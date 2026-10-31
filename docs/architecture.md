# Architecture

godot-mcp 2.0 has three components. Each one owns a single concern, and each one talks to the next through a narrow, validated interface.

```
 MCP client (Claude Code, …)
        │ stdio, MCP 2026-07-28 or 2025-era (SDK v2 serveStdio)
 ┌──────▼─────────────────────────────────────────────────────────────┐
 │ TypeScript MCP server (src/)                                        │
 │  tools/*      tool families: zod input schemas, structured output   │
 │  security/    canonical paths, project boundary, symlink checks     │
 │  context.ts   config, per-project write locks, file guards,        │
 │               rollback, editor-conflict checks                      │
 │  godot/       locate+version, bounded/cancellable process runner,   │
 │               worker protocol, runtime sessions, log diagnostics    │
 │  editor/      authenticated loopback client for the editor plugin   │
 │  resources/   godot://… read-only resources                         │
 └──────┬───────────────────────────────┬─────────────────────┬───────┘
        │ temp request/response JSON     │ argv only           │ TCP 127.0.0.1 + token
 ┌──────▼──────────────────────┐ ┌──────▼──────────────┐ ┌────▼─────────────────────────┐
 │ Headless worker (MainLoop)  │ │ Game / editor /     │ │ EditorPlugin (addons/godot_mcp)│
 │ godot/worker/mcp_worker.gd  │ │ import / export /   │ │ bridge_server.gd + editor_ops │
 │ ops/*.gd per domain         │ │ capture processes   │ │ EditorInterface, UndoRedo     │
 └──────┬──────────────────────┘ └─────────────────────┘ └────┬─────────────────────────┘
        └──────────── shared GDScript lib: addons/godot_mcp/lib/ ──────┘
              mcp_util (paths, UIDs, saving) · class_policy · variant_codec
```

## 1. TypeScript MCP server

- **SDK.** Uses `@modelcontextprotocol/server` 2.4.0 (`McpServer.registerTool` with zod v4 schemas). `serveStdio(factory)` picks the protocol era for each connection. A `server/discover` opening gets 2026-07-28. An `initialize` opening gets the 2025 handshake, which settles on 2025-11-25 or on whatever older revision the client asks for. The server does no protocol negotiation of its own.
- **Factory vs. process state.** `createServer(ctx)` (src/server.ts) is cheap and holds no state of its own. Process-wide state lives in `AppContext` (src/context.ts): configuration, the located Godot install, per-project `KeyedMutex` write locks, the `RuntimeManager` and the editor bridge connections.
- **Tool registry** (src/tools/registry.ts). Every handler returns `{data, summary?, images?}`. The registry turns that into `structuredContent` plus a JSON text block. The text is truncated at `GODOT_MCP_MAX_RESPONSE_BYTES`, and the truncation is stated in the text. Thrown `GodotMcpError`s become `isError` results with `structuredContent.error = {code, message, operation, diagnostics, context, hints}`. Cancellation comes from `ctx.mcpReq.signal`, which is passed to every child process.
- **Tool families.** project, scene, resource, script, api, runtime, visual, assets (import/export/uid), editor, dotnet and legacy. There are 31 `godot_*` tools plus 14 legacy 0.x names. The legacy names are adapters onto the same core.

## 2. Headless worker

- `godot --headless --no-header --path <project> --script godot/worker/mcp_worker.gd -- <req.json> <res.json>`
- **`extends MainLoop`, not `SceneTree`.** With a MainLoop, Godot does not instantiate autoloads, so read operations run no project code. This was verified against 4.7.2; upstream ran autoload `_init`/`_ready` on every operation.
- **Batch protocol.** The request carries `ops: [{op, args}]`. The worker stops at the first failure. The response file is the only result channel: a missing or unreadable response is always a failure, whatever the exit code. JSON never goes on argv.
- **Structured engine diagnostics.** A `Logger` subclass registered with `OS.add_logger` (Godot 4.5+) collects them. The worker doesn't need to scrape stderr.
- **Op modules** (`godot/worker/ops`):
  - `project_ops`: info, settings, InputMap, autoloads, validation, plugin enable
  - `scene_ops`: SceneState-based inspection, create, batched edit, save-as
  - `scene_authoring`: animation, TileMapLayer, GridMap
  - `resource_ops`: inspect, create, edit, TileSet atlas, SpriteFrames, MeshLibrary
  - `script_ops`: validate, inspect
  - `api_ops`: ClassDB reflection
  - `asset_ops`: UIDs, re-save, load checks
- **Startup.** The worker registers every project UID with `ResourceUID`, as the editor's filesystem scan does, so `uid://` references resolve without an editor-built cache.

### Scene mutation pipeline
1. TS: canonicalise paths. Take the per-project lock. Check `expectedHash`. Ask a connected editor whether the scene has unsaved changes, and refuse if so. Back up the original bytes.
2. Worker: `load(CACHE_MODE_IGNORE)`, then `instantiate(GEN_EDIT_STATE_MAIN)`. This is the editor's mode: inherited scenes, instanced sub-scenes and editable-children overrides are preserved. Plain `instantiate()` injects spurious overrides.
3. Apply every action in memory. Any failure aborts the batch and nothing is written.
4. `PackedScene.pack`, then `ResourceSaver.save`. The original UID is restored (`ResourceSaver.set_uid`), as are the `uid="…"` attributes on `[ext_resource]` lines (see limitations). The file is then reloaded with `CACHE_MODE_IGNORE` and checked for instantiability.
5. TS: if a later step failed, restore the backup (or delete a file that did not exist before). If the editor has the scene open, ask it to reload the tab.

### Read-only inspection
`PackedScene.get_state()` (SceneState) gives node names, types, stored properties, groups, connections, instance and inheritance information without instantiating any node, so no `_init` runs. Class property metadata comes from `ClassDB`.

## 3. EditorPlugin bridge

- `addons/godot_mcp/plugin.gd` starts `bridge_server.gd`, which listens with `TCPServer.listen(0, "127.0.0.1")`: loopback only, random port.
- It writes `res://.godot/godot_mcp/bridge.json` with the port, a 256-bit random token, the pid and the canonical project root. The file is owner read/write only.
- Wire protocol: JSON lines, at most 1 MiB per message and at most 4 clients.
  - The first message must be `{"type":"hello","token":…}`. The token is compared in constant time (`Crypto.constant_time_compare`). On failure the client gets `rejected` and the socket is closed. Unauthenticated sockets are also dropped after 5 s.
- All requests are processed in `_process` on the editor main thread.
- Mutations (`set_properties`, `add_node`, `remove_node`) go through `EditorUndoRedoManager` and are undoable with Ctrl+Z. They leave the scene unsaved until `save_scene`.
- `scene_state` exposes `EditorInterface.get_unsaved_scenes()`. The TS side uses it to refuse headless writes that would conflict with the editor.
- The TS client (src/editor/bridge.ts) refuses a discovery file that is a symlink, is not a regular file, or names a different `project_root`. A request for project A therefore cannot be served by the editor of project B.

## 4. Other Godot processes

| Purpose | Command | Notes |
|---|---|---|
| Game / scene run | `godot --path P [--scene S] [--headless] [--quit-after N] [--fixed-fps N]` | Tracked session with a ring buffer and streaming diagnostics. Started without `-d`, because the stdout debugger blocks on stdin. |
| Editor | `godot --editor --path P [--headless]` | Tracked. Output is captured, so startup errors are reported. |
| Import / class-cache refresh | `godot --headless --path P --import` | Official editor scan. Runs editor plugins. |
| Screenshot | `godot --path P --resolution WxH --script capture_runner.gd -- req res` | SceneTree with the real renderer. Waits N frames, reads `root.get_texture().get_image()`, saves a PNG and reports image statistics and scene facts. |
| Export | `godot --headless --path P --export-release/--export-debug preset out` | Templates are checked first. The output file is verified afterwards. |
| C# | `dotnet build <csproj>` | Only when the Godot .NET build, the SDK and a csproj are all present. |

All processes are spawned with argument arrays (no shell), in their own process group. They have timeouts, bounded output and AbortSignal handling, and are reaped on shutdown.

## 5. Value encoding

See `godot://docs/value-encoding` (src/resources/index.ts) and `lib/variant_codec.gd`. Decoding uses the **target property's declared type and hint**. Arrays become Vector2/3, strings become Color or enum constants, `[1,3]` becomes a layer mask, `"res://…"` is loaded only for resource-typed properties that match the hinted class, and `{"$new": Class}` creates an allow-listed resource. Encoding is lossless for value types and uses explicit `$type` tags.

## 6. Module dependency rules

- `tools/*` → `context`, `security`, `godot`, `editor`, `util`.
- `godot/*` never imports `tools/*`.
- `security/*` imports only `errors`.
- GDScript: `ops/*` → `lib/*`. `lib/*` has no dependency on `ops`. The editor plugin uses only `lib/*`.
