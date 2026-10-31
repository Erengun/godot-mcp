import { delimiter, resolve } from 'node:path';

/**
 * Server configuration, read once from the environment at startup.
 * Every option is documented in docs/security.md and README.md.
 */
export interface ServerConfig {
  /** Explicit Godot executable (GODOT_PATH). */
  godotPath?: string;
  /**
   * If non-empty, every project path must canonicalise to a location inside
   * one of these directories (GODOT_MCP_ALLOWED_ROOTS, OS path-delimiter separated).
   */
  allowedRoots: string[];
  /** Hard ceiling for one headless worker invocation (GODOT_MCP_OP_TIMEOUT_MS). */
  operationTimeoutMs: number;
  /** Ring-buffer size for captured runtime output lines (GODOT_MCP_MAX_LOG_LINES). */
  maxLogLines: number;
  /** Register the 14 pre-2.0 tool names (GODOT_MCP_LEGACY_TOOLS, default true). */
  legacyTools: boolean;
  /** Refuse every tool that writes to disk or launches processes (GODOT_MCP_READ_ONLY). */
  readOnly: boolean;
  /** Verbose diagnostics on stderr (DEBUG=true). */
  debug: boolean;
  /** Maximum bytes accepted for file contents written through tools. */
  maxWriteBytes: number;
  /** Maximum bytes returned in a single text payload before truncation. */
  maxResponseBytes: number;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const roots = (env.GODOT_MCP_ALLOWED_ROOTS ?? '')
    .split(delimiter)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => resolve(r));
  return {
    godotPath: env.GODOT_PATH?.trim() || undefined,
    allowedRoots: roots,
    operationTimeoutMs: envInt(env.GODOT_MCP_OP_TIMEOUT_MS, 120_000, 1_000, 3_600_000),
    maxLogLines: envInt(env.GODOT_MCP_MAX_LOG_LINES, 5_000, 100, 200_000),
    legacyTools: envBool(env.GODOT_MCP_LEGACY_TOOLS, true),
    readOnly: envBool(env.GODOT_MCP_READ_ONLY, false),
    debug: envBool(env.DEBUG, false),
    maxWriteBytes: envInt(env.GODOT_MCP_MAX_WRITE_BYTES, 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxResponseBytes: envInt(env.GODOT_MCP_MAX_RESPONSE_BYTES, 256 * 1024, 4096, 16 * 1024 * 1024),
  };
}
