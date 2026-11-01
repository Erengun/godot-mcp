/**
 * Headless Godot worker invocation.
 *
 * One invocation = one Godot process running `godot/worker/mcp_worker.gd`
 * (a `SceneTree` whose autoloads are swapped for an inert placeholder, so the
 * project's autoloads never run) against one
 * project, executing a *batch* of operations.
 *
 * Transport: request and response are JSON files in a private (0700)
 * temporary directory outside the project. Only the two file paths travel on
 * the command line (after `--`), which avoids argv length limits and shell
 * quoting problems entirely. The response file is the single source of truth:
 * a missing or unparseable response is always a failure, regardless of exit
 * code or console output.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode, GodotMcpError, type EngineDiagnostic } from '../errors.ts';
import { log } from '../util/log.ts';
import { parseDiagnostics } from './diagnostics.ts';
import { runProcess } from './process.ts';

export const WORKER_PROTOCOL_VERSION = 1;

/** Absolute path of the repository/package `godot/` directory. */
export function godotAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/godot/worker.ts and build/godot/worker.js are both two levels below the package root.
  return resolve(here, '..', '..', 'godot');
}

export function workerScriptPath(): string {
  return join(godotAssetsDir(), 'worker', 'mcp_worker.gd').replace(/\\/g, '/');
}

export interface WorkerOp {
  op: string;
  args: Record<string, unknown>;
}

export interface WorkerRequest {
  ops: WorkerOp[];
  /** Abort the batch on the first failed op (default true). */
  atomic?: boolean;
}

export interface WorkerOpResult {
  op: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; context?: Record<string, unknown> };
}

export interface WorkerResponse {
  protocol: number;
  ok: boolean;
  results: WorkerOpResult[];
  error?: { code: string; message: string; context?: Record<string, unknown> };
  diagnostics: EngineDiagnostic[];
  engine: { version: string };
}

export interface WorkerRunOptions {
  godotPath: string;
  projectRoot: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra Godot CLI flags placed before --script (e.g. rendering options). */
  extraArgs?: string[];
  headless?: boolean;
  /** Script to run instead of the default worker (e.g. capture runner). */
  scriptPath?: string;
}

export interface WorkerRunResult {
  response: WorkerResponse;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Map Godot's Logger error_type enum to our severity names. */
function normalizeDiagnostics(list: unknown): EngineDiagnostic[] {
  if (!Array.isArray(list)) return [];
  const out: EngineDiagnostic[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    out.push({
      severity: (['error', 'warning', 'script_error', 'shader_error', 'info'] as const).includes(d.severity as never)
        ? (d.severity as EngineDiagnostic['severity'])
        : 'error',
      message: String(d.message ?? ''),
      file: typeof d.file === 'string' && d.file ? d.file : undefined,
      line: typeof d.line === 'number' && d.line > 0 ? d.line : undefined,
      function: typeof d.function === 'string' && d.function ? d.function : undefined,
    });
  }
  return out;
}

export async function runWorker(request: WorkerRequest, opts: WorkerRunOptions): Promise<WorkerRunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'godot-mcp-'));
  const reqPath = join(dir, 'request.json');
  const resPath = join(dir, 'response.json');
  try {
    writeFileSync(reqPath, JSON.stringify({ protocol: WORKER_PROTOCOL_VERSION, atomic: request.atomic ?? true, ops: request.ops }), {
      mode: 0o600,
    });
    const args = [
      ...(opts.headless === false ? [] : ['--headless']),
      '--no-header',
      '--path',
      opts.projectRoot,
      ...(opts.extraArgs ?? []),
      '--script',
      opts.scriptPath ?? workerScriptPath(),
      '--',
      reqPath.replace(/\\/g, '/'),
      resPath.replace(/\\/g, '/'),
    ];
    log.debug('worker', opts.godotPath, args.join(' '));
    const r = await runProcess(opts.godotPath, args, {
      cwd: opts.projectRoot,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    const opNames = request.ops.map((o) => o.op).join(',');
    if (r.spawnError) {
      throw new GodotMcpError(ErrorCode.GodotNotFound, `Failed to start Godot: ${r.spawnError}`, { operation: opNames });
    }
    if (r.cancelled) {
      throw new GodotMcpError(ErrorCode.Cancelled, 'Operation cancelled; the Godot worker was terminated', { operation: opNames });
    }
    if (r.timedOut) {
      throw new GodotMcpError(ErrorCode.Timeout, `Godot worker exceeded ${opts.timeoutMs} ms and was terminated`, {
        operation: opNames,
        diagnostics: parseDiagnostics(r.stderr + '\n' + r.stdout, 50),
        hints: ['Increase GODOT_MCP_OP_TIMEOUT_MS for very large projects', 'Check whether a resource import is pending (run godot_import)'],
      });
    }
    if (!existsSync(resPath)) {
      throw new GodotMcpError(ErrorCode.WorkerFailed, 'Godot worker exited without producing a result', {
        operation: opNames,
        exitCode: r.exitCode,
        signal: r.signal,
        diagnostics: parseDiagnostics(r.stderr + '\n' + r.stdout, 50),
        context: { stderrTail: r.stderr.slice(-4000) },
      });
    }
    let parsed: WorkerResponse;
    try {
      const raw = JSON.parse(readFileSync(resPath, 'utf8')) as Partial<WorkerResponse>;
      parsed = {
        protocol: Number(raw.protocol ?? 0),
        ok: raw.ok === true,
        results: Array.isArray(raw.results) ? raw.results : [],
        error: raw.error,
        diagnostics: normalizeDiagnostics(raw.diagnostics),
        engine: raw.engine ?? { version: 'unknown' },
      };
    } catch (e) {
      throw new GodotMcpError(ErrorCode.WorkerFailed, `Godot worker produced an unreadable result: ${(e as Error).message}`, {
        operation: opNames,
        exitCode: r.exitCode,
      });
    }
    if (parsed.protocol !== WORKER_PROTOCOL_VERSION) {
      throw new GodotMcpError(ErrorCode.WorkerFailed, `Worker protocol mismatch (got ${parsed.protocol}, expected ${WORKER_PROTOCOL_VERSION})`);
    }
    return { response: parsed, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      log.warn('could not remove temp dir', dir, e);
    }
  }
}

/** Convert a failed worker response into a GodotMcpError. */
export function workerFailure(resp: WorkerResponse, operation: string): GodotMcpError {
  const failed = resp.results.find((r) => !r.ok);
  const err = failed?.error ?? resp.error ?? { code: 'OPERATION_FAILED', message: 'Operation failed' };
  const code = Object.values(ErrorCode).includes(err.code as never) ? (err.code as GodotMcpError['code']) : ErrorCode.OperationFailed;
  return new GodotMcpError(code, err.message, {
    operation: failed ? `${operation}:${failed.op}` : operation,
    diagnostics: resp.diagnostics.filter((d) => d.severity !== 'info'),
    context: err.context,
  });
}

/** Write a temp file that a worker op can read (e.g. large payloads). */
export function writeTempJson(data: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'godot-mcp-'));
  const path = join(dir, 'payload.json');
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
