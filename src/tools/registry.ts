/**
 * Tool registration helpers.
 *
 * Every tool returns:
 *  - `structuredContent`: the machine-readable result object, and
 *  - a text block with the same data as JSON (bounded by
 *    GODOT_MCP_MAX_RESPONSE_BYTES; truncation is stated explicitly),
 * so both structured-output-aware and text-only clients work.
 * Failures are tool results with `isError: true` and
 * `structuredContent.error = {code, message, ...details}`.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { toGodotMcpError } from '../errors.ts';
import { log } from '../util/log.ts';

export interface ToolExtra {
  signal: AbortSignal;
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  data: Record<string, unknown>;
  /** One-line human summary placed before the JSON. */
  summary?: string;
  images?: ToolImage[];
}

export interface ToolSpec<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  handler: (args: z.infer<S>, extra: ToolExtra) => Promise<ToolOutput>;
}

export function jsonText(data: unknown, maxBytes: number): string {
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const cut = text.slice(0, Math.max(0, maxBytes - 200));
  return `${cut}\n... [TRUNCATED: response is ${Buffer.byteLength(text)} bytes, limit ${maxBytes}. Use pagination/filter parameters (offset, limit, node, filter) to narrow the result. structuredContent holds the complete data.]`;
}

export function registerTool<S extends z.ZodObject>(server: McpServer, ctx: AppContext, spec: ToolSpec<S>): void {
  // The SDK's generic signature is heavily overloaded; the cast keeps this helper simple.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    cb: (args: z.infer<S>, c: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>,
  ) => void;
  register(
    spec.name,
    { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: { title: spec.title, ...spec.annotations } },
    async (args, c) => {
      const started = Date.now();
      try {
        const out = await spec.handler(args, { signal: c.mcpReq.signal });
        log.debug(`${spec.name} ok in ${Date.now() - started} ms`);
        const content: Array<Record<string, unknown>> = [];
        const text = jsonText(out.data, ctx.config.maxResponseBytes);
        content.push({ type: 'text', text: out.summary ? `${out.summary}\n\n${text}` : text });
        for (const img of out.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        return { content, structuredContent: out.data };
      } catch (e) {
        const err = toGodotMcpError(e, spec.name);
        log.debug(`${spec.name} failed: ${err.code} ${err.message}`);
        const payload = { error: err.toJSON() };
        return {
          content: [{ type: 'text', text: `Error [${err.code}]: ${err.message}\n\n${jsonText(payload, ctx.config.maxResponseBytes)}` }],
          structuredContent: payload,
          isError: true,
        };
      }
    },
  );
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const PROCESS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
