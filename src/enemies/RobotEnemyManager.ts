import * as THREE from 'three';
import type { EventBus } from '@/core/EventBus';
import { clamp, clamp01, damp } from '@/core/MathUtils';
import { Rng } from '@/core/Rng';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import type { EnemyHit } from './EnemyManager';
import { buildScout, SCOUT_HOVER_HEIGHT, type ScoutRig } from './robots/ScoutDrone';
import { buildSentinel, type SentinelRig } from './robots/SentinelUnit';

export type RobotKind = 'SCOUT' | 'SENTINEL';
export type RobotZone = 'exterior' | 'interior';

export interface RobotSpawn {
  kind: RobotKind;
  zone: RobotZone;
  position: THREE.Vector3;
  patrolTo: THREE.Vector3;
  activationX: number;
}

type RobotState = 'idle' | 'alert' | 'tracking' | 'firing' | 'dying' | 'dead';
type Rig = ScoutRig | SentinelRig;

interface RobotUnit {
  kind: RobotKind;
  zone: RobotZone;
  rig: Rig;
  home: THREE.Vector3;
  patrolTo: THREE.Vector3;
  position: THREE.Vector3;
  activationX: number;
  state: RobotState;
  health: number;
  maxHealth: number;
  facing: number;
  laneT: number;
  laneDirection: number;
  reactionTimer: number;
  fireTimer: number;
  burstRemaining: number;
  deathTimer: number;
  recoil: number;
  alarmTimer: number;
}

/**
 * Lightweight controller for the two industrial-security silhouettes.
 *
 * The rigs already existed but were display-only. This manager deliberately
 * mirrors the small public combat surface of EnemyManager (raycast, damage,
 * update, reset and counters), allowing Ballistics and the HUD to stay ignorant
 * of whether a target is a soldier or a machine.
 */
export class RobotEnemyManager {
  readonly group = new THREE.Group();
  enabled = true;
  killCount = 0;

  private readonly units: RobotUnit[] = [];
  private readonly rigs: Rig[] = [];
  private readonly rng = new Rng(0x51c0_7e1);
  private readonly weakPoint = new THREE.Vector3();
  private readonly torso = new THREE.Vector3();
  private readonly toPlayer = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();
  private readonly shotDirection = new THREE.Vector3();
  private poseTest = false;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly collision: CollisionWorld,
    private readonly bus: EventBus,
  ) {
    this.group.name = 'FactoryRobots';
  }

  spawnAll(spawns: readonly RobotSpawn[]): void {
    for (const spawn of spawns) {
      const rig = spawn.kind === 'SCOUT' ? buildScout(this.mats) : buildSentinel(this.mats);
      const maxHealth = spawn.kind === 'SCOUT' ? 48 : 150;
      rig.root.position.copy(spawn.position);
      this.group.add(rig.root);
      this.rigs.push(rig);
      this.units.push({
        kind: spawn.kind,
        zone: spawn.zone,
        rig,
        home: spawn.position.clone(),
        patrolTo: spawn.patrolTo.clone(),
        position: spawn.position.clone(),
        activationX: spawn.activationX,
        state: 'idle',
        health: maxHealth,
        maxHealth,
        facing: 0,
        laneT: this.rng.next(),
        laneDirection: this.rng.chance(0.5) ? 1 : -1,
        reactionTimer: 0,
        fireTimer: this.rng.range(0.5, 1.6),
        burstRemaining: 0,
        deathTimer: 0,
        recoil: 0,
        alarmTimer: 0,
      });
    }
  }

  get totalCount(): number {
    return this.units.length;
  }

  get aliveCount(): number {
    let count = 0;
    for (const unit of this.units) if (unit.state !== 'dead' && unit.state !== 'dying') count++;
    return count;
  }

  aliveInZone(zone: RobotZone): number {
    let count = 0;
    for (const unit of this.units) {
      if (unit.zone === zone && unit.state !== 'dead' && unit.state !== 'dying') count++;
    }
    return count;
  }

  get stateTrace(): string {
    return this.units
      .filter((unit) => unit.state !== 'dead')
      .map((unit) => `${unit.kind[0]}:${unit.state[0]}:${Math.max(0, Math.round(unit.health))}`)
      .join(' ');
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
  }

  /** Deterministic visual line-up retained for automated/still-frame review. */
  setPoseTest(enabled: boolean, origin: THREE.Vector3, yaw: number): void {
    this.poseTest = enabled;
    if (!enabled) return;
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const side = new THREE.Vector3(forward.z, 0, -forward.x);
    const distances = [2, 4, 8, 15, 30];
    for (let i = 0; i < this.units.length; i++) {
      const unit = this.units[i];
      if (i >= distances.length) {
        unit.rig.root.visible = false;
        continue;
      }
      unit.home.copy(origin).addScaledVector(forward, distances[i]).addScaledVector(side, (i - 2) * 0.9);
      unit.patrolTo.copy(unit.home);
      unit.position.copy(unit.home);
      unit.state = 'tracking';
      unit.rig.root.visible = true;
    }
  }

  update(
    dt: number,
    elapsed: number,
    playerEye: THREE.Vector3,
    playerAlive: boolean,
    engage: boolean,
  ): void {
    if (!this.enabled) return;
    const step = Math.min(dt, 0.05);
    for (const unit of this.units) {
      if (unit.state === 'dead') continue;
      if (unit.state === 'dying') {
        this.updateDeath(unit, dt);
        continue;
      }

      if (this.poseTest) {
        unit.facing = Math.atan2(playerEye.x - unit.position.x, playerEye.z - unit.position.z);
        this.animate(unit, elapsed, step, playerEye);
        continue;
      }

      this.toPlayer.subVectors(playerEye, unit.position);
      const distance = this.toPlayer.length();
      const progressWake = unit.zone === 'interior'
        ? playerEye.z > 13.2
        : playerEye.x >= unit.activationX;
      const canWake = engage && playerAlive && (progressWake || distance < 16);
      if (unit.state === 'idle' && canWake) {
        unit.state = 'alert';
        unit.reactionTimer = unit.kind === 'SCOUT' ? 0.7 : 0.95;
        unit.alarmTimer = 1.8;
      }

      if (unit.state !== 'idle') {
        unit.reactionTimer -= dt;
        unit.fireTimer -= dt;
        unit.alarmTimer = Math.max(0, unit.alarmTimer - dt);
        const targetYaw = Math.atan2(this.toPlayer.x, this.toPlayer.z);
        unit.facing = turnToward(unit.facing, targetYaw, (unit.kind === 'SCOUT' ? 3.4 : 1.8) * step);

        const seesPlayer = distance < (unit.kind === 'SCOUT' ? 31 : 38) &&
          this.collision.hasLineOfSight(this.muzzlePoint(unit), playerEye);
        if (unit.reactionTimer <= 0 && seesPlayer && engage && playerAlive) {
          this.updateFire(unit, dt, playerEye);
        } else if (unit.state !== 'alert') {
          unit.state = 'tracking';
        }

        // Short, authored strafe lane. The unit never tries to solve the level;
        // it only changes the angle of pressure while remaining readable.
        const laneSpeed = unit.kind === 'SCOUT' ? 0.24 : 0.09;
        unit.laneT += unit.laneDirection * laneSpeed * step;
        if (unit.laneT <= 0 || unit.laneT >= 1) {
          unit.laneT = clamp(unit.laneT, 0, 1);
          unit.laneDirection *= -1;
        }
        unit.position.lerpVectors(unit.home, unit.patrolTo, unit.laneT);
      }

      unit.recoil = damp(unit.recoil, 0, 14, step);
      this.animate(unit, elapsed, step, playerEye);
    }
  }

  private updateFire(unit: RobotUnit, dt: number, playerEye: THREE.Vector3): void {
    if (unit.burstRemaining <= 0) {
      if (unit.fireTimer > 0) {
        unit.state = 'tracking';
        return;
      }
      unit.burstRemaining = unit.kind === 'SCOUT' ? 2 : 4;
      unit.fireTimer = 0;
    }

    if (unit.fireTimer > 0) return;
    unit.state = 'firing';
    unit.burstRemaining--;
    unit.recoil = 1;
    const origin = this.muzzlePoint(unit).clone();
    this.shotDirection.subVectors(playerEye, origin).normalize();
    const spread = unit.kind === 'SCOUT' ? 0.038 : 0.026;
    this.shotDirection.x += this.rng.spread(spread);
    this.shotDirection.y += this.rng.spread(spread * 0.65);
    this.shotDirection.z += this.rng.spread(spread);
    this.shotDirection.normalize();
    this.bus.emit('enemy:fired', { origin, direction: this.shotDirection.clone() });
    unit.fireTimer = unit.burstRemaining > 0
      ? (unit.kind === 'SCOUT' ? 0.24 : 0.15)
      : (unit.kind === 'SCOUT' ? 1.8 : 1.25);
    void dt;
  }

  private muzzlePoint(unit: RobotUnit): THREE.Vector3 {
    unit.rig.muzzle.getWorldPosition(this.muzzle);
    return this.muzzle;
  }

  private animate(unit: RobotUnit, elapsed: number, dt: number, playerEye: THREE.Vector3): void {
    const root = unit.rig.root;
    root.visible = true;
    root.position.copy(unit.position);
    root.rotation.y = unit.facing;

    if (unit.kind === 'SCOUT') {
      const rig = unit.rig as ScoutRig;
      rig.chassis.position.y = SCOUT_HOVER_HEIGHT + Math.sin(elapsed * 2.6 + unit.laneT * 4) * 0.09;
      rig.chassis.rotation.z = damp(rig.chassis.rotation.z, -unit.laneDirection * 0.08, 7, dt);
      rig.chassis.rotation.x = damp(rig.chassis.rotation.x, unit.recoil * -0.09, 12, dt);
      rig.rotorLeft.rotation.y += dt * 42;
      rig.rotorRight.rotation.y -= dt * 45;
      rig.sensorHead.rotation.y = Math.sin(elapsed * 1.4 + unit.laneT) * 0.08;
      rig.alarmBeacon.visible = unit.alarmTimer > 0 && Math.sin(elapsed * 18) > -0.15;
    } else {
      const rig = unit.rig as SentinelRig;
      rig.hull.rotation.x = damp(rig.hull.rotation.x, unit.laneDirection * 0.025, 8, dt);
      rig.turret.rotation.y = damp(rig.turret.rotation.y, 0, 9, dt);
      this.toPlayer.subVectors(playerEye, unit.position);
      rig.head.rotation.x = clamp(-Math.atan2(this.toPlayer.y - 1.35, Math.hypot(this.toPlayer.x, this.toPlayer.z)), -0.35, 0.35);
      rig.weaponPod.rotation.x = rig.head.rotation.x - unit.recoil * 0.1;
    }
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): EnemyHit | null {
    let best: EnemyHit | null = null;
    let bestScore = maxDistance;
    for (let i = 0; i < this.units.length; i++) {
      const unit = this.units[i];
      if (unit.state === 'dead' || unit.state === 'dying' || !unit.rig.root.visible) continue;

      unit.rig.weakPoint.getWorldPosition(this.weakPoint);
      const weakRadius = unit.kind === 'SCOUT' ? 0.18 : 0.24;
      const weakT = raySphere(origin, direction, this.weakPoint, weakRadius, maxDistance);
      if (weakT >= 0 && weakT - 0.2 < bestScore) {
        bestScore = weakT - 0.2;
        best = this.makeHit(i, origin, direction, weakT, this.weakPoint, true, 'head');
      }

      this.torso.copy(unit.rig.torsoOffset);
      unit.rig.root.localToWorld(this.torso);
      const bodyRadius = unit.kind === 'SCOUT' ? 0.52 : 0.92;
      const bodyT = raySphere(origin, direction, this.torso, bodyRadius, maxDistance);
      if (bodyT >= 0 && bodyT < bestScore) {
        bestScore = bodyT;
        best = this.makeHit(i, origin, direction, bodyT, this.torso, false, 'torso');
      }
    }
    return best;
  }

  private makeHit(
    enemy: number,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    center: THREE.Vector3,
    headshot: boolean,
    zone: EnemyHit['zone'],
  ): EnemyHit {
    const point = origin.clone().addScaledVector(direction, distance);
    const normal = point.clone().sub(center).normalize();
    return { enemy, point, normal, distance, headshot, zone };
  }

  damage(index: number, amount: number, fromDirection: THREE.Vector3, headshot: boolean): boolean {
    const unit = this.units[index];
    if (!unit || unit.state === 'dead' || unit.state === 'dying') return false;
    const applied = amount * (headshot ? 1.65 : unit.kind === 'SENTINEL' ? 0.62 : 1);
    unit.health -= applied;
    unit.state = 'alert';
    unit.reactionTimer = 0;
    unit.facing += fromDirection.x * 0.035;
    if (unit.health > 0) return false;

    unit.health = 0;
    unit.state = 'dying';
    unit.deathTimer = 0;
    this.killCount++;
    this.bus.emit('enemy:killed', { position: unit.position.clone(), remaining: this.aliveCount });
    return true;
  }

  private updateDeath(unit: RobotUnit, dt: number): void {
    unit.deathTimer += dt;
    const t = clamp01(unit.deathTimer / 1.15);
    unit.rig.root.rotation.z = t * (unit.kind === 'SCOUT' ? 1.3 : 0.72);
    unit.rig.root.position.y = unit.kind === 'SCOUT'
      ? unit.home.y - t * SCOUT_HOVER_HEIGHT
      : unit.home.y - Math.sin(t * Math.PI) * 0.05;
    if (unit.deathTimer >= 1.15) {
      unit.state = 'dead';
      unit.rig.root.visible = false;
    }
  }

  reset(): void {
    this.killCount = 0;
    for (const unit of this.units) {
      unit.position.copy(unit.home);
      unit.rig.root.position.copy(unit.home);
      unit.rig.root.rotation.set(0, 0, 0);
      unit.rig.root.visible = true;
      unit.state = 'idle';
      unit.health = unit.maxHealth;
      unit.reactionTimer = 0;
      unit.fireTimer = this.rng.range(0.5, 1.6);
      unit.burstRemaining = 0;
      unit.deathTimer = 0;
      unit.recoil = 0;
      unit.alarmTimer = 0;
      if (unit.kind === 'SCOUT') (unit.rig as ScoutRig).alarmBeacon.visible = false;
    }
  }

  /** Marks one encounter zone as already cleared when restoring a checkpoint. */
  clearZone(zone: RobotZone): void {
    for (const unit of this.units) {
      if (unit.zone !== zone) continue;
      unit.health = 0;
      unit.state = 'dead';
      unit.rig.root.visible = false;
    }
  }

  dispose(): void {
    for (const rig of this.rigs) rig.dispose();
    this.rigs.length = 0;
    this.units.length = 0;
    this.group.removeFromParent();
    this.group.clear();
  }
}

function turnToward(current: number, target: number, maxStep: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + clamp(delta, -maxStep, maxStep);
}

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
