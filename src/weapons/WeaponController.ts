import * as THREE from 'three';
import { WEAPON_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import { clamp, clamp01, damp, lerp, smoothstep } from '@/core/MathUtils';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { MutableVisual } from '@/config/visual';
import type { PlayerCamera } from '@/player/PlayerCamera';
import { buildRifle, type RifleParts } from './RifleModel';

/**
 * Weapon state, animation and ballistics.
 *
 * The pose is composed additively from independent layers, which is what keeps
 * the feel readable and tunable:
 *
 *   base pose  (hip <-> ADS, driven by one smoothed 0..1 blend)
 *   + sway     (mouse-look lag: the gun trails the view)
 *   + bob      (walk cycle, suppressed while aiming)
 *   + sprint   (canted low-ready, blended in over 0.2s)
 *   + recoil   (spring-damped kick back/up/roll, per shot)
 *   + retract  (muzzle-near-wall pull-in)
 *
 * Each layer writes into its own vector and they are summed once at the end,
 * so no layer can fight another and any of them can be soloed for debugging.
 */
export type WeaponState = 'ready' | 'firing' | 'reloading';

const HIP_POSITION = new THREE.Vector3(0.118, -0.108, -0.30);
const HIP_ROTATION = new THREE.Euler(0.02, 0.11, 0.035);
// Aligns the optic's sight point with the exact centre of the screen.
const ADS_POSITION = new THREE.Vector3(0, -0.1005, -0.212);
const ADS_ROTATION = new THREE.Euler(0, 0, 0);
const SPRINT_POSITION = new THREE.Vector3(0.155, -0.175, -0.30);
const SPRINT_ROTATION = new THREE.Euler(0.30, 0.62, -0.34);
const RETRACT_POSITION = new THREE.Vector3(0.075, -0.145, -0.14);
const RETRACT_ROTATION = new THREE.Euler(0.15, 0.85, 0.1);

export class WeaponController {
  readonly parts: RifleParts;

  state: WeaponState = 'ready';
  magAmmo: number = WEAPON_CONFIG.magSize;
  reserveAmmo: number = WEAPON_CONFIG.reserveAmmo;
  /** 0 = hip, 1 = fully aimed. Read by the HUD and the post stack. */
  adsBlend = 0;
  /** Barrel heat 0..1, drives the emissive glow and the heat-haze VFX. */
  heat = 0;
  /** Current bullet spread in radians, including movement and fire bloom. */
  spread: number = WEAPON_CONFIG.spreadHip;

  private fireTimer = 0;
  private reloadTimer = 0;
  private reloadDuration = 0;
  private reloadWasEmpty = false;
  private magSwapDone = false;
  private shotsInBurst = 0;
  private spreadBloom = 0;
  private triggerHeld = false;
  private hasFired = false;

  // Animation layers.
  private swayPos = new THREE.Vector3();
  private swayRot = new THREE.Vector3();
  private bobPhase = 0;
  private bobPos = new THREE.Vector3();
  private recoilPos = new THREE.Vector3();
  private recoilRot = new THREE.Vector3();
  private recoilVel = new THREE.Vector3();
  private recoilRotVel = new THREE.Vector3();
  private sprintBlend = 0;
  private retractBlend = 0;
  private reloadPos = new THREE.Vector3();
  private reloadRot = new THREE.Vector3();

  private boltOffset = 0;
  private boltVelocity = 0;
  private triggerPull = 0;

  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpRot = new THREE.Euler();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly aimDirection = new THREE.Vector3();
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly probeOrigin = new THREE.Vector3();

  /** Debug-panel multipliers. */
  recoilScale = 1;

  constructor(
    mats: MaterialLibrary,
    private readonly view: PlayerCamera,
    private readonly collision: CollisionWorld,
    private readonly bus: EventBus,
    private readonly visual: MutableVisual,
  ) {
    this.parts = buildRifle(mats);
    this.view.weaponCamera.add(this.parts.root);
    this.parts.root.position.copy(HIP_POSITION);
    this.parts.root.rotation.copy(HIP_ROTATION);
  }

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------

  setTrigger(held: boolean): void {
    this.triggerHeld = held;
  }

  requestReload(): void {
    if (this.state === 'reloading') return;
    if (this.magAmmo >= WEAPON_CONFIG.magSize || this.reserveAmmo <= 0) return;
    this.startReload();
  }

  private startReload(): void {
    this.reloadWasEmpty = this.magAmmo <= 0;
    this.reloadDuration = this.reloadWasEmpty ? WEAPON_CONFIG.reloadEmptyTime : WEAPON_CONFIG.reloadTime;
    this.reloadTimer = 0;
    this.magSwapDone = false;
    this.state = 'reloading';
    this.bus.emit('weapon:reloadStart', { empty: this.reloadWasEmpty, duration: this.reloadDuration });
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  update(
    dt: number,
    elapsed: number,
    wantsAds: boolean,
    sprinting: boolean,
    moveSpeed: number,
    grounded: boolean,
    crouched: boolean,
    lookDeltaX: number,
    lookDeltaY: number,
  ): void {
    const canAds = this.state !== 'reloading' && !sprinting;
    const adsTarget = wantsAds && canAds ? 1 : 0;
    const previousAds = this.adsBlend > 0.5;
    // ADS uses a fixed-time approach rather than a damp so the transition
    // duration is exactly WEAPON_CONFIG.adsTime and can be tuned to the audio.
    const adsRate = 1 / WEAPON_CONFIG.adsTime;
    this.adsBlend = clamp01(this.adsBlend + (adsTarget - this.adsBlend > 0 ? adsRate : -adsRate) * dt);
    if (previousAds !== this.adsBlend > 0.5) {
      this.bus.emit('weapon:adsChanged', { ads: this.adsBlend > 0.5 });
    }

    this.sprintBlend = damp(this.sprintBlend, sprinting && this.state !== 'reloading' ? 1 : 0, 9, dt);

    this.updateFiring(dt, sprinting, moveSpeed, crouched);
    this.updateReload(dt);
    this.updateSway(dt, lookDeltaX, lookDeltaY);
    this.updateBob(dt, moveSpeed, grounded);
    this.updateRecoilSpring(dt);
    this.updateWallProbe(dt);
    this.updateMovingParts(dt);
    this.updateHeat(dt, elapsed);
    this.composePose();
  }

  private updateFiring(dt: number, sprinting: boolean, moveSpeed: number, crouched: boolean): void {
    this.fireTimer -= dt;

    const canFire =
      this.triggerHeld &&
      this.state !== 'reloading' &&
      !sprinting &&
      this.fireTimer <= 0;

    if (canFire) {
      if (this.magAmmo > 0) {
        this.fire(moveSpeed, crouched);
        this.fireTimer = 60 / WEAPON_CONFIG.rpm;
      } else {
        this.bus.emit('weapon:dryFire');
        this.fireTimer = 0.35;
        // Auto-reload on an empty trigger pull: expected behaviour in the genre.
        if (this.reserveAmmo > 0) this.startReload();
      }
    }

    // Spread recovery and the movement/stance modifiers.
    this.spreadBloom = Math.max(0, this.spreadBloom - WEAPON_CONFIG.spreadRecovery * dt);
    const base = lerp(WEAPON_CONFIG.spreadHip, WEAPON_CONFIG.spreadAds, this.adsBlend);
    const movement = WEAPON_CONFIG.spreadMoving * clamp01(moveSpeed / 5);
    const stance = crouched ? WEAPON_CONFIG.spreadCrouch : 0;
    this.spread = Math.max(0.0004, base + movement + stance + this.spreadBloom);

    if (!this.triggerHeld) this.shotsInBurst = Math.max(0, this.shotsInBurst - dt * 12);
    this.state = this.state === 'reloading' ? 'reloading' : this.triggerHeld ? 'firing' : 'ready';
  }

  private fire(moveSpeed: number, crouched: boolean): void {
    void moveSpeed;
    void crouched;
    this.magAmmo--;
    this.hasFired = true;
    this.shotsInBurst++;

    // Muzzle position in world space, taken from the animated model so the
    // flash, the smoke and the tracer all originate from the same point the
    // player can see - this is what makes the shot read as synchronised.
    this.parts.muzzlePoint.getWorldPosition(this.muzzleWorld);
    this.view.getAimDirection(this.aimDirection);

    // Cone spread around the aim.
    const spread = this.spread;
    if (spread > 0.0001) {
      const angle = Math.random() * Math.PI * 2;
      // sqrt gives a uniform disc rather than a centre-heavy one.
      const radius = Math.sqrt(Math.random()) * spread;
      const right = new THREE.Vector3().crossVectors(this.aimDirection, UP).normalize();
      const up = new THREE.Vector3().crossVectors(right, this.aimDirection).normalize();
      this.aimDirection
        .addScaledVector(right, Math.cos(angle) * radius)
        .addScaledVector(up, Math.sin(angle) * radius)
        .normalize();
    }

    // Recoil: ramps up over the first few rounds, then plateaus. A constant
    // per-shot kick feels robotic; an unbounded ramp feels broken.
    const ramp = lerp(
      1,
      WEAPON_CONFIG.recoilRampMax,
      smoothstep(clamp01(this.shotsInBurst / WEAPON_CONFIG.recoilRampShots)),
    );
    const adsDamp = lerp(1, 0.72, this.adsBlend);
    const kick = ramp * adsDamp * this.recoilScale;
    this.view.addRecoil(
      WEAPON_CONFIG.recoilVertical * kick,
      (Math.random() * 2 - 1) * WEAPON_CONFIG.recoilHorizontal * kick,
    );
    // Camera shake on firing is deliberately tiny - the weapon model moving is
    // what sells the shot; shaking the world just hurts the player's aim.
    this.view.addShake(0.028 * adsDamp, 34);

    // Weapon model kick, as an impulse into the spring below.
    this.recoilVel.z += WEAPON_CONFIG.weaponKickBack * kick * 62;
    this.recoilVel.y += WEAPON_CONFIG.weaponKickUp * kick * 46;
    this.recoilRotVel.x -= WEAPON_CONFIG.weaponKickUp * kick * 130;
    this.recoilRotVel.z += (Math.random() * 2 - 1) * WEAPON_CONFIG.weaponKickRoll * kick * 42;

    this.boltVelocity = 6.2;
    this.triggerPull = 1;
    this.spreadBloom = Math.min(
      WEAPON_CONFIG.spreadBloomMax,
      this.spreadBloom + WEAPON_CONFIG.spreadBloomPerShot,
    );
    this.heat = clamp01(this.heat + WEAPON_CONFIG.heatPerShot);

    this.bus.emit('weapon:fired', {
      origin: this.muzzleWorld.clone(),
      direction: this.aimDirection.clone(),
      ammo: this.magAmmo,
    });
    this.bus.emit('weapon:ammoChanged', { mag: this.magAmmo, reserve: this.reserveAmmo });
  }

  private updateReload(dt: number): void {
    if (this.state !== 'reloading') return;
    this.reloadTimer += dt;
    const t = clamp01(this.reloadTimer / this.reloadDuration);

    // --- magazine animation ---
    // 0.00-0.22 tilt the weapon in and drop the magazine
    // 0.22-0.62 the empty mag falls away, hand travels
    // 0.62-0.80 new magazine slams home
    // 0.80-1.00 (empty reload only) bolt release, weapon returns
    let magDrop = 0;
    if (t < 0.22) magDrop = smoothstep(t / 0.22) * 0.9;
    else if (t < 0.62) magDrop = 0.9 + (t - 0.22) * 1.4;
    else if (t < 0.8) magDrop = lerp(1.1, 0, smoothstep((t - 0.62) / 0.18));
    this.parts.magazine.position.y = -0.068 - magDrop * 0.26;
    this.parts.magazine.position.z = -0.035 + magDrop * 0.05;
    this.parts.magazine.rotation.x = magDrop * 0.55;
    this.parts.magazine.visible = !(t > 0.28 && t < 0.6);

    if (!this.magSwapDone && t >= WEAPON_CONFIG.reloadAmmoSwapAt) {
      this.magSwapDone = true;
      const needed = WEAPON_CONFIG.magSize - this.magAmmo;
      const taken = Math.min(needed, this.reserveAmmo);
      this.magAmmo += taken;
      this.reserveAmmo -= taken;
      this.bus.emit('weapon:magIn');
      this.bus.emit('weapon:ammoChanged', { mag: this.magAmmo, reserve: this.reserveAmmo });
    }
    if (t > 0.24 && t < 0.30) {
      // Emitted once thanks to the window; the audio system de-dupes anyway.
      this.bus.emit('weapon:magOut');
    }

    // --- weapon body motion during the reload ---
    const swing = Math.sin(t * Math.PI);
    this.reloadPos.set(-0.02 * swing, -0.05 * swing, 0.03 * swing);
    this.reloadRot.set(0.22 * swing, 0.34 * swing, -0.42 * swing);

    // Empty reload: charging handle is racked at the end.
    if (this.reloadWasEmpty && t > 0.84 && this.boltVelocity === 0 && this.boltOffset < 0.001) {
      this.boltVelocity = 7.5;
      this.bus.emit('weapon:boltRelease');
    }

    if (t >= 1) {
      this.state = 'ready';
      this.reloadPos.set(0, 0, 0);
      this.reloadRot.set(0, 0, 0);
      this.parts.magazine.position.set(0, -0.068, -0.035);
      this.parts.magazine.rotation.set(0, 0, 0);
      this.parts.magazine.visible = true;
      this.bus.emit('weapon:reloadEnd');
    }
  }

  /**
   * Sway: the weapon lags behind the view. Implemented as a smoothed,
   * clamped copy of the mouse delta so a fast flick throws the muzzle wide
   * and it settles back - the primary source of "weight" in the hands.
   */
  private updateSway(dt: number, lookDeltaX: number, lookDeltaY: number): void {
    const scale = lerp(1, 0.32, this.adsBlend);
    const targetX = clamp(-lookDeltaX * 0.0016, -1, 1) * WEAPON_CONFIG.swayPosition * scale * 12;
    const targetY = clamp(lookDeltaY * 0.0016, -1, 1) * WEAPON_CONFIG.swayPosition * scale * 12;
    const rate = WEAPON_CONFIG.swaySmoothing;
    this.swayPos.x = damp(this.swayPos.x, targetX, rate, dt);
    this.swayPos.y = damp(this.swayPos.y, targetY, rate, dt);
    this.swayRot.y = damp(this.swayRot.y, targetX * WEAPON_CONFIG.swayRotation * 22, rate, dt);
    this.swayRot.x = damp(this.swayRot.x, -targetY * WEAPON_CONFIG.swayRotation * 22, rate, dt);
    this.swayRot.z = damp(this.swayRot.z, targetX * WEAPON_CONFIG.swayRotation * 14, rate * 0.8, dt);
  }

  private updateBob(dt: number, moveSpeed: number, grounded: boolean): void {
    const intensity = grounded ? clamp01(moveSpeed / 5.2) : 0;
    const amplitude = lerp(
      lerp(WEAPON_CONFIG.bobWalk, WEAPON_CONFIG.bobSprint, clamp01(moveSpeed / 6.5)),
      WEAPON_CONFIG.bobWalk * 0.18,
      this.adsBlend,
    );
    if (grounded) this.bobPhase += dt * WEAPON_CONFIG.bobFrequency * (0.55 + intensity * 0.75);
    const target = new THREE.Vector3(
      Math.sin(this.bobPhase) * amplitude * intensity,
      -Math.abs(Math.cos(this.bobPhase)) * amplitude * 0.72 * intensity,
      0,
    );
    this.bobPos.lerp(target, clamp01(dt * 12));
  }

  /** Spring-damped return so recoil overshoots slightly and settles. */
  private updateRecoilSpring(dt: number): void {
    const stiffness = 210;
    const damping = WEAPON_CONFIG.weaponKickRecovery * 1.55;
    for (const axis of ['x', 'y', 'z'] as const) {
      this.recoilVel[axis] += (-stiffness * this.recoilPos[axis] - damping * this.recoilVel[axis]) * dt;
      this.recoilPos[axis] += this.recoilVel[axis] * dt;
      this.recoilRotVel[axis] += (-stiffness * this.recoilRot[axis] - damping * this.recoilRot[axis] * 0) * dt;
      this.recoilRotVel[axis] -= damping * this.recoilRotVel[axis] * dt;
      this.recoilRot[axis] += this.recoilRotVel[axis] * dt;
    }
  }

  /**
   * Wall retract. A short ray from the eye along the aim: if something is
   * close the weapon is pulled into a low-ready so the barrel never pokes
   * through geometry. Cheaper and more readable than real weapon collision.
   */
  private updateWallProbe(dt: number): void {
    this.probeOrigin.copy(this.view.camera.position);
    this.view.getAimDirection(this.aimDirection);
    const hit = this.collision.raycast(this.probeOrigin, this.aimDirection, WEAPON_CONFIG.wallProbeDistance);
    const proximity = hit ? 1 - clamp01(hit.distance / WEAPON_CONFIG.wallProbeDistance) : 0;
    this.retractBlend = damp(this.retractBlend, proximity * (1 - this.adsBlend * 0.65), 11, dt);
  }

  private updateMovingParts(dt: number): void {
    // Bolt: a fast rearward stroke then a spring-loaded return.
    this.boltOffset += this.boltVelocity * dt;
    if (this.boltOffset > 0.036) {
      this.boltOffset = 0.036;
      this.boltVelocity = -11;
    }
    if (this.boltOffset <= 0) {
      this.boltOffset = 0;
      this.boltVelocity = 0;
    }
    this.parts.bolt.position.z = this.boltOffset;
    this.parts.chargingHandle.position.z = this.boltOffset * 0.85;

    // The dust cover flips open on the first shot and stays open, which is a
    // small persistent record of the player having used the weapon.
    const coverTarget = this.hasFired ? -1.35 : 0;
    this.parts.dustCover.rotation.z = damp(this.parts.dustCover.rotation.z, coverTarget, 9, dt);

    this.triggerPull = damp(this.triggerPull, 0, 22, dt);
    this.parts.trigger.rotation.x = this.triggerPull * 0.42;
  }

  private updateHeat(dt: number, elapsed: number): void {
    this.heat = Math.max(0, this.heat - WEAPON_CONFIG.heatCooling * dt);
    // Barrel glow is nonlinear: nothing visible until the weapon is genuinely
    // hot, then it comes up fast, like real steel.
    const glow = Math.pow(clamp01((this.heat - 0.35) / 0.65), 2.2);
    this.parts.barrelMaterial.emissiveIntensity = glow * 2.4;
    // Reticle brightness pulses very slightly - a holographic sight is not a
    // perfectly steady light source.
    this.parts.reticleMaterial.emissiveIntensity = 5.2 + Math.sin(elapsed * 9) * 0.25;
    // The optic glass is only worth drawing when the player is behind it.
    this.parts.reticleMaterial.opacity = lerp(0.55, 1, this.adsBlend);
  }

  /** Sums every animation layer into the final transform. */
  private composePose(): void {
    const ads = this.adsBlend;
    const sprint = this.sprintBlend;
    const retract = this.retractBlend;

    // Base pose: hip -> ADS -> sprint -> retract, each overriding the last.
    this.tmpPos.copy(HIP_POSITION).lerp(ADS_POSITION, ads);
    this.tmpRot.set(
      lerp(HIP_ROTATION.x, ADS_ROTATION.x, ads),
      lerp(HIP_ROTATION.y, ADS_ROTATION.y, ads),
      lerp(HIP_ROTATION.z, ADS_ROTATION.z, ads),
    );
    if (sprint > 0.001) {
      this.tmpPos.lerp(SPRINT_POSITION, sprint);
      this.tmpRot.set(
        lerp(this.tmpRot.x, SPRINT_ROTATION.x, sprint),
        lerp(this.tmpRot.y, SPRINT_ROTATION.y, sprint),
        lerp(this.tmpRot.z, SPRINT_ROTATION.z, sprint),
      );
    }
    if (retract > 0.001) {
      this.tmpPos.lerp(RETRACT_POSITION, retract * WEAPON_CONFIG.wallRetract * 4.2);
      this.tmpRot.set(
        lerp(this.tmpRot.x, RETRACT_ROTATION.x, retract),
        lerp(this.tmpRot.y, RETRACT_ROTATION.y, retract),
        lerp(this.tmpRot.z, RETRACT_ROTATION.z, retract),
      );
    }

    // Additive layers. Sway and bob are suppressed while aiming so the sight
    // picture stays usable.
    const additiveScale = lerp(1, 0.35, ads);
    this.tmpPos.x += (this.swayPos.x + this.bobPos.x) * additiveScale + this.reloadPos.x;
    this.tmpPos.y += (this.swayPos.y + this.bobPos.y) * additiveScale + this.reloadPos.y + this.recoilPos.y;
    this.tmpPos.z += this.recoilPos.z + this.reloadPos.z;

    this.parts.root.position.copy(this.tmpPos);
    this.tmpRot.x += this.swayRot.x * additiveScale + this.recoilRot.x + this.reloadRot.x;
    this.tmpRot.y += this.swayRot.y * additiveScale + this.reloadRot.y;
    this.tmpRot.z += this.swayRot.z * additiveScale + this.recoilRot.z + this.reloadRot.z;
    this.tmpQuat.setFromEuler(this.tmpRot);
    this.parts.root.quaternion.copy(this.tmpQuat);
  }

  // ------------------------------------------------------------------

  /** World-space muzzle position, used by the VFX and audio systems. */
  getMuzzleWorld(target: THREE.Vector3): THREE.Vector3 {
    return this.parts.muzzlePoint.getWorldPosition(target);
  }

  getEjectWorld(target: THREE.Vector3): THREE.Vector3 {
    return this.parts.ejectPoint.getWorldPosition(target);
  }

  /** Focus distance for depth of field: what the player is actually looking at. */
  getFocusDistance(): number {
    this.probeOrigin.copy(this.view.camera.position);
    this.view.getAimDirection(this.aimDirection);
    const hit = this.collision.raycast(this.probeOrigin, this.aimDirection, 120);
    const distance = hit ? hit.distance : lerp(this.visual.dof.focusHip, this.visual.dof.focusAds, this.adsBlend);
    return clamp(distance, 1.5, 120);
  }

  resupply(): void {
    this.magAmmo = WEAPON_CONFIG.magSize;
    this.reserveAmmo = WEAPON_CONFIG.reserveAmmo;
    this.bus.emit('weapon:ammoChanged', { mag: this.magAmmo, reserve: this.reserveAmmo });
  }

  dispose(): void {
    this.parts.root.removeFromParent();
    this.parts.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
