import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { stubProject } from '../resources/index.ts';
import { projectPath } from './schemas.ts';
import { READ_ONLY, registerTool } from './registry.ts';

/**
 * Engine-class reflection results depend only on the Godot build, so they are
 * cached per (godot version, query). Project classes are never cached.
 */
const cache = new Map<string, Record<string, unknown>>();
const CACHE_LIMIT = 500;

function remember(key: string, value: Record<string, unknown>): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

export function registerApiTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_api_search',
    title: 'Search the Godot API',
    description:
      "Search classes of the installed Godot build via ClassDB (plus the project's class_name scripts): filter by name substring, kind (node/resource) and base class. Shows whether each class can be created through MCP tools. Use it to discover node/resource types instead of guessing.",
    input: z.object({
      projectPath: projectPath.optional().describe('Project whose class_name scripts should be included (optional)'),
      query: z.string().max(100).optional(),
      kind: z.enum(['any', 'node', 'resource', 'object']).optional(),
      inherits: z.string().max(100).optional().describe('Only classes inheriting this one (e.g. CollisionObject3D)'),
      includeEditor: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = a.projectPath ? ctx.project(a.projectPath) : stubProject();
      const { results } = await ctx.runOps(
        project,
        [
          {
            op: 'api_search',
            args: { query: a.query ?? '', kind: a.kind ?? 'any', inherits: a.inherits ?? '', include_editor: !!a.includeEditor, limit: a.limit ?? 50 },
          },
        ],
        { signal },
      );
      return { data: results[0] as Record<string, unknown> };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_api_class',
    title: 'Describe a Godot class',
    description:
      'Reflect one class of the installed Godot build (ClassDB): inheritance chain, properties (type, hints/enum values, defaults), methods (argument types, defaults), signals, enums and constants; or a project class_name script. Use filter to narrow, includeInherited for members of base classes.',
    input: z.object({
      projectPath: projectPath.optional().describe('Needed only for project class_name scripts'),
      className: z.string().min(1).max(128),
      filter: z.string().max(100).optional(),
      includeInherited: z.boolean().optional(),
      sections: z.array(z.enum(['properties', 'methods', 'signals', 'enums', 'constants'])).optional(),
      includeVirtual: z.boolean().optional(),
    }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = a.projectPath ? ctx.project(a.projectPath) : stubProject();
      const godot = await ctx.godot();
      const args = {
        class: a.className,
        filter: a.filter ?? '',
        include_inherited: !!a.includeInherited,
        sections: a.sections ?? ['properties', 'methods', 'signals', 'enums', 'constants'],
        include_virtual: !!a.includeVirtual,
      };
      const key = `${godot.version.raw}|${JSON.stringify(args)}`;
      const hit = cache.get(key);
      if (hit) return { data: { ...hit, cached: true } };
      const { results } = await ctx.runOps(project, [{ op: 'api_class', args }], { signal });
      const data = results[0] as Record<string, unknown>;
      if (!data.project_class) remember(key, data);
      return { data };
    },
  });
}
