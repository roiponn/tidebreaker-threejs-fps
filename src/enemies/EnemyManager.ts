import * as THREE from 'three';
import { ENEMY_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import { clamp01, damp, lerp } from '@/core/MathUtils';
import { Rng } from '@/core/Rng';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import type { EnemySpawn } from '@/environment/HarborLevel';
import { buildSoldier, type SoldierRig } from './EnemySoldier';

/**
 * Enemies.
 *
 * DELIBERATELY MINIMAL, as the brief requires: no navmesh, no squad logic, no
 * cover selection. Each hostile owns a two-point firing lane authored in the
 * level, strafes along it, and shoots in bursts when it can see the player.
 * The purpose of these characters is to make the combat *presentation*
 * legible - hit reactions, tracers coming back, death animations - not to be a
 * tactical opponent.
 *
 * They activate by the player's progress along +X so the fight paces itself
 * across the 60-90 second route instead of everything waking at once.
 */
type EnemyState = 'idle' | 'alert' | 'firing' | 'dying' | 'dead';

interface Enemy {
  rig: SoldierRig;
  position: THREE.Vector3;
  home: THREE.Vector3;
  patrolTo: THREE.Vector3;
  activationX: number;
  elevated: boolean;
  state: EnemyState;
  health: number;
  /** 0..1 along the strafe lane. */
  laneT: number;
  laneDirection: number;
  laneTimer: number;
  facing: number;
  reactionTimer: number;
  fireTimer: number;
  burstRemaining: number;
  flinch: number;
  flinchDirection: THREE.Vector3;
  deathTimer: number;
  deathRotation: number;
  deathFall: number;
  walkPhase: number;
  strobePhase: number;
  visible: boolean;
}

export interface EnemyHit {
  enemy: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  headshot: boolean;
}

export class EnemyManager {
  readonly group = new THREE.Group();
  private enemies: Enemy[] = [];
  private rng = new Rng(0xe0e0e1);
  private rigs: SoldierRig[] = [];
  /** Debug switch: disables all AI and hides every soldier. */
  enabled = true;

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly sphereCenter = new THREE.Vector3();

  killCount = 0;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly collision: CollisionWorld,
    private readonly bus: EventBus,
  ) {
    this.group.name = 'Enemies';
  }

  spawnAll(spawns: EnemySpawn[]): void {
    for (const spawn of spawns) {
      const rig = buildSoldier(this.mats);
      this.rigs.push(rig);
      rig.root.position.copy(spawn.position);
      this.group.add(rig.root);
      this.enemies.push({
        rig,
        position: spawn.position.clone(),
        home: spawn.position.clone(),
        patrolTo: spawn.patrolTo.clone(),
        activationX: spawn.activationX,
        elevated: spawn.elevated,
        state: 'idle',
        health: ENEMY_CONFIG.health,
        laneT: this.rng.next(),
        laneDirection: this.rng.chance(0.5) ? 1 : -1,
        laneTimer: this.rng.range(0, ENEMY_CONFIG.strafeInterval),
        facing: 0,
        reactionTimer: 0,
        fireTimer: this.rng.range(0, ENEMY_CONFIG.burstPause),
        burstRemaining: 0,
        flinch: 0,
        flinchDirection: new THREE.Vector3(),
        deathTimer: 0,
        deathRotation: 0,
        deathFall: 0,
        walkPhase: this.rng.range(0, 6.28),
        strobePhase: this.rng.range(0, 6.28),
        visible: true,
      });
    }
  }

  get aliveCount(): number {
    let count = 0;
    for (const e of this.enemies) if (e.state !== 'dead' && e.state !== 'dying') count++;
    return count;
  }

  get total(): number {
    return this.enemies.length;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const e of this.enemies) e.rig.root.visible = enabled && e.state !== 'dead';
  }

  // ------------------------------------------------------------------
  // Hitscan
  // ------------------------------------------------------------------

  /**
   * Ray vs. enemy capsules. Two spheres per soldier (head + torso) is enough
   * fidelity for this slice and is far cheaper than mesh raycasting a rig that
   * changes pose every frame.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): EnemyHit | null {
    let best: EnemyHit | null = null;
    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (enemy.state === 'dead' || enemy.state === 'dying' || !this.enabled) continue;

      // Head first: a hit there beats a torso hit at the same distance.
      const headHit = raySphere(
        origin,
        direction,
        this.sphereCenter.copy(enemy.position).add(enemy.rig.headOffset),
        0.15,
        maxDistance,
      );
      const torsoHit = raySphere(
        origin,
        direction,
        this.sphereCenter.copy(enemy.position).add(enemy.rig.torsoOffset),
        0.34,
        maxDistance,
      );
      const headshot = headHit >= 0 && (torsoHit < 0 || headHit <= torsoHit + 0.05);
      const distance = headshot ? headHit : torsoHit;
      if (distance < 0) continue;
      if (best && distance >= best.distance) continue;

      const point = new THREE.Vector3().copy(origin).addScaledVector(direction, distance);
      const center = this.tmpVec
        .copy(enemy.position)
        .add(headshot ? enemy.rig.headOffset : enemy.rig.torsoOffset);
      const normal = new THREE.Vector3().subVectors(point, center).normalize();
      best = { enemy: i, point, normal, distance, headshot };
    }
    return best;
  }

  /** Applies damage. Returns true if this shot killed the target. */
  damage(index: number, amount: number, fromDirection: THREE.Vector3, headshot: boolean): boolean {
    const enemy = this.enemies[index];
    if (!enemy || enemy.state === 'dead' || enemy.state === 'dying') return false;
    enemy.health -= amount;
    // Flinch: a short lean away from the incoming round.
    enemy.flinch = ENEMY_CONFIG.flinchTime;
    enemy.flinchDirection.copy(fromDirection).setY(0).normalize();
    // Being shot immediately wakes an idle enemy.
    if (enemy.state === 'idle') {
      enemy.state = 'alert';
      enemy.reactionTimer = ENEMY_CONFIG.reactionTime * 0.4;
    }
    if (enemy.health <= 0) {
      enemy.state = 'dying';
      enemy.deathTimer = 0;
      // Fall away from the shooter, with a bit of randomness in the twist.
      enemy.deathRotation = this.rng.range(-0.7, 0.7);
      this.killCount++;
      this.bus.emit('enemy:killed', {
        position: enemy.position.clone(),
        remaining: this.aliveCount,
      });
      return true;
    }
    void headshot;
    return false;
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  update(dt: number, elapsed: number, playerEye: THREE.Vector3, playerAlive: boolean): void {
    if (!this.enabled) return;
    for (const enemy of this.enemies) {
      switch (enemy.state) {
        case 'dead':
          continue;
        case 'dying':
          this.updateDying(enemy, dt);
          continue;
        default:
          this.updateAlive(enemy, dt, elapsed, playerEye, playerAlive);
      }
    }
  }

  private updateAlive(
    enemy: Enemy,
    dt: number,
    elapsed: number,
    playerEye: THREE.Vector3,
    playerAlive: boolean,
  ): void {
    // --- activation by player progress ---
    if (enemy.state === 'idle' && playerEye.x >= enemy.activationX) {
      enemy.state = 'alert';
      enemy.reactionTimer = ENEMY_CONFIG.reactionTime;
    }

    // --- strafe along the authored lane ---
    if (enemy.state !== 'idle') {
      enemy.laneTimer -= dt;
      if (enemy.laneTimer <= 0) {
        enemy.laneTimer = ENEMY_CONFIG.strafeInterval * this.rng.range(0.7, 1.4);
        enemy.laneDirection *= -1;
      }
      const laneLength = enemy.home.distanceTo(enemy.patrolTo);
      if (laneLength > 0.1) {
        enemy.laneT = clamp01(enemy.laneT + (enemy.laneDirection * ENEMY_CONFIG.strafeSpeed * dt) / laneLength);
        if (enemy.laneT <= 0 || enemy.laneT >= 1) enemy.laneDirection *= -1;
      }
    }
    enemy.position.lerpVectors(enemy.home, enemy.patrolTo, enemy.laneT);
    // Elevated enemies stand on the catwalk; everyone else is on the deck.
    enemy.rig.root.position.copy(enemy.position);

    // --- face the player ---
    this.tmpVec.subVectors(playerEye, enemy.position);
    const distance = this.tmpVec.length();
    const targetFacing = Math.atan2(this.tmpVec.x, this.tmpVec.z);
    enemy.facing = dampAngle(enemy.facing, targetFacing, 6, dt);
    enemy.rig.root.rotation.y = enemy.facing;

    // --- can it see the player? ---
    const eye = this.tmpVec2.copy(enemy.position).add(enemy.rig.headOffset);
    const inRange = distance < ENEMY_CONFIG.sightRange;
    const hasLos = inRange && this.collision.hasLineOfSight(eye, playerEye);

    if (enemy.state === 'alert' || enemy.state === 'firing') {
      enemy.reactionTimer -= dt;
      if (hasLos && playerAlive && enemy.reactionTimer <= 0) {
        enemy.state = 'firing';
        this.updateFiring(enemy, dt, playerEye, distance);
      } else {
        enemy.state = 'alert';
        enemy.burstRemaining = 0;
      }
    }

    // --- animation ---
    this.animate(enemy, dt, elapsed);
  }

  private updateFiring(enemy: Enemy, dt: number, playerEye: THREE.Vector3, distance: number): void {
    enemy.fireTimer -= dt;
    if (enemy.fireTimer > 0) return;

    if (enemy.burstRemaining <= 0) {
      enemy.burstRemaining = ENEMY_CONFIG.burstCount;
      enemy.fireTimer = ENEMY_CONFIG.burstPause * this.rng.range(0.75, 1.35);
      return;
    }

    enemy.burstRemaining--;
    enemy.fireTimer = ENEMY_CONFIG.fireInterval;

    const muzzle = new THREE.Vector3();
    enemy.rig.weaponMuzzle.getWorldPosition(muzzle);
    const direction = new THREE.Vector3().subVectors(playerEye, muzzle).normalize();
    // Miss on purpose most of the time: the accuracy value is the chance the
    // round is aimed at the player at all, and the rest spray past.
    const accurate = this.rng.chance(ENEMY_CONFIG.accuracy);
    const spread = accurate ? 0.012 : 0.055 + distance * 0.0012;
    direction.x += this.rng.spread(spread);
    direction.y += this.rng.spread(spread);
    direction.z += this.rng.spread(spread);
    direction.normalize();

    this.bus.emit('enemy:fired', { origin: muzzle, direction });
  }

  private updateDying(enemy: Enemy, dt: number): void {
    enemy.deathTimer += dt;
    const t = enemy.deathTimer;
    // Fall: a fast topple with a settle, plus a slump of the whole rig.
    const fall = Math.min(1, t / 0.85);
    const eased = 1 - Math.pow(1 - fall, 3);
    enemy.deathFall = eased;
    enemy.rig.root.rotation.x = eased * -1.42;
    enemy.rig.root.rotation.z = eased * enemy.deathRotation;
    enemy.rig.root.position.y = enemy.position.y + eased * 0.12;
    // Limbs go slack.
    enemy.rig.leftArm.rotation.x = lerp(-1.05, -0.25, eased);
    enemy.rig.rightArm.rotation.x = lerp(-1.05, -0.35, eased);
    enemy.rig.torso.rotation.x = eased * 0.28;
    (enemy.rig.strobe.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;

    if (t > ENEMY_CONFIG.deathFadeDelay) {
      enemy.state = 'dead';
      enemy.rig.root.visible = false;
    }
  }

  private animate(enemy: Enemy, dt: number, elapsed: number): void {
    const moving = enemy.state !== 'idle';
    const speed = moving ? ENEMY_CONFIG.strafeSpeed : 0;
    enemy.walkPhase += dt * (2.2 + speed * 1.4);

    const stride = moving ? 0.55 : 0.06;
    const swing = Math.sin(enemy.walkPhase);
    const leftKnee = enemy.rig.leftLeg.userData.knee as THREE.Group;
    const rightKnee = enemy.rig.rightLeg.userData.knee as THREE.Group;
    enemy.rig.leftLeg.rotation.x = swing * stride * 0.5;
    enemy.rig.rightLeg.rotation.x = -swing * stride * 0.5;
    // Knees only bend forward.
    leftKnee.rotation.x = Math.max(0, -swing) * stride * 0.7;
    rightKnee.rotation.x = Math.max(0, swing) * stride * 0.7;
    // Hip bob and counter-rotation of the torso.
    enemy.rig.hips.position.y = 0.92 + Math.abs(Math.cos(enemy.walkPhase)) * 0.035 * (moving ? 1 : 0.2);
    enemy.rig.hips.rotation.y = swing * 0.09 * (moving ? 1 : 0.3);
    enemy.rig.torso.rotation.y = -swing * 0.07 * (moving ? 1 : 0.3);

    // Weapon comes up when firing.
    const aim = enemy.state === 'firing' ? 1 : 0;
    enemy.rig.rightArm.rotation.x = damp(enemy.rig.rightArm.rotation.x, lerp(-0.75, -1.35, aim), 8, dt);
    enemy.rig.leftArm.rotation.x = damp(enemy.rig.leftArm.rotation.x, lerp(-0.7, -1.25, aim), 8, dt);
    enemy.rig.head.rotation.x = damp(enemy.rig.head.rotation.x, aim * -0.12, 6, dt);

    // Flinch: lean away from the hit, snapping in and easing out.
    if (enemy.flinch > 0) {
      enemy.flinch = Math.max(0, enemy.flinch - dt);
      const f = enemy.flinch / ENEMY_CONFIG.flinchTime;
      const local = enemy.flinchDirection;
      enemy.rig.torso.rotation.x += f * ENEMY_CONFIG.flinchAmount * (1 + local.z * 0.2);
      enemy.rig.torso.rotation.z += f * ENEMY_CONFIG.flinchAmount * local.x;
      enemy.rig.head.rotation.z = f * ENEMY_CONFIG.flinchAmount * 0.8;
    } else {
      enemy.rig.head.rotation.z = damp(enemy.rig.head.rotation.z, 0, 8, dt);
    }

    // IR strobe blink - the readability aid, not a decoration.
    const blink = Math.sin(elapsed * 4.2 + enemy.strobePhase);
    (enemy.rig.strobe.material as THREE.MeshStandardMaterial).emissiveIntensity =
      blink > 0.72 ? 9 : 1.1;
  }

  reset(): void {
    for (const enemy of this.enemies) {
      enemy.state = 'idle';
      enemy.health = ENEMY_CONFIG.health;
      enemy.deathTimer = 0;
      enemy.flinch = 0;
      enemy.rig.root.visible = true;
      enemy.rig.root.rotation.set(0, 0, 0);
      enemy.rig.torso.rotation.set(0, 0, 0);
      enemy.position.copy(enemy.home);
      enemy.rig.root.position.copy(enemy.home);
    }
    this.killCount = 0;
  }

  dispose(): void {
    for (const rig of this.rigs) rig.dispose();
    this.rigs.length = 0;
    this.enemies.length = 0;
    this.group.removeFromParent();
  }
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
  // Origin outside the sphere and pointing away.
  if (c > 0 && b > 0) return -1;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const t = -b - Math.sqrt(discriminant);
  if (t < 0 || t > maxDistance) return -1;
  return t;
}

/** Angle damping that takes the short way around. */
function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-rate * dt));
}
