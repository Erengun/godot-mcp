import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Serialises async work per key (e.g. per canonical project root) so two
 * mutating tool calls never write the same project concurrently.
 *
 * The lock is re-entrant within one async call chain: work that currently
 * holds a key runs nested `run(key)` calls directly instead of deadlocking.
 * This lets a guarded write hold the project lock across its whole
 * check → write → verify → rollback sequence while the helpers it calls still
 * take the lock themselves. Each acquisition has its own token (tracked with
 * AsyncLocalStorage) and only the token of the active holder grants
 * re-entry, so a callback that was scheduled inside a locked section but runs
 * after it ended waits for the lock like everyone else.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  private active = new Map<string, symbol>();
  private held = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const holding = this.held.getStore();
    const inherited = holding?.get(key);
    if (inherited !== undefined && this.active.get(key) === inherited) return fn();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    const token = Symbol(key);
    try {
      await previous.catch(() => undefined);
      this.active.set(key, token);
      return await this.held.run(new Map([...(holding ?? []), [key, token]]), fn);
    } finally {
      if (this.active.get(key) === token) this.active.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
