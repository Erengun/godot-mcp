/**
 * Client for the Godot MCP editor plugin (godot/addons/godot_mcp).
 *
 * Discovery: the plugin writes `<project>/.godot/godot_mcp/bridge.json`
 * containing a loopback port and a random token. The client:
 *   1. refuses discovery files that are symlinks, not regular files, or whose
 *      `project_root` does not canonicalise to the requested project (so a
 *      request for project A can never be served by the editor of project B);
 *   2. connects only to 127.0.0.1;
 *   3. authenticates with the token before sending any request;
 *   4. bounds every message (1 MiB) and every request (timeout).
 * Connections are cached per project and transparently re-established when
 * the editor restarts (new port/token).
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { log } from '../util/log.ts';

export const BRIDGE_PROTOCOL = 1;
const MAX_MESSAGE = 1024 * 1024;

export interface BridgeInfo {
  protocol: number;
  port: number;
  token: string;
  pid: number;
  project_root: string;
  godot_version: string;
  started_at?: string;
}

export function bridgeInfoPath(projectRoot: string): string {
  return join(projectRoot, '.godot', 'godot_mcp', 'bridge.json');
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p).replace(/[\\/]+$/, '');
  } catch {
    return p.replace(/[\\/]+$/, '');
  }
}

export function readBridgeInfo(projectRoot: string): BridgeInfo | null {
  const file = bridgeInfoPath(projectRoot);
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) {
    throw new GodotMcpError(ErrorCode.EditorRejected, 'Editor bridge discovery file is not a regular file; refusing to use it');
  }
  let info: BridgeInfo;
  try {
    info = JSON.parse(readFileSync(file, 'utf8')) as BridgeInfo;
  } catch {
    return null;
  }
  if (
    typeof info.port !== 'number' ||
    !Number.isInteger(info.port) ||
    info.port <= 0 ||
    info.port > 65535 ||
    typeof info.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(info.token) ||
    typeof info.project_root !== 'string'
  ) {
    return null;
  }
  const same =
    process.platform === 'win32'
      ? canonical(info.project_root).toLowerCase() === canonical(projectRoot).toLowerCase()
      : canonical(info.project_root) === canonical(projectRoot);
  if (!same) {
    throw new GodotMcpError(ErrorCode.Conflict, 'Editor bridge file belongs to a different project path; refusing to connect', {
      context: { bridgeProject: info.project_root, requested: projectRoot },
    });
  }
  return info;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeConnection {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  readonly info: BridgeInfo;
  welcome: Record<string, unknown> | null = null;

  constructor(info: BridgeInfo) {
    this.info = info;
  }

  get isOpen(): boolean {
    return !!this.socket && !this.closed && !this.socket.destroyed;
  }

  async open(timeoutMs = 3000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port: this.info.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new GodotMcpError(ErrorCode.EditorNotConnected, 'Timed out connecting to the editor bridge'));
      }, timeoutMs);
      let authed = false;
      sock.setEncoding('utf8');
      sock.on('connect', () => {
        sock.write(JSON.stringify({ type: 'hello', token: this.info.token, protocol: BRIDGE_PROTOCOL }) + '\n');
      });
      sock.on('data', (chunk: string) => {
        this.buffer += chunk;
        if (this.buffer.length > MAX_MESSAGE) {
          sock.destroy();
          this.failAll(new GodotMcpError(ErrorCode.EditorRejected, 'Editor bridge sent an oversized message'));
          return;
        }
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!authed) {
            clearTimeout(timer);
            if (msg.type === 'welcome') {
              authed = true;
              this.welcome = msg;
              resolve();
            } else {
              sock.destroy();
              reject(new GodotMcpError(ErrorCode.EditorRejected, 'Editor bridge rejected authentication'));
            }
            continue;
          }
          this.onMessage(msg);
        }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        if (!authed) reject(new GodotMcpError(ErrorCode.EditorNotConnected, `Cannot connect to editor bridge: ${e.message}`));
        this.failAll(new GodotMcpError(ErrorCode.EditorNotConnected, `Editor bridge connection error: ${e.message}`));
      });
      sock.on('close', () => {
        this.closed = true;
        clearTimeout(timer);
        if (!authed) reject(new GodotMcpError(ErrorCode.EditorRejected, 'Editor bridge closed the connection during authentication'));
        this.failAll(new GodotMcpError(ErrorCode.EditorNotConnected, 'Editor bridge connection closed'));
      });
      this.socket = sock;
    });
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok === true) {
      p.resolve(msg.result);
    } else {
      const err = (msg.error ?? {}) as { code?: string; message?: string; context?: Record<string, unknown> };
      const code = Object.values(ErrorCode).includes(err.code as never) ? (err.code as GodotMcpError['code']) : ErrorCode.EditorRejected;
      p.reject(new GodotMcpError(code, err.message ?? 'Editor operation failed', { context: err.context }));
    }
  }

  private failAll(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new GodotMcpError(ErrorCode.EditorNotConnected, 'Editor bridge is not connected'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    if (payload.length > MAX_MESSAGE) {
      return Promise.reject(new GodotMcpError(ErrorCode.InvalidArgument, 'Request too large for the editor bridge'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GodotMcpError(ErrorCode.Timeout, `Editor did not answer '${method}' within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket!.write(payload);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.failAll(new GodotMcpError(ErrorCode.EditorNotConnected, 'Connection closed'));
  }
}

export class EditorBridgeManager {
  private conns = new Map<string, BridgeConnection>();

  /** Connected bridge for the project, or null when no editor plugin is running. */
  async get(projectRoot: string): Promise<BridgeConnection | null> {
    const info = readBridgeInfo(projectRoot);
    if (!info) return null;
    const existing = this.conns.get(projectRoot);
    if (existing && existing.isOpen && existing.info.token === info.token && existing.info.port === info.port) return existing;
    existing?.close();
    const conn = new BridgeConnection(info);
    try {
      await conn.open();
    } catch (e) {
      log.debug('bridge connect failed', e);
      return null;
    }
    this.conns.set(projectRoot, conn);
    return conn;
  }

  async require(projectRoot: string): Promise<BridgeConnection> {
    const info = readBridgeInfo(projectRoot);
    if (!info) {
      throw new GodotMcpError(ErrorCode.EditorNotConnected, 'No running Godot editor with the MCP bridge plugin was found for this project', {
        hints: [
          'Install the plugin with godot_editor_plugin (action: install), then enable it in Project > Project Settings > Plugins',
          'Open the project in the Godot editor (godot_editor_launch)',
        ],
      });
    }
    const c = await this.get(projectRoot);
    if (!c) {
      throw new GodotMcpError(
        ErrorCode.EditorNotConnected,
        'The editor bridge discovery file exists but the editor is not reachable (editor closed or crashed?)',
        {
          context: { port: info.port, pid: info.pid },
        },
      );
    }
    return c;
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
