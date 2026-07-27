/**
 * VISUAL_CONFIG - the single source of truth for the "look" of the slice.
 *
 * Everything here is read at scene build time and/or live-tweaked by the debug
 * panel. If you change a value in this file the game re-authors itself around
 * it; nothing in the renderer hardcodes a colour or intensity.
 *
 * Colour convention: all colours are authored in sRGB hex and converted by
 * three (setHex uses SRGBColorSpace by default in r15x+). Light intensities
 * assume `renderer.useLegacyLights === false` (physically correct lighting),
 * so point/spot lights are in candela-ish units with decay = 2.
 */

export const VISUAL_CONFIG = {
  /** Camera / exposure. Filmic exposure is the primary brightness control. */
  camera: {
    fovBase: 74,
    fovAds: 52,
    /** FOV added while sprinting; sells speed without inducing nausea. */
    fovSprintAdd: 6,
    near: 0.02,
    far: 900,
    /** Weapon is rendered by a second camera so it never clips into geometry. */
    weaponFov: 58,
    weaponFovAds: 42,
    weaponNear: 0.004,
    weaponFar: 8,
  },

  exposure: {
    /** ACES-filmic exposure multiplier applied in the composite pass. */
    base: 1.06,
    /** Eye adaptation speed (units/sec) - deliberately slow and subtle. */
    adaptionSpeed: 0.55,
    /** How far auto-exposure is allowed to drift from `base`. */
    adaptionRange: 0.22,
  },

  /** Dusk-to-night sky. `timeOfDay` 0 = late dusk, 1 = deep night. */
  sky: {
    timeOfDay: 0.34,
    zenithDay: 0x1b3a5c,
    zenithNight: 0x070c18,
    horizonDay: 0xff8b4a,
    horizonNight: 0x2a2f45,
    groundHaze: 0x151a24,
    /** Angular size / softness of the sun disc glow on the sky dome. */
    sunGlowPower: 220,
    starIntensity: 0.55,
    cloudCoverage: 0.62,
    cloudSpeed: 0.0035,
  },

  sun: {
    /** Azimuth/elevation in degrees. Low sun = long, readable shadows. */
    azimuth: 108,
    elevation: 3.4,
    colorDay: 0xffb070,
    colorNight: 0x4a6ea8,
    intensityDay: 3.1,
    intensityNight: 0.28,
    shadowMapSize: 2048,
    shadowBias: -0.0008,
    shadowNormalBias: 0.035,
    /** Tight ortho box around the playable area keeps texels dense. */
    shadowRadius: 46,
    shadowFar: 190,
  },

  ambient: {
    /** Hemisphere fill so shadowed areas keep readable information. */
    skyColor: 0x3d5a7a,
    groundColor: 0x1a1610,
    intensity: 0.85,
    /** Strength of the PMREM environment probe on all PBR materials. */
    envIntensity: 0.9,
  },

  fog: {
    color: 0x2a3243,
    /** Exponential-squared density; the harbour reads best around 0.012. */
    density: 0.0125,
    /** Extra near-ground mist layer height (metres). */
    mistHeight: 3.2,
    mistDensity: 0.55,
    /** Aerial perspective tint applied to distant geometry. */
    aerialColor: 0x4a5f7d,
    aerialStrength: 0.55,
  },

  /** Wet-ground / puddle system. */
  wetness: {
    /** 0 = bone dry, 1 = flooded. Drives roughness + puddle mask coverage. */
    global: 0.82,
    puddleReflectivity: 0.92,
    /** Planar reflection render scale (fraction of the main framebuffer). */
    reflectionScale: 0.5,
    rippleSpeed: 1.1,
    rippleStrength: 0.35,
    /** Light drizzle left over from the storm. 0 disables the rain system. */
    rainAmount: 0.28,
  },

  bloom: {
    strength: 0.42,
    radius: 0.62,
    /** Threshold in linear HDR - only genuine emitters should bloom. */
    threshold: 0.92,
  },

  grade: {
    /** Lift / gamma / gain style trim applied after tonemapping. */
    liftShadows: 0x0c1420,
    gainHighlights: 0xfff2e2,
    contrast: 1.09,
    saturation: 1.05,
    /** Teal shadows / amber highlights split-tone, kept restrained. */
    splitToneShadow: 0x1d3a4d,
    splitToneHighlight: 0xffc48a,
    splitToneBalance: 0.28,
    vignette: 0.36,
    vignetteSoftness: 0.55,
    grain: 0.028,
    chromaticAberration: 0.0016,
  },

  dof: {
    enabled: true,
    /** Distance in metres that is perfectly sharp when hip-firing. */
    focusHip: 14,
    focusAds: 42,
    /** Circle-of-confusion scale. Kept small: this is a game, not a photo. */
    strength: 0.55,
    maxBlurPx: 3.4,
    nearStart: 1.1,
  },

  motion: {
    /** Camera-rotation driven directional blur. Subtle by design. */
    blurStrength: 0.42,
    blurMaxSamples: 6,
  },

  ao: {
    enabled: true,
    radius: 0.85,
    intensity: 0.9,
    bias: 0.025,
    /** Half-resolution SSAO; the blur pass hides the resolution loss. */
    scale: 0.5,
  },

  /** Practical lights placed in the level (floodlights, beacons, strips). */
  practicals: {
    floodColor: 0xffd9a8,
    floodIntensity: 46,
    floodDistance: 38,
    floodAngle: 0.52,
    floodPenumbra: 0.45,
    /** Volumetric cone mesh opacity - fakes light shafts cheaply. */
    shaftOpacity: 0.055,
    beaconColor: 0xff5a2a,
    beaconIntensity: 14,
    beaconSpeed: 1.9,
    stripColor: 0x9fd8ff,
    stripIntensity: 3.2,
    /** Chance per second that a failing lamp flickers. */
    flickerRate: 0.9,
  },

  muzzle: {
    lightIntensity: 260,
    lightDistance: 26,
    /** Flash lifetime in seconds - 2 frames at 60fps reads as "snappy". */
    lightDuration: 0.045,
    flashScale: 0.36,
  },

  explosion: {
    lightIntensity: 1400,
    lightDistance: 62,
    lightDuration: 0.55,
    radius: 7.5,
    damage: 90,
  },
} as const;

export type VisualConfig = typeof VISUAL_CONFIG;

/** Mutable runtime mirror - the debug panel writes here, systems read here. */
export type MutableVisual = {
  -readonly [K in keyof VisualConfig]: { -readonly [P in keyof VisualConfig[K]]: VisualConfig[K][P] };
};

export function cloneVisualConfig(): MutableVisual {
  return structuredClone(VISUAL_CONFIG) as MutableVisual;
}
