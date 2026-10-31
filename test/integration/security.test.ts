import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, realpathSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

describe('security', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  let outside: string;
  before(async () => {
    h = await startServer();
    p = tempProject('Sec', '\n[autoload]\n\nMarker="*res://marker.gd"\n');
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'godot-mcp-outside-')));
    // An autoload that leaves a trace if any project code is executed.
    writeFile(
      p.root,
      'marker.gd',
      `extends Node\nfunc _init():\n\tvar f = FileAccess.open("res://AUTOLOAD_RAN.txt", FileAccess.WRITE)\n\tf.store_string("ran")\n`,
    );
    writeFile(p.root, 'evil.gd', `extends Node\nfunc _init():\n\tvar f = FileAccess.open("res://EVIL_RAN.txt", FileAccess.WRITE)\n\tf.store_string("ran")\n`);
    writeFileSync(join(outside, 'victim.tscn'), '[gd_scene format=3]\n\n[node name="V" type="Node"]\n');
    symlinkSync(outside, join(p.root, 'linked'));
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'main.tscn', rootType: 'Node2D' });
  });
  after(async () => {
    await h.close();
    p.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it('never runs autoload code during headless operations (regression: upstream ran autoloads on every op)', async () => {
    await h.ok('godot_project_info', { projectPath: p.root });
    await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'main.tscn' });
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node2D', name: 'A' }] });
    await h.ok('get_uid', { projectPath: p.root, filePath: 'main.tscn' });
    assert.equal(existsSync(join(p.root, 'AUTOLOAD_RAN.txt')), false);
  });

  it('rejects path traversal in every path argument', async () => {
    for (const scenePath of ['../x.tscn', 'res://../x.tscn', 'res://a/../../x.tscn', '/etc/hosts']) {
      const e = await h.fail('godot_scene_create', { projectPath: p.root, scenePath, rootType: 'Node' });
      assert.ok(['PATH_OUTSIDE_PROJECT', 'INVALID_ARGUMENT'].includes(e.code), `${scenePath}: ${e.code}`);
    }
    const e2 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'main.tscn',
      actions: [{ action: 'instantiate_scene', parent: '.', scene: '../../etc/x.tscn' }],
    });
    assert.equal(e2.code, 'PATH_OUTSIDE_PROJECT');
    assert.equal(existsSync(join(p.root, '..', 'x.tscn')), false);
  });

  it('blocks symlink escapes for reads and writes', async () => {
    assert.equal((await h.fail('godot_scene_inspect', { projectPath: p.root, scenePath: 'linked/victim.tscn' })).code, 'PATH_OUTSIDE_PROJECT');
    assert.equal((await h.fail('godot_scene_create', { projectPath: p.root, scenePath: 'linked/new.tscn', rootType: 'Node' })).code, 'PATH_OUTSIDE_PROJECT');
    assert.equal(existsSync(join(outside, 'new.tscn')), false);
    assert.equal((await h.fail('godot_script_write', { projectPath: p.root, path: 'linked/x.gd', content: 'extends Node\n' })).code, 'PATH_OUTSIDE_PROJECT');
  });

  it('rejects invalid project roots', async () => {
    assert.equal((await h.fail('godot_project_info', { projectPath: outside })).code, 'NOT_A_GODOT_PROJECT');
    assert.equal((await h.fail('godot_project_info', { projectPath: join(outside, 'nope') })).code, 'NOT_A_GODOT_PROJECT');
  });

  it('enforces GODOT_MCP_ALLOWED_ROOTS', async () => {
    const h2 = await startServer({ env: { GODOT_MCP_ALLOWED_ROOTS: outside } });
    assert.equal((await h2.fail('godot_project_info', { projectPath: p.root })).code, 'PATH_NOT_ALLOWED');
    await h2.close();
  });

  it('never instantiates scripts or editor classes from a type name', async () => {
    for (const type of ['res://evil.gd', 'evil.gd', 'GDScript', 'EditorPlugin', 'EditorInterface', 'Node; rm -rf', '']) {
      const r = await h.call('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type, name: 'X' }] });
      assert.equal(r.isError, true, type);
    }
    assert.equal(
      (await h.fail('godot_resource_create', { projectPath: p.root, path: 's.tres', type: 'GDScript', properties: { source_code: 'extends Node' } })).code,
      'CLASS_NOT_ALLOWED',
    );
    assert.equal(existsSync(join(p.root, 'EVIL_RAN.txt')), false);
  });

  it('refuses arbitrary resource injection through properties (regression: upstream add_node loaded any res:// string)', async () => {
    const before = readFileSync(join(p.root, 'main.tscn'), 'utf8');
    assert.equal(
      (await h.fail('add_node', { projectPath: p.root, scenePath: 'main.tscn', nodeType: 'Node', nodeName: 'S', properties: { script: 'res://evil.gd' } }))
        .code,
      'INVALID_ARGUMENT',
    );
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'main.tscn',
          actions: [{ action: 'set_properties', node: '.', properties: { script: 'res://evil.gd' } }],
        })
      ).code,
      'INVALID_ARGUMENT',
    );
    // A Script is not a valid value for a resource-typed property either.
    assert.ok(
      (
        await h.call('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'main.tscn',
          actions: [{ action: 'add_node', type: 'Sprite2D', name: 'Spr', properties: { texture: 'res://evil.gd' } }],
        })
      ).isError,
    );
    assert.equal(readFileSync(join(p.root, 'main.tscn'), 'utf8'), before);
    // A res:// string in a String property stays a string.
    const ok = await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'main.tscn',
      actions: [{ action: 'add_node', type: 'Label', name: 'L', properties: { text: 'res://evil.gd' } }],
    });
    assert.equal((ok.actions as Array<{ properties: { text: string } }>)[0]!.properties.text, 'res://evil.gd');
    assert.equal(existsSync(join(p.root, 'EVIL_RAN.txt')), false);
  });

  it('protects autoload/editor settings from the generic settings writer', async () => {
    for (const key of ['autoload/Evil', 'editor_plugins/enabled', 'application/run/main_loop_type', 'debug/file_logging/log_path']) {
      assert.equal((await h.fail('godot_project_settings', { projectPath: p.root, action: 'set', settings: { [key]: 'x' } })).code, 'PATH_NOT_ALLOWED', key);
    }
    assert.doesNotMatch(readFileSync(join(p.root, 'project.godot'), 'utf8'), /Evil/);
  });

  it('refuses writes to protected project files', async () => {
    assert.equal((await h.fail('godot_script_write', { projectPath: p.root, path: 'project.godot', content: 'x' })).code, 'INVALID_ARGUMENT');
    assert.equal((await h.fail('godot_resource_create', { projectPath: p.root, path: '.godot/x.tres', type: 'Resource' })).code, 'PATH_NOT_ALLOWED');
  });

  it('refuses export output outside the project', async () => {
    writeFile(p.root, 'export_presets.cfg', '[preset.0]\n\nname="Mac"\nplatform="macOS"\nrunnable=true\nexport_path=""\n');
    const e = await h.fail('godot_export', { projectPath: p.root, action: 'export', preset: 'Mac', outputPath: join(outside, 'game.zip') });
    assert.equal(e.code, 'PATH_NOT_ALLOWED');
    assert.equal(existsSync(join(outside, 'game.zip')), false);
  });

  it('rejects oversized requests', async () => {
    const actions = Array.from({ length: 501 }, (_, i) => ({ action: 'add_node', type: 'Node', name: `N${i}` }));
    assert.ok((await h.call('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions })).isError);
    const big = 'x'.repeat(3 * 1024 * 1024);
    assert.ok((await h.call('godot_script_write', { projectPath: p.root, path: 'big.gd', content: big })).isError);
  });

  it('read-only mode refuses every mutation', async () => {
    const h2 = await startServer({ env: { GODOT_MCP_READ_ONLY: 'true' } });
    for (const [tool, args] of [
      ['godot_scene_create', { projectPath: p.root, scenePath: 'ro.tscn' }],
      ['godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'RO' }] }],
      ['godot_run', { projectPath: p.root, headless: true }],
      ['godot_script_write', { projectPath: p.root, path: 'ro.gd', content: 'extends Node\n' }],
      ['godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/config/name': 'X' } }],
    ] as const) {
      assert.equal((await h2.fail(tool, args as Record<string, unknown>)).code, 'CAPABILITY_UNAVAILABLE', tool);
    }
    assert.ok(await h2.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'main.tscn' }));
    await h2.close();
  });

  it('serialises concurrent writes to the same scene without losing either change', async () => {
    const add = (name: string) =>
      h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node', name }] });
    await Promise.all([add('C1'), add('C2'), add('C3')]);
    const tree = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'main.tscn' });
    const names = (tree.nodes as Array<{ name: string }>).map((n) => n.name);
    for (const n of ['C1', 'C2', 'C3']) assert.ok(names.includes(n), names.join(','));
  });

  it('detects stale writes with expectedHash', async () => {
    const t = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'main.tscn' });
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'Other' }] });
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'main.tscn',
      expectedHash: t.sha256,
      actions: [{ action: 'add_node', type: 'Node', name: 'Stale' }],
    });
    assert.equal(e.code, 'CONFLICT');
  });

  it('does not let duplicate names or retries create duplicates', async () => {
    assert.equal(
      (await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'C1' }] })).code,
      'CONFLICT',
    );
    const r = await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'main.tscn',
      actions: [{ action: 'add_node', type: 'Node', name: 'C1', if_exists: 'skip' }],
    });
    assert.equal((r.actions as Array<{ skipped?: boolean }>)[0]!.skipped, true);
  });
});
