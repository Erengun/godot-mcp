# Compatibility

## Tested

| Component | Version | How it was tested |
|---|---|---|
| OS | macOS 15 (Darwin 24.6.0), Apple M3 | full unit and integration suites |
| Godot | 4.7.2.stable.official.ed1daf0bf (standard build) | real headless worker, editor, game, import, export and GPU screenshots (Metal, Forward+) |
| Node.js | v26.12.0 | |
| MCP protocol 2026-07-28 | `@modelcontextprotocol/client` 2.4.0, `versionNegotiation: auto` | `test/integration/protocol.test.ts` |
| MCP protocol 2025-11-25 | client in legacy mode | protocol and legacy round-trip tests |
| MCP protocol 2025-06-18 | client limited to `supportedProtocolVersions: ['2025-06-18']` | protocol test |

## Expected to work, not tested

| Component | Notes |
|---|---|
| Linux (x86_64/arm64) | Process groups and locations are implemented. Screenshots need a display (or `xvfb-run`). The CI workflow `.github/workflows/ci.yml` targets Ubuntu but **has not been run**. |
| Windows 10/11 | Processes are stopped with `child.kill` only (no process-tree kill). Path containment is case-sensitive. Locations of Godot executables and export templates are implemented. |
| Godot 4.5.x / 4.6.x | The worker needs `Logger` / `OS.add_logger` (4.5+). Not verified. Scene files written by 4.7 contain `unique_id` attributes, and how older 4.x versions read them has not been tested. |
| Godot 4.8 beta | Not installed. Downloading it was not authorised. No 4.8-only API is used. |
| Node.js 20 / 22 | Runtime requirement of the SDK (>= 20). Running the test suite directly from TypeScript needs Node >= 22.18 (type stripping). |
| MCP 2025-03-26 / 2024-11-05 | Served by the SDK's legacy path. Not exercised. |

## Not supported

- **Godot 3.x and Godot 4.0–4.4.** The version check refuses non-4.x builds. 4.0–4.4 lack `Logger`.
- **C# reflection and validation through GDScript tools.** C# needs the Godot .NET build, the .NET SDK and a `.csproj`. `godot_dotnet status` reports which of these are present. `godot_dotnet build` is implemented but **unverified**: the .NET SDK is installed on the test machine, but no Godot .NET build is.

## Requirements summary

- Node.js >= 20, Godot >= 4.5 (4.7.2 recommended).
- A display server is required only for `godot_screenshot` and for a non-headless `godot_run` / `godot_editor_launch`.
- Export needs templates installed through the Godot editor. The server never downloads them.
