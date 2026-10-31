/**
 * Bounded, cancellable child-process execution.
 *
 * - Arguments are always passed as an array (no shell, no interpolation).
 * - stdout/stderr are captured up to `maxOutputBytes` each; overflow is
 *   recorded in `truncated` instead of growing memory without bound.
 * - A timeout or an AbortSignal terminates the whole process group
 *   (SIGTERM, then SIGKILL after a grace period) and the promise resolves
 *   with `timedOut`/`cancelled` set — it never hangs.
 * - Every live child is tracked so the server can reap them on shutdown.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { log } from '../util/log.ts';

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  spawnError?: string;
}

const live = new Set<ChildProcess>();

export function liveProcessCount(): number {
  return live.size;
}

export function trackChild(child: ChildProcess): void {
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => live.delete(child));
}

const isWindows = process.platform === 'win32';

/** Send a signal to the child's whole process group where supported. */
export function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (!isWindows) {
      process.kill(-child.pid, sig);
      return;
    }
  } catch {
    // fall through to direct kill (group may not exist)
  }
  try {
    child.kill(sig);
  } catch (e) {
    log.debug('kill failed', e);
  }
}

/** SIGTERM, wait up to graceMs, then SIGKILL. Resolves when the child has exited. */
export function terminate(child: ChildProcess, graceMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    signalTree(child, 'SIGTERM');
    const timer = setTimeout(() => {
      signalTree(child, 'SIGKILL');
      // Resolve even if 'exit' never fires (zombie / platform quirk).
      setTimeout(done, 1000).unref();
    }, graceMs);
    timer.unref();
  });
}

export function spawnTracked(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
    // A separate process group lets us terminate Godot and anything it spawned.
    detached: !isWindows,
  });
  trackChild(child);
  return child;
}

export function runProcess(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const maxBytes = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    if (opts.signal?.aborted) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        truncated,
        durationMs: 0,
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnTracked(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        truncated,
        durationMs: 0,
        spawnError: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= maxBytes) {
        truncated.stdout = true;
        return;
      }
      const room = maxBytes - outBytes;
      out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      outBytes += Math.min(chunk.length, room);
      if (chunk.length > room) truncated.stdout = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= maxBytes) {
        truncated.stderr = true;
        return;
      }
      const room = maxBytes - errBytes;
      err.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      errBytes += Math.min(chunk.length, room);
      if (chunk.length > room) truncated.stderr = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void terminate(child, opts.killGraceMs ?? 2000);
    }, opts.timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      void terminate(child, opts.killGraceMs ?? 2000);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, sig: NodeJS.Signals | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode,
        signal: sig,
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
        spawnError,
      });
    };

    child.once('error', (e) => finish(null, null, e.message));
    child.once('close', (code, sig) => finish(code, sig));
  });
}

/** Kill every tracked child (used on server shutdown). */
export async function reapAll(graceMs = 1500): Promise<void> {
  await Promise.all([...live].map((c) => terminate(c, graceMs)));
}
