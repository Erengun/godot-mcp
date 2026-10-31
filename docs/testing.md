# Testing

All tests use Node's built-in runner (`node --test`), with TypeScript run directly through Node's type stripping (Node >= 22.18). There are no extra test frameworks.

## Commands

```bash
npm ci
npm run typecheck        # tsc on src + tests
npm run format:check     # prettier
npm run build            # tsc -> build/, asset checks
npm run check:gdscript   # parse every bundled .gd file with the real Godot parser (--check-only)
npm run test:unit        # fast, no Godot needed
npm run test:integration # builds, then runs the real server against real Godot (sequential)
npm test                 # unit + integration
npm run bench            # latency of representative operations
npm run docs:tools       # regenerate docs/mcp-tools.md from the live tools/list
```

Godot is located through `GODOT_PATH` or the usual install locations. On a desktop machine, the integration suite briefly opens Godot windows: screenshot renders and the legacy `launch_editor` round-trip, which has no headless option. Every other test runs headless. Integration tests skip with an explicit reason when Godot is missing. They never pass silently.

Useful environment variables for the tests:

- `SHOT_DIR=/some/dir` writes the screenshots taken by the fixtures to that directory.
- `KEEP_FIXTURES=1` keeps the generated fixture projects and prints their paths.

## What runs where

| Suite | File | What it proves |
|---|---|---|
| unit | `test/unit/paths.test.ts` | traversal and scheme rejection, symlink escapes (read and write), protected files, allowed roots |
| unit | `test/unit/process.test.ts` | no shell interpretation, timeouts, AbortSignal cancellation, bounded output, spawn errors |
| unit | `test/unit/diagnostics.test.ts` | Godot log parsing (script errors with file, line and stack; ANSI; noise filtering), MSBuild parsing |
| unit | `test/unit/bridge.test.ts` | editor-bridge client: discovery validation (wrong project, symlink, malformed token), auth failure, error mapping, timeouts. Uses a minimal protocol stand-in for client-side behaviour only; the real plugin is tested in `editor.test.ts`. |
| unit | `test/unit/util.test.ts` | version parsing and gating, ConfigFile reader, ring buffer, keyed mutex, config, truncation |
| integration | `protocol.test.ts` | 2026-07-28, 2025-11-25 and 2025-06-18 negotiation over real stdio; tools/list on both eras; input validation; structured errors; resources and templates; cancellation kills Godot |
| integration | `security.test.ts` | no autoload execution, traversal, symlink escape, allowed roots, class and script injection, protected settings and files, export output confinement, oversized requests, read-only mode, concurrent writes, stale writes, duplicates and retries |
| integration | `scenes.test.ts` | create, add, properties, persistence and reload, atomic batches, suggestions, rename, reparent with global transform, reorder, duplicate, instancing without flattening, cyclic refusal, editable children, inherited scenes, UID and external-reference preservation, signals with arity checks, dry run, save-as, pagination |
| integration | `scripts-runtime.test.ts` | analyzer errors with lines, autoload handling, unsaved source, reflection, atomic write and rollback, healthy run, runtime script error with file and line, crash exit code, timeout kill, restart and stop, legacy runtime tools |
| integration | `fixture-2d-platformer.test.ts` | **Fixture A** (below) |
| integration | `fixture-3d-rts.test.ts` | **Fixture B** |
| integration | `fixture-ui-preserve.test.ts` | **Fixture C** and **Fixture D** |
| integration | `editor.test.ts` | real headless Godot editor with the plugin: install and enable, launch and connect, rejection of unauthenticated and wrong-token clients, undoable live edits, refusal of headless writes when the editor has unsaved changes, wrong-tab guard, save, editor reload after a headless write, selection, play and stop, reload with consent |
| integration | `project-assets.test.ts` | project discovery, settings and backups, autoloads, broken-reference and broken-script detection, ClassDB reflection and cache, UIDs and re-save, import and load checks of real and corrupt PNGs, export preset check and a **real Linux export** (when templates exist), honest .NET capability reporting |
| integration | `coverage-extra.test.ts` | disconnect, detach, group removal, animation removal, method and rotation tracks, GridMap clear, backup pruning, screenshot camera selection, the 0.x legacy round-trip (`create_scene` → `add_node` → `load_sprite` → `save_scene` → `export_mesh_library` → `launch_editor`) |

### End-to-end fixtures (built only through MCP tool calls)

- **A — 2D platformer.**
  - Built from generated PNGs, imported through Godot: InputMap actions, a TileSet with collision, SpriteFrames, a player with collision, Camera2D limits, AnimationPlayer (two animations plus a key edit), an AnimatedSprite2D, a movement script, and a TileMapLayer level with the player instanced.
  - **Run check:** the player must fall and land on the TileMap collision (`on_floor=true`, y≈148), with `idle` playing.
  - **Screenshot check:** not blank, no missing textures.
- **B — 3D RTS.**
  - Built from material resources, a reusable house scene (box body, prism roof, collision), a unit scene (capsule, CapsuleShape3D, NavigationAgent3D, a typed `command_move(target, speed)` contract and an `arrived` signal), a MeshLibrary and GridMap road, terrain, three instanced buildings (one with an editable-children roof override), a camera, a sun with shadows, a WorldEnvironment, a NavigationRegion3D, and signals checked for arity.
  - **Static check:** an incorrect call `command_move(Vector3.ZERO)` is flagged.
  - **Run check:** navigation bakes from static colliders at runtime, both units path to their targets and report `arrived` through the signal contract.
  - **Screenshot check:** ≥ 8 meshes in the camera frustum, no missing meshes.
- **C — UI.**
  - Built from a Theme, LabelSettings, a full-rect anchored Control, Margin/VBox/HBox containers, an ItemList filled at runtime, and buttons wired with persistent signals.
  - **Run check:** the handler fires with the dynamic content (`items=5`).
  - **Screenshot check:** ≥ 9 visible controls.
- **D — Preservation.**
  - Built as a multi-scene project with a shared material and shape, a script, instanced props and an inherited level.
  - **Check:** a one-property edit changes exactly one file and exactly one property line (apart from Godot's regenerated `ext_resource` ids). Inherited-scene edits leave the base untouched. A shared-resource edit changes only that file. The project validates with zero warnings.

All fixtures live in fresh `mkdtemp` directories and are deleted afterwards. User projects are never touched.

## Latest results (2026-10-31, macOS 15 / M3, Godot 4.7.2, Node 26.12)

```
npm run test:unit         tests 33  pass 33  fail 0  skipped 0
npm run test:integration  tests 89  pass 89  fail 0  skipped 0  (≈88 s)
npm run check:gdscript    15/15 GDScript files parse cleanly
npm run typecheck         OK
npm run format:check      OK
```

Screenshots produced by the fixtures were inspected by eye during development. The automated assertions are listed above; a human looking at an image is not counted as an automated test.

### Benchmark (`npm run bench`, same machine)

```
godot_status (no Godot spawn)                median      1 ms
godot_scene_inspect (501 nodes, page 200)    median    246 ms
godot_scene_edit (1 action, save+verify)     median    251 ms
godot_scene_edit (100 actions, one save)     median    246 ms
godot_api_class (uncached -> cached)         first ~253 ms, then ~1 ms
godot_project_validate (2 scenes)            median    251 ms
godot_run headless until_exit (10 frames)    median    249 ms
godot_assets import (empty project)          median  ~1.4 s
```

Each headless operation costs about 250 ms, almost all of it Godot process startup. Batching, such as 100 actions in one `godot_scene_edit`, amortises that cost. A persistent worker process would remove the per-call startup, but it would need a lifecycle and cache-invalidation design for files changed behind its back. It is deliberately not implemented: correctness was prioritised over that latency.

## Continuous integration

`.github/workflows/ci.yml` runs the whole pipeline (typecheck, format, build, GDScript parse, unit and integration tests) on four jobs:

| Job | Result (run 41190993555, commit 47fac17) |
|---|---|
| ubuntu-24.04, Godot 4.7.2 (xvfb) | unit 33/33, integration 89/89 |
| macos-14, Godot 4.7.2 | unit 33/33, integration 89/89 |
| windows-2022, Godot 4.7.2 | unit 33/33, integration 89/89 |
| ubuntu-24.04, Godot 4.8 beta 2 (non-blocking) | unit 33/33, integration 89/89 |

Screenshot tests rendered on all four. The CI machines have no export templates, so the export test there only checks that missing templates are reported; a real export has only been verified locally on macOS.

Bringing CI up exposed and fixed real Windows bugs: path containment was case-sensitive, and Windows 8.3 short paths (`RUNNER~1`) did not match canonical project roots. Test-only fixes covered CRLF checkouts and path-separator assumptions.

## Not executed

- **Platforms.** The Godot .NET build and `godot_dotnet build` have not been tested.
- **Conformance suite.** The third-party conformance suite `@hasmcp/mcp-spec-test` (cited in upstream issues #135/#136) was downloaded and inspected but **not executed**: the execution environment's permission policy blocked running externally downloaded code. To run it yourself:
  ```bash
  npx @hasmcp/mcp-spec-test@0.1.5 -c "node $(pwd)/build/index.js" --spec-version 2026-07-28
  npx @hasmcp/mcp-spec-test@0.1.5 -c "node $(pwd)/build/index.js" --spec-version 2025-11-25
  ```
