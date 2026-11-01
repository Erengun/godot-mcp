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
| CI: Ubuntu 24.04 (x86_64) | Godot 4.7.2 | full suite under xvfb, GitHub Actions run 41190993555 (commit 47fac17) |
| CI: macOS 14 (arm64) | Godot 4.7.2 | full suite, GitHub Actions run 41190993555 (commit 47fac17) |
| CI: Windows Server 2022 | Godot 4.7.2 | full suite including screenshots, GitHub Actions run 41190993555 (commit 47fac17) |
| CI: Ubuntu 24.04 | **Godot 4.8 beta 2** (4.8.beta2.official.cafc17a19) | full suite, GitHub Actions run 41190993555 (commit 47fac17) |
| Linux (Arch, x86_64) | **Godot 4.5.2** and **4.6.3** (official builds) | full suite run locally; added to the CI matrix on Ubuntu |

## Expected to work, not tested

| Component | Notes |
|---|---|
| Linux arm64, other distributions | Only Ubuntu 24.04 x86_64 runs in CI. |
| Flatpak / Snap Godot | Sandboxed: its private `/tmp` hides the worker's request files. Use the official binary, or set `TMPDIR` to a folder the sandbox can read (see the README). |
| Windows 10/11 desktop | CI covers Windows Server 2022. Processes are stopped with `child.kill` only (no process-tree kill). |
| Node.js 20 / 22 | Runtime requirement of the SDK (>= 20). Running the test suite directly from TypeScript needs Node >= 22.18 (type stripping). |
| MCP 2025-03-26 / 2024-11-05 | Served by the SDK's legacy path. Not exercised. |

## Not supported

- **Godot 3.x and Godot 4.0–4.4.** The version check refuses non-4.x builds. 4.0–4.4 lack `Logger`.
- **C# reflection and validation through GDScript tools.** C# needs the Godot .NET build, the .NET SDK and a `.csproj`. `godot_dotnet status` reports which of these are present. `godot_dotnet build` is implemented but **unverified**: the .NET SDK is installed on the test machine, but no Godot .NET build is.

## Requirements summary

- Node.js >= 20, Godot >= 4.5 (4.7.2 recommended).
- A display server is required only for `godot_screenshot` and for a non-headless `godot_run` / `godot_editor_launch`.
- Export needs templates installed through the Godot editor. The server never downloads them.

## Differences on Godot 4.5 and 4.6

- The live editor bridge cannot tell which open scenes have unsaved changes (Godot 4.7 added that query), so it treats every scene open in the editor as unsaved: headless edits of an open scene are refused (close its tab, or make the change with `godot_editor`), and `reload_scene` needs `discardUnsaved`. `godot_editor status` reports `unsaved_tracking: false`, and `importing` is always `false`.
- Scene files written by Godot 4.7 contain `unique_id` attributes. How older 4.x versions read files that a newer editor wrote has not been tested.

## Differences on Godot 4.8 (beta)

- A save of an inherited scene (or of a scene with editable instances) no longer stores the copies Godot makes of resources that are local to the scene; copies a file already stores are kept. The headless save check therefore accepts such a gained copy only on Godot 4.5–4.7, where Godot adds it on every save, and on 4.8 refuses it as a value that project code assigned. Saves that Godot 4.7 refused because copies of one resource were made for more than one scene in the file are accepted on 4.8, since nothing is copied.
