/**
 * Fixture A — 2D platformer built entirely through MCP tool calls, then run
 * (physics must actually land the player on TileMap collision) and rendered.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makePng, SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

const PLAYER_GD = `extends CharacterBody2D

const SPEED := 120.0
const JUMP_VELOCITY := -300.0
var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")
var frames := 0

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = JUMP_VELOCITY
	var dir := Input.get_axis("move_left", "move_right")
	velocity.x = dir * SPEED
	move_and_slide()
	frames += 1
	if frames == 90:
		print("PLAYER_STATE y=%d on_floor=%s anim=%s" % [int(global_position.y), is_on_floor(), $Anim.current_animation])
		get_tree().quit()
`;

describe('Fixture A: 2D platformer', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Platformer');
  });
  after(async () => {
    await h.close();
    if (process.env.KEEP_FIXTURES) console.log('kept fixture at', p.root);
    else p.cleanup();
  });

  it('imports generated textures through Godot', async () => {
    writeFile(
      p.root,
      'art/player.png',
      makePng(16, 24, (x, y) => (y < 6 ? [250, 210, 160, 255] : x % 15 === 0 ? [20, 20, 60, 255] : [40, 90, 220, 255])),
    );
    writeFile(
      p.root,
      'art/tiles.png',
      makePng(64, 16, (x, y) => (x < 16 ? (y < 3 ? [60, 200, 60, 255] : [130, 85, 40, 255]) : x < 32 ? [120, 120, 120, 255] : [200, 200, 80, 255])),
    );
    const list = await h.ok('godot_assets', { projectPath: p.root, action: 'list' });
    assert.equal(list.notImported, 2);
    const imp = await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    assert.equal(imp.unimportedAfter, 0, JSON.stringify(imp));
    const chk = await h.ok('godot_assets', { projectPath: p.root, action: 'check', paths: ['art/player.png', 'art/tiles.png'] });
    assert.equal(chk.problems, 0);
    assert.deepEqual((chk.results as Array<{ size: number[] }>)[0]!.size, [16, 24]);
  });

  it('configures input actions', async () => {
    await h.ok('godot_project_settings', {
      projectPath: p.root,
      action: 'input_set',
      action_name: 'move_left',
      events: [
        { type: 'key', keycode: 'A' },
        { type: 'key', keycode: 'Left' },
      ],
    });
    await h.ok('godot_project_settings', {
      projectPath: p.root,
      action: 'input_set',
      action_name: 'move_right',
      events: [
        { type: 'key', keycode: 'D' },
        { type: 'key', keycode: 'Right' },
      ],
    });
    const jump = await h.ok('godot_project_settings', {
      projectPath: p.root,
      action: 'input_set',
      action_name: 'jump',
      events: [
        { type: 'key', keycode: 'Space' },
        { type: 'joypad_button', button_index: 'a' },
      ],
    });
    assert.equal((jump.events as unknown[]).length, 2);
    const bad = await h.fail('godot_project_settings', {
      projectPath: p.root,
      action: 'input_set',
      action_name: 'x',
      events: [{ type: 'key', keycode: 'NotAKey' }],
    });
    assert.equal(bad.code, 'INVALID_ARGUMENT');
    const info = await h.ok('godot_project_info', { projectPath: p.root });
    assert.deepEqual((info.input_actions as Array<{ name: string }>).map((a) => a.name).sort(), ['jump', 'move_left', 'move_right']);
  });

  it('builds a TileSet with collision and SpriteFrames', async () => {
    const ts = await h.ok('godot_resource_build', {
      projectPath: p.root,
      kind: 'tileset_atlas',
      path: 'tiles/tileset.tres',
      texture: 'art/tiles.png',
      tileSize: [16, 16],
      collision: 'full',
    });
    assert.equal(ts.tiles_created, 4);
    assert.equal(ts.physics_layers, 1);
    const info = await h.ok('godot_resource_inspect', { projectPath: p.root, path: 'tiles/tileset.tres' });
    assert.equal((info.sources as Array<{ tiles: number }>)[0]!.tiles, 4);
    const sf = await h.ok('godot_resource_build', {
      projectPath: p.root,
      kind: 'sprite_frames',
      path: 'player/frames.tres',
      texture: 'art/tiles.png',
      frameSize: [16, 16],
      animations: [
        { name: 'walk', frames: [0, 1, 2, 3], fps: 10 },
        { name: 'idle', frames: [0], loop: false },
      ],
    });
    assert.deepEqual(sf.animations, [
      { name: 'walk', frames: 4 },
      { name: 'idle', frames: 1 },
    ]);
    assert.equal(
      (
        await h.fail('godot_resource_build', {
          projectPath: p.root,
          kind: 'sprite_frames',
          path: 'player/bad.tres',
          texture: 'art/tiles.png',
          frameSize: [16, 16],
          animations: [{ name: 'x', frames: [99] }],
        })
      ).code,
      'INVALID_ARGUMENT',
    );
  });

  it('creates the player scene with collision, camera limits, animation and script', async () => {
    await h.ok('godot_script_write', { projectPath: p.root, path: 'player/player.gd', content: PLAYER_GD });
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'player/player.tscn', rootType: 'CharacterBody2D', rootName: 'Player' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'player/player.tscn',
      actions: [
        { action: 'add_node', type: 'Sprite2D', name: 'Sprite', properties: { texture: 'res://art/player.png' } },
        {
          action: 'add_node',
          type: 'CollisionShape2D',
          name: 'Collision',
          properties: { shape: { $new: 'RectangleShape2D', properties: { size: [14, 24] } } },
        },
        {
          action: 'add_node',
          type: 'Camera2D',
          name: 'Camera',
          properties: { limit_left: 0, limit_top: -200, limit_right: 640, limit_bottom: 200, position_smoothing_enabled: true },
        },
        {
          action: 'add_node',
          type: 'AnimatedSprite2D',
          name: 'Walk',
          properties: { sprite_frames: 'res://player/frames.tres', animation: 'walk', visible: false },
        },
        { action: 'add_node', type: 'AnimationPlayer', name: 'Anim' },
        {
          action: 'animation_upsert',
          player: 'Anim',
          name: 'idle',
          length: 1.0,
          loop_mode: 'linear',
          autoplay: true,
          tracks: [
            {
              type: 'value',
              path: 'Sprite:scale',
              interpolation: 'cubic',
              keys: [
                { time: 0, value: [1, 1] },
                { time: 0.5, value: [1.05, 0.95] },
                { time: 1, value: [1, 1] },
              ],
            },
          ],
        },
        {
          action: 'animation_upsert',
          player: 'Anim',
          name: 'hurt',
          length: 0.3,
          tracks: [
            {
              type: 'value',
              path: 'Sprite:modulate',
              keys: [
                { time: 0, value: '#ff0000' },
                { time: 0.3, value: '#ffffff' },
              ],
            },
          ],
        },
        { action: 'animation_keys', player: 'Anim', name: 'idle', track: 'Sprite:scale', insert: [{ time: 0.25, value: [1.02, 0.98] }], remove_times: [0.5] },
        { action: 'attach_script', node: '.', script: 'player/player.gd' },
      ],
    });
    const t = readFileSync(join(p.root, 'player/player.tscn'), 'utf8');
    assert.match(t, /\[sub_resource type="Animation"/);
    assert.match(t, /autoplay = &"idle"|autoplay = "idle"/);
    assert.match(t, /limit_right = 640/);
    assert.match(t, /path="res:\/\/art\/player.png"/);
    const inv = await h.ok('godot_node_inspect', { projectPath: p.root, scenePath: 'player/player.tscn', nodePath: '.' });
    assert.equal(inv.script, 'res://player/player.gd');
  });

  it('builds the level with a TileMapLayer ground and an instanced player', async () => {
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'level.tscn', rootType: 'Node2D' });
    const r = await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'level.tscn',
      actions: [
        { action: 'add_node', type: 'TileMapLayer', name: 'Ground', properties: { tile_set: 'res://tiles/tileset.tres' } },
        { action: 'tilemap_fill_rect', node: 'Ground', rect: [0, 10, 40, 1], source_id: 0, atlas_coords: [0, 0] },
        { action: 'tilemap_fill_rect', node: 'Ground', rect: [0, 11, 40, 2], source_id: 0, atlas_coords: [1, 0] },
        {
          action: 'tilemap_set_cells',
          node: 'Ground',
          cells: [
            { coords: [8, 7], atlas_coords: [2, 0] },
            { coords: [9, 7], atlas_coords: [3, 0] },
          ],
        },
        { action: 'tilemap_erase_cells', node: 'Ground', cells: [[39, 12]] },
        { action: 'instantiate_scene', parent: '.', scene: 'player/player.tscn', name: 'Player', properties: { position: [64, 60] } },
      ],
    });
    assert.equal((r.actions as Array<{ used_cells?: number }>)[4]!.used_cells, 40 * 3 + 2 - 1);
    assert.equal(
      (
        await h.fail('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'level.tscn',
          actions: [{ action: 'tilemap_set_cells', node: 'Ground', cells: [{ coords: [0, 0], atlas_coords: [9, 9] }] }],
        })
      ).code,
      'INVALID_ARGUMENT',
    );
    await h.ok('godot_project_settings', {
      projectPath: p.root,
      action: 'set',
      settings: { 'application/run/main_scene': 'res://level.tscn', 'display/window/size/viewport_width': 640, 'display/window/size/viewport_height': 360 },
    });
  });

  it('validates the whole project as healthy', async () => {
    const v = await h.ok('godot_project_validate', { projectPath: p.root });
    assert.equal(v.healthy, true, JSON.stringify(v.problems));
  });

  it('runs: physics lands the player on the TileMap collision and the animation plays', async () => {
    const r = await h.ok('godot_run', { projectPath: p.root, headless: true, mode: 'until_exit', timeoutMs: 60000 });
    assert.equal(r.healthy, true, JSON.stringify(r));
    const line = (r.outputTail as string[]).find((l) => l.startsWith('PLAYER_STATE'))!;
    assert.ok(line, JSON.stringify(r.outputTail));
    const y = Number(/y=(-?\d+)/.exec(line)![1]);
    assert.match(line, /on_floor=true/);
    assert.match(line, /anim=idle/);
    // Ground top is tile row 10 => y = 160; player half height 12 => ~148.
    assert.ok(y > 140 && y < 160, line);
  });

  it('renders a real screenshot', { skip: process.platform === 'linux' && !process.env.DISPLAY ? 'no display' : false }, async () => {
    const r = await h.call('godot_screenshot', { projectPath: p.root, width: 640, height: 360, frames: 20, savePath: 'shots/level.png' });
    assert.ok(!r.isError, r.content[0]?.text);
    const img = r.content.find((c) => c.type === 'image')!;
    assert.equal(img.mimeType, 'image/png');
    const s = r.structuredContent!;
    assert.equal((s.stats as { looks_blank: boolean }).looks_blank, false);
    assert.equal((s.sceneFacts as { sprites_missing_texture: number }).sprites_missing_texture, 0);
    assert.ok(Number((s.stats as { distinct_colors_4bit: number }).distinct_colors_4bit) >= 3);
    if (process.env.SHOT_DIR) writeFileSync(join(process.env.SHOT_DIR, 'fixture-a-platformer.png'), Buffer.from(img.data!, 'base64'));
  });
});
