import * as THREE from 'three';
import { WEAPON_CONFIG, ENEMY_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import type { EnemyManager } from '@/enemies/EnemyManager';
import type { VfxManager } from '@/effects/VfxManager';
import type { Player } from '@/player/Player';

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
    private readonly enemies: EnemyManager,
    private readonly vfx: VfxManager,
    private readonly bus: EventBus,
    private readonly player: Player,
  ) {}

  /** Resolves one player round. */
  firePlayerShot(origin: THREE.Vector3, direction: THREE.Vector3, listener: THREE.Vector3): void {
    this.shotsFired++;
    const range = WEAPON_CONFIG.range;

    const worldHit = this.collision.raycast(origin, direction, range);
    const enemyHit = this.enemies.raycast(origin, direction, range);

    // Whichever is nearer wins. Enemies are tested against the world so you
    // cannot shoot through a container and still hit a soldier behind it.
    if (enemyHit && (!worldHit || enemyHit.distance < worldHit.distance)) {
      this.shotsHit++;
      // Head 2.4x, everything else full. See WEAPON_CONFIG.limbMultiplier for
      // why limbs are not discounted.
      const zoneScale = enemyHit.headshot
        ? WEAPON_CONFIG.headshotMultiplier
        : enemyHit.zone === 'legs'
          ? WEAPON_CONFIG.limbMultiplier
          : 1;
      const damage = WEAPON_CONFIG.damage * zoneScale;
      this.incident.copy(direction);
      const killed = this.enemies.damage(enemyHit.enemy, damage, this.incident, enemyHit.headshot);
      this.bus.emit('impact:enemy', {
        point: enemyHit.point,
        normal: enemyHit.normal,
        headshot: enemyHit.headshot,
        killed,
      });
      this.bus.emit('hitmarker', { headshot: enemyHit.headshot, killed });
      this.vfx.spawnTracer(origin, direction, enemyHit.distance, true);
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
      this.vfx.spawnTracer(origin, direction, worldHit.distance, true);
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
