/**
 * stderr logger. stdout belongs to the MCP stdio transport and must never be
 * written to by the server.
 */
let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export const log = {
  debug(...args: unknown[]): void {
    if (debugEnabled) console.error('[godot-mcp:debug]', ...args);
  },
  info(...args: unknown[]): void {
    console.error('[godot-mcp]', ...args);
  },
  warn(...args: unknown[]): void {
    console.error('[godot-mcp:warn]', ...args);
  },
  error(...args: unknown[]): void {
    console.error('[godot-mcp:error]', ...args);
  },
};
