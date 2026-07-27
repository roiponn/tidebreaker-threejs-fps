/** Small frame-rate independent maths helpers shared across systems. */

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : clamp01((v - a) / (b - a));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is roughly "how many e-folds per second"; higher = snappier.
 * Always use this instead of `lerp(a, b, 0.1)` in update loops.
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);

export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
};

/** Cheap deterministic 1D value noise - used for weapon sway and flicker. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = h(i);
  const b = h(i + 1);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

/** Layered value noise for organic motion (cables, cloth, flicker). */
export function fbm1(x: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise1(x * freq) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

export const DEG = Math.PI / 180;

/**
 * Colour temperature (Kelvin) to a linear RGB gain, normalised to preserve
 * luminance so changing white balance re-tints the image without also
 * changing its exposure.
 *
 * Uses the Tanner Helland blackbody approximation, which is accurate enough
 * over 1500-15000K for a creative white-balance control and costs nothing
 * compared with a full CIE xy -> LMS von Kries transform.
 *
 * `tint` shifts green (negative) to magenta (positive).
 */
export function kelvinToLinearGain(
  kelvin: number,
  tint: number,
  out: { x: number; y: number; z: number },
): void {
  const t = clamp(kelvin, 1500, 15000) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  r = clamp(r, 0, 255) / 255;
  g = clamp(g, 0, 255) / 255;
  b = clamp(b, 0, 255) / 255;

  // sRGB -> linear, since the gain is applied to scene-referred values.
  const toLinear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  r = toLinear(r);
  g = toLinear(g);
  b = toLinear(b);

  // Tint: push green against magenta, luminance-neutral by construction.
  g *= 1 - tint;
  r *= 1 + tint * 0.5;
  b *= 1 + tint * 0.5;

  // The camera compensates for the illuminant, so the gain is its INVERSE.
  r = 1 / Math.max(r, 1e-4);
  g = 1 / Math.max(g, 1e-4);
  b = 1 / Math.max(b, 1e-4);

  // Normalise so the gain does not change overall brightness.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out.x = r / luma;
  out.y = g / luma;
  out.z = b / luma;
}
