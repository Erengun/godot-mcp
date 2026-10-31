/**
 * Read-only MCP resources:
 *   godot://docs/value-encoding   how property values are written/returned
 *   godot://server/status         server, Godot and session overview (JSON)
 *   godot://runtime/sessions      tracked game/editor sessions (JSON)
 *   godot://api/class/{className} ClassDB reflection of an engine class (JSON)
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.ts';
import type { ProjectRef } from '../security/paths.ts';
import { SERVER_VERSION } from '../tools/project.ts';

export const VALUE_ENCODING_DOC = `# godot-mcp value encoding

Property values are converted using the **declared type of the target property**, so natural JSON works:

| Godot type | Accepted input | Returned as |
|---|---|---|
| bool/int/float/String | JSON scalar | JSON scalar |
| enum int | 2 or "PROCESS_MODE_ALWAYS" / "always" | int |
| layer mask (collision_layer, ...) | 5 or [1, 3] (1-based layer numbers) | int |
| Vector2/3/4(i) | [x, y(, z, w)] or {"x":..,"y":..} | {"$type":"Vector2","value":[x,y]} |
| Color | "#ff8800", "red", [r,g,b(,a)], {"r":..} | {"$type":"Color","value":[r,g,b,a]} |
| Rect2(i) | [x, y, w, h] or {"position":[..],"size":[..]} | {"$type":"Rect2","position":..,"size":..} |
| Transform2D | {"origin":[x,y],"rotation_degrees":r,"scale":[sx,sy]} or {"x","y","origin"} | {"$type":"Transform2D","x","y","origin"} |
| Transform3D | {"origin":[..],"rotation_degrees":[..],"scale":[..]} or {"basis":{x,y,z},"origin"} | {"$type":"Transform3D","basis":{..},"origin":[..]} |
| Basis / Quaternion | {"rotation_degrees":[..]} / [x,y,z,w] or {"euler_degrees":[..]} | tagged |
| NodePath / StringName | "A/B" | {"$type":"NodePath","value":"A/B"} |
| Array / typed Array | [ ... ] (elements converted to the element type) | [ ... ] |
| Packed*Array | [ ... ] | {"$type":"PackedVector2Array","value":[[x,y],..]} |
| Dictionary | {...} | {...} or {"$type":"Dictionary","entries":[[k,v],..]} |
| Resource (typed property) | "res://path.tres" or {"$new":"BoxMesh","properties":{...}} | {"$type":"Resource","class","path"} or {"$type":"Resource","class","embedded":true,"properties":{..}} |
| Node reference (exported Node) | "../Target" or {"$type":"NodeRef","path":"../Target"} | — |

Rules:
- Strings are never implicitly loaded as resources; only resource-typed properties accept "res://" paths, and the loaded resource must match the property's class.
- \`script\`, \`owner\`, \`name\` cannot be set as properties — use attach_script / rename_node.
- Sub-resource properties: "shape:size", "mesh:material:albedo_color". Editing through an *external* resource is refused (edit that .tres instead).
- Non-JSON values in untyped contexts use explicit tags, e.g. {"$type":"Vector3","value":[0,1,0]}, {"$type":"float","value":1}.
- RID, Callable and Signal values cannot be set.
`;

/** A throwaway project used for engine-only reflection (no user project needed). */
let stubDir: string | null = null;

/**
 * A private, per-process (mkdtemp, 0700) throwaway project used for
 * engine-only reflection, so the API tools work without a user project and a
 * predictable shared temp path can never be pre-created by another user.
 */
export function stubProject(): ProjectRef {
  if (!stubDir || !existsSync(join(stubDir, 'project.godot'))) {
    stubDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'godot-mcp-stub-')));
    writeFileSync(join(stubDir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="godot-mcp reflection stub"\n');
  }
  return { root: stubDir, requested: stubDir };
}

export function removeStubProject(): void {
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  stubDir = null;
}

export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    'value-encoding',
    'godot://docs/value-encoding',
    { title: 'Value encoding', description: 'How godot-mcp converts JSON to Godot property values and back', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: VALUE_ENCODING_DOC }],
    }),
  );

  server.registerResource(
    'server-status',
    'godot://server/status',
    { title: 'Server status', description: 'godot-mcp and Godot installation status', mimeType: 'application/json' },
    async (uri) => {
      let godot: unknown;
      try {
        const g = await ctx.godot();
        godot = { path: g.path, version: g.version.raw, dotnet: g.version.dotnet };
      } catch (e) {
        godot = { error: (e as Error).message };
      }
      const body = {
        server: { name: 'godot-mcp', version: SERVER_VERSION },
        godot,
        readOnly: ctx.config.readOnly,
        allowedRoots: ctx.config.allowedRoots,
        sessions: ctx.runtime.list().length,
      };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerResource(
    'runtime-sessions',
    'godot://runtime/sessions',
    { title: 'Runtime sessions', description: 'Game and editor processes started by this server', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.runtime.list(), null, 2) }],
    }),
  );

  server.registerResource(
    'api-class',
    new ResourceTemplate('godot://api/class/{className}', { list: undefined }),
    {
      title: 'Godot class reference',
      description: 'ClassDB reflection (properties, methods, signals, enums) of an engine class in the installed Godot build',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const cls = String(variables.className ?? '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cls)) throw new Error('Invalid class name');
      const { results } = await ctx.runOps(stubProject(), [
        { op: 'api_class', args: { class: cls, sections: ['properties', 'methods', 'signals', 'enums', 'constants'] } },
      ]);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(results[0], null, 2) }] };
    },
  );
}
