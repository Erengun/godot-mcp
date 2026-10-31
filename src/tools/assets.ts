import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { parseDiagnostics, summarizeDiagnostics } from '../godot/diagnostics.ts';
import { templatesVersionDir, type GodotVersion } from '../godot/locate.ts';
import { runProcess } from '../godot/process.ts';
import { assertAllowedRoot, canonicalizeForCheck, isWithin, resolveInProject, type ProjectRef } from '../security/paths.ts';
import { getValue, parseConfig } from '../util/configFile.ts';
import { listProjectFiles } from './project.ts';
import { paging, projectPath } from './schemas.ts';
import { PROCESS, registerTool, WRITES } from './registry.ts';

function importInfo(abs: string): Record<string, unknown> {
  const meta = `${abs}.import`;
  if (!existsSync(meta)) return { imported: false };
  const cfg = parseConfig(readFileSync(meta, 'utf8'));
  const importer = getValue(cfg, 'remap', 'importer');
  const type = getValue(cfg, 'remap', 'type');
  const valid = getValue(cfg, 'remap', 'valid');
  const uid = getValue(cfg, 'remap', 'uid');
  const destRaw = getValue(cfg, 'deps', 'dest_files');
  const dests = typeof destRaw === 'string' ? [...destRaw.matchAll(/"(res:\/\/[^"]+)"/g)].map((m) => m[1]!) : [];
  return { imported: true, importer, type, uid, valid: valid !== false, destFiles: dests.length };
}

/**
 * Official editor refresh: `godot --headless --import` scans the filesystem,
 * imports new/changed assets and rebuilds the global class and UID caches.
 * It starts the editor, so the project's editor plugins and @tool scripts run.
 */
export async function runImport(ctx: AppContext, project: ProjectRef, timeoutMs: number, signal?: AbortSignal) {
  const godot = await ctx.godot();
  const r = await runProcess(godot.path, ['--headless', '--path', project.root, '--import'], {
    cwd: project.root,
    timeoutMs,
    signal,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (r.cancelled) throw new GodotMcpError(ErrorCode.Cancelled, 'Import cancelled');
  if (r.timedOut) throw new GodotMcpError(ErrorCode.Timeout, `Import did not finish within ${timeoutMs} ms`);
  if (r.spawnError) throw new GodotMcpError(ErrorCode.GodotNotFound, r.spawnError);
  return r;
}

export function classCacheHas(root: string, className: string): boolean {
  const f = join(root, '.godot', 'global_script_class_cache.cfg');
  return existsSync(f) && readFileSync(f, 'utf8').includes(`"class": &"${className}"`);
}

export function templatesRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'export_templates');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'godot', 'export_templates');
}

export interface ExportPreset {
  index: number;
  name: string;
  platform: string;
  runnable: boolean;
  exportPath: string;
}

export function readPresets(root: string): ExportPreset[] {
  const file = join(root, 'export_presets.cfg');
  if (!existsSync(file)) return [];
  const cfg = parseConfig(readFileSync(file, 'utf8'));
  const out: ExportPreset[] = [];
  for (const [section, values] of cfg) {
    const m = /^preset\.(\d+)$/.exec(section);
    if (!m) continue;
    out.push({
      index: Number(m[1]),
      name: String(values.get('name') ?? ''),
      platform: String(values.get('platform') ?? ''),
      runnable: values.get('runnable') === true,
      exportPath: String(values.get('export_path') ?? ''),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

const PLATFORM_TEMPLATE_HINT: Record<string, RegExp> = {
  'Windows Desktop': /^windows_/,
  Linux: /^linux_/,
  'Linux/X11': /^linux_/,
  macOS: /^macos\.zip$/,
  Web: /^web_/,
  Android: /^android_/,
  iOS: /^ios\.zip$/,
};

export function checkTemplates(version: GodotVersion, platform: string): { dir: string; installed: boolean; matching: string[] } {
  const dir = join(templatesRoot(), templatesVersionDir(version));
  if (!existsSync(dir)) return { dir, installed: false, matching: [] };
  const files = readdirSync(dir);
  const re = PLATFORM_TEMPLATE_HINT[platform];
  const matching = re ? files.filter((f) => re.test(f)) : files;
  return { dir, installed: matching.length > 0, matching };
}

function resolveExportOutput(ctx: AppContext, project: ProjectRef, outputPath: string): string {
  // Outputs may go inside the project (e.g. build/) or inside an allowed root.
  const abs = canonicalizeForCheck(
    outputPath.startsWith('res://') || !/^([a-zA-Z]:[\\/]|\/)/.test(outputPath)
      ? resolveInProject(outputPath, project, { forWrite: true, label: 'outputPath' }).abs
      : outputPath,
  );
  if (!isWithin(project.root, abs)) {
    if (ctx.config.allowedRoots.length === 0) {
      throw new GodotMcpError(ErrorCode.PathNotAllowed, 'Export outputs outside the project require GODOT_MCP_ALLOWED_ROOTS to include the destination', {
        hints: ['Use a project-relative path such as build/game.exe'],
      });
    }
    assertAllowedRoot(abs, ctx.config.allowedRoots, outputPath);
  }
  return abs;
}

export function registerAssetTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_assets',
    title: 'Asset import status, import and load checks',
    description:
      'Asset pipeline:\n' +
      '- list {kind?, offset?, limit?}: importable assets (textures, models, audio, fonts) with .import status (importer, resource type, UID, validity)\n' +
      "- import {timeoutMs?}: run the editor importer headlessly (`godot --headless --import`) so new/changed assets become loadable; returns import errors. This starts the editor, which runs the project's editor plugins and @tool scripts.\n" +
      '- check {paths:[...]}: load assets through Godot and report class, texture size, model node/mesh/material counts, audio length — proves the asset actually loads (not just that the file exists).',
    input: z.object({
      projectPath,
      action: z.enum(['list', 'import', 'check']),
      kind: z.enum(['textures', 'models', 'audio', 'fonts', 'all']).optional(),
      paths: z.array(z.string().max(1024)).max(200).optional(),
      timeoutMs: z.number().int().min(5000).max(1_800_000).optional(),
      ...paging,
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      if (a.action === 'list') {
        const kinds = a.kind && a.kind !== 'all' ? [a.kind] : ['textures', 'models', 'audio', 'fonts'];
        const all = listProjectFiles(project, { includeAddons: false }).files.filter((f) => kinds.includes(f.kind));
        const start = a.offset ?? 0;
        const page = all.slice(start, start + (a.limit ?? 200)).map((f) => ({ ...f, ...importInfo(join(project.root, f.path.slice(6))) }));
        return { data: { total: all.length, notImported: all.filter((f) => !f.imported).length, offset: start, assets: page } };
      }
      if (a.action === 'check') {
        if (!a.paths?.length) throw new GodotMcpError(ErrorCode.InvalidArgument, 'paths is required for check');
        const paths = a.paths.map((p) => resolveInProject(p, project, { mustExist: true, label: 'paths[]' }).res);
        const { results } = await ctx.runOps(project, [{ op: 'asset_check', args: { paths } }], { signal });
        return { data: results[0] as Record<string, unknown> };
      }
      ctx.assertWritable('godot_assets:import');
      const before = listProjectFiles(project).files.filter((f) => f.imported === false).length;
      const r = await ctx.locks.run(project.root, () => runImport(ctx, project, a.timeoutMs ?? 300_000, signal));
      const diagnostics = parseDiagnostics(r.stderr + '\n' + r.stdout, 300);
      const after = listProjectFiles(project).files.filter((f) => f.imported === false);
      const summary = summarizeDiagnostics(diagnostics);
      return {
        data: {
          exitCode: r.exitCode,
          unimportedBefore: before,
          unimportedAfter: after.length,
          stillUnimported: after.slice(0, 100).map((f) => f.path),
          globalClassCache: existsSync(join(project.root, '.godot', 'global_script_class_cache.cfg')),
          uidCache: existsSync(join(project.root, '.godot', 'uid_cache.bin')),
          diagnostics,
          errors: summary.errors,
          warnings: summary.warnings,
          ok: r.exitCode === 0 && summary.errors === 0,
          durationMs: r.durationMs,
        },
        summary: `Import finished (exit ${String(r.exitCode)}), ${summary.errors} error(s), ${after.length} asset(s) still unimported.`,
      };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_export',
    title: 'Export presets, checks and builds',
    description:
      'Export workflow:\n' +
      '- presets: list presets from export_presets.cfg\n' +
      '- check {preset}: verify the preset exists and export templates for this Godot version/platform are installed (no download is ever performed)\n' +
      '- export {preset, outputPath, debug?}: run `godot --headless --export-release|--export-debug` and verify the output file was produced. outputPath must be inside the project (e.g. build/game.x86_64) or inside GODOT_MCP_ALLOWED_ROOTS.',
    input: z.object({
      projectPath,
      action: z.enum(['presets', 'check', 'export']),
      preset: z.string().max(256).optional(),
      outputPath: z.string().max(1024).optional(),
      debug: z.boolean().optional(),
      timeoutMs: z.number().int().min(10_000).max(3_600_000).optional(),
    }),
    annotations: PROCESS,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const presets = readPresets(project.root);
      if (a.action === 'presets') return { data: { presets, file: existsSync(join(project.root, 'export_presets.cfg')) } };
      if (!a.preset) throw new GodotMcpError(ErrorCode.InvalidArgument, 'preset is required');
      const preset = presets.find((p) => p.name === a.preset);
      const godot = await ctx.godot();
      if (!preset) throw new GodotMcpError(ErrorCode.NotFound, `Export preset '${a.preset}' not found`, { context: { available: presets.map((p) => p.name) } });
      const templates = checkTemplates(godot.version, preset.platform);
      const problems: string[] = [];
      if (!templates.installed)
        problems.push(`Export templates for Godot ${templatesVersionDir(godot.version)} (${preset.platform}) are not installed in ${templates.dir}`);
      if (a.action === 'check') return { data: { preset, templates, ready: problems.length === 0, problems } };
      ctx.assertWritable('godot_export');
      if (!a.outputPath) throw new GodotMcpError(ErrorCode.InvalidArgument, 'outputPath is required for export');
      const out = resolveExportOutput(ctx, project, a.outputPath);
      if (problems.length)
        throw new GodotMcpError(ErrorCode.CapabilityUnavailable, problems.join('; '), {
          hints: ['Install templates from the Godot editor (Editor > Manage Export Templates); this server never downloads them'],
        });
      mkdirSync(dirname(out), { recursive: true });
      const started = Date.now();
      const r = await runProcess(godot.path, ['--headless', '--path', project.root, a.debug ? '--export-debug' : '--export-release', preset.name, out], {
        cwd: project.root,
        timeoutMs: a.timeoutMs ?? 900_000,
        signal,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (r.cancelled) throw new GodotMcpError(ErrorCode.Cancelled, 'Export cancelled');
      if (r.timedOut) throw new GodotMcpError(ErrorCode.Timeout, 'Export timed out');
      const diagnostics = parseDiagnostics(r.stderr + '\n' + r.stdout, 200);
      const produced = existsSync(out) && statSync(out).mtimeMs >= started - 2000 && statSync(out).size > 0;
      if (!produced || r.exitCode !== 0) {
        throw new GodotMcpError(ErrorCode.OperationFailed, `Export failed (exit ${String(r.exitCode)}${produced ? '' : ', no output file produced'})`, {
          exitCode: r.exitCode,
          diagnostics,
          context: { stderrTail: r.stderr.slice(-3000) },
        });
      }
      return { data: { preset: preset.name, output: out, bytes: statSync(out).size, debug: !!a.debug, diagnostics, durationMs: r.durationMs } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_uid',
    title: 'Resource UIDs',
    description:
      "UID utilities (Godot 4.4+):\n- get {path}: UID of a scene/resource/script (from the header, .uid sidecar or UID cache)\n- resolve {uid}: path for a uid:// (needs the editor-built UID cache)\n- resave: re-save every .tscn/.tres through Godot so references and UIDs are written in the current format, keeping each file's UID.",
    input: z.object({
      projectPath,
      action: z.enum(['get', 'resolve', 'resave']),
      path: z.string().max(1024).optional(),
      uid: z.string().max(64).optional(),
      includeAddons: z.boolean().optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      if (a.action === 'get') {
        const r = resolveInProject(a.path, project, { mustExist: true, label: 'path' });
        const { results } = await ctx.runOps(project, [{ op: 'uid_get', args: { path: r.res } }], { signal });
        return { data: results[0] as Record<string, unknown> };
      }
      if (a.action === 'resolve') {
        const { results } = await ctx.runOps(project, [{ op: 'uid_resolve', args: { uid: a.uid ?? '' } }], { signal });
        return { data: results[0] as Record<string, unknown> };
      }
      const { results } = await ctx.runOps(project, [{ op: 'resave_resources', args: { include_addons: !!a.includeAddons } }], {
        signal,
        mutates: true,
        operation: 'godot_uid:resave',
      });
      return { data: results[0] as Record<string, unknown> };
    },
  });
}
