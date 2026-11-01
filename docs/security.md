# Security model

The godot-mcp server runs with the user's privileges. It reads and writes project files and starts Godot processes. An AI agent drives it, so every tool input is treated as untrusted.

## Trust boundaries

| Boundary | Trusted side | Untrusted side | Enforcement |
|---|---|---|---|
| MCP client → server | server | tool arguments | zod schemas with size limits; path canonicalisation; class policy; per-tool checks |
| Server → Godot worker | server | (worker output) | result read only from a private temp file; protocol version check; bounded output; timeouts |
| Server ↔ editor plugin | the user's editor process | other local processes | loopback bind, random port, 256-bit token, constant-time compare, 1 MiB messages, project-root binding |
| Project content | the user's project | — | project code runs only in explicit execution tools (see below) |

## Filesystem confinement

- **Project root.** `projectPath` is canonicalised with `realpath`. It must contain a regular `project.godot` that is not a symlink pointing outside the project.
- **`GODOT_MCP_ALLOWED_ROOTS`.** Optional; a list separated by `:` (`;` on Windows). If set, every project, every search directory and every export output must canonicalise inside one of these directories. **Recommended for all deployments.**
- **Project-relative paths.** These go through `resolveInProject`, which does three things:
  - It rejects lexical escapes: `..` segments, NUL and control characters, `user://`, URL schemes, `res:///abs`, drive letters, and `uid://` (UIDs must be resolved explicitly).
  - It resolves the realpath of the deepest existing ancestor and requires it to be inside the project, so a symlinked directory or file pointing outside is refused for both reads and writes.
  - It refuses writes to protected files: `.godot/`, `.git/`, `project.godot` (only the settings tools, through Godot), `export_presets.cfg`, `override.cfg`, `*.import` and `*.uid`. It also refuses to write through an existing symlink.
- **Worker re-check.** The GDScript worker validates every path again (defence in depth) and globalises it to confirm it stays inside `res://`.
- **Directory walks.** `list_projects` and file listings never follow symlinks and are bounded in count (the worker's walks also in depth), and `godot_uid resave` skips files that are symbolic links.

## Code execution policy

| Operation | Project code that runs |
|---|---|
| Inspection (`godot_scene_inspect`, `godot_node_inspect`, `godot_project_info`, `godot_resource_inspect`, settings get, API tools) | Loading a GDScript runs its `static var` initialisers and `_static_init()`; freeing loaded objects sends their scripts `_notification()` (`NOTIFICATION_PREDELETE`), including those of the autoload scripts it refers to. Loading a resource or scene file creates its sub-resources, so the `_init()`, setters, `_get()`, `_get_property_list()` and `_validate_property()` of scripted sub-resources run (`godot_resource_inspect`, `godot_project_validate`), and a scripted `gui/theme/custom` theme or `rendering/environment/defaults/default_environment` runs its script's `_init()` in every worker operation. The autoloads themselves never run: the worker registers their names with an inert placeholder node. |
| Script validation and inspection | Static initialisers of the loaded project scripts. |
| Unsaved source (`godot_script_validate` with `source`) | None of the supplied code. It is analysed but never compiled: a sentinel line with a guaranteed type error (and a random name) stops Godot before compilation, which is where `static var` initialisers and `_static_init()` would run. The analyzer does load what the source `preload`s or `extends`, so these must be literal `res://` paths inside the project (checked like any other path; anything else is refused before Godot starts). Preloaded `.gd` files are only parsed; preloaded scenes and resources are loaded, so their built-in scripts and `_init()` run as project code. |
| Scene and resource editing (`godot_scene_edit`, `godot_scene_create` with properties or `inherits`, `godot_resource_edit`, `godot_uid resave`) | `_init()`, `_notification()`, property setters, `_set()`/`_get()`, `_get_property_list()` and `_validate_property()` of scripts attached to nodes (or resources) in the edited file and its instanced sub-scenes and resources, including scripts that use autoloads. Such code sees each autoload as an empty placeholder node, so code that uses one fails at that point; a save that would change or lose a stored value because of it is refused (see limitations.md). `_ready`, `_process` and `_enter_tree` never run: the scene is never added to a tree, and the worker ends its process without running a frame, so nodes or callbacks that such code adds to the tree never run either (a thread it starts runs until the process ends). |
| Asset load checks (`godot_assets check`) | Instantiates every scene it is given (imported glTF and the like, but also project `.tscn` files) to count meshes, so the `_init()`, setters and notifications of their scripts run. |
| `godot_script_write` | The written script is a project file once saved: validating it loads it from disk, so its `static var` initialisers and `_static_init()` run. Refused in read-only mode. |
| `godot_assets import`, `godot_script_write` (class-cache refresh), `godot_editor_launch` | Starts the editor, which runs editor plugins and `@tool` scripts. |
| `godot_run`, `godot_screenshot`, `godot_editor play` | The game itself, including autoloads. These are explicit execution tools. |
| `godot_export`, `godot_dotnet build` | The Godot exporter / the .NET build toolchain. |

Nothing hides execution behind a read-only name. Tool annotations mark process-starting tools `openWorldHint: true`.

## Class and resource policy

- Node and resource types must be either:
  - a ClassDB class that can be instantiated, inherits the required base (`Node` or `Resource`), is not editor-only (`ClassDB.class_get_api_type`) and does not inherit a denied base (`Script`, `ScriptExtension`, `GDExtension`, `EditorPlugin`, `EditorScript`, import/export plugins, resource loaders/savers, `MainLoop`, `Thread`, JavaScript/Java bridges, `WorkerThreadPool`, `EditorSettings`); or
  - a project `class_name` from the global class registry whose native base passes the same rules.
- **Raw paths are never accepted as a type.** Regression tests cover `res://evil.gd`, `GDScript`, `EditorPlugin`, `EditorInterface` and similar inputs.
- **No implicit resource loading.** Strings are never loaded as resources implicitly. A `res://` path is loaded only for a resource-typed property, and the loaded resource must match the property's class hint. `Script` resources are refused everywhere except the dedicated `attach_script` action, which requires an existing `.gd`/`.cs` file inside the project whose base type matches the node. This fixes upstream's `add_node` behaviour, which loaded and assigned any `res://` string, including to `script`.
- **Protected properties.** `script`, `owner`, `name`, `scene_file_path` and internal (`_*`) properties cannot be set as properties.
- **Settings.** The generic settings writer only accepts an allow-list of prefixes. `autoload/`, `editor_plugins/`, `input/`, `filesystem/`, `editor/`, `dotnet/`, `application/run/main_loop_type`, `application/config/project_settings_override` and `debug/file_logging/` are refused. Autoloads and input actions have dedicated, validated operations. The plugin can only toggle `res://addons/godot_mcp/plugin.cfg`.

## Process safety

- **No shell.** `child_process.spawn` is called with argument arrays and `shell: false`. A unit test passes `$(...)` and backticks through verbatim.
- **Bounds.** Every process has a timeout (`GODOT_MCP_OP_TIMEOUT_MS`, default 120 s, or a per-tool limit), bounded stdout and stderr capture, and AbortSignal cancellation.
- **Termination.** Termination sends SIGTERM to the whole process group, then SIGKILL after a grace period. All tracked children are reaped on SIGINT, SIGTERM or stdin EOF.
- **One game per project.** Starting a game stops and awaits any game already running for the same project.
- **Request files.** Worker request and response files live in a fresh `mkdtemp` directory (owner-only) and are deleted afterwards.

## Concurrency and integrity

- **Locking.** Mutations take a per-project async lock.
- **Optimistic concurrency.** `expectedHash` (sha256, returned by inspect and edit tools) rejects stale writes.
- **Editor conflicts.** A headless write is refused if a connected editor has unsaved changes to the same scene. If the editor has the scene open with no unsaved changes, it is told to reload the tab after the write.
- **Rollback.** Scene and resource writes are verified by reloading through Godot. On failure the original bytes are restored, or a new file is deleted.
- **Script writes.** `godot_script_write` is atomic (temp file plus rename) and rolls back code that does not compile.
- **Settings backups.** `project.godot` is backed up before every settings write (the newest 10 are kept in `.godot/godot_mcp/backups/`).

## Editor bridge specifics

- **Exposure.** The plugin listens on `127.0.0.1` only and never accepts remote connections.
- **Token.** `Crypto.generate_random_bytes(32)` produces a new token on every editor start. The discovery file is owner read/write only.
- **Same-user limit.** As with any local-IPC design, other processes running as the *same OS user* can read the discovery file. The bridge does not defend against same-user malware.
- **Cross-project binding.** The client checks that the discovery file is a regular, non-symlink file whose `project_root` canonicalises to the requested project.
- **Undo.** Live edits use undo/redo, so the user can revert them.

## Known residual risks

- Project scripts can still run during the operations listed in the table above. Do not point the server at untrusted projects.
- Same-user processes can reach the editor bridge if they read the token file.

## Security regression tests

`test/unit/paths.test.ts`, `test/unit/process.test.ts`, `test/unit/bridge.test.ts`, `test/integration/security.test.ts` and `test/integration/editor.test.ts` (rejection of unauthenticated and wrong-token clients) cover:

- path traversal and symlink escapes
- invalid roots and the allowed roots
- class-name injection and script/resource injection
- protected settings and files
- export output outside the project
- oversized requests
- read-only mode
- concurrent writes and stale writes
- duplicate and retry handling
- no autoload execution
- shell metacharacters
- timeouts and cancellation
- unauthorized editor clients
