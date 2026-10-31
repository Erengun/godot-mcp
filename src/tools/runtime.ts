import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { resolveInProject, SCENE_EXTENSIONS } from '../security/paths.ts';
import { projectPath } from './schemas.ts';
import { PROCESS, READ_ONLY, registerTool } from './registry.ts';

export interface RunArgs {
  projectPath: string;
  scene?: string;
  headless?: boolean;
  mode?: 'background' | 'until_exit';
  timeoutMs?: number;
  quitAfterFrames?: number;
  startupWaitMs?: number;
  fixedFps?: number;
  resolution?: string;
  debugCollisions?: boolean;
  debugNavigation?: boolean;
}

export async function runGame(ctx: AppContext, a: RunArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  ctx.assertWritable('godot_run');
  const project = ctx.project(a.projectPath);
  const scene = a.scene ? resolveInProject(a.scene, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scene' }) : undefined;
  const godot = await ctx.godot();
  const replaced: string[] = [];
  for (const s of ctx.runtime.runningFor(project.root, 'game')) {
    await ctx.runtime.stopSession(s);
    replaced.push(s.id);
  }
  const extra: string[] = [];
  if (a.quitAfterFrames) extra.push('--quit-after', String(a.quitAfterFrames));
  if (a.fixedFps) extra.push('--fixed-fps', String(a.fixedFps));
  if (a.resolution) extra.push('--resolution', a.resolution);
  if (a.debugCollisions) extra.push('--debug-collisions');
  if (a.debugNavigation) extra.push('--debug-navigation');
  const id = ctx.runtime.start({
    godotPath: godot.path,
    projectRoot: project.root,
    kind: 'game',
    scene: scene?.res,
    headless: a.headless,
    extraArgs: extra,
    maxLines: ctx.config.maxLogLines,
  });
  const session = ctx.runtime.get(id);
  const mode = a.mode ?? 'background';
  let timedOut = false;
  if (mode === 'until_exit') {
    const exited = await ctx.runtime.waitFor(session, a.timeoutMs ?? 30_000, signal);
    if (!exited) {
      timedOut = !signal?.aborted;
      await ctx.runtime.stopSession(session);
    }
  } else {
    await ctx.runtime.waitFor(session, a.startupWaitMs ?? 1500, signal);
  }
  const status = ctx.runtime.status(session);
  const spawnError = ctx.runtime.spawnError(session);
  if (spawnError) {
    throw new GodotMcpError(ErrorCode.GodotNotFound, `Failed to start Godot: ${spawnError}`);
  }
  const diagnostics = ctx.runtime.diagnostics(session);
  const out = ctx.runtime.output(session, { tail: true, limit: 60 });
  const crashed = !status.running && !status.stoppedByRequest && (status.exitCode ?? 0) !== 0;
  return {
    session: status,
    mode,
    timedOut,
    replacedSessions: replaced,
    startupFailed: mode === 'background' && !status.running && (status.exitCode ?? 0) !== 0,
    crashed,
    healthy: status.healthy && !timedOut,
    diagnostics: diagnostics.slice(0, 100),
    diagnosticsTruncated: diagnostics.length > 100,
    outputTail: out.lines.map((l) => `${l.stream === 'stderr' ? '[stderr] ' : ''}${l.text}`),
    nextSeq: out.nextSeq,
  };
}

export function registerRuntimeTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_run',
    title: 'Run the project or a scene',
    description:
      'Start the game (main scene or a specific scene) as a tracked process with captured stdout/stderr and parsed engine/script errors. ' +
      'mode "background" returns after startupWaitMs with early errors (detects startup failures); mode "until_exit" waits for the game to quit (use quitAfterFrames for automated runs) or kills it after timeoutMs, then reports. ' +
      'healthy=false when script/engine errors occurred, the process crashed, or it timed out. Any game already running for this project is stopped first. headless=true runs without a window (no rendering).',
    input: z.object({
      projectPath,
      scene: z.string().max(1024).optional().describe('Scene to run instead of the main scene'),
      headless: z.boolean().optional(),
      mode: z.enum(['background', 'until_exit']).optional(),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      quitAfterFrames: z.number().int().min(1).max(1_000_000).optional(),
      startupWaitMs: z.number().int().min(0).max(30_000).optional(),
      fixedFps: z.number().int().min(1).max(1000).optional(),
      resolution: z
        .string()
        .regex(/^\d{2,5}x\d{2,5}$/)
        .optional(),
      debugCollisions: z.boolean().optional(),
      debugNavigation: z.boolean().optional(),
    }),
    annotations: PROCESS,
    handler: async (a, { signal }) => {
      const data = await runGame(ctx, a, signal);
      const s = data.session as { id: string; running: boolean; exitCode: number | null };
      return {
        data,
        summary: `${s.id}: ${s.running ? 'running' : `exited (code ${String(s.exitCode)})`}; healthy=${String(data.healthy)}`,
      };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_stop',
    title: 'Stop a running game or editor',
    description:
      'Terminate a session started by godot_run or godot_editor_launch (latest game by default). The process group gets SIGTERM, then SIGKILL after a grace period. Output remains readable afterwards.',
    input: z.object({ sessionId: z.string().max(64).optional(), kind: z.enum(['game', 'editor']).optional() }),
    annotations: PROCESS,
    handler: async (a) => {
      const s = ctx.runtime.get(a.sessionId, a.kind ?? 'game');
      const wasRunning = ctx.runtime.status(s).running;
      await ctx.runtime.stopSession(s);
      return { data: { stopped: wasRunning, session: ctx.runtime.status(s) } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_runtime_output',
    title: 'Read game/editor output',
    description:
      'Read captured output of a session with a cursor: pass since=<nextSeq from the previous call> to get only new lines. diagnosticsOnly returns parsed errors/warnings (type, message, res:// file, line, function, GDScript stack). Output is bounded (GODOT_MCP_MAX_LOG_LINES); droppedLines tells how much was discarded.',
    input: z.object({
      sessionId: z.string().max(64).optional(),
      kind: z.enum(['game', 'editor']).optional(),
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
      stream: z.enum(['stdout', 'stderr', 'both']).optional(),
      diagnosticsOnly: z.boolean().optional(),
    }),
    annotations: READ_ONLY,
    handler: async (a) => {
      const s = ctx.runtime.get(a.sessionId, a.kind ?? 'game');
      const status = ctx.runtime.status(s);
      if (a.diagnosticsOnly) {
        const d = ctx.runtime.diagnostics(s, a.since ?? 0);
        return { data: { session: status, diagnostics: d.slice(0, a.limit ?? 200), total: d.length } };
      }
      const out = ctx.runtime.output(s, { since: a.since, limit: a.limit, stream: a.stream, tail: a.since === undefined });
      return { data: { session: status, ...out } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_runtime_status',
    title: 'List running sessions',
    description: 'List game and editor sessions started by this server (running and recently ended), with exit codes, error counts and health.',
    input: z.object({}),
    annotations: READ_ONLY,
    handler: async () => ({ data: { sessions: ctx.runtime.list() } }),
  });
}
