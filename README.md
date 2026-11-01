# Godot MCP

Let AI agents inspect, build, run and screenshot real **Godot 4** projects through the [Model Context Protocol](https://modelcontextprotocol.io).

[![CI](https://github.com/Erengun/godot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Erengun/godot-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-6f42c1)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Godot 4.5+](https://img.shields.io/badge/Godot-4.5%2B-478CBF?logo=godotengine&logoColor=white)](https://godotengine.org)

> **Status: 2.0.0-dev, not released.** CI passes on Ubuntu, macOS and Windows with Godot 4.7.2, and on Ubuntu with Godot 4.8 beta 2. Version 2.0 is **not on npm**: `npx godot-mcp` installs the old 0.x release. Install from source (below). Still unverified: C# (.NET), and real exports on platforms other than macOS. The full list of what's left is in [the final audit](docs/audits/final-implementation-audit.md).

## About

Godot MCP is a local MCP server. It gives an AI agent such as Claude Code the editor-level tasks you would otherwise do by hand:

- read a scene tree;
- add a CharacterBody2D with a collision shape;
- paint a TileMap;
- wire a signal;
- check that a script compiles;
- run the game and read the errors;
- look at a rendered screenshot.

It works through Godot's own APIs, not by guessing at `.tscn` text. It edits scenes the way the editor does, checks scripts with Godot's analyzer and renders with the real GPU renderer. Every edit is verified by reloading the file in Godot afterwards.

## Why this fork?

This project started as a fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp), which proved the idea. An audit of upstream `1209744` ([details](docs/audits/initial-architecture-audit.md)) found problems that were too deep for small patches, so 2.0 is a rewrite.

**Security fixes:**
- **Project code ran on every operation.** The upstream worker instantiated the project's autoload scripts, even for read-only calls like `get_uid`. The 2.0 worker registers autoload names with an empty placeholder node, so scripts that use them still compile, but the autoloads themselves never run.
- **Any path was accepted.** Upstream only checked for `..`. In 2.0, paths are resolved through symlinks and must stay inside the project. Protected files (`.godot/`, `project.godot`, `*.import`, …) cannot be written, and you can optionally limit everything to `GODOT_MCP_ALLOWED_ROOTS`.
- **Scripts could be injected through properties.** Upstream `add_node` loaded any `"res://…"` string, so `properties: {"script": "res://evil.gd"}` attached arbitrary code. In 2.0, values are converted by the property's declared type, resources must match the property's class, and scripts only attach through a dedicated, validated action.
- **No limits on processes.** Upstream had no timeouts, output bounds or cancellation. In 2.0 every Godot process has a timeout, bounded output and AbortSignal cancellation, and it is killed by process group.
- **Unsafe open pull requests.** Several open upstream PRs add new holes:
  - an unauthenticated control socket bound to all interfaces;
  - GDScript code injection;
  - writes to any absolute path.

  2.0's editor bridge listens on `127.0.0.1` only, with a random token per session.

**Correctness and platform updates:**
- **Protocol.** Moved from SDK 0.6.0 (which negotiated MCP 2024-11-05; upstream issues #135/#136) to the official TypeScript SDK v2. 2.0 speaks MCP **2026-07-28** to new clients and 2025-11-25 / 2025-06-18 to older ones.
- **Scene integrity.** Edits no longer flatten inherited or instanced scenes, drop UIDs, or report failures as success.
- **Structured results.** Results are structured data with error codes, not prose.
- **Tested.** 89 integration tests run against real Godot on Linux, macOS and Windows, plus Godot 4.8 beta 2.

The 14 original tool names still work, so existing setups keep running. See [Upgrading from 0.x](#upgrading-from-0x).

## Features

| Area | What the agent can do |
|---|---|
| **Inspect** | Read scene trees without running scripts, node details with every property type and default, resources, scripts (methods, signals, exports), project settings, and the full engine API through ClassDB |
| **Author scenes** | 23 batched, all-or-nothing actions: add/remove/rename/move/duplicate nodes, typed properties, instance and inherit scenes, editable children, attach scripts, connect signals (argument counts are checked), groups |
| **2D / 3D** | Animations (tracks, keys, loops, autoplay), TileMapLayer and TileSet with collision, SpriteFrames, MeshLibrary and GridMap, materials, meshes, shapes, lights, environments, navigation |
| **Validate** | GDScript errors with line numbers from Godot's analyzer (also for unsaved code), whole-project checks for broken references, main scene and autoloads |
| **Run & debug** | Start the game or a scene, read output with a cursor, get structured script errors (file, line, stack), detect crashes and timeouts |
| **See** | Real GPU screenshots with automatic checks: blank image, missing meshes or textures, objects inside the camera view |
| **Assets & builds** | Import status, run the importer, verify assets actually load, UIDs, exports with template checks |
| **Live editor** | With the optional plugin: edit the scene open in the editor with undo/redo, selection, save/reload, play/stop |

All 45 tools are listed in [docs/mcp-tools.md](docs/mcp-tools.md), which is generated from the running server.

## Installation

### Requirements

- [Godot](https://godotengine.org/download) **4.5 or newer** (4.7.2 recommended). For C# you also need the .NET build and the .NET SDK.
- [Node.js](https://nodejs.org) **20 or newer**.
- A display only for screenshots and windowed runs. Everything else runs headless.

### From source

```bash
git clone https://github.com/Erengun/godot-mcp.git
cd godot-mcp
npm ci
npm run build
```

### Add it to Claude Code

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

On Windows, `GODOT_PATH` points at `Godot_v4.x-stable_win64.exe`. On Linux it points at the extracted `Godot_v4.x-stable_linux.x86_64` binary.

A Flatpak or Snap Godot runs in a sandbox with its own private `/tmp`, so it cannot read the request files the server writes to the system temp directory, and it may not see projects outside your home folder. Prefer the official binary; if you must use the sandboxed one, set `TMPDIR` (in the server's `env`) to a folder both can access, such as `~/.cache/godot-mcp`.

## Usage

Ask the agent in plain language:

> Add a player to `res://level.tscn`: a CharacterBody2D at (64, 60) with a 14×24 collision box and the sprite `res://art/player.png`, then run the scene for 90 frames and tell me if anything errors.

The agent does this with a few tools. Starting with `godot_status` and `godot_scene_inspect`, it then makes one atomic edit:

```json
{
  "tool": "godot_scene_edit",
  "arguments": {
    "projectPath": "/Users/you/GodotProjects/platformer",
    "scenePath": "res://level.tscn",
    "actions": [
      { "action": "add_node", "type": "CharacterBody2D", "name": "Player", "properties": { "position": [64, 60] } },
      { "action": "add_node", "parent": "Player", "type": "CollisionShape2D", "name": "Collision",
        "properties": { "shape": { "$new": "RectangleShape2D", "properties": { "size": [14, 24] } } } },
      { "action": "add_node", "parent": "Player", "type": "Sprite2D", "name": "Sprite",
        "properties": { "texture": "res://art/player.png" } }
    ]
  }
}
```

If any action fails, nothing is written. Values are plain JSON: Godot converts them using each property's type. That means `[64, 60]` becomes a `Vector2` and `"#ff8800"` a `Color`, `[1, 3]` becomes collision layers 1 and 3, and `{"$new": …}` creates a sub-resource. The full format is in the `godot://docs/value-encoding` resource.

A good loop for agents:
1. Run `godot_status` and `godot_project_info` to learn the capabilities and the project layout.
2. Run `godot_scene_inspect`, `godot_node_inspect` and `godot_api_class` to get exact paths, property names and types.
3. Make changes with `godot_scene_edit`, `godot_resource_create` / `godot_resource_edit` and `godot_script_write`.
4. Check them with `godot_script_validate` and `godot_project_validate`.
5. Run with `godot_run` (`mode: "until_exit"`, `quitAfterFrames`), then take a `godot_screenshot`.

### Live editor (optional)

1. Ask the agent to run `godot_editor_plugin` with `action: "install"`. This copies `addons/godot_mcp` into the project and enables it.
2. Open or restart the project in the Godot editor, or use `godot_editor_launch`.
3. `godot_editor` now edits the open scene through the editor's undo history. Headless edits are refused while that scene has unsaved changes in the editor.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GODOT_PATH` | auto-detect | Godot executable |
| `GODOT_MCP_ALLOWED_ROOTS` | unrestricted | `:`-separated (`;` on Windows) folders that projects must live in. **Recommended.** |
| `GODOT_MCP_READ_ONLY` | `false` | Refuse every tool that writes files or starts processes |
| `GODOT_MCP_LEGACY_TOOLS` | `true` | Register the 14 0.x tool names |
| `GODOT_MCP_OP_TIMEOUT_MS` | `120000` | Timeout for one headless Godot operation |
| `GODOT_MCP_MAX_LOG_LINES` | `5000` | Game/editor output kept in memory |
| `GODOT_MCP_MAX_RESPONSE_BYTES` | `262144` | Text payload limit (truncation is stated explicitly) |
| `GODOT_MCP_MAX_WRITE_BYTES` | `2097152` | Largest script accepted by `godot_script_write` |
| `DEBUG` | `false` | Verbose logs on stderr |

## Documentation

| Doc | What's in it |
|---|---|
| [mcp-tools.md](docs/mcp-tools.md) | Every tool: parameters, annotations, errors (generated) |
| [architecture.md](docs/architecture.md) | How the server, headless worker and editor plugin fit together |
| [security.md](docs/security.md) | Trust boundaries, path rules, when project code runs |
| [api-coverage.md](docs/api-coverage.md) | What is implemented and how well it is tested |
| [compatibility.md](docs/compatibility.md) | Tested platforms, Godot versions and MCP revisions |
| [limitations.md](docs/limitations.md) | What it doesn't do, and why |
| [testing.md](docs/testing.md) | How the tests work and how to run them |

## Upgrading from 0.x

The 0.x tool names and argument spellings (camelCase and snake_case) still work. Behaviour changed only where 0.x was unsafe or wrong:

- Paths are confined to the project, with symlink checks.
- `add_node` no longer loads arbitrary `res://` strings. Scripts are never loaded this way, and resources only for resource-typed properties.
- Failures are returned as errors, not as success text.
- Project autoloads no longer run during edits.
- `run_project` no longer passes `-d`, which could freeze the game on its first error.

Set `GODOT_MCP_LEGACY_TOOLS=false` to hide the old names.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Every new tool or action needs an integration test against real Godot.

```bash
npm ci
npm run typecheck && npm run format:check && npm run build
npm run check:gdscript      # parse all bundled GDScript with Godot
npm run test:unit           # fast, no Godot needed
npm run test:integration    # real Godot (set GODOT_PATH); see docs/testing.md
npm run docs:tools          # regenerate docs/mcp-tools.md
```

## Roadmap

- [ ] Verify the C# / .NET workflow with the Godot .NET build
- [ ] Run the third-party MCP conformance suite (`@hasmcp/mcp-spec-test`)
- [ ] Real exports in CI on every platform
- [ ] Capture screenshots of an already-running game
- [ ] Debugger integration (breakpoints, DAP) and input simulation
- [ ] Publish 2.0 to npm

## Acknowledgments

- [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo) created the original godot-mcp that this fork builds on.
- Upstream contributors whose open PRs informed this work, especially #132 (headless authoring), #124 (validation), #115 (screenshots) and #137 (`res://` paths).
- The [Godot Engine](https://godotengine.org) and [Model Context Protocol](https://modelcontextprotocol.io) teams.

## License

MIT. See [LICENSE](LICENSE).
