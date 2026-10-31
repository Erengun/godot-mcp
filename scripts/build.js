// Post-compile step: make the CLI entry executable. GDScript assets are
// shipped from the package's godot/ directory and resolved at runtime
// relative to build/ (see src/godot/worker.ts), so nothing is copied.
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'build', 'index.js');
if (!existsSync(entry)) {
  console.error('build/index.js missing — did tsc fail?');
  process.exit(1);
}
chmodSync(entry, 0o755);
for (const f of ['godot/worker/mcp_worker.gd', 'godot/worker/capture_runner.gd', 'godot/addons/godot_mcp/plugin.cfg']) {
  if (!existsSync(join(root, f))) {
    console.error(`missing GDScript asset: ${f}`);
    process.exit(1);
  }
}
console.log('build complete');
