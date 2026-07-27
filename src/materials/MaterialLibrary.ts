import * as THREE from 'three';
import type { SurfaceKind } from '@/core/EventBus';
import { applyFogUniforms } from './FogPatch';
import type { TextureFactory, TextureSet } from './TextureFactory';

/**
 * Central registry of every surface material in the slice.
 *
 * Rules enforced here:
 *  - one MeshStandardMaterial per surface type (shared across all meshes) so
 *    the renderer can batch and the draw-call count stays low;
 *  - every material carries a `userData.surface` tag which the ballistics
 *    system reads to pick impact VFX and audio - the material IS the surface
 *    definition, there is no parallel lookup table to keep in sync;
 *  - textures are cloned (not re-baked) when a different UV tiling is needed.
 */

export type MaterialKey =
  | 'concrete'
  | 'concreteWall'
  | 'asphalt'
  | 'containerRed'
  | 'containerBlue'
  | 'containerGreen'
  | 'containerRust'
  | 'steelPainted'
  | 'steelBare'
  | 'tread'
  | 'claddingPale'
  | 'claddingRust'
  | 'rubber'
  | 'tarp'
  | 'sandbag'
  | 'glass'
  | 'plasticWhite'
  | 'copper'
  | 'gunMetal'
  | 'gunPolymer'
  | 'gunRubber';

interface SurfaceMaterial extends THREE.MeshStandardMaterial {
  userData: { surface: SurfaceKind };
}

/** Clone a texture set so a mesh can use its own repeat without re-baking. */
function tiled(set: TextureSet, repeatX: number, repeatY: number): TextureSet {
  const clone = <T extends THREE.Texture>(tex: T): T => {
    const c = tex.clone() as T;
    c.wrapS = THREE.RepeatWrapping;
    c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(repeatX, repeatY);
    c.needsUpdate = true;
    return c;
  };
  return { map: clone(set.map), normalMap: clone(set.normalMap), ormMap: clone(set.ormMap) };
}

export class MaterialLibrary {
  private materials = new Map<string, THREE.Material>();
  private clonedTextures: THREE.Texture[] = [];
  private envIntensity = 1;

  constructor(private readonly textures: TextureFactory) {}

  /** Global environment-probe contribution. Driven by the debug panel. */
  setEnvIntensity(value: number): void {
    this.envIntensity = value;
    for (const mat of this.materials.values()) {
      if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        (mat as THREE.MeshStandardMaterial).envMapIntensity = value;
      }
    }
  }

  /**
   * Global wetness. Multiplies roughness down and bumps reflectivity on
   * horizontal-ish surfaces. Applied as a uniform scalar per material rather
   * than per-pixel because the ground handles its own puddle mask.
   */
  setWetness(amount: number): void {
    const wetKeys: MaterialKey[] = ['concrete', 'asphalt', 'concreteWall', 'steelPainted', 'tread'];
    for (const key of wetKeys) {
      const mat = this.materials.get(key) as THREE.MeshStandardMaterial | undefined;
      if (!mat) continue;
      const dry = (mat.userData.dryRoughness as number | undefined) ?? mat.roughness;
      mat.userData.dryRoughness = dry;
      mat.roughness = THREE.MathUtils.lerp(dry, dry * 0.35, amount);
    }
  }

  private register<T extends THREE.Material>(key: string, material: T): T {
    material.name = key;
    applyFogUniforms(material);
    if ((material as unknown as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      (material as unknown as THREE.MeshStandardMaterial).envMapIntensity = this.envIntensity;
    }
    this.materials.set(key, material);
    return material;
  }

  private standard(
    key: string,
    set: TextureSet,
    surface: SurfaceKind,
    // normalScale is exposed as a scalar here (three wants a Vector2) because
    // every surface in this project scales both axes together.
    overrides: Omit<Partial<THREE.MeshStandardMaterialParameters>, 'normalScale'> & {
      normalScale?: number;
    } = {},
  ): SurfaceMaterial {
    const existing = this.materials.get(key);
    if (existing) return existing as SurfaceMaterial;
    const { normalScale, ...rest } = overrides;
    const mat = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      // ORM packing: three reads AO from .r, roughness from .g, metalness .b.
      aoMap: set.ormMap,
      roughnessMap: set.ormMap,
      metalnessMap: set.ormMap,
      roughness: 1,
      metalness: 1,
      aoMapIntensity: 1,
      dithering: true,
      ...rest,
    }) as SurfaceMaterial;
    mat.normalScale.setScalar(normalScale ?? 1);
    mat.userData = { surface };
    return this.register(key, mat);
  }

  // -------------------------------------------------------------------
  // Environment materials
  // -------------------------------------------------------------------

  concrete(): SurfaceMaterial {
    return this.standard('concrete', this.trackSet(tiled(this.textures.concrete(), 6, 6)), 'concrete', {
      normalScale: 1.1,
    });
  }

  concreteWall(): SurfaceMaterial {
    return this.standard(
      'concreteWall',
      this.trackSet(tiled(this.textures.concrete(23), 3, 2)),
      'concrete',
      { normalScale: 1.25 },
    );
  }

  asphalt(): SurfaceMaterial {
    return this.standard('asphalt', this.trackSet(tiled(this.textures.asphalt(), 8, 8)), 'concrete', {
      normalScale: 0.9,
    });
  }

  container(variant: 'Red' | 'Blue' | 'Green' | 'Rust'): SurfaceMaterial {
    const palette = { Red: 0x8c3529, Blue: 0x2b4f6b, Green: 0x3d5240, Rust: 0x6b4230 };
    const seeds = { Red: 5, Blue: 15, Green: 25, Rust: 35 };
    return this.standard(
      `container${variant}`,
      this.trackSet(tiled(this.textures.containerPaint(palette[variant], seeds[variant]), 2, 1)),
      'thinMetal',
      { normalScale: 1.15 },
    );
  }

  steelPainted(): SurfaceMaterial {
    return this.standard('steelPainted', this.trackSet(tiled(this.textures.steel(41, true), 2, 2)), 'metal', {
      normalScale: 1.0,
    });
  }

  steelBare(): SurfaceMaterial {
    return this.standard('steelBare', this.trackSet(tiled(this.textures.steel(53, false), 2, 2)), 'metal', {
      normalScale: 1.0,
    });
  }

  tread(): SurfaceMaterial {
    return this.standard('tread', this.trackSet(tiled(this.textures.treadPlate(), 3, 3)), 'metal', {
      normalScale: 1.4,
    });
  }

  cladding(variant: 'Pale' | 'Rust'): SurfaceMaterial {
    const hex = variant === 'Pale' ? 0x8a8f8c : 0x6f5a4a;
    return this.standard(
      `cladding${variant}`,
      this.trackSet(tiled(this.textures.corrugated(hex, variant === 'Pale' ? 77 : 87), 4, 3)),
      'thinMetal',
      { normalScale: 1.3 },
    );
  }

  rubber(): SurfaceMaterial {
    return this.standard('rubber', this.trackSet(tiled(this.textures.rubber(), 2, 2)), 'wood', {
      normalScale: 1.0,
    });
  }

  tarp(): SurfaceMaterial {
    return this.standard('tarp', this.trackSet(tiled(this.textures.fabric(0x4a4433, 181), 2, 2)), 'wood', {
      side: THREE.DoubleSide,
      normalScale: 1.0,
    });
  }

  sandbag(): SurfaceMaterial {
    return this.standard('sandbag', this.trackSet(tiled(this.textures.fabric(0x6b6047, 191), 1, 1)), 'sand', {
      normalScale: 1.2,
    });
  }

  glass(): THREE.MeshPhysicalMaterial {
    const existing = this.materials.get('glass');
    if (existing) return existing as THREE.MeshPhysicalMaterial;
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x1c2429,
      roughness: 0.12,
      metalness: 0,
      transmission: 0,
      opacity: 0.42,
      transparent: true,
      // A strong clearcoat gives dirty industrial glazing its greasy sheen
      // without paying for real transmission.
      clearcoat: 1,
      clearcoatRoughness: 0.25,
      reflectivity: 0.6,
      side: THREE.DoubleSide,
    });
    mat.userData = { surface: 'glass' as SurfaceKind };
    return this.register('glass', mat);
  }

  plasticWhite(): SurfaceMaterial {
    const existing = this.materials.get('plasticWhite');
    if (existing) return existing as SurfaceMaterial;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xa8a49c,
      roughness: 0.55,
      metalness: 0.02,
    }) as SurfaceMaterial;
    mat.userData = { surface: 'wood' };
    return this.register('plasticWhite', mat);
  }

  copper(): SurfaceMaterial {
    const existing = this.materials.get('copper');
    if (existing) return existing as SurfaceMaterial;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb87333,
      roughness: 0.38,
      metalness: 1,
    }) as SurfaceMaterial;
    mat.userData = { surface: 'metal' };
    return this.register('copper', mat);
  }

  /** Chain-link fence: alpha-tested sheet, no shadow casting (too noisy). */
  chainLink(): THREE.MeshStandardMaterial {
    const existing = this.materials.get('chainLink');
    if (existing) return existing as THREE.MeshStandardMaterial;
    const tex = this.textures.chainLink();
    const map = tex.clone();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.needsUpdate = true;
    this.clonedTextures.push(map);
    const mat = new THREE.MeshStandardMaterial({
      map,
      alphaMap: map,
      transparent: false,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0.75,
      color: 0x9aa0a4,
    });
    mat.userData = { surface: 'fence' as SurfaceKind };
    return this.register('chainLink', mat);
  }

  grating(): THREE.MeshStandardMaterial {
    const existing = this.materials.get('grating');
    if (existing) return existing as THREE.MeshStandardMaterial;
    const map = this.textures.grating().clone();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(4, 4);
    map.needsUpdate = true;
    this.clonedTextures.push(map);
    const mat = new THREE.MeshStandardMaterial({
      map,
      alphaMap: map,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.72,
      metalness: 0.8,
      color: 0x7f8386,
    });
    mat.userData = { surface: 'metal' as SurfaceKind };
    return this.register('grating', mat);
  }

  hazard(): SurfaceMaterial {
    const existing = this.materials.get('hazard');
    if (existing) return existing as SurfaceMaterial;
    const map = this.textures.hazardStripe().clone();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(4, 1);
    map.needsUpdate = true;
    this.clonedTextures.push(map);
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.68,
      metalness: 0.25,
    }) as SurfaceMaterial;
    mat.userData = { surface: 'metal' };
    return this.register('hazard', mat);
  }

  // -------------------------------------------------------------------
  // Weapon materials (higher texel density, tighter tiling)
  // -------------------------------------------------------------------

  gunMetal(): SurfaceMaterial {
    return this.standard('gunMetal', this.trackSet(tiled(this.textures.gunMetal(), 1.5, 1.5)), 'metal', {
      normalScale: 0.85,
    });
  }

  gunPolymer(): SurfaceMaterial {
    return this.standard('gunPolymer', this.trackSet(tiled(this.textures.gunPolymer(), 2, 2)), 'wood', {
      normalScale: 0.9,
    });
  }

  gunRubber(): SurfaceMaterial {
    return this.standard('gunRubber', this.trackSet(tiled(this.textures.rubber(157), 1.5, 1.5)), 'wood', {
      normalScale: 1.1,
    });
  }

  /** Emissive material for lamps, screens and tracers. */
  emissive(key: string, color: number, intensity: number, opts: { toneMapped?: boolean } = {}): THREE.MeshStandardMaterial {
    const cacheKey = `emissive_${key}`;
    const existing = this.materials.get(cacheKey);
    if (existing) return existing as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.4,
      metalness: 0,
      toneMapped: opts.toneMapped ?? true,
      fog: true,
    });
    mat.userData = { surface: 'glass' as SurfaceKind };
    return this.register(cacheKey, mat);
  }

  get(key: string): THREE.Material | undefined {
    return this.materials.get(key);
  }

  private trackSet(set: TextureSet): TextureSet {
    this.clonedTextures.push(set.map, set.normalMap, set.ormMap);
    return set;
  }

  dispose(): void {
    for (const tex of this.clonedTextures) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.clonedTextures.length = 0;
    this.materials.clear();
  }
}
