/**
 * Deterministic PRNG (mulberry32).
 *
 * The whole level is procedurally authored - clutter placement, wear masks,
 * rust streaks. Using a seeded RNG means the harbour looks *identical* every
 * launch, which is what makes it art-directable instead of random noise.
 * Never use Math.random() for anything that affects layout or textures.
 */
export class Rng {
  private state: number;

  constructor(seed = 0x5eed1234) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Symmetric noise in [-amount, amount]. */
  spread(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length];
  }

  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt, 0x9e3779b9)) >>> 0);
  }
}

/** Shared level-authoring seed. Change it to reroll the entire harbour. */
export const LEVEL_SEED = 0x7a11b0a7;
