# Godot MCP

[![Github-sponsors](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#EA4AAA)](https://github.com/sponsors/Coding-Solo)

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)

[![](https://img.shields.io/github/last-commit/Coding-Solo/godot-mcp 'Last Commit')](https://github.com/Coding-Solo/godot-mcp/commits/main)
[![](https://img.shields.io/github/stars/Coding-Solo/godot-mcp 'Stars')](https://github.com/Coding-Solo/godot-mcp/stargazers)
[![](https://img.shields.io/github/forks/Coding-Solo/godot-mcp 'Forks')](https://github.com/Coding-Solo/godot-mcp/network/members)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)


```text
                           (((((((             (((((((
                        (((((((((((           (((((((((((
                        (((((((((((((       (((((((((((((
                        (((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((
         (((((      (((((((((((((((((((((((((((((((((((((((((      (((((
       (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
     ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
    ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
      (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
        (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((@@@@@@@(((((((((((((((((((((((((((@@@@@@@(((((((((((
         (((((((((@@@@,,,,,@@@(((((((((((((((((((((@@@,,,,,@@@@(((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         (((((((((@@@,,,,,,,@@((((((((@@@@@((((((((@@,,,,,,,@@@(((((((((
         ((((((((((((@@@@@@(((((((((((@@@@@(((((((((((@@@@@@((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         @@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@
         ((((((((( @@@(((((((((((@@(((((((((((@@(((((((((((@@@ (((((((((
         (((((((((( @@((((((((((@@@(((((((((((@@@((((((((((@@ ((((((((((
          (((((((((((@@@@@@@@@@@@@@(((((((((((@@@@@@@@@@@@@@(((((((((((
           (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
              (((((((((((((((((((((((((((((((((((((((((((((((((((((
                 (((((((((((((((((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((


                          /$$      /$$  /$$$$$$  /$$$$$$$
                         | $$$    /$$$ /$$__  $$| $$__  $$
                         | $$$$  /$$$$| $$  \__/| $$  \ $$
                         | $$ $$/$$ $$| $$      | $$$$$$$/
                         | $$  $$$| $$| $$      | $$____/
                         | $$\  $ | $$| $$    $$| $$
                         | $$ \/  | $$|  $$$$$$/| $$
                         |__/     |__/ \______/ |__/
```

A Model Context Protocol (MCP) server for interacting with the Godot game engine.

## Introduction

Godot MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents work with real **Godot 4** projects. Agents can use it to:

- inspect scenes, nodes, resources, scripts and the engine API;
- author 2D and 3D content: nodes, typed properties, instanced and inherited scenes, signals, groups, animations, TileMapLayers, GridMaps, materials and other resources;
- validate scripts and whole projects with Godot's own parser;
- run the game and read structured errors;
- render real screenshots;
- import assets and export builds;
- edit the scene that is currently open in the editor, with undo, through an optional editor plugin.

Version 2.0 is a rewrite on top of the official MCP TypeScript SDK v2. It supports MCP 2026-07-28 and 2025-era clients. See [docs/architecture.md](docs/architecture.md) for the design, [docs/security.md](docs/security.md) for the security model and [docs/limitations.md](docs/limitations.md) for what it does not do.

> **Status: 2.0.0-dev, NOT released.** Version 2.0 is **not on npm**. `npx godot-mcp` installs the old 0.x release. To use 2.0, install it from source (below).
> Only macOS with Godot 4.7.2 has been tested; see [docs/compatibility.md](docs/compatibility.md).
> The `feat/production-grade-mcp` branch named below is not on the remote yet. The source-install steps work only after that branch has been committed and pushed.

## Features (tools)

| Area | Tools |
|---|---|
| Discovery | `godot_status`, `godot_project_list`, `godot_project_info`, `godot_project_files`, `godot_api_search`, `godot_api_class` |
| Scenes | `godot_scene_inspect`, `godot_node_inspect`, `godot_scene_create`, `godot_scene_edit` (23 batched, all-or-nothing actions: nodes, properties, instancing, scripts, signals, groups, animation, TileMapLayer, GridMap) |
| Resources | `godot_resource_inspect`, `godot_resource_create`, `godot_resource_edit`, `godot_resource_build` (TileSet atlas, SpriteFrames, MeshLibrary) |
| Scripts | `godot_script_validate`, `godot_script_inspect`, `godot_script_write` |
| Project | `godot_project_settings` (settings, InputMap, autoloads), `godot_project_validate`, `godot_uid`, `godot_assets` (list/import/check), `godot_export` |
| Runtime | `godot_run`, `godot_stop`, `godot_runtime_output`, `godot_runtime_status`, `godot_screenshot` |
| Editor | `godot_editor_launch`, `godot_editor_plugin`, `godot_editor` (live, undoable edits of the open scene) |
| C# | `godot_dotnet` (status/build; requires the Godot .NET build) |
| Legacy 0.x | `launch_editor`, `run_project`, `get_debug_output`, `stop_project`, `get_godot_version`, `list_projects`, `get_project_info`, `create_scene`, `add_node`, `load_sprite`, `export_mesh_library`, `save_scene`, `get_uid`, `update_project_uids` |

Every parameter, output and error is documented in [docs/mcp-tools.md](docs/mcp-tools.md), which is generated from the live server. Property values use natural JSON, for example `"position": [10, 20]`, `"modulate": "#ff8800"` or `"shape": {"$new": "CircleShape2D", "properties": {"radius": 8}}`. See the `godot://docs/value-encoding` resource for the full format.

## Requirements

- [Godot](https://godotengine.org/download) **4.5 or newer** (4.7.2 recommended). For C# support you need the .NET build plus the .NET SDK.
- Node.js **20 or newer**. Running the test suite needs Node 22.18 or newer.
- A display server, but only for screenshots and for windowed runs.

## Installation (from source)

```bash
git clone https://github.com/Erengun/godot-mcp.git
cd godot-mcp
git checkout feat/production-grade-mcp
npm ci
npm run build
```

### Claude Code

```bash
claude mcp add godot \
  -e GODOT_PATH=/Applications/Godot.app/Contents/MacOS/Godot \
  -e GODOT_MCP_ALLOWED_ROOTS=$HOME/GodotProjects \
  -- node /absolute/path/to/godot-mcp/build/index.js
```

### Other MCP clients (Claude Desktop, Cursor, Cline, …)

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"],
      "env": {
        "GODOT_PATH": "/Applications/Godot.app/Contents/MacOS/Godot",
        "GODOT_MCP_ALLOWED_ROOTS": "/Users/you/GodotProjects"
      }
    }
  }
}
```

### Optional: live editor bridge

1. Ask the agent to run `godot_editor_plugin` with `action: "install"`. This copies `addons/godot_mcp` into the project and enables it. You can also copy `godot/addons/godot_mcp` into the project yourself and enable it under *Project → Project Settings → Plugins*.
2. Open (or restart) the project in the Godot editor, or use `godot_editor_launch`.
3. `godot_editor` now edits the open scene live, through undo/redo. Headless edits of a scene that has unsaved changes in the editor are refused.

The bridge listens on 127.0.0.1 only and requires a random per-session token. See [docs/security.md](docs/security.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GODOT_PATH` | auto-detect | Godot executable (on macOS: `…/Godot.app/Contents/MacOS/Godot`) |
| `GODOT_MCP_ALLOWED_ROOTS` | unrestricted | `:`-separated (`;` on Windows) directories that projects must lie in. **Recommended.** |
| `GODOT_MCP_READ_ONLY` | `false` | Refuse every tool that writes files or starts processes |
| `GODOT_MCP_LEGACY_TOOLS` | `true` | Register the 14 0.x tool names |
| `GODOT_MCP_OP_TIMEOUT_MS` | `120000` | Timeout for one headless Godot operation |
| `GODOT_MCP_MAX_LOG_LINES` | `5000` | Ring-buffer size for game/editor output |
| `GODOT_MCP_MAX_RESPONSE_BYTES` | `262144` | Text payload limit (truncation is stated explicitly) |
| `GODOT_MCP_MAX_WRITE_BYTES` | `2097152` | Largest script accepted by `godot_script_write` |
| `DEBUG` | `false` | Verbose logs on stderr |

## Typical agent workflow

1. Call `godot_status` and `godot_project_info` to learn the capabilities and the project layout.
2. Call `godot_scene_inspect`, `godot_node_inspect` and `godot_api_class` to get exact node paths, property names and types.
3. Make changes with `godot_scene_edit` (batched) and `godot_resource_create`/`godot_resource_edit`, and write code with `godot_script_write`.
4. Check the work with `godot_script_validate` and `godot_project_validate`.
5. Run it with `godot_run` (`mode: "until_exit"`, `quitAfterFrames`) and look at the structured errors.
6. Capture `godot_screenshot` for visual feedback.

## Development

```bash
npm run typecheck && npm run format:check && npm run build
npm run check:gdscript      # parse all bundled GDScript with Godot
npm run test:unit
npm run test:integration    # real Godot; see docs/testing.md
```

## Upgrading from 0.x

The tool names and argument spellings (camelCase and snake_case) from 0.x still work. The behaviour changed where 0.x was unsafe or wrong:

- Paths are confined to the project, with symlink checks.
- `add_node` no longer loads arbitrary `res://` strings into properties: scripts are never loaded that way, and resources only for resource-typed properties.
- Failures are returned as errors instead of success text.
- Project autoloads no longer run during edits.
- `run_project` no longer uses `-d`.

## License

MIT. Originally created by Solomon Elias ([Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)).
