import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { RESOURCE_EXTENSIONS, resolveInProject, SCENE_EXTENSIONS } from '../security/paths.ts';
import { fileHash } from '../util/hash.ts';
import { expectedHash, projectPath, properties, resPath } from './schemas.ts';
import { READ_ONLY, registerTool, WRITES } from './registry.ts';

export function registerResourceTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_resource_inspect',
    title: 'Inspect a resource or asset',
    description:
      'Load any resource through Godot (.tres/.res, imported textures, models, audio, fonts, scenes) and describe it: class, stored properties (embedded sub-resources expanded to `depth`), UID, dependencies and type-specific facts (texture size, mesh surfaces/AABB, animation tracks, TileSet sources, MeshLibrary items, audio length). Fails clearly if the asset is not imported.',
    input: z.object({ projectPath, path: resPath('Resource file'), depth: z.number().int().min(0).max(5).optional() }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const r = resolveInProject(a.path, project, { mustExist: true, label: 'path' });
      const { results } = await ctx.runOps(project, [{ op: 'resource_inspect', args: { path: r.res, depth: a.depth ?? 2 } }], { signal });
      return { data: { ...(results[0] as Record<string, unknown>), sha256: fileHash(r.abs) } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_resource_create',
    title: 'Create a resource file',
    description:
      'Create a .tres/.res of any instantiable Resource class (StandardMaterial3D, ShaderMaterial, BoxMesh, CapsuleShape3D, RectangleShape2D, Theme, Environment, PhysicsMaterial, NavigationMesh, Animation, Gradient, Curve, LabelSettings, ...) with typed properties, then reload and verify it. Script and editor classes are refused. Nested resources: {"$new":"Class","properties":{...}}.',
    input: z.object({
      projectPath,
      path: resPath('New resource file (.tres or .res)'),
      type: z.string().min(1).max(128).describe('Resource class name'),
      properties: properties.optional(),
      overwrite: z.boolean().optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const r = resolveInProject(a.path, project, { forWrite: true, extensions: RESOURCE_EXTENSIONS, mustNotExist: !a.overwrite, label: 'path' });
      const { result, hashAfter } = await ctx.guardedWrite(project, r, { operation: 'godot_resource_create' }, async () => {
        const { results } = await ctx.runOps(
          project,
          [{ op: 'resource_create', args: { path: r.res, type: a.type, properties: a.properties ?? {}, overwrite: !!a.overwrite } }],
          { signal, mutates: true, operation: 'godot_resource_create' },
        );
        return results[0] as Record<string, unknown>;
      });
      return { data: { ...result, sha256: hashAfter }, summary: `Created ${r.res}` };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_resource_edit',
    title: 'Edit a resource file',
    description:
      'Set typed properties on an existing .tres/.res and save it (UID preserved, reloaded and verified, rolled back on failure). Imported assets (textures, models) are not editable here — they are configured by their .import settings.',
    input: z.object({ projectPath, path: resPath('Resource file (.tres/.res)'), properties, expectedHash }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const r = resolveInProject(a.path, project, { mustExist: true, forWrite: true, extensions: RESOURCE_EXTENSIONS, label: 'path' });
      const { result, hashBefore, hashAfter } = await ctx.guardedWrite(
        project,
        r,
        { operation: 'godot_resource_edit', expectedHash: a.expectedHash },
        async () => {
          const { results } = await ctx.runOps(project, [{ op: 'resource_edit', args: { path: r.res, properties: a.properties } }], {
            signal,
            mutates: true,
            operation: 'godot_resource_edit',
          });
          return results[0] as Record<string, unknown>;
        },
      );
      return { data: { ...result, sha256Before: hashBefore, sha256: hashAfter } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_resource_build',
    title: 'Build composite resources',
    description:
      'Build native composite resources from assets:\n' +
      '- tileset_atlas {path, texture, tileSize:[w,h], margins?, separation?, tiles?:[[x,y]...], collision?: "full", collisionTiles?:[[x,y]...], collisionLayer?} -> TileSet with a TileSetAtlasSource (and optional full-tile collision polygons on physics layer 0)\n' +
      '- sprite_frames {path, texture, frameSize:[w,h], animations:[{name, frames:[0,1,2], fps?, loop?}]} -> SpriteFrames for AnimatedSprite2D/3D using AtlasTexture regions\n' +
      '- mesh_library {path, scene, items?:[names]} -> MeshLibrary for GridMap from the root children of a 3D scene (mesh, material override and collision shapes)\n' +
      'Textures must be imported (see godot_assets).',
    input: z.object({
      projectPath,
      kind: z.enum(['tileset_atlas', 'sprite_frames', 'mesh_library']),
      path: resPath('Output resource (.tres/.res)'),
      texture: z.string().max(1024).optional(),
      tileSize: z.array(z.number().int().positive()).length(2).optional(),
      margins: z.array(z.number().int().min(0)).length(2).optional(),
      separation: z.array(z.number().int().min(0)).length(2).optional(),
      tiles: z.array(z.array(z.number().int()).length(2)).max(10000).optional(),
      collision: z.enum(['none', 'full']).optional(),
      collisionTiles: z.array(z.array(z.number().int()).length(2)).max(10000).optional(),
      collisionLayer: z.number().int().min(1).optional(),
      frameSize: z.array(z.number().int().positive()).length(2).optional(),
      animations: z
        .array(
          z.object({
            name: z.string().min(1).max(64),
            frames: z.array(z.number().int().min(0)).max(1000),
            fps: z.number().positive().optional(),
            loop: z.boolean().optional(),
          }),
        )
        .max(100)
        .optional(),
      scene: z.string().max(1024).optional(),
      items: z.array(z.string().max(128)).max(1000).optional(),
      overwrite: z.boolean().optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const out = resolveInProject(a.path, project, {
        forWrite: true,
        extensions: a.kind === 'mesh_library' ? ['.tres', '.res', '.meshlib'] : RESOURCE_EXTENSIONS,
        mustNotExist: !a.overwrite,
        label: 'path',
      });
      let op: { op: string; args: Record<string, unknown> };
      if (a.kind === 'mesh_library') {
        if (!a.scene) throw new GodotMcpError(ErrorCode.InvalidArgument, 'scene is required for mesh_library');
        const scene = resolveInProject(a.scene, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scene' });
        op = { op: 'mesh_library_export', args: { scene: scene.res, output: out.res, items: a.items ?? [] } };
      } else {
        if (!a.texture) throw new GodotMcpError(ErrorCode.InvalidArgument, 'texture is required');
        const tex = resolveInProject(a.texture, project, { mustExist: true, label: 'texture' });
        op =
          a.kind === 'tileset_atlas'
            ? {
                op: 'tileset_create_atlas',
                args: {
                  path: out.res,
                  texture: tex.res,
                  tile_size: a.tileSize ?? [16, 16],
                  margins: a.margins,
                  separation: a.separation,
                  tiles: a.tiles,
                  collision: a.collision ?? 'none',
                  collision_tiles: a.collisionTiles,
                  collision_layer: a.collisionLayer,
                  overwrite: !!a.overwrite,
                },
              }
            : {
                op: 'sprite_frames_create',
                args: { path: out.res, texture: tex.res, frame_size: a.frameSize, animations: a.animations ?? [], overwrite: !!a.overwrite },
              };
        for (const k of Object.keys(op.args)) if (op.args[k] === undefined) delete op.args[k];
      }
      const { result, hashAfter } = await ctx.guardedWrite(project, out, { operation: `godot_resource_build:${a.kind}` }, async () => {
        const { results } = await ctx.runOps(project, [op], { signal, mutates: true, operation: `godot_resource_build:${a.kind}` });
        return results[0] as Record<string, unknown>;
      });
      return { data: { ...result, sha256: hashAfter } };
    },
  });
}
