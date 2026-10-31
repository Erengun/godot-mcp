import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DiagnosticParser, parseDiagnostics, summarizeDiagnostics } from '../../src/godot/diagnostics.ts';
import { parseMsbuild } from '../../src/tools/dotnet.ts';

const LOG = `Godot Engine v4.7.2.stable.official
SCRIPT ERROR: Invalid call. Nonexistent function 'fly' in base 'CharacterBody2D (player.gd)'.
          at: _physics_process (res://player.gd:12)
          GDScript backtrace (most recent call first):
              [0] _physics_process (res://player.gd:12)
ERROR: Failed to load script "res://bad.gd" with error "Parse error".
   at: load (modules/gdscript/gdscript_resource_format.cpp:46)
WARNING: 3 RIDs of type "CanvasItem" were leaked.
   at: _free_rids (servers/rendering/renderer_canvas_cull.cpp:2735)
USER WARNING: low health
   at: push_warning (core/variant/variant_utility.cpp:1034)
some normal output
`;

describe('diagnostics parser', () => {
  it('parses script errors with location and stack', () => {
    const d = parseDiagnostics(LOG);
    assert.equal(d.length, 3, JSON.stringify(d));
    assert.equal(d[0]!.severity, 'script_error');
    assert.equal(d[0]!.file, 'res://player.gd');
    assert.equal(d[0]!.line, 12);
    assert.equal(d[0]!.function, '_physics_process');
    assert.equal(d[0]!.stack?.length, 1);
    assert.equal(d[1]!.severity, 'error');
    assert.equal(d[1]!.file, 'modules/gdscript/gdscript_resource_format.cpp');
    assert.equal(d[2]!.severity, 'warning');
    assert.deepEqual(summarizeDiagnostics(d), { errors: 2, warnings: 1 });
  });
  it('filters exit-time leak noise', () => {
    assert.ok(!parseDiagnostics(LOG).some((x) => x.message.includes('RIDs')));
  });
  it('streams line by line and bounds stored diagnostics', () => {
    const p = new DiagnosticParser(1);
    for (const l of LOG.split('\n')) p.pushLine(l);
    p.flush();
    assert.equal(p.diagnostics.length, 1);
    assert.equal(p.overflowCount, 2);
  });
  it('strips ANSI colours', () => {
    const d = parseDiagnostics('\u001b[1;31mERROR:\u001b[0m boom\n   at: f (a.cpp:3)\n');
    assert.equal(d[0]!.message, 'boom');
  });
});

describe('msbuild parser', () => {
  it('extracts C# compiler errors', () => {
    const d = parseMsbuild(
      "/p/Player.cs(10,5): error CS0103: The name 'x' does not exist in the current context [/p/Game.csproj]\n/p/Player.cs(10,5): error CS0103: The name 'x' does not exist in the current context [/p/Game.csproj]",
    );
    assert.equal(d.length, 1);
    assert.equal(d[0]!.line, 10);
    assert.match(d[0]!.message, /CS0103/);
  });
});
