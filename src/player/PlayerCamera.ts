import * as THREE from 'three';
import { PLAYER_CONFIG } from '@/config/gameplay';
import { clamp, damp, fbm1, lerp } from '@/core/MathUtils';
import type { MutableVisual } from '@/config/visual';

/**
 * The view: look angles, recoil, shake, bob and FOV.
 *
 * MOTION SICKNESS POLICY - this is a design constraint, not a preference:
 *  - shake only ever displaces the camera POSITION and rolls it slightly; it
 *    never yaws or pitches the aim, so the crosshair stays where the player
 *    put it;
 *  - shake amplitude is clamped hard and decays quadratically, so a chain of
 *    explosions cannot stack into a seizure;
 *  - bob is ~1cm at a walk and is fully suppressed while aiming;
 *  - recoil is applied to the aim (it must be, or shooting has no cost) but is
 *    smoothed and auto-recovers to the pre-fire angle, so it reads as weapon
 *    climb rather than as the world being yanked.
 */
export class PlayerCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly weaponCamera: THREE.PerspectiveCamera;

  /** Aim angles the player controls directly. */
  yaw = 0;
  pitch = 0;

  /** Recoil offset added on top of the aim, and the part already recovered. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilTargetPitch = 0;
  private recoilTargetYaw = 0;

  private shakeTrauma = 0;
  private shakeFrequency = 22;
  private shakeSeed = Math.random() * 1000;

  private bobPhase = 0;
  private bobAmount = 0;
  private landDip = 0;
  private landDipVelocity = 0;

  private currentFov: number;
  private adsBlend = 0;
  private sprintBlend = 0;

  /** Screen-space motion vector handed to the post stack for motion blur. */
  readonly motion = new THREE.Vector2();
  private previousYaw = 0;
  private previousPitch = 0;

  private readonly basePosition = new THREE.Vector3();
  private readonly shakeOffset = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  /** Multiplier from the debug panel; 0 disables camera shake entirely. */
  shakeScale = 1;

  /**
   * Additive offsets owned by the intro sequence.
   * They are applied at compose time and never written back into `yaw`/`pitch`,
   * so when the intro blends out the player's own aim is exactly where they
   * left it - accumulating into the aim angles makes the view drift.
   */
  introYawOffset = 0;
  introPitchOffset = 0;
  private aspect = 1;

  constructor(private readonly visual: MutableVisual) {
    const c = visual.camera;
    this.currentFov = c.fovBase;
    this.camera = new THREE.PerspectiveCamera(c.fovBase, 1, c.near, c.far);
    this.camera.name = 'PlayerCamera';
    this.weaponCamera = new THREE.PerspectiveCamera(c.weaponFov, 1, c.near, c.far);
    this.weaponCamera.name = 'WeaponCamera';
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.weaponCamera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.aspect = aspect;
    this.applyWeaponFov();
  }

  /**
   * The view-model camera is locked to a HORIZONTAL field of view.
   *
   * three's `fov` is vertical, so a vertical-locked view-model camera changes
   * its horizontal coverage with the window shape - and the view-model is
   * placed off to one side, close to the eye, which is exactly where that
   * matters most. At a tall window the rifle falls outside the frustum and
   * only a sliver shows; at a wide one the same rifle fans right across the
   * frame. Locking the horizontal angle makes the weapon occupy the same
   * fraction of the screen width at every aspect, which is the only way the
   * placement constants below can mean anything.
   *
   * `weaponFov` / `weaponFovAds` are therefore HORIZONTAL degrees.
   */
  private applyWeaponFov(): void {
    const c = this.visual.camera;
    const horizontal = lerp(c.weaponFov, c.weaponFovAds, this.adsBlend);
    const halfH = THREE.MathUtils.degToRad(horizontal) * 0.5;
    const vertical = 2 * Math.atan(Math.tan(halfH) / Math.max(this.aspect, 0.2));
    // Cap it so a very tall window cannot produce a fisheye view-model.
    this.weaponCamera.fov = Math.min(THREE.MathUtils.radToDeg(vertical), 76);
    this.weaponCamera.updateProjectionMatrix();
  }

  /** Mouse look. Deltas are raw pixels; sensitivity is applied here. */
  applyLook(deltaX: number, deltaY: number, ads: boolean): void {
    const sensitivity =
      PLAYER_CONFIG.mouseSensitivity * (ads ? PLAYER_CONFIG.adsSensitivityScale : 1);
    this.yaw -= deltaX * sensitivity;
    this.pitch -= deltaY * sensitivity;
    this.pitch = clamp(this.pitch, -PLAYER_CONFIG.pitchLimit, PLAYER_CONFIG.pitchLimit);
  }

  /**
   * Weapon recoil kick. Vertical climb plus horizontal drift.
   * The kick is added to a target which is then chased, so a fast fire rate
   * produces a smooth climb rather than a per-shot teleport.
   */
  addRecoil(pitchAmount: number, yawAmount: number): void {
    this.recoilTargetPitch += pitchAmount;
    this.recoilTargetYaw += yawAmount;
  }

  /**
   * Trauma-based shake. `amplitude` is in metres of camera displacement;
   * anything above ~0.09 starts to feel like a hit to the head.
   */
  addShake(amplitude: number, frequency = 22): void {
    this.shakeTrauma = Math.min(1, this.shakeTrauma + amplitude);
    this.shakeFrequency = frequency;
  }

  /** Landing impact - a downward dip proportional to fall speed. */
  addLandingImpact(fallSpeed: number): void {
    const dip = Math.min(PLAYER_CONFIG.landDipMax, fallSpeed * PLAYER_CONFIG.landDipScale);
    this.landDipVelocity -= dip * 9;
  }

  /** Damage from a direction rolls the view slightly away from the hit. */
  addDamageKick(fromDirection: THREE.Vector3, amount: number): void {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const side = right.dot(fromDirection);
    this.recoilTargetPitch += amount * 0.6;
    this.recoilTargetYaw += side * amount;
    this.addShake(amount * 1.4, 26);
  }

  update(
    dt: number,
    elapsed: number,
    eyePosition: THREE.Vector3,
    speed: number,
    grounded: boolean,
    ads: boolean,
    sprinting: boolean,
  ): void {
    // --- recoil: chase the target, then bleed the target back to zero ---
    const recovery = 1 - Math.exp(-PLAYER_CONFIG.mouseSensitivity * 0 - 26 * dt);
    this.recoilPitch += (this.recoilTargetPitch - this.recoilPitch) * recovery;
    this.recoilYaw += (this.recoilTargetYaw - this.recoilYaw) * recovery;
    const decay = Math.exp(-8.6 * dt);
    this.recoilTargetPitch *= decay;
    this.recoilTargetYaw *= decay;

    // --- shake: quadratic decay, position + roll only ---
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.55);
    const trauma = this.shakeTrauma * this.shakeTrauma * this.shakeScale;
    const t = elapsed * this.shakeFrequency + this.shakeSeed;
    this.shakeOffset.set(
      fbm1(t, 2) * trauma * 0.085,
      fbm1(t + 37.1, 2) * trauma * 0.075,
      fbm1(t + 91.7, 2) * trauma * 0.05,
    );
    const shakeRoll = fbm1(t + 55.3, 2) * trauma * 0.045;

    // --- walk bob ---
    const targetBob = grounded && speed > 0.4 && !ads ? clamp(speed / PLAYER_CONFIG.speedSprint, 0, 1) : 0;
    this.bobAmount = damp(this.bobAmount, targetBob, 8, dt);
    if (grounded) this.bobPhase += dt * (7.4 + speed * 0.55);
    const bobY = Math.sin(this.bobPhase * 2) * 0.021 * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * 0.017 * this.bobAmount;
    const bobRoll = Math.sin(this.bobPhase) * 0.0105 * this.bobAmount;

    // --- landing dip (critically damped spring) ---
    this.landDipVelocity += (-46 * this.landDip - 9.2 * this.landDipVelocity) * dt;
    this.landDip += this.landDipVelocity * dt;

    // --- FOV ---
    this.adsBlend = damp(this.adsBlend, ads ? 1 : 0, 14, dt);
    this.sprintBlend = damp(this.sprintBlend, sprinting && !ads ? 1 : 0, 6, dt);
    const c = this.visual.camera;
    const targetFov =
      lerp(c.fovBase + c.fovSprintAdd * this.sprintBlend, c.fovAds, this.adsBlend);
    this.currentFov = damp(this.currentFov, targetFov, 16, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
    // Independently of the world camera: the ADS blend drives the view-model
    // FOV even when the world FOV has settled.
    this.applyWeaponFov();

    // --- compose the transform ---
    const finalYaw = this.yaw + this.recoilYaw + this.introYawOffset;
    const finalPitch = clamp(
      this.pitch + this.recoilPitch + this.introPitchOffset,
      -PLAYER_CONFIG.pitchLimit,
      PLAYER_CONFIG.pitchLimit,
    );
    this.euler.set(finalPitch, finalYaw, shakeRoll + bobRoll);

    this.basePosition.copy(eyePosition);
    this.basePosition.y += bobY + this.landDip;
    // Bob sideways in the camera's own right vector so it feels like a stride.
    const right = new THREE.Vector3(Math.cos(finalYaw), 0, -Math.sin(finalYaw));
    this.basePosition.addScaledVector(right, bobX);
    this.basePosition.add(this.shakeOffset);

    this.camera.position.copy(this.basePosition);
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.updateMatrixWorld();

    this.weaponCamera.position.copy(this.basePosition);
    this.weaponCamera.quaternion.copy(this.camera.quaternion);
    this.weaponCamera.updateMatrixWorld();

    // --- motion vector for the post stack ---
    // Angular velocity in radians/sec mapped to a screen-space direction.
    const dYaw = (finalYaw - this.previousYaw) / Math.max(dt, 0.0001);
    const dPitch = (finalPitch - this.previousPitch) / Math.max(dt, 0.0001);
    this.previousYaw = finalYaw;
    this.previousPitch = finalPitch;
    const magnitude = Math.min(1, Math.hypot(dYaw, dPitch) * 0.11);
    this.motion.set(dYaw, -dPitch);
    if (this.motion.lengthSq() > 1e-8) this.motion.normalize();
    this.motionStrength = magnitude * magnitude;
  }

  motionStrength = 0;

  /** Forward direction of the aim, used for hitscan and interaction probes. */
  getAimDirection(target: THREE.Vector3): THREE.Vector3 {
    return target.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
  }

  get adsAmount(): number {
    return this.adsBlend;
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilPitch = this.recoilYaw = this.recoilTargetPitch = this.recoilTargetYaw = 0;
    this.shakeTrauma = 0;
    this.landDip = this.landDipVelocity = 0;
    this.bobPhase = 0;
    this.previousYaw = yaw;
    this.previousPitch = 0;
  }
}
