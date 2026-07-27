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
