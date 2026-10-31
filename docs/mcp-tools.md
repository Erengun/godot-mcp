# MCP tools reference

> Generated from the running server (`node scripts/gen-tool-docs.ts`). Do not edit by hand.

45 tools. Legacy 0.x tools (no `godot_` prefix) can be hidden with `GODOT_MCP_LEGACY_TOOLS=false`.

Every tool returns `structuredContent` plus the same data as JSON text. Failures return `isError: true` with
`structuredContent.error = { code, message, operation?, diagnostics?, context?, hints? }`. Error codes: `INVALID_ARGUMENT`, `PATH_OUTSIDE_PROJECT`, `PATH_NOT_ALLOWED`, `NOT_A_GODOT_PROJECT`, `NOT_FOUND`, `ALREADY_EXISTS`, `CLASS_NOT_ALLOWED`, `GODOT_NOT_FOUND`, `GODOT_VERSION_UNSUPPORTED`, `WORKER_FAILED`, `OPERATION_FAILED`, `TIMEOUT`, `CANCELLED`, `CONFLICT`, `PROCESS_NOT_RUNNING`, `EDITOR_NOT_CONNECTED`, `EDITOR_REJECTED`, `CAPABILITY_UNAVAILABLE`, `INTERNAL`.

## Index

- [`godot_status`](#godot_status) — Server and Godot status
- [`godot_project_list`](#godot_project_list) — Find Godot projects
- [`godot_project_info`](#godot_project_info) — Project metadata
- [`godot_project_files`](#godot_project_files) — List project files
- [`godot_project_settings`](#godot_project_settings) — Read or change project settings
- [`godot_project_validate`](#godot_project_validate) — Validate the whole project
- [`godot_scene_inspect`](#godot_scene_inspect) — Inspect a scene tree
- [`godot_node_inspect`](#godot_node_inspect) — Inspect one node
- [`godot_scene_create`](#godot_scene_create) — Create a scene
- [`godot_scene_edit`](#godot_scene_edit) — Edit a scene (batched, all-or-nothing)
- [`godot_resource_inspect`](#godot_resource_inspect) — Inspect a resource or asset
- [`godot_resource_create`](#godot_resource_create) — Create a resource file
- [`godot_resource_edit`](#godot_resource_edit) — Edit a resource file
- [`godot_resource_build`](#godot_resource_build) — Build composite resources
- [`godot_script_validate`](#godot_script_validate) — Validate GDScript
- [`godot_script_inspect`](#godot_script_inspect) — Inspect a script
- [`godot_script_write`](#godot_script_write) — Create or replace a script
- [`godot_api_search`](#godot_api_search) — Search the Godot API
- [`godot_api_class`](#godot_api_class) — Describe a Godot class
- [`godot_run`](#godot_run) — Run the project or a scene
- [`godot_stop`](#godot_stop) — Stop a running game or editor
- [`godot_runtime_output`](#godot_runtime_output) — Read game/editor output
- [`godot_runtime_status`](#godot_runtime_status) — List running sessions
- [`godot_screenshot`](#godot_screenshot) — Render a scene and capture a screenshot
- [`godot_assets`](#godot_assets) — Asset import status, import and load checks
- [`godot_export`](#godot_export) — Export presets, checks and builds
- [`godot_uid`](#godot_uid) — Resource UIDs
- [`godot_editor_launch`](#godot_editor_launch) — Launch the Godot editor
- [`godot_editor_plugin`](#godot_editor_plugin) — Install/enable the editor bridge plugin
- [`godot_editor`](#godot_editor) — Live editor operations
- [`godot_dotnet`](#godot_dotnet) — C# (.NET) project support
- [`launch_editor`](#launch_editor) — Launch editor (legacy)
- [`run_project`](#run_project) — Run project (legacy)
- [`get_debug_output`](#get_debug_output) — Get debug output (legacy)
- [`stop_project`](#stop_project) — Stop project (legacy)
- [`get_godot_version`](#get_godot_version) — Godot version (legacy)
- [`list_projects`](#list_projects) — List projects (legacy)
- [`get_project_info`](#get_project_info) — Project info (legacy)
- [`create_scene`](#create_scene) — Create scene (legacy)
- [`add_node`](#add_node) — Add node (legacy)
- [`load_sprite`](#load_sprite) — Load sprite (legacy)
- [`export_mesh_library`](#export_mesh_library) — Export MeshLibrary (legacy)
- [`save_scene`](#save_scene) — Save scene (legacy)
- [`get_uid`](#get_uid) — Get UID (legacy)
- [`update_project_uids`](#update_project_uids) — Update project UIDs (legacy)

## godot_status

**Server and Godot status** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Report the godot-mcp server version, the detected Godot executable and version (.NET or standard), active configuration (allowed roots, read-only mode, timeouts), running processes and — when projectPath is given — whether a live editor bridge is available for that project. Call this first to discover capabilities.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Absolute path of the Godot project directory (the folder containing project.godot) |

## godot_project_list

**Find Godot projects** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Find directories containing project.godot under a directory (symlinks and hidden folders are not followed; bounded depth and count).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `directory` | string | yes | Directory to search |
| `recursive` | boolean |  | Search sub-directories (default false: only the directory and its direct children) |
| `maxDepth` | integer |  | Maximum search depth when recursive (default 4) |
| `limit` | integer |  |  |

## godot_project_info

**Project metadata** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Read project metadata through Godot: name, main scene (and whether it exists), rendering method, viewport, autoloads, custom InputMap actions with their events, enabled plugins, named physics/render layers, global script classes, C# presence and file counts by kind. Read-only; runs no project code.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `includeBuiltinActions` | boolean |  | Also list ui_* input actions |

## godot_project_files

**List project files** — readOnly: true, destructive: false, idempotent: true, openWorld: false

List project files by kind (scenes, scripts, resources, textures, models, audio, fonts, other) with import status for assets. Skips .godot/, hidden folders and folders containing .gdignore. Paginated.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `kind` | "all" \| "scenes" \| "scripts" \| "resources" \| "textures" \| "models" \| "audio" \| "fonts" \| "other" |  |  |
| `contains` | string |  | Only paths containing this substring (case-insensitive) |
| `includeAddons` | boolean |  |  |
| `offset` | integer |  | Skip this many items (pagination) |
| `limit` | integer |  | Maximum items to return |

## godot_project_settings

**Read or change project settings** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Read or change project settings through Godot's ProjectSettings API.
actions:
- get: {keys?:[...], prefix?:"display/"} read values
- set: {settings:{"display/window/size/viewport_width":1280, "application/run/main_scene":"res://main.tscn"}} — only display/, rendering/, physics/, layer_names/, gui/, audio/, application/config/, application/run/main_scene and similar prefixes; autoload/, editor_plugins/, input/, filesystem/ are refused
- input_set: {action_name:"jump" (alias inputAction), events:[{type:"key",keycode:"Space"},{type:"joypad_button",button_index:"a"},{type:"mouse_button",button_index:"left"},{type:"joypad_motion",axis:"left_x",axis_value:-1}], deadzone?, replace?}
- input_remove: {action_name}
- autoload_set: {name, path, singleton?} — registers a script/scene that will run when the game starts
- autoload_remove: {name}
Writes use ProjectSettings.save() (Godot re-sorts sections and drops comments, as the editor does); a backup of project.godot is kept in .godot/godot_mcp/backups/.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "get" \| "set" \| "input_set" \| "input_remove" \| "autoload_set" \| "autoload_remove" | yes |  |
| `keys` | string[] |  |  |
| `prefix` | string |  |  |
| `settings` | object |  |  |
| `action_name` | string |  | Input action name (alias: inputAction) |
| `inputAction` | string |  |  |
| `events` | object[] |  |  |
| `deadzone` | number |  |  |
| `replace` | boolean |  |  |
| `name` | string |  | Autoload name |
| `path` | string |  | Autoload script/scene path |
| `singleton` | boolean |  |  |

## godot_project_validate

**Validate the whole project** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Load every scene, resource, script and shader through Godot (headless, no autoloads) and report: parse/compile errors with file and line, missing dependencies (broken ext_resource paths/UIDs), scenes that cannot be instantiated, missing main scene and broken autoload paths. healthy=false if anything is wrong. Note: loading scripts runs their static initialisers.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `maxFiles` | integer |  |  |
| `includeAddons` | boolean |  |  |

## godot_scene_inspect

**Inspect a scene tree** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Read a .tscn/.scn without running any of its scripts (uses PackedScene.get_state()). Returns nodes (path, type, parent, groups, script, instanced sub-scene, inheritance), signal connections and dependencies; property values on request. Paginated; narrow with node and maxDepth for big scenes. Also returns the file sha256 for use as expectedHash.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `scenePath` | string | yes | Scene file — "res://..." or a path relative to the project root |
| `node` | string |  | Only this node and its descendants |
| `maxDepth` | integer |  |  |
| `includeProperties` | boolean |  | Include stored (non-default) property values |
| `includeConnections` | boolean |  |  |
| `offset` | integer |  | Skip this many items (pagination) |
| `limit` | integer |  | Maximum items to return |

## godot_node_inspect

**Inspect one node** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Detailed view of one node stored in a scene: its stored property values, script, groups and connections, plus the editable properties its class offers (with types, enum hints and defaults from ClassDB) and its script's exported properties. Use before set_properties to learn exact property names/types. Does not run scene scripts (script reflection loads the script, which runs static initialisers only).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `scenePath` | string | yes | Scene file — "res://..." or a path relative to the project root |
| `nodePath` | string | yes | Node path relative to the scene root ("." for the root, e.g. "Player/Sprite2D") |
| `filter` | string |  | Only class properties whose name contains this |
| `includeClassProperties` | boolean |  |  |

## godot_scene_create

**Create a scene** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Create a new scene file with a root node of the given class (built-in or project class_name), or an inherited scene (inherits: "res://base.tscn"). The file is saved by Godot, reloaded and verified, and gets a UID like editor-created scenes. Refuses to overwrite unless overwrite=true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `scenePath` | string | yes | New scene file (.tscn) — "res://..." or a path relative to the project root |
| `rootType` | string |  | Root node class, e.g. Node2D, Node3D, Control, CharacterBody2D (default Node2D) |
| `rootName` | string |  | Root node name (default: PascalCase of the file name) |
| `inherits` | string |  | Create an inherited scene from this base scene instead |
| `properties` | object |  | Property name -> value. Values are converted using the property type: vectors as [x,y(,z)], colors as "#rrggbb" or [r,g,b,a], enums as int or constant name, layer masks as [1,3], resources as "res://path" or {"$new":"ClassName","properties":{...}}, transforms as {"origin":[...],"rotation_degrees":[...],"scale":[...]}. Sub-resource properties use "shape:size". |
| `overwrite` | boolean |  |  |

## godot_scene_edit

**Edit a scene (batched, all-or-nothing)** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Apply a list of edit actions to a scene file in one Godot process and save once. If any action fails nothing is written. The scene is instantiated the way the editor does (inherited scenes, instanced sub-scenes and their overrides are preserved, never flattened); the saved file is reloaded and verified, its UID is kept, and it is rolled back if verification fails. Refuses to write a scene that has unsaved changes in a connected editor. Note: attached scripts' _init() and setters run while the scene is instantiated; _ready/_process do not.

Each action is an object with "action" plus fields:
- add_node {parent=".", type, name, properties?, index?, if_exists?: "error"|"skip"}  (type: built-in Node class or project class_name; never a path)
- remove_node {node}
- rename_node {node, new_name}
- move_node {node, new_parent, index?, keep_global_transform?}
- reorder_node {node, index}
- duplicate_node {node, new_name?, parent?}
- instantiate_scene {parent, scene, name?, properties?, index?, if_exists?}  (keeps the sub-scene as an instance, never flattened)
- set_properties {node, properties}
- attach_script {node, script, properties?} / detach_script {node}
- connect_signal {from, signal, to, method, binds?, unbinds?, deferred?, one_shot?, allow_missing_method?}  (persistent; argument counts are checked against the method signature)
- disconnect_signal {from, signal, to, method}
- add_to_group / remove_from_group {node, group}
- set_editable_children {node, editable}
- animation_upsert {player, library="", name, length?, loop_mode?: none|linear|pingpong, step?, autoplay?, replace?, tracks:[{type: value|position_3d|rotation_3d|scale_3d|blend_shape|method|bezier, path:"Sprite2D:position", interpolation?, update_mode?, replace_keys?, keys:[{time, value, transition?} | {time, method, args} (method) | {time, value, in_handle, out_handle} (bezier)]}]}
- animation_remove {player, library?, name}
- animation_keys {player, library?, name, track (index or path), insert?:[keys], remove_times?:[t]}
- tilemap_set_cells {node, cells:[{coords:[x,y], source_id?, atlas_coords?, alternative?}], source_id?, atlas_coords?}
- tilemap_erase_cells {node, cells:[[x,y],...]}
- tilemap_fill_rect {node, rect:[x,y,w,h], source_id?, atlas_coords?, alternative?}
- gridmap_set_cells {node, cells:[{position:[x,y,z], item (id or name), orientation?}]} / gridmap_clear_cells {node, cells:[[x,y,z]]}
Node paths are relative to the scene root ("." = root; legacy "root/..." also accepted).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `scenePath` | string | yes | Scene file to edit — "res://..." or a path relative to the project root |
| `actions` | object[] | yes |  |
| `dryRun` | boolean |  | Validate and apply in memory but do not save |
| `saveAs` | string |  | Save the result to a different file instead of overwriting |
| `expectedHash` | string |  | Optional sha256 of the file as last read (returned by inspect/edit tools). The write is refused if the file changed since. |

## godot_resource_inspect

**Inspect a resource or asset** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Load any resource through Godot (.tres/.res, imported textures, models, audio, fonts, scenes) and describe it: class, stored properties (embedded sub-resources expanded to `depth`), UID, dependencies and type-specific facts (texture size, mesh surfaces/AABB, animation tracks, TileSet sources, MeshLibrary items, audio length). Fails clearly if the asset is not imported.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `path` | string | yes | Resource file — "res://..." or a path relative to the project root |
| `depth` | integer |  |  |

## godot_resource_create

**Create a resource file** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Create a .tres/.res of any instantiable Resource class (StandardMaterial3D, ShaderMaterial, BoxMesh, CapsuleShape3D, RectangleShape2D, Theme, Environment, PhysicsMaterial, NavigationMesh, Animation, Gradient, Curve, LabelSettings, ...) with typed properties, then reload and verify it. Script and editor classes are refused. Nested resources: {"$new":"Class","properties":{...}}.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `path` | string | yes | New resource file (.tres or .res) — "res://..." or a path relative to the project root |
| `type` | string | yes | Resource class name |
| `properties` | object |  | Property name -> value. Values are converted using the property type: vectors as [x,y(,z)], colors as "#rrggbb" or [r,g,b,a], enums as int or constant name, layer masks as [1,3], resources as "res://path" or {"$new":"ClassName","properties":{...}}, transforms as {"origin":[...],"rotation_degrees":[...],"scale":[...]}. Sub-resource properties use "shape:size". |
| `overwrite` | boolean |  |  |

## godot_resource_edit

**Edit a resource file** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Set typed properties on an existing .tres/.res and save it (UID preserved, reloaded and verified, rolled back on failure). Imported assets (textures, models) are not editable here — they are configured by their .import settings.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `path` | string | yes | Resource file (.tres/.res) — "res://..." or a path relative to the project root |
| `properties` | object | yes | Property name -> value. Values are converted using the property type: vectors as [x,y(,z)], colors as "#rrggbb" or [r,g,b,a], enums as int or constant name, layer masks as [1,3], resources as "res://path" or {"$new":"ClassName","properties":{...}}, transforms as {"origin":[...],"rotation_degrees":[...],"scale":[...]}. Sub-resource properties use "shape:size". |
| `expectedHash` | string |  | Optional sha256 of the file as last read (returned by inspect/edit tools). The write is refused if the file changed since. |

## godot_resource_build

**Build composite resources** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Build native composite resources from assets:
- tileset_atlas {path, texture, tileSize:[w,h], margins?, separation?, tiles?:[[x,y]...], collision?: "full", collisionTiles?:[[x,y]...], collisionLayer?} -> TileSet with a TileSetAtlasSource (and optional full-tile collision polygons on physics layer 0)
- sprite_frames {path, texture, frameSize:[w,h], animations:[{name, frames:[0,1,2], fps?, loop?}]} -> SpriteFrames for AnimatedSprite2D/3D using AtlasTexture regions
- mesh_library {path, scene, items?:[names]} -> MeshLibrary for GridMap from the root children of a 3D scene (mesh, material override and collision shapes)
Textures must be imported (see godot_assets).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `kind` | "tileset_atlas" \| "sprite_frames" \| "mesh_library" | yes |  |
| `path` | string | yes | Output resource (.tres/.res) — "res://..." or a path relative to the project root |
| `texture` | string |  |  |
| `tileSize` | integer[] |  |  |
| `margins` | integer[] |  |  |
| `separation` | integer[] |  |  |
| `tiles` | integer[][] |  |  |
| `collision` | "none" \| "full" |  |  |
| `collisionTiles` | integer[][] |  |  |
| `collisionLayer` | integer |  |  |
| `frameSize` | integer[] |  |  |
| `animations` | object[] |  |  |
| `scene` | string |  |  |
| `items` | string[] |  |  |
| `overwrite` | boolean |  |  |

## godot_script_validate

**Validate GDScript** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Compile GDScript with Godot's own parser/analyzer and return errors with file and line (wrong argument counts, undeclared identifiers, type errors the analyzer can prove, bad syntax). Pass paths, all=true for every script, or source (unsaved text). Headless limitation: identifiers that refer to autoload singletons cannot be resolved and are reported as info notes, not errors. C# files are skipped (use godot_dotnet).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `paths` | string[] |  |  |
| `all` | boolean |  |  |
| `includeAddons` | boolean |  |  |
| `source` | string |  | Unsaved GDScript source to validate |
| `sourcePath` | string |  | Label used for diagnostics when validating source |

## godot_script_inspect

**Inspect a script** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Reflect a script through Godot: class_name, extends, base script, tool mode, methods with typed arguments and required-argument counts, properties (exported or not), signals with arguments, constants, dependencies; optionally the source text. Loading the script runs its static initialisers only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `path` | string | yes | Script file — "res://..." or a path relative to the project root |
| `includeSource` | boolean |  |  |

## godot_script_write

**Create or replace a script** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Write a .gd, .gdshader, .gdshaderinc or .cs file inside the project (atomic replace), then validate GDScript with Godot. By default a GDScript that fails to compile is rolled back to the previous content (or deleted if it was new) and the errors are returned; pass keepOnError=true to keep it. Use expectedHash to avoid overwriting concurrent changes. When the script declares a new class_name (or refers to a class_name Godot has not registered yet) the global class cache is refreshed with the editor importer (`--import`, which runs editor plugins) so other scripts can use the type; disable with refreshClassCache: "never".

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `path` | string | yes | Script file — "res://..." or a path relative to the project root |
| `content` | string | yes |  |
| `overwrite` | boolean |  | Allow replacing an existing file (default false) |
| `keepOnError` | boolean |  |  |
| `refreshClassCache` | "auto" \| "always" \| "never" |  |  |
| `expectedHash` | string |  | Optional sha256 of the file as last read (returned by inspect/edit tools). The write is refused if the file changed since. |

## godot_api_search

**Search the Godot API** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Search classes of the installed Godot build via ClassDB (plus the project's class_name scripts): filter by name substring, kind (node/resource) and base class. Shows whether each class can be created through MCP tools. Use it to discover node/resource types instead of guessing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Project whose class_name scripts should be included (optional) |
| `query` | string |  |  |
| `kind` | "any" \| "node" \| "resource" \| "object" |  |  |
| `inherits` | string |  | Only classes inheriting this one (e.g. CollisionObject3D) |
| `includeEditor` | boolean |  |  |
| `limit` | integer |  |  |

## godot_api_class

**Describe a Godot class** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Reflect one class of the installed Godot build (ClassDB): inheritance chain, properties (type, hints/enum values, defaults), methods (argument types, defaults), signals, enums and constants; or a project class_name script. Use filter to narrow, includeInherited for members of base classes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Needed only for project class_name scripts |
| `className` | string | yes |  |
| `filter` | string |  |  |
| `includeInherited` | boolean |  |  |
| `sections` | "properties" \| "methods" \| "signals" \| "enums" \| "constants"[] |  |  |
| `includeVirtual` | boolean |  |  |

## godot_run

**Run the project or a scene** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Start the game (main scene or a specific scene) as a tracked process with captured stdout/stderr and parsed engine/script errors. mode "background" returns after startupWaitMs with early errors (detects startup failures); mode "until_exit" waits for the game to quit (use quitAfterFrames for automated runs) or kills it after timeoutMs, then reports. healthy=false when script/engine errors occurred, the process crashed, or it timed out. Any game already running for this project is stopped first. headless=true runs without a window (no rendering).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `scene` | string |  | Scene to run instead of the main scene |
| `headless` | boolean |  |  |
| `mode` | "background" \| "until_exit" |  |  |
| `timeoutMs` | integer |  |  |
| `quitAfterFrames` | integer |  |  |
| `startupWaitMs` | integer |  |  |
| `fixedFps` | integer |  |  |
| `resolution` | string |  |  |
| `debugCollisions` | boolean |  |  |
| `debugNavigation` | boolean |  |  |

## godot_stop

**Stop a running game or editor** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Terminate a session started by godot_run or godot_editor_launch (latest game by default). The process group gets SIGTERM, then SIGKILL after a grace period. Output remains readable afterwards.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string |  |  |
| `kind` | "game" \| "editor" |  |  |

## godot_runtime_output

**Read game/editor output** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Read captured output of a session with a cursor: pass since=<nextSeq from the previous call> to get only new lines. diagnosticsOnly returns parsed errors/warnings (type, message, res:// file, line, function, GDScript stack). Output is bounded (GODOT_MCP_MAX_LOG_LINES); droppedLines tells how much was discarded.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string |  |  |
| `kind` | "game" \| "editor" |  |  |
| `since` | integer |  |  |
| `limit` | integer |  |  |
| `stream` | "stdout" \| "stderr" \| "both" |  |  |
| `diagnosticsOnly` | boolean |  |  |

## godot_runtime_status

**List running sessions** — readOnly: true, destructive: false, idempotent: true, openWorld: false

List game and editor sessions started by this server (running and recently ended), with exit codes, error counts and health.

_No parameters._

## godot_screenshot

**Render a scene and capture a screenshot** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Run a scene (default: the main scene) in a new Godot process with the real GPU renderer for N frames, capture the viewport and return the PNG plus objective checks: image statistics (blank detection, colour variety) and scene facts (meshes/sprites missing resources, meshes inside the camera frustum, active cameras, lights). The scene's scripts and the project's autoloads run, as in the game. This renders a fresh instance; it does not capture an already-running game window. Requires a display (not available in headless CI without xvfb).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `scene` | string |  |  |
| `frames` | integer |  | Frames to run before capturing (default 10) |
| `width` | integer |  |  |
| `height` | integer |  |  |
| `camera` | string |  | Make this Camera2D/Camera3D (node path in the scene) current before capturing |
| `savePath` | string |  | Also save the PNG inside the project at this path |
| `timeoutMs` | integer |  |  |

## godot_assets

**Asset import status, import and load checks** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Asset pipeline:
- list {kind?, offset?, limit?}: importable assets (textures, models, audio, fonts) with .import status (importer, resource type, UID, validity)
- import {timeoutMs?}: run the editor importer headlessly (`godot --headless --import`) so new/changed assets become loadable; returns import errors. This starts the editor, which runs the project's editor plugins and @tool scripts.
- check {paths:[...]}: load assets through Godot and report class, texture size, model node/mesh/material counts, audio length — proves the asset actually loads (not just that the file exists).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "list" \| "import" \| "check" | yes |  |
| `kind` | "textures" \| "models" \| "audio" \| "fonts" \| "all" |  |  |
| `paths` | string[] |  |  |
| `timeoutMs` | integer |  |  |
| `offset` | integer |  | Skip this many items (pagination) |
| `limit` | integer |  | Maximum items to return |

## godot_export

**Export presets, checks and builds** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Export workflow:
- presets: list presets from export_presets.cfg
- check {preset}: verify the preset exists and export templates for this Godot version/platform are installed (no download is ever performed)
- export {preset, outputPath, debug?}: run `godot --headless --export-release|--export-debug` and verify the output file was produced. outputPath must be inside the project (e.g. build/game.x86_64) or inside GODOT_MCP_ALLOWED_ROOTS.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "presets" \| "check" \| "export" | yes |  |
| `preset` | string |  |  |
| `outputPath` | string |  |  |
| `debug` | boolean |  |  |
| `timeoutMs` | integer |  |  |

## godot_uid

**Resource UIDs** — readOnly: false, destructive: false, idempotent: false, openWorld: false

UID utilities (Godot 4.4+):
- get {path}: UID of a scene/resource/script (from the header, .uid sidecar or UID cache)
- resolve {uid}: path for a uid:// (needs the editor-built UID cache)
- resave: re-save every .tscn/.tres through Godot so references and UIDs are written in the current format, keeping each file's UID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "get" \| "resolve" \| "resave" | yes |  |
| `path` | string |  |  |
| `uid` | string |  |  |
| `includeAddons` | boolean |  |  |

## godot_editor_launch

**Launch the Godot editor** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Open the project in the Godot editor as a tracked process (output captured; startup errors reported instead of a blind "launched" message). Optionally wait for the godot-mcp bridge plugin to come online so godot_editor can be used immediately.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `waitForBridgeMs` | integer |  |  |
| `headless` | boolean |  | Run the editor without a window (automation/CI); the bridge still works |

## godot_editor_plugin

**Install/enable the editor bridge plugin** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Manage the godot-mcp editor plugin (addons/godot_mcp) that provides live, undoable editor access:
- status: installed version, bundled version, enabled flag, bridge reachability
- install {enable?=true, overwrite?}: copy the addon into the project (only addons/godot_mcp is written) and add it to editor_plugins/enabled. Restart or open the editor afterwards; enabling while the editor is open may be overwritten by the editor — enable it in Project Settings > Plugins instead.
- enable / disable: toggle the plugin in project.godot

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "status" \| "install" \| "enable" \| "disable" | yes |  |
| `enable` | boolean |  |  |
| `overwrite` | boolean |  |  |

## godot_editor

**Live editor operations** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Operate on the project currently open in the Godot editor through the bridge plugin (loopback, token-authenticated; the connection is bound to this exact project path). Mutations go through the editor's undo/redo history and leave the scene marked unsaved until save_scene.
actions: status | tree {maxDepth?, includeProperties?} | selection_get | selection_set {nodes:[paths]} | open_scene {scene} | save_scene {scene?} | reload_scene {scene, discardUnsaved?} | set_properties {node, properties, scene?} | add_node {parent?, type, name, properties?, scene?} | remove_node {node, scene?} | scan {files?} | play {scene?: "main"|"current"|path} | stop | errors {sinceMs?}
Pass scene to guard against editing the wrong open tab.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "status" \| "tree" \| "selection_get" \| "selection_set" \| "open_scene" \| "save_scene" \| "reload_scene" \| "set_properties" \| "add_node" \| "remove_node" \| "scan" \| "play" \| "stop" \| "errors" | yes |  |
| `scene` | string |  |  |
| `node` | string |  |  |
| `nodes` | string[] |  |  |
| `parent` | string |  |  |
| `type` | string |  |  |
| `name` | string |  |  |
| `properties` | object |  | Property name -> value. Values are converted using the property type: vectors as [x,y(,z)], colors as "#rrggbb" or [r,g,b,a], enums as int or constant name, layer masks as [1,3], resources as "res://path" or {"$new":"ClassName","properties":{...}}, transforms as {"origin":[...],"rotation_degrees":[...],"scale":[...]}. Sub-resource properties use "shape:size". |
| `maxDepth` | integer |  |  |
| `includeProperties` | boolean |  |  |
| `files` | string[] |  |  |
| `discardUnsaved` | boolean |  |  |
| `sinceMs` | integer |  |  |

## godot_dotnet

**C# (.NET) project support** — readOnly: false, destructive: false, idempotent: false, openWorld: true

C# support is conditional: it needs the .NET build of Godot (version string contains "mono"), the .NET SDK (`dotnet`) and a .csproj in the project.
- status: report which of these are present and whether C# features are usable
- build: `dotnet build` the project's .csproj and return compiler errors (file, line, code). Requires all prerequisites; never converts C# to GDScript or vice versa.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the Godot project directory (the folder containing project.godot) |
| `action` | "status" \| "build" | yes |  |
| `configuration` | "Debug" \| "ExportDebug" \| "ExportRelease" |  |  |
| `timeoutMs` | integer |  |  |

## launch_editor

**Launch editor (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Launch Godot editor for a specific project. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |

## run_project

**Run project (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Run the Godot project and capture output. Use get_debug_output to read it. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `scene` | string |  | Optional: specific scene to run |

## get_debug_output

**Get debug output (legacy)** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Get the current debug output and errors of the project started with run_project. (Legacy 0.x tool; prefer the godot_* tools.)

_No parameters._

## stop_project

**Stop project (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: true

Stop the currently running Godot project. (Legacy 0.x tool; prefer the godot_* tools.)

_No parameters._

## get_godot_version

**Godot version (legacy)** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Get the installed Godot version. (Legacy 0.x tool; prefer the godot_* tools.)

_No parameters._

## list_projects

**List projects (legacy)** — readOnly: true, destructive: false, idempotent: true, openWorld: false

List Godot projects in a directory. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `directory` | string |  | Directory to search for Godot projects |
| `recursive` | boolean |  | Whether to search recursively (default: false) |

## get_project_info

**Project info (legacy)** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Retrieve metadata about a Godot project. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |

## create_scene

**Create scene (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Create a new Godot scene file (root node named "root", as in 0.x). (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `scenePath` | string |  | Path where the scene file will be saved (relative to project) |
| `scene_path` | string |  | Alias of scenePath |
| `rootNodeType` | string |  | Type of the root node (e.g., Node2D, Node3D) |
| `root_node_type` | string |  | Alias of rootNodeType |

## add_node

**Add node (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Add a node to an existing scene. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `scenePath` | string |  | Path to the scene file (relative to project) |
| `scene_path` | string |  | Alias of scenePath |
| `parentNodePath` | string |  | Path to the parent node (e.g., "root" or "root/Player") |
| `parent_node_path` | string |  | Alias of parentNodePath |
| `nodeType` | string |  | Type of node to add (e.g., Sprite2D, CollisionShape2D) |
| `node_type` | string |  | Alias of nodeType |
| `nodeName` | string |  | Name for the new node |
| `node_name` | string |  | Alias of nodeName |
| `properties` | object |  | Optional properties to set on the node |

## load_sprite

**Load sprite (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Load a texture into a Sprite2D, Sprite3D or TextureRect node. The texture must be imported. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `scenePath` | string |  | Path to the scene file (relative to project) |
| `scene_path` | string |  | Alias of scenePath |
| `nodePath` | string |  | Path to the Sprite2D node (e.g., "root/Player/Sprite2D") |
| `node_path` | string |  | Alias of nodePath |
| `texturePath` | string |  | Path to the texture file (relative to project) |
| `texture_path` | string |  | Alias of texturePath |

## export_mesh_library

**Export MeshLibrary (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Export a scene as a MeshLibrary resource. (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `scenePath` | string |  | Path to the scene file (.tscn) to export |
| `scene_path` | string |  | Alias of scenePath |
| `outputPath` | string |  | Path where the mesh library (.res) will be saved |
| `output_path` | string |  | Alias of outputPath |
| `meshItemNames` | string[] |  | Optional: names of specific mesh items to include (defaults to all) |
| `mesh_item_names` | string[] |  |  |

## save_scene

**Save scene (legacy)** — readOnly: false, destructive: true, idempotent: false, openWorld: false

Re-save a scene file through Godot, optionally to a new path (variant). (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `scenePath` | string |  | Path to the scene file (relative to project) |
| `scene_path` | string |  | Alias of scenePath |
| `newPath` | string |  | Optional: new path to save the scene to |
| `new_path` | string |  | Alias of newPath |

## get_uid

**Get UID (legacy)** — readOnly: true, destructive: false, idempotent: true, openWorld: false

Get the UID for a specific file in a Godot project (Godot 4.4+). (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |
| `filePath` | string |  | Path to the file (relative to project) |
| `file_path` | string |  | Alias of filePath |

## update_project_uids

**Update project UIDs (legacy)** — readOnly: false, destructive: false, idempotent: false, openWorld: false

Update UID references in a Godot project by resaving resources (Godot 4.4+). (Legacy 0.x tool; prefer the godot_* tools.)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string |  | Path to the Godot project directory |
| `project_path` | string |  | Alias of projectPath |

## Resources

- `godot://docs/value-encoding` — How godot-mcp converts JSON to Godot property values and back
- `godot://server/status` — godot-mcp and Godot installation status
- `godot://runtime/sessions` — Game and editor processes started by this server
- `godot://api/class/{className}` (template) — ClassDB reflection (properties, methods, signals, enums) of an engine class in the installed Godot build
