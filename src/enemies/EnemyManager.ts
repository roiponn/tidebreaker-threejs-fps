import * as THREE from 'three';
import { ENEMY_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import { clamp, clamp01, damp, lerp } from '@/core/MathUtils';
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
type EnemyState = 'idle' | 'alert' | 'firing' | 'reloading' | 'dying' | 'dead';

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
  /** Rounds left before this hostile has to reload. */
  magRounds: number;
  /** Counts down through the reload; drives the reload pose in animate(). */
  reloadTimer: number;
  flinch: number;
  flinchDirection: THREE.Vector3;
  deathTimer: number;
  deathRotation: number;
  deathFall: number;
  walkPhase: number;
  strobePhase: number;
  visible: boolean;
  /** Animation-LOD counter; see updateAlive(). */
  animateSkip: number;

  // --- secondary motion state (see animate()) ---
  /** Decoupled yaw chain: hips lag, torso twists, head leads. */
  hipYaw: number;
  torsoYaw: number;
  headYaw: number;
  /** Measured ground speed, used to drive stride length and lean. */
  groundSpeed: number;
  prevGroundSpeed: number;
  prevPosition: THREE.Vector3;
  /** Acceleration lean spring. */
  leanPitch: number;
  leanPitchVel: number;
  leanRoll: number;
  leanRollVel: number;
  /** Recoil absorbed through the upper body. */
  recoil: number;
  recoilVel: number;
  /** Two-stage hit reaction: sharp local response, slower body follow-through. */
  hitPitch: number;
  hitPitchVel: number;
  hitRoll: number;
  hitRollVel: number;
  bodyPitch: number;
  bodyRoll: number;
  breathPhase: number;
}

export interface EnemyHit {
  enemy: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  headshot: boolean;
  /** Which volume was struck. Drives damage scaling and hit feedback. */
  zone: 'head' | 'torso' | 'legs';
}

export class EnemyManager {
  readonly group = new THREE.Group();
  private enemies: Enemy[] = [];
  private rng = new Rng(0xe0e0e1);
  private rigs: SoldierRig[] = [];
  /** Debug switch: disables all AI and hides every soldier. */
  enabled = true;

  /**
   * Pose-test mode (?posetest=1).
   *
   * Lines the first four hostiles up at 2, 4, 8 and 12 metres directly ahead of
   * the player and cycles them through every pose the rig can reach, with the
   * AI frozen. Inspecting joint quality by chasing a strafing enemy around the
   * level is not repeatable; this is.
   */
  private poseTest = false;
  private poseTestReload = false;
  private poseTestOrigin = new THREE.Vector3();
  private poseTestForward = new THREE.Vector3(1, 0, 0);

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly sphereCenter = new THREE.Vector3();
  private readonly capsuleA = new THREE.Vector3();
  private readonly capsuleB = new THREE.Vector3();

  killCount = 0;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly collision: CollisionWorld,
    private readonly bus: EventBus,
  ) {
    this.group.name = 'ExteriorHumanoidRobots';
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
        magRounds: ENEMY_CONFIG.magazineRounds,
        reloadTimer: 0,
        flinch: 0,
        flinchDirection: new THREE.Vector3(),
        deathTimer: 0,
        deathRotation: 0,
        deathFall: 0,
        walkPhase: this.rng.range(0, 6.28),
        strobePhase: this.rng.range(0, 6.28),
        visible: true,
        animateSkip: 0,
        hipYaw: 0,
        torsoYaw: 0,
        headYaw: 0,
        groundSpeed: 0,
        prevGroundSpeed: 0,
        prevPosition: spawn.position.clone(),
        leanPitch: 0,
        leanPitchVel: 0,
        leanRoll: 0,
        leanRollVel: 0,
        recoil: 0,
        recoilVel: 0,
        hitPitch: 0,
        hitPitchVel: 0,
        hitRoll: 0,
        hitRollVel: 0,
        bodyPitch: 0,
        bodyRoll: 0,
        breathPhase: this.rng.range(0, 6.28),
      });
    }
  }

  /**
   * Hostiles actually spawned. The mission counter reads this rather than a
   * configured constant: the constant was a second source of truth for a
   * number the level already owns, and it silently went stale the moment the
   * encounter layout changed.
   */
  /**
   * Per-hostile state readout for `?enemytrace=1`. Reload is a 2 second event
   * that only fires after twelve rounds, so confirming it enters at all - and
   * that the pose follows - is not something to do by staring at the screen.
   */
  get stateTrace(): string {
    return this.enemies
      .filter((e) => e.state !== 'dead')
      .map((e) => `${e.state[0]}${e.magRounds}`)
      .join(' ');
  }

  get totalCount(): number {
    return this.enemies.length;
  }

  get aliveCount(): number {
    let count = 0;
    for (const e of this.enemies) if (e.state !== 'dead' && e.state !== 'dying') count++;
    return count;
  }

  get total(): number {
    return this.enemies.length;
  }

  /** Freezes the AI and lines hostiles up at fixed inspection distances. */
  setPoseTest(enabled: boolean, origin: THREE.Vector3, yaw: number, mode = ''): void {
    this.poseTest = enabled;
    this.poseTestReload = mode === 'reload';
    this.poseTestOrigin.copy(origin);
    this.poseTestForward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    if (!enabled) return;
    // The inspection distances the rig has to hold up at: arm's length,
    // knife-fight, room, across-the-yard, and the far end of the level.
    const distances = [2, 4, 8, 15, 30];
    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i];
      if (i < distances.length) {
        enemy.home
          .copy(origin)
          .addScaledVector(this.poseTestForward, distances[i])
          // Fan them slightly apart so none occludes another.
          .addScaledVector(SIDE.crossVectors(this.poseTestForward, UP_AXIS).normalize(), (i - 2) * 0.9);
        enemy.home.y = origin.y;
        enemy.patrolTo.copy(enemy.home);
        enemy.position.copy(enemy.home);
        enemy.rig.root.position.copy(enemy.home);
        enemy.state = 'alert';
        enemy.rig.root.visible = true;
      } else {
        enemy.rig.root.visible = false;
        enemy.state = 'dead';
      }
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const e of this.enemies) e.rig.root.visible = enabled && e.state !== 'dead';
  }

  // ------------------------------------------------------------------
  // Hitscan
  // ------------------------------------------------------------------

  /**
   * Ray vs. enemy hit volumes: head sphere, torso sphere, legs capsule.
   *
   * Far cheaper than mesh raycasting a rig that changes pose every frame, and
   * with the legs capsule it now covers the whole silhouette. It used to be
   * head + torso only, so every round that struck below hip height passed
   * straight through - the player saw an obvious hit and got no reaction,
   * which reads as the gun not working rather than as a miss.
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
      const legsHit = rayCapsule(
        origin,
        direction,
        this.capsuleA.copy(enemy.position).add(enemy.rig.legsTop),
        this.capsuleB.copy(enemy.position).add(enemy.rig.legsBottom),
        enemy.rig.legsRadius,
        maxDistance,
      );

      // Nearest wins, with the head breaking ties in its own favour so a shot
      // that grazes both the head and the shoulder still counts as a headshot.
      let zone: 'head' | 'torso' | 'legs' | null = null;
      let distance = Infinity;
      if (torsoHit >= 0) {
        zone = 'torso';
        distance = torsoHit;
      }
      if (legsHit >= 0 && legsHit < distance) {
        zone = 'legs';
        distance = legsHit;
      }
      if (headHit >= 0 && headHit <= distance + 0.05) {
        zone = 'head';
        distance = headHit;
      }
      if (!zone) continue;
      if (best && distance >= best.distance) continue;

      const headshot = zone === 'head';
      const point = new THREE.Vector3().copy(origin).addScaledVector(direction, distance);
      const center = this.tmpVec
        .copy(enemy.position)
        .add(
          zone === 'head'
            ? enemy.rig.headOffset
            : zone === 'legs'
              ? enemy.rig.legsTop
              : enemy.rig.torsoOffset,
        );
      const normal = new THREE.Vector3().subVectors(point, center).normalize();
      best = { enemy: i, point, normal, distance, headshot, zone };
    }
    return best;
  }

  /** Applies damage. Returns true if this shot killed the target. */
  damage(index: number, amount: number, fromDirection: THREE.Vector3, headshot: boolean): boolean {
    const enemy = this.enemies[index];
    if (!enemy || enemy.state === 'dead' || enemy.state === 'dying') return false;
    enemy.health -= amount;
    // Flinch. The incoming direction is resolved into the soldier's OWN frame
    // so a shot from the front pitches the torso back, one from the side rolls
    // it, and one from behind pitches it forward - instead of every hit
    // producing the same isolated limb rotation.
    enemy.flinch = ENEMY_CONFIG.flinchTime;
    enemy.flinchDirection.copy(fromDirection).setY(0).normalize();
    const localForward = Math.cos(enemy.facing) * enemy.flinchDirection.z
      + Math.sin(enemy.facing) * enemy.flinchDirection.x;
    const localRight = Math.cos(enemy.facing) * enemy.flinchDirection.x
      - Math.sin(enemy.facing) * enemy.flinchDirection.z;
    const force = 2.4 + this.rng.range(0, 1.6) + Math.min(amount, 60) * 0.02;
    enemy.hitPitchVel += localForward * force;
    enemy.hitRollVel += localRight * force * 0.85;
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

  /**
   * @param engage  False while the player is not yet in the fight - during the
   *                intro sweep, and before they have taken their first action.
   *                Hostiles hold their fire and stay idle. Being shot at
   *                before you can move is not difficulty, it is a loading
   *                screen that damages you.
   */
  update(
    dt: number,
    elapsed: number,
    playerEye: THREE.Vector3,
    playerAlive: boolean,
    engage: boolean,
  ): void {
    if (!this.enabled) return;

    if (this.poseTest) {
      this.updatePoseTest(dt, elapsed, playerEye);
      return;
    }
    for (const enemy of this.enemies) {
      switch (enemy.state) {
        case 'dead':
          continue;
        case 'dying':
          this.updateDying(enemy, dt);
          continue;
        default:
          this.updateAlive(enemy, dt, elapsed, playerEye, playerAlive, engage);
      }
    }
  }

  /**
   * Drives the four inspection hostiles through the rig's full pose range on a
   * loop: idle -> moving -> aiming -> firing -> flinching -> dying -> reset.
   */
  private updatePoseTest(dt: number, elapsed: number, playerEye: THREE.Vector3): void {
    const CYCLE = 12;
    const phase = elapsed % CYCLE;
    for (const enemy of this.enemies) {
      if (enemy.rig.root.visible === false) continue;

      // Always face the player so joints are seen from a consistent angle.
      this.tmpVec.subVectors(playerEye, enemy.position);
      enemy.facing = Math.atan2(this.tmpVec.x, this.tmpVec.z);
      enemy.rig.root.rotation.y = enemy.facing;
      enemy.rig.root.position.copy(enemy.position);

      // ?posetest=reload holds every subject in a looping reload so the pose
      // can be inspected at 2m. The reload only fires after twelve rounds in
      // play, and by then the hostile is usually too far away to read.
      if (this.poseTestReload) {
        enemy.state = 'reloading';
        enemy.reloadTimer = ENEMY_CONFIG.reloadTime * (1 - ((elapsed * 0.4) % 1));
        this.animate(enemy, dt, elapsed);
        continue;
      }

      if (phase < 8) {
        // 0-2 idle, 2-4 walking, 4-6 running, 6-8 aiming/firing.
        enemy.state = phase < 2 ? 'idle' : 'alert';
        if (phase >= 6) enemy.state = 'firing';
        enemy.deathTimer = 0;

        // Actually TRANSLATE during the locomotion phases. The stride is driven
        // by measured displacement, so a stationary soldier has no gait - the
        // walk cannot be inspected without real movement.
        if (phase >= 6 && Math.floor(phase * 8) % 2 === 0 && enemy.recoil < 0.02) {
          enemy.recoilVel += 5.2;
        }
        if (phase >= 2 && phase < 6) {
          const speed = phase < 4 ? 1.5 : ENEMY_CONFIG.strafeSpeed;
          SIDE.crossVectors(this.poseTestForward, UP_AXIS).normalize();
          // Shuttle about the home position rather than integrating a
          // velocity. Integrating leaves a net drift every time a phase starts
          // or ends mid-cycle, and over a few loops the subject wanders out of
          // frame - which makes the whole point of fixed inspection distances
          // moot. Setting the position absolutely is drift-free, and the rig
          // still sees genuine displacement, which is what drives the stride.
          const swing = Math.sin(elapsed * (speed / POSE_TEST_EXCURSION));
          enemy.position.copy(enemy.home).addScaledVector(SIDE, swing * POSE_TEST_EXCURSION);
        } else {
          enemy.position.copy(enemy.home);
        }

        this.animate(enemy, dt, elapsed);
      } else if (phase < 10) {
        // Hit reactions from all four sides in turn, so front/back/left/right
        // responses can be compared.
        enemy.state = 'firing';
        if (enemy.flinch <= 0) {
          enemy.flinch = ENEMY_CONFIG.flinchTime;
          const quadrant = Math.floor((phase - 8) * 2) % 4;
          const angle = enemy.facing + (quadrant * Math.PI) / 2;
          enemy.flinchDirection.set(Math.sin(angle), 0, Math.cos(angle));
          enemy.hitPitchVel += Math.cos((quadrant * Math.PI) / 2) * 3.2;
          enemy.hitRollVel += Math.sin((quadrant * Math.PI) / 2) * 2.8;
        }
        this.animate(enemy, dt, elapsed);
      } else {
        // Death topple.
        enemy.deathTimer = (phase - 10) * 0.5;
        const eased = 1 - Math.pow(1 - Math.min(1, enemy.deathTimer / 0.85), 3);
        enemy.rig.root.rotation.x = eased * -1.42;
        enemy.rig.root.rotation.z = eased * 0.3;
        enemy.rig.leftArm.rotation.x = lerp(-1.05, -0.25, eased);
        enemy.rig.rightArm.rotation.x = lerp(-1.05, -0.35, eased);
        enemy.rig.torso.rotation.x = eased * 0.28;
      }
    }
  }

  private updateAlive(
    enemy: Enemy,
    dt: number,
    elapsed: number,
    playerEye: THREE.Vector3,
    playerAlive: boolean,
    engage: boolean,
  ): void {
    // --- activation ---
    //
    // Progress past `activationX` wakes a hostile, but SEEING the player wakes
    // one too. Without that a soldier the player has walked into view of will
    // stand inert until an invisible line is crossed, which is the single most
    // obvious tell that this is a scripted encounter rather than a garrison.
    // The line-of-sight test runs below; this is the cheap half.
    if (engage && enemy.state === 'idle' && playerEye.x >= enemy.activationX) {
      enemy.state = 'alert';
      enemy.reactionTimer = ENEMY_CONFIG.reactionTime;
    }

    // --- strafe along the authored lane ---
    // A reloading soldier holds position: moving and reloading at once is what
    // makes the pose unreadable.
    if (enemy.state !== 'idle' && enemy.state !== 'reloading') {
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
    // The body no longer snaps as one piece. `facing` is the AIM direction; the
    // hips, torso and head each chase it at their own rate in animate(), which
    // is what stops the soldier reading as a turret.
    this.tmpVec.subVectors(playerEye, enemy.position);
    const distance = this.tmpVec.length();
    enemy.facing = Math.atan2(this.tmpVec.x, this.tmpVec.z);

    // --- can it see the player? ---
    const eye = this.tmpVec2.copy(enemy.position).add(enemy.rig.headOffset);
    const inRange = distance < ENEMY_CONFIG.sightRange;
    const hasLos = inRange && this.collision.hasLineOfSight(eye, playerEye);

    // Seeing the player wakes an idle hostile, wherever the player is.
    if (engage && enemy.state === 'idle' && hasLos && playerAlive) {
      enemy.state = 'alert';
      enemy.reactionTimer = ENEMY_CONFIG.reactionTime;
    }

    if (enemy.state === 'reloading') {
      enemy.reloadTimer -= dt;
      if (enemy.reloadTimer <= 0) {
        enemy.magRounds = ENEMY_CONFIG.magazineRounds;
        enemy.state = 'alert';
        // A short beat after seating the magazine before firing resumes.
        enemy.fireTimer = 0.18;
        enemy.burstRemaining = 0;
      }
    } else if (enemy.state === 'alert' || enemy.state === 'firing') {
      enemy.reactionTimer -= dt;
      if (engage && hasLos && playerAlive && enemy.reactionTimer <= 0) {
        enemy.state = 'firing';
        this.updateFiring(enemy, dt, playerEye, distance);
      } else {
        enemy.state = 'alert';
        enemy.burstRemaining = 0;
      }
    }

    // --- animation LOD ---
    //
    // The pose solve is pure CPU and its result is sub-pixel beyond ~35m. Far
    // hostiles animate on every third frame; the ones the player is actually
    // fighting animate every frame. Nothing is hidden, so there is no pop -
    // only the update RATE changes, and at that distance a 20Hz limb pose is
    // indistinguishable from a 60Hz one.
    const distanceSq = enemy.position.distanceToSquared(playerEye);
    enemy.animateSkip = distanceSq > 35 * 35 ? (enemy.animateSkip + 1) % 3 : 0;
    if (enemy.animateSkip === 0) this.animate(enemy, dt * (distanceSq > 35 * 35 ? 3 : 1), elapsed);

    // Beyond the fog's useful range a soldier is a couple of dark pixels; stop
    // submitting them entirely.
    const visible = distanceSq < 110 * 110;
    if (enemy.rig.root.visible !== visible) enemy.rig.root.visible = visible;
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
    enemy.magRounds--;
    enemy.fireTimer = ENEMY_CONFIG.fireInterval;

    if (enemy.magRounds <= 0) {
      enemy.state = 'reloading';
      enemy.reloadTimer = ENEMY_CONFIG.reloadTime;
      enemy.burstRemaining = 0;
    }

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

    // Recoil is absorbed by the whole upper body, with per-shot variation so a
    // burst never produces identical mechanical motion.
    enemy.recoilVel += 5.2 + this.rng.range(-1.1, 1.4);
    enemy.hitPitchVel -= 0.9 + this.rng.range(0, 0.5);

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

  /**
   * Procedural secondary motion.
   *
   * The rig is still rigid parts - there is no skinning - so the goal here is
   * not to fake deformation but to remove the two things that actually make a
   * character read as mechanical:
   *
   *   1. every segment rotating about its own pivot in lockstep, and
   *   2. the whole body snapping to face a target as one unit.
   *
   * Everything below is transform maths on the existing hierarchy: no extra
   * meshes, no extra draw calls.
   *
   * LAYERS, applied in order:
   *   yaw chain    hips lag the aim, torso twists toward it, head leads
   *   locomotion   stride driven by MEASURED displacement, not a constant
   *   weight       pelvis bob, lateral shift and roll onto the planted foot
   *   lean         acceleration-driven forward/side lean on a spring
   *   breathing    slow idle motion so a stationary soldier is never frozen
   *   recoil       firing impulse absorbed through torso, arms and head
   *   hit          two-stage: sharp local response, slower body follow-through
   */
  private animate(enemy: Enemy, dt: number, elapsed: number): void {
    const rig = enemy.rig;
    // Springs are integrated explicitly, so cap the step. The animation LOD
    // feeds a 3x dt for distant hostiles and that would otherwise overshoot.
    const step = Math.min(dt, 0.05);

    // ---------------------------------------------------------------
    // 1. Yaw chain - hips lag, torso twists, head leads
    // ---------------------------------------------------------------
    const aiming = enemy.state === 'firing';
    // A soldier only repositions their feet once the twist gets uncomfortable;
    // below that the torso does the work. That threshold is what produces the
    // characteristic "turn the upper body first, then step round" motion.
    const twist = shortAngle(enemy.facing - enemy.hipYaw);
    const hipRate = Math.abs(twist) > 0.55 ? 3.4 : 0.7;
    enemy.hipYaw = dampAngle(enemy.hipYaw, enemy.facing, hipRate, dt);
    enemy.torsoYaw = dampAngle(enemy.torsoYaw, enemy.facing, aiming ? 7 : 4.5, dt);
    enemy.headYaw = dampAngle(enemy.headYaw, enemy.facing, aiming ? 11 : 8, dt);

    // ---------------------------------------------------------------
    // 2. Locomotion - stride from MEASURED displacement
    // ---------------------------------------------------------------
    // Driving the walk cycle from a constant speed is the main cause of foot
    // sliding: the feet cycle at a rate unrelated to how far the body moved.
    const moved = Math.hypot(
      enemy.position.x - enemy.prevPosition.x,
      enemy.position.z - enemy.prevPosition.z,
    );
    enemy.prevPosition.copy(enemy.position);
    const instantSpeed = dt > 0.0001 ? moved / dt : 0;
    enemy.groundSpeed = damp(enemy.groundSpeed, instantSpeed, 9, dt);

    const STRIDE = 1.05;
    // Half a cycle per step, so the phase advances with distance travelled.
    enemy.walkPhase += (moved / STRIDE) * Math.PI;
    // A stationary soldier still shifts weight, just very slowly.
    enemy.walkPhase += dt * 0.55;

    const gait = clamp01(enemy.groundSpeed / ENEMY_CONFIG.strafeSpeed);
    const swing = Math.sin(enemy.walkPhase);
    const bob = Math.cos(enemy.walkPhase * 2);

    // ---------------------------------------------------------------
    // 3. Legs - swing, knee lift, and a stance that widens with speed
    // ---------------------------------------------------------------
    const stride = 0.10 + gait * 0.52;
    const leftKnee = rig.leftLeg.userData.knee as THREE.Group;
    const rightKnee = rig.rightLeg.userData.knee as THREE.Group;
    rig.leftLeg.rotation.x = swing * stride;
    rig.rightLeg.rotation.x = -swing * stride;
    // The knee only bends on the SWING leg (the one travelling forward); the
    // stance leg stays straight and carries the body. Bending both is what
    // makes a procedural walk look like a crouching shuffle.
    leftKnee.rotation.x = Math.max(0, -swing) * (0.12 + gait * 0.85);
    rightKnee.rotation.x = Math.max(0, swing) * (0.12 + gait * 0.85);

    // ---------------------------------------------------------------
    // 4. Pelvis - vertical bob, lateral weight transfer, roll
    // ---------------------------------------------------------------
    const breath = Math.sin(elapsed * 1.15 + enemy.breathPhase);
    // Lowest at mid-stance, highest at the pass; amplitude scales with gait so
    // an idle soldier does not bounce.
    rig.hips.position.y = 0.92 - 0.045 * gait * (1 - bob) * 0.5 + breath * 0.006 * (1 - gait);
    // Weight shifts onto the planted foot.
    rig.hips.position.x = swing * 0.035 * gait;
    // Pelvis drops slightly on the swing side.
    rig.hips.rotation.z = -swing * 0.075 * gait;
    // Pelvis rotation about the vertical, opposed by the shoulders below.
    rig.hips.rotation.y = swing * 0.13 * gait;

    // ---------------------------------------------------------------
    // 5. Lean from acceleration
    // ---------------------------------------------------------------
    const accel = (enemy.groundSpeed - enemy.prevGroundSpeed) / Math.max(dt, 0.0001);
    enemy.prevGroundSpeed = enemy.groundSpeed;
    const targetPitch = clamp(accel * 0.012, -0.10, 0.14) + gait * 0.055;
    enemy.leanPitchVel += (targetPitch - enemy.leanPitch) * 46 * step - enemy.leanPitchVel * 9 * step;
    enemy.leanPitch += enemy.leanPitchVel * step;
    // Lateral lean into the direction of travel relative to facing.
    const strafeSign = Math.sin(shortAngle(enemy.facing - enemy.hipYaw));
    enemy.leanRollVel += (strafeSign * gait * 0.06 - enemy.leanRoll) * 40 * step - enemy.leanRollVel * 8 * step;
    enemy.leanRoll += enemy.leanRollVel * step;

    // ---------------------------------------------------------------
    // 6. Recoil and hit springs
    // ---------------------------------------------------------------
    enemy.recoilVel -= enemy.recoil * 260 * step + enemy.recoilVel * 17 * step;
    enemy.recoil += enemy.recoilVel * step;

    // Sharp local response...
    enemy.hitPitchVel -= enemy.hitPitch * 150 * step + enemy.hitPitchVel * 11 * step;
    enemy.hitPitch += enemy.hitPitchVel * step;
    enemy.hitRollVel -= enemy.hitRoll * 150 * step + enemy.hitRollVel * 11 * step;
    enemy.hitRoll += enemy.hitRollVel * step;
    // ...followed by a slower whole-body follow-through that trails it.
    enemy.bodyPitch = damp(enemy.bodyPitch, enemy.hitPitch * 0.45, 7, dt);
    enemy.bodyRoll = damp(enemy.bodyRoll, enemy.hitRoll * 0.45, 7, dt);
    if (enemy.flinch > 0) enemy.flinch = Math.max(0, enemy.flinch - dt);

    // ---------------------------------------------------------------
    // 7. Compose
    // ---------------------------------------------------------------
    // Hips carry the follow-through, not the sharp response.
    rig.root.rotation.y = enemy.hipYaw;
    rig.root.rotation.x = enemy.bodyPitch * 0.5;
    rig.root.rotation.z = enemy.bodyRoll * 0.5;

    // Torso: twist toward the aim, counter-rotate against the pelvis, lean,
    // absorb recoil, and take the sharp part of a hit.
    const torsoTwist = clamp(shortAngle(enemy.torsoYaw - enemy.hipYaw), -0.95, 0.95);
    rig.torso.rotation.y = torsoTwist - swing * 0.16 * gait;
    rig.torso.rotation.x =
      enemy.leanPitch + enemy.recoil * 0.09 + enemy.hitPitch * 0.55 + breath * 0.012;
    rig.torso.rotation.z = enemy.leanRoll + enemy.hitRoll * 0.55 + swing * 0.03 * gait;

    // Head: leads the torso, and STABILISES - it counters most of the body's
    // bob and lean so the eyeline stays level, which is what real heads do and
    // what most procedural rigs forget.
    const headTwist = clamp(shortAngle(enemy.headYaw - enemy.torsoYaw), -0.7, 0.7);
    rig.head.rotation.y = damp(rig.head.rotation.y, headTwist, 12, dt);
    rig.head.rotation.x = damp(
      rig.head.rotation.x,
      -(enemy.leanPitch * 0.75) - enemy.hitPitch * 0.22 + (aiming ? -0.10 : 0),
      10,
      dt,
    );
    rig.head.rotation.z = damp(rig.head.rotation.z, -enemy.leanRoll * 0.6 - enemy.hitRoll * 0.3, 9, dt);

    // ---------------------------------------------------------------
    // 8. Arms - swing when walking, up on the weapon when aiming,
    //           and the reload
    // ---------------------------------------------------------------
    const aim = aiming ? 1 : 0;
    // Arms swing opposite to the legs, but only while the weapon is down.
    const armSwing = -swing * 0.42 * gait * (1 - aim);
    let rightBase = lerp(-0.80, -1.32, aim) - enemy.recoil * 0.16;
    let leftBase = lerp(-0.74, -1.24, aim) - enemy.recoil * 0.10;
    let rightRoll = -0.22 - aim * 0.06;
    let leftRoll = 0.30 + aim * 0.08;

    // RELOAD.
    //
    // Previously a reloading hostile simply stopped shooting, which from the
    // player's side is indistinguishable from one that has lost interest. The
    // pose has to say what is happening: the weapon comes down off the
    // shoulder, the support hand leaves it and drops to the magazine well,
    // comes back up, and the weapon returns.
    //
    // Three beats over the reload's life, shaped so the hand is at the well
    // for the middle third rather than passing through it.
    if (enemy.state === 'reloading' && ENEMY_CONFIG.reloadTime > 0) {
      const t = clamp01(1 - enemy.reloadTimer / ENEMY_CONFIG.reloadTime);
      // Ease in and out of the whole action so it does not start with a snap.
      const engage = Math.sin(clamp01(t / 0.22) * Math.PI * 0.5);
      const release = Math.sin(clamp01((1 - t) / 0.22) * Math.PI * 0.5);
      const hold = Math.min(engage, release);
      // The support hand's trip down to the well and back.
      const reach = Math.sin(clamp01((t - 0.15) / 0.55) * Math.PI);

      rightBase = lerp(rightBase, -0.46, hold);          // weapon lowered
      leftBase = lerp(leftBase, -0.30 + reach * 0.55, hold); // hand to the well
      rightRoll = lerp(rightRoll, -0.10, hold);
      leftRoll = lerp(leftRoll, 0.62 - reach * 0.30, hold);
      // The whole upper body turns slightly into the work and dips.
      rig.torso.rotation.x += hold * 0.10;
      rig.torso.rotation.y += hold * 0.16;
      rig.head.rotation.x += hold * 0.16 * reach; // glances down at the well
    }

    rig.rightArm.rotation.x = damp(rig.rightArm.rotation.x, rightBase + armSwing, 9, dt);
    rig.leftArm.rotation.x = damp(rig.leftArm.rotation.x, leftBase - armSwing, 9, dt);
    // Shoulders follow the weapon rather than staying square to the chest.
    rig.rightArm.rotation.z = damp(rig.rightArm.rotation.z, rightRoll, 8, dt);
    rig.leftArm.rotation.z = damp(rig.leftArm.rotation.z, leftRoll, 8, dt);

    // IR strobe blink - the readability aid, not a decoration.
    const blink = Math.sin(elapsed * 4.2 + enemy.strobePhase);
    (rig.strobe.material as THREE.MeshStandardMaterial).emissiveIntensity = blink > 0.72 ? 9 : 1.1;
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

  /** Marks the exterior encounter as complete when restoring a later checkpoint. */
  clearAll(): void {
    for (const enemy of this.enemies) {
      enemy.health = 0;
      enemy.state = 'dead';
      enemy.rig.root.visible = false;
    }
  }

  dispose(): void {
    for (const rig of this.rigs) rig.dispose();
    this.rigs.length = 0;
    this.enemies.length = 0;
    this.group.removeFromParent();
  }
}

/**
 * Ray vs. capsule (a segment with a radius). Returns the near hit distance
 * or -1.
 *
 * Solved as ray-vs-infinite-cylinder, then clamped to the segment, with the
 * two end spheres tested separately so the caps are not missed. A capsule is
 * used for the legs rather than a stack of spheres because it is one test and
 * it matches the shape of a leg column exactly.
 */
function rayCapsule(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  maxDistance: number,
): number {
  const ax = b.x - a.x;
  const ay = b.y - a.y;
  const az = b.z - a.z;
  const ox = origin.x - a.x;
  const oy = origin.y - a.y;
  const oz = origin.z - a.z;
  const aa = ax * ax + ay * ay + az * az;
  if (aa < 1e-8) return raySphere(origin, direction, a, radius, maxDistance);

  const ad = ax * direction.x + ay * direction.y + az * direction.z;
  const ao = ax * ox + ay * oy + az * oz;
  const A = aa - ad * ad;
  const B = aa * (ox * direction.x + oy * direction.y + oz * direction.z) - ao * ad;
  const C = aa * (ox * ox + oy * oy + oz * oz - radius * radius) - ao * ao;

  let best = -1;
  if (Math.abs(A) > 1e-8) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t >= 0 && t <= maxDistance) {
        // Inside the segment's span, not past an end cap.
        const h = ao + t * ad;
        if (h >= 0 && h <= aa) best = t;
      }
    }
  }
  // End caps. Either can be nearer than the barrel hit at a shallow angle.
  for (const cap of [a, b]) {
    const t = raySphere(origin, direction, cap, radius, maxDistance);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
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

/** Signed shortest angular difference, in (-PI, PI]. */
function shortAngle(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Angle damping that takes the short way around. */
function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-rate * dt));
}

const SIDE = new THREE.Vector3();
/** Half-width of the pose-test shuttle, in metres. */
const POSE_TEST_EXCURSION = 1.1;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
