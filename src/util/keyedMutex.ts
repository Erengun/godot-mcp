/**
 * Serialises async work per key (e.g. per canonical project root) so two
 * mutating tool calls never write the same project concurrently.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    try {
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
