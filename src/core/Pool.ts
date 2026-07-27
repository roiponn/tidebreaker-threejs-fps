/**
 * Fixed-capacity object pool.
 *
 * Every VFX system in the project allocates its instances up-front and recycles
 * them. Nothing that runs per-frame is allowed to `new` a Vector3 or a Mesh.
 * When the pool is exhausted the *oldest* live item is recycled rather than
 * growing the pool - a hard particle budget is what keeps frame time flat.
 */
export class Pool<T> {
  private readonly items: T[] = [];
  private readonly alive: boolean[] = [];
  private cursor = 0;
  private liveCount = 0;

  constructor(
    readonly capacity: number,
    factory: (index: number) => T,
    private readonly onRecycle?: (item: T) => void,
  ) {
    for (let i = 0; i < capacity; i++) {
      this.items.push(factory(i));
      this.alive.push(false);
    }
  }

  /** Acquire a slot; recycles the oldest entry when full. Never returns null. */
  acquire(): { item: T; index: number } {
    for (let i = 0; i < this.capacity; i++) {
      const index = (this.cursor + i) % this.capacity;
      if (!this.alive[index]) {
        this.cursor = (index + 1) % this.capacity;
        this.alive[index] = true;
        this.liveCount++;
        return { item: this.items[index], index };
      }
    }
    // Exhausted: steal the round-robin slot so the effect still reads on screen.
    const index = this.cursor;
    this.cursor = (index + 1) % this.capacity;
    this.onRecycle?.(this.items[index]);
    return { item: this.items[index], index };
  }

  release(index: number): void {
    if (!this.alive[index]) return;
    this.alive[index] = false;
    this.liveCount--;
    this.onRecycle?.(this.items[index]);
  }

  isAlive(index: number): boolean {
    return this.alive[index];
  }

  at(index: number): T {
    return this.items[index];
  }

  get live(): number {
    return this.liveCount;
  }

  forEachAlive(fn: (item: T, index: number) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) fn(this.items[i], i);
    }
  }

  releaseAll(): void {
    for (let i = 0; i < this.capacity; i++) this.release(i);
  }

  all(): readonly T[] {
    return this.items;
  }
}
