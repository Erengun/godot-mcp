# Initial Architecture Audit — godot-mcp

- **Audited commit:** `1209744` (upstream `Coding-Solo/godot-mcp` `main`, "Merge pull request #99 … fix/rce-arbitrary-script-instantiation", pushed 2026-04-16)
- **Audit date:** 2026-10-31
- **Auditor environment:** macOS 15 (Darwin 24.6.0, Apple M3), Node.js v26.12.0, Godot `4.7.2.stable.official.ed1daf0bf` (`/Applications/Godot.app`). No other Godot build (4.8 beta, .NET) is installed; nothing was downloaded.
- **Method:** full read of `src/index.ts` (2221 lines) and `src/scripts/godot_operations.gd` (1186 lines), the build script and package metadata; diff review of open PRs #110, #115, #123, #124, #132, #137, #140 and issues #49, #70, #102, #106, #135, #136; targeted experiments against Godot 4.7.2 (scripts kept in the session scratchpad, results quoted below).

## 1. Dependency baseline

| Item | Audited value | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` | `0.6.0` | v1 pre-release era. Negotiates `2024-11-05` (issue #135/#136). No `server/discover`, no structured content, no output schemas. |
| `axios` | `^1.7.9` | Declared but never imported (dead dependency with advisories, issue #118). |
| `fs-extra` | `^11.2.0` | Only used by `scripts/build.js`. |
| `typescript` | `^5.3.3`, `moduleResolution: node` | Cannot resolve package `exports` subpaths (blocks SDK v2). |
| Node engine | `>=18` | SDK v2 requires `>=20`. |
| Tests | none | No `test` script, no CI workflow. |

## 2. Existing MCP tools (14)

| Tool | Implementation | Observed behaviour / defects |
|---|---|---|
| `launch_editor` | `spawn(godot, ['-e','--path',p])`, stdio piped but never drained | Returns success immediately; launch errors never reach the agent (issue #106). Undrained pipes can block the editor once the OS pipe buffer fills. |
| `run_project` | `spawn(godot, ['-d','--path',p, scene?])` | Uses `this.godotPath!` without detection. `kill()` of previous process not awaited (issue #70 race). `scene` is appended as a bare positional argument. Output arrays unbounded. |
| `get_debug_output` | returns raw `output[]/errors[]` | Unbounded, unstructured; lost once the process exits (`activeProcess=null` on exit). |
| `stop_project` | `process.kill()` | No wait for exit; no process-group cleanup. |
| `get_godot_version` | `execFile --version` | OK. |
| `list_projects` | recursive `readdirSync` | No depth/count limit; follows directory symlinks; no root restriction. |
| `get_project_info` | regex over `project.godot` | Uses `require('fs')` inside an ES module (`src/index.ts:1438`) → always throws, silently falls back to the folder name (PR #131). |
| `create_scene` | headless GDScript op | Root node renamed to literal `"root"`. |
| `add_node` | headless op, `instantiate()` (edit state disabled) + pack | `res://`-prefixed `scenePath` fails the TS existence check (`join(projectPath,'res://…')`, PR #137). Any string property starting with `res://` is passed to `load()` and assigned — including the `script` property (arbitrary script attachment). JSON arrays are not converted to `Vector2` etc. (PR #133). |
| `load_sprite` | headless op | Same `res://` existence bug. |
| `export_mesh_library` | headless op | Only inspects direct children / grandchildren. Reports success text even when "No valid meshes found" (printerr without non-zero exit). |
| `save_scene` | load → instantiate → pack → save | Re-packs with `GEN_EDIT_STATE_DISABLED`; for scenes with editable instanced children this injects spurious overrides (see §5.2). |
| `get_uid` | reads `<file>.uid` | Only works for scripts/shaders (`.uid` sidecars); scenes/resources store UIDs in their header and are reported as missing. |
| `update_project_uids` | resave all `.tscn` | Passes the absolute project path as a `res://` prefix → `res:///abs/...`, finds 0 files and reports success (issue #102). |

## 3. Architecture weaknesses

1. **Monolith.** All 14 tools, validation, process management and protocol wiring live in one 2221-line class; all Godot operations in one 1186-line GDScript file. Every handler duplicates ~40 lines of validation.
2. **Failure detection by string matching.** Success is decided by `stderr.includes('Failed to')` (`src/index.ts:1530` etc.). Several GDScript failure branches use `printerr` without `quit(1)`; and `SceneTree.quit()` does not stop script execution, so code after `quit(1)` continues and a later `quit()` resets the exit code (verified on 4.7.2 by the PR audit). Failures are routinely reported as success.
3. **JSON on argv.** Parameters are passed as one argv element (`src/index.ts:518`) — limited by OS argument length and historically broken by Windows quoting (issue #49; mitigated by the later switch to `execFile`, not re-verified on Windows).
4. **No timeouts or output bounds.** `execFileAsync` in `executeOperation` has no `timeout` and the default 1 MiB `maxBuffer`; a hanging Godot process hangs the tool call forever.
5. **No cancellation.** MCP cancellation is ignored; the child keeps running.
6. **Single global process slot** shared by run/stop/output; the editor process launched by `launch_editor` is untracked.
7. **No reflection.** Node/resource types and properties are hard-coded per tool; there is no ClassDB-driven discovery or typed value conversion.
8. **No read-only inspection.** There is no tool to read a scene tree, node properties, scripts, resources or project settings.
9. **Unstructured results.** All results are prose strings; no `structuredContent`, no output schema.
10. **Fallback to a non-existent Godot path** in non-strict mode (`src/index.ts:353-365`) — the server starts "successfully" with an invalid executable.

## 4. Security findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **High** | **Project autoload scripts execute on every headless operation**, including read-only ones such as `get_uid`. The worker `extends SceneTree`; Godot instantiates autoloads after `_init()` even when `quit()` was already called. | Experiment (4.7.2): worker that only prints and quits → output contained `AUTOLOAD _init ran` and `AUTOLOAD _ready ran`. Replacing `extends SceneTree` with `extends MainLoop` → no autoload code ran. |
| S2 | High | Path validation is `!path.includes('..')` only (`src/index.ts:207-215`): absolute paths anywhere on disk are accepted for `projectPath`, `directory`, `newPath`, `outputPath`; no realpath, no symlink check, no project-root boundary. Godot's `ResourceSaver.save('res://../x')` writes outside the project (verified 4.7.2 by the PR audit). | code read + experiment |
| S3 | High | Generic property setter loads and assigns any `res://` string (`godot_operations.gd:521-525`) — `properties: {"script": "res://evil.gd"}` attaches an arbitrary script. | code read |
| S4 | Medium | `instantiate_class` falls back to the global script class registry (registered `class_name` scripts), which is acceptable, but there is no deny-list for engine classes such as `GDScript`, `EditorScript`, `GDExtension`. | code read |
| S5 | Medium | No resource limits: unbounded stdout/stderr arrays, no timeouts, recursive directory walk with no depth/count limit (`findGodotProjects`). | code read |
| S6 | Low | Debug mode writes probe files (`res://godot_mcp_test_write.tmp`) into the user's project. | `godot_operations.gd:210-224` |
| S7 | Info | `--check-only` (used by PR #124) and plain `load()` of a GDScript run `static var` initialisers / `_static_init()`. Any "validation" built on script loading executes that code. | PR audit, verified 4.7.2 |

Security problems in open PRs (do not merge as-is): #132 interpolates user strings into generated GDScript (code injection), opens an unauthenticated op-server bound to all interfaces, lets `set_project_setting` write `autoload/*`, and claims a transactional batch that still saves after a failed op; #110 normalises before checking and *accepts* `res://../evil.tscn` (regression); #124 and #115 write PNG/exports to any absolute path; #115's GDScript does not parse on 4.7.2 (`get_tree()` in a `SceneTree` script), which would break every operation.

## 5. Godot behaviour verified for the redesign (4.7.2)

1. **`extends MainLoop` workers** load no autoloads and run no project code beyond what the operation itself loads; `SceneState` (`PackedScene.get_state()`) exposes node names, types, properties, groups, connections, instance and inheritance information without instantiating any node → used for all read-only inspection.
2. **Edit state matters.** Round-tripping `main.tscn` (instanced `derived.tscn` with editable children) through `instantiate()` (`GEN_EDIT_STATE_DISABLED`) added a spurious `[node name="Spr" parent="D"] position = Vector2(5,5)` override; `instantiate(GEN_EDIT_STATE_MAIN)` reproduced the file exactly (plus the added node). A hand-written inherited scene (`instance=ExtResource(...)` on the root) also round-trips with `GEN_EDIT_STATE_MAIN`. → every mutation uses `GEN_EDIT_STATE_MAIN`.
3. **Creating** an inherited scene cannot be done through the public API (`set_scene_inherited_state` is not exposed; packing a `GEN_EDIT_STATE_MAIN_INHERITED` instance flattens it). → inherited-scene creation writes the minimal documented `.tscn` header, then validates by loading through Godot.
4. **`Logger` + `OS.add_logger()`** (4.5+) deliver structured `(function, file, line, code, rationale, error_type)` records for parse errors and engine errors — used instead of scraping stderr in the worker.
5. **`GDScript.new(); source_code=…; reload()`** reports parse/analyzer errors (wrong argument counts, undeclared identifiers) with line numbers.
6. **Real GPU capture works** on this machine: a non-headless `--script` SceneTree that adds a scene, waits frames and reads `root.get_viewport().get_texture().get_image()` produced a correct 640×360 PNG of a lit red cube (Metal, Forward+).
7. **`JSON.from_native/to_native`** exist; the redesign uses its own explicit, type-directed codec instead because the agent-facing format must be readable and must never deserialise objects.
8. `EditorInterface.get_unsaved_scenes()`, `get_open_scenes()`, `get_edited_scene_root()`, `EditorUndoRedoManager`, `EditorSelection`, `EditorFileSystem.scan()/reimport_files()` are present in the 4.7.2 API dump (editor-only) — sufficient for the live editor bridge.

## 6. MCP protocol compliance

- Issue #135 (spec 2026-07-28): 7 failures — `server/discover` unanswered (6 items, `-32601`) and handshake settling on `2024-11-05`.
- Issue #136 (spec 2025-11-25): handshake settles outside the supported window.
- Root cause: SDK 0.6.0. Verified fix: `@modelcontextprotocol/server@2.4.0` with `serveStdio(factory)` serves both eras from one factory — an `auto`-negotiating client settles on **2026-07-28** via `server/discover`, a default (legacy) client on **2025-11-25** (in-memory transport experiment).

## 7. Test coverage gaps

No automated tests of any kind existed: no unit tests, no protocol tests, no Godot integration tests, no security regression tests, no CI.

## 8. Feature coverage matrix (at audit time)

States: **IT** implemented & tested · **IU** implemented, insufficiently tested · **P** partial · **N** not implemented · **U** unsupported by environment · **C** requires user configuration.

| Capability | State | Evidence |
|---|---|---|
| MCP 2026-07-28 / 2025-11-25 | N | SDK 0.6.0, issues #135/#136 |
| Godot detection/version | IU | `detectGodotPath`, no tests |
| Launch editor | IU (defective) | §2 |
| Run project / logs / stop | IU (defective) | §2, #70 |
| Run specific scene | IU | positional arg |
| Scene create | IU | |
| Scene inspect | N | |
| Node add | IU (unsafe) | S3 |
| Node remove/rename/reparent/reorder/duplicate | N | |
| Property edit (typed) | N | |
| Script attach / signals / groups | N | |
| Scene instancing / inheritance-safe edits | N / defective | §5.2 |
| Resources (create/inspect/edit) | N | |
| 2D: sprite texture | IU | `load_sprite` |
| 2D: collision, TileMapLayer, animation, navigation, particles, UI | N | |
| 3D: MeshLibrary export | IU | |
| 3D: meshes/materials/lights/camera/GridMap/navigation | N | |
| Script validation / symbols | N | |
| ClassDB / API discovery | N | |
| Import / asset validation | N | |
| Screenshots | N | |
| Project settings / InputMap / autoloads | N | |
| Export | N | |
| Live editor integration | N | |
| UIDs | P (defective) | #102 |
| C# / .NET | N, U here | no .NET Godot installed |
| Godot 4.8 beta | U here | not installed; downloads not authorised |
| Windows / Linux | U here | macOS host only |

## 9. Migration strategy

1. Replace SDK 0.6.0 with `@modelcontextprotocol/server` 2.4.0 (`McpServer.registerTool` with zod input/output schemas, `serveStdio` for dual-era stdio). TypeScript 6, `module/moduleResolution: nodenext`, Node ≥ 20.
2. Split the server into `security/`, `godot/` (locate, process, worker, runtime, diagnostics), `editor/` (bridge client), `tools/` (one module per family) and `resources/`.
3. Replace the monolithic SceneTree script with a `MainLoop` worker + per-domain op modules + a shared GDScript library (variant codec, class policy, scene helpers) that is reused by the editor plugin. Requests/results travel through files in a private temp directory; the result file is the only source of truth for success.
4. Keep all 14 legacy tool names and argument spellings (camelCase and snake_case) as thin adapters onto the new core.
5. Add an EditorPlugin bridge (loopback TCP, random port, per-session token in the project's `.godot/` directory) for live, undo-aware editing.
6. Build tests from day one: unit (paths, codec helpers, diagnostics parser, process runner), protocol (both eras, legacy names, validation), Godot integration (real 4.7.2) and end-to-end fixtures built through MCP calls.

## 10. Prioritised roadmap

| Priority | Item |
|---|---|
| P0 | SDK v2 + dual era; secure path layer; bounded/cancellable process runner; MainLoop worker with file protocol; legacy adapters; protocol tests |
| P1 | SceneState inspection; batched scene edits (add/remove/rename/reparent/reorder/duplicate/instance/properties/scripts/signals/groups) with backup + reload validation; typed variant codec; resource create/inspect/edit; script validate/inspect; run/stop/output with structured diagnostics; project settings, InputMap, autoloads |
| P2 | 2D/3D authoring ops (collision, TileMapLayer/TileSet, animation tracks, meshes/materials, lights, navigation, GridMap/MeshLibrary); fixtures A–D through MCP |
| P3 | EditorPlugin bridge; real-GPU screenshots; import/asset validation; export with template checks |
| P4 | Documentation, compatibility matrix, final audit; CI workflow |
