# Final implementation audit — godot-mcp 2.0.0-dev.0

- **Repository:** fork `https://github.com/Erengun/godot-mcp`, branch `feat/production-grade-mcp`, based on upstream `1209744`.
- **State:** all changes are uncommitted in the working tree. Nothing has been committed, pushed, merged or published.
- **Date:** 2026-10-31.
- **Environment:** macOS 15 (Darwin 24.6.0, Apple M3), Godot 4.7.2.stable.official.ed1daf0bf, Node v26.12.0.

## Verdict: **NOT READY FOR RELEASE**

The functionality verified on macOS + Godot 4.7.2 is substantial: 89 integration tests against real Godot, four end-to-end fixtures that run and render, and a real editor bridge. The acceptance criteria still require evidence that is missing:

1. **Platforms.** No Linux or Windows execution. The CI workflow is written but has never run.
2. **Godot versions.** No Godot 4.8 beta 2 run (not installed; downloading it was not authorised).
3. **C#.** No .NET (C#) run: `godot_dotnet build` is unverified.
4. **Third-party conformance.** The MCP conformance suite `@hasmcp/mcp-spec-test`, which reported upstream issues #135/#136, was not executed because the environment's permission policy blocked running downloaded code. Protocol behaviour is covered by our own negotiation tests only.
5. **Untested surface.** Several registered capabilities are only "implemented, insufficiently tested". `docs/api-coverage.md` lists them, for example most 2D/3D node types beyond the fixtures, bezier/blend-shape/audio tracks, mouse and joypad-axis input events, and UID resolve.

Release becomes possible once items 1–4 pass and the coverage gaps in item 5 are either tested or explicitly scoped out.

## 1. Implemented functionality (summary)

- **MCP layer.** SDK v2 (`@modelcontextprotocol/server` 2.4.0). Serves both eras over stdio: 2026-07-28 via `server/discover`, and 2025-11-25 / 2025-06-18 via `initialize`. Provides 31 `godot_*` tools, the 14 legacy tools, 3 resources and 1 resource template, structured output, structured errors, zod validation, cancellation and a read-only mode.
- **Headless worker.** A `MainLoop` worker, so autoloads never run. It takes batched operations, reports structured Logger diagnostics, inspects scenes through SceneState without running scripts, and edits scenes in `GEN_EDIT_STATE_MAIN` mode, which preserves inheritance and instancing. UIDs are preserved, saves are verified by reload, and failed writes are rolled back.
- **Authoring.**
  - Nodes: add, remove, rename, move, reorder, duplicate.
  - Scenes: instancing, editable children, inherited scenes.
  - Scripts and signals: attach/detach, signal arity checks, groups.
  - Animation: tracks, keys, loop, autoplay.
  - 2D/3D grids: TileMapLayer, TileSet atlas with collision, SpriteFrames, MeshLibrary/GridMap.
  - Resources: any allow-listed class.
  - Project: settings, InputMap, autoloads.
- **Intelligence.** ClassDB reflection with a cache. GDScript validation through Godot's analyzer, including unsaved source. Script reflection. Project-wide validation (dependencies, main scene, autoloads).
- **Runtime.** Tracked game and editor sessions with bounded, cursor-paged output and parsed diagnostics (file, line, stack). A health flag covers errors, crashes and timeouts. Restart is safe.
- **Visual.** Real GPU screenshots with blank detection and scene facts (missing meshes and textures, frustum checks, cameras, lights).
- **Assets and export.** Import status, `--import` with error reporting, load checks, UID tools, and a real export with template checks.
- **Editor bridge.** A loopback, token-authenticated plugin bound to the project root. It reports status, tree and selection; opens, saves and reloads scenes; makes undoable property, add and remove edits; plays and stops the game; returns editor errors; and drives the conflict protection for headless writes.

## 2. Initial architectural problems (see initial-architecture-audit.md)

- A monolithic 2221-line TypeScript file and a 1186-line GDScript file.
- Success was detected with `stderr.includes('Failed to')`.
- JSON was passed on argv.
- No timeouts, output bounds or cancellation.
- Autoload code ran on every operation.
- Path validation only checked for `..`.
- `add_node` loaded any `res://` string, including into `script`.
- MCP SDK 0.6.0 negotiated 2024-11-05.
- No tests.

## 3. Architectural changes

The server, worker and editor plugin are now separate components, and the GDScript library is shared between the worker and the plugin. On the TypeScript side, the new modules are:

- `security/`, `godot/`, `editor/`, `tools/*`, `resources/`;
- `context.ts`, which holds per-project locks, file guards, rollback and editor-conflict checks.

The other changes are:

- Requests and responses travel as files.
- Logger-based diagnostics replace stderr scraping.
- A type-directed value codec handles property values.
- A class allow-list policy controls which types can be instantiated.

See docs/architecture.md.

## 4. New MCP tools and resources

- **Tools:** godot_status, godot_project_list, godot_project_info, godot_project_files, godot_project_settings, godot_project_validate, godot_scene_inspect, godot_node_inspect, godot_scene_create, godot_scene_edit (23 actions), godot_resource_inspect, godot_resource_create, godot_resource_edit, godot_resource_build, godot_script_validate, godot_script_inspect, godot_script_write, godot_api_search, godot_api_class, godot_run, godot_stop, godot_runtime_output, godot_runtime_status, godot_screenshot, godot_assets, godot_export, godot_uid, godot_editor_launch, godot_editor_plugin, godot_editor, godot_dotnet.
- **Resources:** `godot://docs/value-encoding`, `godot://server/status`, `godot://runtime/sessions`, `godot://api/class/{className}`.
- **Reference:** docs/mcp-tools.md, generated from the live server.

## 5. EditorPlugin capabilities

These were verified against a real headless Godot 4.7.2 editor:

- Authentication: a client with no token or the wrong token is rejected.
- Status: project root, open scenes, unsaved scenes, playing state.
- Tree, selection get and set.
- Open, save and reload scenes; reloading a scene with unsaved changes requires `discardUnsaved`.
- Undoable `set_properties`, `add_node` and `remove_node`.
- Wrong-tab guard.
- Headless writes are refused while the editor has unsaved changes, and the editor reloads the tab after a headless write.
- Play and stop.
- Editor-side error log.

## 6. Godot versions tested

4.7.2.stable.official.ed1daf0bf (standard build, macOS universal). The following were not tested: 4.8 beta, the .NET build, versions before 4.7, and Linux or Windows builds.

## 7. MCP protocol revisions tested

- 2026-07-28: `versionNegotiation: auto`, served through `server/discover`.
- 2025-11-25: legacy client.
- 2025-06-18: client pinned through `supportedProtocolVersions`.

All three ran over real stdio against `build/index.js`.

## 8. Commands executed (final run)

```
npm run typecheck          -> exit 0
npm run format:check       -> All matched files use Prettier code style!
npm run build              -> build complete
npm run check:gdscript     -> 15/15 GDScript files parse cleanly
npm run test:unit          -> tests 33, pass 33, fail 0, skipped 0
npm run test:integration   -> tests 89, pass 89, fail 0, skipped 0 (≈88 s)
npm run bench              -> see docs/testing.md
node scripts/gen-tool-docs.ts -> 45 tools documented
```

After the suite finished, `pgrep` found no orphaned Godot processes. The only leftover temporary directory was the reflection stub; it is now per-process and removed on shutdown.

## 9. Real integration results (selected evidence)

- **Fixture A (2D platformer).** The player script printed `PLAYER_STATE y≈148 on_floor=true anim=idle` after 90 physics frames. The player fell onto TileMapLayer collision built from a generated TileSet. The 640×360 screenshot is non-blank and every Sprite2D has its texture.
- **Fixture B (3D RTS).**
  - The navigation mesh is baked at runtime from static colliders.
  - The agent path has more than 0 points.
  - `ARRIVED 2 U1,U2` was printed through the typed `arrived(unit_name)` signal, and both units ended within 1.5 m of their targets.
  - `RtsUnit.command_move(Vector3.ZERO)` is flagged statically ("Too few arguments", line 3).
  - The 960×540 screenshot shows ≥ 8 meshes in the camera frustum, 0 missing meshes, the camera `Camera` current, and lights present. Inspected visually: three houses with prism roofs (one with a blue override roof), two capsule units, a grass plane, a GridMap road and plaza, shadows and a sky colour.
- **Fixture C (UI).** Printed `UI_START_PRESSED items=5 status=5 levels`. The screenshot has ≥ 9 visible controls. Inspected visually: themed title, list of 5 levels, status label, two buttons.
- **Fixture D (preservation).**
  - A one-property edit changed exactly one file, and within it only `light_energy = 2.0 → 3.5` plus Godot's regenerated ext_resource ids.
  - An inherited-scene edit and a shared-resource edit each changed only their own file.
  - Project validation reports 0 problems.
- **Export.** A real Linux x86_64 debug export produced a binary larger than 1 MB, using the installed 4.7.2 templates.

## 10. Security findings and mitigations

| Finding (upstream) | Mitigation | Regression test |
|---|---|---|
| Autoloads executed on every op | MainLoop worker | security: "never runs autoload code" |
| `..`-only path validation; absolute paths anywhere | realpath containment, symlink checks, allowed roots, protected files | unit/paths, security |
| `res://` strings loaded into any property incl. `script` | type-directed codec, Script refusal, class hints | security |
| No class deny-list | class_policy (ClassDB API type + denied bases) | security |
| Unbounded output/no timeouts | bounded runner, timeouts, cancellation, process-group kill | unit/process, protocol, scripts-runtime |
| `-d` freezes games on error | removed | scripts-runtime |
| PR #132: unauthenticated op-server on all interfaces | bridge on 127.0.0.1, token, project binding | unit/bridge, editor |
| PR #110: normalise-then-check accepts `res://../` | reject before normalising; worker re-check | unit/paths |
| PR #124/#115: outputs to any absolute path | project/allowed-root confinement | security (export) |

## 11. Known limitations

See docs/limitations.md. The main ones:

- Headless edits run scripts' `_init()`.
- Autoload-dependent scripts get analyzer-only validation and are attached by reference.
- `[ext_resource]` UIDs are restored by rewriting the header.
- Screenshots render a fresh process.
- No debugger, LSP or input simulation.
- The class-cache refresh starts the editor.

## 12. Unfinished work and blockers

- Run the CI workflow (Linux + xvfb). Add Windows and macOS runners.
- Test Godot 4.8 beta 2 (needs authorisation to download).
- Test the .NET workflow (needs the Godot .NET build).
- Run `@hasmcp/mcp-spec-test` for 2026-07-28 and 2025-11-25 (needs permission to execute it).
- Expand tests to the IU rows in docs/api-coverage.md.
- Possible future work: a persistent worker for lower latency, a debugger/DAP bridge, input simulation, and in-game capture of a running game.

## 13. Installation and configuration

See README.md (source install, `claude mcp add`, JSON config, environment variables, editor plugin setup). 2.0 is not on npm.

## 14. Files changed

| Status | Files |
|---|---|
| Modified | `README.md`, `CONTRIBUTING.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/build.js`, `src/index.ts` |
| Removed | `src/scripts/godot_operations.gd` (replaced by `godot/worker/*`) |
| Added — TypeScript | `src/config.ts`, `src/context.ts`, `src/errors.ts`, `src/server.ts`, `src/security/paths.ts`, `src/godot/{locate,process,worker,runtime,diagnostics}.ts`, `src/editor/bridge.ts`, `src/resources/index.ts`, `src/tools/{registry,schemas,project,scene,resource,script,api,runtime,visual,assets,editor,dotnet,legacy}.ts`, `src/util/{ringBuffer,keyedMutex,hash,log,configFile}.ts` |
| Added — GDScript | `godot/worker/{mcp_worker,capture_runner}.gd`, `godot/worker/ops/{project,scene,scene_authoring,resource,script,api,asset}_ops.gd`, `godot/addons/godot_mcp/{plugin.cfg,plugin.gd,bridge_server.gd,editor_ops.gd}`, `godot/addons/godot_mcp/lib/{mcp_util,class_policy,variant_codec}.gd` |
| Added — tests | `test/helpers/{mcp,check-gdscript}.ts`, `test/unit/*.test.ts` (5 files), `test/integration/*.test.ts` (10 files) |
| Added — tooling | `scripts/{gen-tool-docs,bench}.ts`, `tsconfig.test.json`, `.prettierrc.json`, `.github/workflows/ci.yml` |
| Added — docs | `docs/{architecture,api-coverage,mcp-tools,security,compatibility,testing,limitations}.md`, `docs/audits/{initial-architecture-audit,final-implementation-audit}.md` |

## 15. Evidence supporting what *is* verified

- Every tool in the "IT" rows of docs/api-coverage.md has at least one integration test that drives the built server over real stdio against real Godot 4.7.2 and checks either the files Godot persisted or runtime output.
- Fixtures A–C combine three layers of evidence: persisted files, runtime behaviour and rendered images.
