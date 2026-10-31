import * as z from 'zod/v4';

export const projectPath = z.string().min(1).max(1024).describe('Absolute path of the Godot project directory (the folder containing project.godot)');

export const resPath = (what: string) => z.string().min(1).max(1024).describe(`${what} — "res://..." or a path relative to the project root`);

export const nodePath = (what = 'Node path relative to the scene root ("." for the root, e.g. "Player/Sprite2D")') =>
  z.string().min(1).max(1024).describe(what);

/**
 * Property values use Godot's types; write natural JSON and the server converts
 * it using the target property's declared type. See the godot://docs/value-encoding resource.
 */
export const properties = z
  .record(z.string(), z.unknown())
  .describe(
    'Property name -> value. Values are converted using the property type: vectors as [x,y(,z)], colors as "#rrggbb" or [r,g,b,a], ' +
      'enums as int or constant name, layer masks as [1,3], resources as "res://path" or {"$new":"ClassName","properties":{...}}, ' +
      'transforms as {"origin":[...],"rotation_degrees":[...],"scale":[...]}. Sub-resource properties use "shape:size".',
  );

export const expectedHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .optional()
  .describe('Optional sha256 of the file as last read (returned by inspect/edit tools). The write is refused if the file changed since.');

export const paging = {
  offset: z.number().int().min(0).optional().describe('Skip this many items (pagination)'),
  limit: z.number().int().min(1).max(2000).optional().describe('Maximum items to return'),
};
