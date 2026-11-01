import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { scanSourcePaths } from '../../src/security/gdscriptSource.ts';
import { resolveProject } from '../../src/security/paths.ts';
import { unsafeSourcePaths } from '../../src/tools/script.ts';

const refused = (src: string) => scanSourcePaths(src).filter((f) => f.problem);
const accepted = (src: string) => scanSourcePaths(src).filter((f) => f.path);

describe('scanSourcePaths', () => {
  it('accepts literal res:// preloads and extends, and class-name extends', () => {
    assert.deepEqual(
      accepted('extends Node\nconst A = preload("res://a.tscn")\nconst B = preload( \'res://b.gd\' )\n').map((f) => f.path),
      ['res://a.tscn', 'res://b.gd'],
    );
    assert.deepEqual(accepted('extends "res://base.gd"\n')[0]?.path, 'res://base.gd');
    assert.equal(scanSourcePaths('extends CharacterBody2D\nclass_name Player\n').length, 0);
    assert.equal(scanSourcePaths('extends \\\n\tNode2D\nclass Inner extends _Base:\n\tpass\n# this class extends the base\n').length, 0);
  });

  it('ignores identifiers that merely contain the keywords', () => {
    assert.equal(scanSourcePaths('var preloaded = 1\nfunc _preload_all():\n\tpass\nvar extends_x = 2\n').length, 0);
  });

  it('refuses anything that is not a plain literal res:// path', () => {
    for (const src of [
      'const A = preload("/etc/x.tscn")',
      'const A = preload("//host/share/x.tscn")',
      'const A = preload("C:/x.tscn")',
      'const A = preload("user://x.tres")',
      'const A = preload("x.tscn")',
      'const P = "/tmp/x.tscn"\nconst A = preload(P)',
      'const A = preload("res://" + "x.tscn")',
      'const A = preload(r"res://x.tscn")',
      'const A = preload("""res://x.tscn""")',
      'const A = preload("res://\\u002e\\u002e/x.tscn")',
      'const A = preload("res://x.tscn",)',
      'const A = preload( # comment\n"res://x.tscn")',
      'const A = preload\n',
      'extends "/abs/base.gd"',
      'extends r"res://base.gd"',
      'extends \\\n"/abs/base.gd"',
      // Godot skips comment lines after a `\` continuation (GH-89403).
      'extends \\\n# c\n"/abs/base.gd"',
      'class_name Foo extends \\\n# c\n"/abs/base.gd"',
      'extends Node\nclass A extends \\\n# c\n"/abs/base.gd":\n\tpass',
      'extends',
      'extends 5',
      '# preload("/etc/x") in a comment is refused too (over-approximation)',
    ]) {
      assert.ok(refused(src).length > 0, src);
    }
  });

  it('reports the keyword line', () => {
    assert.equal(refused('extends Node\n\n\nconst A = preload("/x.tscn")')[0]?.line, 4);
  });
});

describe('unsafeSourcePaths', () => {
  let base: string;
  let root: string;
  before(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'srcpaths-test-')));
    root = join(base, 'proj');
    const outside = join(base, 'outside');
    for (const d of [root, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(root, 'project.godot'), 'config_version=5\n');
    symlinkSync(outside, join(root, 'linked'));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it('confines accepted res:// paths to the project', () => {
    const project = resolveProject(root);
    assert.equal(unsafeSourcePaths('const A = preload("res://ok.tscn")', project, 'x.gd').length, 0);
    for (const src of ['const A = preload("res://../x.tscn")', 'const A = preload("res:///etc/x.tscn")', 'const A = preload("res://linked/x.tscn")']) {
      const d = unsafeSourcePaths(src, project, 'x.gd');
      assert.equal(d.length, 1, src);
      assert.equal(d[0]!.file, 'x.gd');
      assert.equal(d[0]!.severity, 'error');
    }
  });
});
