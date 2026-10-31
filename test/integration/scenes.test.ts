import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

type Node = {
  path: string;
  name: string;
  type: string;
  instance?: string;
  inherits?: string;
  override?: boolean;
  properties?: Record<string, unknown>;
  groups?: string[];
  script?: string;
};
const nodes = (r: Record<string, unknown>) => r.nodes as Node[];
const read = (root: string, f: string) => readFileSync(join(root, f), 'utf8');

describe('scene operations', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Scenes');
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('creates a scene with a UID and the requested root', async () => {
    const r = await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'scenes/level.tscn', rootType: 'Node2D' });
    assert.equal(r.root_name, 'Level');
    assert.match(String(r.uid), /^uid:\/\//);
    assert.match(read(p.root, 'scenes/level.tscn'), new RegExp(`uid="${String(r.uid)}"`));
    assert.equal((await h.fail('godot_scene_create', { projectPath: p.root, scenePath: 'scenes/level.tscn' })).code, 'ALREADY_EXISTS');
  });

  it('adds nodes with typed properties and persists them across reload', async () => {
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [
        { action: 'add_node', type: 'Node2D', name: 'World' },
        {
          action: 'add_node',
          parent: 'World',
          type: 'Sprite2D',
          name: 'Spr',
          properties: { position: [32, 48], modulate: '#336699', scale: { x: 2, y: 2 }, z_index: 3 },
        },
        { action: 'add_node', parent: 'World', type: 'Area2D', name: 'Zone', properties: { collision_layer: [2], collision_mask: [1, 3], monitoring: true } },
        {
          action: 'add_node',
          parent: 'World/Zone',
          type: 'CollisionShape2D',
          name: 'Shape',
          properties: { shape: { $new: 'CircleShape2D', properties: { radius: 12 } } },
        },
        { action: 'set_properties', node: 'World/Spr', properties: { rotation_degrees: 90 } },
        { action: 'add_to_group', node: 'World/Zone', group: 'triggers' },
      ],
    });
    const t = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'scenes/level.tscn', includeProperties: true });
    const spr = nodes(t).find((n) => n.path === 'World/Spr')!;
    assert.deepEqual((spr.properties!.position as { value: number[] }).value, [32, 48]);
    assert.deepEqual((spr.properties!.scale as { value: number[] }).value, [2, 2]);
    assert.ok(Math.abs(Number(spr.properties!.rotation) - Math.PI / 2) < 1e-5);
    const zone = nodes(t).find((n) => n.path === 'World/Zone')!;
    assert.equal(zone.properties!.collision_layer, 2);
    assert.equal(zone.properties!.collision_mask, 5);
    assert.deepEqual(zone.groups, ['triggers']);
    const text = read(p.root, 'scenes/level.tscn');
    assert.match(text, /\[sub_resource type="CircleShape2D"/);
    assert.match(text, /radius = 12/);
  });

  it('is all-or-nothing: a failing action leaves the file untouched', async () => {
    const before = read(p.root, 'scenes/level.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [
        { action: 'add_node', type: 'Node', name: 'Ok' },
        { action: 'set_properties', node: 'World/Spr', properties: { not_a_property: 1 } },
      ],
    });
    assert.equal(e.code, 'NOT_FOUND');
    assert.equal((e.context as { action_index: number }).action_index, 1);
    assert.equal(read(p.root, 'scenes/level.tscn'), before);
  });

  it('suggests property names and validates value types', async () => {
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [{ action: 'set_properties', node: 'World/Spr', properties: { positon: [1, 2] } }],
    });
    assert.ok((e.context as { suggestions: string[] }).suggestions.includes('position'));
    const e2 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [{ action: 'set_properties', node: 'World/Spr', properties: { position: 'left' } }],
    });
    assert.equal(e2.code, 'INVALID_ARGUMENT');
  });

  it('renames, reparents (keeping global transform), reorders and duplicates', async () => {
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [
        { action: 'add_node', type: 'Node2D', name: 'Holder', properties: { position: [100, 0] } },
        { action: 'rename_node', node: 'World/Spr', new_name: 'Hero' },
        { action: 'move_node', node: 'World/Hero', new_parent: 'Holder', keep_global_transform: true },
        { action: 'duplicate_node', node: 'World/Zone', new_name: 'Zone2' },
        { action: 'reorder_node', node: 'Holder', index: 0 },
      ],
    });
    const t = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'scenes/level.tscn', includeProperties: true });
    const hero = nodes(t).find((n) => n.path === 'Holder/Hero')!;
    assert.deepEqual((hero.properties!.position as { value: number[] }).value, [-68, 48]);
    assert.ok(
      nodes(t).some((n) => n.path === 'World/Zone2/Shape'),
      'duplicate keeps children',
    );
    assert.equal(nodes(t)[1]!.path, 'Holder');
  });

  it('instantiates sub-scenes without flattening and keeps references', async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'scenes/enemy.tscn', rootType: 'CharacterBody2D' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/enemy.tscn',
      actions: [
        { action: 'add_node', type: 'CollisionShape2D', name: 'Col', properties: { shape: { $new: 'RectangleShape2D', properties: { size: [10, 20] } } } },
      ],
    });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [
        { action: 'instantiate_scene', parent: 'World', scene: 'scenes/enemy.tscn', name: 'Enemy1', properties: { position: [5, 5] } },
        { action: 'instantiate_scene', parent: 'World', scene: 'res://scenes/enemy.tscn', name: 'Enemy2' },
      ],
    });
    const text = read(p.root, 'scenes/level.tscn');
    const enemyUid = /uid="(uid:\/\/[a-z0-9]+)"/.exec(read(p.root, 'scenes/enemy.tscn'))![1];
    assert.match(text, new RegExp(`\\[ext_resource type="PackedScene" uid="${enemyUid}" path="res://scenes/enemy.tscn"`));
    assert.match(text, /\[node name="Enemy1" parent="World" .*instance=ExtResource/);
    assert.doesNotMatch(text, /name="Col"/, 'sub-scene internals are not copied into the parent');
    // cyclic instancing is refused
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'scenes/enemy.tscn',
          actions: [{ action: 'instantiate_scene', parent: '.', scene: 'scenes/level.tscn' }],
        })
      ).code,
      'INVALID_ARGUMENT',
    );
    // structure inside an instance is protected
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'scenes/level.tscn',
          actions: [{ action: 'remove_node', node: 'World/Enemy1/Col' }],
        })
      ).code,
      'CONFLICT',
    );
    // editable children allow overrides
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [
        { action: 'set_editable_children', node: 'World/Enemy1', editable: true },
        { action: 'set_properties', node: 'World/Enemy1/Col', properties: { disabled: true } },
      ],
    });
    assert.match(read(p.root, 'scenes/level.tscn'), /\[editable path="World\/Enemy1"\]/);
  });

  it('edits inherited scenes without breaking inheritance', async () => {
    const r = await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'scenes/boss.tscn', inherits: 'scenes/enemy.tscn' });
    assert.equal(r.inherits, 'res://scenes/enemy.tscn');
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/boss.tscn',
      actions: [
        { action: 'add_node', type: 'Sprite2D', name: 'Crown' },
        { action: 'set_properties', node: 'Col', properties: { position: [0, -4] } },
      ],
    });
    const text = read(p.root, 'scenes/boss.tscn');
    assert.match(text, /\[node name="Boss" [^\]]*instance=ExtResource/);
    assert.match(text, /\[ext_resource type="PackedScene" uid="uid:\/\/[a-z0-9]+" path="res:\/\/scenes\/enemy.tscn"/);
    assert.match(text, /\[node name="Col" parent="\." /);
    assert.doesNotMatch(text, /type="CollisionShape2D"/, 'inherited nodes are stored as overrides, not re-declared');
    assert.equal(
      (await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'scenes/boss.tscn', actions: [{ action: 'remove_node', node: 'Col' }] })).code,
      'CONFLICT',
    );
    const t = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'scenes/boss.tscn' });
    assert.equal(t.inherited, true);
    assert.equal(t.root_type, 'CharacterBody2D');
  });

  it('keeps the scene UID and external resource references when editing one property', async () => {
    writeFile(p.root, 'mat.tres', '[gd_resource type="CanvasItemMaterial" format=3 uid="uid://cvxtestmat01a"]\n\n[resource]\nblend_mode = 1\n');
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [{ action: 'set_properties', node: 'Holder/Hero', properties: { material: 'res://mat.tres' } }],
    });
    const uidBefore = /uid="(uid:\/\/[a-z0-9]+)"/.exec(read(p.root, 'scenes/level.tscn'))![1];
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [{ action: 'set_properties', node: 'Holder', properties: { visible: false } }],
    });
    const text = read(p.root, 'scenes/level.tscn');
    assert.match(text, new RegExp(`uid="${uidBefore}"`));
    assert.match(text, /path="res:\/\/mat\.tres"/);
    assert.match(text, /material = ExtResource/);
    assert.equal(read(p.root, 'mat.tres').includes('blend_mode = 1'), true, 'external resource untouched');
    // Editing through an external resource is refused.
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'scenes/level.tscn',
          actions: [{ action: 'set_properties', node: 'Holder/Hero', properties: { 'material:blend_mode': 0 } }],
        })
      ).code,
      'CONFLICT',
    );
  });

  it('connects signals persistently and checks argument contracts', async () => {
    writeFile(p.root, 'zone.gd', 'extends Area2D\nfunc _on_body_entered(body: Node2D) -> void:\n\tpass\nfunc _no_args() -> void:\n\tpass\n');
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [
        { action: 'attach_script', node: 'World/Zone', script: 'zone.gd' },
        { action: 'connect_signal', from: 'World/Zone', signal: 'body_entered', to: 'World/Zone', method: '_on_body_entered' },
      ],
    });
    assert.match(read(p.root, 'scenes/level.tscn'), /\[connection signal="body_entered" from="World\/Zone" to="World\/Zone" method="_on_body_entered"\]/);
    const wrong = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [{ action: 'connect_signal', from: 'World/Zone', signal: 'body_entered', to: 'World/Zone', method: '_no_args' }],
    });
    assert.match(wrong.message, /delivers 1 argument/);
    const missing = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      actions: [{ action: 'connect_signal', from: 'World/Zone', signal: 'body_entered', to: 'World/Zone', method: 'nope' }],
    });
    assert.equal(missing.code, 'NOT_FOUND');
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'scenes/level.tscn',
          actions: [{ action: 'connect_signal', from: 'World/Zone', signal: 'not_a_signal', to: 'World', method: 'x' }],
        })
      ).code,
      'NOT_FOUND',
    );
    // script whose base class does not match the node
    writeFile(p.root, 'body.gd', 'extends CharacterBody3D\n');
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'scenes/level.tscn',
          actions: [{ action: 'attach_script', node: 'World', script: 'body.gd' }],
        })
      ).code,
      'INVALID_ARGUMENT',
    );
  });

  it('reports node details with class property metadata', async () => {
    const n = await h.ok('godot_node_inspect', { projectPath: p.root, scenePath: 'scenes/level.tscn', nodePath: 'World/Zone', filter: 'collision' });
    assert.equal(n.type, 'Area2D');
    assert.equal(n.script, 'res://zone.gd');
    assert.ok((n.class_properties as Array<{ name: string }>).some((x) => x.name === 'collision_layer'));
    assert.ok((n.connections as unknown[]).length >= 1);
  });

  it('supports dry runs and save-as variants', async () => {
    const before = read(p.root, 'scenes/level.tscn');
    const r = await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      dryRun: true,
      actions: [{ action: 'remove_node', node: 'World/Zone2' }],
    });
    assert.equal(r.dry_run, true);
    assert.equal(read(p.root, 'scenes/level.tscn'), before);
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'scenes/level.tscn',
      saveAs: 'scenes/level_b.tscn',
      actions: [{ action: 'remove_node', node: 'World/Zone2' }],
    });
    assert.doesNotMatch(read(p.root, 'scenes/level_b.tscn'), /Zone2/);
    assert.match(read(p.root, 'scenes/level.tscn'), /Zone2/);
  });

  it('paginates large scenes', async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'big.tscn', rootType: 'Node' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'big.tscn',
      actions: Array.from({ length: 300 }, (_, i) => ({ action: 'add_node', type: 'Node', name: `N${i}` })),
    });
    const page = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'big.tscn', offset: 100, limit: 50 });
    assert.equal(page.returned, 50);
    assert.equal(page.has_more, true);
    assert.equal((page.nodes as Node[])[0]!.name, 'N99');
  });
});
