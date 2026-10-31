import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SERVER, SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness, godotPath } from '../helpers/mcp.ts';

const LEGACY = [
  'launch_editor',
  'run_project',
  'get_debug_output',
  'stop_project',
  'get_godot_version',
  'list_projects',
  'get_project_info',
  'create_scene',
  'add_node',
  'load_sprite',
  'export_mesh_library',
  'save_scene',
  'get_uid',
  'update_project_uids',
];

describe('MCP protocol', { skip: SKIP_NO_GODOT }, () => {
  let modern: Harness;
  let legacy: Harness;
  before(async () => {
    modern = await startServer({ mode: 'auto' });
    legacy = await startServer({ mode: 'legacy' });
  });
  after(async () => {
    await modern.close();
    await legacy.close();
  });

  it('negotiates 2026-07-28 with a modern client and 2025-11-25 with a legacy client', () => {
    assert.equal(modern.protocol(), '2026-07-28');
    assert.equal(legacy.protocol(), '2025-11-25');
  });

  it('negotiates an older revision when the client only supports 2025-06-18', async () => {
    const env = { ...(process.env as Record<string, string>), GODOT_PATH: godotPath()! };
    const c = new Client({ name: 'old', version: '1' }, { supportedProtocolVersions: ['2025-06-18'] } as never);
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'pipe' }));
    assert.equal(c.getNegotiatedProtocolVersion(), '2025-06-18');
    const r = await c.callTool({ name: 'get_godot_version', arguments: {} });
    assert.ok(!r.isError);
    await c.close();
  });

  it('lists every new and legacy tool on both eras with schemas and annotations', async () => {
    for (const h of [modern, legacy]) {
      const { tools } = await h.client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of [...LEGACY, 'godot_scene_edit', 'godot_run', 'godot_screenshot', 'godot_editor', 'godot_api_class']) assert.ok(names.includes(n), n);
      for (const t of tools) {
        assert.equal(t.inputSchema.type, 'object', t.name);
        assert.ok(t.description && t.description.length > 20, t.name);
        assert.ok(t.annotations, t.name);
      }
    }
  });

  it('hides legacy tools when GODOT_MCP_LEGACY_TOOLS=false', async () => {
    const h = await startServer({ env: { GODOT_MCP_LEGACY_TOOLS: 'false' } });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('add_node'));
    assert.ok(names.includes('godot_scene_edit'));
    await h.close();
  });

  it('validates input and reports schema errors as tool errors', async () => {
    const r = await modern.call('godot_scene_edit', { projectPath: '/tmp', scenePath: 'x.tscn', actions: 'nope' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text!, /validation/i);
    const r2 = await modern.call('godot_scene_edit', { projectPath: '/tmp', scenePath: 'x.tscn', actions: [{ action: 'format_disk' }] });
    assert.equal(r2.isError, true);
  });

  it('returns structured content and structured errors', async () => {
    const ok = await modern.call('get_godot_version');
    assert.match(String(ok.structuredContent?.version), /^4\./);
    const p = tempProject();
    const err = await modern.fail('godot_scene_inspect', { projectPath: p.root, scenePath: 'missing.tscn' });
    assert.equal(err.code, 'NOT_FOUND');
    p.cleanup();
  });

  it('rejects unknown tools with a protocol error', async () => {
    await assert.rejects(modern.client.callTool({ name: 'definitely_not_a_tool', arguments: {} }));
  });

  it('serves resources and resource templates', async () => {
    const list = await modern.client.listResources();
    assert.ok(list.resources.some((r) => r.uri === 'godot://docs/value-encoding'));
    const doc = await modern.client.readResource({ uri: 'godot://docs/value-encoding' });
    assert.match(String((doc.contents[0] as { text: string }).text), /Vector2/);
    const cls = await modern.client.readResource({ uri: 'godot://api/class/Sprite2D' });
    const body = JSON.parse(String((cls.contents[0] as { text: string }).text));
    assert.deepEqual(body.inheritance.slice(0, 3), ['Sprite2D', 'Node2D', 'CanvasItem']);
  });

  it('cancels a running tool call and terminates the Godot process', async () => {
    // A scene that never quits on its own, so only cancellation can end the call.
    const p = tempProject();
    writeFile(p.root, 'loop.gd', 'extends Node\nfunc _process(_d: float) -> void:\n\tpass\n');
    await modern.ok('godot_scene_create', { projectPath: p.root, scenePath: 'loop.tscn', rootType: 'Node' });
    await modern.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'loop.tscn', actions: [{ action: 'attach_script', node: '.', script: 'loop.gd' }] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    await assert.rejects(
      modern.client.callTool(
        { name: 'godot_run', arguments: { projectPath: p.root, scene: 'loop.tscn', headless: true, mode: 'until_exit', timeoutMs: 120000 } },
        { signal: ac.signal },
      ),
    );
    // The session must not stay alive after cancellation.
    await new Promise((r) => setTimeout(r, 4000));
    const st = await modern.ok('godot_runtime_status');
    const running = (st.sessions as Array<{ running: boolean; projectRoot: string }>).filter((s) => s.running && s.projectRoot === p.root);
    assert.equal(running.length, 0, JSON.stringify(st));
    p.cleanup();
  });
});
