/**
 * Fixture C — UI scene (anchors, containers, buttons, signals, Theme, dynamic
 * content) and Fixture D — targeted edits in an existing multi-scene project
 * must leave every unrelated file, node and resource byte-identical.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SKIP_NO_GODOT, startServer, tempProject, type Harness } from '../helpers/mcp.ts';
import { sha256 } from '../../src/util/hash.ts';

const UI_GD = `extends Control

signal start_requested(level: int)

@onready var list: ItemList = $Margin/Layout/Levels
@onready var status: Label = $Margin/Layout/Status

func _ready() -> void:
	for i in 5:
		list.add_item("Level %d" % (i + 1))
	status.text = "%d levels" % list.item_count
	await get_tree().process_frame
	$Margin/Layout/Buttons/Start.pressed.emit()

func _on_start_pressed() -> void:
	start_requested.emit(1)
	print("UI_START_PRESSED items=%d status=%s" % [list.item_count, status.text])
	if not DisplayServer.get_name() == "headless":
		return
	get_tree().quit()

func _on_quit_pressed() -> void:
	get_tree().quit()
`;

describe('Fixture C: UI scene', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('UI');
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('builds a themed, anchored container layout with wired buttons', async () => {
    await h.ok('godot_resource_create', { projectPath: p.root, path: 'ui/theme.tres', type: 'Theme', properties: { default_font_size: 22 } });
    await h.ok('godot_resource_create', {
      projectPath: p.root,
      path: 'ui/title.tres',
      type: 'LabelSettings',
      properties: { font_size: 40, font_color: '#ffd166', outline_size: 4, outline_color: '#000000' },
    });
    await h.ok('godot_script_write', { projectPath: p.root, path: 'ui/menu.gd', content: UI_GD });
    await h.ok('godot_scene_create', {
      projectPath: p.root,
      scenePath: 'ui/menu.tscn',
      rootType: 'Control',
      rootName: 'Menu',
      properties: { anchor_right: 1, anchor_bottom: 1, theme: 'res://ui/theme.tres' },
    });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'ui/menu.tscn',
      actions: [
        { action: 'attach_script', node: '.', script: 'ui/menu.gd' },
        { action: 'add_node', type: 'ColorRect', name: 'Background', properties: { anchor_right: 1, anchor_bottom: 1, color: '#1d3557' } },
        {
          action: 'add_node',
          type: 'MarginContainer',
          name: 'Margin',
          properties: {
            anchor_right: 1,
            anchor_bottom: 1,
            'theme_override_constants/margin_left': 48,
            'theme_override_constants/margin_top': 32,
            'theme_override_constants/margin_right': 48,
            'theme_override_constants/margin_bottom': 32,
          },
        },
        { action: 'add_node', parent: 'Margin', type: 'VBoxContainer', name: 'Layout', properties: { 'theme_override_constants/separation': 16 } },
        {
          action: 'add_node',
          parent: 'Margin/Layout',
          type: 'Label',
          name: 'Title',
          properties: { text: 'Godot MCP Demo', horizontal_alignment: 'center', label_settings: 'res://ui/title.tres' },
        },
        {
          action: 'add_node',
          parent: 'Margin/Layout',
          type: 'ItemList',
          name: 'Levels',
          properties: { size_flags_vertical: 3, custom_minimum_size: [0, 160] },
        },
        { action: 'add_node', parent: 'Margin/Layout', type: 'Label', name: 'Status', properties: { text: '...' } },
        { action: 'add_node', parent: 'Margin/Layout', type: 'HBoxContainer', name: 'Buttons', properties: { alignment: 'center' } },
        { action: 'add_node', parent: 'Margin/Layout/Buttons', type: 'Button', name: 'Start', properties: { text: 'Start', custom_minimum_size: [160, 48] } },
        { action: 'add_node', parent: 'Margin/Layout/Buttons', type: 'Button', name: 'Quit', properties: { text: 'Quit', custom_minimum_size: [160, 48] } },
        { action: 'connect_signal', from: 'Margin/Layout/Buttons/Start', signal: 'pressed', to: '.', method: '_on_start_pressed' },
        { action: 'connect_signal', from: 'Margin/Layout/Buttons/Quit', signal: 'pressed', to: '.', method: '_on_quit_pressed' },
      ],
    });
    const text = readFileSync(join(p.root, 'ui/menu.tscn'), 'utf8');
    assert.match(text, /anchor_right = 1\.0/);
    assert.match(text, /theme = ExtResource/);
    assert.match(text, /theme_override_constants\/margin_left = 48/);
    assert.match(text, /\[connection signal="pressed" from="Margin\/Layout\/Buttons\/Start" to="\." method="_on_start_pressed"\]/);
    await h.ok('godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/run/main_scene': 'res://ui/menu.tscn' } });
  });

  it('runs: dynamic content is created and the signal handler fires', async () => {
    const r = await h.ok('godot_run', { projectPath: p.root, headless: true, mode: 'until_exit', timeoutMs: 30000 });
    assert.equal(r.healthy, true, JSON.stringify(r));
    assert.ok(
      (r.outputTail as string[]).some((l) => l.includes('UI_START_PRESSED items=5 status=5 levels')),
      JSON.stringify(r.outputTail),
    );
  });

  it('renders the layout', { skip: process.platform === 'linux' && !process.env.DISPLAY ? 'no display' : false }, async () => {
    const r = await h.call('godot_screenshot', { projectPath: p.root, width: 800, height: 480, frames: 6 });
    assert.ok(!r.isError, r.content[0]?.text);
    const s = r.structuredContent!;
    assert.ok(Number((s.sceneFacts as { visible_controls: number }).visible_controls) >= 9);
    assert.equal((s.stats as { looks_blank: boolean }).looks_blank, false);
    if (process.env.SHOT_DIR)
      writeFileSync(join(process.env.SHOT_DIR, 'fixture-c-ui.png'), Buffer.from(r.content.find((c) => c.type === 'image')!.data!, 'base64'));
  });
});

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === '.godot') continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), sha256(readFileSync(p)));
    }
  };
  walk(root);
  return out;
}

describe('Fixture D: existing project preservation', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Existing');
    // Build a small "existing" project: shared resources, several scenes, scripts.
    await h.ok('godot_resource_create', { projectPath: p.root, path: 'shared/mat.tres', type: 'StandardMaterial3D', properties: { albedo_color: '#aa3333' } });
    await h.ok('godot_resource_create', { projectPath: p.root, path: 'shared/shape.tres', type: 'BoxShape3D', properties: { size: [1, 2, 1] } });
    await h.ok('godot_script_write', { projectPath: p.root, path: 'scripts/door.gd', content: 'extends StaticBody3D\n@export var open := false\n' });
    for (const name of ['door', 'crate']) {
      await h.ok('godot_scene_create', { projectPath: p.root, scenePath: `props/${name}.tscn`, rootType: 'StaticBody3D' });
      await h.ok('godot_scene_edit', {
        projectPath: p.root,
        scenePath: `props/${name}.tscn`,
        actions: [
          { action: 'add_node', type: 'MeshInstance3D', name: 'Mesh', properties: { mesh: { $new: 'BoxMesh' }, material_override: 'res://shared/mat.tres' } },
          { action: 'add_node', type: 'CollisionShape3D', name: 'Col', properties: { shape: 'res://shared/shape.tres' } },
        ],
      });
    }
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'props/door.tscn',
      actions: [{ action: 'attach_script', node: '.', script: 'scripts/door.gd' }],
    });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'levels/level1.tscn', rootType: 'Node3D' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'levels/level1.tscn',
      actions: [
        { action: 'instantiate_scene', parent: '.', scene: 'props/door.tscn', name: 'Door', properties: { position: [0, 0, -3] } },
        { action: 'instantiate_scene', parent: '.', scene: 'props/crate.tscn', name: 'Crate1' },
        { action: 'instantiate_scene', parent: '.', scene: 'props/crate.tscn', name: 'Crate2', properties: { position: [2, 0, 0] } },
        { action: 'add_node', type: 'OmniLight3D', name: 'Lamp', properties: { position: [0, 3, 0], light_energy: 2 } },
      ],
    });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'levels/level2.tscn', inherits: 'levels/level1.tscn' });
    await h.ok('godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/run/main_scene': 'res://levels/level1.tscn' } });
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('changes exactly one property line in exactly one file', async () => {
    const before = snapshot(p.root);
    const level1Before = readFileSync(join(p.root, 'levels/level1.tscn'), 'utf8').split('\n');
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'levels/level1.tscn',
      actions: [{ action: 'set_properties', node: 'Lamp', properties: { light_energy: 3.5 } }],
    });
    const after = snapshot(p.root);
    const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
    assert.deepEqual(changed, ['levels/level1.tscn']);
    assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort(), 'no files created or deleted');
    const level1After = readFileSync(join(p.root, 'levels/level1.tscn'), 'utf8').split('\n');
    const removed = level1Before.filter((l) => !level1After.includes(l));
    const added = level1After.filter((l) => !level1Before.includes(l));
    // Godot regenerates ext_resource ids; besides those, only the light energy line differs.
    const meaningful = (ls: string[]) => ls.filter((l) => !/^\[ext_resource /.test(l) && !/instance=ExtResource\("/.test(l));
    assert.deepEqual(meaningful(removed), ['light_energy = 2.0']);
    assert.deepEqual(meaningful(added), ['light_energy = 3.5']);
  });

  it('edits through an inherited scene leave the base scene untouched', async () => {
    const before = snapshot(p.root);
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'levels/level2.tscn',
      actions: [
        { action: 'set_properties', node: 'Crate2', properties: { position: [4, 0, 0] } },
        { action: 'add_node', type: 'Node3D', name: 'Extra' },
      ],
    });
    const after = snapshot(p.root);
    assert.deepEqual(
      [...after.keys()].filter((k) => before.get(k) !== after.get(k)),
      ['levels/level2.tscn'],
    );
    const v = await h.ok('godot_project_validate', { projectPath: p.root });
    assert.equal(v.healthy, true, JSON.stringify(v));
    assert.equal(v.files_with_problems, 0, 'no UID or dependency warnings either');
  });

  it('editing a shared resource changes only that resource and every user sees it', async () => {
    const before = snapshot(p.root);
    await h.ok('godot_resource_edit', { projectPath: p.root, path: 'shared/mat.tres', properties: { albedo_color: '#33aa33' } });
    const after = snapshot(p.root);
    assert.deepEqual(
      [...after.keys()].filter((k) => before.get(k) !== after.get(k)),
      ['shared/mat.tres'],
    );
    const r = await h.ok('godot_resource_inspect', { projectPath: p.root, path: 'shared/mat.tres' });
    assert.deepEqual(
      (r.properties as Record<string, { value: number[] }>).albedo_color!.value.map((x) => Math.round(x * 255)),
      [51, 170, 51, 255],
    );
    assert.match(readFileSync(join(p.root, 'shared/mat.tres'), 'utf8'), /^\[gd_resource type="StandardMaterial3D" format=3 uid="uid:\/\//);
  });
});
