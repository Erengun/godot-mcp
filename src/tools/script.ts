import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { resolveInProject, SCRIPT_EXTENSIONS } from '../security/paths.ts';
import { fileHash, sha256 } from '../util/hash.ts';
import { classCacheHas, runImport } from './assets.ts';
import { expectedHash, projectPath, resPath } from './schemas.ts';
import { READ_ONLY, registerTool, WRITES } from './registry.ts';

/** Write via a temp file in the same directory + rename (atomic on POSIX/NTFS). */
export function atomicWrite(abs: string, content: string | Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.godot-mcp-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

export function registerScriptTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_script_validate',
    title: 'Validate GDScript',
    description:
      "Compile GDScript with Godot's own parser/analyzer and return errors with file and line (wrong argument counts, undeclared identifiers, type errors the analyzer can prove, bad syntax). Pass paths, all=true for every script, or source (unsaved text). Headless limitation: identifiers that refer to autoload singletons cannot be resolved and are reported as info notes, not errors. C# files are skipped (use godot_dotnet).",
    input: z.object({
      projectPath,
      paths: z.array(z.string().max(1024)).max(500).optional(),
      all: z.boolean().optional(),
      includeAddons: z.boolean().optional(),
      source: z
        .string()
        .max(2 * 1024 * 1024)
        .optional()
        .describe('Unsaved GDScript source to validate'),
      sourcePath: z.string().max(1024).optional().describe('Label used for diagnostics when validating source'),
    }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      if (a.source !== undefined) {
        const { results } = await ctx.runOps(project, [{ op: 'script_validate_source', args: { source: a.source, path: a.sourcePath ?? 'unsaved.gd' } }], {
          signal,
        });
        return { data: results[0] as Record<string, unknown> };
      }
      const paths = (a.paths ?? []).map((p) => resolveInProject(p, project, { mustExist: true, extensions: ['.gd', '.cs'], label: 'paths[]' }).res);
      const { results } = await ctx.runOps(project, [{ op: 'script_validate', args: { paths, all: !!a.all, include_addons: !!a.includeAddons } }], { signal });
      const r = results[0] as Record<string, unknown>;
      return {
        data: r,
        summary: r.valid
          ? `All ${String(r.checked)} script(s) compiled without errors.`
          : `${String(r.invalid)} of ${String(r.checked)} script(s) have errors.`,
      };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_script_inspect',
    title: 'Inspect a script',
    description:
      'Reflect a script through Godot: class_name, extends, base script, tool mode, methods with typed arguments and required-argument counts, properties (exported or not), signals with arguments, constants, dependencies; optionally the source text. Loading the script runs its static initialisers only.',
    input: z.object({ projectPath, path: resPath('Script file'), includeSource: z.boolean().optional() }),
    annotations: READ_ONLY,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const r = resolveInProject(a.path, project, { mustExist: true, extensions: SCRIPT_EXTENSIONS, label: 'path' });
      const data: Record<string, unknown> = { path: r.res, sha256: fileHash(r.abs) };
      if (r.rel.endsWith('.gd')) {
        const { results } = await ctx.runOps(project, [{ op: 'script_inspect', args: { path: r.res } }], { signal });
        Object.assign(data, results[0] as Record<string, unknown>);
      } else {
        data.note = 'Reflection is only available for GDScript; source returned as text.';
      }
      if (a.includeSource || !r.rel.endsWith('.gd')) {
        const text = readFileSync(r.abs, 'utf8');
        data.source = text.length > ctx.config.maxResponseBytes ? `${text.slice(0, ctx.config.maxResponseBytes)}\n... [TRUNCATED]` : text;
      }
      return { data };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_script_write',
    title: 'Create or replace a script',
    description:
      'Write a .gd, .gdshader, .gdshaderinc or .cs file inside the project (atomic replace), then validate GDScript with Godot. By default a GDScript that fails to compile is rolled back to the previous content (or deleted if it was new) and the errors are returned; pass keepOnError=true to keep it. Use expectedHash to avoid overwriting concurrent changes. ' +
      'When the script declares a new class_name (or refers to a class_name Godot has not registered yet) the global class cache is refreshed with the editor importer (`--import`, which runs editor plugins) so other scripts can use the type; disable with refreshClassCache: "never".',
    input: z.object({
      projectPath,
      path: resPath('Script file'),
      content: z.string().max(2 * 1024 * 1024),
      overwrite: z.boolean().optional().describe('Allow replacing an existing file (default false)'),
      keepOnError: z.boolean().optional(),
      refreshClassCache: z.enum(['auto', 'always', 'never']).optional(),
      expectedHash,
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      ctx.assertWritable('godot_script_write');
      if (Buffer.byteLength(a.content) > ctx.config.maxWriteBytes) {
        throw new GodotMcpError(ErrorCode.InvalidArgument, `content exceeds GODOT_MCP_MAX_WRITE_BYTES (${ctx.config.maxWriteBytes})`);
      }
      const r = resolveInProject(a.path, project, { forWrite: true, extensions: SCRIPT_EXTENSIONS, mustNotExist: !a.overwrite, label: 'path' });
      return ctx.locks.run(project.root, async () => {
        const before = existsSync(r.abs) ? readFileSync(r.abs) : null;
        const hashBefore = before ? sha256(before) : null;
        if (a.expectedHash !== undefined && a.expectedHash !== hashBefore) {
          throw new GodotMcpError(ErrorCode.Conflict, `${r.res} changed since it was read; re-read it and retry`, {
            context: { expectedHash: a.expectedHash, actualHash: hashBefore },
          });
        }
        atomicWrite(r.abs, a.content);
        const data: Record<string, unknown> = {
          path: r.res,
          created: before === null,
          bytes: Buffer.byteLength(a.content),
          sha256Before: hashBefore,
          sha256: fileHash(r.abs),
        };
        if (r.rel.endsWith('.gd')) {
          const validate = async () =>
            (await ctx.runOps(project, [{ op: 'script_validate', args: { paths: [r.res] } }], { signal })).results[0] as {
              valid: boolean;
              results: Array<{ class_name?: string; diagnostics?: Array<{ message: string }> }>;
            };
          let v = await validate();
          const entry = v.results[0];
          const mode = a.refreshClassCache ?? 'auto';
          const newClass = !!entry?.class_name && !classCacheHas(project.root, entry.class_name);
          const unknownType = (entry?.diagnostics ?? []).some((d) => /Could not find type|Identifier "[A-Z]\w*" not declared/.test(d.message));
          if (mode === 'always' || (mode === 'auto' && (newClass || (!v.valid && unknownType)))) {
            const imp = await runImport(ctx, project, 300_000, signal);
            data.classCacheRefreshed = imp.exitCode === 0;
            if (!v.valid) v = await validate();
          }
          data.validation = v.results[0];
          if (!v.valid && !a.keepOnError) {
            if (before) atomicWrite(r.abs, before);
            else rmSync(r.abs, { force: true });
            throw new GodotMcpError(ErrorCode.OperationFailed, `${r.res} does not compile; the write was rolled back`, {
              context: { validation: v.results[0], rolledBack: true },
              hints: ['Fix the reported lines and write again', 'Pass keepOnError: true to keep an intermediate broken version'],
            });
          }
        }
        return { data, summary: `${before ? 'Updated' : 'Created'} ${r.res}` };
      });
    },
  });
}
