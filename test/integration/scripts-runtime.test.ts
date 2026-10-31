import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SKIP_NO_GODOT, startServer, tempProject, writeFile, type Harness } from '../helpers/mcp.ts';

type Diag = { severity: string; message: string; file?: string; line?: number };

describe('scripts and runtime', { skip: SKIP_NO_GODOT }, () => {
  let h: Harness;
  let p: { root: string; cleanup: () => void };
  before(async () => {
    h = await startServer();
    p = tempProject('Runtime', '\n[autoload]\n\nGameState="*res://game_state.gd"\n');
    writeFile(p.root, 'game_state.gd', 'extends Node\nvar score := 0\n');
    writeFile(p.root, 'uses_autoload.gd', 'extends Node\nfunc _ready() -> void:\n\tGameState.score += 1\n');
    writeFile(
      p.root,
      'good.gd',
      'class_name Mover\nextends Node2D\nsignal moved(to: Vector2)\nconst SPEED := 4.0\n@export var target: Vector2\nfunc step(delta: float, boost: float = 1.0) -> Vector2:\n\tposition += Vector2.RIGHT * SPEED * delta * boost\n\tmoved.emit(position)\n\treturn position\n',
    );
    writeFile(p.root, 'bad.gd', 'extends Node\nfunc f(a: int) -> int:\n\treturn a\nfunc g() -> void:\n\tf(1, 2)\n\tvar x: int = "text"\n');
  });
  after(async () => {
    await h.close();
    p.cleanup();
  });

  it('reports real parse/analyzer errors with lines', async () => {
    const r = await h.ok('godot_script_validate', { projectPath: p.root, paths: ['bad.gd', 'good.gd'] });
    assert.equal(r.valid, false);
    const results = r.results as Array<{ path: string; valid: boolean; diagnostics?: Diag[] }>;
    const bad = results.find((x) => x.path === 'res://bad.gd')!;
    assert.equal(bad.valid, false);
    assert.ok(
      bad.diagnostics!.some((d) => d.line === 5 && /Too many arguments/.test(d.message)),
      JSON.stringify(bad.diagnostics),
    );
    assert.equal(results.find((x) => x.path === 'res://good.gd')!.valid, true);
  });

  it('treats autoload references as notes, not errors', async () => {
    const r = await h.ok('godot_script_validate', { projectPath: p.root, paths: ['uses_autoload.gd'] });
    const e = (r.results as Array<{ valid: boolean; diagnostics?: Diag[] }>)[0]!;
    assert.equal(e.valid, true, JSON.stringify(e));
    assert.ok(e.diagnostics?.some((d) => d.severity === 'info'));
  });

  it('validates unsaved source', async () => {
    const r = await h.ok('godot_script_validate', { projectPath: p.root, source: 'extends Node\nfunc x(:\n', sourcePath: 'draft.gd' });
    assert.equal(r.valid, false);
    assert.ok((r.diagnostics as Diag[]).some((d) => d.file === 'draft.gd' && d.line === 2));
  });

  it('inspects script symbols through reflection', async () => {
    const r = await h.ok('godot_script_inspect', { projectPath: p.root, path: 'good.gd' });
    assert.equal(r.class_name, 'Mover');
    assert.equal(r.extends, 'Node2D');
    const step = (r.methods as Array<{ name: string; required_args: number; args: unknown[] }>).find((m) => m.name === 'step')!;
    assert.equal(step.args.length, 2);
    assert.equal(step.required_args, 1);
    assert.ok((r.signals as Array<{ name: string }>).some((s) => s.name === 'moved'));
    assert.ok((r.properties as Array<{ name: string; exported: boolean }>).some((x) => x.name === 'target' && x.exported));
    assert.equal((r.constants as Record<string, unknown>).SPEED, 4);
  });

  it('writes scripts atomically and rolls back code that does not compile', async () => {
    const created = await h.ok('godot_script_write', { projectPath: p.root, path: 'scripts/new.gd', content: 'extends Node\nfunc ok() -> int:\n\treturn 1\n' });
    assert.equal(created.created, true);
    const e = await h.fail('godot_script_write', { projectPath: p.root, path: 'scripts/new.gd', overwrite: true, content: 'extends Node\nfunc ok( -> int:\n' });
    assert.equal(e.code, 'OPERATION_FAILED');
    assert.match(readFileSync(join(p.root, 'scripts/new.gd'), 'utf8'), /return 1/);
    assert.equal(
      (await h.fail('godot_script_write', { projectPath: p.root, path: 'scripts/broken.gd', content: 'extends Node\nfunc (' })).code,
      'OPERATION_FAILED',
    );
    assert.equal(existsSync(join(p.root, 'scripts/broken.gd')), false);
    assert.equal((await h.fail('godot_script_write', { projectPath: p.root, path: 'scripts/new.gd', content: 'x' })).code, 'ALREADY_EXISTS');
  });

  it('runs a scene to completion and reports a healthy run', async () => {
    writeFile(p.root, 'ok_main.gd', 'extends Node\nfunc _ready() -> void:\n\tprint("HELLO FROM GAME ", GameState.score)\n\tget_tree().quit(0)\n');
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'ok.tscn', rootType: 'Node' });
    const att = await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'ok.tscn',
      actions: [{ action: 'attach_script', node: '.', script: 'ok_main.gd' }],
    });
    assert.match(String((att.actions as Array<{ note?: string }>)[0]!.note), /autoload/);
    assert.match(readFileSync(join(p.root, 'ok.tscn'), 'utf8'), /path="res:\/\/ok_main.gd"/);
    // A genuinely broken script is still refused.
    assert.equal(
      (await h.fail('godot_scene_edit', { projectPath: p.root, scenePath: 'ok.tscn', actions: [{ action: 'attach_script', node: '.', script: 'bad.gd' }] }))
        .code,
      'OPERATION_FAILED',
    );
    const r = await h.ok('godot_run', { projectPath: p.root, scene: 'ok.tscn', headless: true, mode: 'until_exit', timeoutMs: 60000 });
    assert.equal(r.healthy, true, JSON.stringify(r));
    assert.equal((r.session as { exitCode: number }).exitCode, 0);
    assert.ok((r.outputTail as string[]).some((l) => l.includes('HELLO FROM GAME 0')));
  });

  it('detects runtime script errors (wrong call signature) and marks the run unhealthy', async () => {
    writeFile(
      p.root,
      'err_main.gd',
      'extends Node\nfunc needs_two(a: int, b: int) -> int:\n\treturn a + b\nfunc _ready() -> void:\n\tcall("needs_two", 1)\n\tget_tree().quit(0)\n',
    );
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'err.tscn', rootType: 'Node' });
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'err.tscn', actions: [{ action: 'attach_script', node: '.', script: 'err_main.gd' }] });
    const r = await h.ok('godot_run', { projectPath: p.root, scene: 'err.tscn', headless: true, mode: 'until_exit', quitAfterFrames: 30, timeoutMs: 60000 });
    assert.equal(r.healthy, false);
    const d = (r.diagnostics as Diag[]).find((x) => x.severity === 'script_error')!;
    assert.ok(d, JSON.stringify(r.diagnostics));
    assert.equal(d.file, 'res://err_main.gd');
    assert.equal(d.line, 5);
    const out = await h.ok('godot_runtime_output', { diagnosticsOnly: true });
    assert.ok((out.total as number) >= 1);
  });

  it('reports crashes / non-zero exits and startup failures', async () => {
    writeFile(p.root, 'crash_main.gd', 'extends Node\nfunc _ready() -> void:\n\tget_tree().quit(7)\n');
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'crash.tscn', rootType: 'Node' });
    await h.ok('godot_scene_edit', {
      projectPath: p.root,
      scenePath: 'crash.tscn',
      actions: [{ action: 'attach_script', node: '.', script: 'crash_main.gd' }],
    });
    const r = await h.ok('godot_run', { projectPath: p.root, scene: 'crash.tscn', headless: true, mode: 'until_exit', timeoutMs: 60000 });
    assert.equal(r.crashed, true);
    assert.equal(r.healthy, false);
    assert.equal((r.session as { exitCode: number }).exitCode, 7);
  });

  it('kills runs that exceed the timeout', async () => {
    writeFile(p.root, 'loop_main.gd', 'extends Node\nfunc _process(_d: float) -> void:\n\tpass\n');
    await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'loop.tscn', rootType: 'Node' });
    await h.ok('godot_scene_edit', { projectPath: p.root, scenePath: 'loop.tscn', actions: [{ action: 'attach_script', node: '.', script: 'loop_main.gd' }] });
    const started = Date.now();
    const r = await h.ok('godot_run', { projectPath: p.root, scene: 'loop.tscn', headless: true, mode: 'until_exit', timeoutMs: 3000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.healthy, false);
    assert.equal((r.session as { running: boolean }).running, false);
    assert.ok(Date.now() - started < 20000);
  });

  it('starts in the background, restarts safely and stops', async () => {
    const a = await h.ok('godot_run', { projectPath: p.root, scene: 'loop.tscn', headless: true, startupWaitMs: 1500 });
    assert.equal((a.session as { running: boolean }).running, true);
    const b = await h.ok('godot_run', { projectPath: p.root, scene: 'loop.tscn', headless: true, startupWaitMs: 1500 });
    assert.deepEqual(b.replacedSessions, [(a.session as { id: string }).id]);
    const status = await h.ok('godot_runtime_status');
    assert.equal((status.sessions as Array<{ running: boolean; kind: string }>).filter((s) => s.running && s.kind === 'game').length, 1);
    const s = await h.ok('godot_stop', {});
    assert.equal(s.stopped, true);
    // Output survives the process
    const out = await h.ok('godot_runtime_output', { since: 0 });
    assert.ok(Array.isArray(out.lines));
    // legacy tools still work against the same runtime
    await h.ok('run_project', { projectPath: p.root, scene: 'loop.tscn' });
    const dbg = await h.ok('get_debug_output');
    assert.ok(Array.isArray(dbg.output));
    await h.ok('stop_project');
    assert.equal((await h.fail('stop_project')).code, 'PROCESS_NOT_RUNNING');
  });
});
