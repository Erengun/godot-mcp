/**
 * Integration-test harness: spawns the BUILT server (build/index.js) over real
 * stdio with the official MCP client, against real Godot. Nothing is mocked.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = join(REPO, 'build', 'index.js');

export function godotPath(): string | undefined {
  if (process.env.GODOT_PATH) return process.env.GODOT_PATH;
  const mac = '/Applications/Godot.app/Contents/MacOS/Godot';
  return existsSync(mac) ? mac : undefined;
}

export const HAS_GODOT = !!godotPath();
export const SKIP_NO_GODOT = HAS_GODOT ? false : 'Godot executable not found (set GODOT_PATH)';

export interface Harness {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  ok(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  fail(name: string, args?: Record<string, unknown>): Promise<{ code: string; message: string; [k: string]: unknown }>;
  close(): Promise<void>;
  protocol(): string | undefined;
}

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
}

export async function startServer(opts: { env?: Record<string, string>; mode?: 'legacy' | 'auto' } = {}): Promise<Harness> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) };
  const gp = godotPath();
  if (gp) env.GODOT_PATH = gp;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'pipe' });
  const client = new Client({ name: 'godot-mcp-tests', version: '1.0.0' }, { versionNegotiation: { mode: opts.mode ?? 'auto' } });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args }, { timeout: 600_000 })) as unknown as ToolResult;
  return {
    client,
    call,
    async ok(name, args) {
      const r = await call(name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text?.slice(0, 3000)}`);
      return r.structuredContent ?? {};
    },
    async fail(name, args) {
      const r = await call(name, args);
      if (!r.isError) throw new Error(`${name} unexpectedly succeeded: ${r.content[0]?.text?.slice(0, 1500)}`);
      return (r.structuredContent?.error ?? { code: 'UNKNOWN', message: r.content[0]?.text ?? '' }) as { code: string; message: string };
    },
    async close() {
      await client.close();
    },
    protocol: () => client.getNegotiatedProtocolVersion(),
  };
}

/** Fresh empty Godot project in a private temp directory (realpath'd). */
export function tempProject(name = 'Test', extra = ''): { root: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'godot-mcp-test-')));
  writeFileSync(join(dir, 'project.godot'), `config_version=5\n\n[application]\n\nconfig/name="${name}"\n${extra}`);
  return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeFile(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

import { deflateSync } from 'node:zlib';

/** Encode an RGBA PNG (for generating real test textures without external tools). */
export function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
