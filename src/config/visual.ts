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
    base: 1.62,
    /** Eye adaptation speed (units/sec) - deliberately slow and subtle. */
    adaptionSpeed: 0.55,
    /** How far auto-exposure is allowed to drift from `base`. */
    adaptionRange: 0.22,
  },

  /**
   * Dusk-to-night sky. `timeOfDay` 0 = late dusk, 1 = deep night.
   *
   * The gradient has four stops. The warm `horizon` colour is applied only
   * TOWARD THE SUN (see SkyShader) - a warm band that wraps the whole horizon
   * ring is what made the previous sky read as a flat orange wash and, through
   * the PMREM probe, tinted every reflective surface in the level.
   */
  sky: {
    timeOfDay: 0.42,
    zenithDay: 0x0a1c33,
    zenithNight: 0x060d1a,
    /** Mid-height band; the main "colour of the sky" the player perceives. */
    upperDay: 0x1d3f5e,
    upperNight: 0x101f36,
    horizonDay: 0xc26536,
    horizonNight: 0x2c3c58,
    groundHaze: 0x121824,
    /** Angular size / softness of the sun disc glow on the sky dome. */
    sunGlowPower: 620,
    starIntensity: 0.85,
    cloudCoverage: 0.66,
    cloudSpeed: 0.0042,
    /**
     * Strength of the horizon haze band, which is painted with the scene's own
     * fog colour so the dome and the distant scenery dissolve into each other.
     */
    hazeStrength: 0.78,
    /** Compass bearing of the departing storm, and how heavy it still is. */
    stormAzimuth: 292,
    stormStrength: 0.62,
  },

  sun: {
    /** Azimuth/elevation in degrees. Low sun = long, readable shadows. */
    azimuth: 108,
    elevation: 3.4,
    // The key is already past sunset at timeOfDay 0.42, so it is only mildly
    // warm; the strongly warm light in this scene comes from the sodium
    // floodlights, not from the sky. A saturated orange key here re-tints
    // every surface and destroys the warm/cool contrast.
    colorDay: 0xffd0a8,
    colorNight: 0x8fb0e0,
    intensityDay: 2.2,
    intensityNight: 1.05,
    shadowMapSize: 2048,
    shadowBias: -0.0008,
    shadowNormalBias: 0.035,
    /** Tight ortho box around the playable area keeps texels dense. */
    shadowRadius: 46,
    shadowFar: 190,
  },

  ambient: {
    /**
     * Hemisphere fill so shadowed areas keep readable information.
     * This is ALSO the shadow colour: whatever is not hit by the key or a
     * practical is lit by this and nothing else. It must be clearly cool, or
     * shadows go brown and the whole frame collapses into one hue.
     */
    skyColor: 0x6d92c0,
    /** Bounce from the ground. Wet asphalt bounces cool, not warm brown. */
    groundColor: 0x18222f,
    intensity: 1.45,
    /** Strength of the PMREM environment probe on all PBR materials. */
    envIntensity: 1.2,
  },

  fog: {
    color: 0x223047,
    /** Exponential-squared density; the harbour reads best around 0.012. */
    density: 0.0138,
    /** Extra near-ground mist layer height (metres). */
    mistHeight: 3.2,
    mistDensity: 0.55,
    /** Aerial perspective tint applied to distant geometry. */
    aerialColor: 0x4a6f9e,
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
    rainAmount: 0.22,
  },

  bloom: {
    strength: 0.48,
    radius: 0.62,
    /** Threshold in linear HDR - only genuine emitters should bloom. */
    threshold: 0.92,
  },

  grade: {
    /**
     * WHITE BALANCE, applied in scene-referred linear space BEFORE the
     * tonemap - which is the only place it is physically meaningful.
     *
     * `whiteBalanceK` is the colour temperature the virtual camera is balanced
     * FOR. Balancing for a warm source (a low value) tells the camera "the
     * light here is orange", so it compensates by cooling the image; anything
     * genuinely warm (the sodium lamps, the muzzle flash) then stands out as
     * warm against a cool world. This is the standard night-exterior trick and
     * it is the single most effective control over the warm/cool contrast.
     *
     * 6500 = neutral. Lower = cooler image. Tint shifts green(-) / magenta(+).
     */
    whiteBalanceK: 5150,
    whiteBalanceTint: 0.04,
    /** Lift / gamma / gain style trim applied after tonemapping. */
    liftShadows: 0x0c1420,
    gainHighlights: 0xfffbf6,
    contrast: 1.09,
    saturation: 1.16,
    /** Teal shadows / amber highlights split-tone, kept restrained. */
    splitToneShadow: 0x1d4f74,
    splitToneHighlight: 0xffc48c,
    splitToneBalance: 0.3,
    vignette: 0.26,
    vignetteSoftness: 0.55,
    grain: 0.014,
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

  /**
   * Practical lights placed in the level.
   *
   * TWO COLOUR FAMILIES, deliberately. The yard and the container canyon are
   * lit by old high-pressure SODIUM (deep amber); the warehouse facade, the
   * pier head and the interior strips are modern MERCURY/LED (cold blue-white).
   * The player physically crosses between the two, which is what produces
   * warm/cool contrast in depth instead of one uniform colour cast. Making
   * every practical the same temperature is what flattened the palette.
   */
  practicals: {
    /** High-pressure sodium: yard masts, canyon masts, catwalk lamp. */
    floodColorWarm: 0xff9c33,
    /** Mercury/LED: warehouse facade, pier head, blockhouse. */
    floodColorCool: 0xbfd8ff,
    floodColor: 0xff9c33,
    floodIntensity: 820,
    floodDistance: 38,
    floodAngle: 0.52,
    floodPenumbra: 0.45,
    /** Volumetric cone mesh opacity - fakes light shafts cheaply. */
    shaftOpacity: 0.115,
    beaconColor: 0xff3d16,
    beaconIntensity: 140,
    beaconSpeed: 1.9,
    stripColor: 0xb8dcff,
    stripIntensity: 26,
    /** Chance per second that a failing lamp flickers. */
    flickerRate: 0.9,
  },

  muzzle: {
    lightIntensity: 480,
    lightDistance: 26,
    /** Flash lifetime in seconds - 2 frames at 60fps reads as "snappy". */
    lightDuration: 0.045,
    flashScale: 0.36,
  },

  explosion: {
    lightIntensity: 430,
    lightDistance: 40,
    lightDuration: 0.62,
    radius: 7.5,
    damage: 90,
  },
} as const;

export type VisualConfig = typeof VISUAL_CONFIG;

/** Mutable runtime mirror - the debug panel writes here, systems read here. */
export type MutableVisual = {
  -readonly [K in keyof VisualConfig]: {
    // `VisualConfig[K][P]` would keep the literal type from `as const`, so
    // every runtime assignment would be a type error. Widen to the primitive.
    -readonly [P in keyof VisualConfig[K]]: VisualConfig[K][P] extends number
      ? number
      : VisualConfig[K][P] extends boolean
        ? boolean
        : VisualConfig[K][P];
  };
};

export function cloneVisualConfig(): MutableVisual {
  // structuredClone keeps the literal types from `as const`; widening them here
  // is what makes the runtime mirror actually mutable.
  return structuredClone(VISUAL_CONFIG) as unknown as MutableVisual;
}
