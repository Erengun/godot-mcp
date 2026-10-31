import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makePng, SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

describe('project, API, assets, UID, export and .NET tools', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Proj');
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'main.tscn', rootType: 'Node2D' });
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('lists projects with bounded search', async () => {
    const r = await h.ok('godot_project_list', { directory: join(p.root, '..'), recursive: true, maxDepth: 1 });
    assert.ok((r.projects as Array<{ path: string; name: string }>).some((x) => x.path === p.root && x.name === 'Proj'));
    const legacy = await h.ok('list_projects', { directory: p.root });
    assert.equal((legacy.projects as unknown[]).length, 1);
  });

  it('reads and writes settings with backups', async () => {
    const s = await h.ok('godot_project_settings', {
      projectPath: p.root,
      action: 'set',
      settings: {
        'display/window/size/viewport_width': 1280,
        'application/config/name': 'Renamed',
        'application/run/main_scene': 'main.tscn',
        'layer_names/2d_physics/layer_1': 'world',
      },
    });
    assert.ok(existsSync(String(s.backup)));
    const g = await h.ok('godot_project_settings', {
      projectPath: p.root,
      action: 'get',
      keys: ['display/window/size/viewport_width', 'application/config/name'],
    });
    assert.equal((g.settings as Record<string, { value: unknown }>)['display/window/size/viewport_width']!.value, 1280);
    assert.equal(
      (await h.fail('godot_project_settings', { projectPath: p.root, action: 'set', settings: { 'application/run/main_scene': 'missing.tscn' } })).code,
      'NOT_FOUND',
    );
    const info = await h.ok('godot_project_info', { projectPath: p.root });
    assert.equal(info.name, 'Renamed');
    assert.equal(info.main_scene, 'res://main.tscn');
    assert.equal((info.layer_names as Record<string, string>)['2d_physics/layer_1'], 'world');
    const legacy = await h.ok('get_project_info', { project_path: p.root });
    assert.equal(legacy.name, 'Renamed');
  });

  it('manages autoloads safely', async () => {
    writeFile(p.root, 'globals.gd', 'extends Node\n');
    await h.ok('godot_project_settings', { projectPath: p.root, action: 'autoload_set', name: 'Globals', path: 'globals.gd' });
    assert.match(readFileSync(join(p.root, 'project.godot'), 'utf8'), /Globals="\*res:\/\/globals\.gd"/);
    assert.equal(
      (await h.fail('godot_project_settings', { projectPath: p.root, action: 'autoload_set', name: 'Node2D', path: 'globals.gd' })).code,
      'CONFLICT',
    );
    assert.equal((await h.fail('godot_project_settings', { projectPath: p.root, action: 'autoload_set', name: 'X', path: 'nope.gd' })).code, 'NOT_FOUND');
    await h.ok('godot_project_settings', { projectPath: p.root, action: 'autoload_remove', name: 'Globals' });
    assert.doesNotMatch(readFileSync(join(p.root, 'project.godot'), 'utf8'), /Globals=/);
  });

  it('validation detects broken references and broken scripts', async () => {
    writeFile(
      p.root,
      'broken.tscn',
      '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://does_not_exist.png" id="1"]\n\n[node name="B" type="Sprite2D"]\ntexture = ExtResource("1")\n',
    );
    writeFile(p.root, 'oops.gd', 'extends Node\nfunc f(\n');
    const v = await h.ok('godot_project_validate', { projectPath: p.root });
    assert.equal(v.healthy, false);
    const probs = v.problems as Array<{ path: string; missing_dependencies?: unknown[]; diagnostics?: unknown[] }>;
    assert.ok(probs.find((x) => x.path === 'res://broken.tscn')?.missing_dependencies?.length);
    assert.ok(probs.find((x) => x.path === 'res://oops.gd')?.diagnostics?.length);
  });

  it('reflects the engine API without a project and caches results', async () => {
    const s = await h.ok('godot_api_search', { query: 'body', kind: 'node', inherits: 'PhysicsBody3D' });
    const names = (s.classes as Array<{ class: string }>).map((c) => c.class);
    for (const n of ['CharacterBody3D', 'RigidBody3D', 'StaticBody3D']) assert.ok(names.includes(n), n);
    const c = await h.ok('godot_api_class', { className: 'CharacterBody3D', filter: 'floor', includeInherited: false });
    assert.ok((c.methods as Array<{ name: string }>).some((m) => m.name === 'is_on_floor'));
    assert.ok((c.properties as Array<{ name: string }>).some((m) => m.name === 'floor_max_angle'));
    const again = await h.ok('godot_api_class', { className: 'CharacterBody3D', filter: 'floor', includeInherited: false });
    assert.equal(again.cached, true);
    const enums = await h.ok('godot_api_class', { className: 'Node', sections: ['enums'] });
    assert.equal((enums.enums as Record<string, Record<string, number>>).ProcessMode!.PROCESS_MODE_ALWAYS, 3);
    assert.equal((await h.fail('godot_api_class', { className: 'NotAClass' })).code, 'NOT_FOUND');
  });

  it('reports UIDs and resaves without changing them', async () => {
    const u = await h.ok('godot_uid', { projectPath: p.root, action: 'get', path: 'main.tscn' });
    assert.match(String(u.uid), /^uid:\/\//);
    const legacy = await h.ok('get_uid', { projectPath: p.root, filePath: 'res://main.tscn' });
    assert.equal(legacy.uid, u.uid);
    await h.ok('update_project_uids', { projectPath: p.root });
    assert.match(readFileSync(join(p.root, 'main.tscn'), 'utf8'), new RegExp(String(u.uid)));
  });

  it('flags assets that exist on disk but are not imported / not loadable', async () => {
    writeFile(
      p.root,
      'img.png',
      makePng(8, 8, () => [255, 0, 0, 255]),
    );
    writeFile(p.root, 'fake.png', 'not a png');
    const before = await h.ok('godot_assets', { projectPath: p.root, action: 'check', paths: ['img.png'] });
    assert.equal((before.results as Array<{ loadable: boolean }>)[0]!.loadable, false);
    const imp = await h.ok('godot_assets', { projectPath: p.root, action: 'import' });
    assert.ok(
      (imp.diagnostics as Array<{ message: string }>).some((d) => /fake\.png/.test(d.message)),
      JSON.stringify(imp.diagnostics),
    );
    const afterCheck = await h.ok('godot_assets', { projectPath: p.root, action: 'check', paths: ['img.png', 'fake.png'] });
    const res = afterCheck.results as Array<{ path: string; loadable: boolean; size?: number[] }>;
    assert.deepEqual(res[0]!.size, [8, 8]);
    assert.equal(res[1]!.loadable, false);
    assert.equal(afterCheck.problems, 1);
  });

  it('checks export prerequisites and performs a real export when templates exist', async () => {
    writeFile(
      p.root,
      'export_presets.cfg',
      '[preset.0]\n\nname="Linux"\nplatform="Linux"\nrunnable=true\ndedicated_server=false\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="build/game.x86_64"\n\n[preset.0.options]\n\nbinary_format/embed_pck=true\nbinary_format/architecture="x86_64"\n',
    );
    const presets = await h.ok('godot_export', { projectPath: p.root, action: 'presets' });
    assert.equal((presets.presets as Array<{ name: string }>)[0]!.name, 'Linux');
    const check = await h.ok('godot_export', { projectPath: p.root, action: 'check', preset: 'Linux' });
    assert.equal((await h.fail('godot_export', { projectPath: p.root, action: 'check', preset: 'Nope' })).code, 'NOT_FOUND');
    if (!check.ready) {
      const e = await h.fail('godot_export', { projectPath: p.root, action: 'export', preset: 'Linux', outputPath: 'build/game.x86_64' });
      assert.equal(e.code, 'CAPABILITY_UNAVAILABLE');
      return;
    }
    rmBroken(p.root);
    const r = await h.ok('godot_export', { projectPath: p.root, action: 'export', preset: 'Linux', outputPath: 'build/game.x86_64', debug: true });
    assert.ok(Number(r.bytes) > 1_000_000, JSON.stringify(r));
    assert.ok(statSync(join(p.root, 'build/game.x86_64')).size > 1_000_000);
  });

  it('reports .NET capability honestly', async () => {
    const r = await h.ok('godot_dotnet', { projectPath: p.root, action: 'status' });
    assert.equal(r.usable, false);
    const e = await h.fail('godot_dotnet', { projectPath: p.root, action: 'build' });
    assert.equal(e.code, 'CAPABILITY_UNAVAILABLE');
    assert.match(e.message, /not the \.NET build|no \.csproj/);
  });
});

function rmBroken(root: string): void {
  for (const f of readdirSync(root)) if (['broken.tscn', 'oops.gd', 'fake.png'].includes(f)) writeFile(root, f, '');
}
