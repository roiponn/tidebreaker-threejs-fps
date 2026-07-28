import type * as THREE from 'three';

/**
 * Typed pub/sub. Keeps gameplay, VFX, audio and UI decoupled: the weapon does
 * not know the HUD exists, it just emits `weapon:fired` and every listener
 * reacts on the same frame. This is what keeps audio/visual sync trivial.
 */

export type SurfaceKind =
  | 'concrete'
  | 'metal'
  | 'thinMetal'
  | 'water'
  | 'wood'
  | 'glass'
  | 'sand'
  | 'flesh'
  | 'fence';

export interface GameEvents {
  'weapon:fired': { origin: THREE.Vector3; direction: THREE.Vector3; ammo: number };
  'weapon:dryFire': void;
  'weapon:reloadStart': { empty: boolean; duration: number };
  'weapon:reloadEnd': void;
  'weapon:magOut': void;
  'weapon:magIn': void;
  'weapon:boltRelease': void;
  'weapon:adsChanged': { ads: boolean };
  'weapon:ammoChanged': { mag: number; reserve: number };

  'impact:surface': {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    surface: SurfaceKind;
    /** Incoming direction, used to angle sparks and debris away from the wall. */
    incident: THREE.Vector3;
    /** Distance from the listener, drives impact audio volume. */
    distance: number;
  };
  'impact:enemy': { point: THREE.Vector3; normal: THREE.Vector3; headshot: boolean; killed: boolean };

  'enemy:killed': { position: THREE.Vector3; remaining: number };
  'enemy:fired': { origin: THREE.Vector3; direction: THREE.Vector3 };

  // --- GATEKEEPER (exterior mid-boss) -------------------------------
  //
  // These are the fight's AUDIO HOOK POINTS as much as anything else. The
  // shield/vent cycle is the only thing that differentiates this unit from an
  // ordinary hostile, so every beat of that cycle has to be announceable
  // without the audio engine knowing what a Gatekeeper is.
  /** It has seen the player and locked its shield forward. Klaxon / stinger. */
  'gatekeeper:engaged': { position: THREE.Vector3 };
  /** Shield leaves started moving. `open` false = re-sealing. Servo motor. */
  'gatekeeper:shield': { position: THREE.Vector3; open: boolean };
  /**
   * The vent window - the only time the coil can be hurt. `open` true on
   * entry, false on exit. Pressure release on entry, clamp-shut on exit.
   */
  'gatekeeper:vent': { position: THREE.Vector3; open: boolean };
  /**
   * One resolved hit. `zone` says WHERE it landed and `blocked` is true when
   * the armour ate it, so the HUD can show a "no effect" marker instead of a
   * normal hitmarker - which is how the player learns the shield is real.
   */
  'gatekeeper:damaged': {
    point: THREE.Vector3;
    zone: 'shield' | 'hull' | 'coil';
    applied: number;
    blocked: boolean;
    healthFraction: number;
  };
  /** Down. Emitted once, at the start of the death slump. */
  'gatekeeper:defeated': { position: THREE.Vector3 };
  /** The access module has come off its back and is now a world pickup. */
  'gatekeeper:moduleDropped': { position: THREE.Vector3; object: THREE.Object3D };

  'player:damaged': { amount: number; fromDirection: THREE.Vector3; health: number };
  'player:died': void;
  'player:landed': { impact: number };
  'player:footstep': { sprinting: boolean; surface: SurfaceKind };

  'explosion': { position: THREE.Vector3; radius: number; power: number };
  'camera:shake': { amplitude: number; duration: number; frequency?: number };

  'mission:started': void;
  'mission:objective': { text: string };
  'mission:complete': { timeSec: number; kills: number; accuracy: number };
  'mission:failed': void;
  /** A radio or PA line. `speaker` null clears the current line. */
  'mission:radio': { speaker: string | null; text: string | null };
  /** Mission state changed. Systems react to this rather than polling. */
  'mission:state': { state: string; previous: string };
  /** Beat cues the world systems subscribe to. */
  'mission:gatekeeperSpawn': void;
  'mission:gateOpen': void;
  'mission:bossSpawn': void;
  'mission:bossDown': void;
  'mission:truthReveal': void;
  'mission:extraction': void;
  'mission:emergencyLighting': { on: boolean };

  // --- WARDEN-03, the final boss ------------------------------------------
  //
  // ADDITIVE ONLY. The boss owns no other system: it never touches the HUD,
  // the lighting rig, the mission flags or the player's health directly. It
  // narrates itself through these events and lets whoever cares subscribe,
  // which is the same contract the weapon has with the muzzle flash.
  //
  // In particular `boss:playerHit` is a REQUEST, not an application of damage:
  // the boss does not own the player, so it describes the blow and lets the
  // player workstream decide what it costs.
  'boss:spawned': { name: string; position: THREE.Vector3 };
  /** Phase 1 sealed, 2 overheating, 3 emergency power. Fired on entry. */
  'boss:phase': { phase: number; name: string };
  'boss:relayDown': { index: number; remaining: number; position: THREE.Vector3 };
  'boss:coolantExposed': void;
  /** Staged destruction of the coolant stack: 0 intact, 2 about to fail. */
  'boss:coolantStage': { stage: number; health01: number };
  'boss:coolantDown': void;
  'boss:armourShed': { position: THREE.Vector3 };
  'boss:coreExposed': void;
  'boss:coreDown': void;
  'boss:defeated': { name: string };
  'boss:weakPointHit': {
    kind: 'relay' | 'coolant' | 'core';
    point: THREE.Vector3;
    normal: THREE.Vector3;
    damage: number;
    /** Remaining health of that weak point, 0..1. Drives the boss HUD bar. */
    health01: number;
    destroyed: boolean;
  };
  /** A round that hit armour instead of a weak point. `absorbed` is 0..1. */
  'boss:armourHit': { point: THREE.Vector3; normal: THREE.Vector3; absorbed: number };
  /** Wind-up begins. `windup` is the dodge window, in seconds. */
  'boss:attack': { kind: string; windup: number; position: THREE.Vector3 };
  'boss:attackFired': { kind: string; position: THREE.Vector3 };
  'boss:playerHit': { kind: string; amount: number; fromDirection: THREE.Vector3 };
  /** Fire-suppressant in the player's face. `blind` is 0..1 screen occlusion. */
  'boss:suppressant': { active: boolean; blind: number };
  'boss:stagger': void;
  /**
   * The boss REFUSED an action because it would have pointed at the people it
   * believes it is protecting. Emitted so the beat is observable in a trace -
   * see the story constraint in Warden03Controller.
   */
  'boss:constrained': { reason: 'protectedVolume'; kind: string };

  'quality:changed': void;
  'hitmarker': { headshot: boolean; killed: boolean };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(
    event: K,
    ...args: GameEvents[K] extends void ? [] : [GameEvents[K]]
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    const payload = args[0] as GameEvents[K];
    for (const handler of set) {
      try {
        (handler as Handler<GameEvents[K]>)(payload);
      } catch (err) {
        // One broken listener must never stall the frame - log and continue.
        console.error(`[EventBus] handler for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
