import * as THREE from 'three';
import {
  blurField,
  buildField,
  fbm2,
  heightToAO,
  heightToNormalRGBA,
  normalizeField,
  ridged2,
  scratchField,
  valueNoise2,
  worley2,
} from './ProceduralNoise';

/**
 * Procedural PBR texture generation.
 *
 * The project ships with ZERO binary art assets - every texture in the harbour
 * is synthesised here at load time. That keeps the repo licence-clean and lets
 * the art direction be parameterised, but it means this file *is* the texture
 * budget: keep resolutions modest and cache aggressively.
 *
 * Channel packing convention (matches glTF "ORM"):
 *   R = ambient occlusion, G = roughness, B = metalness
 * The same texture object is bound to aoMap / roughnessMap / metalnessMap, so
 * it costs one upload and one texture bind.
 */

export interface TextureSet {
  /** sRGB base colour. */
  map: THREE.DataTexture;
  /** Tangent-space normal. */
  normalMap: THREE.DataTexture;
  /** Packed AO(R) / roughness(G) / metalness(B). */
  ormMap: THREE.DataTexture;
}

type Rgb = [number, number, number];

const hexToRgb = (hex: number): Rgb => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function makeColorTexture(res: number, data: Uint8ClampedArray, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeDataTexture(res: number, data: Uint8ClampedArray, anisotropy: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Builder that assembles the three maps from per-texel callbacks. */
interface MaterialRecipe {
  res: number;
  /** Height/bump field used for both the normal map and the AO term. */
  height: Float32Array;
  normalStrength: number;
  aoRadius: number;
  aoStrength: number;
  color: (i: number, u: number, v: number, h: number) => Rgb;
  roughness: (i: number, u: number, v: number, h: number) => number;
  metalness: (i: number, u: number, v: number, h: number) => number;
}

function bake(recipe: MaterialRecipe, anisotropy: number): TextureSet {
  const { res, height } = recipe;
  const ao = heightToAO(height, res, recipe.aoRadius, recipe.aoStrength);
  const colorData = new Uint8ClampedArray(res * res * 4);
  const ormData = new Uint8ClampedArray(res * res * 4);
  const inv = 1 / res;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const u = x * inv;
      const v = y * inv;
      const h = height[i];
      const c = recipe.color(i, u, v, h);
      const o = i * 4;
      colorData[o] = c[0];
      colorData[o + 1] = c[1];
      colorData[o + 2] = c[2];
      colorData[o + 3] = 255;
      ormData[o] = ao[i] * 255;
      ormData[o + 1] = recipe.roughness(i, u, v, h) * 255;
      ormData[o + 2] = recipe.metalness(i, u, v, h) * 255;
      ormData[o + 3] = 255;
    }
  }
  const normalData = heightToNormalRGBA(height, res, recipe.normalStrength);
  return {
    map: makeColorTexture(res, colorData, anisotropy),
    normalMap: makeDataTexture(res, normalData, anisotropy),
    ormMap: makeDataTexture(res, ormData, anisotropy),
  };
}

/**
 * Generates and caches every texture set used by the level.
 * Call `dispose()` on shutdown - DataTextures are real GPU memory.
 */
export class TextureFactory {
  private cache = new Map<string, TextureSet>();
  private extra = new Map<string, THREE.DataTexture>();

  constructor(private anisotropy = 4) {}

  setAnisotropy(value: number): void {
    this.anisotropy = value;
    for (const set of this.cache.values()) {
      set.map.anisotropy = value;
      set.normalMap.anisotropy = value;
      set.ormMap.anisotropy = value;
      set.map.needsUpdate = true;
      set.normalMap.needsUpdate = true;
      set.ormMap.needsUpdate = true;
    }
  }

  private memo(key: string, build: () => TextureSet): TextureSet {
    let set = this.cache.get(key);
    if (!set) {
      set = build();
      this.cache.set(key, set);
    }
    return set;
  }

  // ---------------------------------------------------------------------
  // Surfaces
  // ---------------------------------------------------------------------

  /**
   * Poured concrete: coarse aggregate showing through worn cement, form-work
   * seams, hairline cracks and dark water staining from the rain.
   */
  concrete(seed = 11): TextureSet {
    return this.memo(`concrete${seed}`, () => {
      const res = 512;
      const aggregate = buildField(res, (u, v) => 1 - worley2(u * 26, v * 26, 26, seed + 3));
      const grain = buildField(res, (u, v) => fbm2(u * 9, v * 9, 9, seed, 5));
      const cracks = buildField(res, (u, v) => {
        const r = ridged2(u * 4.2, v * 4.2, 4, seed + 91, 4);
        // Only the very top of the ridge becomes a crack -> thin, sparse lines.
        return Math.max(0, r - 0.86) * 7;
      });
      blurField(cracks, res, 1, 1);
      const stain = buildField(res, (u, v) => fbm2(u * 2.6, v * 2.6, 3, seed + 401, 4));
      const patch = buildField(res, (u, v) => fbm2(u * 1.4, v * 1.4, 1, seed + 733, 3));

      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) {
        height[i] = aggregate[i] * 0.34 + grain[i] * 0.28 - cracks[i] * 0.9;
      }
      scratchField(height, res, 90, seed + 55, { length: 0.3, strength: 0.06 });
      normalizeField(height);

      const light = hexToRgb(0x8d8b85);
      const dark = hexToRgb(0x4a4945);
      const wet = hexToRgb(0x2b2d30);
      const rustBleed = hexToRgb(0x6b4a33);

      return bake(
        {
          res,
          height,
          normalStrength: 1.3,
          aoRadius: 3,
          aoStrength: 1.8,
          color: (i, _u, _v, h) => {
            const tone = 0.35 + h * 0.5 + patch[i] * 0.25;
            let c = mixRgb(dark, light, Math.min(1, tone));
            // Water staining pools in the low frequencies.
            c = mixRgb(c, wet, Math.pow(Math.max(0, stain[i] - 0.52) * 1.5, 1.6) * 0.42);
            // Iron oxide bleeding out of rebar near the strongest stains.
            c = mixRgb(c, rustBleed, Math.pow(Math.max(0, stain[i] - 0.78) * 3, 2) * 0.3);
            c = mixRgb(c, [18, 18, 20], Math.min(1, cracks[i] * 1.4));
            return c;
          },
          roughness: (i, _u, _v, h) => {
            const base = 0.94 - h * 0.14;
            // Wet patches are noticeably smoother -> reads as damp concrete.
            return Math.max(0.42, base - Math.max(0, stain[i] - 0.5) * 0.6);
          },
          metalness: () => 0.0,
        },
        this.anisotropy,
      );
    });
  }

  /** Wet asphalt / tarmac for the dock apron - finer, darker, oilier. */
  asphalt(seed = 27): TextureSet {
    return this.memo(`asphalt${seed}`, () => {
      const res = 512;
      const chips = buildField(res, (u, v) => 1 - worley2(u * 44, v * 44, 44, seed));
      const grain = buildField(res, (u, v) => fbm2(u * 16, v * 16, 16, seed + 12, 4));
      const oil = buildField(res, (u, v) => fbm2(u * 2.2, v * 2.2, 2, seed + 88, 3));
      const wear = buildField(res, (u, v) => fbm2(u * 5, v * 1.2, 5, seed + 313, 3));

      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) height[i] = chips[i] * 0.45 + grain[i] * 0.35;
      normalizeField(height);

      const dark = hexToRgb(0x24262a);
      const mid = hexToRgb(0x3a3d42);
      const oilTint = hexToRgb(0x1a1d24);

      return bake(
        {
          res,
          height,
          normalStrength: 1.7,
          aoRadius: 2,
          aoStrength: 2.2,
          color: (i, _u, _v, h) => {
            let c = mixRgb(dark, mid, h * 0.9 + wear[i] * 0.2);
            c = mixRgb(c, oilTint, Math.max(0, oil[i] - 0.5) * 1.3);
            return c;
          },
          roughness: (i, _u, _v, h) => 0.82 - h * 0.1 - Math.max(0, oil[i] - 0.55) * 0.55,
          metalness: (i) => Math.max(0, oil[i] - 0.72) * 0.35,
        },
        this.anisotropy,
      );
    });
  }

  /**
   * Shipping-container paint: flat industrial enamel over corrugated steel,
   * chipped along the edges with rust blooming and running downward.
   */
  containerPaint(baseHex: number, seed = 5): TextureSet {
    return this.memo(`container${baseHex}_${seed}`, () => {
      const res = 512;
      // Rust starts as blotches then is stretched vertically to make drips.
      const rustBlotch = buildField(res, (u, v) => fbm2(u * 5.5, v * 5.5, 5, seed + 17, 4));
      const rustDrip = buildField(res, (u, v) => fbm2(u * 9, v * 1.6, 9, seed + 29, 4));
      const chip = buildField(res, (u, v) => 1 - worley2(u * 18, v * 18, 18, seed + 61));
      const dirt = buildField(res, (u, v) => fbm2(u * 3, v * 3, 3, seed + 97, 3));
      const grain = buildField(res, (u, v) => valueNoise2(u * 128, v * 128, 128, seed + 5));

      const rust = new Float32Array(res * res);
      for (let i = 0; i < rust.length; i++) {
        const blot = Math.max(0, rustBlotch[i] - 0.56) * 2.6;
        const drip = Math.max(0, rustDrip[i] - 0.62) * 2.2;
        rust[i] = Math.min(1, blot * 0.8 + drip * 0.55 + Math.max(0, chip[i] - 0.78) * 1.6);
      }

      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) {
        // Rust is physically raised (scale/flaking), paint chips are recessed.
        height[i] = rust[i] * 0.42 + grain[i] * 0.08 - Math.max(0, chip[i] - 0.82) * 0.5;
      }
      scratchField(height, res, 140, seed + 7, { length: 0.18, strength: 0.09 });
      normalizeField(height);

      const paint = hexToRgb(baseHex);
      const paintFaded = mixRgb(paint, [150, 150, 148], 0.32);
      const rustDark = hexToRgb(0x532c17);
      const rustLight = hexToRgb(0xa1552a);
      const primer = hexToRgb(0x6d6a63);

      return bake(
        {
          res,
          height,
          normalStrength: 2.0,
          aoRadius: 3,
          aoStrength: 2.4,
          color: (i, _u, v) => {
            // Sun-bleaching: the top of every panel is lighter than the bottom.
            let c = mixRgb(paintFaded, paint, Math.min(1, v * 0.85 + 0.25));
            c = mixRgb(c, primer, Math.max(0, chip[i] - 0.74) * 2.2);
            const r = rust[i];
            c = mixRgb(c, mixRgb(rustDark, rustLight, rustBlotch[i]), Math.min(1, r * 1.15));
            c = mixRgb(c, [40, 38, 34], Math.max(0, dirt[i] - 0.55) * 0.7);
            return c;
          },
          roughness: (i) => Math.min(1, 0.52 + rust[i] * 0.42 + dirt[i] * 0.12),
          // Bare metal shows through only where the paint has actually gone.
          metalness: (i) => Math.min(0.85, Math.max(0, chip[i] - 0.8) * 3 + rust[i] * 0.25),
        },
        this.anisotropy,
      );
    });
  }

  /** Bare / painted structural steel for catwalks, columns and stairs. */
  steel(seed = 41, painted = true): TextureSet {
    return this.memo(`steel${seed}${painted}`, () => {
      const res = 512;
      const rust = buildField(res, (u, v) => fbm2(u * 7, v * 7, 7, seed + 13, 4));
      const dripRust = buildField(res, (u, v) => fbm2(u * 12, v * 2, 12, seed + 47, 3));
      const grime = buildField(res, (u, v) => fbm2(u * 3.5, v * 3.5, 3, seed + 71, 3));
      const brushed = buildField(res, (u, v) => valueNoise2(u * 300, v * 6, 300, seed + 3));

      const rustMask = new Float32Array(res * res);
      for (let i = 0; i < rustMask.length; i++) {
        rustMask[i] = Math.min(
          1,
          Math.max(0, rust[i] - 0.6) * 2.4 + Math.max(0, dripRust[i] - 0.68) * 1.8,
        );
      }

      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) height[i] = rustMask[i] * 0.4 + brushed[i] * 0.07;
      scratchField(height, res, 200, seed + 21, { length: 0.35, strength: 0.11, angleBias: 0, angleSpread: 0.5 });
      normalizeField(height);

      const paintCol = hexToRgb(painted ? 0x5c6165 : 0x8a8d90);
      const rustDark = hexToRgb(0x4a2a18);
      const rustLight = hexToRgb(0x9c5a2c);

      return bake(
        {
          res,
          height,
          normalStrength: 1.9,
          aoRadius: 2,
          aoStrength: 2.5,
          color: (i, _u, _v, h) => {
            let c = mixRgb(paintCol, mixRgb(paintCol, [200, 200, 205], 0.5), brushed[i] * 0.4 + h * 0.2);
            c = mixRgb(c, mixRgb(rustDark, rustLight, rust[i]), rustMask[i]);
            c = mixRgb(c, [30, 30, 32], Math.max(0, grime[i] - 0.58) * 0.9);
            return c;
          },
          roughness: (i) => Math.min(1, (painted ? 0.55 : 0.4) + rustMask[i] * 0.45 + grime[i] * 0.1),
          metalness: (i) => (painted ? 0.35 : 0.9) * (1 - rustMask[i] * 0.65),
        },
        this.anisotropy,
      );
    });
  }

  /** Diamond tread plate for catwalk decking - real raised pattern in the normal. */
  treadPlate(seed = 63): TextureSet {
    return this.memo(`tread${seed}`, () => {
      const res = 512;
      const wear = buildField(res, (u, v) => fbm2(u * 6, v * 6, 6, seed + 9, 3));
      const rust = buildField(res, (u, v) => fbm2(u * 10, v * 10, 10, seed + 55, 4));

      // Two offset rows of elongated diamonds, the standard checker-plate motif.
      const height = buildField(res, (u, v) => {
        const cell = 0.125;
        const row = Math.floor(v / cell);
        const offset = (row % 2) * 0.5;
        const fx = ((u / cell + offset) % 1) - 0.5;
        const fy = ((v / cell) % 1) - 0.5;
        // Rotated, elongated diamond (|x'| + |y'| < r).
        const angle = row % 2 === 0 ? 0.5 : -0.5;
        const rx = fx * Math.cos(angle) - fy * Math.sin(angle);
        const ry = fx * Math.sin(angle) + fy * Math.cos(angle);
        const d = Math.abs(rx * 1.25) + Math.abs(ry * 3.2);
        const bump = Math.max(0, 1 - d / 0.42);
        return Math.pow(bump, 0.55) * 0.85;
      });
      // Worn-down studs where boots land.
      for (let i = 0; i < height.length; i++) height[i] *= 0.65 + wear[i] * 0.5;
      const grain = buildField(res, (u, v) => valueNoise2(u * 200, v * 200, 200, seed + 2));
      for (let i = 0; i < height.length; i++) height[i] += grain[i] * 0.06;
      blurField(height, res, 1, 1);
      normalizeField(height);

      const plate = hexToRgb(0x6a6d70);
      const rustDark = hexToRgb(0x4d2d19);
      const rustLight = hexToRgb(0x8f5127);

      return bake(
        {
          res,
          height,
          normalStrength: 4.2,
          aoRadius: 3,
          aoStrength: 3.4,
          color: (i, _u, _v, h) => {
            const rm = Math.min(1, Math.max(0, rust[i] - 0.58) * 2.4);
            // Raised studs polish to bare metal, valleys stay dirty.
            let c = mixRgb(mixRgb(plate, [40, 40, 42], 0.45), mixRgb(plate, [190, 192, 195], 0.5), h);
            c = mixRgb(c, mixRgb(rustDark, rustLight, rust[i]), rm * 0.8);
            return c;
          },
          roughness: (i, _u, _v, h) => {
            const rm = Math.min(1, Math.max(0, rust[i] - 0.58) * 2.4);
            return Math.min(1, 0.72 - h * 0.3 + rm * 0.35);
          },
          metalness: (i) => 0.85 - Math.min(1, Math.max(0, rust[i] - 0.58) * 2.4) * 0.5,
        },
        this.anisotropy,
      );
    });
  }

  /** Corrugated sheet cladding for the warehouse walls. */
  corrugated(baseHex: number, seed = 77): TextureSet {
    return this.memo(`corr${baseHex}_${seed}`, () => {
      const res = 512;
      const rust = buildField(res, (u, v) => fbm2(u * 6, v * 6, 6, seed + 31, 4));
      const drip = buildField(res, (u, v) => fbm2(u * 14, v * 1.7, 14, seed + 63, 3));
      const dirt = buildField(res, (u, v) => fbm2(u * 2.5, v * 2.5, 2, seed + 19, 3));

      const rustMask = new Float32Array(res * res);
      for (let i = 0; i < rustMask.length; i++) {
        rustMask[i] = Math.min(1, Math.max(0, rust[i] - 0.62) * 2.2 + Math.max(0, drip[i] - 0.66) * 1.9);
      }

      // NO ribs in the texture: corrugatedPanel() displaces real geometry, and
      // two rib frequencies at different scales beat into heavy moire. The
      // texture only carries surface wear.
      const height = buildField(res, (u, v) => valueNoise2(u * 96, v * 96, 96, seed + 4) * 0.25);
      for (let i = 0; i < height.length; i++) height[i] = height[i] + rustMask[i] * 0.55;
      scratchField(height, res, 60, seed + 5, { length: 0.2, strength: 0.05 });
      normalizeField(height);

      const paint = hexToRgb(baseHex);
      const rustDark = hexToRgb(0x4a2b19);
      const rustLight = hexToRgb(0x96522a);

      return bake(
        {
          res,
          height,
          normalStrength: 1.6,
          aoRadius: 3,
          aoStrength: 2.2,
          color: (i, _u, v, h) => {
            let c = mixRgb(mixRgb(paint, [30, 30, 32], 0.18), paint, h * 0.4 + 0.6);
            c = mixRgb(c, mixRgb(rustDark, rustLight, rust[i]), rustMask[i]);
            // Ground splash-back darkens the bottom of every wall.
            c = mixRgb(c, [26, 25, 23], Math.max(0, 0.22 - v) * 2.6 * (0.4 + dirt[i]));
            return c;
          },
          roughness: (i) => Math.min(1, 0.62 + rustMask[i] * 0.34),
          metalness: (i) => 0.55 * (1 - rustMask[i] * 0.7),
        },
        this.anisotropy,
      );
    });
  }

  /** Weapon receiver: hard-anodised aluminium with edge wear and fine tooling. */
  gunMetal(seed = 101): TextureSet {
    return this.memo(`gunmetal${seed}`, () => {
      const res = 512;
      const wear = buildField(res, (u, v) => fbm2(u * 8, v * 8, 8, seed + 3, 4));
      const tooling = buildField(res, (u, v) => valueNoise2(u * 240, v * 8, 240, seed + 11));
      const speckle = buildField(res, (u, v) => 1 - worley2(u * 90, v * 90, 90, seed + 21));

      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) height[i] = tooling[i] * 0.06 + speckle[i] * 0.05;
      // Far fewer, far shallower scratches. A dense high-contrast height field
      // on a 95%-metallic surface produces per-pixel specular chaos rather than
      // "worn metal" - the normal has to stay close to flat.
      scratchField(height, res, 90, seed + 33, { length: 0.14, strength: 0.05 });
      blurField(height, res, 1, 1);
      normalizeField(height);

      const anodised = hexToRgb(0x33373b);
      const bare = hexToRgb(0xb9bcc0);

      return bake(
        {
          res,
          height,
          normalStrength: 0.45,
          aoRadius: 2,
          aoStrength: 1.4,
          color: (i, _u, _v, h) => {
            // Coating rubs off where the field noise peaks -> plausible wear.
            const worn = Math.max(0, wear[i] - 0.66) * 2.6 + Math.max(0, h - 0.86) * 1.2;
            return mixRgb(anodised, bare, Math.min(0.7, worn));
          },
          // Roughness floor of 0.28: a firearm receiver is bead-blasted, not
          // chromed, and anything shinier aliases badly at view-model distance.
          roughness: (i, _u, _v, h) => {
            const worn = Math.min(1, Math.max(0, wear[i] - 0.66) * 2.6);
            return Math.max(0.28, 0.52 - worn * 0.18 - h * 0.04);
          },
          metalness: () => 0.88,
        },
        this.anisotropy,
      );
    });
  }

  /** Weapon polymer: glass-filled nylon furniture, matte with a fine texture. */
  gunPolymer(seed = 131): TextureSet {
    return this.memo(`polymer${seed}`, () => {
      const res = 256;
      const stipple = buildField(res, (u, v) => 1 - worley2(u * 60, v * 60, 60, seed));
      const grain = buildField(res, (u, v) => fbm2(u * 30, v * 30, 30, seed + 7, 3));
      const scuff = buildField(res, (u, v) => fbm2(u * 6, v * 6, 6, seed + 13, 3));

      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) height[i] = stipple[i] * 0.35 + grain[i] * 0.2;
      blurField(height, res, 1, 1);
      normalizeField(height);

      const base = hexToRgb(0x2b2d2a);
      const lighter = hexToRgb(0x3f423c);

      return bake(
        {
          res,
          height,
          // Moulded polymer has a fine matte texture, not a rough sponge; a
          // strong normal here turned the stock into grey foam on screen.
          normalStrength: 0.6,
          aoRadius: 2,
          aoStrength: 1.2,
          color: (i, _u, _v, h) => mixRgb(base, lighter, h * 0.35 + Math.max(0, scuff[i] - 0.62) * 0.5),
          roughness: (i, _u, _v, h) => 0.78 - h * 0.12 - Math.max(0, scuff[i] - 0.65) * 0.2,
          metalness: () => 0.02,
        },
        this.anisotropy,
      );
    });
  }

  /** Rubberised grip / hand-stop material. */
  rubber(seed = 151): TextureSet {
    return this.memo(`rubber${seed}`, () => {
      const res = 256;
      // Moulded chevron grip pattern.
      const height = buildField(res, (u, v) => {
        const rows = 22;
        const y = v * rows;
        const row = Math.floor(y);
        const fy = y - row;
        const zig = Math.abs(((u * 10 + (row % 2) * 0.5) % 1) - 0.5) * 2;
        const band = Math.max(0, 1 - Math.abs(fy - zig * 0.4 - 0.3) * 4.5);
        return Math.pow(band, 0.8);
      });
      const grain = buildField(res, (u, v) => valueNoise2(u * 150, v * 150, 150, seed));
      for (let i = 0; i < height.length; i++) height[i] = height[i] * 0.8 + grain[i] * 0.12;
      blurField(height, res, 1, 1);
      normalizeField(height);

      const base = hexToRgb(0x24262a);
      return bake(
        {
          res,
          height,
          normalStrength: 1.5,
          aoRadius: 2,
          aoStrength: 1.8,
          color: (_i, _u, _v, h) => mixRgb(base, [58, 60, 62], h * 0.5),
          roughness: (_i, _u, _v, h) => 0.92 - h * 0.1,
          metalness: () => 0.0,
        },
        this.anisotropy,
      );
    });
  }

  /** Sandbag / tarpaulin fabric for cover and wind-driven cloth. */
  fabric(baseHex: number, seed = 181): TextureSet {
    return this.memo(`fabric${baseHex}_${seed}`, () => {
      const res = 256;
      const weaveH = buildField(res, (u) => Math.cos(u * Math.PI * 2 * 42) * 0.5 + 0.5);
      const weaveV = buildField(res, (_u, v) => Math.cos(v * Math.PI * 2 * 42) * 0.5 + 0.5);
      const dirt = buildField(res, (u, v) => fbm2(u * 5, v * 5, 5, seed + 3, 4));
      const height = new Float32Array(res * res);
      for (let i = 0; i < height.length; i++) height[i] = Math.max(weaveH[i], weaveV[i]) * 0.6 + dirt[i] * 0.3;
      normalizeField(height);

      const base = hexToRgb(baseHex);
      return bake(
        {
          res,
          height,
          normalStrength: 2.2,
          aoRadius: 2,
          aoStrength: 2.6,
          color: (i, _u, _v, h) => mixRgb(mixRgb(base, [22, 20, 18], 0.35), base, h * 0.6 + dirt[i] * 0.35),
          roughness: () => 0.95,
          metalness: () => 0,
        },
        this.anisotropy,
      );
    });
  }

  // ---------------------------------------------------------------------
  // Single-purpose alpha / mask textures
  // ---------------------------------------------------------------------

  /** Soft radial sprite used by smoke, flash glow and light shafts. */
  radialSprite(key = 'radial', power = 2.2, inner = 0.0): THREE.DataTexture {
    return this.memoExtra(`radial_${key}_${power}_${inner}`, () => {
      const res = 128;
      const data = new Uint8ClampedArray(res * res * 4);
      const c = (res - 1) / 2;
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const d = Math.hypot(x - c, y - c) / c;
          const a = Math.pow(Math.max(0, 1 - Math.max(0, d - inner) / (1 - inner)), power);
          const i = (y * res + x) * 4;
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = a * 255;
        }
      }
      return this.makeSprite(res, data);
    });
  }

  /** Puffy, lit smoke sprite - fbm inside a radial falloff. */
  smokeSprite(seed = 7): THREE.DataTexture {
    return this.memoExtra(`smoke${seed}`, () => {
      const res = 128;
      const data = new Uint8ClampedArray(res * res * 4);
      const c = (res - 1) / 2;
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const u = x / res;
          const v = y / res;
          const d = Math.hypot(x - c, y - c) / c;
          const n = fbm2(u * 5, v * 5, 5, seed, 4);
          const falloff = Math.pow(Math.max(0, 1 - d), 1.6);
          const a = Math.max(0, falloff * (0.45 + n * 0.9) - 0.06);
          const i = (y * res + x) * 4;
          // Slight internal shading so the puff is not a flat blob.
          const lum = 190 + n * 65;
          data[i] = lum;
          data[i + 1] = lum;
          data[i + 2] = lum;
          data[i + 3] = Math.min(1, a) * 255;
        }
      }
      return this.makeSprite(res, data);
    });
  }

  /** Bullet hole decal: crater ring + spall, alpha-masked. */
  bulletHole(kind: 'concrete' | 'metal' | 'glass', seed = 3): THREE.DataTexture {
    return this.memoExtra(`hole_${kind}${seed}`, () => {
      const res = 128;
      const data = new Uint8ClampedArray(res * res * 4);
      const c = (res - 1) / 2;
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const u = x / res;
          const v = y / res;
          const dx = (x - c) / c;
          const dy = (y - c) / c;
          const d = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          // Irregular rim so no two holes look stamped.
          const wob = fbm2(Math.cos(angle) * 2 + 3, Math.sin(angle) * 2 + 3, 8, seed, 3);
          const holeR = kind === 'glass' ? 0.16 : 0.2 + wob * 0.1;
          const spallR = kind === 'metal' ? 0.42 : 0.68;
          const n = fbm2(u * 7, v * 7, 7, seed + 21, 4);

          let alpha = 0;
          let lum = 0;
          if (d < holeR) {
            alpha = 1;
            lum = kind === 'metal' ? 26 : 14;
          } else if (d < spallR) {
            const t = (d - holeR) / (spallR - holeR);
            alpha = Math.pow(1 - t, 1.7) * (0.55 + n * 0.7);
            lum = kind === 'metal' ? 150 - t * 90 : 190 - t * 120;
            if (kind === 'metal') lum *= 1.15;
          }
          // Radial cracks for glass.
          if (kind === 'glass' && d < 0.9) {
            const spokes = Math.abs(Math.sin(angle * 7 + wob * 6));
            if (spokes > 0.86) {
              alpha = Math.max(alpha, (1 - d) * 0.85);
              lum = 225;
            }
          }
          const i = (y * res + x) * 4;
          data[i] = lum;
          data[i + 1] = lum * 0.98;
          data[i + 2] = lum * 0.95;
          data[i + 3] = Math.min(1, alpha) * 255;
        }
      }
      return this.makeSprite(res, data, THREE.SRGBColorSpace);
    });
  }

  /** Scorch mark left by explosions. */
  scorch(seed = 9): THREE.DataTexture {
    return this.memoExtra(`scorch${seed}`, () => {
      const res = 128;
      const data = new Uint8ClampedArray(res * res * 4);
      const c = (res - 1) / 2;
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const u = x / res;
          const v = y / res;
          const d = Math.hypot((x - c) / c, (y - c) / c);
          const n = fbm2(u * 4, v * 4, 4, seed, 4);
          const edge = Math.max(0, 1 - d / (0.55 + n * 0.45));
          const a = Math.pow(edge, 1.5) * (0.5 + n * 0.6);
          const i = (y * res + x) * 4;
          const lum = 18 + n * 26;
          data[i] = lum;
          data[i + 1] = lum * 0.92;
          data[i + 2] = lum * 0.85;
          data[i + 3] = Math.min(1, a) * 255;
        }
      }
      return this.makeSprite(res, data, THREE.SRGBColorSpace);
    });
  }

  /** Chain-link fence alpha sheet - real transparency beats modelled wire. */
  chainLink(seed = 13): THREE.DataTexture {
    return this.memoExtra(`chain${seed}`, () => {
      const res = 256;
      const data = new Uint8ClampedArray(res * res * 4);
      const cells = 12;
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const u = (x / res) * cells;
          const v = (y / res) * cells;
          const fu = u - Math.floor(u);
          const fv = v - Math.floor(v);
          // Two diagonal wire families woven together.
          const d1 = Math.abs(fu - fv);
          const d2 = Math.abs(fu + fv - 1);
          const w = 0.14;
          const wire = Math.max(0, 1 - Math.min(d1, d2) / w);
          const alpha = wire > 0.02 ? Math.min(1, wire * 2.2) : 0;
          // Shade the wire so it catches light instead of reading as a sticker.
          const shade = 0.45 + Math.min(d1, d2) * 2.2;
          const rustN = fbm2(x / res * 6, y / res * 6, 6, seed, 3);
          const lum = (110 * shade) * (1 - rustN * 0.35);
          const i = (y * res + x) * 4;
          data[i] = lum * (1 + rustN * 0.5);
          data[i + 1] = lum * (1 - rustN * 0.1);
          data[i + 2] = lum * (1 - rustN * 0.3);
          data[i + 3] = alpha * 255;
        }
      }
      return this.makeSprite(res, data, THREE.SRGBColorSpace, true);
    });
  }

  /** Grating alpha for catwalk floors seen from below. */
  grating(): THREE.DataTexture {
    return this.memoExtra('grating', () => {
      const res = 128;
      const data = new Uint8ClampedArray(res * res * 4);
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const u = (x / res) * 10;
          const v = (y / res) * 3;
          const barU = Math.abs((u - Math.floor(u)) - 0.5) * 2;
          const barV = Math.abs((v - Math.floor(v)) - 0.5) * 2;
          const solid = barU > 0.62 || barV > 0.82 ? 1 : 0;
          const i = (y * res + x) * 4;
          const lum = solid ? 120 - barU * 30 : 0;
          data[i] = lum;
          data[i + 1] = lum;
          data[i + 2] = lum;
          data[i + 3] = solid * 255;
        }
      }
      return this.makeSprite(res, data, THREE.SRGBColorSpace, true);
    });
  }

  /** Small hazard-stripe strip used on kerbs, bollards and door frames. */
  hazardStripe(): THREE.DataTexture {
    return this.memoExtra('hazard', () => {
      const res = 128;
      const data = new Uint8ClampedArray(res * res * 4);
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const s = ((x + y) / res) * 6;
          const band = s - Math.floor(s) < 0.5 ? 1 : 0;
          const wear = fbm2((x / res) * 8, (y / res) * 8, 8, 5, 3);
          const i = (y * res + x) * 4;
          const yellow: Rgb = [196, 150, 22];
          const dark: Rgb = [30, 30, 32];
          const c = mixRgb(band ? yellow : dark, [70, 66, 60], Math.max(0, wear - 0.55) * 1.6);
          data[i] = c[0];
          data[i + 1] = c[1];
          data[i + 2] = c[2];
          data[i + 3] = 255;
        }
      }
      return this.makeSprite(res, data, THREE.SRGBColorSpace);
    });
  }

  private memoExtra(key: string, build: () => THREE.DataTexture): THREE.DataTexture {
    let tex = this.extra.get(key);
    if (!tex) {
      tex = build();
      this.extra.set(key, tex);
    }
    return tex;
  }

  private makeSprite(
    res: number,
    data: Uint8ClampedArray,
    colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
    repeat = false,
  ): THREE.DataTexture {
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    tex.colorSpace = colorSpace;
    tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;
    return tex;
  }

  dispose(): void {
    for (const set of this.cache.values()) {
      set.map.dispose();
      set.normalMap.dispose();
      set.ormMap.dispose();
    }
    for (const tex of this.extra.values()) tex.dispose();
    this.cache.clear();
    this.extra.clear();
  }
}
