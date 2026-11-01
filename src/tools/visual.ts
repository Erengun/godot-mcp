import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError, type EngineDiagnostic } from '../errors.ts';
import { parseDiagnostics } from '../godot/diagnostics.ts';
import { runProcess } from '../godot/process.ts';
import { godotAssetsDir } from '../godot/worker.ts';
import { resolveInProject, SCENE_EXTENSIONS } from '../security/paths.ts';
import { getValue, parseConfig } from '../util/configFile.ts';
import { projectPath } from './schemas.ts';
import { PROCESS, registerTool } from './registry.ts';

export function displayAvailable(): { ok: boolean; reason?: string } {
  if (process.platform === 'darwin' || process.platform === 'win32') return { ok: true };
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { ok: true };
  return { ok: false, reason: 'No display server (DISPLAY/WAYLAND_DISPLAY unset). Godot cannot render without one; run under a desktop session or xvfb-run.' };
}

export interface CaptureResult {
  png: Buffer;
  width: number;
  height: number;
  stats: Record<string, unknown>;
  scene: Record<string, unknown>;
  diagnostics: EngineDiagnostic[];
  durationMs: number;
}

export async function captureScene(
  ctx: AppContext,
  projectRoot: string,
  sceneRes: string,
  opts: { frames: number; width: number; height: number; camera?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CaptureResult> {
  const disp = displayAvailable();
  if (!disp.ok) throw new GodotMcpError(ErrorCode.CapabilityUnavailable, `Screenshots are unavailable: ${disp.reason}`);
  const godot = await ctx.godot();
  const dir = mkdtempSync(join(tmpdir(), 'godot-mcp-shot-'));
  try {
    const req = join(dir, 'request.json');
    const res = join(dir, 'response.json');
    const png = join(dir, 'shot.png');
    writeFileSync(req, JSON.stringify({ scene: sceneRes, frames: opts.frames, out: png.replace(/\\/g, '/'), camera: opts.camera ?? '' }), { mode: 0o600 });
    const args = [
      '--path',
      projectRoot,
      '--resolution',
      `${opts.width}x${opts.height}`,
      '--windowed',
      '--no-header',
      '--audio-driver',
      'Dummy',
      '--script',
      join(godotAssetsDir(), 'worker', 'capture_runner.gd').replace(/\\/g, '/'),
      '--',
      req.replace(/\\/g, '/'),
      res.replace(/\\/g, '/'),
    ];
    const r = await runProcess(godot.path, args, { cwd: projectRoot, timeoutMs: opts.timeoutMs, signal: opts.signal, maxOutputBytes: 1024 * 1024 });
    if (r.cancelled) throw new GodotMcpError(ErrorCode.Cancelled, 'Screenshot cancelled');
    if (r.timedOut)
      throw new GodotMcpError(ErrorCode.Timeout, `Screenshot did not finish within ${opts.timeoutMs} ms`, { diagnostics: parseDiagnostics(r.stderr, 30) });
    if (!existsSync(res)) {
      throw new GodotMcpError(ErrorCode.WorkerFailed, 'Godot exited without producing a capture result (rendering may be unavailable)', {
        exitCode: r.exitCode,
        diagnostics: parseDiagnostics(r.stderr + '\n' + r.stdout, 30),
        context: { stderrTail: r.stderr.slice(-3000) },
      });
    }
    const result = JSON.parse(readFileSync(res, 'utf8')) as Record<string, unknown>;
    const diagnostics = (result.diagnostics as EngineDiagnostic[] | undefined) ?? [];
    if (result.ok !== true) {
      const err = (result.error ?? {}) as { code?: string; message?: string };
      throw new GodotMcpError(ErrorCode.OperationFailed, `Capture failed: ${err.message ?? 'unknown error'}`, { diagnostics });
    }
    const buf = readFileSync(png);
    // PNG signature + IHDR dimensions: confirm we are returning a real image.
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new GodotMcpError(ErrorCode.OperationFailed, 'Capture produced an invalid PNG');
    return {
      png: buf,
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      stats: (result.stats as Record<string, unknown>) ?? {},
      scene: (result.scene as Record<string, unknown>) ?? {},
      diagnostics,
      durationMs: r.durationMs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerVisualTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_screenshot',
    title: 'Render a scene and capture a screenshot',
    description:
      "Run a scene (default: the main scene) in a new Godot process with the real GPU renderer for N frames, capture the viewport and return the PNG plus objective checks: image statistics (blank detection, colour variety) and scene facts (meshes/sprites missing resources, meshes inside the camera frustum, active cameras, lights). The scene's scripts and the project's autoloads run, as in the game. This renders a fresh instance; it does not capture an already-running game window. Requires a display (not available in headless CI without xvfb).",
    input: z.object({
      projectPath,
      scene: z.string().max(1024).optional(),
      frames: z.number().int().min(2).max(600).optional().describe('Frames to run before capturing (default 10)'),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      camera: z.string().max(1024).optional().describe('Make this Camera2D/Camera3D (node path in the scene) current before capturing'),
      savePath: z.string().max(1024).optional().describe('Also save the PNG inside the project at this path'),
      timeoutMs: z.number().int().min(5000).max(300_000).optional(),
    }),
    annotations: PROCESS,
    handler: async (a, { signal }) => {
      ctx.assertWritable('godot_screenshot');
      const project = ctx.project(a.projectPath);
      let sceneRes: string;
      if (a.scene) {
        sceneRes = resolveInProject(a.scene, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scene' }).res;
      } else {
        const main = getValue(parseConfig(readFileSync(join(project.root, 'project.godot'), 'utf8')), 'application', 'run/main_scene');
        if (typeof main !== 'string' || !main) throw new GodotMcpError(ErrorCode.InvalidArgument, 'No scene given and the project has no main scene');
        sceneRes = main;
      }
      const save = a.savePath ? resolveInProject(a.savePath, project, { forWrite: true, extensions: ['.png'], label: 'savePath' }) : undefined;
      const shot = await captureScene(ctx, project.root, sceneRes, {
        frames: a.frames ?? 10,
        width: a.width ?? 960,
        height: a.height ?? 540,
        camera: a.camera,
        timeoutMs: a.timeoutMs ?? 60_000,
        signal,
      });
      if (save) {
        await ctx.locks.run(project.root, async () => {
          mkdirSync(dirname(save.abs), { recursive: true });
          writeFileSync(save.abs, shot.png);
        });
      }
      const warnings: string[] = [];
      if (shot.stats.looks_blank) warnings.push('The image is a single flat colour: nothing visible was rendered.');
      if (Number(shot.scene.meshes_missing ?? 0) > 0) warnings.push(`${String(shot.scene.meshes_missing)} MeshInstance3D node(s) have no mesh.`);
      if (Number(shot.scene.sprites_missing_texture ?? 0) > 0) warnings.push(`${String(shot.scene.sprites_missing_texture)} Sprite2D node(s) have no texture.`);
      if (Number(shot.scene.meshes ?? 0) > 0 && shot.scene.camera_3d === null) warnings.push('The scene has meshes but no current Camera3D inside it.');
      if (Number(shot.scene.meshes ?? 0) > 0 && Number(shot.scene.meshes_in_view ?? 0) === 0 && shot.scene.camera_3d)
        warnings.push('No mesh centre is inside the camera frustum.');
      const errors = shot.diagnostics.filter((d) => d.severity !== 'warning');
      if (errors.length) warnings.push(`${errors.length} engine/script error(s) occurred while rendering.`);
      const data = {
        scene: sceneRes,
        image: { width: shot.width, height: shot.height, bytes: shot.png.length, mimeType: 'image/png', savedTo: save?.res ?? null },
        stats: shot.stats,
        sceneFacts: shot.scene,
        diagnostics: shot.diagnostics,
        warnings,
        durationMs: shot.durationMs,
        note: 'Structural checks above are automated; judging visual quality requires looking at the image.',
      };
      return {
        data,
        images: [{ data: shot.png.toString('base64'), mimeType: 'image/png' }],
        summary: `Captured ${shot.width}x${shot.height} of ${sceneRes}${warnings.length ? ` — ${warnings.length} warning(s)` : ''}`,
      };
    },
  });
}
