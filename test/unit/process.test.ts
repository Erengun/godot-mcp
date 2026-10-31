import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { liveProcessCount, runProcess } from '../../src/godot/process.ts';

const node = process.execPath;

describe('runProcess', () => {
  it('captures output and exit code without a shell', async () => {
    const r = await runProcess(node, ['-e', 'console.log("hi; rm -rf /"); process.exit(3)'], { timeoutMs: 10_000 });
    assert.equal(r.stdout.trim(), 'hi; rm -rf /');
    assert.equal(r.exitCode, 3);
  });
  it('does not interpret shell metacharacters in arguments', async () => {
    const r = await runProcess(node, ['-e', 'console.log(process.argv[1])', '$(echo pwned) && `id`'], { timeoutMs: 10_000 });
    assert.equal(r.stdout.trim(), '$(echo pwned) && `id`');
  });
  it('enforces timeouts and kills the process', async () => {
    const r = await runProcess(node, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 300, killGraceMs: 200 });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 5000);
    assert.equal(liveProcessCount(), 0);
  });
  it('honours AbortSignal cancellation', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runProcess(node, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 30_000, signal: ac.signal, killGraceMs: 200 });
    assert.equal(r.cancelled, true);
  });
  it('bounds captured output', async () => {
    const r = await runProcess(node, ['-e', 'process.stdout.write("x".repeat(500000))'], { timeoutMs: 10_000, maxOutputBytes: 1000 });
    assert.equal(r.stdout.length, 1000);
    assert.equal(r.truncated.stdout, true);
  });
  it('reports spawn errors', async () => {
    const r = await runProcess('/nonexistent/godot-binary', [], { timeoutMs: 1000 });
    assert.ok(r.spawnError);
  });
});
