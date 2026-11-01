import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import type { ProjectRef } from '../security/paths.ts';
import { resolveInProject, SCENE_EXTENSIONS, SCRIPT_EXTENSIONS } from '../security/paths.ts';
import { fileHash } from '../util/hash.ts';
import { expectedHash, nodePath, paging, projectPath, properties, resPath } from './schemas.ts';
import { READ_ONLY, registerTool, WRITES } from './registry.ts';

export const SCENE_ACTIONS = [
  'add_node',
  'remove_node',
  'rename_node',
  'move_node',
  'reorder_node',
  'duplicate_node',
  'instantiate_scene',
  'set_properties',
  'attach_script',
  'detach_script',
  'connect_signal',
  'disconnect_signal',
  'add_to_group',
  'remove_from_group',
  'set_editable_children',
  'animation_upsert',
  'animation_remove',
  'animation_keys',
  'tilemap_set_cells',
  'tilemap_erase_cells',
  'tilemap_fill_rect',
  'gridmap_set_cells',
  'gridmap_clear_cells',
] as const;

const ACTION_DOC = `Each action is an object with "action" plus fields:
- add_node {parent=".", type, name, properties?, index?, if_exists?: "error"|"skip"}  (type: built-in Node class or project class_name; never a path)
- remove_node {node}
- rename_node {node, new_name}
- move_node {node, new_parent, index?, keep_global_transform?}
- reorder_node {node, index}
- duplicate_node {node, new_name?, parent?}  (only nodes this scene file defines itself — not nodes of an inherited scene or inside an instance; change or remove the original in a separate call)
- instantiate_scene {parent, scene, name?, properties?, index?, if_exists?}  (keeps the sub-scene as an instance, never flattened)
- set_properties {node, properties}
- attach_script {node, script, properties?} / detach_script {node}
- connect_signal {from, signal, to, method, binds?, unbinds?, deferred?, one_shot?, allow_missing_method?}  (persistent; argument counts are checked against the method signature)
- disconnect_signal {from, signal, to, method}
- add_to_group / remove_from_group {node, group}
- set_editable_children {node, editable}
- animation_upsert {player, library="", name, length?, loop_mode?: none|linear|pingpong, step?, autoplay?, replace?, tracks:[{type: value|position_3d|rotation_3d|scale_3d|blend_shape|method|bezier, path:"Sprite2D:position", interpolation?, update_mode?, replace_keys?, keys:[{time, value, transition?} | {time, method, args} (method) | {time, value, in_handle, out_handle} (bezier)]}]}
- animation_remove {player, library?, name}
- animation_keys {player, library?, name, track (index or path), insert?:[keys], remove_times?:[t]}
- tilemap_set_cells {node, cells:[{coords:[x,y], source_id?, atlas_coords?, alternative?}], source_id?, atlas_coords?}
- tilemap_erase_cells {node, cells:[[x,y],...]}
- tilemap_fill_rect {node, rect:[x,y,w,h], source_id?, atlas_coords?, alternative?}
- gridmap_set_cells {node, cells:[{position:[x,y,z], item (id or name), orientation?}]} / gridmap_clear_cells {node, cells:[[x,y,z]]}
Node paths are relative to the scene root ("." = root; legacy "root/..." also accepted).`;

const actionSchema = z
  .object({ action: z.enum(SCENE_ACTIONS) })
  .catchall(z.unknown())
  .describe('One edit action; see the tool description for fields');

/** Validate path-valued action fields in TypeScript too (symlink-aware). */
function checkActionPaths(project: ProjectRef, actions: Array<Record<string, unknown>>): void {
  for (const a of actions) {
    if (a.action === 'instantiate_scene' && a.scene !== undefined) {
      resolveInProject(a.scene, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'instantiate_scene.scene' });
    }
    if (a.action === 'attach_script' && a.script !== undefined) {
      resolveInProject(a.script, project, { mustExist: true, extensions: SCRIPT_EXTENSIONS, label: 'attach_script.script' });
    }
  }
}

export function registerSceneTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_scene_inspect',
    title: 'Inspect a scene tree',
    description:
      'Read a .tscn/.scn without running any of its scripts (uses PackedScene.get_state()). Returns nodes (path, type, parent, groups, script, instanced sub-scene, inheritance), signal connections and dependencies; property values on request. Paginated; narrow with node and maxDepth for big scenes. Also returns the file sha256 for use as expectedHash.',
    input: z.object({
      projectPath,
      scenePath: resPath('Scene file'),
      node: z.string().max(1024).optional().describe('Only this node and its descendants'),
      maxDepth: z.number().int().min(0).max(64).optional(),
      includeProperties: z.boolean().optional().describe('Include stored (non-default) property values'),
      includeConnections: z.boolean().optional(),
      ...paging,
    }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const scene = resolveInProject(a.scenePath, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scenePath' });
      const { results } = await ctx.runOps(
        project,
        [
          {
            op: 'scene_inspect',
            args: {
              scene: scene.res,
              node: a.node ?? '',
              max_depth: a.maxDepth ?? -1,
              include_properties: !!a.includeProperties,
              include_connections: a.includeConnections ?? true,
              offset: a.offset ?? 0,
              limit: a.limit ?? 200,
            },
          },
        ],
        { signal },
      );
      return { data: { ...(results[0] as Record<string, unknown>), sha256: fileHash(scene.abs) } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_node_inspect',
    title: 'Inspect one node',
    description:
      "Detailed view of one node stored in a scene: its stored property values, script, groups and connections, plus the editable properties its class offers (with types, enum hints and defaults from ClassDB) and its script's exported properties. Use before set_properties to learn exact property names/types. Does not run scene scripts (script reflection loads the script, which runs static initialisers only).",
    input: z.object({
      projectPath,
      scenePath: resPath('Scene file'),
      nodePath: nodePath(),
      filter: z.string().max(100).optional().describe('Only class properties whose name contains this'),
      includeClassProperties: z.boolean().optional(),
    }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const scene = resolveInProject(a.scenePath, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scenePath' });
      const { results } = await ctx.runOps(
        project,
        [
          {
            op: 'node_inspect',
            args: { scene: scene.res, node: a.nodePath, filter: a.filter ?? '', include_class_properties: a.includeClassProperties ?? true },
          },
        ],
        { signal },
      );
      return { data: results[0] as Record<string, unknown> };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_scene_create',
    title: 'Create a scene',
    description:
      'Create a new scene file with a root node of the given class (built-in or project class_name), or an inherited scene (inherits: "res://base.tscn"). The file is saved by Godot, reloaded and verified, and gets a UID like editor-created scenes. Refuses to overwrite unless overwrite=true.',
    input: z.object({
      projectPath,
      scenePath: resPath('New scene file (.tscn)'),
      rootType: z.string().max(128).optional().describe('Root node class, e.g. Node2D, Node3D, Control, CharacterBody2D (default Node2D)'),
      rootName: z.string().max(128).optional().describe('Root node name (default: PascalCase of the file name)'),
      inherits: z.string().max(1024).optional().describe('Create an inherited scene from this base scene instead'),
      properties: properties.optional(),
      overwrite: z.boolean().optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const scene = resolveInProject(a.scenePath, project, { forWrite: true, extensions: ['.tscn'], mustNotExist: !a.overwrite, label: 'scenePath' });
      if (a.inherits) resolveInProject(a.inherits, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'inherits' });
      const { result, hashAfter, editorNote } = await ctx.guardedWrite(project, scene, { operation: 'godot_scene_create' }, async () => {
        const { results } = await ctx.runOps(
          project,
          [
            {
              op: 'scene_create',
              args: {
                scene: scene.res,
                root_type: a.rootType ?? 'Node2D',
                root_name: a.rootName ?? '',
                inherits: a.inherits ?? '',
                properties: a.properties ?? {},
                overwrite: !!a.overwrite,
              },
            },
          ],
          { signal, mutates: true, operation: 'godot_scene_create' },
        );
        return results[0] as Record<string, unknown>;
      });
      return { data: { ...result, sha256: hashAfter, editor: editorNote }, summary: `Created ${scene.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_scene_edit',
    title: 'Edit a scene (batched, all-or-nothing)',
    description:
      "Apply a list of edit actions to a scene file in one Godot process and save once. If any action fails nothing is written. The scene is instantiated the way the editor does (inherited scenes, instanced sub-scenes and their overrides are preserved, never flattened); the saved file is reloaded and verified, its UID is kept, and it is rolled back if verification fails. Refuses to write a scene that has unsaved changes in a connected editor. Note: attached scripts' _init() and setters run while the scene is instantiated; _ready/_process do not.\n\n" +
      ACTION_DOC,
    input: z.object({
      projectPath,
      scenePath: resPath('Scene file to edit'),
      actions: z.array(actionSchema).min(1).max(500),
      dryRun: z.boolean().optional().describe('Validate and apply in memory but do not save'),
      saveAs: z.string().max(1024).optional().describe('Save the result to a different file instead of overwriting'),
      overwrite: z.boolean().optional().describe('With saveAs: replace the target if it already exists'),
      expectedHash,
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const scene = resolveInProject(a.scenePath, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scenePath' });
      // saveAs naming the scene itself is a plain save, which needs no overwrite.
      const sameFile = !!a.saveAs && resolveInProject(a.saveAs, project, { extensions: ['.tscn', '.scn'], label: 'saveAs' }).res === scene.res;
      const target = a.saveAs
        ? resolveInProject(a.saveAs, project, { forWrite: true, extensions: ['.tscn', '.scn'], mustNotExist: !a.overwrite && !sameFile, label: 'saveAs' })
        : resolveInProject(a.scenePath, project, { forWrite: true, extensions: SCENE_EXTENSIONS, label: 'scenePath' });
      checkActionPaths(project, a.actions as Array<Record<string, unknown>>);
      const args = { scene: scene.res, actions: a.actions, dry_run: !!a.dryRun, save_as: a.saveAs ? target.res : '', overwrite: !!a.overwrite };
      if (a.dryRun) {
        const { results } = await ctx.runOps(project, [{ op: 'scene_edit', args }], { signal, operation: 'godot_scene_edit(dry run)' });
        return { data: results[0] as Record<string, unknown>, summary: 'Dry run: all actions applied in memory; nothing saved.' };
      }
      // expectedHash always refers to the scene that was read (scenePath), also with saveAs.
      const { result, hashBefore, hashAfter, editorNote } = await ctx.guardedWrite(
        project,
        target,
        {
          operation: 'godot_scene_edit',
          expectedHash: a.saveAs ? undefined : a.expectedHash,
          precheck: a.saveAs ? () => ctx.assertHash(scene, a.expectedHash) : undefined,
        },
        async () => {
          const { results } = await ctx.runOps(project, [{ op: 'scene_edit', args }], { signal, mutates: true, operation: 'godot_scene_edit' });
          return results[0] as Record<string, unknown>;
        },
      );
      return {
        data: { ...result, sha256Before: hashBefore, sha256: hashAfter, editor: editorNote },
        summary: `Applied ${a.actions.length} action(s) to ${target.res}`,
      };
    },
  });
}
