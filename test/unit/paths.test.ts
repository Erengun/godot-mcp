import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isProtectedPath, normalizeResPath, resolveInProject, resolveProject, resolveSearchDirectory } from '../../src/security/paths.ts';

let base: string;
let root: string;
let outside: string;

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'paths-test-')));
  root = join(base, 'proj');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'scenes'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'project.godot'), 'config_version=5\n');
  writeFileSync(join(root, 'scenes', 'a.tscn'), '[gd_scene format=3]\n');
  writeFileSync(join(outside, 'secret.tscn'), 'x');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'secret.tscn'), join(root, 'link.tscn'));
});
after(() => rmSync(base, { recursive: true, force: true }));

describe('resolveProject', () => {
  it('accepts a project directory and canonicalises it', () => {
    assert.equal(resolveProject(root).root, root);
    assert.equal(resolveProject(join(root, 'project.godot')).root, root);
  });
  it('rejects non-projects, empty values and control characters', () => {
    assert.throws(() => resolveProject(outside), /NOT_A_GODOT_PROJECT|Not a Godot project/);
    assert.throws(() => resolveProject(''), /required/);
    assert.throws(() => resolveProject(42), /required/);
    assert.throws(() => resolveProject(`${root}\u0000x`), /invalid characters/);
    assert.throws(() => resolveProject(join(base, 'missing')), /does not exist/);
  });
  it('enforces allowed roots', () => {
    assert.equal(resolveProject(root, [base]).root, root);
    assert.throws(
      () => resolveProject(root, [outside]),
      (e: Error & { code?: string }) => e.code === 'PATH_NOT_ALLOWED',
    );
  });
});

describe('normalizeResPath / resolveInProject', () => {
  const p = () => ({ root, requested: root });
  it('normalises res:// and relative forms', () => {
    assert.equal(normalizeResPath('res://scenes/a.tscn', p()).res, 'res://scenes/a.tscn');
    assert.equal(normalizeResPath('scenes/./a.tscn', p()).res, 'res://scenes/a.tscn');
    assert.equal(normalizeResPath('scenes\\a.tscn', p()).res, 'res://scenes/a.tscn');
    assert.equal(normalizeResPath(join(root, 'scenes', 'a.tscn'), p()).res, 'res://scenes/a.tscn');
  });
  it('rejects traversal and foreign schemes', () => {
    for (const bad of [
      '../x.tscn',
      'res://../x.tscn',
      'res://a/../../x',
      'scenes/../../x',
      'user://x.tres',
      'http://x',
      'res:///abs/x.tscn',
      '/etc/passwd',
      'uid://abc',
    ]) {
      assert.throws(() => normalizeResPath(bad, p()), /./, bad);
    }
  });
  it('detects symlink escapes for reads and writes', () => {
    assert.throws(
      () => resolveInProject('escape/secret.tscn', p(), { mustExist: true }),
      (e: Error & { code?: string }) => e.code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.throws(
      () => resolveInProject('escape/new.tscn', p(), { forWrite: true }),
      (e: Error & { code?: string }) => e.code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.throws(
      () => resolveInProject('link.tscn', p(), { mustExist: true }),
      (e: Error & { code?: string }) => e.code === 'PATH_OUTSIDE_PROJECT',
    );
  });
  it('enforces existence, extensions and protected paths', () => {
    assert.throws(() => resolveInProject('nope.tscn', p(), { mustExist: true }), /does not exist/);
    assert.throws(() => resolveInProject('scenes/a.tscn', p(), { mustNotExist: true }), /already exists/);
    assert.throws(() => resolveInProject('scenes/a.txt', p(), { extensions: ['.tscn'] }), /extensions/);
    assert.throws(() => resolveInProject('project.godot', p(), { forWrite: true }), /protected/);
    assert.throws(() => resolveInProject('.godot/x.cfg', p(), { forWrite: true }), /protected/);
    assert.equal(resolveInProject('project.godot', p(), { forWrite: true, allowProtected: true }).res, 'res://project.godot');
  });
  it('classifies protected paths', () => {
    assert.ok(isProtectedPath('.git/config'));
    assert.ok(isProtectedPath('icon.png.import'));
    assert.ok(isProtectedPath('a.gd.uid'));
    assert.ok(!isProtectedPath('scenes/a.tscn'));
  });
});

describe('resolveSearchDirectory', () => {
  it('validates directories and allowed roots', () => {
    assert.equal(resolveSearchDirectory(base, []), base);
    assert.throws(() => resolveSearchDirectory(join(base, 'missing'), []), /does not exist/);
    assert.throws(() => resolveSearchDirectory(outside, [root]), /ALLOWED_ROOTS/);
  });
});
