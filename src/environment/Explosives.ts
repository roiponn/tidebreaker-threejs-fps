import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import type { EventBus } from '@/core/EventBus';
import { Rng } from '@/core/Rng';
import { damp } from '@/core/MathUtils';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import type { MutableVisual } from '@/config/visual';
import { chamferBox } from './GeometryKit';

/**
 * Shootable fuel drums.
 *
 * The only genuinely destructible objects in the slice, and deliberately so:
 * the brief asks for "lightweight destruction", and a handful of authored,
 * hand-placed explosives that chain-react gives a far better set-piece than a
 * generic destruction system would at this scope.
 *
 * Lifecycle: intact -> venting (a 0.6s fuse with a jet of fire and a visible
 * wobble, which is the tell that tells the player to back off) -> detonated.
 * The fuse is what makes the explosion feel caused rather than scripted.
 */
interface Drum {
  group: THREE.Group;
  position: THREE.Vector3;
  health: number;
  state: 'intact' | 'venting' | 'gone';
  fuse: number;
  wobble: number;
  wobblePhase: number;
  collisionRegistered: boolean;
  /** Index within `drums`, used by the chain-reaction test log. */
  id: number;
}

export class Explosives {
  readonly group = new THREE.Group();
  private drums: Drum[] = [];
  private rng = new Rng(0xbadb001);
  private disposables: Array<{ dispose(): void }> = [];
  private ventSmokeTimer = 0;

  /** Wired by the game so a venting drum can spit fire before it goes. */
  onVentTick: ((position: THREE.Vector3) => void) | null = null;

  /**
   * Chain-reaction trace, for the deterministic test path (?chaintest=).
   * Each entry is `id@elapsed:cause`. Reading it is the only way to confirm
   * propagation order, timing stagger, single-trigger protection and
   * termination without being able to watch a 2-second event by hand.
   */
  readonly chainLog: string[] = [];
  private clock = 0;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly bus: EventBus,
    private readonly visual: MutableVisual,
    private readonly collision: CollisionWorld,
  ) {
    this.group.name = 'Explosives';
  }

  spawnAt(positions: THREE.Vector3[]): void {
    const bodyGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.86, 16, 1, false);
    const hoopGeo = new THREE.TorusGeometry(0.295, 0.022, 6, 16);
    const lidGeo = new THREE.CylinderGeometry(0.3, 0.29, 0.05, 16);
    const placardGeo = chamferBox(0.2, 0.14, 0.012, 0.004, 1);
    this.disposables.push(bodyGeo, hoopGeo, lidGeo, placardGeo);

    const shell = this.mats.container('Rust');
    const steel = this.mats.steelBare();
    const hazard = this.mats.hazard();

    for (const position of positions) {
      const group = new THREE.Group();
      group.position.copy(position);
      group.rotation.y = this.rng.range(0, Math.PI * 2);

      const body = new THREE.Mesh(bodyGeo, shell);
      body.position.y = 0.43;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      for (const y of [0.02, 0.87]) {
        const lid = new THREE.Mesh(lidGeo, steel);
        lid.position.y = y;
        lid.castShadow = true;
        group.add(lid);
      }
      for (const y of [0.3, 0.58]) {
        const hoop = new THREE.Mesh(hoopGeo, steel);
        hoop.position.y = y;
        hoop.rotation.x = Math.PI / 2;
        group.add(hoop);
      }
      // Hazard placard: the visual language that says "shoot me".
      const placard = new THREE.Mesh(placardGeo, hazard);
      placard.position.set(0, 0.5, 0.295);
      group.add(placard);

      group.traverse((node) => node.layers.set(LAYER.WORLD));
      this.group.add(group);
      this.collision.addRaycastTarget(group);

      const drum: Drum = {
        group,
        position: position.clone(),
        health: 34,
        state: 'intact',
        fuse: 0,
        wobble: 0,
        wobblePhase: this.rng.range(0, 6.28),
        collisionRegistered: true,
        id: this.drums.length,
      };
      this.collision.addBox(
        new THREE.Vector3(position.x - 0.3, position.y, position.z - 0.3),
        new THREE.Vector3(position.x + 0.3, position.y + 0.9, position.z + 0.3),
        'thinMetal',
        true,
      );
      this.drums.push(drum);
    }
  }

  /**
   * Called from the impact handler. Any round landing within 0.45m of a drum
   * damages it - a cheap proximity test that avoids per-drum ray tests.
   */
  registerImpact(point: THREE.Vector3, damage: number): void {
    for (const drum of this.drums) {
      if (drum.state !== 'intact') continue;
      const dx = point.x - drum.position.x;
      const dy = point.y - (drum.position.y + 0.45);
      const dz = point.z - drum.position.z;
      if (dx * dx + dy * dy + dz * dz > 0.42 * 0.42) continue;
      drum.health -= damage;
      drum.wobble = 1;
      if (drum.health <= 0) this.startFuse(drum);
      return;
    }
  }

  /**
   * Test entry point: force a drum to start its fuse as if it had been shot.
   * Returns false if it is already lit or destroyed - which is itself part of
   * what the test verifies.
   */
  debugTrigger(index: number): boolean {
    const drum = this.drums[index];
    if (!drum || drum.state !== 'intact') return false;
    this.chainLog.push(`${index}@${this.clock.toFixed(2)}:manual`);
    this.startFuse(drum);
    return true;
  }

  get drumStates(): string {
    return this.drums.map((d) => d.state[0]).join('');
  }

  private startFuse(drum: Drum): void {
    drum.state = 'venting';
    // A short, visible fuse. Long enough to react to, short enough to feel
    // like a consequence of the shot rather than a timer.
    drum.fuse = 0.55 + this.rng.range(0, 0.25);
  }

  private detonate(drum: Drum): void {
    drum.state = 'gone';
    drum.group.visible = false;
    this.chainLog.push(`${drum.id}@${this.clock.toFixed(2)}:BLEW`);
    const position = drum.position.clone();
    position.y += 0.45;
    this.bus.emit('explosion', {
      position,
      radius: this.visual.explosion.radius,
      power: 1,
    });
    // CHAIN REACTION.
    //
    // A nearby drum is not detonated directly - it takes blast DAMAGE and, if
    // that is enough, lights its own fuse. So propagation obeys the same
    // distance falloff and the same health threshold as gunfire, and a drum on
    // the edge of the radius survives.
    //
    // `state !== 'intact'` is the single-trigger guard: a drum that is already
    // venting or gone is skipped, so it can never be lit twice and the chain
    // is guaranteed to terminate (each drum leaves the intact set exactly once).
    for (const other of this.drums) {
      if (other === drum || other.state !== 'intact') continue;
      const distance = other.position.distanceTo(drum.position);
      if (distance >= this.visual.explosion.radius) continue;
      const falloff = 1 - distance / this.visual.explosion.radius;
      other.health -= this.visual.explosion.damage * falloff * falloff;
      other.wobble = 1;
      if (other.health > 0) continue;
      // Closer drums cook off sooner, with a little jitter so a cluster does
      // not detonate as one simultaneous flash.
      other.state = 'venting';
      other.fuse = 0.12 + (1 - falloff) * 0.35 + this.rng.range(0, 0.16);
      this.chainLog.push(
        `${other.id}@${this.clock.toFixed(2)}:by${drum.id}d${distance.toFixed(1)}`,
      );
    }
  }

  update(dt: number, elapsed: number): void {
    this.clock = elapsed;
    this.ventSmokeTimer -= dt;
    const emitVent = this.ventSmokeTimer <= 0;
    if (emitVent) this.ventSmokeTimer = 0.045;

    for (const drum of this.drums) {
      if (drum.state === 'gone') continue;

      // Being hit makes the drum rock on its base - the readable "damaged" cue.
      if (drum.wobble > 0.001) {
        drum.wobble = damp(drum.wobble, 0, 3.4, dt);
        const a = drum.wobble * 0.07;
        drum.group.rotation.x = Math.sin(elapsed * 21 + drum.wobblePhase) * a;
        drum.group.rotation.z = Math.cos(elapsed * 18 + drum.wobblePhase) * a;
      }

      if (drum.state === 'venting') {
        drum.fuse -= dt;
        // Escalating shake as the fuse runs out.
        const urgency = 1 - Math.max(0, drum.fuse) / 0.8;
        drum.group.rotation.x += Math.sin(elapsed * 46) * 0.02 * urgency;
        drum.group.position.y = drum.position.y + Math.abs(Math.sin(elapsed * 38)) * 0.03 * urgency;
        if (emitVent && this.onVentTick) {
          this.onVentTick(tmpVent.copy(drum.position).setY(drum.position.y + 0.9));
        }
        if (drum.fuse <= 0) this.detonate(drum);
      }
    }
  }

  /** Explosion damage against the player, applied by the game. */
  getBlastDamage(position: THREE.Vector3, target: THREE.Vector3): number {
    const distance = position.distanceTo(target);
    const radius = this.visual.explosion.radius;
    if (distance > radius) return 0;
    // Quadratic falloff: standing next to one is lethal, 6m away is a scare.
    const falloff = 1 - distance / radius;
    return this.visual.explosion.damage * falloff * falloff;
  }

  reset(): void {
    this.chainLog.length = 0;
    for (const drum of this.drums) {
      drum.state = 'intact';
      drum.health = 34;
      drum.fuse = 0;
      drum.wobble = 0;
      drum.group.visible = true;
      drum.group.rotation.set(0, drum.group.rotation.y, 0);
      drum.group.position.copy(drum.position);
    }
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.drums.length = 0;
    this.group.removeFromParent();
  }
}

const tmpVent = new THREE.Vector3();
