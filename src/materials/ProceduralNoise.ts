/**
 * Tileable procedural noise primitives.
 *
 * Every noise function here is *periodic* on an integer lattice, which is what
 * makes the generated textures tile seamlessly. Non-tiling noise is the single
 * most common tell of a procedurally-textured scene, so it is banned here.
 *
 * All functions work on Float32Array height/mask buffers of size `res * res`.
 */

const PERM_SIZE = 512;

function buildPermutation(seed: number): Uint8Array {
  const perm = new Uint8Array(PERM_SIZE);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  // Deterministic Fisher-Yates using mulberry32.
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = base[i & 255];
  return perm;
}

const permCache = new Map<number, Uint8Array>();
function perm(seed: number): Uint8Array {
  let p = permCache.get(seed);
  if (!p) {
    p = buildPermutation(seed);
    permCache.set(seed, p);
  }
  return p;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Periodic 2D value noise in [0,1]. `period` must be an integer. */
export function valueNoise2(x: number, y: number, period: number, seed: number): number {
  const p = perm(seed);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const h = (ax: number, ay: number): number => p[(p[ax & 255] + ay) & 255] / 255;
  const u = fade(xf);
  const v = fade(yf);
  const a = h(x0, y0) * (1 - u) + h(x1, y0) * u;
  const b = h(x0, y1) * (1 - u) + h(x1, y1) * u;
  return a * (1 - v) + b * v;
}

/** Periodic fractal noise. Returns [0,1]. */
export function fbm2(
  x: number,
  y: number,
  period: number,
  seed: number,
  octaves = 4,
  gain = 0.5,
  lacunarity = 2,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  let per = period;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq, per, seed + i * 131) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    per = Math.max(1, Math.round(per * lacunarity));
  }
  return sum / norm;
}

/** Ridged fbm - good for cracks, scratches and rust flow. */
export function ridged2(x: number, y: number, period: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  let per = period;
  for (let i = 0; i < octaves; i++) {
    const n = Math.abs(valueNoise2(x * freq, y * freq, per, seed + i * 977) * 2 - 1);
    sum += (1 - n) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    per = Math.max(1, per * 2);
  }
  return sum / norm;
}

/**
 * Periodic Worley / cellular noise. Returns distance to the nearest feature
 * point in [0,1]. Used for concrete aggregate, chipped paint and tread plate.
 */
export function worley2(x: number, y: number, period: number, seed: number): number {
  const p = perm(seed);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const hx = p[(p[wx & 255] + wy) & 255] / 255;
      const hy = p[(p[(wx + 71) & 255] + wy + 31) & 255] / 255;
      const px = cx + hx;
      const py = cy + hy;
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

/** Allocate a height buffer and fill it from a per-texel callback. */
export function buildField(res: number, fn: (u: number, v: number, x: number, y: number) => number): Float32Array {
  const out = new Float32Array(res * res);
  const inv = 1 / res;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      out[y * res + x] = fn(x * inv, y * inv, x, y);
    }
  }
  return out;
}

/** In-place separable box blur (approximates a gaussian in 2 passes). */
export function blurField(field: Float32Array, res: number, radius: number, passes = 2): Float32Array {
  if (radius < 1) return field;
  // `typeof field` keeps the ArrayBufferLike generic so the ping-pong swap
  // below type-checks under TypeScript 5.7+ typed-array generics.
  let src: typeof field = field;
  let dst: typeof field = new Float32Array(field.length);
  const r = Math.round(radius);
  for (let pass = 0; pass < passes; pass++) {
    // Horizontal (wrapping, to preserve tiling).
    for (let y = 0; y < res; y++) {
      const row = y * res;
      for (let x = 0; x < res; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + ((x + k + res) % res)];
        dst[row + x] = sum / (r * 2 + 1);
      }
    }
    const swap = src;
    src = dst;
    dst = swap;
    // Vertical.
    for (let x = 0; x < res; x++) {
      for (let y = 0; y < res; y++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[((y + k + res) % res) * res + x];
        dst[y * res + x] = sum / (r * 2 + 1);
      }
    }
    const swap2 = src;
    src = dst;
    dst = swap2;
  }
  if (src !== field) field.set(src);
  return field;
}

/** Remap a field to [0,1] based on its own min/max. */
export function normalizeField(field: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < min) min = field[i];
    if (field[i] > max) max = field[i];
  }
  const span = max - min || 1;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - min) / span;
  return field;
}

/**
 * Draw randomised scratch strokes into a field. Scratches are what sell "used
 * military hardware" - a perfectly smooth metal reads as plastic.
 */
export function scratchField(
  field: Float32Array,
  res: number,
  count: number,
  seed: number,
  opts: { length?: number; strength?: number; angleBias?: number; angleSpread?: number } = {},
): Float32Array {
  const length = opts.length ?? 0.22;
  const strength = opts.strength ?? 0.35;
  const angleBias = opts.angleBias ?? 0;
  const angleSpread = opts.angleSpread ?? Math.PI;
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const sx = rand() * res;
    const sy = rand() * res;
    const angle = angleBias + (rand() * 2 - 1) * angleSpread;
    const len = (0.25 + rand() * 0.75) * length * res;
    const amp = (0.35 + rand() * 0.65) * strength * (rand() < 0.5 ? -1 : 1);
    const steps = Math.max(2, Math.ceil(len));
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Slight curvature so scratches do not look machine-drawn.
    const curve = (rand() * 2 - 1) * 0.0035;
    let a = angle;
    let px = sx;
    let py = sy;
    for (let s = 0; s < steps; s++) {
      a += curve;
      px += Math.cos(a) - dx * 0;
      py += Math.sin(a) - dy * 0;
      const ix = ((Math.round(px) % res) + res) % res;
      const iy = ((Math.round(py) % res) + res) % res;
      const taper = Math.sin((s / steps) * Math.PI);
      field[iy * res + ix] += amp * taper;
    }
  }
  return field;
}

/**
 * Convert a height field to a tangent-space normal map RGBA byte buffer.
 * Sobel operator with wrap-around sampling so normals tile too.
 */
export function heightToNormalRGBA(height: Float32Array, res: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(res * res * 4);
  const at = (x: number, y: number): number => height[(((y % res) + res) % res) * res + (((x % res) + res) % res)];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * res + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Cheap ambient-occlusion approximation from a height field: a texel sitting
 * below its blurred neighbourhood is occluded.
 */
export function heightToAO(height: Float32Array, res: number, radius: number, strength: number): Float32Array {
  const blurred = blurField(Float32Array.from(height), res, radius, 2);
  const out = new Float32Array(height.length);
  for (let i = 0; i < height.length; i++) {
    const diff = height[i] - blurred[i];
    out[i] = Math.max(0, Math.min(1, 1 + diff * strength));
  }
  return out;
}
