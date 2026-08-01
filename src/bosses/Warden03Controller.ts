import * as THREE from 'three';
import { CAST, MISSION_V2 } from '@/config/mission';
import type { EventBus } from '@/core/EventBus';
import { LAYER } from '@/core/Layers';
import { clamp, clamp01, damp, lerp, smoothstep } from '@/core/MathUtils';
import { Rng } from '@/core/Rng';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import { buildWarden03, WARDEN_METRICS, type WardenRig } from './Warden03';

/**
 * WARDEN-03 - the fight.
 *
 * ================================================================
 * WHY THE FIGHT IS SHAPED LIKE THIS
 * ================================================================
 *
 * The mission's whole reveal depends on the player being made to fight
 * something they will later learn was trying to keep people alive. That only
 * lands if the encounter itself is honest about what the machine is: every
 * phase is a RESCUE PROCEDURE aimed at the wrong target.
 *
 *   Phase 1  SEALED / SUPPRESSION   It is doing containment. Armour closed,
 *                                   suppressant out, sweeping the intruder
 *                                   away from the protected area. It is not
 *                                   trying to kill the player yet - it is
 *                                   trying to REMOVE them.
 *   Phase 2  OVERHEAT               Containment cost it its thermal budget.
 *                                   The stack blows open. It keeps working.
 *   Phase 3  EMERGENCY POWER        It cuts its own armour off to save weight
 *                                   and runs on the cells. It is spending
 *                                   itself. The lights go red because the
 *                                   FACTORY is now in emergency, not because
 *                                   the boss got angrier.
 *
 * Each phase changes four things at once - objective, weak point, attack set
 * and mood - because a boss whose phases only change a number is a boss whose
 * phases the player cannot feel. The tell for each transition is visual and
 * arrives before any HUD text: relays go dark, doors blow open, plates hit the
 * floor.
 *
 * ================================================================
 * READABILITY CONTRACT
 * ================================================================
 *
 * Every attack has (a) a wind-up of at least 0.75 seconds during which the
 * machine is visibly committing, (b) a pose that says which dodge works, and
 * (c) a recovery in which it is punishable. Nothing here can kill a player who
 * is paying attention, and nothing kills instantly at any health.
 *
 *   sweep   arm draws back and up      -> CROUCH under it
 *   slam    both arms raised overhead  -> JUMP the ring, or be outside it
 *   foam    nozzle drops and charges   -> BREAK THE CONE (strafe out)
 *   torch   torch arm cocks, arc lit   -> BACK OFF, it is very short ranged
 *   charge  squats, beacon strobes     -> SIDESTEP, it cannot turn mid-rush
 *
 * ================================================================
 * THE STORY CONSTRAINT  (read this before touching selectAttack)
 * ================================================================
 *
 * WARDEN-03 believes it is protecting the three people in the isolation bay.
 * Therefore it will not, under any circumstance:
 *
 *   1. aim an attack whose damage volume touches that bay, or
 *   2. position itself so the player's line of fire runs into that bay -
 *      i.e. it never uses them as a backstop or a shield.
 *
 * This is implemented for real, in `coneClearOfProtected()` and
 * `chooseStandPosition()`, not faked by level layout. It costs the boss real
 * options: a player who fights with their back to the bay will see it refuse
 * attacks and reposition instead, and it will keep circling to put ITSELF on
 * the far side so the player's muzzle points away from the glass.
 *
 * This is a FORESHADOWING DEVICE and it is meant to be noticed on a rewatch,
 * the way the "protected subject" line in the PA barks is. On a first play it
 * reads as the boss being oddly reluctant near one wall. On a second play it
 * reads as the only thing in the building that was looking after them.
 *
 * DO NOT "optimise" this away. If the boss ever fires through that volume the
 * ending stops being earned.
 *
 * ================================================================
 * OWNERSHIP
 * ================================================================
 *
 * This controller owns a scene group and nothing else. It does not touch the
 * player, the HUD, the lighting rig or the mission flags; it emits `boss:*`
 * events and lets the systems that own those things react. `boss:playerHit` is
 * a request for damage, not damage.
 */

// ---------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------

/**
 * Per-relay health.
 *
 * ASSUMPTION: `MISSION_V2.boss` specifies how MANY relays there are
 * (`phase1Relays`) but not how tough each one is, so the number lives here for
 * now. It belongs in mission.ts next to the other two pools the moment that
 * file's owner adds a field for it - this is the one boss constant that is not
 * yet centralised, and it is called out rather than hidden.
 *
 * 240 is about four seconds of sustained fire from the MK-7 (26 damage,
 * 720rpm), which is long enough that the player has to commit to a flank and
 * short enough that they are not standing still while a four-metre machine
 * walks at them.
 */
const RELAY_HEALTH = 240;

/** Phase 2 vent rhythm. See `updatePurge()`. */
const PURGE_INTERVAL = 9.5;
const PURGE_DURATION = 2.8;
/** Damage multiplier on the coolant stack during a purge. */
const PURGE_VULNERABILITY = 1.7;

/**
 * Accumulated weak-point damage that buys a stagger. Tuned so a scoped burst
 * into the open stack produces a visible reaction roughly every other burst -
 * frequent enough to feel like the shot MATTERS, rare enough that it is not a
 * stunlock.
 */
const STAGGER_THRESHOLD = 130;
const STAGGER_TIME = 1.15;

/** Distance the boss tries to hold while it has options. */
const PREFERRED_RANGE = 9.5;

interface AttackDef {
  kind: 'sweep' | 'slam' | 'foam' | 'torch' | 'charge';
  /** The dodge window. Never below 0.75s, even in phase 3. */
  windup: number;
  /** How long the damaging part lasts. */
  strike: number;
  /** Punish window. */
  recover: number;
  minRange: number;
  maxRange: number;
  /** Half-angle of the damage cone. Math.PI means omnidirectional. */
  halfAngle: number;
  damage: number;
  cooldown: number;
}

/**
 * The attack table.
 *
 * Three attacks in phase 1, three in phase 2, three in phase 3, with only two
 * carried over between any pair of phases - so each transition changes the
 * majority of what the player has to read, without throwing away the vocabulary
 * they just learned.
 */
const ATTACKS: Record<AttackDef['kind'], AttackDef> = {
  // Backhand sweep with the rescue clamp. It is the motion of clearing debris
  // off a casualty, and it passes through chest height - which is precisely why
  // crouching beats it.
  sweep: { kind: 'sweep', windup: 1.15, strike: 0.3, recover: 0.85, minRange: 0, maxRange: 8.5, halfAngle: 0.95, damage: 18, cooldown: 3.4 },
  // Both manipulators driven into the deck. Expanding ring on the floor.
  slam: { kind: 'slam', windup: 1.4, strike: 0.2, recover: 1.15, minRange: 0, maxRange: 12, halfAngle: Math.PI, damage: 22, cooldown: 6.2 },
  // Fire suppressant. Barely hurts; it BLINDS, and that is the threat - it is
  // how a rescue rig moves someone who will not move: it makes the area
  // untenable rather than making the person dead.
  foam: { kind: 'foam', windup: 2.2, strike: 1.6, recover: 1.0, minRange: 4, maxRange: 15, halfAngle: 0.5, damage: 7, cooldown: 8.5 },
  // Cutting torch. The single most dangerous thing on the machine and also the
  // shortest ranged - standing still next to it is the only way to be hit.
  torch: { kind: 'torch', windup: 0.95, strike: 0.45, recover: 1.0, minRange: 0, maxRange: 5.2, halfAngle: 0.6, damage: 28, cooldown: 5.0 },
  // Emergency-power rush. Straight line only; it cannot steer mid-charge.
  charge: { kind: 'charge', windup: 1.1, strike: 1.5, recover: 1.3, minRange: 7, maxRange: 24, halfAngle: 0.38, damage: 26, cooldown: 7.5 },
};

const PHASE_ATTACKS: Record<number, AttackDef['kind'][]> = {
  1: ['sweep', 'slam', 'foam'],
  2: ['slam', 'foam', 'torch'],
  3: ['sweep', 'slam', 'charge'],
};

/**
 * Wind-up scaling per phase. Phase 3 is FASTER but never faster than the
 * readability floor: 0.78 x 0.95s (torch) is still 0.74s, and the floor below
 * clamps anything that would drop under it.
 */
const PHASE_WINDUP_SCALE: Record<number, number> = { 1: 1, 2: 0.92, 3: 0.78 };
const WINDUP_FLOOR = 0.75;

const MOVE_SPEED: Record<number, number> = { 1: 1.65, 2: 1.85, 3: 3.0 };

// ---------------------------------------------------------------------
// A minimal self-contained particle emitter
// ---------------------------------------------------------------------

/**
 * The boss needs steam and sparks, but the project's ParticleSystem is owned by
 * VfxManager and this controller is not allowed to reach into it. Rather than
 * couple the two workstreams, the boss carries its own two-draw-call emitter:
 * one additive batch for sparks and torch spatter, one soft batch for steam.
 *
 * Point sprites, radial falloff computed in the fragment shader, no texture at
 * all - which keeps the "zero binary assets" rule intact without even a
 * procedural DataTexture. Fixed capacity, no allocation after construction, and
 * the oldest particle is recycled when it is full.
 *
 * KNOWN LIMITATION: this material does not participate in the project's fog
 * patch, so at long range the particles do not fade into the haze. Everything it
 * emits lives within a few metres of a machine the player is fighting at close
 * range, so it has never been visible; if the boss ever gets a long-range VFX,
 * route it through VfxManager instead of extending this.
 */
class BossEmitter {
  readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly position: Float32Array;
  private readonly colour: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly sizeRange: Float32Array;
  private readonly colourEnd: Float32Array;
  private cursor = 0;

  constructor(
    private readonly capacity: number,
    additive: boolean,
    private readonly drag: number,
    private readonly gravity: number,
  ) {
    this.position = new Float32Array(capacity * 3);
    this.colour = new Float32Array(capacity * 3);
    this.colourEnd = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.sizeRange = new Float32Array(capacity * 2);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colour, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    // A boss-sized bounding sphere so nothing is frustum-culled while alive.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (340.0 / max(0.05, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d) * 4.0;
          if (r > 1.0 || vAlpha <= 0.001) discard;
          gl_FragColor = vec4(vColor, vAlpha * pow(1.0 - r, 1.5));
        }`,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER.WORLD);
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, sizeStart: number, sizeEnd: number,
    r0: number, g0: number, b0: number,
    r1: number, g1: number, b1: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const i3 = i * 3;
    this.position[i3] = x; this.position[i3 + 1] = y; this.position[i3 + 2] = z;
    this.velocity[i3] = vx; this.velocity[i3 + 1] = vy; this.velocity[i3 + 2] = vz;
    this.colour[i3] = r0; this.colour[i3 + 1] = g0; this.colour[i3 + 2] = b0;
    this.colourEnd[i3] = r1; this.colourEnd[i3 + 1] = g1; this.colourEnd[i3 + 2] = b1;
    this.sizeRange[i * 2] = sizeStart;
    this.sizeRange[i * 2 + 1] = sizeEnd;
    this.age[i] = 0;
    this.life[i] = life;
    this.alpha[i] = 1;
    this.size[i] = sizeStart;
  }

  update(dt: number): void {
    const decay = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      const i3 = i * 3;
      this.velocity[i3] *= decay;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * decay + this.gravity * dt;
      this.velocity[i3 + 2] *= decay;
      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;
      this.size[i] = lerp(this.sizeRange[i * 2], this.sizeRange[i * 2 + 1], t);
      // Fade in fast, out slow - a spark that pops into existence at full
      // brightness reads as a rendering glitch.
      this.alpha[i] = Math.min(1, t * 12) * (1 - t) * (1 - t);
      this.colour[i3] = lerp(this.colour[i3], this.colourEnd[i3], dt * 6);
      this.colour[i3 + 1] = lerp(this.colour[i3 + 1], this.colourEnd[i3 + 1], dt * 6);
      this.colour[i3 + 2] = lerp(this.colour[i3 + 2], this.colourEnd[i3 + 2], dt * 6);
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------

export interface ProtectedVolume {
  /** World centre of the hostage isolation bay. */
  center: THREE.Vector3;
  /** Radius that encloses it, plus whatever margin the level wants. */
  radius: number;
}

export interface Warden03Options {
  /**
   * The volume the boss will never fire into or fight across. Supplied by the
   * level workstream, which is the only thing that knows where the isolation
   * bay actually is. If this is left null the constraint is INERT and the
   * story beat silently does not happen - see the class comment.
   */
  protectedVolume?: ProtectedVolume | null;
  /** Optional arena the boss stays inside. Keeps it out of the scenery. */
  arena?: { center: THREE.Vector3; radius: number } | null;
  seed?: number;
}

type WardenState = 'dormant' | 'wake' | 'fight' | 'stagger' | 'transition' | 'dying' | 'down';

interface ShedPiece {
  object: THREE.Object3D;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  settled: boolean;
}

export class Warden03Controller {
  /**
   * The boss's scene group. It is kept at the world origin with an identity
   * transform on purpose: the shockwave ring, the suppressant cone and the
   * particle emitters all work in world space, and shedding an armour plate
   * onto the floor is a straight `attach()` with no transform maths.
   */
  readonly group = new THREE.Group();
  /** Always CAST.boss. Never hardcode the name - an editor may rename it. */
  readonly name: string = CAST.boss;

  private rig: WardenRig;
  private readonly rng: Rng;

  private state: WardenState = 'dormant';
  private stateTimer = 0;
  private phaseIndex = 1;

  private readonly position = new THREE.Vector3();
  private readonly prevPosition = new THREE.Vector3();
  private facing = 0;
  private torsoYaw = 0;
  private headYaw = 0;
  private headPitch = 0;
  private walkPhase = 0;
  private groundSpeed = 0;
  private lastFootSign = 1;

  // --- damage state ---
  private readonly relayHealth: number[] = [];
  private relaysDown = 0;
  private coolantHealth: number = MISSION_V2.boss.phase2CoolantHealth;
  private coreHealth: number = MISSION_V2.boss.phase3CoreHealth;
  private coolantStage = -1;
  private coreDestroyed = false;
  private staggerMeter = 0;
  /** Per-weak-point white flash, decays to zero. */
  private relayFlash = [0, 0];
  private coolantFlash = 0;
  private coreFlash = 0;

  // --- attack state ---
  private attack: AttackDef | null = null;
  private attackTime = 0;
  private attackFired = false;
  private readonly cooldowns = new Map<AttackDef['kind'], number>();
  private attackGap = 2.0;
  private readonly chargeDirection = new THREE.Vector3();
  private suppressantActive = false;

  // --- phase 2 vent rhythm ---
  private purgeTimer = PURGE_INTERVAL * 0.45;
  private purgeActive = false;
  private heat = 0;

  // --- presentation ---
  private readonly emberEmitter: BossEmitter;
  private readonly steamEmitter: BossEmitter;
  private readonly shockRing: THREE.Mesh;
  private readonly shockMaterial: THREE.MeshBasicMaterial;
  private shockTime = -1;
  private shockRadius = 0;
  private readonly foamCone: THREE.Mesh;
  private readonly foamMaterial: THREE.MeshBasicMaterial;
  private beaconSpin = 0;
  private readonly shedPieces: ShedPiece[] = [];

  // --- cached world-space weak point centres, refreshed once per update ---
  private readonly relayWorld: THREE.Vector3[] = [];
  private readonly coolantWorld = new THREE.Vector3();
  private readonly coreWorld = new THREE.Vector3();

  private protectedVolume: ProtectedVolume | null;
  private readonly arena: { center: THREE.Vector3; radius: number } | null;

  // Scratch. Nothing in update() may allocate.
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly bus: EventBus,
    options: Warden03Options = {},
  ) {
    this.group.name = 'Warden03Controller';
    this.rng = new Rng(options.seed ?? 0xb055_03);
    this.protectedVolume = options.protectedVolume ?? null;
    this.arena = options.arena ?? null;

    this.rig = buildWarden03(this.mats);
    this.group.add(this.rig.root);

    for (let i = 0; i < MISSION_V2.boss.phase1Relays; i++) {
      this.relayHealth.push(RELAY_HEALTH);
      this.relayWorld.push(new THREE.Vector3());
    }
    // The rig models two relay pods. If an editor raises `phase1Relays` above
    // that, the extra relays have no geometry to hang on - clamp rather than
    // silently spawning invisible objectives.
    while (this.relayHealth.length > this.rig.relays.length) {
      this.relayHealth.pop();
      this.relayWorld.pop();
    }
    this.relayFlash = this.relayHealth.map(() => 0);

    // --- shockwave ring -------------------------------------------------
    // A thin additive ring scaled up over the slam's travel. It is the ONLY
    // reason the slam is dodgeable: an invisible radial damage test is
    // indistinguishable from being hit at random.
    const ringGeo = new THREE.RingGeometry(0.94, 1.0, 56);
    ringGeo.rotateX(-Math.PI / 2);
    this.shockMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc06a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.shockRing = new THREE.Mesh(ringGeo, this.shockMaterial);
    this.shockRing.visible = false;
    this.shockRing.frustumCulled = false;
    this.shockRing.layers.set(LAYER.WORLD);
    this.group.add(this.shockRing);

    // --- suppressant cone -----------------------------------------------
    // Apex at the origin opening down -Z, so the mesh can simply `lookAt` the
    // point it is being sprayed at.
    const coneGeo = new THREE.ConeGeometry(1, 1, 18, 1, true);
    coneGeo.translate(0, -0.5, 0);
    coneGeo.rotateX(Math.PI / 2);
    this.foamMaterial = new THREE.MeshBasicMaterial({
      color: 0xdfe8ee,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.foamCone = new THREE.Mesh(coneGeo, this.foamMaterial);
    this.foamCone.visible = false;
    this.foamCone.frustumCulled = false;
    this.foamCone.layers.set(LAYER.WORLD);
    this.group.add(this.foamCone);

    this.emberEmitter = new BossEmitter(200, true, 1.4, -11);
    this.steamEmitter = new BossEmitter(160, false, 1.9, 1.35);
    this.group.add(this.emberEmitter.points, this.steamEmitter.points);

    this.group.visible = false;
    this.applyPhaseVisuals(1, 0);
  }

  // ==================================================================
  // Public API
  // ==================================================================

  get phase(): number {
    return this.phaseIndex;
  }

  get defeated(): boolean {
    return this.coreDestroyed;
  }

  /** True while the machine is still a threat. Convenience for the director. */
  get active(): boolean {
    return this.state === 'fight' || this.state === 'stagger' || this.state === 'transition';
  }

  /** Current weak point's remaining health, 0..1. For the boss HUD bar. */
  get weakPointHealth01(): number {
    if (this.phaseIndex === 1) {
      const total = this.relayHealth.length * RELAY_HEALTH;
      let left = 0;
      for (const h of this.relayHealth) left += Math.max(0, h);
      return total > 0 ? left / total : 0;
    }
    if (this.phaseIndex === 2) {
      return clamp01(this.coolantHealth / MISSION_V2.boss.phase2CoolantHealth);
    }
    return clamp01(this.coreHealth / MISSION_V2.boss.phase3CoreHealth);
  }

  /** World centre of whichever weak point is live. Drives objective markers. */
  weakPointPosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.phaseIndex === 1) {
      for (let i = 0; i < this.relayHealth.length; i++) {
        if (this.relayHealth[i] > 0) return out.copy(this.relayWorld[i]);
      }
      return out.copy(this.coreWorld);
    }
    return out.copy(this.phaseIndex === 2 ? this.coolantWorld : this.coreWorld);
  }

  /**
   * Where the isolation bay is. The level workstream must call this (or pass it
   * to the constructor) or the story constraint does nothing.
   */
  setProtectedVolume(volume: ProtectedVolume | null): void {
    this.protectedVolume = volume;
  }

  spawn(position: THREE.Vector3): void {
    this.position.copy(position);
    this.prevPosition.copy(position);
    this.rig.root.position.copy(position);
    this.group.visible = true;
    this.state = 'wake';
    this.stateTimer = 0;
    this.phaseIndex = 1;
    this.bus.emit('boss:spawned', { name: this.name, position: position.clone() });
  }

  /**
   * Restores the complete pre-fight machine, including destructible geometry.
   * Checkpoint retry cannot merely set phase=1: phase 3 physically reparents
   * armour plates into the world and all three weak-point health pools mutate.
   */
  reset(): void {
    for (const piece of this.shedPieces) piece.object.removeFromParent();
    this.shedPieces.length = 0;
    this.rig.root.removeFromParent();
    this.rig.dispose();
    this.rig = buildWarden03(this.mats);
    this.group.add(this.rig.root);

    this.state = 'dormant';
    this.stateTimer = 0;
    this.phaseIndex = 1;
    this.position.set(0, 0, 0);
    this.prevPosition.set(0, 0, 0);
    this.facing = 0;
    this.torsoYaw = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.walkPhase = 0;
    this.groundSpeed = 0;
    this.lastFootSign = 1;

    this.relayHealth.length = 0;
    for (let i = 0; i < Math.min(MISSION_V2.boss.phase1Relays, this.rig.relays.length); i++) {
      this.relayHealth.push(RELAY_HEALTH);
    }
    this.relaysDown = 0;
    this.coolantHealth = MISSION_V2.boss.phase2CoolantHealth;
    this.coreHealth = MISSION_V2.boss.phase3CoreHealth;
    this.coolantStage = -1;
    this.coreDestroyed = false;
    this.staggerMeter = 0;
    this.relayFlash = this.relayHealth.map(() => 0);
    this.coolantFlash = 0;
    this.coreFlash = 0;

    this.attack = null;
    this.attackTime = 0;
    this.attackFired = false;
    this.cooldowns.clear();
    this.attackGap = 2;
    this.suppressantActive = false;
    this.purgeTimer = PURGE_INTERVAL * 0.45;
    this.purgeActive = false;
    this.heat = 0;
    this.shockTime = -1;
    this.shockRadius = 0;
    this.shockRing.visible = false;
    this.foamCone.visible = false;
    this.emberEmitter.clear();
    this.steamEmitter.clear();
    this.group.visible = false;
    this.applyPhaseVisuals(1, 0);
  }

  /** Debug-only phase restore used by direct mission-state jumps. */
  debugSetPhase(phase: 1 | 2 | 3): void {
    if (!this.group.visible) return;
    this.relayHealth.fill(phase === 1 ? RELAY_HEALTH : 0);
    this.relaysDown = phase === 1 ? 0 : this.relayHealth.length;
    for (let i = 0; i < this.rig.relays.length; i++) {
      this.rig.relays[i].lampMaterial.emissiveIntensity = phase === 1 ? 5 : 0;
    }
    this.coolantHealth = phase <= 2 ? MISSION_V2.boss.phase2CoolantHealth : 0;
    this.coreHealth = MISSION_V2.boss.phase3CoreHealth;
    this.coreDestroyed = false;
    if (phase === 3 && this.shedPieces.length === 0) this.shedArmour();
    this.phaseIndex = phase;
    this.state = 'fight';
    this.stateTimer = 0;
    this.attack = null;
    this.attackGap = 2;
    this.applyPhaseVisuals(phase, 0);
  }

  /**
   * Ray vs. the boss.
   *
   * Offered so the ballistics workstream can resolve a hit without knowing the
   * rig: sphere tests against the three weak points first, then two body
   * spheres. Weak points win ties at equal distance, which is what makes a
   * grazing shot at the edge of the coolant stack count as a coolant hit rather
   * than a hull hit - and grazing shots at a weak point should always be
   * generous, never pedantic.
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
  ): { point: THREE.Vector3; normal: THREE.Vector3; distance: number; weak: boolean } | null {
    if (!this.group.visible || this.state === 'down') return null;
    let bestT = maxDistance;
    let bestCenter: THREE.Vector3 | null = null;
    let bestWeak = false;

    const test = (center: THREE.Vector3, radius: number, weak: boolean): void => {
      const t = raySphere(origin, direction, center, radius, maxDistance);
      if (t < 0) return;
      // A weak point at the same range as armour always wins.
      if (t < bestT || (weak && !bestWeak && t < bestT + 0.4)) {
        bestT = t;
        bestCenter = center;
        bestWeak = weak;
      }
    };

    if (this.phaseIndex === 1) {
      for (let i = 0; i < this.relayHealth.length; i++) {
        if (this.relayHealth[i] > 0) test(this.relayWorld[i], WARDEN_METRICS.relayRadius, true);
      }
    } else if (this.phaseIndex === 2) {
      test(this.coolantWorld, WARDEN_METRICS.coolantRadius, true);
    } else {
      test(this.coreWorld, WARDEN_METRICS.coreRadius, true);
    }

    // Body: carriage and torso, as two spheres.
    test(this.tmpA.copy(this.position).setY(this.position.y + 1.95), 1.25, false);
    test(this.tmpB.copy(this.position).setY(this.position.y + 2.9), 1.15, false);

    if (bestCenter === null) return null;
    const point = new THREE.Vector3().copy(origin).addScaledVector(direction, bestT);
    const normal = new THREE.Vector3().subVectors(point, bestCenter).normalize();
    return { point, normal, distance: bestT, weak: bestWeak };
  }

  /**
   * Apply damage at a world point.
   *
   * The point IS the routing: there is no "hit zone" enum coming in, because
   * the shooter should not have to know the anatomy. Everything within a weak
   * point's sphere is a weak point hit; everything else is armour.
   *
   * PER-PHASE MODEL
   *   phase 1  relay sphere -> full damage to that relay
   *            anything else -> amount * sealedDamageScale (0.03), DISCARDED.
   *            Phase 1 is not a health bar. Chipping the hull must never be a
   *            slower way to win, or the relays stop being the objective.
   *   phase 2  coolant sphere -> full damage, x1.7 during a purge
   *            anything else -> sealed scale, discarded
   *   phase 3  core sphere -> full damage
   *            anything else -> discarded, but it sparks loudly, because the
   *            armour is gone and a player shooting a bare chassis deserves the
   *            feedback even though it is not progress.
   */
  damage(amount: number, worldPoint: THREE.Vector3): void {
    if (this.state === 'dormant' || this.state === 'dying' || this.state === 'down') return;
    if (amount <= 0) return;

    if (this.phaseIndex === 1) {
      for (let i = 0; i < this.relayHealth.length; i++) {
        if (this.relayHealth[i] <= 0) continue;
        if (worldPoint.distanceToSquared(this.relayWorld[i]) > sq(WARDEN_METRICS.relayRadius)) continue;
        this.relayHealth[i] -= amount;
        this.relayFlash[i] = 1;
        this.staggerMeter += amount;
        this.emitSparks(worldPoint, 6, 0.9, 1.0, 0.55);
        const dead = this.relayHealth[i] <= 0;
        this.bus.emit('boss:weakPointHit', {
          kind: 'relay',
          point: worldPoint.clone(),
          normal: new THREE.Vector3().subVectors(worldPoint, this.relayWorld[i]).normalize(),
          damage: amount,
          health01: clamp01(Math.max(0, this.relayHealth[i]) / RELAY_HEALTH),
          destroyed: dead,
        });
        if (dead) this.onRelayDestroyed(i);
        return;
      }
      this.absorb(amount, worldPoint);
      return;
    }

    if (this.phaseIndex === 2) {
      if (worldPoint.distanceToSquared(this.coolantWorld) <= sq(WARDEN_METRICS.coolantRadius)) {
        const applied = amount * (this.purgeActive ? PURGE_VULNERABILITY : 1);
        this.coolantHealth -= applied;
        this.coolantFlash = 1;
        this.staggerMeter += applied;
        this.emitSparks(worldPoint, 9, 1.0, 0.72, 0.3);
        this.emitSteam(worldPoint, 4, 1.1);
        const dead = this.coolantHealth <= 0;
        this.bus.emit('boss:weakPointHit', {
          kind: 'coolant',
          point: worldPoint.clone(),
          normal: new THREE.Vector3().subVectors(worldPoint, this.coolantWorld).normalize(),
          damage: applied,
          health01: clamp01(this.coolantHealth / MISSION_V2.boss.phase2CoolantHealth),
          destroyed: dead,
        });
        this.updateCoolantStage();
        if (dead) this.onCoolantDestroyed();
        return;
      }
      this.absorb(amount, worldPoint);
      return;
    }

    if (worldPoint.distanceToSquared(this.coreWorld) <= sq(WARDEN_METRICS.coreRadius)) {
      this.coreHealth -= amount;
      this.coreFlash = 1;
      this.staggerMeter += amount;
      this.emitSparks(worldPoint, 8, 0.55, 0.85, 1.0);
      const dead = this.coreHealth <= 0;
      this.bus.emit('boss:weakPointHit', {
        kind: 'core',
        point: worldPoint.clone(),
        normal: new THREE.Vector3().subVectors(worldPoint, this.coreWorld).normalize(),
        damage: amount,
        health01: clamp01(this.coreHealth / MISSION_V2.boss.phase3CoreHealth),
        destroyed: dead,
      });
      if (dead) this.onCoreDestroyed();
      return;
    }
    this.absorb(amount, worldPoint);
  }

  // ==================================================================
  // Frame
  // ==================================================================

  /**
   * @param engage False while the player has not been handed the fight yet -
   *               during the intro walk-in and the boss's own reveal beat. It
   *               keeps breathing and tracking, but it will not move on the
   *               player or attack. Being hit before you can act is not
   *               difficulty.
   */
  update(dt: number, elapsed: number, playerEye: THREE.Vector3, engage: boolean): void {
    if (this.state === 'dormant') return;
    const step = Math.min(dt, 0.05);

    this.stateTimer += dt;
    for (const [kind, t] of this.cooldowns) this.cooldowns.set(kind, t - dt);
    this.relayFlash = this.relayFlash.map((f) => Math.max(0, f - dt * 5));
    this.coolantFlash = Math.max(0, this.coolantFlash - dt * 5);
    this.coreFlash = Math.max(0, this.coreFlash - dt * 5);
    this.staggerMeter = Math.max(0, this.staggerMeter - dt * 40);

    switch (this.state) {
      case 'wake':
        // Power-up beat: floods come on, beacon spins up, doors take a breath.
        // Nothing hostile happens for 2.2 seconds - the player's first read of
        // this machine should be its SIZE, not an incoming attack.
        if (this.stateTimer >= 2.2) this.enterPhase(1);
        break;
      case 'fight':
        this.updateFight(step, playerEye, engage);
        break;
      case 'stagger':
        if (this.stateTimer >= STAGGER_TIME) {
          this.state = 'fight';
          this.stateTimer = 0;
          this.attackGap = 0.8;
        }
        break;
      case 'transition':
        this.updateTransition();
        break;
      case 'dying':
        this.updateDying(dt);
        break;
      case 'down':
        break;
    }

    this.updateLocomotionPose(step, elapsed, playerEye);
    this.updateAttackPose(step);
    this.updateEffects(dt, elapsed, playerEye);
    this.updateShedPieces(dt);

    // World matrices are refreshed here, not at render time, because damage()
    // can be called at any point between updates and it resolves hits against
    // these cached centres.
    this.group.updateMatrixWorld(true);
    for (let i = 0; i < this.relayWorld.length; i++) {
      this.rig.relays[i].anchor.getWorldPosition(this.relayWorld[i]);
    }
    this.rig.coolant.anchor.getWorldPosition(this.coolantWorld);
    this.rig.core.anchor.getWorldPosition(this.coreWorld);
  }

  // ==================================================================
  // Fight logic
  // ==================================================================

  private updateFight(dt: number, playerEye: THREE.Vector3, engage: boolean): void {
    const toPlayer = this.tmpA.copy(playerEye).sub(this.position);
    toPlayer.y = 0;
    const range = toPlayer.length();
    if (range > 0.001) toPlayer.multiplyScalar(1 / range);

    // The head always tracks the player, even when the body cannot - this is
    // the machine's most human gesture and it is deliberate. It is watching a
    // person it is about to hurt.
    const desiredFacing = Math.atan2(toPlayer.x, toPlayer.z);

    if (this.attack) {
      // updateAttackLogic may complete the attack and clear this.attack. Keep
      // the committed definition for the turn-rate calculation in this frame.
      const committedAttack = this.attack;
      this.updateAttackLogic(dt, playerEye, range, toPlayer);
      // A committed attack turns only slowly. That commitment IS the dodge
      // window: a boss that tracks through its own wind-up cannot be sidestepped.
      const turnRate = committedAttack.kind === 'charge' && this.attackTime < committedAttack.windup ? 2.2 : 0.7;
      this.facing = dampAngle(this.facing, desiredFacing, turnRate, dt);
      return;
    }

    this.facing = dampAngle(this.facing, desiredFacing, this.phaseIndex === 3 ? 2.6 : 1.9, dt);

    if (!engage) return;

    if (this.phaseIndex === 2) this.updatePurge(dt);
    if (this.purgeActive) return; // Venting. It cannot attack while it vents.

    this.updateMovement(dt, playerEye, range);

    this.attackGap -= dt;
    if (this.attackGap <= 0) this.selectAttack(playerEye, range);
  }

  /**
   * PHASE 2 RHYTHM.
   *
   * The stack is open for the whole phase, but every PURGE_INTERVAL it stops
   * dead, hunches, flings the shroud doors wide and dumps heat for
   * PURGE_DURATION seconds. During that window it cannot attack and the stack
   * takes PURGE_VULNERABILITY x damage.
   *
   * This exists so the forced-ADS moment has somewhere to land. Scoping in is a
   * commitment - reduced movement, reduced peripheral vision - and asking a
   * player to make that commitment against a moving target with no safe window
   * is how scoped boss phases become frustrating. The purge is the game saying
   * "now", loudly, on a fixed and learnable cadence.
   */
  private updatePurge(dt: number): void {
    this.purgeTimer -= dt;
    if (this.purgeActive) {
      if (this.purgeTimer <= 0) {
        this.purgeActive = false;
        this.purgeTimer = PURGE_INTERVAL;
      }
      return;
    }
    if (this.purgeTimer <= 0) {
      this.purgeActive = true;
      this.purgeTimer = PURGE_DURATION;
      // Announced like an attack because it IS a telegraphed action - audio
      // needs a cue with a duration, and the player needs to hear it coming.
      this.bus.emit('boss:attack', { kind: 'purge', windup: 0.35, position: this.position.clone() });
      this.bus.emit('camera:shake', { amplitude: 0.05, duration: 0.5, frequency: 22 });
      for (const vent of this.rig.coolant.vents) {
        vent.getWorldPosition(this.tmpC);
        this.emitSteam(this.tmpC, 26, 2.6);
      }
    }
  }

  // ------------------------------------------------------------------
  // Movement, and the positional half of the story constraint
  // ------------------------------------------------------------------

  private updateMovement(dt: number, playerEye: THREE.Vector3, range: number): void {
    const target = this.chooseStandPosition(playerEye);
    const speed = MOVE_SPEED[this.phaseIndex] ?? 1.7;
    this.tmpB.copy(target).sub(this.position);
    this.tmpB.y = 0;
    const distance = this.tmpB.length();
    // A deadband, or the machine jitters between two equally good positions.
    if (distance > 0.6) {
      this.tmpB.multiplyScalar(1 / distance);
      const advance = Math.min(speed * dt, distance - 0.5);
      this.position.addScaledVector(this.tmpB, advance);
    }
    if (this.arena) {
      this.tmpB.copy(this.position).sub(this.arena.center);
      this.tmpB.y = 0;
      const r = this.tmpB.length();
      const limit = this.arena.radius - WARDEN_METRICS.bodyRadius;
      if (r > limit && r > 0.001) {
        this.position.copy(this.arena.center).addScaledVector(this.tmpB.multiplyScalar(1 / r), limit);
      }
    }
    void range;
  }

  /**
   * Pick where to stand.
   *
   * Candidates ring the player at PREFERRED_RANGE. They are scored on:
   *
   *   1. HARD REJECT - would the player, shooting at the boss from where they
   *      are, be shooting INTO the isolation bay? If so the position is not
   *      available at any price. This is the "never use them as a shield"
   *      clause, and it is a rejection, not a penalty.
   *   2. Preference for the side of the player AWAY from the bay, so the fight
   *      naturally rotates until the player's muzzle points at a blank wall.
   *      The boss is herding them, and it has been doing that since the moment
   *      it walked in.
   *   3. A small preference for not walking a long way, so it does not orbit
   *      pointlessly.
   *
   * A player who never fights near the bay will never notice any of this. That
   * is fine. It is for the ones who do.
   */
  private chooseStandPosition(playerEye: THREE.Vector3): THREE.Vector3 {
    const out = this.tmpC;
    const bay = this.protectedVolume;

    // Direction from the bay to the player: standing along this from the
    // player puts the player's back to the bay and their muzzle away from it.
    let preferX = 0;
    let preferZ = 0;
    if (bay) {
      preferX = playerEye.x - bay.center.x;
      preferZ = playerEye.z - bay.center.z;
      const len = Math.hypot(preferX, preferZ);
      if (len > 0.001) {
        preferX /= len;
        preferZ /= len;
      }
    }

    let bestScore = -Infinity;
    out.copy(this.position);
    const SAMPLES = 12;
    for (let i = 0; i < SAMPLES; i++) {
      const angle = (i / SAMPLES) * Math.PI * 2;
      const dx = Math.sin(angle);
      const dz = Math.cos(angle);
      const px = playerEye.x + dx * PREFERRED_RANGE;
      const pz = playerEye.z + dz * PREFERRED_RANGE;
      this.tmpA.set(px, this.position.y, pz);

      if (!this.standClearOfProtected(this.tmpA, playerEye)) continue;
      if (this.arena) {
        const dr = Math.hypot(px - this.arena.center.x, pz - this.arena.center.z);
        if (dr > this.arena.radius - WARDEN_METRICS.bodyRadius) continue;
      }

      const alignment = bay ? dx * preferX + dz * preferZ : 0;
      const travel = Math.hypot(px - this.position.x, pz - this.position.z);
      const score = alignment * 2.2 - travel * 0.12;
      if (score > bestScore) {
        bestScore = score;
        out.set(px, this.position.y, pz);
      }
    }
    // Every candidate was rejected: hold station rather than push through the
    // bay. Standing still next to a person is not a failure state for a machine
    // whose actual objective is that nobody gets hurt.
    if (bestScore === -Infinity) {
      this.bus.emit('boss:constrained', { reason: 'protectedVolume', kind: 'reposition' });
      out.copy(this.position);
    }
    return out;
  }

  /**
   * Would a player standing at `playerEye` and shooting at a boss standing at
   * `bossPos` be firing into the protected volume? Tests the bay against a
   * narrow cone that starts at the player and runs THROUGH the boss - i.e.
   * everything the player's misses would hit.
   */
  private standClearOfProtected(bossPos: THREE.Vector3, playerEye: THREE.Vector3): boolean {
    const bay = this.protectedVolume;
    if (!bay) return true;
    this.tmpB.copy(bossPos).sub(playerEye);
    this.tmpB.y = 0;
    if (this.tmpB.lengthSq() < 0.0001) return true;
    this.tmpB.normalize();
    // 22 degrees of spread and 45m of overtravel is a generous envelope for
    // "where a magazine of missed rifle rounds ends up".
    return coneClearOfSphere(playerEye, this.tmpB, 0.38, 45, bay.center, bay.radius);
  }

  // ------------------------------------------------------------------
  // Attacks
  // ------------------------------------------------------------------

  private selectAttack(playerEye: THREE.Vector3, range: number): void {
    const pool = PHASE_ATTACKS[this.phaseIndex] ?? PHASE_ATTACKS[1];
    const candidates: AttackDef[] = [];
    let refusedByConstraint = false;

    for (const kind of pool) {
      const def = ATTACKS[kind];
      if ((this.cooldowns.get(kind) ?? 0) > 0) continue;
      if (range < def.minRange || range > def.maxRange) continue;
      if (!this.attackClearOfProtected(def, playerEye)) {
        refusedByConstraint = true;
        continue;
      }
      candidates.push(def);
    }

    if (candidates.length === 0) {
      // Nothing available. If the reason was the constraint, say so - this is
      // the beat the whole ending is built on and it should be traceable.
      if (refusedByConstraint) {
        this.bus.emit('boss:constrained', { reason: 'protectedVolume', kind: 'attack' });
      }
      this.attackGap = 0.5;
      return;
    }

    const def = candidates[this.rng.int(0, candidates.length - 1)];
    this.attack = def;
    this.attackTime = 0;
    this.attackFired = false;
    this.cooldowns.set(def.kind, def.cooldown + def.windup + def.strike + def.recover);

    if (def.kind === 'charge') {
      // Locked in at wind-up start. It commits to a LINE, not to the player.
      this.chargeDirection.copy(playerEye).sub(this.position);
      this.chargeDirection.y = 0;
      this.chargeDirection.normalize();
    }

    this.bus.emit('boss:attack', {
      kind: def.kind,
      windup: this.windupTime(def),
      position: this.position.clone(),
    });
  }

  /** Phase-scaled wind-up, floored so it is always readable. */
  private windupTime(def: AttackDef): number {
    return Math.max(WINDUP_FLOOR, def.windup * (PHASE_WINDUP_SCALE[this.phaseIndex] ?? 1));
  }

  /**
   * THE STORY CONSTRAINT, aiming half.
   *
   * An attack is only legal if its damage volume misses the isolation bay
   * entirely. Directional attacks are tested as a cone from the machine's
   * chest toward the player; the ground slam is radial, so it is tested as a
   * plain distance - a shockwave that reaches the bay's foundations is not
   * something a rescue rig would ever set off, however far the walls are.
   *
   * The margin below is added to the bay's radius so the boss keeps a visible
   * standoff rather than shaving past it. It should look CAREFUL, not lucky.
   */
  private attackClearOfProtected(def: AttackDef, playerEye: THREE.Vector3): boolean {
    const bay = this.protectedVolume;
    if (!bay) return true;
    const MARGIN = 2.0;
    const radius = bay.radius + MARGIN;

    if (def.halfAngle >= Math.PI * 0.5) {
      // Radial. Safe only if the whole ring stays clear of the bay.
      this.tmpB.copy(bay.center).sub(this.position);
      this.tmpB.y = 0;
      return this.tmpB.length() > def.maxRange + radius;
    }

    this.tmpB.copy(playerEye).sub(this.position);
    this.tmpB.y = 0;
    if (this.tmpB.lengthSq() < 0.0001) return true;
    this.tmpB.normalize();
    this.tmpA.copy(this.position);
    this.tmpA.y += WARDEN_METRICS.sweepY;
    return coneClearOfSphere(this.tmpA, this.tmpB, def.halfAngle, def.maxRange, bay.center, radius);
  }

  private updateAttackLogic(
    dt: number,
    playerEye: THREE.Vector3,
    range: number,
    toPlayer: THREE.Vector3,
  ): void {
    const def = this.attack;
    if (!def) return;
    this.attackTime += dt;
    const windup = this.windupTime(def);

    // The charge translates during its strike window; everything else is
    // planted, which is what makes the recovery a real punish opportunity.
    if (def.kind === 'charge' && this.attackTime >= windup && this.attackTime < windup + def.strike) {
      this.position.addScaledVector(this.chargeDirection, MOVE_SPEED[3] * 2.1 * dt);
    }

    if (!this.attackFired && this.attackTime >= windup) {
      this.attackFired = true;
      this.fire(def, playerEye, range, toPlayer);
    }

    // The suppressant sprays continuously across its strike window.
    if (def.kind === 'foam' && this.attackFired && this.attackTime < windup + def.strike) {
      this.updateSuppressant(dt, playerEye, def);
    } else if (this.suppressantActive) {
      this.suppressantActive = false;
      this.bus.emit('boss:suppressant', { active: false, blind: 0 });
    }

    if (this.attackTime >= windup + def.strike + def.recover) {
      this.attack = null;
      this.attackTime = 0;
      // Gap between attacks. Phase 3 crowds the player harder, but never to
      // the point where two wind-ups overlap.
      this.attackGap = this.phaseIndex === 3 ? this.rng.range(0.7, 1.4) : this.rng.range(1.4, 2.6);
    }
  }

  /** The moment of commitment: resolve the hit and fire the presentation. */
  private fire(def: AttackDef, playerEye: THREE.Vector3, range: number, toPlayer: THREE.Vector3): void {
    this.bus.emit('boss:attackFired', { kind: def.kind, position: this.position.clone() });

    switch (def.kind) {
      case 'sweep': {
        // Passes through chest height. A crouched player is UNDER it, which is
        // the dodge the raised-arm pose is advertising.
        const inArc = range <= def.maxRange && angleTo(toPlayer, this.facing) <= def.halfAngle;
        const ducked = playerEye.y < this.position.y + 1.28;
        if (inArc && !ducked) this.hitPlayer(def, playerEye, def.damage);
        this.bus.emit('camera:shake', { amplitude: inArc ? 0.16 : 0.07, duration: 0.35, frequency: 16 });
        break;
      }
      case 'slam': {
        this.shockTime = 0;
        this.shockRadius = 0;
        this.shockRing.visible = true;
        this.bus.emit('explosion', {
          position: this.tmpA.copy(this.position).setY(this.position.y + 0.15).clone(),
          radius: 3.0,
          power: 0.35,
          damagesPlayer: false,
        });
        this.bus.emit('camera:shake', { amplitude: 0.3, duration: 0.6, frequency: 13 });
        this.emitDust(this.position, 30);
        break;
      }
      case 'foam': {
        this.suppressantActive = true;
        this.foamCone.visible = true;
        break;
      }
      case 'torch': {
        const inArc = range <= def.maxRange && angleTo(toPlayer, this.facing) <= def.halfAngle;
        if (inArc) this.hitPlayer(def, playerEye, def.damage);
        this.rig.torchTip.getWorldPosition(this.tmpA);
        this.emitSparks(this.tmpA, 22, 0.75, 0.9, 1.0);
        this.bus.emit('camera:shake', { amplitude: inArc ? 0.2 : 0.06, duration: 0.3, frequency: 20 });
        break;
      }
      case 'charge': {
        this.bus.emit('camera:shake', { amplitude: 0.12, duration: 0.4, frequency: 11 });
        break;
      }
    }
  }

  /** The suppressant cone: continuous, blinding, barely damaging. */
  private updateSuppressant(dt: number, playerEye: THREE.Vector3, def: AttackDef): void {
    this.rig.nozzleTip.getWorldPosition(this.tmpA);
    this.tmpB.copy(playerEye).sub(this.tmpA);
    const distance = this.tmpB.length();
    this.tmpB.normalize();

    this.foamCone.position.copy(this.tmpA);
    this.tmpC.copy(this.tmpA).addScaledVector(this.tmpB, 1);
    this.foamCone.lookAt(this.tmpC);
    const reach = def.maxRange;
    this.foamCone.scale.set(Math.tan(def.halfAngle) * reach, Math.tan(def.halfAngle) * reach, reach);
    this.foamMaterial.opacity = 0.34;

    // Spray particles from the nozzle along the aim.
    for (let i = 0; i < 4; i++) {
      const spread = 0.22;
      this.emberEmitterOff();
      this.steamEmitter.emit(
        this.tmpA.x, this.tmpA.y, this.tmpA.z,
        this.tmpB.x * 13 + this.rng.spread(spread * 13),
        this.tmpB.y * 13 + this.rng.spread(spread * 13) + 1.2,
        this.tmpB.z * 13 + this.rng.spread(spread * 13),
        1.1, 0.5, 2.6,
        0.9, 0.94, 0.97,
        0.6, 0.64, 0.68,
      );
    }

    const inCone = distance <= reach && angleBetween(this.tmpB, playerEye, this.tmpA) <= def.halfAngle;
    if (inCone) {
      // Damage per second, not per hit: it is pressure and cold, not a blow.
      this.hitPlayer(def, playerEye, def.damage * dt);
      // Blindness ramps with proximity. It is recoverable and it never fully
      // blacks the screen - a player who cannot see anything cannot dodge, and
      // an undodgeable attack is not an attack, it is a punishment.
      const blind = clamp01(1 - distance / reach) * 0.8;
      this.bus.emit('boss:suppressant', { active: true, blind });
    } else if (this.suppressantActive) {
      this.bus.emit('boss:suppressant', { active: true, blind: 0 });
    }
  }

  /** No-op hook kept so the spray loop reads symmetrically. */
  private emberEmitterOff(): void {
    /* suppressant produces no embers - it is putting fires OUT */
  }

  private hitPlayer(def: AttackDef, playerEye: THREE.Vector3, amount: number): void {
    this.tmpB.copy(playerEye).sub(this.position).normalize();
    this.bus.emit('boss:playerHit', {
      kind: def.kind,
      amount,
      fromDirection: this.tmpB.clone().negate(),
    });
  }

  // ------------------------------------------------------------------
  // Phase transitions
  // ------------------------------------------------------------------

  private onRelayDestroyed(index: number): void {
    this.relaysDown++;
    this.rig.relays[index].lampMaterial.emissiveIntensity = 0;
    this.rig.relays[index].anchor.getWorldPosition(this.tmpA);
    this.emitSparks(this.tmpA, 30, 1.0, 0.85, 0.4);
    this.emitSteam(this.tmpA, 10, 1.4);
    this.bus.emit('boss:relayDown', {
      index,
      remaining: Math.max(0, this.relayHealth.length - this.relaysDown),
      position: this.tmpA.clone(),
    });
    this.bus.emit('camera:shake', { amplitude: 0.14, duration: 0.45, frequency: 18 });
    // Each relay lost visibly costs it something even before the phase turns.
    this.staggerMeter = STAGGER_THRESHOLD;
    if (this.relaysDown >= this.relayHealth.length) this.beginTransition(2);
    else this.enterStagger();
  }

  private onCoolantDestroyed(): void {
    this.rig.coolant.anchor.getWorldPosition(this.tmpA);
    this.emitSparks(this.tmpA, 40, 1.0, 0.7, 0.35);
    this.emitSteam(this.tmpA, 40, 2.4);
    this.bus.emit('boss:coolantDown');
    this.bus.emit('explosion', { position: this.tmpA.clone(), radius: 2.2, power: 0.4, damagesPlayer: false });
    this.beginTransition(3);
  }

  private onCoreDestroyed(): void {
    this.coreDestroyed = true;
    this.state = 'dying';
    this.stateTimer = 0;
    this.attack = null;
    this.purgeActive = false;
    this.rig.core.anchor.getWorldPosition(this.tmpA);
    this.bus.emit('boss:coreDown');
    this.bus.emit('boss:defeated', { name: this.name });
    this.bus.emit('explosion', { position: this.tmpA.clone(), radius: 3.4, power: 0.55, damagesPlayer: false });
    this.bus.emit('camera:shake', { amplitude: 0.34, duration: 1.1, frequency: 12 });
    if (this.suppressantActive) {
      this.suppressantActive = false;
      this.bus.emit('boss:suppressant', { active: false, blind: 0 });
    }
  }

  private enterStagger(): void {
    this.state = 'stagger';
    this.stateTimer = 0;
    this.attack = null;
    this.attackFired = false;
    this.staggerMeter = 0;
    if (this.suppressantActive) {
      this.suppressantActive = false;
      this.bus.emit('boss:suppressant', { active: false, blind: 0 });
    }
    this.bus.emit('boss:stagger');
  }

  /**
   * The transition itself is a HELD BEAT, not a state flip. The machine stops,
   * takes the damage visibly, and the player gets two clear seconds to look at
   * what has changed before anything comes at them again. Phase transitions
   * that resume combat instantly are how players end up not knowing what phase
   * they are in.
   */
  private beginTransition(toPhase: number): void {
    this.state = 'transition';
    this.stateTimer = 0;
    this.attack = null;
    this.attackFired = false;
    this.purgeActive = false;
    this.phaseIndex = toPhase;
    if (this.suppressantActive) {
      this.suppressantActive = false;
      this.bus.emit('boss:suppressant', { active: false, blind: 0 });
    }
    this.foamCone.visible = false;

    if (toPhase === 2) {
      this.bus.emit('boss:coolantExposed');
      this.bus.emit('camera:shake', { amplitude: 0.22, duration: 0.8, frequency: 14 });
      this.rig.coolant.anchor.getWorldPosition(this.tmpA);
      this.emitSteam(this.tmpA, 46, 2.8);
    } else {
      this.shedArmour();
      this.bus.emit('boss:coreExposed');
      this.bus.emit('camera:shake', { amplitude: 0.26, duration: 0.9, frequency: 12 });
    }
    this.bus.emit('boss:phase', { phase: toPhase, name: this.name });
  }

  private updateTransition(): void {
    // 2.4s of held reaction, then back to the fight with a short grace gap.
    if (this.stateTimer < 2.4) return;
    this.state = 'fight';
    this.stateTimer = 0;
    this.attackGap = 1.1;
    this.purgeTimer = PURGE_INTERVAL * 0.35;
  }

  private enterPhase(phase: number): void {
    this.phaseIndex = phase;
    this.state = 'fight';
    this.stateTimer = 0;
    this.attackGap = 1.6;
    this.bus.emit('boss:phase', { phase, name: this.name });
  }

  /**
   * PHASE 3 ENTRY: it cuts its own armour off.
   *
   * The plates are not hidden - they are detached into world space and left
   * lying on the floor for the rest of the fight. The player should be able to
   * walk over the thing that used to be invulnerable. That is worth two meshes
   * of budget on its own.
   */
  private shedArmour(): void {
    for (const plate of [this.rig.armourLeft, this.rig.armourRight]) {
      if (plate.parent === this.group) continue;
      // attach() preserves the world transform, and the controller group is
      // identity, so the plate simply keeps standing where it was.
      this.group.attach(plate);
      const side = plate === this.rig.armourLeft ? -1 : 1;
      this.shedPieces.push({
        object: plate,
        velocity: new THREE.Vector3(side * this.rng.range(1.6, 2.6), this.rng.range(1.4, 2.4), this.rng.range(-0.6, 0.9)),
        spin: new THREE.Vector3(this.rng.range(-3, 3), this.rng.range(-2, 2), side * this.rng.range(2, 5)),
        settled: false,
      });
    }
    this.rig.core.anchor.getWorldPosition(this.tmpA);
    this.bus.emit('boss:armourShed', { position: this.tmpA.clone() });
    for (const vent of this.rig.damageVents) {
      vent.getWorldPosition(this.tmpB);
      this.emitSparks(this.tmpB, 16, 1.0, 0.8, 0.45);
    }
  }

  private updateCoolantStage(): void {
    const health01 = clamp01(this.coolantHealth / MISSION_V2.boss.phase2CoolantHealth);
    const stage = health01 > 0.66 ? 0 : health01 > 0.33 ? 1 : 2;
    if (stage === this.coolantStage) return;
    this.coolantStage = stage;
    this.bus.emit('boss:coolantStage', { stage, health01 });
    if (stage === 0) return;
    // Each stage blows something loose: more steam, brighter fins, a door
    // buckling further open. The stack should look progressively RUINED, so a
    // player can tell how the phase is going without a HUD.
    this.rig.coolant.anchor.getWorldPosition(this.tmpA);
    this.emitSteam(this.tmpA, 18 + stage * 10, 2.0 + stage * 0.5);
    this.emitSparks(this.tmpA, 12 + stage * 8, 1.0, 0.72, 0.3);
    this.bus.emit('camera:shake', { amplitude: 0.1 + stage * 0.05, duration: 0.4, frequency: 19 });
  }

  private absorb(amount: number, worldPoint: THREE.Vector3): void {
    const scale = this.phaseIndex === 3 ? 0 : MISSION_V2.boss.sealedDamageScale;
    // Sparks and a ricochet whine, but no progress. The feedback has to be
    // POSITIVE and USELESS at the same time - the player must be able to tell
    // that they hit, and equally able to tell that it did nothing.
    this.emitSparks(worldPoint, 4, 1.0, 0.9, 0.72);
    this.bus.emit('boss:armourHit', {
      point: worldPoint.clone(),
      normal: new THREE.Vector3().subVectors(worldPoint, this.coreWorld).normalize(),
      absorbed: 1 - scale,
    });
    void amount;
  }

  // ==================================================================
  // Animation
  // ==================================================================

  /**
   * Locomotion and the yaw chain.
   *
   * Same layering as the soldier - carriage lags the aim, torso twists toward
   * it, head leads - but with the rates dropped hard, because the thing that
   * sells four tonnes is RELUCTANCE. Every rotation on this machine should look
   * like it costs something.
   */
  private updateLocomotionPose(dt: number, elapsed: number, playerEye: THREE.Vector3): void {
    const rig = this.rig;
    rig.root.position.copy(this.position);

    const moved = Math.hypot(
      this.position.x - this.prevPosition.x,
      this.position.z - this.prevPosition.z,
    );
    this.prevPosition.copy(this.position);
    const instant = dt > 0.0001 ? moved / dt : 0;
    this.groundSpeed = damp(this.groundSpeed, instant, 7, dt);

    // Stride advances with DISTANCE, so the feet cannot slide.
    const STRIDE = 2.3;
    this.walkPhase += (moved / STRIDE) * Math.PI;
    this.walkPhase += dt * 0.35; // idle weight shift

    const gait = clamp01(this.groundSpeed / (MOVE_SPEED[this.phaseIndex] ?? 1.7));
    const swing = Math.sin(this.walkPhase);
    const bob = Math.cos(this.walkPhase * 2);

    rig.root.rotation.y = this.facing;

    // Torso and head yaw chain, in the machine's own frame.
    const desired = Math.atan2(playerEye.x - this.position.x, playerEye.z - this.position.z);
    const relative = shortAngle(desired - this.facing);
    this.torsoYaw = damp(this.torsoYaw, clamp(relative, -0.75, 0.75), 3.4, dt);
    this.headYaw = damp(this.headYaw, clamp(relative, -1.1, 1.1) - this.torsoYaw, 6.5, dt);
    // It looks DOWN at the player. It is two and a half times their height and
    // the pitch is what says so.
    const eyeHeight = this.position.y + 3.4;
    const flat = Math.hypot(playerEye.x - this.position.x, playerEye.z - this.position.z);
    this.headPitch = damp(this.headPitch, Math.atan2(eyeHeight - playerEye.y, Math.max(1, flat)), 5, dt);

    rig.torso.rotation.y = this.torsoYaw;
    rig.head.rotation.y = this.headYaw;
    rig.head.rotation.x = clamp(this.headPitch, -0.1, 0.62);

    // --- legs -----------------------------------------------------------
    // Digitigrade: the knee breaks BACKWARD (negative), and the ankle
    // counter-rotates so the foot pad stays flat on the deck. A heavy walker
    // that lands on its toes reads as a bird; one that plants flat reads as
    // plant machinery.
    const stride = 0.08 + gait * 0.42;
    for (let i = 0; i < 2; i++) {
      const leg = rig.legs[i];
      const side = i === 0 ? 1 : -1;
      const s = swing * side;
      leg.root.rotation.x = s * stride;
      const lift = Math.max(0, -s) * (0.1 + gait * 0.75);
      leg.knee.rotation.x = -lift;
      leg.ankle.rotation.x = -(leg.root.rotation.x + leg.knee.rotation.x) * 0.85;
    }

    // Carriage: heavy vertical bob and a roll onto the planted foot.
    rig.carriage.position.y = WARDEN_METRICS.hipY - 0.07 * gait * (1 - bob) * 0.5;
    rig.carriage.rotation.z = -swing * 0.045 * gait;
    rig.carriage.rotation.x = gait * 0.03;

    // Footfall. Each plant is a small shake scaled by how close the player is -
    // the ground telling them how big this thing is, without a cutscene.
    const footSign = Math.sign(swing);
    if (footSign !== 0 && footSign !== this.lastFootSign && gait > 0.15) {
      this.lastFootSign = footSign;
      const distance = this.position.distanceTo(playerEye);
      const amplitude = clamp(0.09 * gait * (14 / Math.max(4, distance)), 0.01, 0.12);
      this.bus.emit('camera:shake', { amplitude, duration: 0.22, frequency: 9 });
      this.tmpA.copy(this.position);
      this.tmpA.x += footSign * 0.86 * Math.cos(this.facing);
      this.tmpA.z -= footSign * 0.86 * Math.sin(this.facing);
      this.emitDust(this.tmpA, 4);
    }

    // Idle: a slow compressor breath so a stationary boss is never frozen.
    const breath = Math.sin(elapsed * 0.9);
    rig.torso.rotation.x = breath * 0.012 + gait * 0.04;
  }

  /**
   * Attack poses.
   *
   * Every pose here exists to answer one question the player is asking: "what
   * is about to happen and where do I need to be?" The wind-up poses are
   * exaggerated well past mechanical plausibility for exactly that reason - a
   * realistic hydraulic pre-load would be a 5cm movement nobody can see.
   */
  private updateAttackPose(dt: number): void {
    const rig = this.rig;
    const def = this.attack;

    // Rest targets.
    let grappleX = -0.22;
    let grappleElbow = 0.42;
    let grappleZ = 0.14;
    let toolX = -0.18;
    let toolElbow = 0.38;
    let toolZ = -0.16;
    let jaw = 0.16;
    let torchGlow = 0.1;

    if (this.state === 'stagger') {
      // Hit reaction: arms drop, the whole machine sags forward. It has been
      // HURT and the player needs to see the shot land on the body, not just
      // on a number.
      const t = clamp01(this.stateTimer / STAGGER_TIME);
      const sag = Math.sin(t * Math.PI);
      grappleX = -0.05 - sag * 0.35;
      toolX = -0.05 - sag * 0.3;
      grappleElbow = 0.2;
      toolElbow = 0.2;
      rig.torso.rotation.x += sag * 0.2;
      rig.head.rotation.x += sag * 0.28;
    } else if (this.state === 'transition') {
      const t = clamp01(this.stateTimer / 2.4);
      const heave = Math.sin(clamp01(t / 0.5) * Math.PI);
      rig.torso.rotation.x += heave * 0.24;
      grappleX = -0.1 - heave * 0.4;
      toolX = -0.1 - heave * 0.4;
      grappleElbow = 0.9;
      toolElbow = 0.9;
    } else if (this.state === 'dying') {
      const t = clamp01(this.stateTimer / 3.2);
      const eased = smoothstep(t);
      grappleX = lerp(-0.22, 0.35, eased);
      toolX = lerp(-0.18, 0.3, eased);
      grappleElbow = lerp(0.42, 0.05, eased);
      toolElbow = lerp(0.38, 0.05, eased);
    } else if (def) {
      const windup = this.windupTime(def);
      const t = this.attackTime;
      const w = clamp01(t / windup);
      const after = Math.max(0, t - windup);
      const strikeT = clamp01(after / Math.max(0.05, def.strike));
      const recoverT = clamp01((after - def.strike) / Math.max(0.05, def.recover));

      switch (def.kind) {
        case 'sweep': {
          // Draws the clamp arm back and ACROSS the body, then whips it through
          // at chest height. The wind-up silhouette is unmistakable from any
          // angle - the arm leaves the body outline entirely.
          const draw = smoothstep(w);
          const through = t < windup ? 0 : 1 - Math.pow(1 - strikeT, 3);
          grappleZ = lerp(0.14, -1.5, draw) + through * 2.6;
          grappleX = lerp(-0.22, -1.05, draw) + through * 0.55;
          grappleElbow = lerp(0.42, 0.15, draw);
          jaw = 0.55 - through * 0.5;
          if (t >= windup) grappleZ -= recoverT * 0.9;
          break;
        }
        case 'slam': {
          // Both arms overhead, held at the top, then driven straight down.
          const raise = smoothstep(w);
          const drive = t < windup ? 0 : 1 - Math.pow(1 - strikeT, 4);
          grappleX = lerp(-0.22, -2.55, raise) + drive * 3.1;
          toolX = lerp(-0.18, -2.5, raise) + drive * 3.05;
          grappleElbow = lerp(0.42, 0.9, raise) * (1 - drive * 0.8);
          toolElbow = lerp(0.38, 0.9, raise) * (1 - drive * 0.8);
          if (t >= windup) {
            // Recoil back up off the deck, and the whole machine settles.
            rig.carriage.position.y -= 0.18 * (1 - recoverT) * (1 - strikeT * 0.4);
          }
          break;
        }
        case 'foam': {
          // The nozzle comes UP and levels at the player, and holds there for a
          // long, unmistakable beat. Two-plus seconds of wind-up is enormous -
          // it has to be, because the payoff is taking the player's sight away.
          const level = smoothstep(w);
          toolX = lerp(-0.18, -1.15, level);
          toolElbow = lerp(0.38, 0.5, level);
          toolZ = lerp(-0.16, -0.35, level);
          break;
        }
        case 'torch': {
          // Cocks back short and fast, then a tight downward arc. The arc is
          // small, which is the point: it is only dangerous within five metres.
          const cock = smoothstep(w);
          const cut = t < windup ? 0 : 1 - Math.pow(1 - strikeT, 3);
          toolX = lerp(-0.18, -1.35, cock) + cut * 1.75;
          toolElbow = lerp(0.38, 0.95, cock) - cut * 0.7;
          torchGlow = 0.1 + cock * 5 + cut * 9;
          break;
        }
        case 'charge': {
          // Squats and lowers its shoulder. It is going to run, and the only
          // answer is to not be in the line.
          const squat = smoothstep(w);
          rig.carriage.position.y -= squat * 0.3 * (1 - strikeT);
          rig.torso.rotation.x += squat * 0.25 + strikeT * 0.2;
          grappleX = -0.9 - strikeT * 0.3;
          toolX = -0.9 - strikeT * 0.3;
          grappleElbow = 1.3;
          toolElbow = 1.3;
          jaw = 0.6;
          break;
        }
      }
    }

    const rate = 12;
    rig.grappleArm.root.rotation.x = damp(rig.grappleArm.root.rotation.x, grappleX, rate, dt);
    rig.grappleArm.root.rotation.z = damp(rig.grappleArm.root.rotation.z, grappleZ, rate, dt);
    rig.grappleArm.elbow.rotation.x = damp(rig.grappleArm.elbow.rotation.x, grappleElbow, rate, dt);
    rig.toolArm.root.rotation.x = damp(rig.toolArm.root.rotation.x, toolX, rate, dt);
    rig.toolArm.root.rotation.z = damp(rig.toolArm.root.rotation.z, toolZ, rate, dt);
    rig.toolArm.elbow.rotation.x = damp(rig.toolArm.elbow.rotation.x, toolElbow, rate, dt);
    rig.clampJaws[0].rotation.z = damp(rig.clampJaws[0].rotation.z, jaw, 9, dt);
    rig.clampJaws[1].rotation.z = damp(rig.clampJaws[1].rotation.z, -jaw, 9, dt);
    rig.torchMaterial.emissiveIntensity = damp(rig.torchMaterial.emissiveIntensity, torchGlow, 8, dt);
  }

  // ==================================================================
  // Presentation: heat, steam, sparks, lamps, lighting mood
  // ==================================================================

  private updateEffects(dt: number, elapsed: number, playerEye: THREE.Vector3): void {
    const rig = this.rig;

    // --- relay lamps: the phase 1 progress readout ---------------------
    for (let i = 0; i < this.relayHealth.length; i++) {
      const relay = rig.relays[i];
      if (this.relayHealth[i] <= 0) {
        relay.lampMaterial.emissiveIntensity = 0;
        continue;
      }
      const health01 = clamp01(this.relayHealth[i] / RELAY_HEALTH);
      // Dims as it dies and starts to flicker under 40%: a damaged relay looks
      // damaged before it looks destroyed.
      const flicker = health01 < 0.4 ? (Math.sin(elapsed * 31 + i * 2) > 0.1 ? 1 : 0.35) : 1;
      relay.lampMaterial.emissiveIntensity = (1.4 + health01 * 6) * flicker + this.relayFlash[i] * 12;
      // Under heavy damage it spits.
      if (health01 < 0.5 && this.rng.chance(dt * 3)) {
        relay.anchor.getWorldPosition(this.tmpA);
        this.emitSparks(this.tmpA, 2, 1.0, 0.85, 0.45);
      }
    }

    // --- heat: the phase 2 mood ----------------------------------------
    // Phase 1 runs cold. Phase 2 the fin bank climbs from ember to white, and
    // the purge windows spike it. This IS the health bar for the phase, and
    // it is legible from across the room.
    const targetHeat = this.phaseIndex >= 2 ? (this.purgeActive ? 1 : 0.55) : 0;
    this.heat = damp(this.heat, targetHeat, this.purgeActive ? 6 : 1.6, dt);
    const damage01 = this.phaseIndex >= 2 ? 1 - clamp01(this.coolantHealth / MISSION_V2.boss.phase2CoolantHealth) : 0;
    const glow = this.heat * (0.6 + damage01 * 1.4);
    rig.coolant.finMaterial.emissiveIntensity = 0.12 + glow * 9 + this.coolantFlash * 10;
    // Orange -> white as it fails. Colour temperature is the read; brightness
    // alone would just look like a stronger lamp.
    this.tmpColor.setHex(0xff5a1e).lerp(WHITE_HOT, clamp01(damage01 * 0.85 + (this.purgeActive ? 0.25 : 0)));
    rig.coolant.finMaterial.emissive.copy(this.tmpColor);

    // Doors: closed in phase 1, flung open in phase 2, buckled wider as the
    // stack fails.
    const doorOpen = this.phaseIndex >= 2 ? 1.15 + damage01 * 0.45 + (this.purgeActive ? 0.3 : 0) : 0;
    rig.coolant.doorLeft.rotation.y = damp(rig.coolant.doorLeft.rotation.y, doorOpen, 4, dt);
    rig.coolant.doorRight.rotation.y = damp(rig.coolant.doorRight.rotation.y, -doorOpen, 4, dt);

    // Steam from the relief valves, scaled by heat and by damage.
    if (this.phaseIndex >= 2) {
      const rate = (0.6 + damage01 * 2.2 + (this.purgeActive ? 7 : 0)) * dt * 12;
      if (this.rng.chance(clamp01(rate))) {
        const vent = rig.coolant.vents[this.rng.int(0, rig.coolant.vents.length - 1)];
        vent.getWorldPosition(this.tmpA);
        this.emitSteam(this.tmpA, 2, this.purgeActive ? 2.6 : 1.5);
      }
    }

    // --- phase 3: it is coming apart -----------------------------------
    if (this.phaseIndex === 3 && this.state !== 'down') {
      if (this.rng.chance(dt * 9)) {
        const vent = rig.damageVents[this.rng.int(0, rig.damageVents.length - 1)];
        vent.getWorldPosition(this.tmpA);
        this.emitSparks(this.tmpA, 3, 1.0, 0.7, 0.35);
      }
      if (this.rng.chance(dt * 4)) {
        const vent = rig.coolant.vents[this.rng.int(0, rig.coolant.vents.length - 1)];
        vent.getWorldPosition(this.tmpA);
        this.emitSteam(this.tmpA, 3, 2.0);
      }
    }

    // --- core lens ------------------------------------------------------
    // Cold cyan while sealed - it is a diagnostic light, not a threat. On
    // emergency power it goes red, because the FACTORY is in emergency. The
    // machine did not become evil; the building's power state changed.
    const p3 = this.phaseIndex === 3;
    rig.core.material.emissive.lerp(p3 ? EMERGENCY_RED : CORE_CYAN, clamp01(dt * 2.5));
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * (p3 ? 6.5 : 1.4));
    rig.core.material.emissiveIntensity = (p3 ? 4 + pulse * 5 : 1.6 + pulse * 1.2) + this.coreFlash * 14;

    // Sensor bar and floods: amber while it is working, red on emergency power.
    rig.sensorMaterial.emissive.lerp(p3 ? EMERGENCY_RED : SENSOR_AMBER, clamp01(dt * 2.5));
    rig.sensorMaterial.emissiveIntensity = this.state === 'wake'
      ? clamp01(this.stateTimer / 1.4) * 5
      : 4 + (p3 ? Math.sin(elapsed * 9) * 1.6 : 0);
    rig.floodMaterial.emissiveIntensity = this.state === 'wake'
      ? clamp01((this.stateTimer - 0.6) / 1.2) * 4
      : this.state === 'down' ? 0 : p3 ? 1.4 : 4;

    // --- beacon: never stops warning people to stand clear ---------------
    this.beaconSpin += dt * (p3 ? 9 : 4.5);
    const sweep = 0.5 + 0.5 * Math.sin(this.beaconSpin);
    rig.coolant.beaconMaterial.emissiveIntensity = this.state === 'down' ? 0 : 1.5 + sweep * 7;

    // --- shockwave ring --------------------------------------------------
    if (this.shockTime >= 0) {
      this.shockTime += dt;
      // 9 m/s: fast enough to feel like a shock, slow enough that a player who
      // sees the slam land can still jump it.
      this.shockRadius = this.shockTime * 9;
      const life = clamp01(this.shockRadius / ATTACKS.slam.maxRange);
      this.shockRing.position.copy(this.position);
      this.shockRing.position.y += 0.06;
      this.shockRing.scale.setScalar(Math.max(0.01, this.shockRadius));
      this.shockMaterial.opacity = (1 - life) * 0.85;

      // The ring hits when it crosses the player - and it can be JUMPED. The
      // threshold is 2.1m of eye height above the boss's feet, which a standing
      // player (1.68m) clears only by actually leaving the ground.
      const distance = Math.hypot(playerEye.x - this.position.x, playerEye.z - this.position.z);
      const airborne = playerEye.y > this.position.y + 2.1;
      if (
        !airborne &&
        this.shockRadius >= distance &&
        this.shockRadius - dt * 9 < distance &&
        distance <= ATTACKS.slam.maxRange
      ) {
        this.hitPlayer(ATTACKS.slam, playerEye, ATTACKS.slam.damage);
      }
      if (life >= 1) {
        this.shockTime = -1;
        this.shockRing.visible = false;
      }
    }

    // --- suppressant cone fade ------------------------------------------
    if (!this.suppressantActive && this.foamCone.visible) {
      this.foamMaterial.opacity = damp(this.foamMaterial.opacity, 0, 9, dt);
      if (this.foamMaterial.opacity < 0.01) this.foamCone.visible = false;
    }

    this.emberEmitter.update(dt);
    this.steamEmitter.update(dt);

    // Stagger check. Only weak-point damage feeds the meter, so a player
    // dumping rounds into armour can never stunlock it.
    if (this.state === 'fight' && this.staggerMeter >= STAGGER_THRESHOLD) this.enterStagger();
  }

  /** Shed armour plates fall, tumble, and stay on the floor. */
  private updateShedPieces(dt: number): void {
    for (const piece of this.shedPieces) {
      if (piece.settled) continue;
      piece.velocity.y -= 18 * dt;
      piece.object.position.addScaledVector(piece.velocity, dt);
      piece.object.rotation.x += piece.spin.x * dt;
      piece.object.rotation.y += piece.spin.y * dt;
      piece.object.rotation.z += piece.spin.z * dt;
      if (piece.object.position.y <= 0.12) {
        piece.object.position.y = 0.12;
        piece.velocity.multiplyScalar(0.3);
        piece.velocity.y = Math.abs(piece.velocity.y) * 0.28;
        piece.spin.multiplyScalar(0.35);
        if (piece.velocity.lengthSq() < 0.4) {
          piece.settled = true;
          // Lie flat, like a dropped plate.
          piece.object.rotation.set(Math.PI * 0.5, piece.object.rotation.y, 0);
          this.emitDust(piece.object.position, 8);
        }
      }
    }
  }

  /**
   * The death.
   *
   * It does not explode. It runs down: the legs give, the torso drops, the
   * lights go out one system at a time, and then it is a piece of machinery
   * sitting on a factory floor. Blowing it up would make it a monster; letting
   * it stop makes it what it is, and the four lines the core speaks afterwards
   * land on a body, not on wreckage.
   */
  private updateDying(dt: number): void {
    const t = this.stateTimer;
    const rig = this.rig;
    const collapse = smoothstep(clamp01(t / 2.6));

    rig.carriage.position.y = lerp(WARDEN_METRICS.hipY, 0.95, collapse);
    for (const leg of rig.legs) {
      leg.root.rotation.x = damp(leg.root.rotation.x, 0.5, 2.2, dt);
      leg.knee.rotation.x = damp(leg.knee.rotation.x, -1.15, 2.2, dt);
      leg.ankle.rotation.x = damp(leg.ankle.rotation.x, 0.5, 2.2, dt);
    }
    rig.carriage.rotation.x = collapse * 0.22;
    rig.torso.rotation.x = collapse * 0.34;
    rig.head.rotation.x = collapse * 0.5;

    // The lights die in order: floods, then sensor, then the core last. The
    // core is the part that is still thinking, and it is the part that speaks
    // after this - so it is the last thing to go dark.
    const fade = clamp01((t - 1.2) / 1.6);
    rig.floodMaterial.emissiveIntensity = (1 - fade) * 4;
    rig.sensorMaterial.emissiveIntensity = (1 - clamp01((t - 1.8) / 1.4)) * 4;
    rig.coolant.finMaterial.emissiveIntensity = (1 - fade) * 3;

    if (this.rng.chance(dt * 14)) {
      const vent = rig.damageVents[this.rng.int(0, rig.damageVents.length - 1)];
      vent.getWorldPosition(this.tmpA);
      this.emitSparks(this.tmpA, 4, 1.0, 0.6, 0.3);
    }
    if (this.rng.chance(dt * 8)) {
      const vent = rig.coolant.vents[this.rng.int(0, rig.coolant.vents.length - 1)];
      vent.getWorldPosition(this.tmpA);
      this.emitSteam(this.tmpA, 4, 2.2);
    }

    if (t >= 4.2) {
      this.state = 'down';
      this.stateTimer = 0;
      this.emberEmitter.clear();
      this.bus.emit('camera:shake', { amplitude: 0.18, duration: 0.7, frequency: 8 });
    }
  }

  // ------------------------------------------------------------------
  // Emitter helpers
  // ------------------------------------------------------------------

  private emitSparks(at: THREE.Vector3, count: number, r: number, g: number, b: number): void {
    for (let i = 0; i < count; i++) {
      this.emberEmitter.emit(
        at.x + this.rng.spread(0.12), at.y + this.rng.spread(0.12), at.z + this.rng.spread(0.12),
        this.rng.spread(3.6), this.rng.range(0.5, 4.2), this.rng.spread(3.6),
        this.rng.range(0.4, 1.1), this.rng.range(0.045, 0.1), 0.01,
        r, g, b,
        r * 0.35, g * 0.12, 0,
      );
    }
  }

  private emitSteam(at: THREE.Vector3, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      this.steamEmitter.emit(
        at.x + this.rng.spread(0.18), at.y + this.rng.spread(0.18), at.z + this.rng.spread(0.18),
        this.rng.spread(speed * 0.55), this.rng.range(speed * 0.4, speed), this.rng.spread(speed * 0.55),
        this.rng.range(1.0, 2.0), this.rng.range(0.25, 0.5), this.rng.range(1.8, 3.2),
        0.86, 0.88, 0.9,
        0.42, 0.44, 0.46,
      );
    }
  }

  private emitDust(at: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(1.4, 5.0);
      this.steamEmitter.emit(
        at.x + this.rng.spread(0.5), at.y + 0.08, at.z + this.rng.spread(0.5),
        Math.sin(angle) * speed, this.rng.range(0.2, 1.4), Math.cos(angle) * speed,
        this.rng.range(0.7, 1.5), this.rng.range(0.3, 0.6), this.rng.range(1.4, 2.6),
        0.5, 0.47, 0.43,
        0.26, 0.25, 0.23,
      );
    }
  }

  /** Sets the emissive state that matches a phase without playing its beat. */
  private applyPhaseVisuals(phase: number, dtSeed: number): void {
    this.rig.coolant.doorLeft.rotation.y = phase >= 2 ? 1.15 : 0;
    this.rig.coolant.doorRight.rotation.y = phase >= 2 ? -1.15 : 0;
    void dtSeed;
  }

  dispose(): void {
    this.rig.dispose();
    this.emberEmitter.dispose();
    this.steamEmitter.dispose();
    this.shockRing.geometry.dispose();
    this.shockMaterial.dispose();
    this.foamCone.geometry.dispose();
    this.foamMaterial.dispose();
    this.shedPieces.length = 0;
    this.cooldowns.clear();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Local maths
// ---------------------------------------------------------------------

const WHITE_HOT = new THREE.Color(0xfff2d8);
const EMERGENCY_RED = new THREE.Color(0xff2418);
const CORE_CYAN = new THREE.Color(0x59d8ff);
const SENSOR_AMBER = new THREE.Color(0xffb347);

const sq = (v: number): number => v * v;

/** Signed shortest angular difference, in (-PI, PI]. */
function shortAngle(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + shortAngle(target - current) * (1 - Math.exp(-rate * dt));
}

/** Angle between a horizontal unit vector and a yaw. */
function angleTo(dir: THREE.Vector3, yaw: number): number {
  return Math.abs(shortAngle(Math.atan2(dir.x, dir.z) - yaw));
}

/** Angle between an aim direction and the direction from `from` to `to`. */
function angleBetween(aim: THREE.Vector3, to: THREE.Vector3, from: THREE.Vector3): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.0001) return 0;
  const dot = (aim.x * dx + aim.y * dy + aim.z * dz) / len;
  return Math.acos(clamp(dot, -1, 1));
}

/**
 * True when a sphere lies entirely OUTSIDE a finite cone.
 *
 * This is the geometric core of the story constraint, so it is written to fail
 * SAFE: any ambiguity resolves to "not clear", and the boss stands down.
 */
function coneClearOfSphere(
  apex: THREE.Vector3,
  axis: THREE.Vector3,
  halfAngle: number,
  range: number,
  center: THREE.Vector3,
  radius: number,
): boolean {
  const vx = center.x - apex.x;
  const vy = center.y - apex.y;
  const vz = center.z - apex.z;
  const along = vx * axis.x + vy * axis.y + vz * axis.z;
  // Entirely behind the apex, or entirely beyond the reach.
  if (along < -radius) return true;
  if (along - radius > range) return true;
  const perpSq = Math.max(0, vx * vx + vy * vy + vz * vz - along * along);
  const perp = Math.sqrt(perpSq);
  // Distance from the sphere centre to the cone surface, measured
  // perpendicular to that surface.
  const surfaceDistance = perp * Math.cos(halfAngle) - along * Math.sin(halfAngle);
  return surfaceDistance > radius;
}

/** Ray/sphere intersection. Returns the near hit distance or -1. */
function raySphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  maxDistance: number,
): number {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return -1;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const t = -b - Math.sqrt(discriminant);
  if (t < 0 || t > maxDistance) return -1;
  return t;
}
