/**
 * Process-wide state shared by all tools: configuration, the located Godot
 * install, per-project write locks, the runtime/process manager and editor
 * bridge connections. Created once in index.ts and handed to the McpServer
 * factory (a stdio connection may instantiate the factory per protocol era).
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config.ts';
import { EditorBridgeManager } from './editor/bridge.ts';
import { removeStubProject } from './resources/index.ts';
import { ErrorCode, GodotMcpError, toGodotMcpError } from './errors.ts';
import { locateGodot, type GodotInstall } from './godot/locate.ts';
import { RuntimeManager } from './godot/runtime.ts';
import { runWorker, workerFailure, type WorkerOp, type WorkerResponse } from './godot/worker.ts';
import { resolveProject, type ProjectRef, type ResolvedResPath } from './security/paths.ts';
import { fileHash } from './util/hash.ts';
import { KeyedMutex } from './util/keyedMutex.ts';
import { log } from './util/log.ts';

export const MAX_PROJECT_BACKUPS = 10;

export interface RunOpsOptions {
  signal?: AbortSignal;
  /** The batch writes to the project (enforces read-only mode + project lock). */
  mutates?: boolean;
  timeoutMs?: number;
  operation?: string;
}

export interface FileGuard {
  path: ResolvedResPath;
  hashBefore: string | null;
  backup: Buffer | null;
  editorOpen: boolean;
}

export interface GuardedWriteOptions {
  /** Tool/operation name for read-only refusals and error messages. */
  operation: string;
  /** sha256 the target must still have (optimistic concurrency). */
  expectedHash?: string;
  /** Further checks that must hold under the lock, before anything is written. */
  precheck?: () => void | Promise<void>;
}

export interface GuardedWriteResult<T> {
  result: T;
  hashBefore: string | null;
  hashAfter: string | null;
  editorNote?: string;
}

export class AppContext {
  readonly config: ServerConfig;
  readonly locks = new KeyedMutex();
  readonly runtime = new RuntimeManager();
  readonly editor = new EditorBridgeManager();

  constructor(config: ServerConfig) {
    this.config = config;
  }

  godot(): Promise<GodotInstall> {
    return locateGodot(this.config.godotPath);
  }

  project(projectPath: unknown): ProjectRef {
    return resolveProject(projectPath, this.config.allowedRoots);
  }

  assertWritable(operation: string): void {
    if (this.config.readOnly) {
      throw new GodotMcpError(
        ErrorCode.CapabilityUnavailable,
        `${operation} modifies the project or starts processes, which is disabled (GODOT_MCP_READ_ONLY=true)`,
      );
    }
  }

  /** Run a batch of worker operations; throws on the first failed op. */
  async runOps(project: ProjectRef, ops: WorkerOp[], opts: RunOpsOptions = {}): Promise<{ results: unknown[]; response: WorkerResponse }> {
    const operation = opts.operation ?? ops.map((o) => o.op).join('+');
    if (opts.mutates) this.assertWritable(operation);
    const godot = await this.godot();
    const exec = async () => {
      const { response } = await runWorker(
        { ops },
        { godotPath: godot.path, projectRoot: project.root, timeoutMs: opts.timeoutMs ?? this.config.operationTimeoutMs, signal: opts.signal },
      );
      if (!response.ok) throw workerFailure(response, operation);
      return { results: response.results.map((r) => r.result), response };
    };
    return opts.mutates ? this.locks.run(project.root, exec) : exec();
  }

  /**
   * Rewrite one file through `write` (normally a worker batch) as a single
   * unit under the project lock: the pre-write checks, the backup, the write,
   * the editor reload and — if `write` fails — the rollback all happen while
   * no other mutation of the project can run. Taking the backup outside the
   * lock would let a failing call restore a stale copy over a concurrent
   * call's successful write.
   */
  async guardedWrite<T>(project: ProjectRef, path: ResolvedResPath, opts: GuardedWriteOptions, write: () => Promise<T>): Promise<GuardedWriteResult<T>> {
    this.assertWritable(opts.operation);
    return this.locks.run(project.root, async () => {
      await opts.precheck?.();
      const guard = await this.guardFileWrite(project, path, opts.expectedHash);
      try {
        const result = await write();
        const editorNote = await this.notifyEditorOfWrite(project, guard);
        return { result, hashBefore: guard.hashBefore, hashAfter: fileHash(path.abs), editorNote };
      } catch (e) {
        const err = toGodotMcpError(e, opts.operation);
        if (fileHash(path.abs) !== guard.hashBefore) {
          this.rollback(guard);
          err.details.context = { ...(err.details.context ?? {}), rolledBack: true };
        }
        throw err;
      }
    });
  }

  /** Refuse when `path` no longer has the sha256 the caller last saw. */
  assertHash(path: ResolvedResPath, expectedHash: string | undefined): void {
    if (expectedHash === undefined) return;
    const actualHash = fileHash(path.abs);
    if (expectedHash !== actualHash) {
      throw new GodotMcpError(ErrorCode.Conflict, `${path.res} changed since it was read (hash mismatch); re-inspect it and retry`, {
        context: { expectedHash, actualHash },
      });
    }
  }

  /**
   * Pre-write checks for a file the worker is about to rewrite (call under
   * the project lock; guardedWrite does):
   *  - optimistic concurrency (expectedHash),
   *  - refuse when the live editor holds unsaved changes to the same scene,
   *  - keep an in-memory backup so a failed post-write validation can be rolled back.
   */
  async guardFileWrite(project: ProjectRef, path: ResolvedResPath, expectedHash?: string): Promise<FileGuard> {
    this.assertHash(path, expectedHash);
    const hashBefore = fileHash(path.abs);
    let editorOpen = false;
    try {
      const bridge = await this.editor.get(project.root);
      if (bridge) {
        const state = await bridge.request<{ open: boolean; unsaved: boolean }>('scene_state', { path: path.res }, 5000);
        if (state.unsaved) {
          throw new GodotMcpError(ErrorCode.Conflict, `${path.res} has unsaved changes in the running Godot editor; refusing to overwrite them`, {
            hints: [
              'Save the scene in the editor (godot_editor action save_scene) and retry',
              'Or make the change live with godot_editor (set_properties / add_node)',
            ],
          });
        }
        editorOpen = state.open;
      }
    } catch (e) {
      if (e instanceof GodotMcpError && e.code === ErrorCode.Conflict) throw e;
      log.debug('editor state check skipped', e);
    }
    const backup = existsSync(path.abs) ? readFileSync(path.abs) : null;
    return { path, hashBefore, backup, editorOpen };
  }

  /** Restore a guarded file after a failed write. */
  rollback(guard: FileGuard): void {
    if (guard.backup) {
      writeFileSync(guard.path.abs, guard.backup);
    } else if (guard.hashBefore === null && existsSync(guard.path.abs)) {
      // The file did not exist before this operation: remove the invalid result.
      rmSync(guard.path.abs, { force: true });
    }
  }

  /** After a successful headless write, make an editor that has the file open reload it. */
  async notifyEditorOfWrite(project: ProjectRef, guard: FileGuard): Promise<string | undefined> {
    if (!guard.editorOpen) return undefined;
    try {
      const bridge = await this.editor.get(project.root);
      await bridge?.request('reload_scene', { path: guard.path.res }, 10000);
      return 'The open editor tab was reloaded from disk.';
    } catch (e) {
      return `The scene is open in the editor and could not be reloaded automatically: ${(e as Error).message}`;
    }
  }

  /** Copy project.godot aside before a settings write (kept in .godot/godot_mcp/backups); call under the project lock. */
  backupProjectFile(project: ProjectRef): string {
    const src = join(project.root, 'project.godot');
    const dir = join(project.root, '.godot', 'godot_mcp', 'backups');
    mkdirSync(dir, { recursive: true });
    // Timestamp first so the names sort chronologically; the random suffix keeps two backups in one millisecond apart.
    const dest = join(dir, `project.godot.${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.bak`);
    copyFileSync(src, dest);
    // Keep only the most recent backups.
    const old = readdirSync(dir)
      .filter((f) => f.startsWith('project.godot.') && f.endsWith('.bak'))
      .sort()
      .slice(0, -MAX_PROJECT_BACKUPS);
    for (const f of old) rmSync(join(dir, f), { force: true });
    return dest;
  }

  async shutdown(): Promise<void> {
    removeStubProject();
    this.editor.closeAll();
    await this.runtime.stopAll();
  }
}
