# Known limitations

This page lists what godot-mcp 2.0 does not do, does only partly, or does with caveats. Each entry says why.

## Engine and headless constraints

- **Scene editing runs some script code.** Headless editing instantiates the scene, so the `_init()` and property setters of attached scripts run. `_ready`, `_process` and tree callbacks do not run, and autoloads never run. Loading any GDScript also runs its `static var` initialisers and `_static_init()`. If you need zero execution, use the live editor bridge, which uses the editor's placeholder instances for non-tool scripts.
- **Scripts that use autoload singletons.** The headless worker does not register autoload globals.
  - Godot's analyzer still resolves autoload types from ProjectSettings, so parse, type and argument-count errors are still reported. Only the final compile step fails ("Identifier not found: X"), and that failure is reported as an `info` note rather than an error. Errors that only the compiler would report after that point are not checked headlessly; the result marks this as `partial`.
  - `attach_script` attaches such a script *by reference* through a compiled stand-in that owns the same path. The saved scene points at the real file. In the same batch, the script's exported properties and methods are not available to later actions, so use a second `godot_scene_edit` call or `allow_missing_method`.
- **Inherited scenes can't be created through the public API.** Packing a `GEN_EDIT_STATE_MAIN_INHERITED` instance flattens it. `godot_scene_create {inherits}` therefore writes the minimal documented `.tscn` header (`instance=ExtResource`) and then has Godot load, re-pack, re-save and verify it.
- **UIDs in references.** Outside the editor, Godot's text saver writes `[ext_resource]` lines without the `uid="…"` attribute. After every save, the worker re-inserts the UID of each referenced file. Only that attribute is inserted; the result is re-verified. The worker also registers all project UIDs at startup, so `uid://` references resolve without an editor-built cache.
- **Ext-resource ids get renumbered.** Godot regenerates `ext_resource` ids (`id="1_abcd"`) when it re-saves a scene. Semantic content is preserved, but the text diff of an edited scene includes those id changes. Fixture D verifies that nothing else changes.
- **`ProjectSettings.save()`** re-sorts sections, drops comments in `project.godot` and writes `config/features` for the running engine version, the same as saving in the editor. A backup is kept in `.godot/godot_mcp/backups/`.
- **Class cache refresh starts the editor.** New `class_name` scripts need the global class cache. `godot_script_write` refreshes it automatically with `godot --headless --import`, which starts the editor and runs editor plugins and `@tool` scripts. Turn this off with `refreshClassCache: "never"`.
- **Navigation meshes are not baked headlessly.** Baking needs a SceneTree and the NavigationServer. Bake at runtime (`NavigationRegion3D.bake_navigation_mesh`, see Fixture B) or in the editor.

## Visual capture

- **No capture of an already-running game.** `godot_screenshot` renders the scene in a *fresh* process with the GPU renderer. Capturing the window of a game started earlier, or the editor viewport, would need cooperation from inside that process (an injected autoload or the debugger protocol), and that is not implemented.
- **A display is required.** Headless Linux CI needs `xvfb-run` or a similar virtual display. Without one, the tool returns `CAPABILITY_UNAVAILABLE` and never produces a fake image.
- **Visual checks are partial.** The automated checks are a blank-image check, colour variety, missing meshes or textures, meshes inside the camera frustum and the presence of cameras and lights. Judging aesthetic quality requires looking at the returned image.

## Debugging

- **Log-based diagnostics only.** Runtime diagnostics are parsed from Godot's console output: `SCRIPT ERROR`, `ERROR`, `WARNING`, `USER ERROR` and `SHADER ERROR`, with `at:` locations and GDScript backtraces.
- **No debugger integration.** The GDScript Debug Adapter Protocol, the remote debugger protocol and the language server are **not** integrated. Breakpoints, stepping and variable inspection are not available.
- **No `-d` flag.** Games are started without `-d`, because the stdout debugger blocks on stdin at the first error.

## Live editor bridge

- **Plugin required.** The bridge only works after the plugin is installed and enabled in the project and the editor has been (re)started. If you enable it while the editor is already running, the editor may overwrite the setting.
- **Limited live operations.** Live operations cover status, tree, selection, open, save and reload of scenes, `set_properties`, `add_node`, `remove_node`, filesystem scan, play and stop, and editor-side errors. Batched structural edits (reparent, instancing, animation, TileMap) are headless-only.
- **Same-user access.** Other processes running as the same OS user can read the token file (see security.md).

## Platform and version coverage

- **Tested environment.** Only macOS (Apple Silicon) with Godot 4.7.2 standard has been tested. Linux and Windows code paths exist (process groups, Godot locations, export template locations), but they have not been executed. On Windows, path containment is case-sensitive.
- **Godot 4.8 beta 2.** Not tested; it was not installed, and downloading it was not authorised. No 4.8-only API is used.
- **Godot < 4.5.** Not supported. The worker relies on `Logger` / `OS.add_logger`, which arrived in 4.5.
- **C# / .NET.** `godot_dotnet build` (`dotnet build` plus MSBuild diagnostics) is implemented but unverified, because no Godot .NET build was available. C# scripts are skipped by GDScript validation, and reflection is GDScript-only.

## Not implemented

- **Input and gameplay automation.** There is no simulated input or automated gameplay driving beyond the project's own scripts and `--quit-after`.
- **3D asset pipelines.** glTF / Skeleton3D / AnimationTree authoring is not covered. Generic property editing works on these nodes, but no dedicated workflows exist or have been tested.
- **Shader-specific tooling.** `.gdshader` files can be written and validated as resources, but there is no shader-specific parse report.
- **Third-party plugin APIs.** Not covered.
- **Main scene required.** `godot_project_validate` reports a missing main scene as an error, so library-style projects without a main scene read as unhealthy.
