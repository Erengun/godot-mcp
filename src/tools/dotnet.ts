import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { ErrorCode, GodotMcpError, type EngineDiagnostic } from '../errors.ts';
import { runProcess } from '../godot/process.ts';
import { listProjectFiles } from './project.ts';
import { projectPath } from './schemas.ts';
import { PROCESS, registerTool } from './registry.ts';

/** MSBuild diagnostic line: path(line,col): error CS0103: message [project] */
export function parseMsbuild(text: string): EngineDiagnostic[] {
  const out: EngineDiagnostic[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+(.*?)(?:\s+\[[^\]]+\])?$/.exec(line.trim());
    if (!m) continue;
    const key = `${m[1]}:${m[2]}:${m[5]}:${m[6]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ severity: m[4] === 'error' ? 'error' : 'warning', message: `${m[5]}: ${m[6]}`, file: m[1], line: Number(m[2]) });
  }
  return out;
}

async function dotnetSdk(): Promise<string | null> {
  const r = await runProcess('dotnet', ['--version'], { timeoutMs: 15_000, maxOutputBytes: 4096 });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export function registerDotnetTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_dotnet',
    title: 'C# (.NET) project support',
    description:
      'C# support is conditional: it needs the .NET build of Godot (version string contains "mono"), the .NET SDK (`dotnet`) and a .csproj in the project.\n' +
      '- status: report which of these are present and whether C# features are usable\n' +
      "- build: `dotnet build` the project's .csproj and return compiler errors (file, line, code). Requires all prerequisites; never converts C# to GDScript or vice versa.",
    input: z.object({
      projectPath,
      action: z.enum(['status', 'build']),
      configuration: z.enum(['Debug', 'ExportDebug', 'ExportRelease']).optional(),
      timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
    }),
    annotations: PROCESS,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const godot = await ctx.godot();
      const csproj = readdirSync(project.root).filter((f) => f.endsWith('.csproj'));
      const csFiles = listProjectFiles(project, { includeAddons: true }).files.filter((f) => f.path.endsWith('.cs')).length;
      const sdk = await dotnetSdk();
      const status = {
        godotIsDotnetBuild: godot.version.dotnet,
        godotVersion: godot.version.raw,
        dotnetSdk: sdk,
        csproj,
        csFiles,
        usable: godot.version.dotnet && !!sdk && csproj.length > 0,
      };
      if (a.action === 'status') return { data: status };
      ctx.assertWritable('godot_dotnet:build');
      const missing: string[] = [];
      if (!godot.version.dotnet) missing.push('the configured Godot executable is not the .NET build');
      if (!sdk) missing.push('the .NET SDK (dotnet) is not on PATH');
      if (csproj.length === 0) missing.push('the project has no .csproj (create it from the Godot .NET editor: Project > Tools > C# > Create C# solution)');
      if (missing.length) throw new GodotMcpError(ErrorCode.CapabilityUnavailable, `C# build unavailable: ${missing.join('; ')}`, { context: status });
      const r = await runProcess('dotnet', ['build', join(project.root, csproj[0]!), '-c', a.configuration ?? 'Debug', '-nologo', '-v', 'minimal'], {
        cwd: project.root,
        timeoutMs: a.timeoutMs ?? 600_000,
        signal,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (r.timedOut) throw new GodotMcpError(ErrorCode.Timeout, 'dotnet build timed out');
      const diagnostics = parseMsbuild(r.stdout + '\n' + r.stderr);
      return { data: { ...status, exitCode: r.exitCode, success: r.exitCode === 0, diagnostics, outputTail: (r.stdout + r.stderr).slice(-4000) } };
    },
  });
}
