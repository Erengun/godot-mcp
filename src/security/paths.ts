/**
 * Path canonicalisation and project-boundary enforcement.
 *
 * Every filesystem path that reaches Godot or the local filesystem must pass
 * through this module. The rules are:
 *
 *  1. A project path is canonicalised with realpath (symlinks resolved) and
 *     must contain a `project.godot` file. When GODOT_MCP_ALLOWED_ROOTS is set,
 *     the canonical path must lie inside one of the (canonicalised) roots.
 *  2. Project-relative paths ("res://a/b.tscn" or "a/b.tscn") are normalised
 *     lexically; `..` segments, NUL/control characters, `user://`, URL schemes
 *     and drive letters are rejected outright.
 *  3. The resulting absolute path is checked again after resolving symlinks of
 *     the deepest existing ancestor, so a symlink inside the project that points
 *     outside of it cannot be used to escape (read or write).
 *  4. Writes into `.godot/`, `.git/`, `project.godot`, `*.import` and `*.uid`
 *     are refused unless the calling tool explicitly owns that file type.
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErrorCode, GodotMcpError } from '../errors.ts';

export const MAX_PATH_LENGTH = 1024;

export interface ProjectRef {
  /** Canonical (realpath) absolute project directory. */
  root: string;
  /** Path as supplied by the caller (for messages only). */
  requested: string;
}

export interface ResolvedResPath {
  /** "res://dir/file.ext" */
  res: string;
  /** "dir/file.ext" (forward slashes) */
  rel: string;
  /** Absolute OS path inside the project. */
  abs: string;
}

/** Windows paths are case-insensitive; compare them case-folded there. */
const CASE_INSENSITIVE = process.platform === 'win32';

export function isWithin(parent: string, child: string): boolean {
  const rel = CASE_INSENSITIVE ? relative(parent.toLowerCase(), child.toLowerCase()) : relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Realpath of the deepest existing ancestor, with the non-existing tail re-appended. */
export function canonicalizeForCheck(absPath: string): string {
  let current = resolve(absPath);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  return join(safeRealpath(current), ...tail);
}

export function resolveProject(projectPath: unknown, allowedRoots: string[] = []): ProjectRef {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw new GodotMcpError(ErrorCode.InvalidArgument, 'projectPath is required and must be a non-empty string');
  }
  if (projectPath.length > MAX_PATH_LENGTH || hasControlChars(projectPath)) {
    throw new GodotMcpError(ErrorCode.InvalidArgument, 'projectPath contains invalid characters or is too long');
  }
  let candidate = projectPath.trim();
  // Accept a path to project.godot itself for convenience.
  if (candidate.endsWith('project.godot')) candidate = dirname(candidate);
  const absolute = resolve(candidate);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new GodotMcpError(ErrorCode.NotAProject, `Project directory does not exist: ${projectPath}`, {
      hints: ['Pass the directory that contains project.godot', 'Use godot_project_list to discover projects'],
    });
  }
  const root = safeRealpath(absolute);
  const projectFile = join(root, 'project.godot');
  if (!existsSync(projectFile) || !statSync(projectFile).isFile()) {
    throw new GodotMcpError(ErrorCode.NotAProject, `Not a Godot project (no project.godot): ${projectPath}`, {
      hints: ['Pass the directory that contains project.godot'],
    });
  }
  if (!isWithin(root, safeRealpath(projectFile))) {
    throw new GodotMcpError(ErrorCode.PathOutsideProject, 'project.godot is a symlink that points outside the project');
  }
  assertAllowedRoot(root, allowedRoots, projectPath);
  return { root, requested: projectPath };
}

export function assertAllowedRoot(canonicalPath: string, allowedRoots: string[], label: string): void {
  if (allowedRoots.length === 0) return;
  const ok = allowedRoots.some((r) => isWithin(safeRealpath(r), canonicalPath));
  if (!ok) {
    throw new GodotMcpError(ErrorCode.PathNotAllowed, `Path is outside GODOT_MCP_ALLOWED_ROOTS: ${label}`, {
      hints: ['Add the directory to GODOT_MCP_ALLOWED_ROOTS or use a project inside an allowed root'],
    });
  }
}

/**
 * Lexically normalise a project-relative path. Does not touch the filesystem.
 * Accepts "res://x", "x", or an absolute OS path that lies inside the project.
 */
export function normalizeResPath(input: unknown, project: ProjectRef, label = 'path'): ResolvedResPath {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new GodotMcpError(ErrorCode.InvalidArgument, `${label} is required and must be a non-empty string`);
  }
  let p = input.trim();
  if (p.length > MAX_PATH_LENGTH || hasControlChars(p)) {
    throw new GodotMcpError(ErrorCode.InvalidArgument, `${label} contains invalid characters or is too long`);
  }
  if (p.startsWith('uid://')) {
    throw new GodotMcpError(ErrorCode.InvalidArgument, `${label}: uid:// paths are not accepted here; pass a res:// path`, {
      hints: ['Resolve UIDs with godot_uid first'],
    });
  }
  if (p.startsWith('res://')) {
    p = p.slice('res://'.length);
    if (p.startsWith('/')) {
      throw new GodotMcpError(ErrorCode.InvalidArgument, `${label}: malformed res:// path (extra leading slash): ${input}`);
    }
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) {
    throw new GodotMcpError(ErrorCode.InvalidArgument, `${label}: only res:// or project-relative paths are accepted: ${input}`);
  } else if (isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    const abs = canonicalizeForCheck(p);
    if (!isWithin(project.root, abs)) {
      throw new GodotMcpError(ErrorCode.PathOutsideProject, `${label} is outside the project: ${input}`);
    }
    p = relative(project.root, abs);
  }
  const segments = p.replace(/\\/g, '/').split('/');
  const clean: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new GodotMcpError(ErrorCode.PathOutsideProject, `${label} must not contain '..' segments: ${input}`);
    }
    clean.push(seg);
  }
  if (clean.length === 0) {
    throw new GodotMcpError(ErrorCode.InvalidArgument, `${label} must name a file or directory inside the project`);
  }
  const rel = clean.join('/');
  return { res: `res://${rel}`, rel, abs: join(project.root, ...clean) };
}

export interface ResolveOptions {
  mustExist?: boolean;
  mustNotExist?: boolean;
  forWrite?: boolean;
  /** Allowed (lower-case, dot-prefixed) extensions. */
  extensions?: readonly string[];
  /** Allow writing files that are normally protected (e.g. project.godot). */
  allowProtected?: boolean;
  label?: string;
}

const PROTECTED_DIRS = ['.godot', '.git', '.import'];

export function isProtectedPath(rel: string): boolean {
  const first = rel.split('/')[0] ?? '';
  if (PROTECTED_DIRS.includes(first)) return true;
  if (rel === 'project.godot' || rel === 'export_presets.cfg' || rel === 'override.cfg') return true;
  return rel.endsWith('.import') || rel.endsWith('.uid');
}

/** Normalise + symlink-aware boundary check + optional existence/extension rules. */
export function resolveInProject(input: unknown, project: ProjectRef, opts: ResolveOptions = {}): ResolvedResPath {
  const label = opts.label ?? 'path';
  const r = normalizeResPath(input, project, label);
  if (opts.extensions && opts.extensions.length > 0) {
    const lower = r.rel.toLowerCase();
    if (!opts.extensions.some((ext) => lower.endsWith(ext))) {
      throw new GodotMcpError(ErrorCode.InvalidArgument, `${label} must have one of the extensions ${opts.extensions.join(', ')}: ${r.res}`);
    }
  }
  const canonical = canonicalizeForCheck(r.abs);
  if (!isWithin(project.root, canonical)) {
    throw new GodotMcpError(ErrorCode.PathOutsideProject, `${label} resolves outside the project (symlink escape): ${r.res}`);
  }
  if (opts.forWrite && !opts.allowProtected && isProtectedPath(r.rel)) {
    throw new GodotMcpError(ErrorCode.PathNotAllowed, `${label} is a protected project file and cannot be written by this tool: ${r.res}`);
  }
  const exists = existsSync(r.abs);
  if (opts.forWrite && exists && lstatSync(r.abs).isSymbolicLink()) {
    throw new GodotMcpError(ErrorCode.PathNotAllowed, `${label} is a symlink; refusing to write through it: ${r.res}`);
  }
  if (opts.mustExist && !exists) {
    throw new GodotMcpError(ErrorCode.NotFound, `${label} does not exist: ${r.res}`);
  }
  if (opts.mustNotExist && exists) {
    throw new GodotMcpError(ErrorCode.AlreadyExists, `${label} already exists: ${r.res}`, {
      hints: ['Pass overwrite: true if replacing the file is intended'],
    });
  }
  return r;
}

/** Validate a directory that is not necessarily a Godot project (list_projects). */
export function resolveSearchDirectory(dir: unknown, allowedRoots: string[]): string {
  if (typeof dir !== 'string' || dir.trim() === '' || hasControlChars(dir) || dir.length > MAX_PATH_LENGTH) {
    throw new GodotMcpError(ErrorCode.InvalidArgument, 'directory must be a non-empty path');
  }
  const abs = resolve(dir.trim());
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new GodotMcpError(ErrorCode.NotFound, `Directory does not exist: ${dir}`);
  }
  const canonical = safeRealpath(abs);
  assertAllowedRoot(canonical, allowedRoots, dir);
  return canonical;
}

export const SCENE_EXTENSIONS = ['.tscn', '.scn'] as const;
export const RESOURCE_EXTENSIONS = ['.tres', '.res'] as const;
export const SCRIPT_EXTENSIONS = ['.gd', '.cs', '.gdshader', '.gdshaderinc'] as const;
