/**
 * Parse-check every bundled GDScript file with the real Godot parser
 * (`godot --headless --check-only --script <file>`). Exit code 1 on any error.
 */
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { godotPath, REPO } from './mcp.ts';

const godot = godotPath();
if (!godot) {
  console.error('SKIP: Godot not found (set GODOT_PATH)');
  process.exit(0);
}
const files: string[] = [];
const walk = (d: string): void => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.gd')) files.push(p);
  }
};
walk(join(REPO, 'godot'));
const proj = mkdtempSync(join(tmpdir(), 'godot-mcp-check-'));
writeFileSync(join(proj, 'project.godot'), 'config_version=5\n');
let failed = 0;
for (const f of files) {
  const r = spawnSync(godot, ['--headless', '--no-header', '--path', proj, '--check-only', '--script', f], { encoding: 'utf8', timeout: 60_000 });
  const errs = (r.stdout + r.stderr).split('\n').filter((l) => /SCRIPT ERROR|Parse Error|Compile Error/.test(l));
  if (r.status !== 0 || errs.length) {
    failed++;
    console.error(`FAIL ${f}\n${errs.join('\n') || r.stderr}`);
  } else console.log(`ok   ${f.slice(REPO.length + 1)}`);
}
rmSync(proj, { recursive: true, force: true });
console.log(`${files.length - failed}/${files.length} GDScript files parse cleanly`);
process.exit(failed ? 1 : 0);
