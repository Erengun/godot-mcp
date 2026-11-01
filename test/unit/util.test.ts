import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { isSupported, parseGodotVersion, templatesVersionDir, versionAtLeast } from '../../src/godot/locate.ts';
import { getValue, parseConfig } from '../../src/util/configFile.ts';
import { KeyedMutex } from '../../src/util/keyedMutex.ts';
import { RingBuffer } from '../../src/util/ringBuffer.ts';
import { jsonText } from '../../src/tools/registry.ts';

describe('version parsing', () => {
  it('parses stable, beta and .NET builds', () => {
    const v = parseGodotVersion('4.7.2.stable.official.ed1daf0bf')!;
    assert.deepEqual([v.major, v.minor, v.patch, v.status, v.dotnet, v.hash], [4, 7, 2, 'stable', false, 'ed1daf0bf']);
    const b = parseGodotVersion('4.8.beta2.mono.official.abc123')!;
    assert.deepEqual([b.minor, b.patch, b.status, b.dotnet], [8, 0, 'beta2', true]);
    assert.equal(templatesVersionDir(b), '4.8.beta2.mono');
    assert.equal(templatesVersionDir(v), '4.7.2.stable');
    assert.equal(parseGodotVersion('not godot'), null);
    assert.ok(versionAtLeast(v, 4, 4));
    assert.ok(!versionAtLeast(v, 4, 8));
    assert.ok(isSupported(v));
    assert.ok(isSupported(b));
    assert.ok(!isSupported(parseGodotVersion('4.4.1.stable.official.abc')!));
    assert.ok(!isSupported(parseGodotVersion('3.6.stable.official.abc')!));
  });
});

describe('ConfigFile reader', () => {
  it('reads sections, quoted strings and multi-line values', () => {
    const cfg = parseConfig(
      `; comment\nconfig_version=5\n\n[application]\n\nconfig/name="My \\"Game\\""\nrun/main_scene="res://main.tscn"\n\n[input]\n\njump={\n"deadzone": 0.5,\n"events": []\n}\n\n[preset.0]\nname="Linux"\nrunnable=true\n`,
    );
    assert.equal(getValue(cfg, 'application', 'config/name'), 'My "Game"');
    assert.equal(getValue(cfg, 'application', 'run/main_scene'), 'res://main.tscn');
    assert.match(String(getValue(cfg, 'input', 'jump')), /deadzone/);
    assert.equal(getValue(cfg, 'preset.0', 'runnable'), true);
    assert.equal(getValue(cfg, '', 'config_version'), 5);
  });
});

describe('RingBuffer', () => {
  it('keeps the newest items and tracks drops and cursors', () => {
    const r = new RingBuffer<number>(3);
    for (let i = 0; i < 5; i++) r.push(i);
    assert.deepEqual(r.all(), [2, 3, 4]);
    assert.equal(r.droppedCount, 2);
    assert.deepEqual(r.since(3).items, [3, 4]);
    assert.deepEqual(r.since(0).items, [2, 3, 4]);
    assert.equal(r.since(0).firstSeq, 2);
  });
});

describe('KeyedMutex', () => {
  it('serialises work per key and isolates keys', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = (k: string, tag: string, ms: number) =>
      m.run(k, async () => {
        order.push(`${tag}+`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${tag}-`);
      });
    await Promise.all([slow('a', 'a1', 30), slow('a', 'a2', 1), slow('b', 'b1', 1)]);
    assert.ok(order.indexOf('a1-') < order.indexOf('a2+'), order.join(','));
    assert.ok(order.indexOf('b1+') < order.indexOf('a1-'), 'other keys run concurrently');
  });
  it('releases the lock when work throws', async () => {
    const m = new KeyedMutex();
    await assert.rejects(
      m.run('k', async () => {
        throw new Error('x');
      }),
    );
    assert.equal(await m.run('k', async () => 7), 7);
  });
  it('is re-entrant within one call chain but still excludes other callers', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const outer = m.run('k', async () => {
      order.push('outer+');
      // Nested use of the same key (and a second key) must not deadlock.
      const inner = await m.run('k', async () => m.run('j', async () => 'inner'));
      await new Promise((r) => setTimeout(r, 20));
      order.push('outer-');
      return inner;
    });
    const other = m.run('k', async () => {
      order.push('other');
    });
    assert.equal(await outer, 'inner');
    await other;
    assert.deepEqual(order, ['outer+', 'outer-', 'other']);
    assert.equal(m.isBusy('k'), false);
  });
  it('does not let a callback scheduled inside a locked section bypass a later holder', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    let late!: Promise<void>;
    await m.run('k', async () => {
      // Fires after this section has released the lock.
      late = new Promise((resolve) =>
        setTimeout(() => {
          void m
            .run('k', async () => {
              order.push('timer');
            })
            .then(resolve);
        }, 10),
      );
    });
    await m.run('k', async () => {
      order.push('B+');
      await new Promise((r) => setTimeout(r, 40));
      order.push('B-');
    });
    await late;
    assert.deepEqual(order, ['B+', 'B-', 'timer']);
  });
});

describe('config', () => {
  it('reads and clamps environment options', () => {
    const c = loadConfig({ GODOT_MCP_OP_TIMEOUT_MS: '5', GODOT_MCP_READ_ONLY: 'true', GODOT_MCP_LEGACY_TOOLS: 'false', GODOT_MCP_ALLOWED_ROOTS: '' });
    assert.equal(c.operationTimeoutMs, 1000);
    assert.equal(c.readOnly, true);
    assert.equal(c.legacyTools, false);
    assert.deepEqual(c.allowedRoots, []);
  });
});

describe('response truncation', () => {
  it('truncates explicitly', () => {
    const t = jsonText({ big: 'x'.repeat(10_000) }, 4096);
    assert.ok(t.length < 5000);
    assert.match(t, /TRUNCATED/);
  });
});
