/**
 * Regenerate docs/mcp-tools.md from the live server's tools/list and
 * resources/list, so the reference can never drift from the implementation.
 * Usage: npm run build && node scripts/gen-tool-docs.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, startServer } from '../test/helpers/mcp.ts';

type Schema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
};

function typeOf(s: Schema): string {
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' \\| ');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' \\| ');
  if (s.type === 'array') return `${s.items ? typeOf(s.items) : 'any'}[]`;
  return Array.isArray(s.type) ? s.type.join(' \\| ') : (s.type ?? 'any');
}

const h = await startServer();
const { tools } = await h.client.listTools();
const { resources } = await h.client.listResources();
const { resourceTemplates } = await h.client.listResourceTemplates();
const out: string[] = [
  '# MCP tools reference',
  '',
  '> Generated from the running server (`node scripts/gen-tool-docs.ts`). Do not edit by hand.',
  '',
  `${tools.length} tools. Legacy 0.x tools (no \`godot_\` prefix) can be hidden with \`GODOT_MCP_LEGACY_TOOLS=false\`.`,
  '',
  'Every tool returns `structuredContent` plus the same data as JSON text. Failures return `isError: true` with',
  '`structuredContent.error = { code, message, operation?, diagnostics?, context?, hints? }`. Error codes: ' +
    '`INVALID_ARGUMENT`, `PATH_OUTSIDE_PROJECT`, `PATH_NOT_ALLOWED`, `NOT_A_GODOT_PROJECT`, `NOT_FOUND`, `ALREADY_EXISTS`, `CLASS_NOT_ALLOWED`, ' +
    '`GODOT_NOT_FOUND`, `GODOT_VERSION_UNSUPPORTED`, `WORKER_FAILED`, `OPERATION_FAILED`, `TIMEOUT`, `CANCELLED`, `CONFLICT`, `PROCESS_NOT_RUNNING`, ' +
    '`EDITOR_NOT_CONNECTED`, `EDITOR_REJECTED`, `CAPABILITY_UNAVAILABLE`, `INTERNAL`.',
  '',
  '## Index',
  '',
  ...tools.map((t) => `- [\`${t.name}\`](#${t.name.replace(/_/g, '_')}) — ${t.title ?? ''}`),
  '',
];
for (const t of tools) {
  const a = t.annotations ?? {};
  out.push(
    `## ${t.name}`,
    '',
    `**${t.title ?? t.name}** — readOnly: ${String(a.readOnlyHint)}, destructive: ${String(a.destructiveHint)}, idempotent: ${String(a.idempotentHint)}, openWorld: ${String(a.openWorldHint)}`,
    '',
  );
  out.push(t.description ?? '', '');
  const schema = t.inputSchema as Schema;
  const props = Object.entries(schema.properties ?? {});
  if (props.length) {
    out.push('| Parameter | Type | Required | Description |', '|---|---|---|---|');
    for (const [k, v] of props)
      out.push(
        `| \`${k}\` | ${typeOf(v)} | ${(schema.required ?? []).includes(k) ? 'yes' : ''} | ${(v.description ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|')} |`,
      );
    out.push('');
  } else out.push('_No parameters._', '');
}
out.push('## Resources', '');
for (const r of resources) out.push(`- \`${r.uri}\` — ${r.description ?? r.name}`);
for (const r of resourceTemplates) out.push(`- \`${r.uriTemplate}\` (template) — ${r.description ?? r.name}`);
out.push('');
writeFileSync(join(REPO, 'docs', 'mcp-tools.md'), out.join('\n'));
await h.close();
console.log(`wrote docs/mcp-tools.md (${tools.length} tools)`);
