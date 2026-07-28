import type { EventBus } from '@/core/EventBus';
import {
  CHECKPOINT_OF,
  COMBAT_ACTIVE,
  MISSION_ORDER,
  OBJECTIVE_OF,
  PLAYABLE,
  type Checkpoint,
  type MissionState,
} from './MissionState';

/**
 * Per-state behaviour. All fields optional: most states only need `enter`.
 *
 * `update` returns the state to move to, or null to stay. Returning a state is
 * the ONLY way a state advances itself, which is what keeps the transition
 * logic in one file instead of scattered across the systems that observe it.
 */
export interface StateDef {
  enter?(ctx: MissionContext): void;
  update?(ctx: MissionContext, dt: number): MissionState | null;
  exit?(ctx: MissionContext): void;
  /** Seconds after which the state force-advances. Guards against soft-locks. */
  timeout?: number;
  /** Where a timeout goes. Required if `timeout` is set. */
  onTimeout?: MissionState;
}

/**
 * Everything a state handler is allowed to touch.
 *
 * Passing a narrow context rather than the Game keeps the machine testable and
 * stops state handlers from quietly growing into gameplay code.
 */
export interface MissionContext {
  readonly bus: EventBus;
  /** Seconds spent in the current state. */
  time: number;
  /** Seconds of playable mission time, for the results screen. */
  missionTime: number;
  /** Set by the game each frame. */
  playerAlive: boolean;
  playerX: number;
  /** Progress flags the states read; owned by the systems that satisfy them. */
  flags: MissionFlags;
  /** Fire a radio line. Deduplicated by key. */
  say(key: string, speaker: string, text: string): void;
}

export interface MissionFlags {
  exteriorHostilesRemaining: number;
  gatekeeperAlive: boolean;
  gatekeeperDefeated: boolean;
  moduleAcquired: boolean;
  atGateTerminal: boolean;
  gateOpen: boolean;
  insideFactory: boolean;
  reachedControlRoom: boolean;
  hostagesSeen: boolean;
  bossRelaysDown: number;
  bossCoolantDown: boolean;
  bossCoreDown: boolean;
  hostagesReleased: boolean;
  atExtraction: boolean;
}

export function createFlags(): MissionFlags {
  return {
    exteriorHostilesRemaining: 99,
    gatekeeperAlive: false,
    gatekeeperDefeated: false,
    moduleAcquired: false,
    atGateTerminal: false,
    gateOpen: false,
    insideFactory: false,
    reachedControlRoom: false,
    hostagesSeen: false,
    bossRelaysDown: 0,
    bossCoolantDown: false,
    bossCoreDown: false,
    hostagesReleased: false,
    atExtraction: false,
  };
}

/**
 * The single authority for mission progress.
 *
 * Design rules, all of which exist because the alternative has bitten this
 * project before:
 *
 *  - ONE writer. `state` is private; everything goes through request().
 *  - Transitions are DEFERRED to the end of the frame. A state's enter() may
 *    request another transition without re-entrancy, and two systems requesting
 *    the same transition in one frame produce one transition, not two.
 *  - Every state may declare a `timeout`. A vertical slice that soft-locks
 *    because a trigger volume was missed is worse than one that advances
 *    slightly early, and this is the safety net for that.
 *  - Death and restart are states, not side channels, so the reset path is the
 *    same path as everything else.
 */
export class MissionStateMachine {
  private current: MissionState = 'BOOT';
  private pending: MissionState | null = null;
  private readonly defs = new Map<MissionState, StateDef>();
  private readonly said = new Set<string>();
  readonly ctx: MissionContext;

  /** Set by the game; fires once per genuine transition. */
  onEnter: ((state: MissionState, previous: MissionState) => void) | null = null;

  /** The checkpoint a death will restore. Updated as the player progresses. */
  checkpoint: Checkpoint = 'EXTERIOR_ENTRY';

  constructor(bus: EventBus) {
    this.ctx = {
      bus,
      time: 0,
      missionTime: 0,
      playerAlive: true,
      playerX: 0,
      flags: createFlags(),
      say: (key, speaker, text) => {
        if (this.said.has(key)) return;
        this.said.add(key);
        bus.emit('mission:radio', { speaker, text });
      },
    };
  }

  get state(): MissionState {
    return this.current;
  }

  get isPlayable(): boolean {
    return PLAYABLE.has(this.current);
  }

  get combatActive(): boolean {
    return COMBAT_ACTIVE.has(this.current);
  }

  /** True once `state` has been reached at least once this run. */
  isAtOrPast(state: MissionState): boolean {
    return MISSION_ORDER.indexOf(this.current) >= MISSION_ORDER.indexOf(state);
  }

  define(state: MissionState, def: StateDef): void {
    this.defs.set(state, def);
  }

  /**
   * Ask to move to `next`. Ignored if already there or already pending, which
   * is what makes a trigger volume firing on every frame harmless.
   */
  request(next: MissionState): void {
    if (next === this.current || this.pending === next) return;
    this.pending = next;
  }

  /** Debug and checkpoint restore: jump without the intervening states. */
  forceTo(next: MissionState): void {
    this.pending = next;
  }

  update(dt: number): void {
    this.ctx.time += dt;
    if (this.isPlayable) this.ctx.missionTime += dt;

    const def = this.defs.get(this.current);
    if (def?.update) {
      const next = def.update(this.ctx, dt);
      if (next) this.request(next);
    }
    if (def?.timeout !== undefined && def.onTimeout && this.ctx.time >= def.timeout) {
      this.request(def.onTimeout);
    }

    // Deferred commit. Loops because an enter() may request the next state
    // immediately (e.g. a pass-through beat), but is bounded so a pair of
    // states that request each other cannot hang the frame.
    let guard = 0;
    while (this.pending && guard++ < 8) {
      const next = this.pending;
      this.pending = null;
      this.commit(next);
    }
    if (guard >= 8) {
      console.warn('[Mission] transition storm; parked at', this.current);
      this.pending = null;
    }
  }

  private commit(next: MissionState): void {
    if (next === this.current) return;
    const previous = this.current;
    this.defs.get(previous)?.exit?.(this.ctx);
    this.current = next;
    this.ctx.time = 0;

    const checkpoint = CHECKPOINT_OF[next];
    if (MISSION_ORDER.indexOf(checkpoint) > MISSION_ORDER.indexOf(this.checkpoint)) {
      this.checkpoint = checkpoint;
    }

    const objective = OBJECTIVE_OF[next];
    if (objective) this.ctx.bus.emit('mission:objective', { text: objective });

    this.defs.get(next)?.enter?.(this.ctx);
    this.onEnter?.(next, previous);
  }

  /** Full reset for a retry. Restores to the stored checkpoint. */
  restartAtCheckpoint(): void {
    this.said.clear();
    this.ctx.flags = createFlags();
    this.ctx.time = 0;
    this.forceTo(this.checkpoint);
  }

  /** Reset to the very beginning, as for a return to the title. */
  resetAll(): void {
    this.said.clear();
    this.ctx.flags = createFlags();
    this.ctx.time = 0;
    this.ctx.missionTime = 0;
    this.checkpoint = 'EXTERIOR_ENTRY';
    this.current = 'BOOT';
    this.pending = null;
  }
}
