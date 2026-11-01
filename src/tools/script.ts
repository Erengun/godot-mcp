import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError, type EngineDiagnostic } from '../errors.ts';
import { scanSourcePaths } from '../security/gdscriptSource.ts';
import { resolveInProject, SCRIPT_EXTENSIONS, type ProjectRef } from '../security/paths.ts';
import { fileHash, sha256 } from '../util/hash.ts';
import { classCacheHas, runImport } from './assets.ts';
import { expectedHash, projectPath, resPath } from './schemas.ts';
import { READ_ONLY, registerTool, WRITES } from './registry.ts';

/**
 * preload/extends paths in unsaved source that Godot's analyzer would load
 * from outside the project (see security/gdscriptSource.ts), as diagnostics.
 */
export function unsafeSourcePaths(source: string, project: ProjectRef, label: string): EngineDiagnostic[] {
  const out: EngineDiagnostic[] = [];
  for (const f of scanSourcePaths(source)) {
    let problem = f.problem;
    if (!problem && f.path) {
      try {
        resolveInProject(f.path, project, { label: `${f.keyword} path` });
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    if (problem) {
      out.push({
        severity: 'error',
        message: `${f.keyword}: ${problem}. Unsaved source may only ${f.keyword} literal res:// paths inside the project (write the script with godot_script_write to check anything else).`,
        file: label,
        line: f.line,
      });
    }
  }
  return out;
}

/** Diagnostics that a refreshed global class cache may resolve. */
const UNKNOWN_TYPE = /Could not find type|Identifier "[A-Z]\w*" not declared/;

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
      "Compile GDScript with Godot's own parser/analyzer and return errors with file and line (wrong argument counts, undeclared identifiers, type errors the analyzer can prove, bad syntax). Pass paths, all=true for every script, or source (unsaved text). Unsaved source is only analysed, never compiled or run, so none of its code executes; it may only preload/extend literal res:// paths inside the project, and rare compiler-stage errors are not reported for it (godot_script_write checks those). Scripts that use autoload singletons are validated fully (the autoloads themselves never run; a scene autoload is typed as a plain Node). C# files are skipped (use godot_dotnet).",
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
        const label = a.sourcePath ?? 'unsaved.gd';
        const refused = unsafeSourcePaths(a.source, project, label);
        if (refused.length > 0) {
          return {
            data: { path: label, valid: false, error: 'Unsafe path in unsaved source; nothing was analysed', diagnostics: refused },
            summary: `${label}: refused ${refused.length} preload/extends path(s) outside the project.`,
          };
        }
        const { results } = await ctx.runOps(project, [{ op: 'script_validate_source', args: { source: a.source, path: label } }], {
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
      'Write a .gd, .gdshader, .gdshaderinc or .cs file inside the project (atomic replace), validating GDScript with Godot. By default GDScript that Godot cannot parse or analyse is refused before anything is written, and one that then fails to compile is rolled back to the previous content (or deleted if it was new); the errors are returned either way. Pass keepOnError=true to keep a broken version. Use expectedHash to avoid overwriting concurrent changes. ' +
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
        // Analyse the new GDScript before it replaces anything (the analysis
        // never runs its code); a script Godot cannot parse is not written at
        // all. Compiler-stage errors are still caught after the write below.
        if (r.rel.endsWith('.gd') && !a.keepOnError && unsafeSourcePaths(a.content, project, r.res).length === 0) {
          const pre = (await ctx.runOps(project, [{ op: 'script_validate_source', args: { source: a.content, path: r.res } }], { signal })).results[0] as {
            valid: boolean;
            diagnostics?: Array<{ message: string }>;
          };
          // An unknown class may be one the class cache refresh below registers.
          const unknownType = (pre.diagnostics ?? []).some((d) => UNKNOWN_TYPE.test(d.message));
          if (!pre.valid && !unknownType) {
            throw new GodotMcpError(ErrorCode.OperationFailed, `${r.res} does not compile; nothing was written`, {
              context: { validation: pre, written: false },
              hints: ['Fix the reported lines and write again', 'Pass keepOnError: true to write a broken intermediate version anyway'],
            });
          }
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
          const unknownType = (entry?.diagnostics ?? []).some((d) => UNKNOWN_TYPE.test(d.message));
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
