/**
 * Rough latency benchmark of representative operations against real Godot.
 * Usage: npm run bench   (prints median/min/max ms per operation)
 */
import { startServer, tempProject } from '../test/helpers/mcp.ts';

const h = await startServer();
const p = tempProject('Bench');
const time = async (label: string, n: number, fn: (i: number) => Promise<unknown>) => {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(44)} median ${ms[Math.floor(n / 2)]!.toFixed(0).padStart(6)} ms   min ${ms[0]!.toFixed(0).padStart(6)}   max ${ms[n - 1]!.toFixed(0).padStart(6)}   (n=${n})`,
  );
};
await h.ok('godot_scene_create', { projectPath: p.root, scenePath: 'big.tscn', rootType: 'Node' });
await h.ok('godot_scene_edit', {
  projectPath: p.root,
  scenePath: 'big.tscn',
  actions: Array.from({ length: 500 }, (_, i) => ({ action: 'add_node', type: 'Node2D', name: `N${i}`, properties: { position: [i, i] } })),
});
await time('godot_status (no Godot spawn)', 5, () => h.ok('godot_status'));
await time('godot_scene_inspect (501 nodes, page 200)', 5, () => h.ok('godot_scene_inspect', { projectPath: p.root, scenePath: 'big.tscn' }));
await time('godot_scene_edit (1 action, save+verify)', 5, (i) =>
  h.ok('godot_scene_edit', {
    projectPath: p.root,
    scenePath: 'big.tscn',
    actions: [{ action: 'set_properties', node: 'N1', properties: { position: [i, 0] } }],
  }),
);
await time('godot_scene_edit (100 actions, one save)', 3, (i) =>
  h.ok('godot_scene_edit', {
    projectPath: p.root,
    scenePath: 'big.tscn',
    actions: Array.from({ length: 100 }, (_, k) => ({ action: 'set_properties', node: `N${k}`, properties: { rotation: i } })),
  }),
);
await time('godot_api_class (uncached -> cached)', 5, () => h.ok('godot_api_class', { className: 'Node3D' }));
await time('godot_project_validate (2 scenes)', 3, () => h.ok('godot_project_validate', { projectPath: p.root }));
await time('godot_run headless until_exit (10 frames)', 3, () =>
  h.ok('godot_run', { projectPath: p.root, scene: 'big.tscn', headless: true, mode: 'until_exit', quitAfterFrames: 10 }),
);
await time('godot_assets import (empty project)', 2, () => h.ok('godot_assets', { projectPath: p.root, action: 'import' }));
await h.close();
p.cleanup();
