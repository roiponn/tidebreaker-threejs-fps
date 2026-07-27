import type { Explosives } from '@/environment/Explosives';

/**
 * Deterministic chain-reaction test (?chaintest=1).
 *
 * A drum chain is a ~2 second event that fires once per playthrough and can
 * only be started by hitting a 0.6m target with a bullet. Verifying it by hand
 * means: acquire pointer lock, walk 30m, aim, hit, and be watching the right
 * three drums at the right moment - and it is not repeatable, so "it worked"
 * proves nothing about the second run. Worse, several of the properties that
 * matter (single-trigger protection, termination, out-of-range drums staying
 * intact, pool recycling across repeats) are invisible on screen even if you
 * do catch them.
 *
 * So the test drives the chain directly and reads the outcome from the
 * simulation rather than from the picture. Each run:
 *
 *   1. records the pre-state of every drum,
 *   2. triggers ONE drum (index `seed`) via Explosives.debugTrigger,
 *   3. immediately re-triggers the same drum, which MUST be refused,
 *   4. lets the chain run to completion,
 *   5. re-triggers a destroyed drum, which MUST be refused,
 *   6. records the propagation log, final states, and pool occupancy,
 *   7. resets and repeats, so run 2 and run 3 can be compared with run 1.
 *
 * The result is written to `document.body.dataset.chain` as JSON, because the
 * scripting console runs in an isolated world and cannot read module state -
 * a DOM data attribute is the only channel that survives.
 */

export interface ChainTestStats {
  /** Live particles, to prove pooled effects are recycled and not leaked. */
  particles: number;
  /** Active dynamic lights, to prove flashes do not accumulate. */
  lights: number;
}

interface RunResult {
  run: number;
  /** Drum states before triggering, e.g. "iiiiii". */
  before: string;
  /** Drum states after the chain has settled. */
  after: string;
  /** Propagation trace: `id@time:cause`. */
  log: string[];
  /** First re-trigger of the seed drum while it is already lit. Must be false. */
  reTriggerWhileLit: boolean;
  /** Re-trigger of the seed drum after it is destroyed. Must be false. */
  reTriggerWhenGone: boolean;
  /** Trigger of an out-of-array index. Must be false. */
  triggerBadIndex: boolean;
  /** Explosion events observed during the run. */
  explosions: number;
  /** Pool occupancy after the chain has fully settled. */
  restParticles: number;
  restLights: number;
}

const SETTLE = 3.2; // seconds allowed for the chain to run out
const RECOVER = 2.6; // seconds after that, for pooled effects to expire

export class ChainTest {
  /** Set by the game when an `explosion` event is seen. */
  explosionsSeen = 0;

  private phase: 'idle' | 'armed' | 'settling' | 'recovering' | 'done' = 'idle';
  private timer = 0;
  private run = 0;
  private current: RunResult | null = null;
  private results: RunResult[] = [];

  constructor(
    private readonly explosives: Explosives,
    private readonly stats: () => ChainTestStats,
    private readonly seed: number,
    private readonly runs: number,
  ) {}

  start(delay: number): void {
    this.phase = 'armed';
    this.timer = delay;
  }

  get finished(): boolean {
    return this.phase === 'done';
  }

  update(dt: number): void {
    if (this.phase === 'idle' || this.phase === 'done') return;
    this.timer -= dt;
    if (this.timer > 0) return;

    if (this.phase === 'armed') {
      this.run++;
      this.explosionsSeen = 0;
      const before = this.explosives.drumStates;
      // The one and only intentional trigger.
      this.explosives.debugTrigger(this.seed);
      this.current = {
        run: this.run,
        before,
        after: '',
        log: [],
        // Same drum again, while its fuse is burning. Must be refused, or a
        // burst of fire into a drum would stack fuses and multi-detonate it.
        reTriggerWhileLit: this.explosives.debugTrigger(this.seed),
        reTriggerWhenGone: false,
        triggerBadIndex: this.explosives.debugTrigger(999),
        explosions: 0,
        restParticles: 0,
        restLights: 0,
      };
      this.phase = 'settling';
      this.timer = SETTLE;
      return;
    }

    if (this.phase === 'settling' && this.current) {
      this.current.after = this.explosives.drumStates;
      this.current.log = [...this.explosives.chainLog];
      this.current.explosions = this.explosionsSeen;
      // A destroyed drum must be inert.
      this.current.reTriggerWhenGone = this.explosives.debugTrigger(this.seed);
      this.phase = 'recovering';
      this.timer = RECOVER;
      return;
    }

    if (this.phase === 'recovering' && this.current) {
      const s = this.stats();
      this.current.restParticles = s.particles;
      this.current.restLights = s.lights;
      this.results.push(this.current);
      this.current = null;
      this.publish();
      if (this.run >= this.runs) {
        this.phase = 'done';
        return;
      }
      // Rebuild the fuel dump and go again, so repeats are comparable.
      this.explosives.reset();
      this.phase = 'armed';
      this.timer = 1.0;
    }
  }

  private publish(): void {
    document.body.dataset.chain = JSON.stringify({
      runs: this.results.length,
      results: this.results,
    });
  }
}
