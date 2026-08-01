import * as THREE from 'three';
import { WEAPON_CONFIG, ENEMY_CONFIG } from '@/config/gameplay';
import type { GatekeeperController, GatekeeperHit } from '@/bosses/GatekeeperController';
import type { Warden03Controller } from '@/bosses/Warden03Controller';
import type { EventBus } from '@/core/EventBus';
import type { CollisionWorld, RaycastHit } from '@/physics/CollisionWorld';
import type { VfxManager } from '@/effects/VfxManager';
import type { Player } from '@/player/Player';

export interface CombatTargetHit {
  enemy: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  headshot: boolean;
  zone: 'head' | 'torso' | 'legs';
}

/** Structural contract shared by the soldier and robot enemy managers. */
export interface CombatTargetManager {
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): CombatTargetHit | null;
  damage(index: number, amount: number, fromDirection: THREE.Vector3, headshot: boolean): boolean;
}

interface WardenHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  weak: boolean;
}

type PlayerShotHit =
  | { kind: 'world'; hit: RaycastHit }
  | { kind: 'enemy'; hit: CombatTargetHit; manager: CombatTargetManager }
  | { kind: 'gatekeeper'; hit: GatekeeperHit }
  | { kind: 'warden'; hit: WardenHit };

/**
 * Shot resolution for both the player and the AI.
 *
 * Hitscan, not projectiles. At 6.8mm muzzle velocities over the 60m this level
 * fights across, travel time is ~0.02s - below one frame - so simulating a
 * projectile would add complexity and desync the impact from the muzzle flash
 * for zero perceptual gain. The *tracer* still travels visibly, which is what
 * players actually read as "the bullet".
 *
 * The single most important property of this file: the impact event is emitted
 * on the SAME frame as the shot, so the flash, the report, the tracer spawn and
 * the impact spark/sound are never a frame apart.
 */
export class Ballistics {
  private readonly hitPoint = new THREE.Vector3();
  private readonly incident = new THREE.Vector3();

  /** Shots fired / shots that hit a hostile, for the end-of-mission accuracy. */
  shotsFired = 0;
  shotsHit = 0;

  constructor(
    private readonly collision: CollisionWorld,
    private readonly enemies: readonly CombatTargetManager[],
    private readonly vfx: VfxManager,
    private readonly bus: EventBus,
    private readonly player: Player,
    private readonly gatekeeper: GatekeeperController | null = null,
    private readonly warden: Warden03Controller | null = null,
  ) {}

  /** Resolves one player round. */
  firePlayerShot(origin: THREE.Vector3, direction: THREE.Vector3, listener: THREE.Vector3): void {
    this.shotsFired++;
    const range = WEAPON_CONFIG.range;

    const worldHit = this.collision.raycast(origin, direction, range);
    const gatekeeperHit = this.gatekeeper?.raycast(origin, direction, range) ?? null;
    const wardenHit = this.warden?.raycast(origin, direction, range) ?? null;

    // Resolve exactly one nearest candidate. Starting with the world means a
    // distance tie is treated as cover instead of allowing a shot through it.
    let resolved: PlayerShotHit | null = worldHit ? { kind: 'world', hit: worldHit } : null;
    let nearestDistance = worldHit?.distance ?? range + 1;
    for (const manager of this.enemies) {
      const enemyHit = manager.raycast(origin, direction, range);
      if (enemyHit && enemyHit.distance < nearestDistance) {
        resolved = { kind: 'enemy', hit: enemyHit, manager };
        nearestDistance = enemyHit.distance;
      }
    }
    if (gatekeeperHit && gatekeeperHit.distance < nearestDistance) {
      resolved = { kind: 'gatekeeper', hit: gatekeeperHit };
      nearestDistance = gatekeeperHit.distance;
    }
    if (wardenHit && wardenHit.distance < nearestDistance) {
      resolved = { kind: 'warden', hit: wardenHit };
    }

    if (resolved?.kind === 'enemy') {
      const hit = resolved.hit;
      this.shotsHit++;
      // Head 2.4x, everything else full. See WEAPON_CONFIG.limbMultiplier for
      // why limbs are not discounted.
      const zoneScale = hit.headshot
        ? WEAPON_CONFIG.headshotMultiplier
        : hit.zone === 'legs'
          ? WEAPON_CONFIG.limbMultiplier
          : 1;
      const damage = WEAPON_CONFIG.damage * zoneScale;
      this.incident.copy(direction);
      const killed = resolved.manager.damage(hit.enemy, damage, this.incident, hit.headshot);
      this.bus.emit('impact:enemy', {
        point: hit.point,
        normal: hit.normal,
        headshot: hit.headshot,
        killed,
      });
      this.bus.emit('hitmarker', { headshot: hit.headshot, killed });
      this.vfx.spawnTracer(origin, direction, hit.distance, true);
      return;
    }

    if (resolved?.kind === 'gatekeeper' && this.gatekeeper) {
      const hit = resolved.hit;
      this.shotsHit++;
      const wasDefeated = this.gatekeeper.defeated;
      this.gatekeeper.damage(WEAPON_CONFIG.damage, hit.point);
      const killed = !wasDefeated && this.gatekeeper.defeated;
      const weakPoint = hit.zone === 'coil';
      this.bus.emit('impact:enemy', {
        point: hit.point,
        normal: hit.normal,
        headshot: weakPoint,
        killed,
      });
      this.bus.emit('hitmarker', { headshot: weakPoint, killed });
      this.vfx.spawnTracer(origin, direction, hit.distance, true);
      return;
    }

    if (resolved?.kind === 'warden' && this.warden) {
      const hit = resolved.hit;
      this.shotsHit++;
      const wasDefeated = this.warden.defeated;
      this.warden.damage(WEAPON_CONFIG.damage, hit.point);
      const killed = !wasDefeated && this.warden.defeated;
      this.bus.emit('impact:enemy', {
        point: hit.point,
        normal: hit.normal,
        headshot: hit.weak,
        killed,
      });
      this.bus.emit('hitmarker', { headshot: hit.weak, killed });
      this.vfx.spawnTracer(origin, direction, hit.distance, true);
      return;
    }

    if (resolved?.kind === 'world') {
      const hit = resolved.hit;
      this.bus.emit('impact:surface', {
        point: hit.point,
        normal: hit.normal,
        surface: hit.surface,
        incident: direction.clone(),
        distance: hit.point.distanceTo(listener),
      });
      this.vfx.spawnTracer(origin, direction, hit.distance, true);
    } else {
      // Missed everything: the tracer still flies off into the fog.
      this.vfx.spawnTracer(origin, direction, range, true);
    }
  }

  /** Resolves one AI round. */
  fireEnemyShot(origin: THREE.Vector3, direction: THREE.Vector3, listener: THREE.Vector3): void {
    const range = ENEMY_CONFIG.sightRange + 20;
    const worldHit = this.collision.raycast(origin, direction, range);

    // Player hit test: a capsule approximated by a sphere at chest height.
    const playerCenter = this.hitPoint.copy(this.player.position);
    playerCenter.y += 1.1;
    const toPlayer = tmpVec.subVectors(playerCenter, origin);
    const along = toPlayer.dot(direction);
    let playerDistance = -1;
    if (along > 0) {
      const closest = tmpVec2.copy(origin).addScaledVector(direction, along);
      if (closest.distanceTo(playerCenter) < 0.42) playerDistance = along;
    }

    if (playerDistance >= 0 && (!worldHit || playerDistance < worldHit.distance)) {
      this.player.damage(ENEMY_CONFIG.damage, origin);
      this.vfx.spawnTracer(origin, direction, playerDistance, false);
      return;
    }

    if (worldHit) {
      this.bus.emit('impact:surface', {
        point: worldHit.point,
        normal: worldHit.normal,
        surface: worldHit.surface,
        incident: direction.clone(),
        distance: worldHit.point.distanceTo(listener),
      });
      this.vfx.spawnTracer(origin, direction, worldHit.distance, false);
    } else {
      this.vfx.spawnTracer(origin, direction, range, false);
    }
  }

  get accuracy(): number {
    return this.shotsFired === 0 ? 0 : this.shotsHit / this.shotsFired;
  }

  reset(): void {
    this.shotsFired = 0;
    this.shotsHit = 0;
  }
}

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
