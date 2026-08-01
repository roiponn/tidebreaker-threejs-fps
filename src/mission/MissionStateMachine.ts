import type { EventBus } from '@/core/EventBus';
import {
  CHECKPOINT_OF,
  COMBAT_ACTIVE,
  INPUT_OF,
  MISSION_ORDER,
  OBJECTIVE_OF,
  PLAYABLE,
  type Checkpoint,
  type MissionInputPermissions,
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
  /** Set by MissionDirector when the short first-person insertion finishes. */
  introComplete: boolean;
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

export function createFlags(checkpoint: Checkpoint = 'EXTERIOR_ENTRY'): MissionFlags {
  const flags: MissionFlags = {
    introComplete: false,
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

  if (checkpoint === 'GATEKEEPER_DEFEATED' || checkpoint === 'FACTORY_ENTRY' || checkpoint === 'BOSS_INTRO') {
    flags.introComplete = true;
    flags.exteriorHostilesRemaining = 0;
    flags.gatekeeperAlive = false;
    flags.gatekeeperDefeated = true;
  }

  if (checkpoint === 'FACTORY_ENTRY' || checkpoint === 'BOSS_INTRO') {
    flags.moduleAcquired = true;
    flags.gateOpen = true;
  }

  if (checkpoint === 'BOSS_INTRO') {
    flags.insideFactory = true;
    flags.reachedControlRoom = true;
    flags.hostagesSeen = true;
  }

  return flags;
}

/** Mutates an existing flag object so observers may safely retain its identity. */
export function restoreFlags(target: MissionFlags, checkpoint: Checkpoint): void {
  Object.assign(target, createFlags(checkpoint));
}

const NORMAL_PRIORITY = 0;
const RESTART_PRIORITY = 50;
const DEATH_PRIORITY = 100;

interface PendingTransition {
  state: MissionState;
  priority: number;
  forced: boolean;
}

const LEGAL_TRANSITIONS: Readonly<Record<MissionState, ReadonlySet<MissionState>>> = {
  BOOT: new Set(['BRIEFING']),
  BRIEFING: new Set(['EXTERIOR_ENTRY']),
  EXTERIOR_ENTRY: new Set(['EXTERIOR_COMBAT', 'PLAYER_DEAD']),
  EXTERIOR_COMBAT: new Set(['GATEKEEPER_INTRO', 'PLAYER_DEAD']),
  GATEKEEPER_INTRO: new Set(['GATEKEEPER_ACTIVE', 'PLAYER_DEAD']),
  GATEKEEPER_ACTIVE: new Set(['GATEKEEPER_DEFEATED', 'PLAYER_DEAD']),
  GATEKEEPER_DEFEATED: new Set(['ACCESS_MODULE_DROPPED', 'PLAYER_DEAD']),
  ACCESS_MODULE_DROPPED: new Set(['ACCESS_MODULE_ACQUIRED', 'PLAYER_DEAD']),
  ACCESS_MODULE_ACQUIRED: new Set(['GATE_TERMINAL_ACTIVE', 'PLAYER_DEAD']),
  GATE_TERMINAL_ACTIVE: new Set(['GATE_OPENING', 'PLAYER_DEAD']),
  GATE_OPENING: new Set(['FACTORY_ENTRY', 'PLAYER_DEAD']),
  FACTORY_ENTRY: new Set(['INTERIOR_APPROACH', 'PLAYER_DEAD']),
  INTERIOR_APPROACH: new Set(['HOSTAGES_DISCOVERED', 'PLAYER_DEAD']),
  HOSTAGES_DISCOVERED: new Set(['BOSS_INTRO', 'PLAYER_DEAD']),
  BOSS_INTRO: new Set(['BOSS_PHASE_1', 'PLAYER_DEAD']),
  BOSS_PHASE_1: new Set(['BOSS_PHASE_2', 'PLAYER_DEAD']),
  BOSS_PHASE_2: new Set(['BOSS_PHASE_3', 'PLAYER_DEAD']),
  BOSS_PHASE_3: new Set(['BOSS_DEFEATED', 'PLAYER_DEAD']),
  BOSS_DEFEATED: new Set(['TRUTH_REVEAL', 'PLAYER_DEAD']),
  TRUTH_REVEAL: new Set(['HOSTAGE_RELEASE', 'PLAYER_DEAD']),
  HOSTAGE_RELEASE: new Set(['EXTRACTION', 'PLAYER_DEAD']),
  EXTRACTION: new Set(['MISSION_COMPLETE', 'PLAYER_DEAD']),
  MISSION_COMPLETE: new Set(),
  PLAYER_DEAD: new Set(['RESTARTING']),
  RESTARTING: new Set(['EXTERIOR_ENTRY', 'GATEKEEPER_DEFEATED', 'FACTORY_ENTRY', 'BOSS_INTRO']),
};

const LAST_PROGRESS_INDEX = MISSION_ORDER.indexOf('MISSION_COMPLETE');

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
  private pending: PendingTransition | null = null;
  private readonly defs = new Map<MissionState, StateDef>();
  private readonly said = new Set<string>();
  private readonly reached = new Set<MissionState>(['BOOT']);
  private furthestProgress = 0;
  private restartTarget: Checkpoint | null = null;
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

  get inputPermissions(): MissionInputPermissions {
    return INPUT_OF[this.current];
  }

  /** True once `state` has been reached at least once this run. */
  isAtOrPast(state: MissionState): boolean {
    const index = MISSION_ORDER.indexOf(state);
    return index <= LAST_PROGRESS_INDEX ? this.furthestProgress >= index : this.reached.has(state);
  }

  hasReached(state: MissionState): boolean {
    return this.reached.has(state);
  }

  get reachedStates(): ReadonlySet<MissionState> {
    return this.reached;
  }

  define(state: MissionState, def: StateDef): void {
    this.defs.set(state, def);
  }

  /**
   * Ask to move to `next`. Ignored if already there or already pending, which
   * is what makes a trigger volume firing on every frame harmless.
   */
  request(next: MissionState): boolean {
    if (!LEGAL_TRANSITIONS[this.current].has(next)) {
      console.warn(`[Mission] rejected illegal transition ${this.current} -> ${next}`);
      return false;
    }
    return this.queue(next, next === 'PLAYER_DEAD' ? DEATH_PRIORITY : NORMAL_PRIORITY, false);
  }

  /** Debug only: jump without validating the intervening states. */
  forceTo(next: MissionState): void {
    this.queue(next, Number.POSITIVE_INFINITY, true);
  }

  update(dt: number): void {
    this.ctx.time += dt;
    if (this.isPlayable) this.ctx.missionTime += dt;

    // Death wins every same-frame race, including a phase-complete update that
    // happens after the lethal hit. It is deliberately queued before the state
    // handler; lower-priority requests cannot replace it.
    if (!this.ctx.playerAlive && this.canDie(this.current)) {
      this.queue('PLAYER_DEAD', DEATH_PRIORITY, false);
    }

    const def = this.defs.get(this.current);
    if (def?.update) {
      const next = def.update(this.ctx, dt);
      if (next) this.request(next);
    }
    if (def?.timeout !== undefined && def.onTimeout && this.ctx.time >= def.timeout) {
      this.request(def.onTimeout);
    }

    if (this.current === 'RESTARTING' && this.restartTarget) {
      this.request(this.restartTarget);
    }

    // Deferred commit. Loops because an enter() may request the next state
    // immediately (e.g. a pass-through beat), but is bounded so a pair of
    // states that request each other cannot hang the frame.
    let guard = 0;
    while (this.pending && guard++ < 8) {
      const next = this.pending.state;
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
    this.reached.add(next);
    const progressIndex = MISSION_ORDER.indexOf(next);
    if (progressIndex >= 0 && progressIndex <= LAST_PROGRESS_INDEX) {
      this.furthestProgress = Math.max(this.furthestProgress, progressIndex);
    }

    const checkpoint = CHECKPOINT_OF[next];
    if (MISSION_ORDER.indexOf(checkpoint) > MISSION_ORDER.indexOf(this.checkpoint)) {
      this.checkpoint = checkpoint;
    }

    const objective = OBJECTIVE_OF[next];
    if (objective !== undefined) this.ctx.bus.emit('mission:objective', { text: objective });

    this.defs.get(next)?.enter?.(this.ctx);
    this.ctx.bus.emit('mission:state', { state: next, previous });
    this.onEnter?.(next, previous);
    if (next !== 'RESTARTING' && next === this.restartTarget) this.restartTarget = null;
  }

  /** Full reset for a retry. Restores to the stored checkpoint. */
  restartAtCheckpoint(): boolean {
    if (this.current !== 'PLAYER_DEAD') return false;
    this.said.clear();
    restoreFlags(this.ctx.flags, this.checkpoint);
    this.ctx.time = 0;
    this.restartTarget = this.checkpoint;
    return this.queue('RESTARTING', RESTART_PRIORITY, false);
  }

  /** Reset to the very beginning, as for a return to the title. */
  resetAll(): void {
    const previous = this.current;
    this.defs.get(previous)?.exit?.(this.ctx);
    this.said.clear();
    restoreFlags(this.ctx.flags, 'EXTERIOR_ENTRY');
    this.ctx.time = 0;
    this.ctx.missionTime = 0;
    this.ctx.playerAlive = true;
    this.checkpoint = 'EXTERIOR_ENTRY';
    this.current = 'BOOT';
    this.pending = null;
    this.restartTarget = null;
    this.reached.clear();
    this.reached.add('BOOT');
    this.furthestProgress = 0;
    if (previous !== 'BOOT') {
      this.ctx.bus.emit('mission:state', { state: 'BOOT', previous });
      this.onEnter?.('BOOT', previous);
    }
  }

  private canDie(state: MissionState): boolean {
    return state !== 'BOOT' &&
      state !== 'BRIEFING' &&
      state !== 'MISSION_COMPLETE' &&
      state !== 'PLAYER_DEAD' &&
      state !== 'RESTARTING';
  }

  private queue(next: MissionState, priority: number, forced: boolean): boolean {
    if (next === this.current || this.pending?.state === next) return false;
    if (this.pending) {
      if (this.pending.forced || this.pending.priority > priority) return false;
      // Equal priority is first-writer-wins. A noisy trigger cannot replace a
      // different transition merely because it happened later in the frame.
      if (this.pending.priority === priority) return false;
    }
    this.pending = { state: next, priority, forced };
    return true;
  }
}
