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

  it('never runs caller-supplied source while validating it (static initialisers included)', async () => {
    const marker = (name: string) => `FileAccess.open("res://${name}", FileAccess.WRITE).store_string("ran")`;
    const sources = {
      static_var: `extends RefCounted\nstatic var x = ${marker('SRC_STATIC_VAR.txt')}\n`,
      static_init_tool: `@tool\nextends RefCounted\nstatic func _static_init():\n\t${marker('SRC_STATIC_INIT.txt')}\n`,
      inner_class: `extends RefCounted\nclass Inner:\n\tstatic var y = ${marker('SRC_INNER.txt')}\n`,
      no_trailing_newline: `extends RefCounted\nstatic var z = ${marker('SRC_NO_NL.txt')}`,
    };
    for (const [name, source] of Object.entries(sources)) {
      const r = await h.call('godot_script_validate', { projectPath: p.root, source, sourcePath: `${name}.gd` });
      assert.ok(!r.isError, `${name}: ${r.content[0]?.text}`);
      // The code itself is well-formed, so it must still be reported as valid.
      assert.equal(r.structuredContent?.valid, true, `${name}: ${JSON.stringify(r.structuredContent)}`);
    }
    for (const f of ['SRC_STATIC_VAR.txt', 'SRC_STATIC_INIT.txt', 'SRC_INNER.txt', 'SRC_NO_NL.txt']) assert.equal(existsSync(join(p.root, f)), false, f);
    // Constructs that would swallow the sentinel line are parse errors, never compiled.
    for (const source of ['extends Node\nstatic var x = [\n', 'extends Node\nvar a = 1 \\', 'extends Node\n@export']) {
      const r = await h.ok('godot_script_validate', { projectPath: p.root, source });
      assert.equal(r.valid, false, source);
      for (const d of r.diagnostics as Array<{ line?: number }>) assert.ok((d.line ?? 0) <= source.split('\n').length, JSON.stringify(d));
    }
    // Errors in function bodies are still reported in full, on the caller's own lines.
    const bad = await h.ok('godot_script_validate', {
      projectPath: p.root,
      source: 'extends Node\nfunc f():\n\tvar x: int = "s"\n\treturn undefined_thing\nfunc g(a, b):\n\tpass\nfunc h():\n\tg(1)\n',
    });
    assert.equal(bad.valid, false);
    const lines = (bad.diagnostics as Array<{ line: number; severity: string }>).filter((d) => d.severity !== 'info').map((d) => d.line);
    for (const l of [3, 4, 8]) assert.ok(lines.includes(l), `line ${l}: ${JSON.stringify(bad.diagnostics)}`);
    assert.ok(!JSON.stringify(bad).includes('__godot_mcp_no_compile'), 'sentinel leaked into the result');
    // The analyzer resolves autoload singletons from the project settings, so a
    // reference to one is valid (the old compile step reported it as an info note).
    const auto = await h.ok('godot_script_validate', { projectPath: p.root, source: 'extends Node\nfunc f():\n\tMarker.queue_free()\n' });
    assert.equal(auto.valid, true, JSON.stringify(auto));
    assert.ok(!(auto.diagnostics as Array<{ severity: string }>).some((d) => d.severity === 'error'), JSON.stringify(auto));
    assert.equal(existsSync(join(p.root, 'AUTOLOAD_RAN.txt')), false);
  });

  it('confines preload/extends paths in unsaved source to the project', async () => {
    // A scene with a built-in script runs that script's static initialiser when preloaded.
    const evilScene = (marker: string) =>
      `[gd_scene load_steps=2 format=3]\n\n[sub_resource type="GDScript" id="s"]\nscript/source = "extends Node\nstatic var x = FileAccess.open(\\"${marker}\\", FileAccess.WRITE).store_string(\\"ran\\")\n"\n\n[node name="E" type="Node"]\nscript = SubResource("s")\n`;
    const outsideMarker = join(outside, 'PRELOAD_RAN.txt').replace(/\\/g, '/');
    writeFileSync(join(outside, 'evil.tscn'), evilScene(outsideMarker));
    for (const target of [join(outside, 'evil.tscn').replace(/\\/g, '/'), 'res://linked/evil.tscn', 'res://../evil.tscn']) {
      for (const source of [`extends Node\nconst E = preload("${target}")\n`, `extends Node\nconst P = "${target}"\nconst E = preload(P)\n`]) {
        const r = await h.ok('godot_script_validate', { projectPath: p.root, source });
        assert.equal(r.valid, false, source);
        assert.ok(
          (r.diagnostics as Array<{ message: string }>).some((d) => /preload/.test(d.message)),
          JSON.stringify(r),
        );
      }
    }
    // An outside base script that preloads the scene, reached through `extends`
    // with a comment line after a `\` continuation (Godot skips such comments).
    const chain = join(outside, 'chain.gd').replace(/\\/g, '/');
    writeFileSync(chain, `extends Node\nconst S = preload("${join(outside, 'evil.tscn').replace(/\\/g, '/')}")\n`);
    for (const source of [
      `extends \\\n# c\n"${chain}"\n`,
      `class_name Foo extends \\\n# c\n"${chain}"\n`,
      `extends Node\nclass A extends \\\n# c\n"${chain}":\n\tpass\n`,
    ]) {
      const r = await h.ok('godot_script_validate', { projectPath: p.root, source });
      assert.equal(r.valid, false, source);
    }
    assert.equal(existsSync(join(outside, 'PRELOAD_RAN.txt')), false);
    // In-project literal paths still work.
    writeFile(p.root, 'dep.gd', 'extends Node\nconst N := 3\n');
    const ok = await h.ok('godot_script_validate', {
      projectPath: p.root,
      source: 'extends Node\nconst D = preload("res://dep.gd")\nfunc f() -> int:\n\treturn D.N\n',
    });
    assert.equal(ok.valid, true, JSON.stringify(ok));
  });

  it('reports invalid unsaved source accurately (sentinel cannot be forged or absorbed)', async () => {
    // The sentinel name is random per call: declaring a guessed name cannot hide real errors.
    const forged = await h.ok('godot_script_validate', {
      projectPath: p.root,
      source: 'extends Node\nfunc f():\n\tundefined_call()\n\tvar y: int = "nope"\nconst __godot_mcp_no_compile_161026589__ = 1\n',
    });
    assert.equal(forged.valid, false, JSON.stringify(forged));
    // A trailing annotation with no target is an error, on the caller's line.
    for (const [source, line] of [
      ['extends Node\n@warning_ignore("unused_variable")\n', 2],
      ['extends Node\n@rpc\n', 2],
      ['extends Node\nvar a := 1\n@export\n\n', 3],
      ['extends Node\n@warning_ignore(\n\t"unused_variable")\n# trailing comment\n', 2],
      ['extends Node\nvar a = 1; @warning_ignore("unused_variable")\n', 2],
      ['extends Node\n@warning_ignore \\\n("unused_variable")\n', 2],
    ] as const) {
      const r = await h.ok('godot_script_validate', { projectPath: p.root, source });
      assert.equal(r.valid, false, source);
      assert.ok(
        (r.diagnostics as Array<{ line: number; severity: string }>).some((d) => ['error', 'script_error'].includes(d.severity) && d.line === line),
        `${source}: ${JSON.stringify(r)}`,
      );
    }
    // Class-level annotations alone, and standalone annotations at the end, are valid.
    for (const source of [
      '@tool\n',
      '@tool\nextends Node\n',
      '@icon("res://x.svg")\nextends Node\n',
      'extends Node\n@export_group("Stats")\n',
      'extends Node\n@export_category("Main")\n',
      '@warning_ignore("unused_variable")\n',
      'extends Node\nvar a = 1 # see @warning_ignore\n',
      'extends Node\n@warning_ignore_start("unused_variable")\nvar a = 1\n@warning_ignore_restore("unused_variable")\n',
    ]) {
      const r = await h.ok('godot_script_validate', { projectPath: p.root, source });
      assert.equal(r.valid, true, `${source}: ${JSON.stringify(r)}`);
    }
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

  it('does not loop through linked directories when scanning the project', { skip: process.platform === 'win32' }, async () => {
    const q = tempProject('Loop');
    try {
      writeFile(q.root, 'a/s.tscn', '[gd_scene format=3]\n\n[node name="S" type="Node"]\n');
      writeFile(q.root, 'a/x.gd', 'extends Node\n');
      symlinkSync(join(q.root, 'a'), join(q.root, 'a', 'loop'));
      const r = await h.ok('godot_uid', { projectPath: q.root, action: 'resave' });
      assert.equal(r.files_found, 1, JSON.stringify(r));
      const v = await h.ok('godot_script_validate', { projectPath: q.root, all: true });
      assert.equal(v.valid, true);
      assert.equal(v.checked, 1, JSON.stringify(v));
    } finally {
      q.cleanup();
    }
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
    for (const type of ['res://evil.gd', 'evil.gd', 'GDScript', 'EditorPlugin', 'EditorInterface', 'MissingNode', 'Node; rm -rf', '']) {
      const r = await h.call('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type, name: 'X' }] });
      assert.equal(r.isError, true, type);
    }
    assert.equal(
      (await h.fail('godot_resource_create', { projectPath: p.root, path: 's.tres', type: 'GDScript', properties: { source_code: 'extends Node' } })).code,
      'CLASS_NOT_ALLOWED',
    );
    // A MissingResource would save any class name and properties it is given.
    assert.equal(
      (
        await h.fail('godot_resource_create', {
          projectPath: p.root,
          path: 'm.tres',
          type: 'MissingResource',
          properties: { original_class: 'GDScript' },
        })
      ).code,
      'CLASS_NOT_ALLOWED',
    );
    assert.equal(existsSync(join(p.root, 'm.tres')), false);
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
    // An absolute path into the project gets the protected-file checks too, and
    // no export may replace the project's own sources.
    const settings = readFileSync(join(p.root, 'project.godot'), 'utf8');
    for (const outputPath of [join(p.root, 'project.godot'), join(p.root, '.godot', 'game.zip'), 'main.tscn', join(p.root, 'main.tscn')]) {
      const r = await h.fail('godot_export', { projectPath: p.root, action: 'export', preset: 'Mac', outputPath });
      assert.ok(['PATH_NOT_ALLOWED', 'INVALID_ARGUMENT'].includes(r.code), `${outputPath}: ${JSON.stringify(r)}`);
    }
    assert.equal(readFileSync(join(p.root, 'project.godot'), 'utf8'), settings);
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

  it('never lets a failing concurrent write roll back another call’s successful write', async () => {
    // Regression: the backup used for rollback was taken outside the project lock,
    // so a failing call restored a stale copy over a concurrent successful edit.
    for (let i = 0; i < 3; i++) {
      const [good, bad] = await Promise.all([
        h.call('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'add_node', type: 'Node', name: `Good${i}` }] }),
        h.call('godot_scene_edit', { projectPath: p.root, scenePath: 'main.tscn', actions: [{ action: 'remove_node', node: 'DoesNotExist' }] }),
        h.call('godot_resource_edit', { projectPath: p.root, path: 'missing.tres', properties: { x: 1 } }),
      ]);
      assert.ok(!good.isError, good.content[0]?.text);
      assert.ok(bad.isError);
      const tree = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'main.tscn' });
      assert.ok(
        (tree.nodes as Array<{ name: string }>).some((n) => n.name === `Good${i}`),
        `Good${i} lost: ${JSON.stringify(tree.nodes)}`,
      );
    }
  });

  it('lets only one of several concurrent writers with the same expectedHash succeed', async () => {
    const t = await h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'main.tscn' });
    const results = await Promise.all(
      ['H1', 'H2', 'H3'].map((name) =>
        h.call('godot_scene_edit', {
          projectPath: p.root,
          scenePath: 'main.tscn',
          expectedHash: t.sha256,
          actions: [{ action: 'add_node', type: 'Node', name }],
        }),
      ),
    );
    assert.equal(results.filter((r) => !r.isError).length, 1, JSON.stringify(results.map((r) => r.content[0]?.text?.slice(0, 120))));
    for (const r of results.filter((x) => x.isError)) assert.equal((r.structuredContent?.error as { code: string }).code, 'CONFLICT');
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
