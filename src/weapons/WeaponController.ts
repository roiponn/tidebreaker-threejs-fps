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

/**
 * View-model placement.
 *
 * The rifle's local origin is at the pistol grip; the stock extends +0.30
 * behind it and the muzzle reaches -0.44 in front.
 *
 * THE FORWARD OFFSET IS THE LOAD-BEARING NUMBER. These offsets are read by the
 * eye as ANGLES, and the angle to a point 13cm to the right depends entirely
 * on how far forward it is. At the original z of -0.115 the grip sat 49° off
 * the view axis while the muzzle sat at 13° - so the rifle fanned diagonally
 * across the frame instead of pointing into it, and how much of that fan was
 * visible depended on the window shape. It only ever looked acceptable in a
 * tall window, which cropped the near end away entirely.
 *
 * Distance also sets apparent SIZE, and the two have to be solved together:
 * scaling x and y with z holds the weapon at the same screen angles while
 * moving it further away, which is the only knob that shrinks its footprint
 * without moving it. The rifle is 0.29m tall; at the original 0.12m it
 * subtended more than the whole frame height, which is the other half of why
 * it looked like a slab rather than a weapon.
 *
 * At z = -0.50 the grip sits ~16° off axis and ~18° low. The lateral offset
 * was 0.196, which put the sight 40-46% of the way to the right edge - and
 * because the view-model camera is locked to a VERTICAL fov, that fraction
 * grows as the window narrows, so on a 4:3-ish window the weapon fanned out
 * past the edge. Measured with tools/framingProbe.ts rather than guessed:
 * 0.146 puts the sight at 0.26-0.34 NDC across every window shape from 4:3 to
 * ultrawide, which reads as "held at the hip" without crowding the frame.
 *
 * These are screen-composition numbers, not anatomical ones: a view-model is
 * posed for the camera, not for a shoulder.
 */
const HIP_POSITION = new THREE.Vector3(0.146, -0.163, -0.500);
/**
 * Yaw swings the stock toward +X and the muzzle toward the centre, which is
 * how the butt is kept out of frame now that it is no longer hidden behind the
 * near plane. Pitch drops it out of the bottom for the same reason.
 */
const HIP_ROTATION = new THREE.Euler(0.052, 0.150, 0.026);
/**
 * Aligns the optic's sight point (0, 0.100, -0.052) with the screen centre.
 * y must stay at -0.100 for that to hold.
 *
 * z is NOT free. The stock extends +0.302 behind the grip, so any z greater
 * than -0.302 puts the butt pad in front of the eye - and at ADS the weapon is
 * centred, so a visible butt pad is a slab across the bottom half of the
 * screen rather than something tucked into a corner. At -0.16 the butt sits
 * 14cm behind the camera and is clipped away, which is where a shouldered
 * stock belongs.
 */
const ADS_POSITION = new THREE.Vector3(0, -0.1005, -0.16);
const ADS_ROTATION = new THREE.Euler(0, 0, 0);
/**
 * Sprint and wall-retract are POSE OFFSETS, not poses of their own.
 *
 * They used to yaw the weapon 38 deg and 50 deg respectively. In a container
 * canyon the wall probe is partially engaged almost continuously - every time
 * the player looks at a wall, at the deck while walking, or at an enemy within
 * the probe distance - so the rifle was being swung through most of a right
 * angle and back as a matter of course. That reads as the weapon spinning,
 * not as weapon handling.
 *
 * Both are now small: enough to say "the weapon is lowered" without the barrel
 * ever leaving the corner of the screen it lives in.
 */
const SPRINT_POSITION = new THREE.Vector3(0.235, -0.250, -0.480);
const SPRINT_ROTATION = new THREE.Euler(0.135, 0.255, -0.115);
/**
 * Hard bounds on how far the additive layers may take the view-model from its
 * pose: 3.4 degrees and 2.2cm per axis. Deliberately tight. The weapon lives
 * 50cm from the eye, so this is still clearly visible motion - it just cannot
 * become a swing.
 */
const VIEWMODEL_ROT_LIMIT = 0.060;
const VIEWMODEL_POS_LIMIT = 0.022;

const RETRACT_POSITION = new THREE.Vector3(0.145, -0.214, -0.430);
const RETRACT_ROTATION = new THREE.Euler(0.075, 0.235, 0.055);

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
  /** A pulled trigger waiting for the sight to finish coming up. */
  private shotArmed = false;
  /** Seconds the sight stays up after the trigger is released. */
  private adsHold = 0;
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

  /**
   * FORCED ADS.
   *
   * This weapon has no hip fire. Pulling the trigger does not fire a round; it
   * *commits to a shot*, which means raising the sight, waiting for it to
   * settle on the screen centre, and only then releasing the round. Everything
   * downstream depends on that: the boss fight's weak points are designed to be
   * scoped, and a hip-fire escape hatch would quietly remove the reason the
   * sight exists.
   *
   * The latch is what makes a single click work. A tap is shorter than the ADS
   * transition, so without it the input would be gone by the time the sight
   * arrived and the shot would be silently dropped - which reads as the game
   * ignoring you. A tap therefore ARMS one shot, held until the sight is up.
   */
  setTrigger(held: boolean, pressedThisFrame = false): void {
    // Arm on the PRESS EVENT, not on the polled held-state.
    //
    // A click that begins and ends between two frames never appears in the
    // polled state at all, so a fast tap - or any tap at all during a frame
    // spike - was silently swallowed. The brief is explicit that a short click
    // must not lose the input, and the edge is the only signal that survives.
    if (pressedThisFrame || (held && !this.triggerHeld)) this.shotArmed = true;
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
    // ?weaponpose=ads must drive the real blend, not just the pose: the FOV,
    // the reticle brightness and the sway suppression all key off adsBlend, so
    // pinning only the pose would show a pose nobody ever sees.
    // The sight comes up for the trigger as well as for the aim button, and
    // drops as soon as the trigger is released - the hold is only long enough
    // to cover an armed shot still waiting for the sight. Sprinting and
    // reloading lower it too - but
    // they also block firing entirely (see updateFiring), so there is no path
    // by which a round leaves the barrel from the hip.
    if (this.triggerHeld || this.shotArmed) {
      this.adsHold = WEAPON_CONFIG.adsHoldAfterFire;
    } else if (this.adsHold > 0) {
      this.adsHold = Math.max(0, this.adsHold - dt);
    }
    const forcedAds = this.triggerHeld || this.shotArmed || this.adsHold > 0;
    // An armed shot that can never be taken has to be dropped, or the weapon
    // stays raised forever after a trigger pull that began during a sprint.
    if (this.shotArmed && !canAds) this.shotArmed = false;
    const adsTarget = (wantsAds || forcedAds || this.debugPose === 'ads') && canAds ? 1 : 0;
    const previousAds = this.adsBlend > 0.5;
    // ADS uses a fixed-time approach rather than a damp so the transition
    // duration is exactly WEAPON_CONFIG.adsTime and can be tuned to the audio.
    // ASYMMETRIC, AND IT MUST SETTLE EXACTLY ON THE TARGET.
    //
    // This line used to step by a signed rate chosen with a strict inequality:
    //
    //     rate = (adsTarget > adsBlend) ? +rise : -fall
    //
    // At equality - which is where it lands the instant the sight is fully up -
    // that test is FALSE, so it applied the falling rate and walked back off
    // the target. Next frame it was below, so it climbed to 1 again, and fell
    // again. The blend chattered around 1.0 for as long as the trigger was
    // held, and since the blend interpolates the whole hip-to-ADS pose, a 4%
    // chatter is over a centimetre of weapon movement at ~10Hz. That is the
    // scope shake, and it is why every amplitude I tuned made no difference:
    // the oscillation was in the blend parameter, not in any of the layers
    // being blended.
    //
    // Clamping toward the target instead of stepping past it cannot oscillate.
    if (adsTarget > this.adsBlend) {
      this.adsBlend = Math.min(adsTarget, this.adsBlend + dt / WEAPON_CONFIG.adsTime);
    } else if (adsTarget < this.adsBlend) {
      this.adsBlend = Math.max(adsTarget, this.adsBlend - dt / WEAPON_CONFIG.adsLowerTime);
    }
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
    this.composePose(dt);
  }

  private updateFiring(dt: number, sprinting: boolean, moveSpeed: number, crouched: boolean): void {
    this.fireTimer -= dt;

    // The sight must be fully up. Not "mostly" - a partial sight picture that
    // still fires is hip fire with extra steps.
    const sightReady = this.adsBlend >= 0.999;
    const wantsShot = this.triggerHeld || this.shotArmed;
    const canFire =
      wantsShot &&
      sightReady &&
      this.state !== 'reloading' &&
      !sprinting &&
      this.fireTimer <= 0;

    if (canFire) {
      if (this.magAmmo > 0) {
        this.fire(moveSpeed, crouched);
        // The armed shot is spent. Holding the trigger re-arms nothing - the
        // `triggerHeld` branch keeps automatic fire going on its own.
        this.shotArmed = false;
        this.adsHold = WEAPON_CONFIG.adsHoldAfterFire;
        this.fireTimer = 60 / WEAPON_CONFIG.rpm;
      } else {
        // Spend the armed shot on the dry fire too. Without this an empty
        // trigger pull with no reserve left `shotArmed` set forever, which
        // holds forcedAds true and welds the weapon into the aimed pose with
        // no way out - the sight simply never comes down again.
        this.shotArmed = false;
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
    // Recoil damping while scoped.
    //
    // Was 0.72 - a 28% reduction, which is nothing. A scoped shot still threw
    // the view up by more than half a degree, and with the burst ramp on top
    // that reaches a degree. The eye reads a sight picture that jumps and
    // returns, once per trigger pull, as the scope shaking - because from the
    // player's side that is exactly what it is.
    //
    // Recoil is not removed: the weapon still climbs, which is what makes
    // sustained fire cost something. It is damped hard enough that the sight
    // stays ON the target between shots instead of bouncing off it.
    const adsDamp = lerp(1, 0.32, this.adsBlend);
    const kick = ramp * adsDamp * this.recoilScale;
    this.view.addRecoil(
      WEAPON_CONFIG.recoilVertical * kick,
      (Math.random() * 2 - 1) * WEAPON_CONFIG.recoilHorizontal * kick,
    );
    // Camera shake on firing is deliberately tiny - the weapon model moving is
    // what sells the shot; shaking the world just hurts the player's aim.
    //
    // And while scoped it is removed entirely. Shake is random noise applied
    // to the camera; through a sight that is aligned with the screen centre it
    // has no reading other than "the scope is vibrating". Scaled by
    // (1 - adsBlend) rather than by adsDamp so it genuinely reaches zero.
    this.view.addShake(0.028 * (1 - this.adsBlend), 34);

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
    // The magazine falls DOWN AND AWAY from the camera. Dropping it straight
    // down sweeps a 20cm object across the lens at 15cm, which fills a third of
    // the screen with a blurry slab - the single ugliest frame in the reload.
    this.parts.magazine.position.y = -0.068 - magDrop * 0.16;
    this.parts.magazine.position.z = -0.035 - magDrop * 0.14;
    this.parts.magazine.rotation.x = magDrop * 0.35;
    // Hidden earlier and for longer, so the "empty mag falls away" beat is
    // implied rather than shown in extreme close-up.
    this.parts.magazine.visible = !(t > 0.2 && t < 0.62);

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
    // Tilt the weapon toward the off-hand and slightly away from the camera.
    // Kept modest: a big swing looks dramatic in isolation but obscures the
    // whole screen during a 2.4-second animation the player must fight through.
    const swing = Math.sin(t * Math.PI);
    this.reloadPos.set(-0.015 * swing, -0.035 * swing, -0.02 * swing);
    this.reloadRot.set(0.06 * swing, 0.08 * swing, -0.09 * swing);

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
    // Sway is GENERATED at a reduced amplitude while aiming, and then damped
    // again on the way into the pose (see composePose). Two stages rather than
    // one because sway must not vanish entirely - a weapon that is welded to
    // the screen centre feels weightless - but the residual has to be small
    // enough that the sight stays ON the centre.
    const scale = lerp(1, 0.20, this.adsBlend);
    const targetX = clamp(-lookDeltaX * 0.0016, -1, 1) * WEAPON_CONFIG.swayPosition * scale * 12;
    const targetY = clamp(lookDeltaY * 0.0016, -1, 1) * WEAPON_CONFIG.swayPosition * scale * 12;
    const rate = WEAPON_CONFIG.swaySmoothing;
    this.swayPos.x = damp(this.swayPos.x, targetX, rate, dt);
    this.swayPos.y = damp(this.swayPos.y, targetY, rate, dt);
    // Rotational sway is halved relative to positional: a rifle that yaws with
    // every mouse movement reads as loose in the hands rather than heavy. Peak
    // excursion here is about 3 deg.
    this.swayRot.y = damp(this.swayRot.y, targetX * WEAPON_CONFIG.swayRotation * 11, rate, dt);
    this.swayRot.x = damp(this.swayRot.x, -targetY * WEAPON_CONFIG.swayRotation * 11, rate, dt);
    this.swayRot.z = damp(this.swayRot.z, targetX * WEAPON_CONFIG.swayRotation * 7, rate * 0.8, dt);
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
  /**
   * Recoil springs, SUB-STEPPED at a fixed rate.
   *
   * These are integrated with explicit Euler, and the frame dt is clamped at
   * 0.05 - so on a machine running at 20fps a single shot moved the weapon far
   * enough in one step to hit the additive clamp, and the spring rang instead
   * of settling. The same shot on a 120fps machine produced a smooth push.
   * That frame-rate dependence is the reason tuning the amplitudes never
   * helped: the amplitudes were never the problem, the step size was.
   *
   * Fixed 1/120s sub-steps make the result identical at any frame rate, and
   * make the spring stable at the largest dt the clock will ever hand us.
   */
  private updateRecoilSpring(dt: number): void {
    const STEP = 1 / 120;
    let remaining = dt;
    // Bounded so a long stall cannot turn into an unbounded loop.
    for (let i = 0; i < 12 && remaining > 1e-5; i++) {
      const h = Math.min(STEP, remaining);
      remaining -= h;
      this.stepRecoilSpring(h);
    }
  }

  private stepRecoilSpring(dt: number): void {
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
    // Bright enough to read as an illuminated dot rather than a red smudge.
    // The tiny pulse is there because a holographic sight is not a perfectly
    // steady light source.
    this.parts.reticleMaterial.emissiveIntensity = 3.6 + Math.sin(elapsed * 9) * 0.2;
    // The optic glass is only worth drawing when the player is behind it.
    // Visible from the hip too - it is a projected dot on glass, not something
    // that switches on when shouldered - but strongest when actually aiming.
    this.parts.reticleMaterial.opacity = lerp(0.7, 1, this.adsBlend);
  }

  /**
   * Debug only (?weaponpose=). Pins one pose blend to 1 so its extreme can be
   * captured. The poses that swing the weapon furthest are exactly the ones
   * that only occur transiently in play, which is why they went unchecked.
   */
  debugPose: 'hip' | 'ads' | 'sprint' | 'retract' | null = null;

  /** ?weapontrace=1 - mirrors every rotation layer onto document.body. */
  debugTrace = false;
  private readonly traceRing: string[] = [];

  /** Sums every animation layer into the final transform. */
  private composePose(dtSeconds = 0): void {
    let ads = this.adsBlend;
    let sprint = this.sprintBlend;
    let retract = this.retractBlend;
    if (this.debugPose) {
      ads = this.debugPose === 'ads' ? 1 : 0;
      sprint = this.debugPose === 'sprint' ? 1 : 0;
      retract = this.debugPose === 'retract' ? 1 : 0;
    }

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
    //
    // Every additive layer is BOUNDED before it is applied. Individually each
    // one is modest, but they sum - sway plus recoil plus the reload swing can
    // put the weapon a long way from its pose, and on an object this close to
    // the eye a few centimetres of translation changes the projected angle of
    // the barrel far more than the same number of degrees of rotation does.
    // That is what reads as the weapon "rotating". Clamping the SUM makes the
    // deviation a guarantee rather than something that depends on the tuning
    // of four independent systems never peaking together.
    // ADS SUPPRESSION.
    //
    // This was 0.35, which let a third of the hip-fire sway and bob survive
    // into the aimed pose. On an iron sight that is aligned with the screen
    // centre, positional sway of the weapon IS movement of the sight across
    // the target - so the scope visibly wandered whenever the player moved the
    // mouse or walked. Forced ADS made it far worse by keeping the sight up
    // continuously instead of for the occasional aimed shot.
    //
    // Combined with the reduced generation in updateSway, the residual at full
    // ADS is about 2% of the hip-fire amplitude: enough that the weapon is not
    // rigidly nailed to the crosshair, small enough that the sight holds.
    const additiveScale = lerp(1, 0.10, ads);

    // WEAPON-MODEL RECOIL IS SUPPRESSED IN ADS.
    //
    // I previously excluded recoil from this suppression on the grounds that
    // it is "meant to move the sight". That was backwards, and it is the whole
    // reason the scope still shook after three attempts at the surrounding
    // systems.
    //
    // When the sight is aligned with the screen centre, ANY movement of the
    // weapon model is movement of the sight across the target - which is the
    // one thing a scoped weapon must not do. Look at how this reads in a
    // shipped shooter: the sight is welded to the centre of the screen and the
    // recoil is expressed by the WORLD climbing, not by the reticle wandering.
    // The camera recoil already does that job here, and it is untouched.
    //
    // A small residual is kept so the weapon is not a rigid decal; the visible
    // kick at the muzzle end and the shell ejection carry the impact instead.
    const recoilScaleAds = lerp(1, 0.30, ads);
    const clampPos = (v: number): number => clamp(v, -VIEWMODEL_POS_LIMIT, VIEWMODEL_POS_LIMIT);
    const clampRot = (v: number): number => clamp(v, -VIEWMODEL_ROT_LIMIT, VIEWMODEL_ROT_LIMIT);

    this.tmpPos.x += clampPos((this.swayPos.x + this.bobPos.x) * additiveScale + this.reloadPos.x);
    this.tmpPos.y += clampPos(
      (this.swayPos.y + this.bobPos.y) * additiveScale +
        this.reloadPos.y +
        this.recoilPos.y * recoilScaleAds,
    );
    this.tmpPos.z += clampPos(this.recoilPos.z * recoilScaleAds + this.reloadPos.z);

    this.parts.root.position.copy(this.tmpPos);
    this.tmpRot.x += clampRot(
      this.swayRot.x * additiveScale + this.recoilRot.x * recoilScaleAds + this.reloadRot.x,
    );
    this.tmpRot.y += clampRot(this.swayRot.y * additiveScale + this.reloadRot.y);
    this.tmpRot.z += clampRot(
      this.swayRot.z * additiveScale + this.recoilRot.z * recoilScaleAds + this.reloadRot.z,
    );
    this.tmpQuat.setFromEuler(this.tmpRot);
    this.parts.root.quaternion.copy(this.tmpQuat);

    // Diagnostic: which layer is moving the weapon, in degrees. Written only
    // when explicitly asked for, so it costs nothing in a normal session.
    // Per-frame ring buffer. The scope-shake investigation needs to know what
    // the numbers ACTUALLY do frame to frame, and a single-value data attribute
    // only ever shows the last frame - which is how three wrong diagnoses got
    // made from still images instead of from the signal.
    if (this.debugTrace) {
      const v = this.view;
      this.traceRing.push(
        `${this.adsBlend.toFixed(3)},${v.adsAmount.toFixed(3)},` +
          `${v.debugPitch.toFixed(4)},${v.debugRecoilPitch.toFixed(4)},` +
          `${v.debugShake.toFixed(3)},${this.tmpPos.x.toFixed(3)},${dtSeconds.toFixed(4)}`,
      );
      if (this.traceRing.length > 240) this.traceRing.shift();
      document.body.dataset.adsring = this.traceRing.join(' ');
    }
    if (this.debugTrace) {
      const d = (r: number): string => (r * 57.2958).toFixed(1);
      const wc = this.view.weaponCamera;
      document.body.dataset.weapon =
        `cam fov ${wc.fov.toFixed(1)} asp ${wc.aspect.toFixed(3)}` +
        ` | pos ${this.tmpPos.x.toFixed(3)},${this.tmpPos.y.toFixed(3)},${this.tmpPos.z.toFixed(3)}` +
        ` | rot ${d(this.tmpRot.x)},${d(this.tmpRot.y)},${d(this.tmpRot.z)}` +
        ` | ads ${this.adsBlend.toFixed(3)} camAds ${this.view.adsAmount.toFixed(3)} sprint ${this.sprintBlend.toFixed(2)}` +
        ` retract ${this.retractBlend.toFixed(2)}` +
        ` | sway ${d(this.swayRot.x)},${d(this.swayRot.y)},${d(this.swayRot.z)}` +
        ` | recoil ${d(this.recoilRot.x)},${d(this.recoilRot.y)},${d(this.recoilRot.z)}` +
        ` | reload ${d(this.reloadRot.x)},${d(this.reloadRot.y)},${d(this.reloadRot.z)}`;
    }
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
