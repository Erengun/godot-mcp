/**
 * Structured error model shared by every tool.
 *
 * Tool handlers throw `GodotMcpError`; the tool registry converts it into an
 * MCP tool result with `isError: true` and a machine-readable
 * `structuredContent.error` object so agents can branch on `code` instead of
 * parsing prose.
 */

export const ErrorCode = {
  InvalidArgument: 'INVALID_ARGUMENT',
  PathOutsideProject: 'PATH_OUTSIDE_PROJECT',
  PathNotAllowed: 'PATH_NOT_ALLOWED',
  NotAProject: 'NOT_A_GODOT_PROJECT',
  NotFound: 'NOT_FOUND',
  AlreadyExists: 'ALREADY_EXISTS',
  ClassNotAllowed: 'CLASS_NOT_ALLOWED',
  GodotNotFound: 'GODOT_NOT_FOUND',
  GodotVersionUnsupported: 'GODOT_VERSION_UNSUPPORTED',
  WorkerFailed: 'WORKER_FAILED',
  OperationFailed: 'OPERATION_FAILED',
  Timeout: 'TIMEOUT',
  Cancelled: 'CANCELLED',
  Conflict: 'CONFLICT',
  ProcessNotRunning: 'PROCESS_NOT_RUNNING',
  EditorNotConnected: 'EDITOR_NOT_CONNECTED',
  EditorRejected: 'EDITOR_REJECTED',
  CapabilityUnavailable: 'CAPABILITY_UNAVAILABLE',
  Internal: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** One engine-reported diagnostic (parse error, runtime error, warning). */
export interface EngineDiagnostic {
  severity: 'error' | 'warning' | 'script_error' | 'shader_error' | 'info';
  message: string;
  file?: string;
  line?: number;
  function?: string;
  stack?: string[];
}

export interface ErrorDetails {
  /** The tool or worker operation that failed. */
  operation?: string;
  /** Engine diagnostics collected while the operation ran. */
  diagnostics?: EngineDiagnostic[];
  exitCode?: number | null;
  signal?: string | null;
  /** Free-form, JSON-serialisable context useful for debugging. */
  context?: Record<string, unknown>;
  /** Short, actionable hints. */
  hints?: string[];
}

export class GodotMcpError extends Error {
  readonly code: ErrorCodeValue;
  readonly details: ErrorDetails;

  constructor(code: ErrorCodeValue, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'GodotMcpError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isGodotMcpError(e: unknown): e is GodotMcpError {
  return e instanceof GodotMcpError;
}

/** Normalise anything thrown into a GodotMcpError without losing the message. */
export function toGodotMcpError(e: unknown, operation?: string): GodotMcpError {
  if (e instanceof GodotMcpError) {
    if (operation && !e.details.operation) e.details.operation = operation;
    return e;
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return new GodotMcpError(ErrorCode.Cancelled, 'Operation was cancelled', { operation });
  }
  const message = e instanceof Error ? e.message : String(e);
  return new GodotMcpError(ErrorCode.Internal, message, { operation });
}
