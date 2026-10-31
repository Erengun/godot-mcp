/**
 * Long-running Godot processes: games/scenes started by the agent and editor
 * instances launched on its behalf.
 *
 * - Each process is a tracked session with bounded, sequence-numbered output
 *   (ring buffer) and a streaming diagnostic parser, so output survives the
 *   process exiting and can be paged with a cursor.
 * - Starting a game for a project first terminates (and awaits) any game
 *   already running for that project — no orphaned processes, no race
 *   (upstream issue #70).
 * - Games are started WITHOUT `-d`: the local stdout debugger blocks on stdin
 *   at the first script error, which would freeze a game whose stdin is not a
 *   terminal.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ErrorCode, GodotMcpError, type EngineDiagnostic } from '../errors.ts';
import { RingBuffer } from '../util/ringBuffer.ts';
import { DiagnosticParser, summarizeDiagnostics } from './diagnostics.ts';
import { spawnTracked, terminate } from './process.ts';

export type SessionKind = 'game' | 'editor';

export interface OutputLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  /** ms since session start */
  t: number;
}

export interface SessionStatus {
  id: string;
  kind: SessionKind;
  projectRoot: string;
  scene?: string;
  pid?: number;
  running: boolean;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number;
  stoppedByRequest: boolean;
  diagnostics: { errors: number; warnings: number };
  /** Healthy = no engine/script errors so far and no abnormal exit. */
  healthy: boolean;
  outputLines: number;
  droppedLines: number;
  args: string[];
}

interface Session {
  id: string;
  kind: SessionKind;
  projectRoot: string;
  scene?: string;
  child: ChildProcess;
  args: string[];
  started: number;
  ended?: number;
  exitCode: number | null;
  signal: string | null;
  stoppedByRequest: boolean;
  lines: RingBuffer<OutputLine>;
  diagnostics: RingBuffer<EngineDiagnostic & { seq: number }>;
  parser: DiagnosticParser;
  partial: { stdout: string; stderr: string };
  exited: Promise<void>;
  spawnError?: string;
}

export interface StartOptions {
  godotPath: string;
  projectRoot: string;
  kind: SessionKind;
  scene?: string;
  headless?: boolean;
  extraArgs?: string[];
  maxLines: number;
}

const MAX_ENDED_SESSIONS = 10;
const MAX_LINE_LENGTH = 4000;

export class RuntimeManager {
  private sessions = new Map<string, Session>();
  private order: string[] = [];

  start(opts: StartOptions): string {
    const args: string[] = [];
    if (opts.kind === 'editor') args.push('--editor');
    if (opts.headless) args.push('--headless');
    args.push('--path', opts.projectRoot);
    if (opts.scene) args.push('--scene', opts.scene);
    args.push(...(opts.extraArgs ?? []));
    const child = spawnTracked(opts.godotPath, args, { cwd: opts.projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const id = `${opts.kind}-${randomUUID().slice(0, 8)}`;
    let resolveExit!: () => void;
    const session: Session = {
      id,
      kind: opts.kind,
      projectRoot: opts.projectRoot,
      scene: opts.scene,
      child,
      args,
      started: Date.now(),
      exitCode: null,
      signal: null,
      stoppedByRequest: false,
      lines: new RingBuffer(opts.maxLines),
      diagnostics: new RingBuffer(1000),
      parser: new DiagnosticParser(Number.MAX_SAFE_INTEGER),
      partial: { stdout: '', stderr: '' },
      exited: new Promise<void>((r) => (resolveExit = r)),
    };
    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = session.partial[stream] + chunk.toString('utf8');
      const parts = text.split('\n');
      session.partial[stream] = parts.pop() ?? '';
      if (session.partial[stream].length > MAX_LINE_LENGTH) {
        parts.push(session.partial[stream]);
        session.partial[stream] = '';
      }
      for (const line of parts) this.addLine(session, stream, line);
    };
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.once('error', (e) => {
      session.spawnError = e.message;
      session.ended = Date.now();
      resolveExit();
    });
    child.once('close', (code, sig) => {
      for (const s of ['stdout', 'stderr'] as const) {
        if (session.partial[s]) this.addLine(session, s, session.partial[s]);
        session.partial[s] = '';
      }
      const last = session.parser.flush();
      if (last) session.diagnostics.push({ ...last, seq: session.lines.totalCount });
      session.exitCode = code;
      session.signal = sig;
      session.ended = Date.now();
      resolveExit();
    });
    this.sessions.set(id, session);
    this.order.push(id);
    this.prune();
    return id;
  }

  private addLine(s: Session, stream: 'stdout' | 'stderr', raw: string): void {
    const text = raw.replace(/\r$/, '').slice(0, MAX_LINE_LENGTH);
    const seq = s.lines.totalCount;
    s.lines.push({ seq, stream, text, t: Date.now() - s.started });
    const done = s.parser.pushLine(text);
    if (done) s.diagnostics.push({ ...done, seq });
  }

  private prune(): void {
    const ended = this.order.filter((id) => this.sessions.get(id)?.ended !== undefined);
    while (ended.length > MAX_ENDED_SESSIONS) {
      const id = ended.shift()!;
      this.sessions.delete(id);
      this.order = this.order.filter((x) => x !== id);
    }
  }

  get(id?: string, kind: SessionKind = 'game'): Session {
    if (id) {
      const s = this.sessions.get(id);
      if (!s) throw new GodotMcpError(ErrorCode.NotFound, `No session with id ${id}`, { hints: ['Use godot_runtime_status to list sessions'] });
      return s;
    }
    for (let i = this.order.length - 1; i >= 0; i--) {
      const s = this.sessions.get(this.order[i]!);
      if (s && s.kind === kind) return s;
    }
    throw new GodotMcpError(ErrorCode.ProcessNotRunning, `No ${kind} session has been started`, {
      hints: [kind === 'game' ? 'Start one with godot_run' : 'Start one with godot_editor_launch'],
    });
  }

  runningFor(projectRoot: string, kind: SessionKind): Session[] {
    return [...this.sessions.values()].filter((s) => s.kind === kind && s.projectRoot === projectRoot && s.ended === undefined);
  }

  async stopSession(s: Session, graceMs = 3000): Promise<void> {
    if (s.ended !== undefined) return;
    s.stoppedByRequest = true;
    await terminate(s.child, graceMs);
    await Promise.race([s.exited, new Promise((r) => setTimeout(r, 2000))]);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.stopSession(s, 1500)));
  }

  /** Wait until the session exits or `ms` elapses; abortable. */
  async waitFor(s: Session, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (s.ended !== undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const result = await Promise.race([
      s.exited.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
      new Promise<boolean>((r) => {
        if (!signal) return;
        onAbort = () => r(false);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    return result;
  }

  status(s: Session): SessionStatus {
    const diags = s.diagnostics.all();
    const summary = summarizeDiagnostics(diags);
    const running = s.ended === undefined;
    const abnormalExit = !running && !s.stoppedByRequest && (s.exitCode ?? 0) !== 0;
    return {
      id: s.id,
      kind: s.kind,
      projectRoot: s.projectRoot,
      scene: s.scene,
      pid: s.child.pid,
      running,
      startedAt: new Date(s.started).toISOString(),
      endedAt: s.ended ? new Date(s.ended).toISOString() : undefined,
      exitCode: s.exitCode,
      signal: s.signal,
      uptimeMs: (s.ended ?? Date.now()) - s.started,
      stoppedByRequest: s.stoppedByRequest,
      diagnostics: summary,
      healthy: summary.errors === 0 && !abnormalExit && !s.spawnError,
      outputLines: s.lines.totalCount,
      droppedLines: s.lines.droppedCount,
      args: s.args,
    };
  }

  list(): SessionStatus[] {
    return this.order
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => !!s)
      .map((s) => this.status(s));
  }

  output(s: Session, opts: { since?: number; limit?: number; stream?: 'stdout' | 'stderr' | 'both'; tail?: boolean }) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    let items: OutputLine[];
    let firstSeq: number;
    if (opts.tail || opts.since === undefined) {
      items = s.lines.all();
      firstSeq = items[0]?.seq ?? s.lines.totalCount;
    } else {
      const r = s.lines.since(opts.since);
      items = r.items;
      firstSeq = r.firstSeq;
    }
    if (opts.stream && opts.stream !== 'both') items = items.filter((l) => l.stream === opts.stream);
    const truncatedBefore = opts.tail || opts.since === undefined ? Math.max(0, items.length - limit) : 0;
    const window = opts.tail || opts.since === undefined ? items.slice(-limit) : items.slice(0, limit);
    const nextSeq = window.length > 0 ? window[window.length - 1]!.seq + 1 : (opts.since ?? s.lines.totalCount);
    return {
      lines: window,
      nextSeq,
      firstAvailableSeq: firstSeq,
      omittedOlderLines: truncatedBefore,
      hasMore: nextSeq < s.lines.totalCount,
      droppedLines: s.lines.droppedCount,
    };
  }

  diagnostics(s: Session, since = 0): Array<EngineDiagnostic & { seq: number }> {
    return s.diagnostics.all().filter((d) => d.seq >= since);
  }

  spawnError(s: Session): string | undefined {
    return s.spawnError;
  }
}
