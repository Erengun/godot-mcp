#!/usr/bin/env node
/**
 * godot-mcp entry point: stdio MCP server for Godot 4 projects.
 *
 * Serves both protocol eras over stdio via the SDK's serveStdio: 2026-07-28
 * clients (server/discover) and 2025-era clients (initialize handshake) are
 * handled by the same server factory.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.ts';
import { AppContext } from './context.ts';
import { reapAll } from './godot/process.ts';
import { createServer } from './server.ts';
import { log, setDebug } from './util/log.ts';

const config = loadConfig();
setDebug(config.debug);
const ctx = new AppContext(config);

ctx
  .godot()
  .then((g) => log.info(`using Godot ${g.version.raw} at ${g.path}`))
  .catch((e: Error) => log.warn(`${e.message} — tools that need Godot will report GODOT_NOT_FOUND until GODOT_PATH is fixed`));

const handle = serveStdio(() => createServer(ctx), { onerror: (e) => log.error('transport error:', e.message) });

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await ctx.shutdown();
    await reapAll();
    await handle.close();
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.stdin.on('end', () => void shutdown(0));
process.on('uncaughtException', (e) => {
  log.error('uncaught exception:', e);
  void shutdown(1);
});
