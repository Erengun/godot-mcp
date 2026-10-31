import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { readBridgeInfo } from '../editor/bridge.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { versionLabel } from '../godot/locate.ts';
import { liveProcessCount } from '../godot/process.ts';
import { resolveSearchDirectory, type ProjectRef } from '../security/paths.ts';
import { getValue, parseConfig } from '../util/configFile.ts';
import { paging, projectPath } from './schemas.ts';
import { READ_ONLY, registerTool, WRITES } from './registry.ts';

export const SERVER_VERSION = '2.0.0-dev.0';

const SKIP_DIRS = new Set(['.godot', '.git', '.import', 'node_modules', '.svn', '.hg']);

export function projectName(root: string): string {
  try {
    const cfg = parseConfig(readFileSync(join(root, 'project.godot'), 'utf8'));
    const n = getValue(cfg, 'application', 'config/name');
    return typeof n === 'string' && n ? n : (root.split(sep).pop() ?? root);
  } catch {
    return root.split(sep).pop() ?? root;
  }
}

export function findProjects(dir: string, maxDepth: number, limit: number): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const walk = (d: string, depth: number): void => {
    if (out.length >= limit) return;
    if (existsSync(join(d, 'project.godot'))) {
      out.push({ path: d, name: projectName(d) });
      return; // nested projects inside a project are not searched
    }
    if (depth >= maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(join(d, e.name), depth + 1);
      if (out.length >= limit) return;
    }
  };
  walk(dir, 0);
  return out;
}

const KIND_EXT: Record<string, string[]> = {
  scenes: ['.tscn', '.scn'],
  scripts: ['.gd', '.cs', '.gdshader', '.gdshaderinc'],
  resources: ['.tres', '.res'],
  textures: ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.bmp', '.tga', '.exr', '.hdr', '.ktx', '.dds'],
  models: ['.glb', '.gltf', '.obj', '.fbx', '.blend', '.dae'],
  audio: ['.wav', '.ogg', '.mp3'],
  fonts: ['.ttf', '.otf', '.woff', '.woff2', '.fnt', '.font'],
};
const IMPORTABLE = new Set([...KIND_EXT.textures!, ...KIND_EXT.models!, ...KIND_EXT.audio!, ...KIND_EXT.fonts!]);

export function kindOf(file: string): string {
  const lower = file.toLowerCase();
  for (const [kind, exts] of Object.entries(KIND_EXT)) if (exts.some((e) => lower.endsWith(e))) return kind;
  return 'other';
}

export interface ProjectFile {
  path: string;
  kind: string;
  size: number;
  imported?: boolean;
}

export function listProjectFiles(project: ProjectRef, opts: { includeAddons?: boolean; max?: number } = {}): { files: ProjectFile[]; truncated: boolean } {
  const files: ProjectFile[] = [];
  const max = opts.max ?? 20000;
  let truncated = false;
  const walk = (d: string): void => {
    if (truncated) return;
    if (existsSync(join(d, '.gdignore')) && d !== project.root) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!opts.includeAddons && d === project.root && e.name === 'addons') continue;
        walk(full);
      } else if (e.isFile()) {
        if (e.name.endsWith('.import') || e.name.endsWith('.uid')) continue;
        if (files.length >= max) {
          truncated = true;
          return;
        }
        const rel = relative(project.root, full).split(sep).join('/');
        const f: ProjectFile = { path: `res://${rel}`, kind: kindOf(e.name), size: lstatSync(full).size };
        if (IMPORTABLE.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) f.imported = existsSync(`${full}.import`);
        files.push(f);
      }
    }
  };
  walk(project.root);
  return { files, truncated };
}

export function registerProjectTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_status',
    title: 'Server and Godot status',
    description:
      'Report the godot-mcp server version, the detected Godot executable and version (.NET or standard), active configuration (allowed roots, read-only mode, timeouts), running processes and — when projectPath is given — whether a live editor bridge is available for that project. Call this first to discover capabilities.',
    input: z.object({ projectPath: projectPath.optional() }),
    annotations: READ_ONLY,
    handler: async ({ projectPath: p }) => {
      let godot: Record<string, unknown>;
      try {
        const g = await ctx.godot();
        godot = { found: true, path: g.path, version: g.version.raw, label: versionLabel(g.version), dotnet: g.version.dotnet };
      } catch (e) {
        godot = { found: false, error: (e as Error).message };
      }
      const data: Record<string, unknown> = {
        server: { name: 'godot-mcp', version: SERVER_VERSION, node: process.version, platform: process.platform },
        godot,
        config: {
          allowedRoots: ctx.config.allowedRoots,
          readOnly: ctx.config.readOnly,
          legacyTools: ctx.config.legacyTools,
          operationTimeoutMs: ctx.config.operationTimeoutMs,
          maxLogLines: ctx.config.maxLogLines,
        },
        processes: {
          tracked: liveProcessCount(),
          sessions: ctx.runtime.list().map((s) => ({ id: s.id, kind: s.kind, running: s.running, project: s.projectRoot })),
        },
        capabilities: {
          headlessWorker: godot.found === true,
          screenshots: process.platform === 'darwin' || process.platform === 'win32' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY,
          csharp: godot.found === true && godot.dotnet === true,
        },
      };
      if (p) {
        const project = ctx.project(p);
        let editor: Record<string, unknown> = { available: false };
        try {
          const info = readBridgeInfo(project.root);
          if (info) {
            const conn = await ctx.editor.get(project.root);
            editor = { available: !!conn, port: info.port, pid: info.pid, godotVersion: info.godot_version, stale: !conn };
          }
        } catch (e) {
          editor = { available: false, error: (e as Error).message };
        }
        data.project = {
          root: project.root,
          name: projectName(project.root),
          editorBridge: editor,
          pluginInstalled: existsSync(join(project.root, 'addons', 'godot_mcp', 'plugin.cfg')),
        };
      }
      return { data };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_project_list',
    title: 'Find Godot projects',
    description: 'Find directories containing project.godot under a directory (symlinks and hidden folders are not followed; bounded depth and count).',
    input: z.object({
      directory: z.string().min(1).describe('Directory to search'),
      recursive: z.boolean().optional().describe('Search sub-directories (default false: only the directory and its direct children)'),
      maxDepth: z.number().int().min(1).max(8).optional().describe('Maximum search depth when recursive (default 4)'),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    annotations: READ_ONLY,
    handler: async ({ directory, recursive, maxDepth, limit }) => {
      const dir = resolveSearchDirectory(directory, ctx.config.allowedRoots);
      const projects = findProjects(dir, recursive ? (maxDepth ?? 4) : 1, limit ?? 200);
      return { data: { directory: dir, count: projects.length, projects } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_project_info',
    title: 'Project metadata',
    description:
      'Read project metadata through Godot: name, main scene (and whether it exists), rendering method, viewport, autoloads, custom InputMap actions with their events, enabled plugins, named physics/render layers, global script classes, C# presence and file counts by kind. Read-only; runs no project code.',
    input: z.object({ projectPath, includeBuiltinActions: z.boolean().optional().describe('Also list ui_* input actions') }),
    annotations: READ_ONLY,
    handler: async ({ projectPath: p, includeBuiltinActions }, { signal }) => {
      const project = ctx.project(p);
      const { results } = await ctx.runOps(project, [{ op: 'project_info', args: { include_builtin_actions: !!includeBuiltinActions } }], { signal });
      const info = results[0] as Record<string, unknown>;
      const { files, truncated } = listProjectFiles(project, { includeAddons: true });
      const counts: Record<string, number> = {};
      for (const f of files) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
      const csproj = readdirSync(project.root).filter((f) => f.endsWith('.csproj'));
      return {
        data: {
          path: project.root,
          ...info,
          csharp: { csproj, hasCsharpScripts: (counts.scripts ?? 0) > 0 && files.some((f) => f.path.endsWith('.cs')) },
          fileCounts: counts,
          fileCountTruncated: truncated,
          unimportedAssets: files.filter((f) => f.imported === false).length,
        },
      };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_project_files',
    title: 'List project files',
    description:
      'List project files by kind (scenes, scripts, resources, textures, models, audio, fonts, other) with import status for assets. Skips .godot/, hidden folders and folders containing .gdignore. Paginated.',
    input: z.object({
      projectPath,
      kind: z.enum(['all', 'scenes', 'scripts', 'resources', 'textures', 'models', 'audio', 'fonts', 'other']).optional(),
      contains: z.string().max(200).optional().describe('Only paths containing this substring (case-insensitive)'),
      includeAddons: z.boolean().optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    handler: async ({ projectPath: p, kind, contains, includeAddons, offset, limit }) => {
      const project = ctx.project(p);
      const { files, truncated } = listProjectFiles(project, { includeAddons });
      let filtered = files;
      if (kind && kind !== 'all') filtered = filtered.filter((f) => f.kind === kind);
      if (contains) filtered = filtered.filter((f) => f.path.toLowerCase().includes(contains.toLowerCase()));
      const start = offset ?? 0;
      const page = filtered.slice(start, start + (limit ?? 500));
      return {
        data: {
          total: filtered.length,
          offset: start,
          returned: page.length,
          hasMore: start + page.length < filtered.length,
          scanTruncated: truncated,
          files: page,
        },
      };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_project_settings',
    title: 'Read or change project settings',
    description:
      "Read or change project settings through Godot's ProjectSettings API.\n" +
      'actions:\n' +
      '- get: {keys?:[...], prefix?:"display/"} read values\n' +
      '- set: {settings:{"display/window/size/viewport_width":1280, "application/run/main_scene":"res://main.tscn"}} — only display/, rendering/, physics/, layer_names/, gui/, audio/, application/config/, application/run/main_scene and similar prefixes; autoload/, editor_plugins/, input/, filesystem/ are refused\n' +
      '- input_set: {action_name:"jump" (alias inputAction), events:[{type:"key",keycode:"Space"},{type:"joypad_button",button_index:"a"},{type:"mouse_button",button_index:"left"},{type:"joypad_motion",axis:"left_x",axis_value:-1}], deadzone?, replace?}\n' +
      '- input_remove: {action_name}\n' +
      '- autoload_set: {name, path, singleton?} — registers a script/scene that will run when the game starts\n' +
      '- autoload_remove: {name}\n' +
      'Writes use ProjectSettings.save() (Godot re-sorts sections and drops comments, as the editor does); a backup of project.godot is kept in .godot/godot_mcp/backups/.',
    input: z.object({
      projectPath,
      action: z.enum(['get', 'set', 'input_set', 'input_remove', 'autoload_set', 'autoload_remove']),
      keys: z.array(z.string().max(256)).max(200).optional(),
      prefix: z.string().max(256).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      action_name: z.string().max(128).optional().describe('Input action name (alias: inputAction)'),
      inputAction: z.string().max(128).optional(),
      events: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
      deadzone: z.number().min(0).max(1).optional(),
      replace: z.boolean().optional(),
      name: z.string().max(128).optional().describe('Autoload name'),
      path: z.string().max(1024).optional().describe('Autoload script/scene path'),
      singleton: z.boolean().optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      if (a.action === 'get') {
        const { results } = await ctx.runOps(project, [{ op: 'project_settings_get', args: { keys: a.keys ?? [], prefix: a.prefix ?? '' } }], { signal });
        return { data: results[0] as Record<string, unknown> };
      }
      const inputName = a.action_name ?? a.inputAction;
      let op: { op: string; args: Record<string, unknown> };
      switch (a.action) {
        case 'set':
          if (!a.settings) throw new GodotMcpError(ErrorCode.InvalidArgument, 'settings is required for action "set"');
          op = { op: 'project_settings_set', args: { settings: a.settings } };
          break;
        case 'input_set':
          if (!inputName || !a.events) throw new GodotMcpError(ErrorCode.InvalidArgument, 'action_name and events are required for input_set');
          op = { op: 'input_action_set', args: { action: inputName, events: a.events, deadzone: a.deadzone, replace: a.replace ?? true } };
          break;
        case 'input_remove':
          if (!inputName) throw new GodotMcpError(ErrorCode.InvalidArgument, 'action_name is required for input_remove');
          op = { op: 'input_action_remove', args: { action: inputName } };
          break;
        case 'autoload_set':
          if (!a.name || !a.path) throw new GodotMcpError(ErrorCode.InvalidArgument, 'name and path are required for autoload_set');
          op = { op: 'autoload_set', args: { name: a.name, path: a.path, singleton: a.singleton ?? true } };
          break;
        default:
          if (!a.name) throw new GodotMcpError(ErrorCode.InvalidArgument, 'name is required for autoload_remove');
          op = { op: 'autoload_remove', args: { name: a.name } };
      }
      ctx.assertWritable(`godot_project_settings:${a.action}`);
      if (op.args.deadzone === undefined) delete op.args.deadzone;
      const result = await ctx.locks.run(project.root, async () => {
        const backup = ctx.backupProjectFile(project);
        const { results } = await ctx.runOps(project, [op], { signal, operation: `godot_project_settings:${a.action}` });
        return { ...(results[0] as Record<string, unknown>), backup };
      });
      return { data: result };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_project_validate',
    title: 'Validate the whole project',
    description:
      'Load every scene, resource, script and shader through Godot (headless, no autoloads) and report: parse/compile errors with file and line, missing dependencies (broken ext_resource paths/UIDs), scenes that cannot be instantiated, missing main scene and broken autoload paths. healthy=false if anything is wrong. Note: loading scripts runs their static initialisers.',
    input: z.object({
      projectPath,
      maxFiles: z.number().int().min(1).max(20000).optional(),
      includeAddons: z.boolean().optional(),
    }),
    annotations: READ_ONLY,
    handler: async ({ projectPath: p, maxFiles, includeAddons }, { signal }) => {
      const project = ctx.project(p);
      const { results } = await ctx.runOps(project, [{ op: 'project_validate', args: { max_files: maxFiles ?? 3000, include_addons: !!includeAddons } }], {
        signal,
      });
      const r = results[0] as Record<string, unknown>;
      return { data: r, summary: r.healthy ? 'Project validation passed.' : `Project validation found ${String(r.error_count)} problem(s).` };
    },
  });
}

export function statSafe(p: string): import('node:fs').Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
