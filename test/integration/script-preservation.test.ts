import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

/**
 * Regression: scripts that refer to an autoload singleton did not compile in
 * the headless worker (it never registered autoloads), so they were dropped,
 * with every script-defined value, whenever a scene or resource that uses them
 * was re-saved. Edits reported success while the file lost its
 * `script = ExtResource(...)` line. The worker now registers autoload names
 * with an inert placeholder, and every save is compared with the original.
 */
describe('script preservation', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  const read = (rel: string) => readFileSync(join(p.root, rel), 'utf8');
  /**
   * For a save in which project code changed a resource local to the scene that
   * an inherited scene does not store yet. Godot up to 4.7 gives the save a copy
   * of it, so the save is refused (`msg`); from 4.8 the save stores no copy, so
   * it may succeed, but then nothing but the added node may be written.
   */
  const refusedOrNotStored = async (scene: string, added: string, msg: RegExp) => {
    const before = read(scene);
    const r = await h.call('godot_scene_edit', { projectPath: p.root, scenePath: scene, actions: [{ action: 'add_node', type: 'Node', name: added }] });
    if (r.isError) {
      const e = (r.structuredContent?.error ?? {}) as { code?: string; message?: string };
      assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
      assert.match(e.message ?? '', msg);
      assert.equal(read(scene), before);
      return;
    }
    const norm = (t: string) =>
      t
        .replace(/ uid="[^"]*"/g, '')
        .replace(/ unique_id=\d+/g, '')
        .replace(/ index="\d+"/g, '');
    const old = new Set(norm(before).split('\n'));
    const extra = norm(read(scene))
      .split('\n')
      .filter((l) => l !== '' && !old.has(l));
    assert.deepEqual(
      extra.filter((l) => !l.startsWith('[gd_scene ') && !l.startsWith(`[node name="${added}" type="Node" parent="."`)),
      [],
      read(scene),
    );
  };

  const LEVEL = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://unit.gd" id="1"]
[ext_resource type="PackedScene" path="res://player.tscn" id="2"]

[sub_resource type="TileSet" id="ts"]

[node name="Level" type="Node2D" node_paths=PackedStringArray("target", "targets")]
script = ExtResource("1")
speed = 99
target = NodePath("Child")
targets = [NodePath("Child"), NodePath("Player")]
tint = Color(1, 0, 0, 1)

[node name="Child" type="Node2D" parent="."]

[node name="Player" parent="." instance=ExtResource("2")]
speed = 7

[node name="Tiles" type="TileMapLayer" parent="."]
tile_set = SubResource("ts")

[connection signal="hit" from="." to="." method="_on_hit"]
[connection signal="hit" from="Player" to="Child" method="queue_free"]
`;

  const ARENA = `[gd_scene load_steps=5 format=3]

[ext_resource type="Script" path="res://boss.gd" id="1"]
[ext_resource type="Resource" path="res://item.tres" id="2"]
[ext_resource type="Script" path="res://enemy.gd" id="3"]

[node name="Boss" type="Node2D" node_paths=PackedStringArray("target", "minions", "by_name")]
script = ExtResource("1")
target = NodePath("E")
loot = ExtResource("2")
minions = [NodePath("E"), NodePath("E2")]
by_name = {
"e": NodePath("E")
}
n = 6

[node name="E" type="Node2D" parent="."]
script = ExtResource("3")
hp = 9

[node name="E2" type="Node2D" parent="."]
script = ExtResource("3")

[node name="Child" type="Node2D" parent="."]
`;

  before(async () => {
    h = await startServer();
    p = tempProject('Preserve', '\n[autoload]\n\nGameState="*res://game_state.gd"\n');
    writeFile(p.root, 'game_state.gd', 'extends Node\nvar score := 0\n');
    writeFile(
      p.root,
      'unit.gd',
      'extends Node2D\nsignal hit(amount: int)\n@export var speed = 1\n@export var target: Node\n@export var targets: Array[Node] = []\n@export var tint: Color = Color.WHITE\nfunc _ready():\n\tGameState.score += 1\nfunc _on_hit(_a):\n\tpass\n',
    );
    writeFile(
      p.root,
      'player.tscn',
      '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://unit.gd" id="1"]\n\n[node name="Player" type="Node2D"]\nscript = ExtResource("1")\nspeed = 5\n',
    );
    writeFile(p.root, 'level.tscn', LEVEL);
    writeFile(
      p.root,
      'item.gd',
      'extends Resource\nclass_name ItemData\n@export var hp: int = 10\n@export var tags: Array[String] = []\nfunc bonus():\n\treturn GameState.score\n',
    );
    writeFile(
      p.root,
      'item.tres',
      '[gd_resource type="Resource" script_class="ItemData" load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://item.gd" id="1"]\n\n[resource]\nscript = ExtResource("1")\nhp = 42\ntags = Array[String](["a", "b"])\n',
    );
    writeFile(p.root, 'broken.gd', 'extends Node\n@export var a = 1\nfunc f():\n\tvar x: int = "not an int"\n');
    writeFile(
      p.root,
      'uses_broken.tscn',
      '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://broken.gd" id="1"]\n\n[node name="B" type="Node"]\nscript = ExtResource("1")\na = 3\n',
    );
    writeFile(
      p.root,
      'builtin.tscn',
      '[gd_scene load_steps=2 format=3]\n\n[sub_resource type="GDScript" id="s"]\nscript/source = "extends Node\nfunc _ready():\n\tvar x: int = \\"not an int\\"\n"\n\n[node name="B" type="Node"]\nscript = SubResource("s")\n',
    );
    // Enemy uses an autoload; Boss compiles but types its properties with
    // Enemy and ItemData, and arena.tscn lists boss.gd before their files.
    writeFile(
      p.root,
      'enemy.gd',
      'extends Node2D\nclass_name Enemy\nsignal died(x: int)\n@export var hp := 3\nfunc f():\n\treturn GameState.score\nfunc on_died(_x):\n\tpass\n',
    );
    writeFile(
      p.root,
      'boss.gd',
      'extends Node2D\n@export var target: Enemy\n@export var loot: ItemData\n@export var minions: Array[Enemy] = []\n@export var by_name: Dictionary[String, Node2D] = {}\n@export var n := 4\n',
    );
    writeFile(p.root, 'arena.tscn', ARENA);
    writeFile(p.root, 'thing.cs', 'using Godot;\npublic partial class Thing : Node\n{\n}\n');
    writeFile(
      p.root,
      'cs.tscn',
      '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://thing.cs" id="1"]\n\n[node name="T" type="Node"]\nscript = ExtResource("1")\nZ = 4\n',
    );
    // o.tres and pz.tscn load q.tres (pz.tscn is still in memory when q.tres comes up) before q.tres itself is re-saved.
    writeFile(p.root, 'holder.gd', 'extends Resource\n@export var m := 1\nfunc g():\n\treturn GameState.score\n');
    writeFile(
      p.root,
      'q.tres',
      '[gd_resource type="Resource" load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://holder.gd" id="1"]\n\n[resource]\nscript = ExtResource("1")\nm = 5\n',
    );
    writeFile(
      p.root,
      'o.tres',
      '[gd_resource type="Resource" load_steps=2 format=3]\n\n[ext_resource type="Resource" path="res://q.tres" id="1"]\n\n[resource]\nmetadata/x = ExtResource("1")\n',
    );
    writeFile(p.root, 'pn.gd', 'extends Node\n@export var h: Resource\n');
    writeFile(
      p.root,
      'pz.tscn',
      '[gd_scene load_steps=3 format=3]\n\n[ext_resource type="Script" path="res://pn.gd" id="1"]\n[ext_resource type="Resource" path="res://q.tres" id="2"]\n\n[node name="P" type="Node"]\nscript = ExtResource("1")\nh = ExtResource("2")\n',
    );
    // The editor importer registers ItemData in the global class cache.
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  const assertLevelIntact = (text: string) => {
    assert.match(text, /\[node name="Level" type="Node2D"[^\]]*node_paths=PackedStringArray\("target", "targets"\)/, text);
    assert.match(text, /script = ExtResource\("[^"]+"\)/, text);
    assert.match(text, /target = NodePath\("Child"\)/, text);
    assert.match(text, /targets = \[NodePath\("Child"\), NodePath\("Player"\)\]/, text);
    assert.match(text, /tint = Color\(1, 0, 0, 1\)/, text);
    assert.match(text, /\[node name="Player" parent="\."[^\]]*\]\nspeed = 7/, text);
    assert.doesNotMatch(text, /script = null/, text);
    assert.match(text, /\[connection signal="hit" from="\." to="\." method="_on_hit"\]/, text);
    assert.match(text, /\[connection signal="hit" from="Player" to="Child" method="queue_free"\]/, text);
  };

  it('keeps scripts that use autoloads, their values, node references and connections when editing a scene', async () => {
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'level.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'Added' }] });
    const text = read('level.tscn');
    assertLevelIntact(text);
    assert.match(text, /speed = 99/, text);
    assert.match(text, /\[node name="Added" type="Node" parent="\."/, text);
  });

  it("sets a preserved script's variables", async () => {
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'level.tscn',
      actions: [{ action: 'set_properties', node: '.', properties: { speed: 120 } }],
    });
    const text = read('level.tscn');
    assert.match(text, /speed = 120/, text);
    assertLevelIntact(text);
  });

  it('instances a scene whose root script uses autoloads without overriding its script', async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'world.tscn', rootType: 'Node2D' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'world.tscn',
      actions: [{ action: 'instantiate_scene', parent: '.', scene: 'player.tscn', name: 'P' }],
    });
    const text = read('world.tscn');
    assert.match(text, /\[node name="P" parent="\."[^\]]*instance=ExtResource/, text);
    assert.doesNotMatch(text, /script = null/, text);
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'level_child.tscn', inherits: 'level.tscn' });
    assert.doesNotMatch(read('level_child.tscn'), /script = null/);
  });

  it('keeps the script, class header and typed arrays of a .tres when editing it', async () => {
    await h.ok('godot_resource_edit', { projectPath: p.root, path: 'item.tres', properties: { hp: 50 } });
    const text = read('item.tres');
    assert.match(text, /script_class="ItemData"/, text);
    assert.match(text, /script = ExtResource\("[^"]+"\)/, text);
    assert.match(text, /hp = 50/, text);
    assert.match(text, /tags = Array\[String\]\(\["a", "b"\]\)/, text);
  });

  it('keeps values typed with classes that use autoloads, whatever order the scene lists its scripts in', async () => {
    // Regression: boss.gd compiles, but its typed properties rejected the
    // stand-in-backed values (and Enemy's stand-in failed when listed after it).
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'arena.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'Added' }] });
    const text = read('arena.tscn');
    assert.match(text, /\[node name="Boss" type="Node2D"[^\]]*node_paths=PackedStringArray\("target", "minions", "by_name"\)/, text);
    assert.match(text, /target = NodePath\("E"\)/, text);
    assert.match(text, /loot = ExtResource\("[^"]+"\)/, text);
    assert.match(text, /minions = \[NodePath\("E"\), NodePath\("E2"\)\]/, text);
    assert.match(text, /by_name = \{\n"e": NodePath\("E"\)\n\}/, text);
    assert.match(text, /n = 6/, text);
    assert.match(text, /hp = 9/, text);
    assert.doesNotMatch(text, /= null/, text);
  });

  it('attaches a script that uses autoloads and sets its properties in the same batch', async () => {
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'arena.tscn',
      actions: [
        { action: 'add_node', type: 'Node2D', name: 'E3' },
        { action: 'attach_script', node: 'E3', script: 'enemy.gd', properties: { hp: 12 } },
      ],
    });
    assert.match(read('arena.tscn'), /\[node name="E3" type="Node2D" parent="\."[^\]]*\]\nscript = ExtResource\("[^"]+"\)\nhp = 12/);
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'arena.tscn',
      actions: [{ action: 'attach_script', node: 'Child', script: 'broken.gd' }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
  });

  it('connects to methods of scripts that use autoloads and checks signal arity', async () => {
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'arena.tscn',
      actions: [{ action: 'connect_signal', from: 'E', signal: 'died', to: 'E2', method: 'on_died' }],
    });
    assert.match(read('arena.tscn'), /\[connection signal="died" from="E" to="E2" method="on_died"\]/);
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'arena.tscn',
      actions: [{ action: 'connect_signal', from: 'E', signal: 'died', to: 'Child', method: 'queue_free' }],
    });
    assert.equal(e.code, 'INVALID_ARGUMENT', JSON.stringify(e));
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'arena.tscn',
      actions: [{ action: 'connect_signal', from: 'E', signal: 'died', to: 'Child', method: 'queue_free', unbinds: 1 }],
    });
  });

  it('refuses to save scenes whose scripts cannot be preserved, and leaves them untouched', async () => {
    for (const scenePath of ['uses_broken.tscn', 'builtin.tscn', 'cs.tscn']) {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions: [{ action: 'add_node', type: 'Node', name: 'X' }] });
      assert.equal(e.code, 'OPERATION_FAILED', scenePath);
      assert.match(e.message, /do not compile/, e.message);
      assert.equal(read(scenePath), before, scenePath);
    }
    // Read-only tools still work on them.
    await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'uses_broken.tscn' });
  });

  it('re-saves the project without dropping scripts, skipping files it cannot preserve', async () => {
    const broken = read('uses_broken.tscn');
    const r = await h.ok('godot_uid', { projectPath: p.root, action: 'resave' });
    assert.ok(
      (r.skipped as Array<{ path: string }>).some((s) => s.path === 'res://uses_broken.tscn'),
      JSON.stringify(r),
    );
    assert.deepEqual(r.failed, [], JSON.stringify(r));
    assert.equal(read('uses_broken.tscn'), broken);
    // q.tres was already loaded (through o.tres and pz.tscn) when its turn came.
    const q = read('q.tres');
    assert.match(q, /script = ExtResource\("[^"]+"\)/, q);
    assert.match(q, /m = 5/, q);
    assert.match(read('pz.tscn'), /h = ExtResource/);
    assertLevelIntact(read('level.tscn'));
    assert.match(read('builtin.tscn'), /not an int/);
    const item = read('item.tres');
    assert.match(item, /script = ExtResource/, item);
    assert.match(item, /hp = 50/, item);
    assert.match(item, /tags = Array\[String\]/, item);
    // The legacy re-save tools go through the same checks.
    await h.ok('save_scene', { projectPath: p.root, scenePath: 'level.tscn' });
    assertLevelIntact(read('level.tscn'));
  });

  it('fails the whole batch, saving nothing, when an action crashes inside the worker', async () => {
    // Regression: a runtime error in the worker returned null, which counted as
    // success; the remaining actions ran and the scene was saved.
    const before = read('level.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'level.tscn',
      actions: [
        { action: 'tilemap_set_cells', node: 'Tiles', cells: [1] },
        { action: 'remove_node', node: 'Child' },
      ],
    });
    assert.equal(e.code, 'INTERNAL', JSON.stringify(e));
    assert.equal(read('level.tscn'), before);
  });

  it('keeps values typed with a base class whose subclass uses autoloads', async () => {
    writeFile(p.root, 'item_base.gd', 'class_name ItemBase extends Resource\n@export var title := ""\n');
    writeFile(p.root, 'magic_item.gd', 'class_name MagicItem extends ItemBase\n@export var power := 1\nfunc use() -> void:\n\tGameState.score += power\n');
    writeFile(
      p.root,
      'inventory.gd',
      'class_name Inventory extends Resource\n@export var label := "a"\n@export var main: ItemBase\n@export var items: Array[ItemBase] = []\n',
    );
    writeFile(p.root, 'goblin.gd', 'class_name Goblin extends Enemy\n@export var rage := 1\nfunc _ready() -> void:\n\tGameState.score += 1\n');
    writeFile(p.root, 'army.gd', 'extends Node2D\n@export var foes: Array[Enemy] = []\n@export var boss: Enemy\n');
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    writeFile(
      p.root,
      'sword.tres',
      '[gd_resource type="Resource" script_class="MagicItem" format=3]\n\n[ext_resource type="Script" path="res://magic_item.gd" id="1"]\n\n[resource]\nscript = ExtResource("1")\ntitle = "Sword"\npower = 5\n',
    );
    writeFile(
      p.root,
      'inv.tres',
      '[gd_resource type="Resource" script_class="Inventory" format=3]\n\n[ext_resource type="Script" path="res://inventory.gd" id="1"]\n[ext_resource type="Resource" path="res://sword.tres" id="2"]\n[ext_resource type="Script" path="res://item_base.gd" id="3"]\n\n[resource]\nscript = ExtResource("1")\nmain = ExtResource("2")\nitems = Array[ExtResource("3")]([ExtResource("2")])\n',
    );
    writeFile(
      p.root,
      'army.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://army.gd" id="1"]\n[ext_resource type="Script" path="res://goblin.gd" id="2"]\n\n[node name="Army" type="Node2D" node_paths=PackedStringArray("foes", "boss")]\nscript = ExtResource("1")\nfoes = [NodePath("G")]\nboss = NodePath("G")\n\n[node name="G" type="Node2D" parent="."]\nscript = ExtResource("2")\nrage = 9\n',
    );
    await h.ok('godot_resource_edit', { projectPath: p.root, path: 'inv.tres', properties: { label: 'b' } });
    const inv = read('inv.tres');
    assert.match(inv, /main = ExtResource\("[^"]+"\)/, inv);
    assert.match(inv, /items = Array\[ExtResource\("[^"]+"\)\]\(\[ExtResource\("[^"]+"\)\]\)/, inv);
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'army.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'Added' }] });
    const army = read('army.tscn');
    assert.match(army, /foes = \[NodePath\("G"\)\]/, army);
    assert.match(army, /boss = NodePath\("G"\)/, army);
    assert.match(army, /rage = 9/, army);
  });

  it('keeps cyclic class references, whatever order the file lists them in', async () => {
    writeFile(p.root, 'ca.gd', 'class_name CA extends Resource\n@export var other: CB\n@export var v := 1\nfunc f() -> void:\n\tGameState.score = 1\n');
    writeFile(p.root, 'cb.gd', 'class_name CB extends Resource\n@export var other: CA\n@export var n := 1\n');
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    for (const [name, order] of [
      ['cyc1.tres', ['ca', 'cb']],
      ['cyc2.tres', ['cb', 'ca']],
    ] as const) {
      const ext = order.map((c) => `[ext_resource type="Script" path="res://${c}.gd" id="${c}"]`).join('\n');
      writeFile(
        p.root,
        name,
        `[gd_resource type="Resource" script_class="CB" format=3]\n\n${ext}\n\n[sub_resource type="Resource" id="a"]\nscript = ExtResource("ca")\nv = 5\n\n[resource]\nscript = ExtResource("cb")\nother = SubResource("a")\nn = 2\n`,
      );
      await h.ok('godot_resource_edit', { projectPath: p.root, path: name, properties: { resource_name: 'zz' } });
      const text = read(name);
      assert.match(text, /\[sub_resource type="Resource" id="a"\]\nscript = ExtResource\("[^"]+"\)\nv = 5/, text);
      assert.match(text, /other = SubResource\("a"\)/, text);
      assert.match(text, /n = 2/, text);
    }
  });

  it('keeps properties a script supplies through _get_property_list', async () => {
    writeFile(
      p.root,
      'dyn.gd',
      'extends Resource\n@export var plain := 1\nvar extra := {"speed": 0, "mode": ""}\nfunc _get_property_list() -> Array:\n\treturn [{"name": "extra_speed", "type": TYPE_INT, "usage": PROPERTY_USAGE_DEFAULT}, {"name": "extra_mode", "type": TYPE_STRING, "usage": PROPERTY_USAGE_DEFAULT}]\nfunc _set(n: StringName, v: Variant) -> bool:\n\tif str(n).begins_with("extra_"):\n\t\textra[str(n).substr(6)] = v\n\t\treturn true\n\treturn false\nfunc _get(n: StringName) -> Variant:\n\tif str(n).begins_with("extra_"):\n\t\treturn extra.get(str(n).substr(6))\n\treturn null\nfunc f() -> void:\n\tGameState.score = 1\n',
    );
    writeFile(
      p.root,
      'dyn.tres',
      '[gd_resource type="Resource" format=3]\n\n[ext_resource type="Script" path="res://dyn.gd" id="1"]\n\n[resource]\nscript = ExtResource("1")\nplain = 2\nextra_speed = 7\nextra_mode = "fast"\n',
    );
    await h.ok('godot_resource_edit', { projectPath: p.root, path: 'dyn.tres', properties: { plain: 5 } });
    const text = read('dyn.tres');
    assert.match(text, /extra_speed = 7/, text);
    assert.match(text, /extra_mode = "fast"/, text);
  });

  it('refuses, leaving the file untouched, when a setter fails before storing a value', async () => {
    // The setter runs headlessly and the autoload is only a placeholder there,
    // so it fails before assigning: the save would silently drop `hp = 5`.
    writeFile(p.root, 'guarded.gd', 'extends Node\n@export var hp := 1:\n\tset(v):\n\t\tGameState.score += v\n\t\thp = v\n');
    writeFile(
      p.root,
      'guarded.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://guarded.gd" id="1"]\n\n[node name="G" type="Node"]\nscript = ExtResource("1")\nhp = 5\n',
    );
    const before = read('guarded.tscn');
    const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'guarded.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'X' }] });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.match(e.message, /hp/, e.message);
    assert.equal(read('guarded.tscn'), before);
  });

  it('never runs autoloads and leaves project.godot untouched', async () => {
    writeFile(
      p.root,
      'game_state.gd',
      'extends Node\nvar score := 0\nfunc _init():\n\tFileAccess.open("res://AUTOLOAD_RAN.txt", FileAccess.WRITE).store_string("ran")\n',
    );
    const settings = read('project.godot');
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'level.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'Probe' }] });
    assert.equal(read('project.godot'), settings);
    assert.equal(existsSync(join(p.root, 'AUTOLOAD_RAN.txt')), false);
  });

  it('refuses when loading changes a stored value, even if an action touched the node', async () => {
    // Setters run headlessly and see the autoload as an empty placeholder, so
    // they can half-apply a value before failing.
    writeFile(
      p.root,
      'waves.gd',
      'extends Node2D\n@export var waves: Array[int] = []:\n\tset(v):\n\t\twaves = []\n\t\tfor w in v:\n\t\t\twaves.append(w)\n\t\t\tGameState.score += w\n',
    );
    writeFile(
      p.root,
      'waves.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://waves.gd" id="1"]\n\n[node name="Root" type="Node2D"]\n\n[node name="Group" type="Node2D" parent="."]\n\n[node name="W" type="Node2D" parent="Group"]\nscript = ExtResource("1")\nwaves = Array[int]([1, 2, 3])\n',
    );
    const before = read('waves.tscn');
    for (const actions of [
      [{ action: 'add_node', type: 'Node', name: 'X' }],
      [{ action: 'set_properties', node: 'Group/W', properties: { position: { x: 1, y: 2 } } }],
      [{ action: 'add_to_group', node: 'Group/W', group: 'g' }],
      [{ action: 'rename_node', node: 'Group', new_name: 'G2' }],
      [{ action: 'move_node', node: 'Group/W', new_parent: '.' }],
    ]) {
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'waves.tscn', actions });
      assert.equal(e.code, 'OPERATION_FAILED', `${JSON.stringify(actions)}: ${JSON.stringify(e)}`);
      assert.match(e.message, /waves/, e.message);
      assert.equal(read('waves.tscn'), before);
    }
  });

  it('refuses when an instance override would be replaced by the default', async () => {
    writeFile(p.root, 'hp_unit.gd', 'extends Node2D\n@export var hp := 10:\n\tset(v):\n\t\tGameState.score += v\n\t\thp = v\n');
    writeFile(
      p.root,
      'hp_unit.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://hp_unit.gd" id="1"]\n\n[node name="U" type="Node2D"]\nscript = ExtResource("1")\nhp = 20\n',
    );
    writeFile(
      p.root,
      'hp_parent.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://hp_unit.tscn" id="1"]\n\n[node name="P" type="Node2D"]\n\n[node name="C" parent="." instance=ExtResource("1")]\nhp = 40\n',
    );
    const before = read('hp_parent.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'hp_parent.tscn',
      actions: [{ action: 'add_node', type: 'Node', name: 'X' }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.equal(read('hp_parent.tscn'), before);
  });

  it('refuses new instances and inherited scenes that would store a changed value', async () => {
    // hp_unit.tscn stores hp = 20; its setter fails headlessly, so a fresh
    // instance holds the default 10, which would be saved as an override.
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'host.tscn', rootType: 'Node2D' });
    const host = read('host.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'host.tscn',
      actions: [{ action: 'instantiate_scene', parent: '.', scene: 'hp_unit.tscn', name: 'U' }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.equal(read('host.tscn'), host);
    const e2 = await h.fail('godot_scene_create', { projectPath: p.root, scenePath: 'hp_kid.tscn', inherits: 'hp_unit.tscn' });
    assert.equal(e2.code, 'OPERATION_FAILED', JSON.stringify(e2));
    assert.equal(existsSync(join(p.root, 'hp_kid.tscn')), false);
  });

  it('fails an action whose setter raises an error instead of reporting the value as set', async () => {
    const before = read('hp_unit.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'hp_unit.tscn',
      actions: [{ action: 'set_properties', node: '.', properties: { hp: 60 } }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.match(e.message, /hp/, e.message);
    assert.equal(read('hp_unit.tscn'), before);
  });

  it('refuses scenes whose dependencies or node classes cannot be loaded', async () => {
    writeFile(
      p.root,
      'missing_dep.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://gone.png" id="1"]\n\n[node name="S" type="Sprite2D"]\ntexture = ExtResource("1")\n',
    );
    writeFile(
      p.root,
      'unknown_class.tscn',
      '[gd_scene format=3]\n\n[node name="R" type="Node"]\n\n[node name="T" type="SomeExtensionNode" parent="."]\nsize = 4\n',
    );
    for (const scenePath of ['missing_dep.tscn', 'unknown_class.tscn']) {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions: [{ action: 'add_node', type: 'Node', name: 'X' }] });
      assert.equal(e.code, 'OPERATION_FAILED', `${scenePath}: ${JSON.stringify(e)}`);
      assert.equal(read(scenePath), before);
    }
  });

  it('refuses saves that change native or hidden values, including copies saved as .scn', async () => {
    writeFile(p.root, 'flip.gd', 'extends Node2D\n@export var flip := false:\n\tset(v):\n\t\tflip = v\n\t\tscale = Vector2(-1, 1) if v else Vector2.ONE\n');
    writeFile(
      p.root,
      'hidden.gd',
      'extends Node2D\n@export var mode := 0\n@export var speed := 1.0\nfunc _validate_property(p: Dictionary) -> void:\n\tif p.name == "speed" and mode == 0:\n\t\tp.usage = PROPERTY_USAGE_NONE\n',
    );
    writeFile(p.root, 'clamp.gd', 'extends Node2D\n@export var gold := 0:\n\tset(v):\n\t\tgold = mini(v, 999999)\n');
    writeFile(p.root, 'meta_init.gd', 'extends Node2D\nfunc _init() -> void:\n\tset_meta("spawned", true)\n');
    const scene = (script: string, props: string) =>
      `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://${script}" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="E" type="Node2D" parent="."]\nscript = ExtResource("1")\n${props}\n`;
    writeFile(p.root, 'flip.tscn', scene('flip.gd', 'scale = Vector2(2, 2)\nflip = true'));
    writeFile(p.root, 'hidden.tscn', scene('hidden.gd', 'speed = 5.0'));
    writeFile(p.root, 'clamp.tscn', scene('clamp.gd', 'gold = 1000000'));
    writeFile(p.root, 'meta_init.tscn', scene('meta_init.gd', ''));
    for (const scenePath of ['flip.tscn', 'hidden.tscn', 'clamp.tscn']) {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions: [{ action: 'add_node', type: 'Node', name: 'X' }] });
      assert.equal(e.code, 'OPERATION_FAILED', `${scenePath}: ${JSON.stringify(e)}`);
      assert.equal(read(scenePath), before);
    }
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'meta_init.tscn',
      actions: [{ action: 'add_node', type: 'Node', name: 'X' }],
      saveAs: 'meta_copy.scn',
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.equal(existsSync(join(p.root, 'meta_copy.scn')), false);
  });

  it('edits CRLF files, sub-resource paths and setters that copy their value', async () => {
    writeFile(p.root, 'stats.gd', 'class_name StatsRes extends Resource\n@export var hp := 10\n@export var tag := "a"\n');
    writeFile(p.root, 'holder2.gd', 'extends Node2D\n@export var stats: Resource:\n\tset(v):\n\t\tstats = v.duplicate() if v != null else null\n');
    const text = [
      '[gd_scene format=3]',
      '',
      '[ext_resource type="Script" path="res://holder2.gd" id="1"]',
      '[ext_resource type="Script" path="res://stats.gd" id="2"]',
      '',
      '[sub_resource type="Resource" id="st"]',
      'script = ExtResource("2")',
      'hp = 40',
      'tag = "b"',
      '',
      '[node name="R" type="Node2D"]',
      'script = ExtResource("1")',
      'stats = SubResource("st")',
      '',
    ].join('\r\n');
    writeFile(p.root, 'crlf.tscn', text);
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'crlf.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'X' }] });
    let saved = read('crlf.tscn');
    assert.match(saved, /hp = 40/, saved);
    assert.match(saved, /tag = "b"/, saved);
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'crlf.tscn',
      actions: [{ action: 'set_properties', node: '.', properties: { 'stats:hp': 50 } }],
    });
    saved = read('crlf.tscn');
    assert.match(saved, /hp = 50/, saved);
    assert.match(saved, /tag = "b"/, saved);
  });

  it('refuses to save nodes that project code creates while the scene loads, also in a dry run', async () => {
    writeFile(p.root, 'gen.gd', 'extends Node2D\nfunc _init() -> void:\n\tvar t := Timer.new()\n\tt.name = "AutoTimer"\n\tadd_child(t)\n\tt.owner = self\n');
    writeFile(
      p.root,
      'gen.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://gen.gd" id="1"]\n\n[node name="G" type="Node2D"]\nscript = ExtResource("1")\n',
    );
    const before = read('gen.tscn');
    for (const dryRun of [false, true]) {
      const e = await h.fail('godot_scene_edit', {
        projectPath: p.root,
        scenePath: 'gen.tscn',
        dryRun,
        actions: [{ action: 'add_node', type: 'Node', name: 'X' }],
      });
      assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
      assert.match(e.message, /AutoTimer/, e.message);
    }
    assert.equal(read('gen.tscn'), before);
  });

  it('accepts ordinary placement edits, unique-name paths and files from older Godot versions', async () => {
    writeFile(
      p.root,
      'placement.tscn',
      [
        '[gd_scene format=3]',
        '',
        '[sub_resource type="Animation" id="A"]',
        'resource_name = "open"',
        'length = 1.0',
        '',
        '[sub_resource type="AnimationLibrary" id="L"]',
        '_data = {',
        '"open": SubResource("A")',
        '}',
        '',
        '[sub_resource type="SpriteFrames" id="F"]',
        'animations = [{',
        '"frames": [],',
        '"loop": true,',
        '"name": &"default",',
        '"speed": 5.0',
        '}]',
        '',
        '[node name="Root" type="Node2D"]',
        '',
        '[node name="Box" type="Node3D" parent="."]',
        'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 2, 3)',
        '',
        '[node name="Sprite" type="Node2D" parent="."]',
        'unique_name_in_owner = true',
        'rotation = 0.5',
        '',
        '[node name="UI" type="Control" parent="."]',
        'layout_mode = 3',
        'anchors_preset = 0',
        'offset_left = 10.0',
        'offset_top = 10.0',
        'offset_right = 110.0',
        'offset_bottom = 50.0',
        '',
        '[node name="AP" type="AnimationPlayer" parent="."]',
        'libraries = {',
        '"": SubResource("L")',
        '}',
        '',
        '[node name="Anim" type="AnimatedSprite2D" parent="."]',
        'sprite_frames = SubResource("F")',
        '',
      ].join('\n'),
    );
    const edits = [
      { action: 'set_properties', node: 'Box', properties: { position: { $type: 'Vector3', value: [4, 5, 6] } } },
      { action: 'set_properties', node: '%Sprite', properties: { rotation_degrees: 45 } },
      { action: 'set_properties', node: 'UI', properties: { size: { $type: 'Vector2', value: [200, 80] } } },
      { action: 'add_node', type: 'Node', name: 'Added' },
    ];
    for (const action of edits) await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'placement.tscn', actions: [action] });
    const text = read('placement.tscn');
    assert.match(text, /Transform3D\(1, 0, 0, 0, 1, 0, 0, 0, 1, 4, 5, 6\)/, text);
    assert.match(text, /SubResource\("L"\)/, text);
  });

  it('refuses changes that project code makes to native data, whatever the action', async () => {
    // Each setter changes something the file stores; the change would be saved
    // and applied again on top at runtime.
    writeFile(
      p.root,
      'grad_node.gd',
      'extends Node2D\n@export var grad: Gradient:\n\tset(v):\n\t\tgrad = v\n\t\tif v:\n\t\t\tv.add_point(0.5, Color(1, 0, 0))\n',
    );
    writeFile(
      p.root,
      'grad_res.gd',
      'extends Resource\n@export var grad: Gradient:\n\tset(v):\n\t\tgrad = v\n\t\tif v:\n\t\t\tv.add_point(0.5, Color(1, 0, 0))\n',
    );
    writeFile(p.root, 'grow.gd', 'extends Node2D\n@export var grow := 1.0:\n\tset(v):\n\t\tgrow = v\n\t\tscale *= v\n');
    writeFile(p.root, 'mover.gd', 'extends Node2D\nfunc _init() -> void:\n\tposition = Vector2(99, 99)\n');
    const grad = '[sub_resource type="Gradient" id="g"]\noffsets = PackedFloat32Array(0, 1)\ncolors = PackedColorArray(0, 0, 0, 1, 1, 1, 1, 1)\n\n';
    const head = (scripts: string[]) =>
      `[gd_scene format=3]\n\n${scripts.map((sc, i) => `[ext_resource type="Script" path="res://${sc}" id="${i + 1}"]`).join('\n')}\n\n`;
    writeFile(
      p.root,
      'nat1.tscn',
      `${head(['grad_node.gd'])}${grad}[node name="R" type="Node2D"]\n\n[node name="A" type="Node2D" parent="."]\n\n[node name="G" type="Node2D" parent="."]\nscript = ExtResource("1")\ngrad = SubResource("g")\n`,
    );
    writeFile(
      p.root,
      'nat2.tscn',
      `${head(['grad_res.gd'])}${grad}[sub_resource type="Resource" id="r"]\nscript = ExtResource("1")\ngrad = SubResource("g")\n\n[node name="R" type="Node2D"]\nmetadata/data = SubResource("r")\n\n[node name="A" type="Node2D" parent="."]\n`,
    );
    writeFile(
      p.root,
      'nat3.tscn',
      `${head(['grow.gd'])}[node name="R" type="Node2D"]\n\n[node name="A" type="Node2D" parent="."]\nscript = ExtResource("1")\nscale = Vector2(2, 2)\ngrow = 2.0\n`,
    );
    writeFile(
      p.root,
      'nat4.tscn',
      '[gd_scene format=3]\n\n[node name="R" type="Node2D"]\n\n[node name="A" type="Node2D" parent="."]\nposition = Vector2(1, 2)\n',
    );
    const cases: Array<[string, unknown[]]> = [
      ['nat1.tscn', [{ action: 'set_properties', node: 'A', properties: { position: { $type: 'Vector2', value: [1, 1] } } }]],
      ['nat2.tscn', [{ action: 'set_properties', node: 'A', properties: { position: { $type: 'Vector2', value: [1, 1] } } }]],
      ['nat3.tscn', [{ action: 'set_properties', node: 'A', properties: { position: { $type: 'Vector2', value: [5, 5] } } }]],
      ['nat4.tscn', [{ action: 'attach_script', node: 'A', script: 'mover.gd' }]],
    ];
    for (const [scenePath, actions] of cases) {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions });
      assert.equal(e.code, 'OPERATION_FAILED', `${scenePath}: ${JSON.stringify(e)}`);
      assert.equal(read(scenePath), before, scenePath);
    }
  });

  it('re-saves each file from disk, unaffected by what other files did to it in memory', async () => {
    writeFile(
      p.root,
      'touch_ext.gd',
      'extends Resource\n@export var target: Gradient:\n\tset(v):\n\t\ttarget = v\n\t\tif v:\n\t\t\tv.add_point(0.5, Color(1, 0, 0))\n',
    );
    writeFile(
      p.root,
      'zz_grad.tres',
      '[gd_resource type="Gradient" format=3]\n\n[resource]\noffsets = PackedFloat32Array(0.2, 0.8)\ncolors = PackedColorArray(0, 0, 1, 1, 0, 1, 0, 1)\n',
    );
    writeFile(
      p.root,
      'aa_toucher.tres',
      '[gd_resource type="Resource" format=3]\n\n[ext_resource type="Script" path="res://touch_ext.gd" id="1"]\n[ext_resource type="Gradient" path="res://zz_grad.tres" id="2"]\n\n[resource]\nscript = ExtResource("1")\ntarget = ExtResource("2")\n',
    );
    await h.ok('godot_uid', { projectPath: p.root, action: 'resave' });
    assert.match(read('zz_grad.tres'), /offsets = PackedFloat32Array\(0\.2, 0\.8\)/, read('zz_grad.tres'));
  });

  it('refuses saveAs onto a scene the edited scene uses, and onto an existing file without overwrite', async () => {
    writeFile(p.root, 'dep_sub.tscn', '[gd_scene format=3]\n\n[node name="Sub" type="Node2D"]\n\n[node name="Important" type="Node" parent="."]\n');
    writeFile(
      p.root,
      'dep_main.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://dep_sub.tscn" id="1"]\n\n[node name="M" type="Node2D"]\n\n[node name="S" parent="." instance=ExtResource("1")]\n',
    );
    const sub = read('dep_sub.tscn');
    const add = [{ action: 'add_node', type: 'Node', name: 'X' }];
    const e1 = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'dep_main.tscn', saveAs: 'dep_sub.tscn', overwrite: true, actions: add });
    assert.equal(e1.code, 'INVALID_ARGUMENT', JSON.stringify(e1));
    const e2 = await h.fail('save_scene', { projectPath: p.root, scenePath: 'dep_main.tscn', newPath: 'dep_sub.tscn' });
    assert.equal(e2.code, 'INVALID_ARGUMENT', JSON.stringify(e2));
    assert.equal(read('dep_sub.tscn'), sub);
    writeFile(p.root, 'other.tscn', '[gd_scene format=3]\n\n[node name="O" type="Node"]\n');
    const e3 = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'dep_main.tscn', saveAs: 'other.tscn', actions: add });
    assert.equal(e3.code, 'ALREADY_EXISTS', JSON.stringify(e3));
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'dep_main.tscn', saveAs: 'other.tscn', overwrite: true, actions: add });
  });

  it('refuses changes project code makes to groups, sibling order and connection flags', async () => {
    writeFile(
      p.root,
      'side.gd',
      'extends Node2D\n@export var mode := 0\nfunc _notification(what: int) -> void:\n\tif what == NOTIFICATION_PARENTED:\n\t\tif mode == 1:\n\t\t\tremove_from_group("enemies")\n\t\telif mode == 2 and get_index() > 0:\n\t\t\tget_parent().move_child(self, 0)\n\tif what == NOTIFICATION_SCENE_INSTANTIATED and mode == 3:\n\t\tvar b: Node = get_node("B")\n\t\tb.disconnect("renamed", Callable(self, "queue_redraw"))\n\t\tb.connect("renamed", Callable(self, "queue_redraw"), CONNECT_PERSIST | CONNECT_ONE_SHOT)\n',
    );
    const scene = (mode: number, extra = '') =>
      `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://side.gd" id="1"]\n\n[node name="R" type="Node2D"]\n${mode === 3 ? 'script = ExtResource("1")\nmode = 3\n' : ''}\n[node name="A" type="Node2D" parent="."]\n\n[node name="B" type="Node2D" parent="."${mode === 1 ? ' groups=["enemies"]' : ''}]\n${mode !== 3 ? `script = ExtResource("1")\nmode = ${mode}\n` : ''}${extra}`;
    writeFile(p.root, 'side_groups.tscn', scene(1));
    writeFile(p.root, 'side_order.tscn', scene(2));
    writeFile(p.root, 'side_conn.tscn', scene(3, '\n[connection signal="renamed" from="B" to="." method="queue_redraw"]\n'));
    for (const scenePath of ['side_groups.tscn', 'side_order.tscn', 'side_conn.tscn']) {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', {
        projectPath: p.root,
        scenePath,
        actions: [{ action: 'set_properties', node: 'A', properties: { visible: false } }],
      });
      assert.equal(e.code, 'OPERATION_FAILED', `${scenePath}: ${JSON.stringify(e)}`);
      assert.equal(read(scenePath), before, scenePath);
    }
  });

  it('keeps checking script values on nodes an authoring action edits, and the basis when only a 3D position is set', async () => {
    writeFile(p.root, 'tm_level.gd', 'extends TileMapLayer\n@export var level := 1:\n\tset(v):\n\t\tlevel = v * 2\n');
    writeFile(
      p.root,
      'tm.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://tm_level.gd" id="1"]\n\n[sub_resource type="TileSet" id="ts"]\n\n[node name="R" type="Node2D"]\n\n[node name="T" type="TileMapLayer" parent="."]\ntile_set = SubResource("ts")\nscript = ExtResource("1")\nlevel = 4\n',
    );
    const tm = read('tm.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'tm.tscn',
      actions: [{ action: 'tilemap_erase_cells', node: 'T', cells: [[0, 0]] }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.equal(read('tm.tscn'), tm);
    writeFile(
      p.root,
      'scaler3d.gd',
      'extends Node3D\nfunc _set(p: StringName, _v: Variant) -> bool:\n\tif p == &"position":\n\t\tscale = Vector3(3, 3, 3)\n\treturn false\n',
    );
    writeFile(
      p.root,
      'n3.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://scaler3d.gd" id="1"]\n\n[node name="R" type="Node3D"]\n\n[node name="N" type="Node3D" parent="."]\nscript = ExtResource("1")\n',
    );
    const n3 = read('n3.tscn');
    const e2 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'n3.tscn',
      actions: [{ action: 'set_properties', node: 'N', properties: { position: { $type: 'Vector3', value: [5, 5, 5] } } }],
    });
    assert.equal(e2.code, 'OPERATION_FAILED', JSON.stringify(e2));
    assert.equal(read('n3.tscn'), n3);
  });

  it('duplicates instanced scripted scenes and applies properties to new inherited scenes', async () => {
    writeFile(p.root, 'dup_enemy.gd', 'extends Node2D\n@export var hp := 1\n');
    writeFile(
      p.root,
      'dup_enemy.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://dup_enemy.gd" id="1"]\n\n[node name="Enemy" type="Node2D"]\nscript = ExtResource("1")\nhp = 20\n',
    );
    writeFile(
      p.root,
      'dup_lvl.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://dup_enemy.tscn" id="1"]\n\n[node name="L" type="Node2D"]\n\n[node name="E" parent="." instance=ExtResource("1")]\n',
    );
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'dup_lvl.tscn', actions: [{ action: 'duplicate_node', node: 'E', new_name: 'E2' }] });
    // Copied as an instance (like the editor does), not with the instance's values written inline.
    const dup = read('dup_lvl.tscn');
    assert.match(dup, /\[node name="E2"[^\]]*parent="\."[^\]]*instance=/);
    assert.doesNotMatch(dup, /\[node name="E2"[^\]]*type=/, dup);
    assert.doesNotMatch(dup, /script = /, dup);
    // ...so later headless edits of the scene still save.
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'dup_lvl.tscn',
      actions: [{ action: 'set_properties', node: 'E2', properties: { hp: 3 } }],
    });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'dup_kid.tscn', inherits: 'dup_enemy.tscn', properties: { hp: 35 } });
    assert.match(read('dup_kid.tscn'), /hp = 35/);
  });

  it('follows connections by both ends, inherited-scene sibling order, quoted group names, and only lays out moved Controls', async () => {
    const refused = async (scenePath: string, actions: unknown[], why: RegExp) => {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions });
      assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
      assert.match(e.message, why);
      assert.equal(read(scenePath), before);
    };
    writeFile(
      p.root,
      'tw.gd',
      'extends Node2D\n@export var mode := 0\nfunc _on_t() -> void:\n\tpass\nfunc _notification(what: int) -> void:\n\tif what != NOTIFICATION_SCENE_INSTANTIATED:\n\t\treturn\n\tif mode == 1:\n\t\t$T2.timeout.disconnect(_on_t)\n\tif mode == 2:\n\t\tmove_child($X, -1)\n\tif mode == 3:\n\t\t$T1.remove_from_group("keep")\n',
    );
    const timers = (mode: number) =>
      `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://tw.gd" id="1"]\n\n[node name="R" type="Node2D"]\nscript = ExtResource("1")\nmode = ${mode}\n\n[node name="T1" type="Timer" parent="."${mode === 3 ? ' groups=["a]b", "keep"]' : ''}]\n\n[node name="T2" type="Timer" parent="."]\n\n[connection signal="timeout" from="T1" to="." method="_on_t"]\n[connection signal="timeout" from="T2" to="." method="_on_t"]\n`;
    const disconnectT1 = [{ action: 'disconnect_signal', from: 'T1', signal: 'timeout', to: '.', method: '_on_t' }];
    // Disconnecting one of two connections to the same method is fine...
    writeFile(p.root, 'tw_plain.tscn', timers(0));
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'tw_plain.tscn', actions: disconnectT1 });
    assert.doesNotMatch(read('tw_plain.tscn'), /from="T1"/);
    assert.match(read('tw_plain.tscn'), /from="T2"/);
    // ...but it does not explain project code dropping the other one.
    writeFile(p.root, 'tw_code.tscn', timers(1));
    await refused('tw_code.tscn', disconnectT1, /connection timeout\|T2\|\.\|_on_t.* would be dropped/);
    // A group name containing "]" does not hide a dropped group.
    writeFile(p.root, 'tw_groups.tscn', timers(3));
    await refused('tw_groups.tscn', [{ action: 'set_properties', node: 'T2', properties: { wait_time: 2 } }], /T1: its groups would change/);
    // Sibling order of a node added to an inherited scene (index="0").
    writeFile(
      p.root,
      'tw_base.tscn',
      '[gd_scene format=3]\n\n[node name="B" type="Node2D"]\n\n[node name="A" type="Node2D" parent="."]\n\n[node name="C" type="Node2D" parent="."]\n',
    );
    writeFile(
      p.root,
      'tw_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://tw_base.tscn" id="1"]\n[ext_resource type="Script" path="res://tw.gd" id="2"]\n\n[node name="K" instance=ExtResource("1")]\nscript = ExtResource("2")\nmode = 2\n\n[node name="X" type="Node2D" parent="." index="0"]\n',
    );
    await refused('tw_kid.tscn', [{ action: 'set_properties', node: 'A', properties: { position: [1, 1] } }], /children of \. would change order/);
    // Moving a Node2D does not excuse a setter that shifts its position.
    writeFile(p.root, 'shift.gd', 'extends Node2D\n@export var shift := 5.0:\n\tset(v):\n\t\tshift = v\n\t\tposition.x += v\n');
    writeFile(
      p.root,
      'shift.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://shift.gd" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="Holder" type="Node2D" parent="."]\n\n[node name="N" type="Node2D" parent="."]\nposition = Vector2(100, 200)\nscript = ExtResource("1")\nshift = 5.0\n',
    );
    await refused('shift.tscn', [{ action: 'move_node', node: 'N', new_parent: 'Holder' }], /'position' would change/);
  });

  it('copies 3D transforms and children with duplicate_node, and compares groups by name', async () => {
    writeFile(p.root, 'guard.gd', 'extends Node3D\n@export var hp := 1\n');
    writeFile(
      p.root,
      'room.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://guard.gd" id="1"]\n\n[node name="R" type="Node3D"]\n\n[node name="Room" type="StaticBody3D" parent="."]\ntransform = Transform3D(0.866, 0, 0.5, 0, 1, 0, -0.5, 0, 0.866, -3, 0.5, 2)\n\n[node name="Guard" type="Node3D" parent="Room"]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)\nscript = ExtResource("1")\nhp = 4\n',
    );
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'room.tscn', actions: [{ action: 'duplicate_node', node: 'Room', new_name: 'Room2' }] });
    const room = read('room.tscn');
    const section = (name: string) =>
      room
        .slice(room.indexOf(`[node name="${name}"`))
        .split('\n\n')[0]!
        .replace(/^\[.*\n/, '');
    assert.equal(section('Room2'), section('Room'), room);
    assert.equal(room.match(/hp = 4/g)?.length, 2, room);
    assert.equal(room.match(/0, 1, 0, 0, 0, 1, 0, 1, 0\)/g)?.length, 2, room);
    // An action on one group does not explain project code removing another.
    writeFile(p.root, 'grp.gd', 'extends Node\nfunc _notification(what: int) -> void:\n\tif what == NOTIFICATION_PARENTED:\n\t\tremove_from_group("keep")\n');
    writeFile(
      p.root,
      'grp.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://grp.gd" id="1"]\n\n[node name="R" type="Node"]\n\n[node name="N" type="Node" parent="." groups=["a,b", "keep"]]\nscript = ExtResource("1")\n',
    );
    const grp = read('grp.tscn');
    const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'grp.tscn', actions: [{ action: 'add_to_group', node: 'N', group: 'new' }] });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.match(e.message, /N: its groups would change/);
    assert.equal(read('grp.tscn'), grp);
  });

  it('accepts inherited scenes whose own nodes have no index, and refuses copies of inherited nodes', async () => {
    writeFile(
      p.root,
      'ix_base.tscn',
      '[gd_scene format=3]\n\n[node name="B" type="Node2D"]\n\n[node name="A" type="Node2D" parent="."]\nposition = Vector2(3, 4)\n\n[node name="C" type="Node2D" parent="."]\n',
    );
    writeFile(
      p.root,
      'ix_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://ix_base.tscn" id="1"]\n\n[node name="K" instance=ExtResource("1")]\n\n[node name="X" type="Node2D" parent="."]\n\n[node name="Y" type="Node2D" parent="." index="0"]\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'ix_kid.tscn',
      actions: [{ action: 'set_properties', node: 'C', properties: { visible: false } }],
    });
    // The file stores only overrides of a node its base scene defines, so a
    // copy of one cannot be checked headlessly.
    const kid = read('ix_kid.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'ix_kid.tscn',
      actions: [{ action: 'duplicate_node', node: 'A', new_name: 'A2' }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.match(e.message, /A comes from an inherited or instanced scene.*use godot_editor/);
    assert.equal(read('ix_kid.tscn'), kid);
    // A node the inherited scene adds itself can be copied.
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'ix_kid.tscn', actions: [{ action: 'duplicate_node', node: 'X', new_name: 'X2' }] });
    assert.match(read('ix_kid.tscn'), /\[node name="X2" type="Node2D" parent="\."/);
  });

  it('refuses saveAs onto a scene the batch made the edited scene use', async () => {
    writeFile(p.root, 'cyc_t.tscn', '[gd_scene format=3]\n\n[node name="T" type="Node2D"]\n\n[node name="Keep" type="Node" parent="."]\n');
    writeFile(p.root, 'cyc_s.tscn', '[gd_scene format=3]\n\n[node name="S" type="Node2D"]\n');
    writeFile(p.root, 'cyc_next.gd', 'extends Node2D\n@export var next_scene: PackedScene\n');
    writeFile(
      p.root,
      'cyc_n.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://cyc_next.gd" id="1"]\n\n[node name="S" type="Node2D"]\nscript = ExtResource("1")\n',
    );
    const t = read('cyc_t.tscn');
    const e1 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'cyc_s.tscn',
      saveAs: 'cyc_t.tscn',
      overwrite: true,
      actions: [{ action: 'instantiate_scene', parent: '.', scene: 'cyc_t.tscn' }],
    });
    assert.equal(e1.code, 'INVALID_ARGUMENT', JSON.stringify(e1));
    const e2 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'cyc_n.tscn',
      saveAs: 'cyc_t.tscn',
      overwrite: true,
      actions: [{ action: 'set_properties', node: '.', properties: { next_scene: 'res://cyc_t.tscn' } }],
    });
    assert.equal(e2.code, 'INVALID_ARGUMENT', JSON.stringify(e2));
    assert.equal(read('cyc_t.tscn'), t);
  });

  it('never runs nodes or callbacks that project code adds to the tree during an edit', async () => {
    writeFile(
      p.root,
      'sneaky.gd',
      'extends Node\nclass M extends Node:\n\tfunc _ready():\n\t\tFileAccess.open("res://TREE_RAN.txt", FileAccess.WRITE).store_string("ran")\nfunc _init():\n\tvar ml = Engine.get_main_loop()\n\tif ml is SceneTree:\n\t\tml.root.add_child.call_deferred(M.new())\n\t\tml.root.add_child(M.new())\n\t\tml.process_frame.connect(func(): FileAccess.open("res://FRAME_RAN.txt", FileAccess.WRITE).store_string("ran"))\n',
    );
    writeFile(
      p.root,
      'sneaky.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://sneaky.gd" id="1"]\n\n[node name="S" type="Node"]\nscript = ExtResource("1")\n',
    );
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'sneaky.tscn', actions: [{ action: 'add_node', type: 'Node', name: 'X' }] });
    assert.equal(existsSync(join(p.root, 'TREE_RAN.txt')), false);
    assert.equal(existsSync(join(p.root, 'FRAME_RAN.txt')), false);
  });

  it('scopes reorder exemptions to the placed node, follows renamed copies, and keeps Container-hidden values', async () => {
    const refused = async (scenePath: string, actions: unknown[], why: RegExp) => {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions });
      assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
      assert.match(e.message, why);
      assert.equal(read(scenePath), before);
    };
    // Project code moving Z is not excused by a move elsewhere in the scene.
    writeFile(
      p.root,
      'zfirst.gd',
      'extends Node2D\nfunc _notification(what: int) -> void:\n\tif what == NOTIFICATION_SCENE_INSTANTIATED:\n\t\tmove_child($Z, 0)\n',
    );
    writeFile(
      p.root,
      'zfirst.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://zfirst.gd" id="1"]\n\n[node name="R" type="Node2D"]\nscript = ExtResource("1")\n\n[node name="P" type="Node2D" parent="."]\n\n[node name="A" type="Node2D" parent="P"]\n\n[node name="A2" type="Node2D" parent="P"]\n\n[node name="Q" type="Node2D" parent="."]\n\n[node name="Q2" type="Node2D" parent="Q"]\n\n[node name="Z" type="Node2D" parent="."]\n',
    );
    await refused('zfirst.tscn', [{ action: 'move_node', node: 'P/A', new_parent: 'Q' }], /node \S+ would move among its siblings/);
    await refused('zfirst.tscn', [{ action: 'reorder_node', node: 'P/A2', index: 0 }], /node \S+ would move among its siblings/);
    // Without such code, the placed node may go anywhere.
    writeFile(
      p.root,
      'plain_order.tscn',
      '[gd_scene format=3]\n\n[node name="R" type="Node2D"]\n\n[node name="P" type="Node2D" parent="."]\n\n[node name="A" type="Node2D" parent="P"]\n\n[node name="A2" type="Node2D" parent="P"]\n\n[node name="Q" type="Node2D" parent="."]\n\n[node name="Q2" type="Node2D" parent="Q"]\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'plain_order.tscn',
      actions: [
        { action: 'reorder_node', node: 'P/A2', index: 0 },
        { action: 'move_node', node: 'P/A', new_parent: 'Q', index: 0 },
      ],
    });
    const order = read('plain_order.tscn');
    assert.ok(order.indexOf('name="A2"') < order.indexOf('name="Q"'));
    assert.ok(order.indexOf('name="A" ') < order.indexOf('name="Q2"'));
    // A copy whose child is renamed in the same batch is compared with its source.
    writeFile(p.root, 'hp.gd', 'extends Node2D\n@export var hp := 1\n');
    writeFile(
      p.root,
      'rooms.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://hp.gd" id="1"]\n\n[node name="Root" type="Node2D"]\n\n[node name="Room" type="Node2D" parent="."]\n\n[node name="G" type="Node2D" parent="Room"]\nscript = ExtResource("1")\nhp = 4\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'rooms.tscn',
      actions: [
        { action: 'duplicate_node', node: 'Room', new_name: 'Room2' },
        { action: 'rename_node', node: 'Room2/G', new_name: 'H' },
      ],
    });
    assert.match(read('rooms.tscn'), /\[node name="H" type="Node2D" parent="Room2"[^\n]*\]\nscript = ExtResource\("1"\)\nhp = 4\n/);
    // A Container does not store a child's rotation: copying one there is refused.
    writeFile(
      p.root,
      'rot.tscn',
      '[gd_scene format=3]\n\n[node name="UI" type="Control"]\n\n[node name="C" type="Control" parent="."]\nlayout_mode = 0\noffset_right = 40.0\noffset_bottom = 40.0\nrotation = 0.3\n\n[node name="VB" type="VBoxContainer" parent="."]\nlayout_mode = 0\n',
    );
    await refused('rot.tscn', [{ action: 'duplicate_node', node: 'C', parent: 'VB', new_name: 'Cc' }], /duplicate VB\/Cc: 'rotation' differs from C/);
    // Group names with quotes and backslashes can be added and removed.
    writeFile(
      p.root,
      'qgroups.tscn',
      '[gd_scene format=3]\n\n[node name="R" type="Node"]\n\n[node name="N" type="Node" parent="." groups=["x\\"y]", "c\\\\d"]]\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'qgroups.tscn',
      actions: [
        { action: 'remove_from_group', node: 'N', group: 'c\\d' },
        { action: 'add_to_group', node: 'N', group: 'q"q' },
      ],
    });
    assert.match(read('qgroups.tscn'), /groups=\["q\\"q", "x\\"y\]"\]/);
  });
  it('holds copies to their source: no later change to the source, no code-made groups, children or connections', async () => {
    const refused = async (scenePath: string, actions: unknown[], why: RegExp) => {
      const before = read(scenePath);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath, actions });
      assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
      assert.match(e.message, why);
      assert.equal(read(scenePath), before);
    };
    // Project code acting only on copies (every node after the first one parented).
    const copyCode = (name: string, body: string) =>
      writeFile(
        p.root,
        `${name}.gd`,
        `extends Node2D\nsignal hit\nstatic var seen := 0\nfunc _notification(w):\n\tif w == NOTIFICATION_PARENTED:\n\t\tseen += 1\n\t\tif seen > 1:\n${body}\n`,
      );
    const room = (name: string) =>
      writeFile(
        p.root,
        `${name}.tscn`,
        `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://${name}.gd" id="1"]\n\n[node name="Root" type="Node2D"]\n\n[node name="Room" type="Node2D" parent="."]\n\n[node name="G" type="Node2D" parent="Room"]\nposition = Vector2(3, 4)\nscript = ExtResource("1")\n`,
      );
    const dupG = [{ action: 'duplicate_node', node: 'Room/G', new_name: 'G2' }];
    copyCode('cp_z', '\t\t\tz_index = 5');
    room('cp_z');
    await refused('cp_z.tscn', dupG, /duplicate Room\/G2: 'z_index' differs from Room\/G/);
    // Removing or changing the source later in the batch would leave nothing to compare with.
    await refused('cp_z.tscn', [...dupG, { action: 'remove_node', node: 'Room/G' }], /source was removed later in the same batch/);
    await refused(
      'cp_z.tscn',
      [...dupG, { action: 'set_properties', node: 'Room/G', properties: { z_index: 1 } }],
      /source was changed later in the same batch/,
    );
    copyCode('cp_group', '\t\t\tadd_to_group("spawned", true)');
    room('cp_group');
    await refused('cp_group.tscn', dupG, /duplicate Room\/G2: its groups differ from Room\/G/);
    copyCode('cp_conn', '\t\t\thit.connect(get_parent().queue_free, CONNECT_PERSIST)');
    room('cp_conn');
    await refused('cp_conn.tscn', dupG, /connection hit\|Room\/G2\|Room\|queue_free.* would be added/);
    copyCode('cp_child', '\t\t\tvar n := Node2D.new()\n\t\t\tn.name = "Extra"\n\t\t\tadd_child(n)\n\t\t\tn.owner = get_parent().owner');
    room('cp_child');
    await refused('cp_child.tscn', dupG, /duplicate Room\/G2\/Extra: its source Room\/G\/Extra is not saved/);
    // A removed node's exemptions do not pass to the node renamed into its place.
    writeFile(p.root, 'zmove.gd', 'extends Node2D\nfunc _notification(w):\n\tif w == NOTIFICATION_SCENE_INSTANTIATED:\n\t\t$Z.position = Vector2(9, 9)\n');
    writeFile(
      p.root,
      'zmove.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://zmove.gd" id="1"]\n\n[node name="R" type="Node2D"]\nscript = ExtResource("1")\n\n[node name="Z" type="Node2D" parent="."]\nposition = Vector2(1, 1)\n\n[node name="W" type="Node2D" parent="."]\n',
    );
    await refused(
      'zmove.tscn',
      [
        { action: 'set_properties', node: 'W', properties: { position: [5, 5] } },
        { action: 'remove_node', node: 'W' },
        { action: 'rename_node', node: 'Z', new_name: 'W' },
      ],
      /node W: 'position' would change/,
    );
    // Nor may a copy lose what its source has: children, their order, connections.
    const roomKids = (name: string) =>
      writeFile(
        p.root,
        `${name}.tscn`,
        `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://${name}.gd" id="1"]\n\n[node name="Root" type="Node2D"]\n\n[node name="Room" type="Node2D" parent="."]\nscript = ExtResource("1")\n\n[node name="A" type="Node2D" parent="Room"]\n\n[node name="B" type="Button" parent="Room"]\n\n[connection signal="pressed" from="Room/B" to="Room" method="_on"]\n`,
      );
    const kidsCode = (name: string, body: string) =>
      writeFile(
        p.root,
        `${name}.gd`,
        `extends Node2D\nstatic var seen := 0\nfunc _on() -> void:\n\tpass\nfunc _notification(w):\n\tif w == NOTIFICATION_PARENTED:\n\t\tseen += 1\n\t\tif seen > 1:\n${body}\n`,
      );
    const dupRoom = [{ action: 'duplicate_node', node: 'Room', new_name: 'Room2' }];
    kidsCode('kid_free', '\t\t\tremove_child($A)');
    roomKids('kid_free');
    await refused('kid_free.tscn', dupRoom, /Room2\/A \(a copy of Room\/A\) would be dropped/);
    kidsCode('kid_order', '\t\t\tmove_child($B, 0)');
    roomKids('kid_order');
    await refused('kid_order.tscn', dupRoom, /Room2\/\S+ would move among its siblings/);
    kidsCode('kid_conn', '\t\t\t$B.pressed.disconnect(_on)');
    roomKids('kid_conn');
    await refused('kid_conn.tscn', dupRoom, /connection pressed\|Room2\/B\|Room2\|_on.* would be dropped/);
    // Moving the source while keeping its global transform changes it: refused.
    copyCode('cp_move', '\t\t\tposition = Vector2(99, 99)');
    room('cp_move');
    await refused(
      'cp_move.tscn',
      [...dupG, { action: 'move_node', node: 'Room/G', new_parent: '.', keep_global_transform: true }],
      /source was changed later in the same batch/,
    );
    // A node an inherited scene defines cannot be copied headlessly.
    writeFile(p.root, 'grp_base.tscn', '[gd_scene format=3]\n\n[node name="R" type="Node2D"]\n\n[node name="Base" type="Node2D" parent="." groups=["g"]]\n');
    // (The script is attached after the source is parented, so only the copy sees NOTIFICATION_PARENTED.)
    writeFile(p.root, 'grp_code.gd', 'extends Node2D\nfunc _notification(w):\n\tif w == NOTIFICATION_PARENTED:\n\t\tremove_from_group("g")\n');
    writeFile(
      p.root,
      'grp_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://grp_base.tscn" id="1"]\n[ext_resource type="Script" path="res://grp_code.gd" id="2"]\n\n[node name="K" instance=ExtResource("1")]\n\n[node name="Base" parent="."]\nscript = ExtResource("2")\n',
    );
    await refused('grp_kid.tscn', [{ action: 'duplicate_node', node: 'Base', new_name: 'Base2' }], /Base comes from an inherited or instanced scene/);
    // Without such code: copies of copies, moved and re-scripted copies save.
    writeFile(p.root, 'plain.gd', 'extends Node2D\n@export var hp := 1\n');
    writeFile(
      p.root,
      'cp_plain.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://plain.gd" id="1"]\n\n[node name="Root" type="Node2D"]\n\n[node name="Room" type="Node2D" parent="." groups=["rooms"]]\n\n[node name="G" type="Node2D" parent="Room"]\nscript = ExtResource("1")\nhp = 4\n\n[node name="Other" type="Node2D" parent="."]\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'cp_plain.tscn',
      actions: [
        { action: 'duplicate_node', node: 'Room', new_name: 'Room2' },
        { action: 'duplicate_node', node: 'Room2', new_name: 'Room3' },
        { action: 'move_node', node: 'Room3', new_parent: 'Other' },
        { action: 'detach_script', node: 'Other/Room3/G' },
      ],
    });
    const plain = read('cp_plain.tscn');
    assert.match(plain, /\[node name="Room3" type="Node2D" parent="Other"[^\n]* groups=\["rooms"\]\]/);
    assert.match(plain, /\[node name="G" type="Node2D" parent="Room2"[^\n]*\]\nscript = ExtResource\("1"\)\nhp = 4\n/);
    assert.doesNotMatch(plain, /parent="Other\/Room3"[^\n]*\]\nscript/);
  });
  it('holds override sections that a save gains to what the actions set', async () => {
    // A non-tool setter in the base scene recolours a child while the variant loads.
    writeFile(
      p.root,
      'team.gd',
      'extends Node2D\n@export var team := 0:\n\tset(v):\n\t\tteam = v\n\t\tif is_node_ready() or has_node("Body"):\n\t\t\t$Body.modulate = Color.RED if v == 1 else Color.WHITE\n',
    );
    writeFile(
      p.root,
      'team_base.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://team.gd" id="1"]\n\n[node name="Unit" type="Node2D"]\nscript = ExtResource("1")\n\n[node name="Body" type="Sprite2D" parent="."]\n',
    );
    writeFile(
      p.root,
      'team_red.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://team_base.tscn" id="1"]\n\n[node name="Unit" instance=ExtResource("1")]\nteam = 1\n',
    );
    const before = read('team_red.tscn');
    const e = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'team_red.tscn',
      actions: [{ action: 'set_properties', node: '.', properties: { position: [4, 4] } }],
    });
    assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
    assert.match(e.message, /node Body: 'modulate' would be added/);
    assert.equal(read('team_red.tscn'), before);
    // Setting a value on a node of the base scene is what the action asked for.
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'team_red.tscn',
      actions: [{ action: 'set_properties', node: 'Body', properties: { modulate: '#ff0000', visible: false } }],
    });
    assert.match(read('team_red.tscn'), /\[node name="Body" parent="\."[^\n]*\]\n(?:[^\n]+\n)*visible = false/);
    // Moving a rotated base-scene node stores its whole transform (the base
    // scene's rotation with the new origin).
    writeFile(
      p.root,
      'arena_base.tscn',
      '[gd_scene format=3]\n\n[node name="Arena" type="Node3D"]\n\n[node name="Crate" type="Node3D" parent="."]\ntransform = Transform3D(0.866025, 0, 0.5, 0, 1, 0, -0.5, 0, 0.866025, 2, 0, 2)\n',
    );
    writeFile(
      p.root,
      'arena_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://arena_base.tscn" id="1"]\n\n[node name="Arena" instance=ExtResource("1")]\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'arena_kid.tscn',
      actions: [{ action: 'set_properties', node: 'Crate', properties: { position: [0, 0.5, 0] } }],
    });
    assert.match(
      read('arena_kid.tscn'),
      /\[node name="Crate" parent="\."[^\n]*\]\ntransform = Transform3D\(0\.866025, 0, 0\.5, 0, 1, 0, -0\.5, 0, 0\.866025, 0, 0\.5, 0\)/,
    );
    // A renamed instance is not compared with the original that had its name.
    writeFile(
      p.root,
      'sh_enemy.tscn',
      '[gd_scene format=3]\n\n[node name="Enemy" type="Node2D"]\n\n[node name="K" type="Node2D" parent="."]\nposition = Vector2(1, 1)\n',
    );
    writeFile(p.root, 'sh_code.gd', 'extends Node2D\nfunc _notification(w):\n\tif w == NOTIFICATION_SCENE_INSTANTIATED:\n\t\t$E2/K.position = Vector2(7, 7)\n');
    writeFile(
      p.root,
      'sh_level.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://sh_enemy.tscn" id="1"]\n[ext_resource type="Script" path="res://sh_code.gd" id="2"]\n\n[node name="L" type="Node2D"]\nscript = ExtResource("2")\n\n[node name="E1" parent="." instance=ExtResource("1")]\n\n[node name="K" parent="E1" index="0"]\nposition = Vector2(7, 7)\n\n[node name="E2" parent="." instance=ExtResource("1")]\n\n[editable path="E1"]\n[editable path="E2"]\n',
    );
    const lvl = read('sh_level.tscn');
    const e2 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'sh_level.tscn',
      actions: [
        { action: 'remove_node', node: 'E1' },
        { action: 'rename_node', node: 'E2', new_name: 'E1' },
      ],
    });
    assert.equal(e2.code, 'OPERATION_FAILED', JSON.stringify(e2));
    assert.match(e2.message, /node E1\/K: 'position' would be added/);
    assert.equal(read('sh_level.tscn'), lvl);
    // Asking for editable children an instance already has explains nothing.
    const e3 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'sh_level.tscn',
      actions: [
        { action: 'set_editable_children', node: 'E2', editable: true },
        { action: 'set_properties', node: 'E1/K', properties: { visible: false } },
      ],
    });
    assert.equal(e3.code, 'OPERATION_FAILED', JSON.stringify(e3));
    assert.match(e3.message, /node E2\/K: 'position' would be added/);
    // A material local to the scene is copied into a new inherited scene by Godot itself.
    writeFile(
      p.root,
      'lts_base.tscn',
      '[gd_scene format=3]\n\n[sub_resource type="CanvasItemMaterial" id="m1"]\nresource_local_to_scene = true\nblend_mode = 1\n\n[node name="B" type="Node2D"]\n\n[node name="S" type="Sprite2D" parent="."]\nmaterial = SubResource("m1")\n',
    );
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'lts_kid.tscn', inherits: 'lts_base.tscn' });
    // ...but not when project code changed something nested in it (shared with the base's copy).
    writeFile(
      p.root,
      'lts_code.gd',
      'extends Node2D\nfunc _notification(w):\n\tif w == NOTIFICATION_SCENE_INSTANTIATED:\n\t\t$S.material.shader.code = "shader_type canvas_item;\\nvoid fragment() { COLOR = vec4(1.0); }"\n',
    );
    writeFile(
      p.root,
      'lts_sh_base.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://lts_code.gd" id="1"]\n\n[sub_resource type="Shader" id="sh"]\ncode = "shader_type canvas_item;\n"\n\n[sub_resource type="ShaderMaterial" id="m1"]\nresource_local_to_scene = true\nshader = SubResource("sh")\n\n[node name="B" type="Node2D"]\nscript = ExtResource("1")\n\n[node name="S" type="Sprite2D" parent="."]\nmaterial = SubResource("m1")\n',
    );
    writeFile(
      p.root,
      'lts_sh_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://lts_sh_base.tscn" id="1"]\n\n[node name="K" instance=ExtResource("1")]\n',
    );
    await refusedOrNotStored('lts_sh_kid.tscn', 'X', /node S: 'material' would be added/);
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'lts_kid.tscn',
      actions: [{ action: 'set_properties', node: 'S', properties: { visible: false } }],
    });
  });

  it('compares string contents exactly, refuses script-backed local copies, keeps which nodes share one, and reads editable lines of instanced variants', async () => {
    const ctl = (body: string) => `extends Node\nfunc _notification(w):\n\tif w == NOTIFICATION_PARENTED:\n\t\t${body}\n`;
    const add = [{ action: 'add_node', type: 'Node', name: 'Extra' }];
    const refuses = async (scene: string, msg: RegExp, actions: unknown[] = add) => {
      const before = read(scene);
      const e = await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: scene, actions });
      assert.equal(e.code, 'OPERATION_FAILED', JSON.stringify(e));
      assert.match(e.message, msg);
      assert.equal(read(scene), before);
    };
    // A string ending in "&" is not the same as one without it.
    writeFile(p.root, 'amp_code.gd', ctl('get_parent().get_node("L").text = "Tom"'));
    writeFile(
      p.root,
      'amp.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://amp_code.gd" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="L" type="Label" parent="."]\ntext = "Tom&"\nmetadata/key = &"k"\n\n[node name="Ctl" type="Node" parent="."]\nscript = ExtResource("1")\n',
    );
    await refuses('amp.tscn', /node L: 'text' would change/);
    // Local copies in a variant: a script-backed one is refused; which nodes
    // share a copy must stay as the base scene has it.
    const variant = (base: string, code: string) =>
      `[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://${base}" id="1"]\n[ext_resource type="Script" path="res://${code}" id="2"]\n\n[node name="V" instance=ExtResource("1")]\n\n[node name="Ctl" type="Node" parent="."]\nscript = ExtResource("2")\n`;
    writeFile(p.root, 'lsc_mat.gd', 'extends CanvasItemMaterial\n@export_storage var x = 5\n');
    writeFile(p.root, 'lsc_code.gd', ctl('get_parent().get_node("S1").material.x = 5'));
    writeFile(
      p.root,
      'lsc_base.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://lsc_mat.gd" id="1"]\n\n[sub_resource type="CanvasItemMaterial" id="m"]\nresource_local_to_scene = true\nscript = ExtResource("1")\nx = null\n\n[node name="E" type="Node2D"]\n\n[node name="S1" type="Sprite2D" parent="."]\nmaterial = SubResource("m")\n',
    );
    writeFile(p.root, 'lsc_v.tscn', variant('lsc_base.tscn', 'lsc_code.gd'));
    await refusedOrNotStored('lsc_v.tscn', 'Extra', /node S1: 'material' would be added/);
    const shared = (two: boolean) =>
      `[gd_scene format=3]\n\n[sub_resource type="CanvasItemMaterial" id="m1"]\nresource_local_to_scene = true\nblend_mode = 1\n\n${two ? '[sub_resource type="CanvasItemMaterial" id="m2"]\nresource_local_to_scene = true\nblend_mode = 1\n\n' : ''}[node name="E" type="Node2D"]\n\n[node name="S1" type="Sprite2D" parent="."]\nmaterial = SubResource("m1")\n\n[node name="S2" type="Sprite2D" parent="."]\nmaterial = SubResource("${two ? 'm2' : 'm1'}")\n`;
    writeFile(p.root, 'lsh_one.tscn', shared(false));
    writeFile(p.root, 'lsh_two.tscn', shared(true));
    writeFile(p.root, 'lsh_pass.gd', ctl('pass'));
    writeFile(p.root, 'lsh_split.gd', ctl('var s2 = get_parent().get_node("S2"); s2.material = s2.material.duplicate()'));
    writeFile(p.root, 'lsh_join.gd', ctl('get_parent().get_node("S2").material = get_parent().get_node("S1").material'));
    for (const [name, base, code] of [
      ['lsh_one_ok.tscn', 'lsh_one.tscn', 'lsh_pass.gd'],
      ['lsh_two_ok.tscn', 'lsh_two.tscn', 'lsh_pass.gd'],
      ['lsh_split.tscn', 'lsh_one.tscn', 'lsh_split.gd'],
      ['lsh_join.tscn', 'lsh_two.tscn', 'lsh_join.gd'],
    ] as const) {
      writeFile(p.root, name, variant(base, code));
    }
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'lsh_one_ok.tscn', actions: add });
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'lsh_two_ok.tscn', actions: add });
    // Up to Godot 4.7 a save gives the variant copies of the base's resources
    // and the copies must be shared as the originals are; from 4.8 the save
    // gives it none, so a copy it gains is one project code assigned.
    const unshared = /node S2: 'material' would (?:change which values share a resource|be added)/;
    await refuses('lsh_split.tscn', unshared);
    await refuses('lsh_join.tscn', unshared);
    const copies = read('lsh_one_ok.tscn').match(/\[sub_resource /g)?.length ?? 0;
    const setBlend = {
      projectPath: p.root,
      scenePath: 'lsh_one_ok.tscn',
      actions: [{ action: 'set_properties', node: 'S1', properties: { 'material:blend_mode': 2 } }],
    };
    if (copies === 1) {
      // The saved variant now stores the shared copy itself: setting a value in
      // it changes it for both nodes.
      await h.ok('godot_scene_edit', setBlend);
      assert.equal(read('lsh_one_ok.tscn').match(/\[sub_resource /g)?.length, 1);
    } else {
      // The variant stores no copy, so a sub-path into the base's resource is refused.
      assert.equal(copies, 0, read('lsh_one_ok.tscn'));
      assert.equal((await h.fail('godot_scene_edit', setBlend)).code, 'CONFLICT');
    }
    // Project code may not split the copy either way.
    writeFile(p.root, 'lsh_pass.gd', ctl('var s2 = get_parent().get_node("S2"); s2.material = s2.material.duplicate()'));
    await refuses('lsh_one_ok.tscn', unshared, [{ action: 'add_node', type: 'Node', name: 'Extra2' }]);
    // Copies of one resource for two instances: Godot versions share them differently.
    writeFile(
      p.root,
      'lsh_level.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://lsh_one.tscn" id="1"]\n\n[node name="L" type="Node2D"]\n\n[node name="A" parent="." instance=ExtResource("1")]\n\n[node name="B" parent="." instance=ExtResource("1")]\n\n[editable path="A"]\n[editable path="B"]\n',
    );
    await refusedOrNotStored('lsh_level.tscn', 'Extra', /is also copied for another scene in this file/);
    // Setting a key of a sub-resource does not let project code replace or
    // unshare that sub-resource (here a setter that makes the material unique).
    writeFile(
      p.root,
      'uniq.gd',
      'extends Sprite2D\n@export var tint := Color.WHITE:\n\tset(v):\n\t\ttint = v\n\t\tif material:\n\t\t\tmaterial = material.duplicate()\n',
    );
    writeFile(
      p.root,
      'uniq.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://uniq.gd" id="1"]\n\n[sub_resource type="CanvasItemMaterial" id="m"]\nblend_mode = 1\nlight_mode = 2\n\n[node name="R" type="Node2D"]\n\n[node name="A" type="Sprite2D" parent="."]\nmaterial = SubResource("m")\nscript = ExtResource("1")\ntint = Color(1, 0, 0, 1)\n\n[node name="C" type="Sprite2D" parent="."]\nmaterial = SubResource("m")\n',
    );
    await refuses('uniq.tscn', /node C: 'material' would change which values share a resource/, [
      { action: 'set_properties', node: 'A', properties: { 'material:blend_mode': 2 } },
    ]);
    // A batch that removes a node skips only the node paths in a value.
    writeFile(p.root, 'np_holder.gd', 'extends Node\n@export var data: Dictionary = {}\n');
    writeFile(p.root, 'np_code.gd', ctl('get_parent().get_node("H").data["hp"] = 0'));
    writeFile(
      p.root,
      'np.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://np_holder.gd" id="1"]\n[ext_resource type="Script" path="res://np_code.gd" id="2"]\n\n[node name="R" type="Node2D"]\n\n[node name="H" type="Node" parent="."]\nscript = ExtResource("1")\ndata = {\n"hp": 10,\n"target": NodePath("../T")\n}\n\n[node name="T" type="Node2D" parent="."]\n\n[node name="Tmp" type="Node" parent="."]\n\n[node name="Ctl" type="Node" parent="."]\nscript = ExtResource("2")\n',
    );
    await refuses('np.tscn', /H: property 'data'/, [{ action: 'remove_node', node: 'Tmp' }]);
    for (const [name, code] of [
      ['np_clear.gd', 'get_parent().get_node("H").data = {}'],
      ['np_str.gd', 'get_parent().get_node("H").data["k^"] = 0'],
    ] as const) {
      writeFile(p.root, name, ctl(code));
      writeFile(p.root, 'np2.tscn', read('np.tscn').replace('"hp": 10,', '"k^": 10,').replace('np_code.gd', name));
      await refuses('np2.tscn', /H: (?:property )?'data'/, [{ action: 'rename_node', node: 'Tmp', new_name: 'Tmp2' }]);
    }
    // A path may follow its node's rename, or empty when its node is removed;
    // project code may not point it elsewhere or clear it.
    writeFile(p.root, 'tg_holder.gd', 'extends Node\n@export var target: Node\n');
    const tg = (code: string) =>
      `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://tg_holder.gd" id="1"]\n[ext_resource type="Script" path="res://${code}" id="2"]\n\n[node name="R" type="Node2D"]\nscript = ExtResource("2")\n\n[node name="H" type="Node" parent="." node_paths=PackedStringArray("target")]\nscript = ExtResource("1")\ntarget = NodePath("../T")\n\n[node name="T" type="Node2D" parent="."]\n\n[node name="U" type="Node2D" parent="."]\n\n[node name="Tmp" type="Node" parent="."]\n`;
    const atLoad = (body: string) => `extends Node2D\nfunc _notification(w):\n\tif w == NOTIFICATION_SCENE_INSTANTIATED:\n\t\t${body}\n`;
    writeFile(p.root, 'tg_pass.gd', atLoad('pass'));
    writeFile(p.root, 'tg_ok.tscn', tg('tg_pass.gd'));
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'tg_ok.tscn', actions: [{ action: 'rename_node', node: 'T', new_name: 'T2' }] });
    assert.match(read('tg_ok.tscn'), /target = NodePath\("\.\.\/T2"\)/);
    writeFile(p.root, 'tg_move.gd', atLoad('$H.target = $U'));
    writeFile(p.root, 'tg_move.tscn', tg('tg_move.gd'));
    await refuses('tg_move.tscn', /'target'/, [{ action: 'rename_node', node: 'Tmp', new_name: 'Tmp2' }]);
    writeFile(p.root, 'tg_clear.gd', atLoad('$H.target = null'));
    writeFile(p.root, 'tg_clear.tscn', tg('tg_clear.gd'));
    await refuses('tg_clear.tscn', /'target'/, [{ action: 'remove_node', node: 'Tmp' }]);
    // Moving a node re-parents it, so its parenting code runs again; a
    // node-typed export must still point to the node it held.
    writeFile(
      p.root,
      'mv_holder.gd',
      'extends Node\n@export var host: Node\nfunc _notification(w):\n\tif w == NOTIFICATION_PARENTED:\n\t\thost = get_parent()\n',
    );
    writeFile(
      p.root,
      'mv.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://mv_holder.gd" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="A" type="Node2D" parent="."]\n\n[node name="H" type="Node" parent="A" node_paths=PackedStringArray("host")]\nscript = ExtResource("1")\nhost = NodePath("..")\n\n[node name="B" type="Node2D" parent="."]\n',
    );
    await refuses('mv.tscn', /'host'/, [{ action: 'move_node', node: 'A/H', new_parent: 'B' }]);
    // A key the script no longer has does not let code add other values.
    writeFile(p.root, 'stale.gd', 'extends Node2D\n@export var team := 0:\n\tset(v):\n\t\tteam = v\n\t\tmodulate = Color.RED\n');
    writeFile(
      p.root,
      'stale.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://stale.gd" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="H" type="Node2D" parent="."]\nscript = ExtResource("1")\nteam = 1\nold_speed = 3\n',
    );
    await refuses('stale.tscn', /node H: 'modulate' would be added/);
    // ...even when the value it sets equals the leftover one.
    writeFile(p.root, 'stale2.gd', 'extends Node2D\n@export var layer := 0:\n\tset(v):\n\t\tlayer = v\n\t\tz_index = v\n');
    writeFile(
      p.root,
      'stale2.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://stale2.gd" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="H" type="Node2D" parent="."]\nscript = ExtResource("1")\nlayer = 2\nold_hp = 2\n',
    );
    await refuses('stale2.tscn', /node H: 'z_index' would be added/);
    // A sub-resource the inherited scene does not store cannot be edited through it.
    writeFile(
      p.root,
      'sp_base.tscn',
      '[gd_scene format=3]\n\n[sub_resource type="CanvasItemMaterial" id="M"]\nblend_mode = 1\n\n[node name="B" type="Node2D"]\n\n[node name="S" type="Sprite2D" parent="."]\nmaterial = SubResource("M")\n',
    );
    writeFile(
      p.root,
      'sp_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://sp_base.tscn" id="1"]\n\n[node name="V" instance=ExtResource("1")]\n',
    );
    const spe = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'sp_kid.tscn',
      actions: [{ action: 'set_properties', node: 'S', properties: { 'material:blend_mode': 2 } }],
    });
    assert.equal(spe.code, 'CONFLICT', JSON.stringify(spe));
    assert.match(spe.message, /sub-resource of res:\/\/sp_base\.tscn/);
    // A node inside a nested instance is saved only when every instance on the
    // way makes its children editable.
    writeFile(p.root, 'nest_in.tscn', '[gd_scene format=3]\n\n[node name="In" type="Node2D"]\n\n[node name="S" type="Sprite2D" parent="."]\n');
    const nestMid = (editable: boolean) =>
      `[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://nest_in.tscn" id="1"]\n\n[node name="Mid" type="Node2D"]\n\n[node name="In" parent="." instance=ExtResource("1")]\n${editable ? '\n[editable path="In"]\n' : ''}`;
    const nestTop =
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://nest_mid.tscn" id="1"]\n\n[node name="Top" type="Node2D"]\n\n[node name="Mid" parent="." instance=ExtResource("1")]\n\n[editable path="Mid"]\n';
    writeFile(p.root, 'nest_mid.tscn', nestMid(false));
    writeFile(p.root, 'nest_top.tscn', nestTop);
    const ne = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'nest_top.tscn',
      actions: [{ action: 'set_properties', node: 'Mid/In/S', properties: { position: [5, 5] } }],
    });
    assert.equal(ne.code, 'CONFLICT', JSON.stringify(ne));
    assert.equal(read('nest_top.tscn'), nestTop);
    writeFile(p.root, 'nest_mid.tscn', nestMid(true));
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'nest_top.tscn',
      actions: [{ action: 'set_properties', node: 'Mid/In/S', properties: { position: [5, 5] } }],
    });
    assert.match(read('nest_top.tscn'), /position = Vector2\(5, 5\)/);
    // A copy holds what its source holds, apart from the key an action set in it.
    writeFile(
      p.root,
      'dup_code.gd',
      'extends Sprite2D\nstatic var seen := 0\nfunc _notification(w):\n\tif w == NOTIFICATION_PARENTED:\n\t\tseen += 1\n\t\tif seen == 2:\n\t\t\tvar m := CanvasItemMaterial.new()\n\t\t\tm.light_mode = 2\n\t\t\tmaterial = m\n',
    );
    writeFile(
      p.root,
      'dup.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://dup_code.gd" id="1"]\n\n[sub_resource type="CanvasItemMaterial" id="m"]\nblend_mode = 1\n\n[node name="R" type="Node2D"]\n\n[node name="S" type="Sprite2D" parent="."]\nmaterial = SubResource("m")\nscript = ExtResource("1")\n',
    );
    await refuses('dup.tscn', /duplicate Copy: 'material' differs from S/, [
      { action: 'duplicate_node', node: 'S', new_name: 'Copy' },
      { action: 'set_properties', node: 'Copy', properties: { 'material:blend_mode': 3 } },
    ]);
    // An editable instance of a variant restates the [editable] lines of the
    // scene that variant inherits.
    writeFile(p.root, 'ed_enemy.tscn', '[gd_scene format=3]\n\n[node name="Enemy" type="Node2D"]\n\n[node name="K" type="Node2D" parent="."]\n');
    writeFile(
      p.root,
      'ed_base.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://ed_enemy.tscn" id="1"]\n\n[node name="EB" type="Node2D"]\n\n[node name="E" parent="." instance=ExtResource("1")]\n\n[node name="K" parent="E" index="0"]\nposition = Vector2(4, 4)\n\n[editable path="E"]\n',
    );
    writeFile(
      p.root,
      'ed_variant.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://ed_base.tscn" id="1"]\n\n[node name="EV" instance=ExtResource("1")]\n',
    );
    writeFile(
      p.root,
      'ed_level.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://ed_variant.tscn" id="1"]\n\n[node name="R" type="Node2D"]\n\n[node name="Inst" parent="." instance=ExtResource("1")]\n\n[editable path="Inst"]\n',
    );
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'ed_level.tscn', actions: add });
  });
  it('refuses authoring edits that the scene would not save', async () => {
    writeFile(
      p.root,
      'anim_base.tscn',
      '[gd_scene format=3]\n\n[sub_resource type="Animation" id="a1"]\nlength = 1.0\n\n[sub_resource type="AnimationLibrary" id="l1"]\n_data = {\n&"walk": SubResource("a1")\n}\n\n[node name="B" type="Node2D"]\n\n[node name="Anim" type="AnimationPlayer" parent="."]\nlibraries = {\n&"": SubResource("l1")\n}\n',
    );
    writeFile(
      p.root,
      'anim_kid.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://anim_base.tscn" id="1"]\n\n[node name="K" instance=ExtResource("1")]\n',
    );
    const kid = read('anim_kid.tscn');
    // The library belongs to the base scene: an edit here would be lost.
    const e1 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'anim_kid.tscn',
      actions: [{ action: 'animation_upsert', player: 'Anim', name: 'run', length: 2, tracks: [] }],
    });
    assert.equal(e1.code, 'CONFLICT', JSON.stringify(e1));
    assert.match(e1.message, /stored in res:\/\/anim_base\.tscn/);
    assert.equal(read('anim_kid.tscn'), kid);
    // Nodes of an instance without editable children are not saved either.
    writeFile(
      p.root,
      'anim_level.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://anim_base.tscn" id="1"]\n\n[node name="L" type="Node2D"]\n\n[node name="E" parent="." instance=ExtResource("1")]\n',
    );
    const e2 = await h.fail('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'anim_level.tscn',
      actions: [{ action: 'animation_remove', player: 'E/Anim', name: 'walk' }],
    });
    assert.equal(e2.code, 'CONFLICT', JSON.stringify(e2));
    assert.match(e2.message, /children are not editable/);
    // The base scene itself can be edited.
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'anim_base.tscn',
      actions: [{ action: 'animation_upsert', player: 'Anim', name: 'run', length: 2, tracks: [] }],
    });
    assert.match(read('anim_base.tscn'), /&"run"/);
  });
  it('clears node-typed values that point at a removed node (regression: the worker crashed)', async () => {
    writeFile(p.root, 'refs.gd', 'extends Node2D\n@export var target: Node2D\n@export var many: Array[Node2D] = []\n');
    writeFile(
      p.root,
      'refs.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://refs.gd" id="1"]\n\n[node name="R" type="Node2D" node_paths=PackedStringArray("target", "many")]\nscript = ExtResource("1")\ntarget = NodePath("X")\nmany = [NodePath("X"), NodePath("Y")]\n\n[node name="X" type="Node2D" parent="."]\n\n[node name="Y" type="Node2D" parent="."]\n',
    );
    const r = await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'refs.tscn', actions: [{ action: 'remove_node', node: 'X' }] });
    const removed = (r.actions as Array<{ cleared_references?: string[] }>)[0];
    assert.deepEqual(removed?.cleared_references?.sort(), ['.:many', '.:target']);
    const text = read('refs.tscn');
    assert.doesNotMatch(text, /target = /);
    assert.match(text, /many = \[null, NodePath\("Y"\)\]/);
    assert.doesNotMatch(text, /name="X"/);
  });
  it('sets metadata and Control anchor presets', async () => {
    writeFile(
      p.root,
      'ui_meta.tscn',
      '[gd_scene format=3]\n\n[node name="UI" type="Control"]\n\n[node name="P" type="Panel" parent="."]\nlayout_mode = 0\noffset_right = 40.0\noffset_bottom = 40.0\n',
    );
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'ui_meta.tscn',
      actions: [{ action: 'set_properties', node: 'P', properties: { 'metadata/role': 'menu', anchors_preset: 15, layout_mode: 1 } }],
    });
    const ui = read('ui_meta.tscn');
    assert.match(ui, /metadata\/role = "menu"/);
    assert.match(ui, /anchors_preset = 15/);
    assert.match(ui, /anchor_right = 1\.0/);
    // null removes the metadata again.
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'ui_meta.tscn',
      actions: [{ action: 'set_properties', node: 'P', properties: { 'metadata/role': null } }],
    });
    assert.doesNotMatch(read('ui_meta.tscn'), /metadata\/role/);
  });
});

describe('autoload registration', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Autoloads', '\n[autoload]\n\nHud="*res://hud.tscn"\nPlain="res://plain.gd"\n');
    writeFile(p.root, 'hud.gd', 'class_name HudC extends CanvasLayer\nfunc foo() -> int:\n\treturn 1\n');
    writeFile(
      p.root,
      'hud.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://hud.gd" id="1"]\n\n[node name="Hud" type="CanvasLayer"]\nscript = ExtResource("1")\n',
    );
    writeFile(p.root, 'plain.gd', 'extends Node\nfunc f() -> int:\n\treturn 1\n');
    writeFile(p.root, 'uses_hud.gd', 'extends Node\nvar hc: HudC = Hud\nfunc g():\n\treturn Hud.foo() + 1\n');
    writeFile(p.root, 'uses_plain.gd', 'extends Node\nfunc g():\n\treturn Plain.f()\n');
    await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('compiles scripts that use a scene autoload', async () => {
    const r = await h.ok('godot_script_validate', { projectPath: p.root, paths: ['uses_hud.gd'] });
    assert.equal((r.results as Array<{ valid: boolean }>)[0]!.valid, true, JSON.stringify(r));
  });

  it('reports a reference to a non-singleton autoload as the error it is', async () => {
    const r = await h.ok('godot_script_validate', { projectPath: p.root, paths: ['uses_plain.gd'] });
    const e = (r.results as Array<{ valid: boolean; partial?: string }>)[0]!;
    assert.equal(e.valid, false, JSON.stringify(r));
    assert.equal(e.partial, undefined, JSON.stringify(r));
  });
});
