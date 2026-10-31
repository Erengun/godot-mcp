/**
 * Fixture B — 3D strategy scene built through MCP tool calls: real meshes,
 * materials, lights, environment, collision, instanced buildings (one with an
 * editable-children override), a GridMap road from a MeshLibrary, units with
 * NavigationAgent3D and a scripted command interface with an explicit
 * argument contract. Navigation is baked at runtime by the engine and units
 * must physically reach their target.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SKIP_NO_GODOT, startServer, tempProject, type Harness } from '../helpers/mcp.ts';

const UNIT_GD = `class_name RtsUnit
extends CharacterBody3D

signal arrived(unit_name: String)

@export var speed := 4.0
var _moving := false
@onready var agent: NavigationAgent3D = $Agent

func command_move(target: Vector3, move_speed: float) -> void:
	speed = move_speed
	agent.target_position = target
	_moving = true

func _physics_process(_delta: float) -> void:
	if not _moving:
		return
	if agent.is_navigation_finished():
		_moving = false
		arrived.emit(String(name))
		return
	var dir := agent.get_next_path_position() - global_position
	dir.y = 0.0
	velocity = dir.normalized() * speed
	move_and_slide()
`;

const MAIN_GD = `extends Node3D

var arrived_units: Array[String] = []
var frames := 0
var started := false
var since_start := 0

func _ready() -> void:
	$NavRegion.bake_finished.connect(_on_baked)
	$NavRegion.bake_navigation_mesh(false)

func _on_baked() -> void:
	for i in 10:
		await get_tree().physics_frame
	var units := get_tree().get_nodes_in_group("units")
	units.sort_custom(func(a, b): return String(a.name) < String(b.name))
	for i in units.size():
		(units[i] as RtsUnit).command_move(Vector3(8, 0, 8 - 3 * i), 6.0)
	started = true

func _on_unit_arrived(unit_name: String) -> void:
	arrived_units.append(unit_name)

func _physics_process(_delta: float) -> void:
	frames += 1
	if started:
		since_start += 1
		if since_start == 5:
			var agent: NavigationAgent3D = $Units/U1/Agent
			print("NAV_PATH_POINTS ", agent.get_current_navigation_path().size())
	if frames >= 900 or (started and arrived_units.size() == 2):
		arrived_units.sort()
		print("ARRIVED ", arrived_units.size(), " ", ",".join(arrived_units))
		for u in get_tree().get_nodes_in_group("units"):
			var p: Vector3 = u.global_position
			print("UNIT %s %.1f %.1f" % [u.name, p.x, p.z])
		get_tree().quit()
`;

describe('Fixture B: 3D RTS scene', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  const edit = (scenePath: string, actions: unknown[]) => h.ok('godot_scene_edit', { projectPath: p.root, scenePath, actions });
  before(async () => {
    h = await startServer();
    p = tempProject('RTS', '\n[rendering]\n\nlights_and_shadows/directional_shadow/soft_shadow_filter_quality=1\n');
  });
  after(async () => {
    await h.close();
    if (process.env.KEEP_FIXTURES) console.log('kept fixture at', p.root);
    else p.cleanup();
  });

  it('creates shared materials as resource files', async () => {
    await h.ok('godot_resource_create', {
      projectPath: p.root,
      path: 'materials/wall.tres',
      type: 'StandardMaterial3D',
      properties: { albedo_color: '#d9c7a3', roughness: 0.8 },
    });
    await h.ok('godot_resource_create', {
      projectPath: p.root,
      path: 'materials/roof.tres',
      type: 'StandardMaterial3D',
      properties: { albedo_color: '#8c2f22', roughness: 0.6 },
    });
    await h.ok('godot_resource_create', {
      projectPath: p.root,
      path: 'materials/grass.tres',
      type: 'StandardMaterial3D',
      properties: { albedo_color: [0.32, 0.55, 0.25, 1] },
    });
    await h.ok('godot_resource_edit', { projectPath: p.root, path: 'materials/roof.tres', properties: { metallic: 0.1 } });
    const r = await h.ok('godot_resource_inspect', { projectPath: p.root, path: 'materials/roof.tres' });
    assert.equal(r.class, 'StandardMaterial3D');
    assert.ok(Math.abs(Number((r.properties as Record<string, number>).metallic) - 0.1) < 1e-6);
  });

  it('builds a reusable building scene with real geometry and collision', async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'buildings/house.tscn', rootType: 'StaticBody3D', rootName: 'House' });
    await edit('buildings/house.tscn', [
      {
        action: 'add_node',
        type: 'MeshInstance3D',
        name: 'Body',
        properties: { mesh: { $new: 'BoxMesh', properties: { size: [4, 3, 4] } }, position: [0, 1.5, 0], material_override: 'res://materials/wall.tres' },
      },
      {
        action: 'add_node',
        type: 'MeshInstance3D',
        name: 'Roof',
        properties: {
          mesh: { $new: 'PrismMesh', properties: { size: [4.4, 1.5, 4.4] } },
          position: [0, 3.75, 0],
          material_override: 'res://materials/roof.tres',
        },
      },
      {
        action: 'add_node',
        type: 'CollisionShape3D',
        name: 'Collision',
        properties: { shape: { $new: 'BoxShape3D', properties: { size: [4, 3, 4] } }, position: [0, 1.5, 0] },
      },
    ]);
    const facts = await h.ok('godot_assets', { projectPath: p.root, action: 'check', paths: ['buildings/house.tscn'] });
    const f = (facts.results as Array<Record<string, number>>)[0]!;
    assert.equal(f.mesh_instances, 2);
    assert.equal(f.meshes_missing, 0);
  });

  it('builds a unit scene with navigation agent and typed command script', async () => {
    await h.ok('godot_script_write', { projectPath: p.root, path: 'units/unit.gd', content: UNIT_GD });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'units/unit.tscn', rootType: 'CharacterBody3D', rootName: 'Unit' });
    await edit('units/unit.tscn', [
      {
        action: 'add_node',
        type: 'MeshInstance3D',
        name: 'Mesh',
        properties: {
          mesh: { $new: 'CapsuleMesh', properties: { radius: 0.4, height: 1.6 } },
          position: [0, 0.8, 0],
          material_override: { $new: 'StandardMaterial3D', properties: { albedo_color: '#2a5bd7' } },
        },
      },
      {
        action: 'add_node',
        type: 'CollisionShape3D',
        name: 'Collision',
        properties: { shape: { $new: 'CapsuleShape3D', properties: { radius: 0.4, height: 1.6 } }, position: [0, 0.8, 0] },
      },
      { action: 'add_node', type: 'NavigationAgent3D', name: 'Agent', properties: { path_desired_distance: 0.5, target_desired_distance: 0.8 } },
      { action: 'attach_script', node: '.', script: 'units/unit.gd' },
    ]);
  });

  it('exports a MeshLibrary and uses it in a GridMap', async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'tiles/road_tiles.tscn', rootType: 'Node3D' });
    await edit('tiles/road_tiles.tscn', [
      {
        action: 'add_node',
        type: 'MeshInstance3D',
        name: 'Road',
        properties: {
          mesh: { $new: 'BoxMesh', properties: { size: [2, 0.1, 2] } },
          material_override: { $new: 'StandardMaterial3D', properties: { albedo_color: '#555555' } },
        },
      },
      {
        action: 'add_node',
        type: 'MeshInstance3D',
        name: 'Plaza',
        properties: {
          mesh: { $new: 'BoxMesh', properties: { size: [2, 0.1, 2] } },
          material_override: { $new: 'StandardMaterial3D', properties: { albedo_color: '#b0a080' } },
        },
      },
    ]);
    const lib = await h.ok('godot_resource_build', { projectPath: p.root, kind: 'mesh_library', path: 'tiles/road.meshlib', scene: 'tiles/road_tiles.tscn' });
    assert.equal((lib.items as unknown[]).length, 2);
  });

  it('assembles the battlefield: terrain, instances, lights, camera, environment, navigation, GridMap', async () => {
    await h.ok('godot_script_write', { projectPath: p.root, path: 'rts_main.gd', content: MAIN_GD });
    // The import step builds the global class cache so `RtsUnit` resolves.
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'battlefield.tscn', rootType: 'Node3D', rootName: 'Battlefield' });
    await edit('battlefield.tscn', [
      { action: 'attach_script', node: '.', script: 'rts_main.gd' },
      {
        action: 'add_node',
        type: 'Camera3D',
        name: 'Camera',
        properties: { transform: { origin: [0, 24, 20], rotation_degrees: [-52, 0, 0] }, current: true, fov: 60 },
      },
      {
        action: 'add_node',
        type: 'DirectionalLight3D',
        name: 'Sun',
        properties: { transform: { origin: [0, 10, 0], rotation_degrees: [-55, -30, 0] }, shadow_enabled: true, light_energy: 1.2 },
      },
      {
        action: 'add_node',
        type: 'WorldEnvironment',
        name: 'Env',
        properties: {
          environment: {
            $new: 'Environment',
            properties: { background_mode: 1, background_color: '#87b5e0', ambient_light_source: 2, ambient_light_color: '#ffffff', ambient_light_energy: 0.5 },
          },
        },
      },
      {
        action: 'add_node',
        type: 'NavigationRegion3D',
        name: 'NavRegion',
        properties: {
          navigation_mesh: {
            $new: 'NavigationMesh',
            properties: { agent_radius: 0.5, agent_height: 1.5, cell_size: 0.25, cell_height: 0.25, geometry_parsed_geometry_type: 'static_colliders' },
          },
        },
      },
      { action: 'add_node', parent: 'NavRegion', type: 'StaticBody3D', name: 'Ground' },
      {
        action: 'add_node',
        parent: 'NavRegion/Ground',
        type: 'MeshInstance3D',
        name: 'Mesh',
        properties: { mesh: { $new: 'PlaneMesh', properties: { size: [40, 40] } }, material_override: 'res://materials/grass.tres' },
      },
      {
        action: 'add_node',
        parent: 'NavRegion/Ground',
        type: 'CollisionShape3D',
        name: 'Collision',
        properties: { shape: { $new: 'BoxShape3D', properties: { size: [40, 0.2, 40] } }, position: [0, -0.1, 0] },
      },
      { action: 'instantiate_scene', parent: 'NavRegion', scene: 'buildings/house.tscn', name: 'House1', properties: { position: [-6, 0, -3] } },
      {
        action: 'instantiate_scene',
        parent: 'NavRegion',
        scene: 'buildings/house.tscn',
        name: 'House2',
        properties: { position: [5, 0, -7], rotation_degrees: [0, 30, 0] },
      },
      {
        action: 'instantiate_scene',
        parent: 'NavRegion',
        scene: 'buildings/house.tscn',
        name: 'TownHall',
        properties: { position: [0, 0, 3], scale: [1.4, 1.6, 1.4] },
      },
      { action: 'set_editable_children', node: 'NavRegion/TownHall', editable: true },
      {
        action: 'set_properties',
        node: 'NavRegion/TownHall/Roof',
        properties: { material_override: { $new: 'StandardMaterial3D', properties: { albedo_color: '#1f4e8c' } } },
      },
      { action: 'add_node', type: 'GridMap', name: 'Roads', properties: { mesh_library: 'res://tiles/road.meshlib', cell_size: [2, 0.2, 2] } },
      {
        action: 'gridmap_set_cells',
        node: 'Roads',
        cells: Array.from({ length: 10 }, (_, i) => ({ position: [i - 5, 0, 7], item: 'Road' })).concat([{ position: [0, 0, 6], item: 'Plaza' }]),
      },
      { action: 'add_node', type: 'Node3D', name: 'Units' },
      { action: 'instantiate_scene', parent: 'Units', scene: 'units/unit.tscn', name: 'U1', properties: { position: [-10, 0.1, -10] } },
      { action: 'instantiate_scene', parent: 'Units', scene: 'units/unit.tscn', name: 'U2', properties: { position: [-12, 0.1, -8] } },
      { action: 'add_to_group', node: 'Units/U1', group: 'units' },
      { action: 'add_to_group', node: 'Units/U2', group: 'units' },
      { action: 'connect_signal', from: 'Units/U1', signal: 'arrived', to: '.', method: '_on_unit_arrived' },
      { action: 'connect_signal', from: 'Units/U2', signal: 'arrived', to: '.', method: '_on_unit_arrived' },
    ]);
    await h.ok('godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/run/main_scene': 'res://battlefield.tscn' } });
    const text = readFileSync(join(p.root, 'battlefield.tscn'), 'utf8');
    assert.equal((text.match(/instance=ExtResource/g) ?? []).length, 5, 'buildings and units stay instances');
    assert.match(text, /\[editable path="NavRegion\/TownHall"\]/);
    assert.match(text, /\[connection signal="arrived" from="Units\/U1" to="\." method="_on_unit_arrived"\]/);
    const t = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'battlefield.tscn' });
    const types = (t.nodes as Array<{ type: string }>).map((n) => n.type);
    for (const ty of ['Camera3D', 'DirectionalLight3D', 'WorldEnvironment', 'NavigationRegion3D', 'GridMap', 'StaticBody3D', 'CharacterBody3D'])
      assert.ok(types.includes(ty), ty);
  });

  it('detects an incorrect call to the unit command contract statically', async () => {
    const bad = 'extends Node\nfunc order(u: RtsUnit) -> void:\n\tu.command_move(Vector3.ZERO)\n';
    const r = await h.ok('godot_script_validate', { projectPath: p.root, source: bad, sourcePath: 'commander.gd' });
    assert.equal(r.valid, false);
    assert.ok(
      (r.diagnostics as Array<{ message: string; line: number }>).some((d) => /Too few arguments/.test(d.message) && d.line === 3),
      JSON.stringify(r.diagnostics),
    );
    const good = await h.ok('godot_script_validate', {
      projectPath: p.root,
      source: 'extends Node\nfunc order(u: RtsUnit) -> void:\n\tu.command_move(Vector3.ZERO, 2.0)\n',
      sourcePath: 'commander.gd',
    });
    assert.equal(good.valid, true, JSON.stringify(good));
  });

  it('validates the project as healthy', async () => {
    const v = await h.ok('godot_project_validate', { projectPath: p.root });
    assert.equal(v.healthy, true, JSON.stringify(v.problems, null, 1));
  });

  it('runs: navigation bakes, units path around buildings and arrive via the signal contract', async () => {
    const r = await h.ok('godot_run', { projectPath: p.root, headless: true, mode: 'until_exit', fixedFps: 60, timeoutMs: 120000 });
    const out = (r.outputTail as string[]).join('\n');
    assert.match(out, /NAV_PATH_POINTS [1-9]/, out);
    assert.match(out, /ARRIVED 2 U1,U2/, out);
    const targets: Record<string, [number, number]> = { U1: [8, 8], U2: [8, 5] };
    const units = [...out.matchAll(/UNIT (U\d) (-?[\d.]+) (-?[\d.]+)/g)];
    assert.equal(units.length, 2, out);
    for (const m of units) {
      const [tx, tz] = targets[m[1]!]!;
      assert.ok(Math.hypot(Number(m[2]) - tx, Number(m[3]) - tz) < 1.5, `${m[1]} ended at ${m[2]},${m[3]}`);
    }
    assert.equal(r.healthy, true, JSON.stringify(r.diagnostics));
  });

  it(
    'renders: visible meshes in the camera frustum, no missing assets',
    { skip: process.platform === 'linux' && !process.env.DISPLAY ? 'no display' : false },
    async () => {
      const r = await h.call('godot_screenshot', { projectPath: p.root, width: 960, height: 540, frames: 8 });
      assert.ok(!r.isError, r.content[0]?.text);
      const s = r.structuredContent!;
      const facts = s.sceneFacts as Record<string, number | string | null>;
      assert.equal(facts.camera_3d, 'Camera');
      assert.equal(facts.meshes_missing, 0);
      assert.ok(Number(facts.meshes_in_view) >= 8, JSON.stringify(facts));
      assert.ok(Number(facts.lights) >= 1);
      assert.equal((s.stats as { looks_blank: boolean }).looks_blank, false);
      assert.ok(Number((s.stats as { distinct_colors_4bit: number }).distinct_colors_4bit) >= 8, JSON.stringify(s.stats));
      if (process.env.SHOT_DIR)
        writeFileSync(join(process.env.SHOT_DIR, 'fixture-b-rts.png'), Buffer.from(r.content.find((c) => c.type === 'image')!.data!, 'base64'));
    },
  );
});
