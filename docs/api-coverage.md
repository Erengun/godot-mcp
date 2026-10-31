# Godot capability coverage

States:
- **IT**: implemented and tested (an automated test against real Godot 4.7.2)
- **IU**: implemented, insufficiently tested
- **P**: partial
- **N**: not implemented
- **U**: unsupported in the tested environment
- **C**: requires user configuration

The "Evidence" column names the test file under `test/` that exercises the capability.

## MCP and server

| Capability | State | Evidence / notes |
|---|---|---|
| MCP 2026-07-28 (server/discover) over stdio | IT | integration/protocol |
| MCP 2025-11-25 / 2025-06-18 legacy handshake | IT | integration/protocol |
| MCP 2025-03-26 / 2024-11-05 | IU | SDK legacy path, not exercised |
| Structured output and structured errors | IT | all integration tests |
| Input validation (zod) | IT | protocol, security |
| Cancellation (AbortSignal → kill Godot) | IT | protocol |
| Resources and resource templates | IT | protocol |
| 0.x tool names and argument spellings | IT | coverage-extra (legacy round-trip), scripts-runtime, project-assets |
| Read-only mode | IT | security |
| Streamable HTTP transport | N | stdio only, by design (local server) |

## Projects

| Capability | State | Evidence / notes |
|---|---|---|
| Discover projects | IT | project-assets |
| Metadata (name, main scene, renderer, autoloads, input, plugins, layers, classes) | IT | project-assets, fixture A |
| Read/write allow-listed settings (with backup) | IT | project-assets, coverage-extra |
| InputMap actions (key, mouse, joypad button and axis) | IT | fixture A (key + joypad button). Mouse and axis: IU |
| Autoloads add/remove (validated) | IT | project-assets |
| Plugin inspection and enabling (own plugin only) | IT | editor |
| Project validation (load everything, deps, main scene, autoloads) | IT | project-assets, fixtures |
| Export presets and template check | IT | project-assets |
| Real export | IT | project-assets (Linux preset). Other platforms: IU |
| Downloading templates | N | not allowed by design |

## Scenes and nodes

| Capability | State | Evidence / notes |
|---|---|---|
| Inspect tree (SceneState, no script execution), pagination | IT | scenes |
| Node detail with ClassDB property metadata | IT | scenes |
| Create scene (any allowed root type, UID assigned) | IT | scenes |
| Create inherited scene | IT | scenes (header write + Godot re-save, see limitations) |
| Add / remove / rename / move (keep global transform) / reorder / duplicate | IT | scenes |
| Instantiate PackedScene (never flattened), cycle detection | IT | scenes, fixture B |
| Editable children overrides | IT | scenes, fixture B |
| Typed property edits incl. sub-resources and `{"$new"}` | IT | scenes, fixtures |
| Attach / detach scripts (base-type check) | IT | scenes, coverage-extra |
| Persistent signal connections with arity check; disconnect | IT | scenes, fixture B/C, coverage-extra |
| Groups add/remove | IT | scenes, coverage-extra |
| Dependencies / external resources / UID preservation | IT | scenes, fixture D |
| Save-as variants, dry run | IT | scenes |
| Undo/redo | IT (live editor only) | editor |
| Close scene in editor | N | `EditorInterface.close_scene` exists but is not exposed |

## 2D

| Capability | State | Evidence / notes |
|---|---|---|
| Node2D, Sprite2D (+texture), CharacterBody2D, Area2D, CollisionShape2D, Camera2D limits, CanvasLayer/Control | IT | fixture A, scenes |
| AnimatedSprite2D + SpriteFrames from a sheet | IT | fixture A |
| TileSet atlas (+full-tile collision) / TileMapLayer set/erase/fill | IT | fixture A |
| Terrain painting (`set_cells_terrain_connect`) | N | |
| CollisionPolygon2D, RigidBody2D, StaticBody2D, Light2D, GPU/CPUParticles2D, NavigationRegion2D/Agent2D | IU | generic node + property layer; not exercised in a fixture |
| Collision layers/masks as layer lists | IT | scenes, security |
| Particle process materials | IU | generic `{"$new":"ParticleProcessMaterial"}` |

## 3D

| Capability | State | Evidence / notes |
|---|---|---|
| MeshInstance3D with primitive meshes + StandardMaterial3D (file and embedded) | IT | fixture B, D |
| StaticBody3D / CharacterBody3D + CollisionShape3D | IT | fixture B |
| Camera3D, DirectionalLight3D (shadows), OmniLight3D, WorldEnvironment/Environment | IT | fixture B, D |
| NavigationRegion3D + NavigationMesh + NavigationAgent3D (runtime bake, agents arrive) | IT | fixture B |
| MeshLibrary export + GridMap set/clear | IT | fixture B, coverage-extra |
| Transforms (origin / rotation_degrees / scale; basis) | IT | fixture B, scenes |
| 3D animation tracks (rotation_3d), method tracks | IT | coverage-extra |
| ShaderMaterial / custom shaders | IU | resources can be created; shader code is written with `godot_script_write` |
| MultiMeshInstance3D, RigidBody3D, Area3D, SpotLight3D, CPU/GPUParticles3D, Skeleton3D, AnimationTree | IU | generic layer only |
| Navigation baking headless | U | needs SceneTree; runtime/editor only |
| Imported glTF/GLB scenes | IU | `godot_assets check` counts meshes and materials; no model in the fixtures |

## Animation and resources

| Capability | State | Evidence / notes |
|---|---|---|
| Animation create/replace, tracks (value, position/rotation/scale 3D, method, bezier, blend shape) | IT (value, rotation_3d, method) / IU (others) | fixture A, coverage-extra |
| Insert/remove keys, interpolation, loop mode, autoplay, libraries | IT | fixture A |
| AnimationTree parameters | IU | generic property layer |
| Resource create/edit/inspect (.tres/.res) | IT | fixtures B, D |
| Theme, LabelSettings, Environment, NavigationMesh, Shapes, Materials | IT | fixtures B, C |
| Fonts, audio, physics materials | IU | |

## Scripts

| Capability | State | Evidence / notes |
|---|---|---|
| Discover, read (inspect + source), write atomically with compile rollback | IT | scripts-runtime |
| Parse/analyzer errors with lines (arg counts, undeclared identifiers, type errors) | IT | scripts-runtime, fixture B |
| Validate unsaved source | IT | scripts-runtime, fixture B |
| Reflection: class_name, extends, methods with required args, props, signals, constants | IT | scripts-runtime |
| Autoload-aware validation | P | analyzer level only (see limitations) |
| Class cache refresh for new class_name | IT | fixture B |
| Reference-aware refactoring / rename | N | |
| GDScript LSP / warnings | N | |
| C# build diagnostics | IU / C | needs the .NET Godot build (not available) |

## Runtime and debugging

| Capability | State | Evidence / notes |
|---|---|---|
| Run project / scene, background or until-exit, quit-after, fixed fps | IT | scripts-runtime, fixtures |
| Stop / restart without orphans | IT | scripts-runtime, protocol |
| Captured stdout/stderr with cursor, bounded | IT | scripts-runtime |
| Structured script errors (file, line, function, stack) | IT | scripts-runtime |
| Crash / non-zero exit / timeout detection; health flag | IT | scripts-runtime |
| Debugger (breakpoints, DAP, remote debug) | N | |
| Input simulation | N | |

## Visual

| Capability | State | Evidence / notes |
|---|---|---|
| Real GPU screenshot of a scene (PNG) + image stats + scene facts | IT | fixtures A–C, coverage-extra (macOS/Metal) |
| Camera selection | IT | coverage-extra |
| Screenshot of an already running game window / editor viewport | N | see limitations |
| Headless screenshot | U | refused honestly |

## Assets

| Capability | State | Evidence / notes |
|---|---|---|
| List assets with import status | IT | fixture A |
| Import (`--import`) with error reporting | IT | fixture A, project-assets (corrupt PNG reported) |
| Load verification (texture size, scene mesh/material counts) | IT | fixture A, B |
| UIDs get / re-save | IT | project-assets |
| UID resolve (needs editor cache) | IU | |

## Live editor

| Capability | State | Evidence / notes |
|---|---|---|
| Authenticated loopback bridge, project binding | IT | editor, unit/bridge |
| Status, unsaved scenes, playing state | IT | editor |
| Tree, selection get/set, open/save/reload scene | IT | editor |
| Undoable set_properties / add_node / remove_node | IT | editor |
| Headless-write conflict protection + auto reload | IT | editor |
| Play / stop | IT | editor |
| Editor-side error log | IT (shape only) | editor |
| Requires plugin installed + enabled | C | `godot_editor_plugin install` |

## Platforms

| Platform | State |
|---|---|
| macOS + Godot 4.7.2 | IT (local + CI) |
| Ubuntu 24.04 + Godot 4.7.2 | IT (CI) |
| Windows Server 2022 + Godot 4.7.2 | IT (CI) |
| Ubuntu 24.04 + Godot 4.8 beta 2 | IT (CI, non-blocking job) |
| Godot .NET | U |
