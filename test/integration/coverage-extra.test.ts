/**
 * Remaining actions and the 0.x legacy tool surface, exercised end-to-end.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makePng, SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

describe('remaining scene actions', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Extra');
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('disconnects signals, detaches scripts, removes groups, animations and grid cells', async () => {
    writeFile(p.root, 'a.gd', 'extends Node3D\nfunc _on_ready() -> void:\n\tpass\n');
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'tiles.tscn', rootType: 'Node3D' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'tiles.tscn',
      actions: [{ action: 'add_node', type: 'MeshInstance3D', name: 'Block', properties: { mesh: { $new: 'BoxMesh' } } }],
    });
    await h.ok('godot_resource_build', { projectPath: p.root, kind: 'mesh_library', path: 'lib.tres', scene: 'tiles.tscn' });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 's.tscn', rootType: 'Node3D' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 's.tscn',
      actions: [
        { action: 'attach_script', node: '.', script: 'a.gd' },
        { action: 'connect_signal', from: '.', signal: 'ready', to: '.', method: '_on_ready' },
        { action: 'add_to_group', node: '.', group: 'g' },
        { action: 'add_node', type: 'AnimationPlayer', name: 'AP' },
        {
          action: 'animation_upsert',
          player: 'AP',
          name: 'spin',
          length: 1,
          tracks: [
            {
              type: 'rotation_3d',
              path: '.',
              keys: [
                { time: 0, value: [0, 0, 0, 1] },
                { time: 1, value: { euler_degrees: [0, 90, 0] } },
              ],
            },
          ],
        },
        {
          action: 'animation_upsert',
          player: 'AP',
          name: 'calls',
          length: 1,
          tracks: [{ type: 'method', path: '.', keys: [{ time: 0.5, method: '_on_ready', args: [] }] }],
        },
        { action: 'add_node', type: 'GridMap', name: 'Grid', properties: { mesh_library: 'res://lib.tres' } },
        {
          action: 'gridmap_set_cells',
          node: 'Grid',
          cells: [
            { position: [0, 0, 0], item: 'Block' },
            { position: [1, 0, 0], item: 0, orientation: 10 },
          ],
        },
      ],
    });
    let text = readFileSync(join(p.root, 's.tscn'), 'utf8');
    assert.match(text, /\[connection signal="ready"/);
    assert.match(text, /tracks\/0\/type = "rotation_3d"/);
    assert.match(text, /tracks\/0\/type = "method"/);
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 's.tscn',
      actions: [
        { action: 'disconnect_signal', from: '.', signal: 'ready', to: '.', method: '_on_ready' },
        { action: 'detach_script', node: '.' },
        { action: 'remove_from_group', node: '.', group: 'g' },
        { action: 'animation_remove', player: 'AP', name: 'calls' },
        { action: 'gridmap_clear_cells', node: 'Grid', cells: [[1, 0, 0]] },
      ],
    });
    text = readFileSync(join(p.root, 's.tscn'), 'utf8');
    assert.doesNotMatch(text, /\[connection/);
    assert.doesNotMatch(text, /a\.gd/);
    assert.doesNotMatch(text, /groups=/);
    assert.doesNotMatch(text, /"method"/);
    assert.equal(
      (await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 's.tscn', actions: [{ action: 'remove_from_group', node: '.', group: 'g' }] })).code,
      'NOT_FOUND',
    );
  });

  it('prunes project.godot backups to the newest ten', async () => {
    for (let i = 0; i < 12; i++)
      await h.ok('godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/config/description': `v${i}` } });
    const backups = readdirSync(join(p.root, '.godot', 'godot_mcp', 'backups'));
    assert.equal(backups.length, 10);
  });

  it('screenshot honours an explicit camera', { skip: process.platform === 'linux' && !process.env.DISPLAY ? 'no display' : false }, async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'cam.tscn', rootType: 'Node3D' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'cam.tscn',
      actions: [
        { action: 'add_node', type: 'MeshInstance3D', name: 'Box', properties: { mesh: { $new: 'BoxMesh' } } },
        { action: 'add_node', type: 'Camera3D', name: 'Away', properties: { position: [0, 0, -5], rotation_degrees: [0, 180, 180] } },
        { action: 'add_node', type: 'Camera3D', name: 'Front', properties: { position: [0, 0, 4] } },
      ],
    });
    const r = await h.ok('godot_screenshot', { projectPath: p.root, scene: 'cam.tscn', camera: 'Front', width: 320, height: 240 });
    assert.equal((r.sceneFacts as { camera_3d: string }).camera_3d, 'Front');
    assert.equal((r.sceneFacts as { meshes_in_view: number }).meshes_in_view, 1);
    assert.equal((await h.fail('godot_screenshot', { projectPath: p.root, scene: 'cam.tscn', camera: 'Box' })).code, 'OPERATION_FAILED');
  });
});

describe('legacy 0.x tools round-trip', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer({ mode: 'legacy' });
    p = tempProject('Legacy');
  });
  after(async () => {
    try {
      await h.ok('godot_stop', { kind: 'editor' });
    } catch {
      /* not running */
    }
    await h.close();
    p.cleanup();
  });

  it('create_scene -> add_node -> load_sprite -> save_scene -> export_mesh_library -> launch_editor', async () => {
    writeFile(
      p.root,
      'icon.png',
      makePng(16, 16, () => [0, 200, 0, 255]),
    );
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    await h.ok('create_scene', { project_path: p.root, scene_path: 'scenes/main.tscn', root_node_type: 'Node2D' });
    assert.match(readFileSync(join(p.root, 'scenes/main.tscn'), 'utf8'), /\[node name="root" type="Node2D"/);
    await h.ok('add_node', {
      projectPath: p.root,
      scenePath: 'scenes/main.tscn',
      parentNodePath: 'root',
      nodeType: 'Sprite2D',
      nodeName: 'Icon',
      properties: { position: [5, 6] },
    });
    await h.ok('load_sprite', { projectPath: p.root, scenePath: 'res://scenes/main.tscn', nodePath: 'root/Icon', texturePath: 'icon.png' });
    assert.match(readFileSync(join(p.root, 'scenes/main.tscn'), 'utf8'), /texture = ExtResource/);
    assert.equal(
      (await h.fail('load_sprite', { projectPath: p.root, scenePath: 'scenes/main.tscn', nodePath: 'root', texturePath: 'icon.png' })).code,
      'INVALID_ARGUMENT',
    );
    await h.ok('save_scene', { projectPath: p.root, scenePath: 'scenes/main.tscn', newPath: 'scenes/variant.tscn' });
    assert.match(readFileSync(join(p.root, 'scenes/variant.tscn'), 'utf8'), /name="Icon"/);
    await h.ok('create_scene', { projectPath: p.root, scenePath: 'scenes/blocks.tscn', rootNodeType: 'Node3D' });
    await h.ok('add_node', {
      projectPath: p.root,
      scenePath: 'scenes/blocks.tscn',
      nodeType: 'MeshInstance3D',
      nodeName: 'Cube',
      properties: { mesh: { $new: 'BoxMesh' } },
    });
    const lib = await h.ok('export_mesh_library', { projectPath: p.root, scenePath: 'scenes/blocks.tscn', outputPath: 'blocks.res', meshItemNames: ['Cube'] });
    assert.equal((lib.items as unknown[]).length, 1);
    const ed = await h.ok('launch_editor', { projectPath: p.root });
    assert.equal((ed.session as { kind: string }).kind, 'editor');
  });
});
