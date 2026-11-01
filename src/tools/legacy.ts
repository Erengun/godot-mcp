/**
 * The 14 tool names of godot-mcp 0.x, kept as thin adapters over the new
 * core so existing prompts/configurations keep working. Both camelCase and
 * snake_case argument spellings are accepted, as before.
 *
 * Behavioural changes (all security/correctness fixes, see docs/mcp-tools.md):
 *  - paths are confined to the project (realpath + symlink checks);
 *  - add_node no longer loads arbitrary "res://" strings into any property
 *    (resources are only loaded for resource-typed properties, scripts never);
 *  - failures are reported as errors instead of success text;
 *  - run_project no longer passes -d (which could freeze the game on errors).
 * Set GODOT_MCP_LEGACY_TOOLS=false to hide these tools.
 */
import { readdirSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { resolveInProject, resolveSearchDirectory, SCENE_EXTENSIONS } from '../security/paths.ts';
import { resaveWithBackup } from './assets.ts';
import { launchEditor } from './editor.ts';
import { findProjects, listProjectFiles, projectName } from './project.ts';
import { DESTRUCTIVE, PROCESS, READ_ONLY, registerTool, WRITES } from './registry.ts';
import { runGame } from './runtime.ts';

type Args = Record<string, unknown>;

function pick(a: Args, camel: string, snake: string, required = true): string | undefined {
  const v = a[camel] ?? a[snake];
  if (v === undefined || v === null || v === '') {
    if (required) throw new GodotMcpError(ErrorCode.InvalidArgument, `${camel} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new GodotMcpError(ErrorCode.InvalidArgument, `${camel} must be a string`);
  return v;
}

const str = (d: string) => z.string().max(4096).optional().describe(d);
const alias = (camel: string) => z.string().max(4096).optional().describe(`Alias of ${camel}`);

export function registerLegacyTools(server: McpServer, ctx: AppContext): void {
  const legacyNote = ' (Legacy 0.x tool; prefer the godot_* tools.)';

  registerTool(server, ctx, {
    name: 'launch_editor',
    title: 'Launch editor (legacy)',
    description: 'Launch Godot editor for a specific project.' + legacyNote,
    input: z.object({ projectPath: str('Path to the Godot project directory'), project_path: alias('projectPath') }),
    annotations: PROCESS,
    handler: async (a, { signal }) => ({ data: await launchEditor(ctx, pick(a, 'projectPath', 'project_path')!, 0, signal) }),
  });

  registerTool(server, ctx, {
    name: 'run_project',
    title: 'Run project (legacy)',
    description: 'Run the Godot project and capture output. Use get_debug_output to read it.' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      scene: str('Optional: specific scene to run'),
    }),
    annotations: PROCESS,
    handler: async (a, { signal }) => {
      const data = await runGame(
        ctx,
        { projectPath: pick(a, 'projectPath', 'project_path')!, scene: pick(a, 'scene', 'scene', false), mode: 'background' },
        signal,
      );
      return { data, summary: 'Godot project started. Use get_debug_output to see output.' };
    },
  });

  registerTool(server, ctx, {
    name: 'get_debug_output',
    title: 'Get debug output (legacy)',
    description: 'Get the current debug output and errors of the project started with run_project.' + legacyNote,
    input: z.object({}),
    annotations: READ_ONLY,
    handler: async () => {
      const s = ctx.runtime.get(undefined, 'game');
      const lines = ctx.runtime.output(s, { tail: true, limit: 2000 }).lines;
      return {
        data: {
          output: lines.filter((l) => l.stream === 'stdout').map((l) => l.text),
          errors: lines.filter((l) => l.stream === 'stderr').map((l) => l.text),
          diagnostics: ctx.runtime.diagnostics(s),
          status: ctx.runtime.status(s),
        },
      };
    },
  });

  registerTool(server, ctx, {
    name: 'stop_project',
    title: 'Stop project (legacy)',
    description: 'Stop the currently running Godot project.' + legacyNote,
    input: z.object({}),
    annotations: PROCESS,
    handler: async () => {
      const s = ctx.runtime.get(undefined, 'game');
      if (!ctx.runtime.status(s).running) throw new GodotMcpError(ErrorCode.ProcessNotRunning, 'No active Godot process to stop.');
      await ctx.runtime.stopSession(s);
      const lines = ctx.runtime.output(s, { tail: true, limit: 2000 }).lines;
      return {
        data: {
          message: 'Godot project stopped',
          finalOutput: lines.filter((l) => l.stream === 'stdout').map((l) => l.text),
          finalErrors: lines.filter((l) => l.stream === 'stderr').map((l) => l.text),
        },
      };
    },
  });

  registerTool(server, ctx, {
    name: 'get_godot_version',
    title: 'Godot version (legacy)',
    description: 'Get the installed Godot version.' + legacyNote,
    input: z.object({}),
    annotations: READ_ONLY,
    handler: async () => {
      const g = await ctx.godot();
      return { data: { version: g.version.raw, path: g.path, dotnet: g.version.dotnet }, summary: g.version.raw };
    },
  });

  registerTool(server, ctx, {
    name: 'list_projects',
    title: 'List projects (legacy)',
    description: 'List Godot projects in a directory.' + legacyNote,
    input: z.object({
      directory: str('Directory to search for Godot projects'),
      recursive: z.boolean().optional().describe('Whether to search recursively (default: false)'),
    }),
    annotations: READ_ONLY,
    handler: async (a) => {
      const dir = resolveSearchDirectory(pick(a, 'directory', 'directory'), ctx.config.allowedRoots);
      const projects = findProjects(dir, a.recursive ? 4 : 1, 200);
      return { data: { projects } };
    },
  });

  registerTool(server, ctx, {
    name: 'get_project_info',
    title: 'Project info (legacy)',
    description: 'Retrieve metadata about a Godot project.' + legacyNote,
    input: z.object({ projectPath: str('Path to the Godot project directory'), project_path: alias('projectPath') }),
    annotations: READ_ONLY,
    handler: async (a) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const g = await ctx.godot();
      const { files } = listProjectFiles(project, { includeAddons: true });
      const structure = { scenes: 0, scripts: 0, assets: 0, other: 0 };
      for (const f of files) {
        if (f.kind === 'scenes') structure.scenes++;
        else if (f.kind === 'scripts') structure.scripts++;
        else if (['textures', 'audio', 'fonts', 'models'].includes(f.kind)) structure.assets++;
        else structure.other++;
      }
      return {
        data: {
          name: projectName(project.root),
          path: project.root,
          godotVersion: g.version.raw,
          structure,
          csproj: readdirSync(project.root).filter((f) => f.endsWith('.csproj')),
        },
      };
    },
  });

  registerTool(server, ctx, {
    name: 'create_scene',
    title: 'Create scene (legacy)',
    description: 'Create a new Godot scene file (root node named "root", as in 0.x).' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      scenePath: str('Path where the scene file will be saved (relative to project)'),
      scene_path: alias('scenePath'),
      rootNodeType: str('Type of the root node (e.g., Node2D, Node3D)'),
      root_node_type: alias('rootNodeType'),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const scene = resolveInProject(pick(a, 'scenePath', 'scene_path'), project, {
        forWrite: true,
        extensions: ['.tscn'],
        mustNotExist: true,
        label: 'scenePath',
      });
      const { result } = await ctx.guardedWrite(project, scene, { operation: 'create_scene' }, async () => {
        const { results } = await ctx.runOps(
          project,
          [{ op: 'scene_create', args: { scene: scene.res, root_type: pick(a, 'rootNodeType', 'root_node_type', false) ?? 'Node2D', root_name: 'root' } }],
          { signal, mutates: true },
        );
        return results[0] as Record<string, unknown>;
      });
      return { data: result, summary: `Scene created successfully at: ${scene.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'add_node',
    title: 'Add node (legacy)',
    description: 'Add a node to an existing scene.' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      scenePath: str('Path to the scene file (relative to project)'),
      scene_path: alias('scenePath'),
      parentNodePath: str('Path to the parent node (e.g., "root" or "root/Player")'),
      parent_node_path: alias('parentNodePath'),
      nodeType: str('Type of node to add (e.g., Sprite2D, CollisionShape2D)'),
      node_type: alias('nodeType'),
      nodeName: str('Name for the new node'),
      node_name: alias('nodeName'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Optional properties to set on the node'),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const scene = resolveInProject(pick(a, 'scenePath', 'scene_path'), project, {
        mustExist: true,
        forWrite: true,
        extensions: SCENE_EXTENSIONS,
        label: 'scenePath',
      });
      const action = {
        action: 'add_node',
        parent: pick(a, 'parentNodePath', 'parent_node_path', false) ?? '.',
        type: pick(a, 'nodeType', 'node_type'),
        name: pick(a, 'nodeName', 'node_name'),
        properties: a.properties ?? {},
      };
      const { result } = await ctx.guardedWrite(project, scene, { operation: 'add_node' }, async () => {
        const { results } = await ctx.runOps(project, [{ op: 'scene_edit', args: { scene: scene.res, actions: [action] } }], { signal, mutates: true });
        return results[0] as Record<string, unknown>;
      });
      return { data: result, summary: `Node '${String(action.name)}' of type '${String(action.type)}' added successfully to '${scene.res}'.` };
    },
  });

  registerTool(server, ctx, {
    name: 'load_sprite',
    title: 'Load sprite (legacy)',
    description: 'Load a texture into a Sprite2D, Sprite3D or TextureRect node. The texture must be imported.' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      scenePath: str('Path to the scene file (relative to project)'),
      scene_path: alias('scenePath'),
      nodePath: str('Path to the Sprite2D node (e.g., "root/Player/Sprite2D")'),
      node_path: alias('nodePath'),
      texturePath: str('Path to the texture file (relative to project)'),
      texture_path: alias('texturePath'),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const scene = resolveInProject(pick(a, 'scenePath', 'scene_path'), project, {
        mustExist: true,
        forWrite: true,
        extensions: SCENE_EXTENSIONS,
        label: 'scenePath',
      });
      const tex = resolveInProject(pick(a, 'texturePath', 'texture_path'), project, { mustExist: true, label: 'texturePath' });
      const node = pick(a, 'nodePath', 'node_path')!;
      const info = (
        await ctx.runOps(
          project,
          [{ op: 'node_inspect', args: { scene: scene.res, node, include_class_properties: false, include_script_properties: false } }],
          { signal },
        )
      ).results[0] as { type?: string };
      if (!['Sprite2D', 'Sprite3D', 'TextureRect'].includes(info.type ?? '')) {
        throw new GodotMcpError(ErrorCode.InvalidArgument, `Node is not a sprite-compatible type: ${String(info.type)}`);
      }
      const { result } = await ctx.guardedWrite(project, scene, { operation: 'load_sprite' }, async () => {
        const { results } = await ctx.runOps(
          project,
          [{ op: 'scene_edit', args: { scene: scene.res, actions: [{ action: 'set_properties', node, properties: { texture: tex.res } }] } }],
          { signal, mutates: true },
        );
        return results[0] as Record<string, unknown>;
      });
      return { data: result, summary: `Sprite loaded successfully with texture: ${tex.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'export_mesh_library',
    title: 'Export MeshLibrary (legacy)',
    description: 'Export a scene as a MeshLibrary resource.' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      scenePath: str('Path to the scene file (.tscn) to export'),
      scene_path: alias('scenePath'),
      outputPath: str('Path where the mesh library (.res) will be saved'),
      output_path: alias('outputPath'),
      meshItemNames: z.array(z.string().max(256)).max(1000).optional().describe('Optional: names of specific mesh items to include (defaults to all)'),
      mesh_item_names: z.array(z.string().max(256)).max(1000).optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const scene = resolveInProject(pick(a, 'scenePath', 'scene_path'), project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scenePath' });
      const out = resolveInProject(pick(a, 'outputPath', 'output_path'), project, {
        forWrite: true,
        extensions: ['.res', '.tres', '.meshlib'],
        label: 'outputPath',
      });
      const { result } = await ctx.guardedWrite(project, out, { operation: 'export_mesh_library' }, async () => {
        const { results } = await ctx.runOps(
          project,
          [{ op: 'mesh_library_export', args: { scene: scene.res, output: out.res, items: a.meshItemNames ?? a.mesh_item_names ?? [] } }],
          { signal, mutates: true },
        );
        return results[0] as Record<string, unknown>;
      });
      return { data: result, summary: `MeshLibrary exported successfully to: ${out.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'save_scene',
    title: 'Save scene (legacy)',
    description: 'Re-save a scene file through Godot, optionally to a new path (variant).' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      scenePath: str('Path to the scene file (relative to project)'),
      scene_path: alias('scenePath'),
      newPath: str('Optional: new path to save the scene to'),
      new_path: alias('newPath'),
    }),
    annotations: DESTRUCTIVE,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const scene = resolveInProject(pick(a, 'scenePath', 'scene_path'), project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scenePath' });
      const newPath = pick(a, 'newPath', 'new_path', false);
      const target = resolveInProject(newPath ?? scene.res, project, {
        forWrite: true,
        extensions: SCENE_EXTENSIONS,
        label: newPath ? 'newPath' : 'scenePath',
      });
      const { result } = await ctx.guardedWrite(project, target, { operation: 'save_scene' }, async () => {
        const { results } = await ctx.runOps(project, [{ op: 'scene_save_as', args: { scene: scene.res, new_path: target.res, overwrite: true } }], {
          signal,
          mutates: true,
        });
        return results[0] as Record<string, unknown>;
      });
      return { data: result, summary: `Scene saved successfully to: ${target.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'get_uid',
    title: 'Get UID (legacy)',
    description: 'Get the UID for a specific file in a Godot project (Godot 4.4+).' + legacyNote,
    input: z.object({
      projectPath: str('Path to the Godot project directory'),
      project_path: alias('projectPath'),
      filePath: str('Path to the file (relative to project)'),
      file_path: alias('filePath'),
    }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      const f = resolveInProject(pick(a, 'filePath', 'file_path'), project, { mustExist: true, label: 'filePath' });
      const { results } = await ctx.runOps(project, [{ op: 'uid_get', args: { path: f.res } }], { signal });
      const r = results[0] as { uid?: string };
      return { data: results[0] as Record<string, unknown>, summary: r.uid ? `UID for ${f.res}: ${r.uid}` : `No UID for ${f.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'update_project_uids',
    title: 'Update project UIDs (legacy)',
    description: 'Update UID references in a Godot project by resaving resources (Godot 4.4+).' + legacyNote,
    input: z.object({ projectPath: str('Path to the Godot project directory'), project_path: alias('projectPath') }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(pick(a, 'projectPath', 'project_path'));
      return { data: await resaveWithBackup(ctx, project, false, 'update_project_uids', signal), summary: 'Project UIDs updated.' };
    },
  });
}
