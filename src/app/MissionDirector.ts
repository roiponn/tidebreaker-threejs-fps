import * as THREE from 'three';
import { MISSION_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import { clamp01, smoothstep } from '@/core/MathUtils';

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
  { at: 0.6, speaker: 'ACTUAL', text: 'Tidebreaker, storm has cleared. Berth seven is still lit.' },
  { at: 3.4, speaker: 'ACTUAL', text: 'Push east to the pier head. Window closes in ninety seconds.' },
];

export class MissionDirector {
  phase: MissionPhase = 'briefing';
  /** Seconds since the intro began. */
  timer = 0;
  /** Seconds of active play, used for the end-of-mission stats. */
  missionTime = 0;

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
  private objectiveIssued = false;
  private extractionAnnounced = false;

  /** Hooks the game wires up. */
  onChatter: ((speaker: string | null, text: string | null) => void) | null = null;
  onLetterbox: ((show: boolean) => void) | null = null;

  constructor(private readonly bus: EventBus) {}

  begin(): void {
    this.phase = 'intro';
    this.timer = 0;
    this.missionTime = 0;
    this.introBlend = 1;
    this.fade = 1;
    this.letterbox = true;
    this.currentChatter = -1;
    this.objectiveIssued = false;
    this.extractionAnnounced = false;
    this.onLetterbox?.(true);
    this.bus.emit('mission:started');
  }

  reset(): void {
    this.phase = 'briefing';
    this.timer = 0;
    this.missionTime = 0;
    this.introBlend = 0;
    this.fade = 0;
    this.letterbox = false;
    this.onLetterbox?.(false);
    this.onChatter?.(null, null);
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
    switch (this.phase) {
      case 'intro': {
        this.timer += dt;
        const duration = MISSION_CONFIG.introDurationSec;
        // Fade up over the first second.
        this.fade = 1 - clamp01(this.timer / 1.1);
        this.introBlend = 1 - clamp01((this.timer - duration * 0.55) / (duration * 0.45));

        // Chatter.
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

        if (this.timer >= duration) {
          this.phase = 'active';
          this.introBlend = 0;
          this.letterbox = false;
          this.onLetterbox?.(false);
          this.onChatter?.(null, null);
          this.bus.emit('mission:objective', { text: 'ADVANCE TO THE PIER HEAD' });
        }
        break;
      }

      case 'active': {
        this.missionTime += dt;
        if (!playerAlive) {
          this.phase = 'failed';
          this.bus.emit('mission:failed');
          break;
        }
        // Objective escalation as the player progresses.
        if (!this.objectiveIssued && playerX > 28) {
          this.objectiveIssued = true;
          this.bus.emit('mission:objective', { text: 'CLEAR THE YARD' });
        }
        if (!this.extractionAnnounced && playerX > 46) {
          this.extractionAnnounced = true;
          this.bus.emit('mission:objective', { text: 'REACH THE EXTRACTION PAD' });
        }
        if (extractionDistance < MISSION_CONFIG.extractRadius && enemiesRemaining <= 2) {
          this.phase = 'complete';
        }
        break;
      }

      case 'complete':
      case 'failed':
        // Fade out under the end card.
        this.fade = Math.min(1, this.fade + dt * 0.9);
        break;

      default:
        break;
    }
  }

  get isPlayable(): boolean {
    return this.phase === 'active';
  }
}

/** Utility: mm:ss for the end card. */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const MISSION_UP = new THREE.Vector3(0, 1, 0);
