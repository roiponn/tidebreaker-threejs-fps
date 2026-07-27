import * as THREE from 'three';
import { PLAYER_CONFIG } from '@/config/gameplay';
import type { EventBus } from '@/core/EventBus';
import type { Input } from '@/core/Input';
import { clamp, clamp01, damp } from '@/core/MathUtils';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import type { PlayerCamera } from './PlayerCamera';

/**
 * Player movement, stance and health.
 *
 * Movement model is acceleration + friction rather than direct velocity
 * assignment. That single choice is most of the "weight" the brief asks for:
 * the player takes ~0.15s to reach full speed and slides a few centimetres on
 * stopping, so starting and stopping have mass, while the numbers are high
 * enough that the controls never feel sluggish.
 */
export type Stance = 'stand' | 'crouch';

export class Player {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  stance: Stance = 'stand';
  grounded = false;
  health = PLAYER_CONFIG.health;
  alive = true;

  private eyeHeight = PLAYER_CONFIG.eyeHeightStand;
  private coyoteTimer = 0;
  private timeSinceDamage = 999;
  private footstepDistance = 0;
  private wasGrounded = true;
  private frozen = false;

  /** Horizontal speed, exposed for the camera bob and weapon sway. */
  speed = 0;
  sprinting = false;

  private readonly eyePosition = new THREE.Vector3();
  private readonly wishDirection = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly damageDirection = new THREE.Vector3();

  constructor(
    private readonly collision: CollisionWorld,
    private readonly view: PlayerCamera,
    private readonly bus: EventBus,
  ) {}

  spawn(position: THREE.Vector3, yaw: number): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.stance = 'stand';
    this.health = PLAYER_CONFIG.health;
    this.alive = true;
    this.eyeHeight = PLAYER_CONFIG.eyeHeightStand;
    this.view.reset(yaw);
    this.frozen = false;
  }

  /** Locks movement input (used by the intro and the end sequence). */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (frozen) this.velocity.set(0, 0, 0);
  }

  get eye(): THREE.Vector3 {
    return this.eyePosition.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  update(dt: number, input: Input, ads: boolean): void {
    if (!this.alive) {
      // On death the camera settles to the ground rather than freezing.
      this.eyeHeight = damp(this.eyeHeight, 0.42, 3.5, dt);
      this.velocity.y -= PLAYER_CONFIG.gravity * dt;
      this.position.y += this.velocity.y * dt;
      this.collision.resolveCapsule(this.position, PLAYER_CONFIG.radius, 0.5, 0.1);
      return;
    }

    // --- stance ---
    const wantsCrouch = !this.frozen && input.isDown('crouch');
    // Do not stand up into a ceiling.
    const headroom = !this.collision.isBlocked(
      new THREE.Vector3(this.position.x, this.position.y + PLAYER_CONFIG.eyeHeightStand + 0.12, this.position.z),
      PLAYER_CONFIG.radius * 0.5,
    );
    this.stance = wantsCrouch || !headroom ? 'crouch' : 'stand';
    const targetEye =
      this.stance === 'crouch' ? PLAYER_CONFIG.eyeHeightCrouch : PLAYER_CONFIG.eyeHeightStand;
    this.eyeHeight = damp(this.eyeHeight, targetEye, PLAYER_CONFIG.crouchLerp, dt);

    // --- desired direction in world space ---
    this.wishDirection.set(0, 0, 0);
    if (!this.frozen) {
      const yaw = this.view.yaw;
      this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      if (input.isDown('forward')) this.wishDirection.add(this.forward);
      if (input.isDown('back')) this.wishDirection.sub(this.forward);
      if (input.isDown('right')) this.wishDirection.add(this.right);
      if (input.isDown('left')) this.wishDirection.sub(this.right);
      if (this.wishDirection.lengthSq() > 0) this.wishDirection.normalize();
    }

    // Sprint requires forward intent and an un-aimed weapon: it is a movement
    // state, not a speed boost you can strafe with.
    const forwardIntent = this.wishDirection.dot(this.forward);
    this.sprinting =
      !this.frozen &&
      input.isDown('sprint') &&
      forwardIntent > 0.55 &&
      this.stance === 'stand' &&
      !ads &&
      this.grounded;

    let targetSpeed = PLAYER_CONFIG.speedWalk;
    if (this.stance === 'crouch') targetSpeed = PLAYER_CONFIG.speedCrouch;
    else if (this.sprinting) targetSpeed = PLAYER_CONFIG.speedSprint;
    else if (ads) targetSpeed = PLAYER_CONFIG.speedAds;

    // --- horizontal acceleration with ground friction ---
    const accel = this.grounded ? PLAYER_CONFIG.accelGround : PLAYER_CONFIG.accelAir;
    const desiredX = this.wishDirection.x * targetSpeed;
    const desiredZ = this.wishDirection.z * targetSpeed;
    this.velocity.x += (desiredX - this.velocity.x) * clamp01(accel * dt);
    this.velocity.z += (desiredZ - this.velocity.z) * clamp01(accel * dt);
    if (this.grounded && this.wishDirection.lengthSq() < 0.01) {
      const friction = clamp01(PLAYER_CONFIG.frictionGround * dt);
      this.velocity.x -= this.velocity.x * friction;
      this.velocity.z -= this.velocity.z * friction;
    }

    // --- jump with coyote time ---
    this.coyoteTimer = this.grounded ? PLAYER_CONFIG.coyoteTime : this.coyoteTimer - dt;
    if (!this.frozen && input.wasPressed('jump') && this.coyoteTimer > 0) {
      this.velocity.y = PLAYER_CONFIG.jumpVelocity;
      this.coyoteTimer = 0;
      this.grounded = false;
    }

    this.velocity.y -= PLAYER_CONFIG.gravity * dt;

    // --- integrate + resolve ---
    this.position.addScaledVector(this.velocity, dt);
    const height = this.stance === 'crouch' ? 1.2 : 1.78;
    const result = this.collision.resolveCapsule(
      this.position,
      PLAYER_CONFIG.radius,
      height,
      PLAYER_CONFIG.stepHeight,
    );

    if (result.grounded) {
      if (!this.wasGrounded && this.velocity.y < -1.5) {
        const impact = Math.abs(this.velocity.y);
        this.view.addLandingImpact(impact);
        this.bus.emit('player:landed', { impact });
      }
      this.velocity.y = Math.max(0, this.velocity.y);
    }
    this.grounded = result.grounded;
    this.wasGrounded = result.grounded;

    // Keep the player inside the authored playspace. A soft wall, not a stop.
    this.position.x = clamp(this.position.x, -8.5, 60);
    this.position.z = clamp(this.position.z, -13.4, 11.4);

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // --- footsteps, driven by distance travelled, not by a timer ---
    if (this.grounded) {
      this.footstepDistance += this.speed * dt;
      const stride = this.sprinting ? 1.95 : this.stance === 'crouch' ? 1.5 : 1.62;
      if (this.footstepDistance > stride) {
        this.footstepDistance = 0;
        this.bus.emit('player:footstep', { sprinting: this.sprinting, surface: 'concrete' });
      }
    }

    // --- health regeneration ---
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > PLAYER_CONFIG.healthRegenDelay && this.health < PLAYER_CONFIG.health) {
      this.health = Math.min(PLAYER_CONFIG.health, this.health + PLAYER_CONFIG.healthRegenRate * dt);
    }
  }

  damage(amount: number, fromPosition: THREE.Vector3): void {
    if (!this.alive) return;
    this.health -= amount;
    this.timeSinceDamage = 0;
    this.damageDirection.subVectors(fromPosition, this.position).setY(0).normalize();
    this.view.addDamageKick(this.damageDirection, PLAYER_CONFIG.damageKick * (amount / 10));
    this.bus.emit('player:damaged', {
      amount,
      fromDirection: this.damageDirection.clone(),
      health: Math.max(0, this.health),
    });
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.bus.emit('player:died');
    }
  }

  get healthFraction(): number {
    return clamp01(this.health / PLAYER_CONFIG.health);
  }
}
