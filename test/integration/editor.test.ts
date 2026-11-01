/**
 * Live editor bridge against a REAL Godot editor (run with --headless so it
 * works without a desktop session). Verifies authentication, project binding,
 * undoable edits, unsaved-change protection and saving.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bridgeInfoPath, readBridgeInfo } from '../../src/editor/bridge.ts';
import { SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

async function rawExchange(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => lines.forEach((l) => s.write(l + '\n')));
    s.on('data', (d: string) => (buf += d));
    s.on('close', () => resolve(buf));
    setTimeout(() => {
      s.destroy();
      resolve(buf);
    }, 3000);
  });
}

describe('live editor bridge', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('EditorBridge');
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'main.tscn', rootType: 'Node2D' });
    await h.ok('godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/run/main_scene': 'res://main.tscn' } });
    // A project class whose script is not @tool (the editor must not run it).
    writeFile(
      p.root,
      'mover.gd',
      'class_name Mover\nextends Node2D\n@export var speed := 3.0\nfunc _init() -> void:\n\tFileAccess.open("res://MOVER_RAN.txt", FileAccess.WRITE).store_string("ran")\n',
    );
  });
  after(async () => {
    try {
      await h.ok('godot_stop', { kind: 'editor' });
    } catch {
      /* already stopped */
    }
    await h.close();
    p.cleanup();
  });

  it('installs and enables the plugin', async () => {
    const r = await h.ok('godot_editor_plugin', { projectPath: p.root, action: 'install' });
    assert.equal(r.installed, true);
    assert.equal(r.enabled, true);
    assert.match(readFileSync(join(p.root, 'project.godot'), 'utf8'), /res:\/\/addons\/godot_mcp\/plugin\.cfg/);
  });

  it('launches the editor and connects to the bridge', async () => {
    const r = await h.ok('godot_editor_launch', { projectPath: p.root, headless: true, waitForBridgeMs: 60000 });
    assert.equal(r.bridgeConnected, true, JSON.stringify(r));
    const st = await h.ok('godot_editor', { projectPath: p.root, action: 'status' });
    assert.equal(realpathSync.native(String(st.project_root)).toLowerCase(), p.root.toLowerCase());
  });

  it('rejects unauthenticated and wrong-token clients', async () => {
    if (process.platform !== 'win32') {
      // Only the owner can read the token (the directory too, so it is never exposed).
      assert.equal(statSync(bridgeInfoPath(p.root)).mode & 0o777, 0o600);
      assert.equal(statSync(join(bridgeInfoPath(p.root), '..')).mode & 0o777, 0o700);
    }
    const info = readBridgeInfo(p.root)!;
    const noAuth = await rawExchange(info.port, [JSON.stringify({ id: 1, method: 'status', params: {} })]);
    assert.doesNotMatch(noAuth, /"ok":true/);
    const bad = await rawExchange(info.port, [JSON.stringify({ type: 'hello', token: '0'.repeat(64) }), JSON.stringify({ id: 1, method: 'status' })]);
    assert.match(bad, /rejected/);
    assert.doesNotMatch(bad, /"ok":true/);
  });

  it('edits the open scene through undo/redo and protects unsaved changes', async () => {
    await h.ok('godot_editor', { projectPath: p.root, action: 'open_scene', scene: 'main.tscn' });
    const add = await h.ok('godot_editor', {
      projectPath: p.root,
      action: 'add_node',
      scene: 'main.tscn',
      parent: '.',
      type: 'Sprite2D',
      name: 'LiveSprite',
      properties: { position: [10, 20] },
    });
    assert.equal(add.path, 'LiveSprite');
    await h.ok('godot_editor', { projectPath: p.root, action: 'set_properties', scene: 'main.tscn', node: 'LiveSprite', properties: { modulate: '#00ff00' } });
    // Metadata can be set live; internal properties cannot (as in headless edits).
    const meta = await h.ok('godot_editor', {
      projectPath: p.root,
      action: 'set_properties',
      scene: 'main.tscn',
      node: 'LiveSprite',
      properties: { 'metadata/role': 'hero' },
    });
    assert.deepEqual(meta.properties, { 'metadata/role': 'hero' });
    const internal = await h.fail('godot_editor', {
      projectPath: p.root,
      action: 'set_properties',
      scene: 'main.tscn',
      node: 'LiveSprite',
      properties: { _import_path: 'x' },
    });
    assert.equal(internal.code, 'INVALID_ARGUMENT', JSON.stringify(internal));
    const tree = await h.ok('godot_editor', { projectPath: p.root, action: 'tree' });
    assert.ok((tree.nodes as Array<{ path: string }>).some((n) => n.path === 'LiveSprite'));
    const st = await h.ok('godot_editor', { projectPath: p.root, action: 'status' });
    assert.ok((st.unsaved_scenes as string[]).includes('res://main.tscn'), JSON.stringify(st));
    // A headless write would clobber the editor's unsaved state: refused.
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'main.tscn',
      actions: [{ action: 'add_node', type: 'Node', name: 'Headless' }],
    });
    assert.equal(e.code, 'CONFLICT');
    assert.doesNotMatch(readFileSync(join(p.root, 'main.tscn'), 'utf8'), /LiveSprite/);
    // Guard against editing the wrong tab.
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'other.tscn', rootType: 'Node' });
    assert.equal(
      (await h.fail('godot_editor', { projectPath: p.root, action: 'set_properties', scene: 'other.tscn', node: '.', properties: { name: 'x' } })).code,
      'CONFLICT',
    );
  });

  it('saves through the editor and the file reflects the live edits', async () => {
    const s = await h.ok('godot_editor', { projectPath: p.root, action: 'save_scene', scene: 'main.tscn' });
    assert.equal(s.saved, 'res://main.tscn');
    const text = readFileSync(join(p.root, 'main.tscn'), 'utf8');
    assert.match(text, /\[node name="LiveSprite" type="Sprite2D"/);
    assert.match(text, /modulate = Color\(0, 1, 0, 1\)/);
    const status = await h.ok('godot_editor', { projectPath: p.root, action: 'status' });
    if (status.unsaved_tracking === false) {
      // Godot < 4.7 does not say which scenes are unsaved: every open scene counts as unsaved.
      assert.equal(
        (await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'Headless' }] }))
          .code,
        'CONFLICT',
      );
      await h.ok('godot_editor', { projectPath: p.root, action: 'add_node', scene: 'main.tscn', parent: '.', type: 'Node', name: 'Headless' });
      return;
    }
    // After saving, headless edits are allowed again and the editor reloads the tab.
    const r = await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'main.tscn',
      actions: [{ action: 'add_node', type: 'Node', name: 'Headless' }],
    });
    assert.match(String(r.editor), /reloaded/);
    const tree = await h.ok('godot_editor', { projectPath: p.root, action: 'tree' });
    assert.ok(
      (tree.nodes as Array<{ path: string }>).some((n) => n.path === 'Headless'),
      JSON.stringify(tree),
    );
  });

  it('selection round-trips and live removal is refused for the root', async () => {
    const sel = await h.ok('godot_editor', { projectPath: p.root, action: 'selection_set', nodes: ['LiveSprite'] });
    assert.deepEqual(
      (sel.selected as Array<{ path: string }>).map((x) => x.path),
      ['LiveSprite'],
    );
    assert.equal((await h.fail('godot_editor', { projectPath: p.root, action: 'remove_node', node: '.' })).code, 'INVALID_ARGUMENT');
    const rm = await h.ok('godot_editor', { projectPath: p.root, action: 'remove_node', node: 'Headless' });
    assert.equal(rm.undoable, true);
  });

  it('adds nodes of project classes whose script is not a tool script', async () => {
    const add = await h.ok('godot_editor', {
      projectPath: p.root,
      action: 'add_node',
      scene: 'main.tscn',
      parent: '.',
      type: 'Mover',
      name: 'LiveMover',
      properties: { speed: 7 },
    });
    assert.equal(add.path, 'LiveMover');
    const tree = await h.ok('godot_editor', { projectPath: p.root, action: 'tree', includeProperties: true });
    assert.ok(
      (tree.nodes as Array<{ path: string }>).some((n) => n.path === 'LiveMover'),
      JSON.stringify(tree),
    );
    assert.equal(existsSync(join(p.root, 'MOVER_RAN.txt')), false);
  });

  it('plays and stops the project from the editor and exposes editor-side errors', async () => {
    await h.ok('godot_editor', { projectPath: p.root, action: 'save_scene', scene: 'main.tscn' });
    await h.ok('godot_editor', { projectPath: p.root, action: 'play', scene: 'main.tscn' });
    let playing = false;
    for (let i = 0; i < 20 && !playing; i++) {
      await new Promise((r) => setTimeout(r, 250));
      playing = (await h.ok('godot_editor', { projectPath: p.root, action: 'status' })).playing === true;
    }
    assert.equal(playing, true);
    await h.ok('godot_editor', { projectPath: p.root, action: 'stop' });
    const st = await h.ok('godot_editor', { projectPath: p.root, action: 'status' });
    assert.equal(st.playing, false);
    // "current" is a keyword, not a file name (regression: it was resolved to res://current).
    const cur = await h.ok('godot_editor', { projectPath: p.root, action: 'play', scene: 'current' });
    assert.equal(cur.scene, 'current');
    playing = false;
    for (let i = 0; i < 20 && !playing; i++) {
      await new Promise((r) => setTimeout(r, 250));
      playing = (await h.ok('godot_editor', { projectPath: p.root, action: 'status' })).playing === true;
    }
    assert.equal(playing, true);
    await h.ok('godot_editor', { projectPath: p.root, action: 'stop' });
    // Any other scene must exist.
    const missing = await h.fail('godot_editor', { projectPath: p.root, action: 'play', scene: 'missing.tscn' });
    assert.ok(['NOT_FOUND', 'INVALID_ARGUMENT'].includes(missing.code), JSON.stringify(missing));
    const errs = await h.ok('godot_editor', { projectPath: p.root, action: 'errors' });
    assert.ok(Array.isArray(errs.errors));
    // reload with unsaved changes requires explicit consent
    await h.ok('godot_editor', { projectPath: p.root, action: 'set_properties', scene: 'main.tscn', node: '.', properties: { visible: false } });
    assert.equal((await h.fail('godot_editor', { projectPath: p.root, action: 'reload_scene', scene: 'main.tscn' })).code, 'CONFLICT');
    const rl = await h.ok('godot_editor', { projectPath: p.root, action: 'reload_scene', scene: 'main.tscn', discardUnsaved: true });
    assert.equal(rl.reloaded, true);
  });
});
