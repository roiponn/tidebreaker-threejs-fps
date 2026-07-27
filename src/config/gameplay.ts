/**
 * GAMEPLAY_CONFIG - movement, weapon handling and encounter tuning.
 * Feel values (accel, bob, recoil) live here so the "game feel" pass can be
 * done without touching controller code.
 */

export const PLAYER_CONFIG = {
  /** Eye height while standing / crouched, measured from the feet. */
  eyeHeightStand: 1.68,
  eyeHeightCrouch: 1.02,
  crouchLerp: 11,

  radius: 0.36,
  /** Step height the capsule can climb without jumping. */
  stepHeight: 0.42,

  speedWalk: 4.15,
  speedSprint: 6.9,
  speedCrouch: 2.05,
  speedAds: 2.35,
  /** Ground acceleration / friction. High values = snappy, arcade-military. */
  accelGround: 62,
  accelAir: 9,
  frictionGround: 11.5,

  jumpVelocity: 4.55,
  gravity: 20.5,
  /** Forgiveness window after leaving ground where jump still fires. */
  coyoteTime: 0.11,

  mouseSensitivity: 0.0022,
  adsSensitivityScale: 0.62,
  pitchLimit: Math.PI * 0.49,

  /** Landing impact: camera dip proportional to fall speed. */
  landDipScale: 0.028,
  landDipMax: 0.22,

  health: 100,
  healthRegenDelay: 4.5,
  healthRegenRate: 16,

  /** View-kick smoothing for taking damage. */
  damageKick: 0.055,
} as const;

export const WEAPON_CONFIG = {
  name: 'MK-7 "VESPER"',
  caliber: '6.8x43mm',

  magSize: 30,
  reserveAmmo: 180,
  /** Rounds per minute. 720 gives a punchy but controllable cadence. */
  rpm: 720,
  damage: 26,
  headshotMultiplier: 2.4,
  range: 220,
  /** Hitscan with a short travel delay for tracer readability. */
  tracerSpeed: 340,

  /** Recoil: vertical climb, horizontal drift, and how fast it recovers. */
  recoilVertical: 0.0142,
  recoilHorizontal: 0.0062,
  recoilRecovery: 8.6,
  /** Additional kick applied to the weapon model (metres / radians). */
  weaponKickBack: 0.028,
  weaponKickUp: 0.011,
  weaponKickRoll: 0.026,
  weaponKickRecovery: 15,
  /** Recoil pattern grows for the first N shots then plateaus. */
  recoilRampShots: 7,
  recoilRampMax: 1.85,

  spreadHip: 0.021,
  spreadAds: 0.0022,
  spreadMoving: 0.016,
  spreadCrouch: -0.006,
  spreadBloomPerShot: 0.0034,
  spreadBloomMax: 0.028,
  spreadRecovery: 0.055,

  adsTime: 0.19,
  reloadTime: 2.35,
  reloadEmptyTime: 2.95,
  /** When in the reload the magazine actually swaps (drives ammo counter). */
  reloadAmmoSwapAt: 0.62,

  /** Weapon sway / bob amplitudes. Kept low: sway must not fight the aim. */
  swayPosition: 0.014,
  swayRotation: 0.028,
  swaySmoothing: 7.5,
  bobWalk: 0.0125,
  bobSprint: 0.026,
  bobFrequency: 8.4,
  /**
   * How far the weapon retracts when the muzzle nears a wall.
   *
   * This must sit just beyond the muzzle (~0.96m from the eye) and no further.
   * At 1.35m the probe was engaging on the deck whenever the player looked
   * down while walking, so the retract pose was blended in almost constantly.
   */
  wallProbeDistance: 1.05,
  wallRetract: 0.24,

  /** Heat haze / barrel glow builds with sustained fire. */
  heatPerShot: 0.055,
  heatCooling: 0.28,
} as const;

export const ENEMY_CONFIG = {
  health: 100,
  /** Simple state machine only - no navmesh, no squad logic. */
  sightRange: 62,
  fieldOfView: Math.PI * 0.62,
  fireInterval: 0.14,
  burstCount: 4,
  burstPause: 1.25,
  /** Deliberately generous so the player survives a 90 second slice. */
  accuracy: 0.32,
  damage: 8,
  reactionTime: 0.42,
  strafeSpeed: 2.4,
  strafeInterval: 2.1,
  /** Hit reaction: flinch magnitude and duration. */
  flinchAmount: 0.16,
  flinchTime: 0.22,
  deathFadeDelay: 6.0,
} as const;

export const MISSION_CONFIG = {
  /** The slice is authored for a 60-90 second run. */
  targetDurationSec: 90,
  introDurationSec: 6.5,
  /** Radius around the extraction marker that completes the mission. */
  extractRadius: 3.2,
  totalHostiles: 11,
} as const;
