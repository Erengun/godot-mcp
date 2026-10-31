/**
 * McpServer factory. `serveStdio` may call it once per connection era
 * (2026-07-28 "modern" or 2025-era legacy), so it must be cheap and must not
 * own process-wide state — that lives in AppContext.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.ts';
import { registerResources } from './resources/index.ts';
import { registerApiTools } from './tools/api.ts';
import { registerAssetTools } from './tools/assets.ts';
import { registerDotnetTools } from './tools/dotnet.ts';
import { registerEditorTools } from './tools/editor.ts';
import { registerLegacyTools } from './tools/legacy.ts';
import { registerProjectTools, SERVER_VERSION } from './tools/project.ts';
import { registerResourceTools } from './tools/resource.ts';
import { registerRuntimeTools } from './tools/runtime.ts';
import { registerSceneTools } from './tools/scene.ts';
import { registerScriptTools } from './tools/script.ts';
import { registerVisualTools } from './tools/visual.ts';

export const INSTRUCTIONS = `godot-mcp gives you programmatic access to Godot 4 projects.
Start with godot_status (capabilities) and godot_project_info. Inspect before editing: godot_scene_inspect / godot_node_inspect / godot_api_class tell you exact node paths, property names and types.
Edit scenes with godot_scene_edit (batched, all-or-nothing, inheritance-safe). Values use the target property's type (see resource godot://docs/value-encoding).
Validate with godot_script_validate and godot_project_validate; verify behaviour with godot_run (mode "until_exit" + quitAfterFrames) and visuals with godot_screenshot.
If a Godot editor with the bridge plugin is open (godot_editor_plugin / godot_editor_launch), prefer godot_editor for live, undoable edits of the open scene.
All paths are project-relative ("res://..."); files outside the project are never touched.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: 'godot-mcp', version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS, maxToolInputElements: 200_000 },
  );
  registerProjectTools(server, ctx);
  registerSceneTools(server, ctx);
  registerResourceTools(server, ctx);
  registerScriptTools(server, ctx);
  registerApiTools(server, ctx);
  registerRuntimeTools(server, ctx);
  registerVisualTools(server, ctx);
  registerAssetTools(server, ctx);
  registerEditorTools(server, ctx);
  registerDotnetTools(server, ctx);
  if (ctx.config.legacyTools) registerLegacyTools(server, ctx);
  registerResources(server, ctx);
  return server;
}
