import * as THREE from 'three';
import { MISSION_CONFIG } from '@/config/gameplay';
import { CAST } from '@/config/mission';
import type { EventBus } from '@/core/EventBus';
import { clamp01, smoothstep } from '@/core/MathUtils';
import { buildMissionGraph } from '@/mission/MissionGraph';
import {
  MissionStateMachine,
  type MissionFlags,
} from '@/mission/MissionStateMachine';
import type {
  Checkpoint,
  MissionInputPermissions,
  MissionState,
} from '@/mission/MissionState';

/**
 * Mission flow: the opening sequence, the objective state and the ending.
 *
 * The intro is deliberately short (about 6 seconds) and does not take control
 * away for long. It exists to do three specific things:
 *   1. establish the frame - letterbox + a slow rise from a crouch, which
 *      shows the canopy silhouette, the lit yard and the extraction strobe in
 *      one continuous move;
 *   2. establish the fiction - two lines of radio chatter, no cutscene;
 *   3. hand over control before the player gets bored of watching.
 *
 * Everything is time-driven from one `elapsed` value so it can be scrubbed or
 * skipped safely.
 */
export type MissionPhase = 'briefing' | 'intro' | 'active' | 'complete' | 'failed';

interface ChatterLine {
  at: number;
  speaker: string;
  text: string;
}

const CHATTER: ChatterLine[] = [
  { at: 0.6, speaker: CAST.handler, text: 'Tidebreaker, three life signs confirmed. Perimeter systems are engaging.' },
  { at: 3.4, speaker: CAST.handler, text: 'Breach the yard. The gate unit is carrying the physical authentication.' },
];

export class MissionDirector {
  /** The sole authority for mission progression. Presentation never owns state. */
  private readonly machine: MissionStateMachine;

  /** Seconds since the intro began. */
  timer = 0;

  /**
   * 0..1 - how much the intro is still driving the camera.
   * Zero outside the intro phase: during the briefing the camera must sit at
   * normal eye height so the attract shot is the real first-person framing.
   */
  introBlend = 0;
  /**
   * Screen fade 0..1, applied by the composite pass.
   * Starts at 0 so the briefing screen sits over a live view of the harbour -
   * the attract shot is the first impression and should not be a black card.
   */
  fade = 0;
  letterbox = false;

  private currentChatter = -1;

  /** Hooks the game wires up. */
  onChatter: ((speaker: string | null, text: string | null) => void) | null = null;
  onLetterbox: ((show: boolean) => void) | null = null;
  onStateChange: ((state: MissionState, previous: MissionState) => void) | null = null;

  constructor(private readonly bus: EventBus) {
    this.machine = new MissionStateMachine(bus);
    buildMissionGraph(this.machine);
    this.machine.onEnter = (state, previous) => {
      this.handleStateEnter(state, previous);
      this.onStateChange?.(state, previous);
    };
    // BOOT is a pass-through implementation state. Commit BRIEFING now so the
    // first user click always requests a legal BRIEFING -> EXTERIOR_ENTRY edge.
    this.machine.update(0);
  }

  begin(): boolean {
    if (this.machine.state !== 'BRIEFING') return false;
    this.bus.emit('mission:started');
    const accepted = this.machine.request('EXTERIOR_ENTRY');
    // A click is a discrete action outside the frame update. Commit it now so
    // the overlay and the first rendered insertion frame cannot disagree.
    this.machine.update(0);
    return accepted;
  }

  private startIntroPresentation(): void {
    this.timer = 0;
    this.introBlend = 1;
    this.fade = 1;
    this.letterbox = true;
    this.currentChatter = -1;
    this.machine.ctx.flags.introComplete = false;
    this.onLetterbox?.(true);
  }

  reset(): void {
    this.machine.resetAll();
    this.timer = 0;
    this.introBlend = 0;
    this.fade = 0;
    this.letterbox = false;
    this.currentChatter = -1;
    this.onLetterbox?.(false);
    this.onChatter?.(null, null);
    this.machine.update(0);
  }

  /**
   * Returns the intro camera offset: a rise from a low crouch with a slight
   * settle, plus a small yaw sweep that reveals the length of the berth.
   */
  getIntroOffset(target: { heightOffset: number; yawOffset: number; pitchOffset: number }): void {
    const t = clamp01(this.timer / MISSION_CONFIG.introDurationSec);
    // Rise: fast at first, easing into standing. Overshoot slightly then settle.
    const rise = smoothstep(clamp01(t / 0.55));
    const settle = Math.sin(clamp01((t - 0.5) / 0.5) * Math.PI) * 0.035;
    target.heightOffset = (1 - rise) * -0.78 + settle;
    // Yaw sweep: start looking down at the deck and to the right, come round
    // to the objective line. Gives the opening shot movement without a cut.
    const sweep = smoothstep(clamp01((t - 0.15) / 0.7));
    target.yawOffset = (1 - sweep) * 0.42;
    target.pitchOffset = (1 - sweep) * -0.38;
  }

  update(dt: number, playerX: number, enemiesRemaining: number, extractionDistance: number, playerAlive: boolean): void {
    const ctx = this.machine.ctx;
    ctx.playerX = playerX;
    ctx.playerAlive = playerAlive;
    ctx.flags.exteriorHostilesRemaining = enemiesRemaining;
    ctx.flags.atExtraction =
      this.machine.state === 'EXTRACTION' && extractionDistance < MISSION_CONFIG.extractRadius;

    if (this.machine.state === 'EXTERIOR_ENTRY' && !ctx.flags.introComplete) {
      this.updateIntroPresentation(dt);
    }

    this.machine.update(dt);

    if (this.machine.state === 'MISSION_COMPLETE' || this.machine.state === 'PLAYER_DEAD') {
      // Fade out under the end card without making the fade a second state
      // machine. The authoritative state is still the one above.
      this.fade = Math.min(1, this.fade + dt * 0.9);
    }
  }

  private updateIntroPresentation(dt: number): void {
    this.timer += dt;
    const duration = MISSION_CONFIG.introDurationSec;
    // Fade up over the first second.
    this.fade = 1 - clamp01(this.timer / 1.1);
    this.introBlend = 1 - clamp01((this.timer - duration * 0.55) / (duration * 0.45));

    for (let i = CHATTER.length - 1; i >= 0; i--) {
      if (this.timer >= CHATTER[i].at && this.currentChatter < i) {
        this.currentChatter = i;
        this.onChatter?.(CHATTER[i].speaker, CHATTER[i].text);
        break;
      }
    }
    if (this.currentChatter >= 0 && this.timer > CHATTER[this.currentChatter].at + 2.6) {
      this.onChatter?.(null, null);
    }

    if (this.timer >= duration) this.completeIntroPresentation();
  }

  private completeIntroPresentation(): void {
    this.timer = MISSION_CONFIG.introDurationSec;
    this.introBlend = 0;
    this.fade = 0;
    this.letterbox = false;
    this.machine.ctx.flags.introComplete = true;
    this.onLetterbox?.(false);
    this.onChatter?.(null, null);
  }

  private handleStateEnter(state: MissionState, previous: MissionState): void {
    if (state !== 'EXTERIOR_ENTRY') return;
    if (previous === 'BRIEFING') {
      this.startIntroPresentation();
      return;
    }
    // A checkpoint retry must not replay the insertion camera. The state still
    // passes through EXTERIOR_ENTRY so the legal graph and objective remain the
    // same, but control is returned on the next update.
    this.completeIntroPresentation();
  }

  /** Debug: end the intro immediately, running its normal completion path. */
  finishIntro(): void {
    if (this.machine.state !== 'EXTERIOR_ENTRY') return;
    this.completeIntroPresentation();
  }

  /** Legacy coarse phase for the existing overlay/end-card bridge. */
  get phase(): MissionPhase {
    switch (this.machine.state) {
      case 'BOOT':
      case 'BRIEFING':
        return 'briefing';
      case 'EXTERIOR_ENTRY':
        return this.machine.ctx.flags.introComplete ? 'active' : 'intro';
      case 'MISSION_COMPLETE':
        return 'complete';
      case 'PLAYER_DEAD':
      case 'RESTARTING':
        return 'failed';
      default:
        return 'active';
    }
  }

  get isPlayable(): boolean {
    return this.machine.inputPermissions.move;
  }

  get state(): MissionState {
    return this.machine.state;
  }

  get inputPermissions(): MissionInputPermissions {
    return this.machine.inputPermissions;
  }

  get flags(): MissionFlags {
    return this.machine.ctx.flags;
  }

  get checkpoint(): Checkpoint {
    return this.machine.checkpoint;
  }

  get missionTime(): number {
    return this.machine.ctx.missionTime;
  }

  get combatActive(): boolean {
    return this.machine.combatActive;
  }

  requestState(next: MissionState): boolean {
    return this.machine.request(next);
  }

  /** Debug-only jump. Callers must restore matching world state first. */
  debugForceState(next: MissionState): void {
    this.machine.forceTo(next);
    this.machine.update(0);
  }

  restartAtCheckpoint(): boolean {
    return this.machine.restartAtCheckpoint();
  }

  setFlag<K extends keyof MissionFlags>(key: K, value: MissionFlags[K]): void {
    this.machine.ctx.flags[key] = value;
  }

  hasReached(state: MissionState): boolean {
    return this.machine.hasReached(state);
  }
}

/** Utility: mm:ss for the end card. */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const MISSION_UP = new THREE.Vector3(0, 1, 0);
