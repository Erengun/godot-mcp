import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppContext } from '../context.ts';
import { readBridgeInfo } from '../editor/bridge.ts';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { godotAssetsDir } from '../godot/worker.ts';
import { resolveInProject, SCENE_EXTENSIONS } from '../security/paths.ts';
import { getValue, parseConfig } from '../util/configFile.ts';
import { projectPath, properties } from './schemas.ts';
import { PROCESS, registerTool, WRITES } from './registry.ts';

const PLUGIN_CFG = 'res://addons/godot_mcp/plugin.cfg';

function pluginVersion(cfgPath: string): string | null {
  if (!existsSync(cfgPath)) return null;
  const v = getValue(parseConfig(readFileSync(cfgPath, 'utf8')), 'plugin', 'version');
  return typeof v === 'string' ? v : null;
}

function pluginEnabled(root: string): boolean {
  const raw = getValue(parseConfig(readFileSync(join(root, 'project.godot'), 'utf8')), 'editor_plugins', 'enabled');
  return typeof raw === 'string' && raw.includes(PLUGIN_CFG);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });
}

export async function launchEditor(
  ctx: AppContext,
  projectPathArg: string,
  waitForBridgeMs: number,
  signal?: AbortSignal,
  headless = false,
): Promise<Record<string, unknown>> {
  ctx.assertWritable('godot_editor_launch');
  const project = ctx.project(projectPathArg);
  const godot = await ctx.godot();
  // Check-then-start is one step per project, so concurrent launches open one editor.
  const started = await ctx.locks.run(`editor:${project.root}`, async () => {
    const running = ctx.runtime.runningFor(project.root, 'editor')[0];
    if (running) return { running };
    return { id: ctx.runtime.start({ godotPath: godot.path, projectRoot: project.root, kind: 'editor', headless, maxLines: ctx.config.maxLogLines }) };
  });
  if (started.running) {
    return { alreadyRunning: true, session: ctx.runtime.status(started.running) };
  }
  const id = started.id!;
  const session = ctx.runtime.get(id, 'editor');
  await ctx.runtime.waitFor(session, 2500, signal);
  let bridge = false;
  const deadline = Date.now() + waitForBridgeMs;
  while (waitForBridgeMs > 0 && Date.now() < deadline && ctx.runtime.status(session).running && !signal?.aborted) {
    if (readBridgeInfo(project.root) && (await ctx.editor.get(project.root))) {
      bridge = true;
      break;
    }
    await sleep(500, signal);
  }
  const status = ctx.runtime.status(session);
  const spawnError = ctx.runtime.spawnError(session);
  if (spawnError) throw new GodotMcpError(ErrorCode.GodotNotFound, `Failed to start the editor: ${spawnError}`);
  return {
    session: status,
    startupFailed: !status.running,
    bridgeConnected: bridge,
    diagnostics: ctx.runtime.diagnostics(session).slice(0, 50),
    outputTail: ctx.runtime.output(session, { tail: true, limit: 40 }).lines.map((l) => l.text),
    pluginInstalled: existsSync(join(project.root, 'addons', 'godot_mcp', 'plugin.cfg')),
  };
}

const EDITOR_ACTIONS = [
  'status',
  'tree',
  'selection_get',
  'selection_set',
  'open_scene',
  'save_scene',
  'reload_scene',
  'set_properties',
  'add_node',
  'remove_node',
  'scan',
  'play',
  'stop',
  'errors',
] as const;

export function registerEditorTools(server: McpServer, ctx: AppContext): void {
  registerTool(server, ctx, {
    name: 'godot_editor_launch',
    title: 'Launch the Godot editor',
    description:
      'Open the project in the Godot editor as a tracked process (output captured; startup errors reported instead of a blind "launched" message). Optionally wait for the godot-mcp bridge plugin to come online so godot_editor can be used immediately.',
    input: z.object({
      projectPath,
      waitForBridgeMs: z.number().int().min(0).max(120_000).optional(),
      headless: z.boolean().optional().describe('Run the editor without a window (automation/CI); the bridge still works'),
    }),
    annotations: PROCESS,
    handler: async (a, { signal }) => ({ data: await launchEditor(ctx, a.projectPath, a.waitForBridgeMs ?? 0, signal, !!a.headless) }),
  });

  registerTool(server, ctx, {
    name: 'godot_editor_plugin',
    title: 'Install/enable the editor bridge plugin',
    description:
      'Manage the godot-mcp editor plugin (addons/godot_mcp) that provides live, undoable editor access:\n' +
      '- status: installed version, bundled version, enabled flag, bridge reachability\n' +
      '- install {enable?=true, overwrite?}: copy the addon into the project (only addons/godot_mcp is written) and add it to editor_plugins/enabled. Restart or open the editor afterwards; enabling while the editor is open may be overwritten by the editor — enable it in Project Settings > Plugins instead.\n' +
      '- enable / disable: toggle the plugin in project.godot',
    input: z.object({
      projectPath,
      action: z.enum(['status', 'install', 'enable', 'disable']),
      enable: z.boolean().optional(),
      overwrite: z.boolean().optional(),
    }),
    annotations: WRITES,
    handler: async (a, { signal }) => {
      const project = ctx.project(a.projectPath);
      const target = join(project.root, 'addons', 'godot_mcp');
      const bundled = join(godotAssetsDir(), 'addons', 'godot_mcp');
      const status = () => ({
        installed: existsSync(join(target, 'plugin.cfg')),
        installedVersion: pluginVersion(join(target, 'plugin.cfg')),
        bundledVersion: pluginVersion(join(bundled, 'plugin.cfg')),
        enabled: pluginEnabled(project.root),
        bridgeFile: !!readBridgeInfo(project.root),
      });
      if (a.action === 'status') return { data: status() };
      ctx.assertWritable(`godot_editor_plugin:${a.action}`);
      if (a.action === 'install') {
        // The whole install (copy + enable + project.godot backup) is one locked step.
        await ctx.locks.run(project.root, async () => {
          const ver = pluginVersion(join(target, 'plugin.cfg'));
          if (existsSync(target) && !ver) {
            throw new GodotMcpError(ErrorCode.Conflict, 'addons/godot_mcp exists but is not the godot-mcp plugin; refusing to overwrite it');
          }
          if (!(existsSync(target) && !a.overwrite && ver === pluginVersion(join(bundled, 'plugin.cfg')))) {
            resolveInProject('addons/godot_mcp/plugin.cfg', project, { forWrite: true, label: 'plugin target' });
            rmSync(target, { recursive: true, force: true });
            cpSync(bundled, target, { recursive: true, dereference: false, filter: (src) => !src.endsWith('.uid') });
          }
          if (a.enable ?? true) {
            ctx.backupProjectFile(project);
            await ctx.runOps(project, [{ op: 'mcp_plugin_set_enabled', args: { enabled: true } }], { signal, mutates: true });
          }
        });
        return { data: status(), summary: 'Plugin installed. Start (or restart) the editor to activate the bridge.' };
      }
      const { results } = await ctx.locks.run(project.root, async () => {
        ctx.backupProjectFile(project);
        return ctx.runOps(project, [{ op: 'mcp_plugin_set_enabled', args: { enabled: a.action === 'enable' } }], { signal, mutates: true });
      });
      return { data: { ...(results[0] as Record<string, unknown>), ...status() } };
    },
  });

  registerTool(server, ctx, {
    name: 'godot_editor',
    title: 'Live editor operations',
    description:
      "Operate on the project currently open in the Godot editor through the bridge plugin (loopback, token-authenticated; the connection is bound to this exact project path). Mutations go through the editor's undo/redo history and leave the scene marked unsaved until save_scene.\n" +
      'actions: status | tree {maxDepth?, includeProperties?} | selection_get | selection_set {nodes:[paths]} | open_scene {scene} | save_scene {scene?} | reload_scene {scene, discardUnsaved?} | set_properties {node, properties, scene?} | add_node {parent?, type, name, properties?, scene?} | remove_node {node, scene?} | scan {files?} | play {scene?: "main"|"current"|path} | stop | errors {sinceMs?}\n' +
      'Pass scene to guard against editing the wrong open tab.',
    input: z.object({
      projectPath,
      action: z.enum(EDITOR_ACTIONS),
      scene: z.string().max(1024).optional(),
      node: z.string().max(1024).optional(),
      nodes: z.array(z.string().max(1024)).max(200).optional(),
      parent: z.string().max(1024).optional(),
      type: z.string().max(128).optional(),
      name: z.string().max(128).optional(),
      properties: properties.optional(),
      maxDepth: z.number().int().min(0).max(64).optional(),
      includeProperties: z.boolean().optional(),
      files: z.array(z.string().max(1024)).max(500).optional(),
      discardUnsaved: z.boolean().optional(),
      sinceMs: z.number().int().min(0).optional(),
    }),
    annotations: WRITES,
    handler: async (a) => {
      const project = ctx.project(a.projectPath);
      const mutating = ['open_scene', 'save_scene', 'reload_scene', 'set_properties', 'add_node', 'remove_node', 'play', 'stop', 'selection_set', 'scan'];
      if (mutating.includes(a.action)) ctx.assertWritable(`godot_editor:${a.action}`);
      // play takes "main" / "current" literally; any other scene must be an existing scene file.
      const playKeyword = a.action === 'play' && (a.scene === 'main' || a.scene === 'current');
      const scene =
        a.scene && !playKeyword ? resolveInProject(a.scene, project, { mustExist: true, extensions: SCENE_EXTENSIONS, label: 'scene' }).res : undefined;
      const bridge = await ctx.editor.require(project.root);
      let method: string = a.action;
      let params: Record<string, unknown> = {};
      switch (a.action) {
        case 'tree':
          method = 'scene_tree';
          params = { max_depth: a.maxDepth ?? 4, include_properties: !!a.includeProperties };
          break;
        case 'selection_set':
          params = { nodes: a.nodes ?? [] };
          break;
        case 'open_scene':
          if (!scene) throw new GodotMcpError(ErrorCode.InvalidArgument, 'scene is required');
          params = { path: scene };
          break;
        case 'save_scene':
          params = { scene };
          break;
        case 'reload_scene':
          if (!scene) throw new GodotMcpError(ErrorCode.InvalidArgument, 'scene is required');
          params = { path: scene, discard_unsaved: !!a.discardUnsaved };
          break;
        case 'set_properties':
          params = { scene, node: a.node ?? '.', properties: a.properties ?? {} };
          break;
        case 'add_node':
          params = { scene, parent: a.parent ?? '.', type: a.type ?? '', name: a.name ?? '', properties: a.properties ?? {} };
          break;
        case 'remove_node':
          params = { scene, node: a.node };
          break;
        case 'scan':
          method = 'filesystem_scan';
          params = { files: (a.files ?? []).map((f) => resolveInProject(f, project, { label: 'files[]' }).res) };
          break;
        case 'play':
          params = { scene: playKeyword ? a.scene : (scene ?? 'main') };
          break;
        case 'stop':
          method = 'stop_playing';
          break;
        case 'errors':
          params = { since_ms: a.sinceMs ?? 0 };
          break;
      }
      // Saving (or reloading) through the editor touches the scene file on disk,
      // so it is ordered with headless writes to the same project.
      const result =
        a.action === 'save_scene' || a.action === 'reload_scene'
          ? await ctx.locks.run(project.root, () => bridge.request<Record<string, unknown>>(method, params))
          : await bridge.request<Record<string, unknown>>(method, params);
      return { data: { action: a.action, ...result } };
    },
  });
}
