import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BridgeConnection, bridgeInfoPath, EditorBridgeManager, readBridgeInfo } from '../../src/editor/bridge.ts';

const TOKEN = 'a'.repeat(64);
let dir: string;
let server: Server;
let port = 0;
const seen: string[] = [];

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-test-')));
  writeFileSync(join(dir, 'project.godot'), 'config_version=5\n');
  // Minimal stand-in implementing the plugin's wire protocol, used only to
  // test client-side handling (auth, routing, errors). The real plugin is
  // exercised against a real headless editor in test/integration/editor.test.ts.
  server = createServer((sock) => {
    let buf = '';
    let authed = false;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(msg.type ?? msg.method);
        if (!authed) {
          if (msg.token === TOKEN) {
            authed = true;
            sock.write(JSON.stringify({ type: 'welcome', protocol: 1 }) + '\n');
          } else {
            sock.write(JSON.stringify({ type: 'rejected' }) + '\n');
            sock.end();
          }
          continue;
        }
        if (msg.method === 'hang') continue;
        if (msg.method === 'boom') sock.write(JSON.stringify({ id: msg.id, ok: false, error: { code: 'CONFLICT', message: 'nope' } }) + '\n');
        else sock.write(JSON.stringify({ id: msg.id, ok: true, result: { echo: msg.params } }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeInfo(extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, '.godot', 'godot_mcp'), { recursive: true });
  writeFileSync(bridgeInfoPath(dir), JSON.stringify({ protocol: 1, port, token: TOKEN, pid: 1, project_root: dir, godot_version: 'x', ...extra }));
}

describe('editor bridge client', () => {
  it('returns null without a discovery file', () => {
    assert.equal(readBridgeInfo(dir), null);
  });
  it('rejects a discovery file for a different project', () => {
    writeInfo({ project_root: '/some/other/project' });
    assert.throws(() => readBridgeInfo(dir), /different project/);
  });
  it('rejects malformed tokens and ports', () => {
    writeInfo({ token: 'short' });
    assert.equal(readBridgeInfo(dir), null);
    writeInfo({ port: 70000 });
    assert.equal(readBridgeInfo(dir), null);
  });
  it('refuses symlinked discovery files', () => {
    rmSync(bridgeInfoPath(dir));
    const real = join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ protocol: 1, port, token: TOKEN, pid: 1, project_root: dir, godot_version: 'x' }));
    symlinkSync(real, bridgeInfoPath(dir));
    assert.throws(() => readBridgeInfo(dir), /not a regular file/);
    rmSync(bridgeInfoPath(dir));
  });
  it('authenticates, routes responses and maps errors', async () => {
    writeInfo();
    const m = new EditorBridgeManager();
    const c = await m.require(dir);
    assert.deepEqual(await c.request('status', { a: 1 }), { echo: { a: 1 } });
    await assert.rejects(c.request('boom'), (e: Error & { code?: string }) => e.code === 'CONFLICT');
    await assert.rejects(c.request('hang', {}, 200), (e: Error & { code?: string }) => e.code === 'TIMEOUT');
    m.closeAll();
  });
  it('fails cleanly with a wrong token', async () => {
    writeInfo();
    const info = readBridgeInfo(dir)!;
    const bad = new BridgeConnection({ ...info, token: 'b'.repeat(64) });
    await assert.rejects(bad.open(), (e: Error & { code?: string }) => e.code === 'EDITOR_REJECTED');
  });
});
