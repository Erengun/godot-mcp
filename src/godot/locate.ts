/**
 * Locate the Godot executable and parse its version.
 *
 * Detection order: explicit GODOT_PATH → `godot`/`godot4` on PATH → common
 * per-platform install locations. A candidate is only accepted after
 * `--version` succeeds and reports Godot 4.x; there is no silent fallback to a
 * path that was never verified.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { normalize } from 'node:path';
import { ErrorCode, GodotMcpError } from '../errors.ts';
import { runProcess } from './process.ts';

export interface GodotVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  status: string;
  build: string;
  hash?: string;
  /** True for the Godot .NET (mono) build. */
  dotnet: boolean;
}

export interface GodotInstall {
  path: string;
  version: GodotVersion;
}

export function parseGodotVersion(raw: string): GodotVersion | null {
  const line = raw.trim().split(/\r?\n/).pop()?.trim() ?? '';
  // e.g. 4.7.2.stable.official.ed1daf0bf | 4.8.beta2.mono.official.abc123 | 4.3.stable.official.77dcf97d8
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?\.([a-z]+\d*)((?:\.[A-Za-z0-9_-]+)*)$/.exec(line);
  if (!m) return null;
  const rest = (m[5] ?? '').split('.').filter(Boolean);
  const dotnet = rest.includes('mono');
  const tail = rest.filter((p) => p !== 'mono');
  return {
    raw: line,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0,
    status: m[4] ?? 'unknown',
    build: tail[0] ?? 'unknown',
    hash: tail[1],
    dotnet,
  };
}

export function versionAtLeast(v: GodotVersion, major: number, minor: number, patch = 0): boolean {
  if (v.major !== major) return v.major > major;
  if (v.minor !== minor) return v.minor > minor;
  return v.patch >= patch;
}

export function versionLabel(v: GodotVersion): string {
  return `${v.major}.${v.minor}${v.patch ? `.${v.patch}` : ''}.${v.status}${v.dotnet ? '.mono' : ''}`;
}

/** Templates directory name used by Godot, e.g. "4.7.2.stable" or "4.8.beta2.mono". */
export function templatesVersionDir(v: GodotVersion): string {
  return `${v.major}.${v.minor}${v.patch ? `.${v.patch}` : ''}.${v.status}${v.dotnet ? '.mono' : ''}`;
}

export function candidatePaths(platform: NodeJS.Platform = process.platform): string[] {
  const home = homedir();
  const c: string[] = ['godot', 'godot4'];
  if (platform === 'darwin') {
    c.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      '/Applications/Godot_4.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
      `${home}/Applications/Godot_mono.app/Contents/MacOS/Godot`,
      `${home}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
    );
  } else if (platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    c.push(
      `${pf}\\Godot\\Godot.exe`,
      `${pf}\\Godot_4\\Godot.exe`,
      `${process.env.USERPROFILE ?? home}\\Godot\\Godot.exe`,
      `${process.env.LOCALAPPDATA ?? home}\\Programs\\Godot\\Godot.exe`,
    );
  } else {
    c.push(
      '/usr/bin/godot',
      '/usr/local/bin/godot',
      '/usr/bin/godot4',
      '/snap/bin/godot',
      `${home}/.local/bin/godot`,
      '/var/lib/flatpak/exports/bin/org.godotengine.Godot',
    );
  }
  return c;
}

async function probe(path: string): Promise<GodotInstall | null> {
  const bare = !path.includes('/') && !path.includes('\\');
  if (!bare && !existsSync(path)) return null;
  const r = await runProcess(path, ['--version'], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  if (r.spawnError || r.exitCode !== 0) return null;
  const version = parseGodotVersion(r.stdout);
  if (!version) return null;
  return { path: bare ? path : normalize(path), version };
}

let cached: GodotInstall | null = null;
let cachedKey: string | undefined;

export async function locateGodot(explicitPath?: string): Promise<GodotInstall> {
  if (cached && cachedKey === explicitPath) return cached;
  if (explicitPath) {
    const found = await probe(explicitPath);
    if (!found) {
      throw new GodotMcpError(ErrorCode.GodotNotFound, `GODOT_PATH does not point to a working Godot executable: ${explicitPath}`, {
        hints: ['On macOS use .../Godot.app/Contents/MacOS/Godot', 'Run "<path> --version" to verify'],
      });
    }
    return remember(found, explicitPath);
  }
  const rejected: string[] = [];
  for (const candidate of candidatePaths()) {
    const found = await probe(candidate);
    if (!found) continue;
    if (!isSupported(found.version)) {
      rejected.push(`${found.path} (${found.version.raw})`);
      continue;
    }
    return remember(found, explicitPath);
  }
  throw new GodotMcpError(
    ErrorCode.GodotNotFound,
    `Could not find a Godot 4.5+ executable${rejected.length ? `; unsupported versions found: ${rejected.join(', ')}` : ''}`,
    {
      hints: ['Set GODOT_PATH to the Godot executable', 'Install Godot 4.x from https://godotengine.org'],
    },
  );
}

export function isSupported(v: GodotVersion): boolean {
  return v.major === 4 && versionAtLeast(v, 4, 5);
}

function remember(found: GodotInstall, key: string | undefined): GodotInstall {
  if (!isSupported(found.version)) {
    throw new GodotMcpError(
      ErrorCode.GodotVersionUnsupported,
      `Godot ${found.version.raw} at ${found.path} is not supported; Godot 4.5 or newer is required (4.7.2 recommended)`,
    );
  }
  cached = found;
  cachedKey = key;
  return found;
}

export function resetGodotCache(): void {
  cached = null;
  cachedKey = undefined;
}
