/** Fixed-capacity line buffer that remembers how many lines were dropped. */
export class RingBuffer<T> {
  private items: T[] = [];
  private dropped = 0;
  private total = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  push(item: T): void {
    this.total++;
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped++;
    }
  }

  /** Items with a global sequence number >= `from` (sequence numbers start at 0). */
  since(from: number): { items: T[]; firstSeq: number; nextSeq: number; dropped: number } {
    const firstSeq = this.total - this.items.length;
    const start = Math.max(0, from - firstSeq);
    return { items: this.items.slice(start), firstSeq: Math.max(from, firstSeq), nextSeq: this.total, dropped: this.dropped };
  }

  tail(n: number): T[] {
    return this.items.slice(Math.max(0, this.items.length - n));
  }

  all(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get totalCount(): number {
    return this.total;
  }
}
