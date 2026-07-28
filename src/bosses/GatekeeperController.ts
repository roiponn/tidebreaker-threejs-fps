import * as THREE from 'three';
import { MISSION_V2 } from '@/config/mission';
import type { EventBus } from '@/core/EventBus';
import { clamp, clamp01, damp, lerp, smoothstep } from '@/core/MathUtils';
import { Rng } from '@/core/Rng';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import { buildGatekeeper, type GatekeeperPose, type GatekeeperRig } from './Gatekeeper';

/**
 * GATEKEEPER - the fight.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A mid-boss must not be an ordinary enemy with a bigger number. `health: 900`
 * against a 26-damage rifle is 35 body shots, which on its own is nine seconds
 * of holding the trigger at a stationary target - that is not a boss, it is a
 * chore. So the health value is deliberately NOT the difficulty. The
 * difficulty is a gate on WHEN those 35 shots are allowed to count:
 *
 *   BARRAGE  (barrageTime = 6.5s)  shield locked forward, frontal damage
 *                                  multiplied by shieldedDamageScale = 0.06.
 *                                  Shooting the face is not a slow answer, it
 *                                  is not an answer.
 *   VENT     (ventTime = 3.4s)     shield thrown open, coil exposed, damage
 *                                  lands at 1.0. Roughly 40 rounds fit in the
 *                                  window - more than a magazine, less than
 *                                  the whole health bar.
 *
 * So a clean kill is TWO vent windows plus the reload between them, and a
 * scrappy one is four. That range is the encounter. Nothing about it changes
 * if `health` is retuned by ±30%, which is exactly the property a readable
 * boss needs.
 *
 * WHY HULL DAMAGE IS 0.15 AND NOT 0
 *
 * Zero would be honest but it punishes the player for shooting at the right
 * moment in the wrong place, and it makes flanking pointless. 0.15 means a
 * flank shot does something - but do the arithmetic: 900 / (26 x 0.15) = 231
 * rounds, and the player carries 210 in total. The AMMO ECONOMY, not a rule,
 * makes grinding the hull impossible. There is no invisible immunity to be
 * frustrated by; the player who tries it simply runs dry and works it out.
 *
 * What hull damage DOES do is add heat, which brings the vent forward by up to
 * 45%. Flanking is therefore rewarded with tempo rather than with damage,
 * which is the reward that actually makes the fight shorter.
 *
 * THE TELL
 *
 * The vent has to be unmissable from anywhere in the yard, in rain, at night,
 * with muzzle flash in the player's eyes. Four simultaneous signals, on
 * purpose, because any one of them can be lost to a bad angle:
 *   1. the shield physically parts - a silhouette change, readable at any
 *      distance and immune to lighting;
 *   2. the coil emissive goes from 0.2 to 14 - a 70x swing, so bloom blooms;
 *   3. the beacons shift amber -> cyan, and the sensor eye drops to near-dark,
 *      inverting the unit's whole colour signature for the duration;
 *   4. a steam plume grows out of the vent.
 * Plus `gatekeeper:vent` on the bus for audio and for the handler's radio line
 * ("It is venting. Coil is open, take it.").
 */

type GatekeeperState = 'dormant' | 'waking' | 'barrage' | 'venting' | 'sealing' | 'dying' | 'dead';

/** Where a round landed. Drives the damage scale AND the hit feedback. */
export type GatekeeperZone = 'shield' | 'hull' | 'coil';

export interface GatekeeperHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  zone: GatekeeperZone;
}

const GK = MISSION_V2.gatekeeper;

/**
 * Tuning that belongs to the FIGHT rather than to the mission, and so is not
 * in mission.ts. The rule used to decide: if an editor retuning pacing would
 * plausibly want to touch it, it lives in mission.ts; if changing it would
 * break the encounter's logic, it lives here with the reasoning next to it.
 */
const TUNING = {
  /** Sides, rear and top, at any time. See the ammo-economy note above. */
  hullDamageScale: 0.15,
  /** The coil during a vent. Full damage - the reward has to be undiluted. */
  coilDamageScale: 1.0,

  /** Seconds the shield takes to swing open or shut. Long enough to be an
   *  event the player can react to, short enough not to eat the window. */
  shieldOpenTime: 0.55,
  /** The one-off "it has noticed you" beat, before any shooting happens. */
  wakeTime: 1.25,
  /** Slump. The module comes off partway through, at moduleDropAt. */
  deathTime: 2.4,
  moduleDropAt: 0.55,

  /** Heat added per point of RAW hull damage, and the cap on that
   *  contribution per cycle. A full magazine into the flank buys ~45% of a
   *  barrage; it cannot buy the whole thing, or the vent stops being a rhythm
   *  and becomes a button. */
  heatPerHullDamage: 0.0011,
  heatFromDamageCap: 0.45,

  /** Standoff. It closes to this and holds - a tracked chassis pinning the
   *  player against the dock is not a fight, it is a shove. */
  standoff: 11,
  tooClose: 7,
  advanceSpeed: 1.7,
  withdrawSpeed: 1.1,

  /** Turn rates, rad/s. The hull is much slower than the turret, and the
   *  turret is slower than the player can strafe. That gap IS the "work the
   *  sides" instruction the handler gives - it is a real, measurable window,
   *  not flavour text. */
  hullYawRate: 0.85,
  turretYawRate: 1.65,
  headYawRate: 5.0,

  /** Suppressive fire. Volume, not accuracy: this is pressure that pushes the
   *  player out of the open, and the damage is ENEMY_CONFIG.damage because
   *  Ballistics owns that - the boss only says "a round went that way". */
  burstCount: 5,
  fireInterval: 0.11,
  burstPause: 0.95,
  /** Firing cone. It will not shoot at a player it has not turned to face,
   *  which is what makes flanking feel like it worked. */
  fireArc: 0.55,

  /** Emissive extremes for the coil. The ratio is the tell, not the value. */
  coilIdle: 0.2,
  coilVent: 14,
} as const;

export class GatekeeperController {
  /** World-space container. Game.ts adds this to the scene; nothing else. */
  readonly group = new THREE.Group();

  private rig: GatekeeperRig | null = null;
  private state: GatekeeperState = 'dormant';
  private health = GK.health;

  /** Ground position of the chassis. The rig's root origin is at its feet. */
  private readonly position = new THREE.Vector3();
  private readonly spawnPosition = new THREE.Vector3();

  /** Pose written to the rig every frame. The rig owns no state of its own. */
  private pose: GatekeeperPose = {
    hullYaw: 0,
    turretYaw: 0,
    headYaw: 0,
    headPitch: 0,
    shieldDeploy: 0,
    shieldOpen: 0,
    armPitch: 0.35,
    armElbow: 0.9,
    hullPitch: 0,
    hullRoll: 0,
  };

  /** Aim direction, in the same yaw convention EnemyManager uses:
   *  atan2(dx, dz), so the rig's local +Z points at the player. */
  private aimYaw = 0;
  private stateTimer = 0;
  /** 0..1. Fills over barrageTime, and faster when the flanks are worked. */
  private heat = 0;
  private heatFromDamage = 0;
  /** Rises while engaged; drives the sensor eye amber -> red and the arm. */
  private aggression = 0;

  private fireTimer = 0;
  private burstRemaining = 0;

  private deathTimer = 0;
  private moduleDropped = false;
  /** Free-falling module after the drop, animated to rest on the deck. */
  private moduleFall = 0;
  private moduleSpin = 0;

  private readonly rng = new Rng(0x6a7e11);
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpLocal = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly amberColor = new THREE.Color(0xffb347);
  private readonly hostileColor = new THREE.Color(0xff3a20);
  private readonly ventColor = new THREE.Color(0x9fe8ff);

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly bus: EventBus,
    private readonly collision?: CollisionWorld,
  ) {
    this.group.name = 'Gatekeeper';
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Builds the rig and parks it. It does NOT wake here: waking is driven by
   * `engage` plus proximity in update(), so the mission director can place it
   * long before the player is meant to meet it and the player can walk into
   * the encounter rather than have it triggered at them.
   */
  spawn(position: THREE.Vector3): void {
    if (this.rig) this.dispose();
    this.rig = buildGatekeeper(this.mats);
    this.group.add(this.rig.root);

    this.position.copy(position);
    this.spawnPosition.copy(position);
    this.rig.root.position.copy(position);

    this.state = 'dormant';
    this.health = GK.health;
    this.heat = 0;
    this.heatFromDamage = 0;
    this.aggression = 0;
    this.stateTimer = 0;
    this.deathTimer = 0;
    this.moduleDropped = false;
    this.moduleFall = 0;

    // A four-tonne tracked chassis is not something the player walks through.
    // NOTE: CollisionWorld has no removeBox, so this blocker is permanent for
    // the level's lifetime. That is correct rather than a limitation - the
    // wreck stays where it fell and should keep blocking.
    this.collision?.addBox(
      this.tmpVec.set(position.x - 1.3, position.y, position.z - 1.6),
      this.tmpVec2.set(position.x + 1.3, position.y + 1.5, position.z + 1.6),
      'metal',
    );
  }

  get alive(): boolean {
    return this.rig !== null && this.state !== 'dying' && this.state !== 'dead';
  }

  /** True from the instant it starts to fall, so the mission flag trips once. */
  get defeated(): boolean {
    return this.state === 'dying' || this.state === 'dead';
  }

  get healthFraction(): number {
    return clamp01(this.health / GK.health);
  }

  /** True only during the window in which the coil can be hurt. */
  get venting(): boolean {
    return this.state === 'venting';
  }

  /** World position of the chassis, for radio cues and audio panning. */
  get worldPosition(): THREE.Vector3 {
    return this.position;
  }

  /** One-line readout for the debug overlay, matching EnemyManager.stateTrace. */
  get stateTrace(): string {
    return `${this.state} hp=${Math.max(0, Math.round(this.health))} heat=${this.heat.toFixed(2)}`;
  }

  // ------------------------------------------------------------------
  // Hitscan
  // ------------------------------------------------------------------

  /**
   * Ray vs. three spheres: shield, coil, hull. Same reasoning as the soldier
   * capsule test - mesh raycasting an articulated rig every shot is far more
   * expensive than the fidelity is worth at these ranges.
   *
   * The important part is that the spheres are HONEST about the shield. Its
   * effective radius shrinks as the leaves part, so a shot down the middle of
   * an open shield reaches the coil geometrically rather than by special case.
   * Nothing here can produce a hit the player could not have seen coming.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): GatekeeperHit | null {
    const rig = this.rig;
    if (!rig || this.state === 'dead') return null;

    let bestDistance = -1;
    let bestScore = Infinity;
    let bestZone: GatekeeperZone = 'hull';
    let bestCenter = this.tmpVec2;

    const consider = (center: THREE.Vector3, radius: number, zone: GatekeeperZone, bias: number): void => {
      const t = raySphere(origin, direction, center, radius, maxDistance);
      if (t < 0) return;
      const score = t - bias;
      if (score >= bestScore) return;
      bestScore = score;
      bestDistance = t;
      bestZone = zone;
      bestCenter = center.clone();
    };

    // Hull. Always present, always the fallback.
    consider(this.worldPoint(rig.hullOffset, HULL_WORLD), rig.hullRadius, 'hull', 0);

    // Shield, once deployed. Radius collapses with `shieldOpen`.
    if (this.pose.shieldDeploy > 0.35) {
      const shrink = 1 - 0.85 * this.pose.shieldOpen;
      consider(
        this.worldPoint(rig.shieldOffset, SHIELD_WORLD),
        rig.shieldRadius * shrink,
        'shield',
        // Small bias so a frontal shot resolves as shield rather than hull
        // where the two spheres overlap. The player must not accidentally get
        // hull rates by aiming at the plate.
        0.25,
      );
    }

    // Coil, only once the leaves are genuinely apart. The bias makes it win
    // ties against the hull sphere it sits inside, exactly as the soldier's
    // head beats his torso.
    if (this.pose.shieldOpen > 0.3) {
      consider(this.worldPoint(rig.coilOffset, COIL_WORLD), rig.coilRadius, 'coil', 0.6);
    }

    if (bestDistance < 0) return null;
    const point = new THREE.Vector3().copy(origin).addScaledVector(direction, bestDistance);
    const normal = new THREE.Vector3().subVectors(point, bestCenter).normalize();
    return { point, normal, distance: bestDistance, zone: bestZone };
  }

  /**
   * THE DAMAGE MODEL, in one place.
   *
   *   coil, shield open  amount x 1.00                     the whole fight
   *   shield, frontal    amount x lerp(0.06, 0.15, open)   near-immune closed
   *   hull, anywhere     amount x 0.15                     tempo, not damage
   *
   * Classification is done from the WORLD POINT rather than from a zone handed
   * in by the caller, so explosions, splash and any future damage source get
   * the same rules for free. Returns the damage actually applied, which the
   * caller can use to decide what kind of hitmarker to show.
   */
  damage(amount: number, worldPoint: THREE.Vector3): number {
    const rig = this.rig;
    if (!rig || !this.alive || amount <= 0) return 0;

    const zone = this.classify(worldPoint);
    let scale: number;
    if (zone === 'coil') {
      scale = TUNING.coilDamageScale;
    } else if (zone === 'shield') {
      // As the leaves part, the frontal arc stops being protected. One lerp
      // instead of a hard switch, so the transition frames are not a cliff the
      // player's timing can fall off.
      scale = lerp(GK.shieldedDamageScale, TUNING.hullDamageScale, this.pose.shieldOpen);
    } else {
      scale = TUNING.hullDamageScale;
    }

    const applied = amount * scale;
    this.health -= applied;

    // Hull hits stoke the reactor: flanking buys TEMPO. Capped per cycle so a
    // player with a full magazine cannot delete the barrage phase outright.
    if (zone === 'hull') {
      const room = Math.max(0, TUNING.heatFromDamageCap - this.heatFromDamage);
      const add = Math.min(room, amount * TUNING.heatPerHullDamage);
      this.heatFromDamage += add;
      this.heat += add;
    }

    // Being shot at all wakes it, wherever the player is standing.
    if (this.state === 'dormant') this.wake();

    this.bus.emit('gatekeeper:damaged', {
      point: worldPoint.clone(),
      zone,
      applied,
      // "Blocked" is the HUD's cue to show a deflect marker instead of a hit
      // marker. Teaching the shield through feedback beats teaching it through
      // a radio line the player may talk over.
      blocked: scale <= GK.shieldedDamageScale + 1e-4,
      healthFraction: this.healthFraction,
    });

    if (this.health <= 0) this.enterDying();
    return applied;
  }

  /** World point -> damage zone. Pure geometry, no state beyond the pose. */
  private classify(worldPoint: THREE.Vector3): GatekeeperZone {
    const rig = this.rig;
    if (!rig) return 'hull';

    // The coil, generously: a slightly oversized sphere so a shot that visibly
    // struck the glowing thing counts as having struck the glowing thing.
    if (this.pose.shieldOpen > 0.3) {
      const coilWorld = this.worldPoint(rig.coilOffset, COIL_WORLD);
      if (worldPoint.distanceToSquared(coilWorld) < (rig.coilRadius * 1.3) ** 2) return 'coil';
    }

    // Frontal arc, in the CHASSIS's own frame. Local +Z is the direction the
    // hull faces, so this is "did it land on the side the shield covers".
    this.tmpLocal.copy(worldPoint);
    rig.root.worldToLocal(this.tmpLocal);
    if (this.pose.shieldDeploy > 0.4 && this.tmpLocal.z > 0.3) return 'shield';
    return 'hull';
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  /**
   * @param engage  False during the intro sweep and before the player's first
   *                action, same contract as EnemyManager. A boss that starts
   *                shooting during a camera move is not difficulty.
   */
  update(dt: number, elapsed: number, playerEye: THREE.Vector3, engage: boolean): void {
    const rig = this.rig;
    if (!rig || this.state === 'dead') return;

    // --- aim ---
    this.tmpVec.subVectors(playerEye, this.position);
    const distance = this.tmpVec.length();
    this.aimYaw = Math.atan2(this.tmpVec.x, this.tmpVec.z);

    switch (this.state) {
      case 'dormant':
        this.updateDormant(dt, distance, engage);
        break;
      case 'waking':
        this.updateWaking(dt);
        break;
      case 'barrage':
        this.updateBarrage(dt, distance, playerEye);
        break;
      case 'venting':
        this.updateVenting(dt);
        break;
      case 'sealing':
        this.updateSealing(dt);
        break;
      case 'dying':
        this.updateDying(dt);
        break;
      default:
        break;
    }

    this.animate(dt, elapsed, playerEye);
    rig.apply(this.pose);
    rig.root.position.copy(this.position);
  }

  // --- states -------------------------------------------------------

  /**
   * Parked. Sensor sweeps a slow arc and the beacons idle - it is obviously
   * powered, obviously not yet interested. That contrast is what makes the
   * wake beat land; a boss that is already hostile when discovered has no
   * moment of being noticed by.
   */
  private updateDormant(dt: number, distance: number, engage: boolean): void {
    this.pose.shieldDeploy = damp(this.pose.shieldDeploy, 0, 4, dt);
    this.aggression = damp(this.aggression, 0, 2, dt);
    if (!engage) return;
    if (distance > GK.contactRange) return;
    // Line of sight if we have a collision world; range alone otherwise. It
    // must not wake through the dock wall - the reveal is worth protecting.
    if (this.collision) {
      this.tmpVec2.copy(this.position).setY(this.position.y + 2.4);
      // The eye sits high on the mast; check from there.
      const eye = this.tmpVec2;
      const target = this.tmpVec.copy(this.position).addScaledVector(
        FORWARD_TMP.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw)),
        distance,
      );
      target.y = eye.y - 0.8;
      if (!this.collision.hasLineOfSight(eye, target)) return;
    }
    this.wake();
  }

  private wake(): void {
    if (this.state !== 'dormant') return;
    this.state = 'waking';
    this.stateTimer = 0;
    this.bus.emit('gatekeeper:engaged', { position: this.position.clone() });
    // AUDIO HOOK: klaxon / servo spin-up rides this, and the mission graph's
    // `gatekeeperSpotted` radio line is already cued off mission:gatekeeperSpawn.
    this.bus.emit('camera:shake', { amplitude: 0.045, duration: 0.5, frequency: 9 });
  }

  /**
   * The wind-up. Shield swings up and locks, head snaps onto the player,
   * beacons go hard. No shooting: the player gets a full second and a quarter
   * to read the silhouette they are about to have to solve.
   */
  private updateWaking(dt: number): void {
    this.stateTimer += dt;
    const t = clamp01(this.stateTimer / TUNING.wakeTime);
    this.pose.shieldDeploy = smoothstep(t);
    this.aggression = damp(this.aggression, 1, 6, dt);
    if (this.stateTimer >= TUNING.wakeTime) {
      this.bus.emit('gatekeeper:shield', { position: this.position.clone(), open: false });
      this.enterBarrage();
    }
  }

  private enterBarrage(): void {
    this.state = 'barrage';
    this.stateTimer = 0;
    this.heat = 0;
    this.heatFromDamage = 0;
    this.burstRemaining = 0;
    this.fireTimer = 0.35;
  }

  /**
   * Pressure. It closes to standoff, tracks, and fires bursts through the
   * shield's firing port. Heat climbs on a clock, and faster if the player is
   * hurting its flanks. When heat fills, it MUST vent - there is no version of
   * this state that lasts forever, which is the promise that makes the player
   * willing to stop shooting and reposition.
   */
  private updateBarrage(dt: number, distance: number, playerEye: THREE.Vector3): void {
    this.stateTimer += dt;
    this.heat = clamp01(this.heat + dt / GK.barrageTime);
    this.pose.shieldDeploy = damp(this.pose.shieldDeploy, 1, 8, dt);
    this.pose.shieldOpen = damp(this.pose.shieldOpen, 0, 1 / TUNING.shieldOpenTime, dt);
    this.aggression = damp(this.aggression, 1, 4, dt);

    this.driveTracks(dt, distance);
    this.updateFiring(dt, playerEye);

    if (this.heat >= 1) this.enterVent();
  }

  private enterVent(): void {
    this.state = 'venting';
    this.stateTimer = 0;
    this.burstRemaining = 0;
    this.rig?.steam && (this.rig.steam.visible = true);
    this.bus.emit('gatekeeper:shield', { position: this.position.clone(), open: true });
    this.bus.emit('gatekeeper:vent', { position: this.position.clone(), open: true });
    // AUDIO HOOK: pressure release, and the handler's "It is venting. Coil is
    // open, take it." The shake is small - it announces, it does not disrupt
    // the aim the player is about to need.
    this.bus.emit('camera:shake', { amplitude: 0.03, duration: 0.35, frequency: 14 });
  }

  /**
   * THE WINDOW. It stops moving, stops shooting, opens, and glows. Everything
   * about this state is designed to say "now, and only now" - including the
   * fact that it becomes completely passive, so the player can commit to
   * aiming instead of dodging. A vent the player has to dodge through is a
   * vent they will miss, and then the fight is just long.
   */
  private updateVenting(dt: number): void {
    this.stateTimer += dt;
    this.pose.shieldOpen = damp(this.pose.shieldOpen, 1, 1 / TUNING.shieldOpenTime, dt);
    // Head tilts down over its own vent: a second, close-range readable tell
    // of where the player is supposed to be shooting.
    this.aggression = damp(this.aggression, 0.15, 3, dt);
    if (this.stateTimer >= GK.ventTime) {
      this.state = 'sealing';
      this.stateTimer = 0;
      this.bus.emit('gatekeeper:vent', { position: this.position.clone(), open: false });
      this.bus.emit('gatekeeper:shield', { position: this.position.clone(), open: false });
    }
  }

  /**
   * The leaves slam shut. Split out from barrage so the closing frames are a
   * distinct, visible "your window just ended" rather than something that
   * happens while it is already shooting at you again.
   */
  private updateSealing(dt: number): void {
    this.stateTimer += dt;
    this.pose.shieldOpen = damp(this.pose.shieldOpen, 0, 1 / (TUNING.shieldOpenTime * 0.7), dt);
    this.aggression = damp(this.aggression, 1, 5, dt);
    if (this.stateTimer >= TUNING.shieldOpenTime) this.enterBarrage();
  }

  private enterDying(): void {
    if (this.state === 'dying' || this.state === 'dead') return;
    this.state = 'dying';
    this.deathTimer = 0;
    this.burstRemaining = 0;
    this.bus.emit('gatekeeper:defeated', { position: this.position.clone() });
    this.bus.emit('camera:shake', { amplitude: 0.11, duration: 1.1, frequency: 7 });
  }

  /**
   * Death. It does not explode - it SLUMPS. An exploding security unit reads
   * as a war machine and undercuts the mission's whole reveal; a machine that
   * sags, drops its shield and goes dark reads as something being switched
   * off, which is the note the story needs this early.
   *
   * Partway through, the access module detaches. The pickup itself belongs to
   * another workstream, so this only does the physical handoff: reparent to
   * the world container preserving the world transform, drop it to the deck,
   * and emit the event with the object attached.
   */
  private updateDying(dt: number): void {
    const rig = this.rig;
    if (!rig) return;
    this.deathTimer += dt;
    const t = clamp01(this.deathTimer / TUNING.deathTime);
    const eased = 1 - (1 - t) ** 3;

    // Chassis settles onto its suspension and slews to a stop.
    this.pose.hullPitch = eased * 0.14;
    this.pose.hullRoll = eased * 0.09;
    // Shield falls open and then droops forward - dead weight on dead hinges.
    this.pose.shieldOpen = lerp(this.pose.shieldOpen, 1, clamp01(t * 3));
    this.pose.shieldDeploy = lerp(1, 0.35, eased);
    // Head hangs.
    this.pose.headPitch = eased * 0.55;
    this.pose.armPitch = lerp(this.pose.armPitch, 1.15, clamp01(t * 1.6));
    this.pose.armElbow = lerp(this.pose.armElbow, 0.1, clamp01(t * 1.6));

    if (!this.moduleDropped && t >= TUNING.moduleDropAt) {
      this.detachModule();
    }
    if (this.moduleDropped) this.updateFallingModule(dt);

    if (this.deathTimer >= TUNING.deathTime) {
      this.state = 'dead';
      // The wreck STAYS. It is a landmark now, and the player has to walk past
      // it to reach the shutter - removing it would erase the thing they just
      // did. Only the AI stops.
    }
  }

  private detachModule(): void {
    const rig = this.rig;
    if (!rig) return;
    this.moduleDropped = true;
    const mount = rig.moduleMount;

    // Preserve the world transform across the reparent. `attach` does exactly
    // this and is the reason not to hand-roll a matrix decomposition here.
    this.group.attach(mount);
    this.moduleFall = 0;
    this.moduleSpin = this.rng.range(-2.4, 2.4);

    this.bus.emit('gatekeeper:moduleDropped', {
      position: mount.getWorldPosition(new THREE.Vector3()),
      object: mount,
    });
    // AUDIO HOOK: latch release + a metallic clatter when it lands.
  }

  /** Short arc to the deck, then it just sits there waiting to be picked up. */
  private updateFallingModule(dt: number): void {
    const rig = this.rig;
    if (!rig) return;
    const mount = rig.moduleMount;
    const restY = this.spawnPosition.y + 0.24;
    if (mount.position.y <= restY) return;
    this.moduleFall += 9.8 * dt;
    mount.position.y = Math.max(restY, mount.position.y - this.moduleFall * dt);
    // Drift clear of the hull so it never lands inside the wreck the player
    // then has to reach into.
    mount.position.z -= dt * 0.9;
    mount.rotation.y += this.moduleSpin * dt;
    mount.rotation.x = damp(mount.rotation.x, 0, 6, dt);
    if (mount.position.y <= restY) {
      this.bus.emit('camera:shake', { amplitude: 0.02, duration: 0.2, frequency: 18 });
    }
  }

  // --- movement and fire --------------------------------------------

  /**
   * Locomotion. It only ever moves along its own facing, because tracks
   * cannot strafe - and that restriction is load-bearing: a boss that can
   * sidestep cancels out the player's flanking, which is the one tactic this
   * fight is trying to teach.
   */
  private driveTracks(dt: number, distance: number): void {
    let speed = 0;
    if (distance > TUNING.standoff) speed = TUNING.advanceSpeed;
    else if (distance < TUNING.tooClose) speed = -TUNING.withdrawSpeed;
    if (speed === 0) {
      this.pose.hullPitch = damp(this.pose.hullPitch, 0, 5, dt);
      return;
    }

    FORWARD_TMP.set(Math.sin(this.pose.hullYaw), 0, Math.cos(this.pose.hullYaw));
    const step = speed * dt;
    this.tmpVec2.copy(this.position).addScaledVector(FORWARD_TMP, step);
    // Refuse to drive into geometry rather than resolving out of it: a boss
    // that can be shoved through a wall by its own pathing is worse than one
    // that occasionally stalls against a container.
    if (!this.collision || !this.collision.isBlocked(this.tmpVec2, 1.5)) {
      this.position.copy(this.tmpVec2);
    }
    // Suspension squats under acceleration. This, not a scrolling texture, is
    // what sells the tracks as driven - see the note in Gatekeeper.ts.
    this.pose.hullPitch = damp(this.pose.hullPitch, -speed * 0.022, 4, dt);
  }

  /**
   * Suppressive bursts. Emitted as `enemy:fired` on purpose: Ballistics, the
   * tracer pool, the impact VFX and the enemy-fire audio all already listen to
   * that event, so the boss inherits the entire feedback chain without a line
   * of new plumbing anywhere else in the project.
   */
  private updateFiring(dt: number, playerEye: THREE.Vector3): void {
    const rig = this.rig;
    if (!rig) return;

    // Only fires once the shield is actually up and only within its arc.
    if (this.pose.shieldDeploy < 0.8) return;
    const offAxis = Math.abs(shortAngle(this.aimYaw - this.pose.turretYaw));
    if (offAxis > TUNING.fireArc) return;

    this.fireTimer -= dt;
    if (this.fireTimer > 0) return;

    if (this.burstRemaining <= 0) {
      this.burstRemaining = TUNING.burstCount;
      this.fireTimer = TUNING.burstPause * this.rng.range(0.8, 1.3);
      return;
    }
    this.burstRemaining--;
    this.fireTimer = TUNING.fireInterval;

    const origin = new THREE.Vector3();
    rig.muzzle.getWorldPosition(origin);
    const direction = new THREE.Vector3().subVectors(playerEye, origin).normalize();
    // Wide by design. This is area denial that makes standing still expensive,
    // not a duel the player is expected to win by trading.
    const spread = 0.035;
    direction.x += this.rng.spread(spread);
    direction.y += this.rng.spread(spread * 0.6);
    direction.z += this.rng.spread(spread);
    direction.normalize();
    this.bus.emit('enemy:fired', { origin, direction });
  }

  // ------------------------------------------------------------------
  // Presentation
  // ------------------------------------------------------------------

  /**
   * Everything the player reads without being told. Split from the state
   * machine so the fight's logic can be retimed without disturbing the tells,
   * and so the tells can be tuned without risk of changing the fight.
   */
  private animate(dt: number, elapsed: number, playerEye: THREE.Vector3): void {
    const rig = this.rig;
    if (!rig) return;
    const dead = this.state === 'dying' || this.state === 'dead';
    const venting = this.state === 'venting';

    // --- yaw chain: hull lags, turret chases, head leads ---
    //
    // Same principle as the soldier's hips/torso/head, for the opposite
    // reason. On a person it hides rigidity; here the LAG IS THE MECHANIC.
    // The hull turns at 0.85 rad/s against a player who can strafe far faster,
    // so circling genuinely exposes the flank, and the player discovers that
    // by doing it rather than by being told.
    if (!dead) {
      this.pose.hullYaw = approachAngle(this.pose.hullYaw, this.aimYaw, TUNING.hullYawRate * dt);
      this.pose.turretYaw = approachAngle(
        this.pose.turretYaw,
        this.aimYaw,
        // It stops tracking while venting: it is busy, and a turret that keeps
        // following you through the window makes the window feel unearned.
        (venting ? TUNING.turretYawRate * 0.15 : TUNING.turretYawRate) * dt,
      );
    }

    // Head leads and tracks smoothly; it is the only part that ever looks
    // directly at the player, which is what makes eye contact mean something.
    const headTarget = clamp(shortAngle(this.aimYaw - this.pose.turretYaw), -0.9, 0.9);
    this.pose.headYaw = damp(this.pose.headYaw, dead ? 0 : headTarget, TUNING.headYawRate, dt);
    if (!dead) {
      // Pitch onto the player's actual height, and DOWN onto its own coil
      // while venting - a close-range pointer at the weak point.
      const rise = playerEye.y - (this.position.y + 2.4);
      const horizontal = Math.max(1, Math.hypot(playerEye.x - this.position.x, playerEye.z - this.position.z));
      const track = clamp(-Math.atan2(rise, horizontal), -0.5, 0.5);
      this.pose.headPitch = damp(this.pose.headPitch, venting ? 0.42 : track, 5, dt);
    }

    // Dormant sweep: a slow, obviously automatic scan. It reads as a machine
    // doing a job, which is what the unit is before the player matters to it.
    if (this.state === 'dormant') {
      this.pose.turretYaw = damp(this.pose.turretYaw, Math.sin(elapsed * 0.35) * 0.7, 1.5, dt);
      this.pose.hullYaw = damp(this.pose.hullYaw, 0, 1, dt);
      this.pose.headYaw = damp(this.pose.headYaw, Math.sin(elapsed * 0.62) * 0.45, 2.5, dt);
    }

    // --- work arm ---
    // Raised and cocked while pressuring, folded in while venting. It is a
    // silhouette-scale readout of what the unit is currently doing, visible
    // long after the emissive detail has been lost to distance.
    if (!dead) {
      this.pose.armPitch = damp(this.pose.armPitch, venting ? 0.15 : -0.55 - this.aggression * 0.35, 3.5, dt);
      this.pose.armElbow = damp(this.pose.armElbow, venting ? 1.5 : 0.55, 3.5, dt);
      // A slow idle sweep so the arm is never frozen.
      this.pose.armPitch += Math.sin(elapsed * 0.9) * 0.035;
    }

    // --- roll from the turret slewing ---
    if (!dead) {
      const slew = shortAngle(this.aimYaw - this.pose.turretYaw);
      this.pose.hullRoll = damp(this.pose.hullRoll, clamp(slew * 0.03, -0.045, 0.045), 4, dt);
    }

    // --- emissives ---
    //
    // These write straight onto the pooled MaterialLibrary emissives. Safe
    // because there is exactly one Gatekeeper; noted in Gatekeeper.ts too.
    const lensMat = rig.lens.material as THREE.MeshStandardMaterial;
    const coilMat = rig.coil.material as THREE.MeshStandardMaterial;
    const warnMat = rig.warnLights.material as THREE.MeshStandardMaterial;
    const moduleMat = rig.moduleGlow.material as THREE.MeshStandardMaterial;
    const steamMat = rig.steam.material as THREE.MeshStandardMaterial;

    // SENSOR EYE: amber when it does not care, red when it does, and nearly
    // dark while venting. Dropping the eye at the same moment the coil ignites
    // moves the brightest point on the model from the head to the chest, which
    // is a colour-blind-safe way of saying "aim lower".
    lensMat.emissive.copy(this.tmpColor.copy(this.amberColor).lerp(this.hostileColor, this.aggression));
    const lensPulse = 1 + Math.sin(elapsed * (2 + this.aggression * 5)) * 0.25;
    lensMat.emissiveIntensity = dead ? 0 : lerp(2.2, 7.5, this.aggression) * lensPulse * (venting ? 0.18 : 1);

    // COIL: near-black at rest, faintly warming through the barrage as heat
    // builds (a free 6-second countdown the player can learn to read), then a
    // 70x jump on the vent.
    const ventGlow = venting ? 1 : this.state === 'sealing' ? clamp01(1 - this.stateTimer / TUNING.shieldOpenTime) : 0;
    const preheat = this.state === 'barrage' ? this.heat * 0.22 : 0;
    const coilLevel = clamp01(Math.max(ventGlow, preheat));
    const flicker = 1 + Math.sin(elapsed * 21) * 0.09 * ventGlow;
    coilMat.emissiveIntensity = dead
      ? damp(coilMat.emissiveIntensity, 0, 3, dt)
      : lerp(TUNING.coilIdle, TUNING.coilVent, coilLevel) * flicker;
    // Colour rides the same curve: dull ember while it is only warm, cold
    // white-blue when it is actually open.
    coilMat.emissive.copy(this.tmpColor.set(0xff6a1e).lerp(this.ventColor, ventGlow));

    // BEACONS: slow amber patrol pulse, hard fast strobe once engaged, and a
    // hold-steady CYAN through the vent so the whole unit changes colour for
    // the duration of the window.
    const blinkRate = this.state === 'dormant' ? 1.1 : 5.5;
    const blink = Math.sin(elapsed * blinkRate) > 0.4 ? 1 : 0.12;
    warnMat.emissive.copy(this.tmpColor.set(0xffa022).lerp(this.ventColor, ventGlow));
    warnMat.emissiveIntensity = dead ? damp(warnMat.emissiveIntensity, 0, 2.5, dt) : lerp(3, 11, ventGlow) * blink;

    // MODULE: a steady, slow breath so it never competes with the combat
    // signals, and it BRIGHTENS once the unit is down - at that moment it
    // stops being scenery and becomes the objective.
    moduleMat.emissiveIntensity = (dead ? 9 : 4.5) * (1 + Math.sin(elapsed * 1.6) * 0.18);

    // STEAM: grows and fades across the window. Hidden entirely when idle so
    // it costs nothing outside the three seconds it matters.
    if (rig.steam.visible) {
      const life = venting ? clamp01(this.stateTimer / GK.ventTime) : 1;
      const puff = Math.sin(clamp01(life) * Math.PI);
      steamMat.opacity = puff * 0.5 * (venting || this.state === 'sealing' ? 1 : 0);
      const grow = 0.35 + life * 1.5;
      rig.steam.scale.setScalar(grow);
      rig.steam.position.z = life * 0.5;
      if (steamMat.opacity <= 0.005) rig.steam.visible = false;
    }
  }

  // ------------------------------------------------------------------

  /** Root-local offset -> world, reusing a scratch vector per call site. */
  private worldPoint(localOffset: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const rig = this.rig;
    if (!rig) return out.copy(localOffset);
    return out.copy(localOffset).applyMatrix4(rig.root.matrixWorld);
  }

  reset(): void {
    if (!this.rig) return;
    this.state = 'dormant';
    this.health = GK.health;
    this.heat = 0;
    this.heatFromDamage = 0;
    this.aggression = 0;
    this.stateTimer = 0;
    this.deathTimer = 0;
    this.position.copy(this.spawnPosition);
    this.pose.shieldDeploy = 0;
    this.pose.shieldOpen = 0;
    this.pose.hullPitch = 0;
    this.pose.hullRoll = 0;
    // The module goes back on its back if it was dropped.
    if (this.moduleDropped) {
      this.rig.turret.add(this.rig.moduleMount);
      this.rig.moduleMount.position.set(0, 0.34, -0.82);
      this.rig.moduleMount.rotation.set(0, 0, 0);
      this.moduleDropped = false;
    }
    this.rig.steam.visible = false;
    this.rig.apply(this.pose);
  }

  dispose(): void {
    this.rig?.dispose();
    this.rig = null;
    this.group.clear();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Local maths. Duplicated from EnemyManager rather than exported from it:
// the enemy module is a sibling system, and a boss reaching into it for a
// helper would couple two things that should be free to diverge.
// ---------------------------------------------------------------------

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

/** Signed shortest angular difference, in (-PI, PI]. */
function shortAngle(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Rotates toward a target by at most `maxDelta`, the short way round.
 *
 * A RATE LIMIT, not damping, and that is deliberate. Damping would make the
 * turret fast when far from the target and slow when near, so the flank window
 * would change size depending on how hard the player had already pulled it
 * off-axis. A constant rate means the window is the same every time, which is
 * what lets the player learn it.
 */
function approachAngle(current: number, target: number, maxDelta: number): number {
  const delta = shortAngle(target - current);
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

const FORWARD_TMP = new THREE.Vector3();
const HULL_WORLD = new THREE.Vector3();
const SHIELD_WORLD = new THREE.Vector3();
const COIL_WORLD = new THREE.Vector3();
