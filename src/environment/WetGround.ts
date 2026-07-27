import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { Rng } from '@/core/Rng';
import { applyFogUniforms } from '@/materials/FogPatch';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';
import type { CollisionWorld } from '@/physics/CollisionWorld';

/**
 * The wet dock apron: standing water, planar reflections and live ripples.
 *
 * This is the highest-value single feature in the scene. A dry grey plane
 * kills the "after the storm" premise instantly; standing water doubles the
 * apparent lighting complexity for one extra render pass because every
 * floodlight, every muzzle flash and the whole sky get a second appearance.
 *
 * Construction:
 *   - MeshStandardMaterial (so it keeps real PBR, shadows and our fog patch),
 *     extended through onBeforeCompile rather than replaced. Writing a bespoke
 *     shader here would mean re-implementing shadow mapping and IBL.
 *   - A procedural puddle mask drives roughness toward mirror-smooth and
 *     swaps the concrete normal for an animated water normal.
 *   - Planar reflection = the scene re-rendered from the camera mirrored
 *     through the water plane, sampled in screen space (exact for a flat
 *     mirror) and distorted by the ripple normal.
 *   - Rain rings are spawned procedurally inside the shader from a hashed
 *     grid, so drizzle intensity is a single uniform with no CPU cost.
 */
export class WetGround {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;

  private reflectionRT: THREE.WebGLRenderTarget | null = null;
  private reflectionCamera = new THREE.PerspectiveCamera();
  private reflectionMatrix = new THREE.Matrix4();
  private puddleTexture: THREE.DataTexture;
  private uniforms: Record<string, THREE.IUniform>;
  private quality: QualitySettings;
  private enabled = true;
  /** Objects hidden while rendering the mirrored view (ground, VFX, HUD-ish). */
  private hiddenDuringReflection: THREE.Object3D[] = [];
  private ownedTextures: THREE.Texture[] = [];
  private screenWidth = 1280;
  private screenHeight = 720;
  /**
   * Global clip plane used ONLY during the mirrored pass.
   *
   * Without it, every object below the water plane gets mirrored to above it
   * and appears in the reflection. The 900x900m sea plane at y = -1.35 was
   * being folded up to y = +1.35 and filling most of the reflection with flat
   * water colour, which is what produced the hard horizontal seam across the
   * deck and made the reflections look like a solid tint rather than an image.
   *
   * The plane stays in `renderer.clippingPlanes` permanently and is disabled by
   * pushing its constant out of range - changing the ARRAY LENGTH would force
   * every material in the scene to recompile, every frame.
   */
  private readonly clipPlane: THREE.Plane;
  private static readonly CLIP_DISABLED = 1e5;

  constructor(
    materials: MaterialLibrary,
    private visual: MutableVisual,
    quality: QualitySettings,
    private readonly waterLevel = 0,
    private readonly size = 220,
  ) {
    this.quality = quality;
    this.puddleTexture = buildPuddleMask(512);
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), WetGround.CLIP_DISABLED);

    const base = materials.asphalt();
    this.material = base.clone() as THREE.MeshStandardMaterial;
    this.material.name = 'wetApron';
    this.material.userData = { surface: 'concrete' };
    // The apron is the largest single surface in the scene, so it gets its own
    // tiling: ~1.4m per tile keeps the aggregate at a believable grain size
    // without visible repetition at the far end of the berth.
    for (const map of [this.material.map, this.material.normalMap, this.material.roughnessMap]) {
      if (!map) continue;
      const own = map.clone();
      own.wrapS = own.wrapT = THREE.RepeatWrapping;
      own.repeat.set(0.7, 0.7);
      own.needsUpdate = true;
      if (map === this.material.map) this.material.map = own;
      else if (map === this.material.normalMap) this.material.normalMap = own;
      else {
        this.material.roughnessMap = own;
        this.material.metalnessMap = own;
        this.material.aoMap = own;
      }
      this.ownedTextures.push(own);
    }

    this.uniforms = {
      uPuddleMask: { value: this.puddleTexture },
      uReflection: { value: null },
      uReflectionStrength: { value: 0.92 },
      uHasReflection: { value: 0 },
      uTime: { value: 0 },
      uRippleSpeed: { value: 1.1 },
      uRippleStrength: { value: 0.35 },
      uRainAmount: { value: 0.28 },
      uWetness: { value: 0.82 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      /** Expanding rings pushed by gameplay: footsteps, impacts, explosions. */
      uImpacts: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      /**
       * Diagnostic view, enabled with ?wetdebug=mask|rough|reflect.
       * Standing water is authored through three interacting fields (mask,
       * roughness, reflection) and guessing which one is misbehaving from the
       * final image does not work - this shows each one directly.
       */
      uDebugMode: { value: debugModeFromUrl() },
    };

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n\tvGroundWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${GROUND_PARS}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${GROUND_MASK}`)
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n\t// Water roughness varies with the fine surface field and with local chop,\n\t// so a pool has calm mirror-like centres and duller, wind-ruffled edges\n\t// instead of being one flat mirror.\n\tfloat gViewDist = length( vViewPosition );\n\t// Roughness also grows with DISTANCE: a far water surface covers many\n\t// ripples per pixel so it is physically rougher at that scale, and a\n\t// mirror-smooth surface at a grazing angle aliases badly. It also softens\n\t// the abrupt boundary where the deck passes out from under the loading-bay\n\t// canopy and starts reflecting open sky instead of roof.\n\tfloat gWaterRough = clamp( 0.018 + gSurface * 0.075 + gChop * 1.6 + gViewDist * 0.0035 + ( 1.0 - gDepthAmt ) * 0.16, 0.012, 0.40 );\n\troughnessFactor = mix( roughnessFactor * ( 1.0 - uWetness * 0.45 ), gWaterRough, gPuddle * mix( 0.55, 1.0, gDepthAmt ) );',
        )
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GROUND_NORMAL}`)
        .replace('#include <opaque_fragment>', `${GROUND_REFLECTION}\n#include <opaque_fragment>`);
    };
    applyFogUniforms(this.material);

    // A modest subdivision lets the far apron pick up the vertex-interpolated
    // fog gradient smoothly; the plane itself stays flat.
    const geometry = new THREE.PlaneGeometry(size, size, 32, 32);
    geometry.rotateX(-Math.PI / 2);
    // Metre UVs, matching applyBoxUv() and corrugatedPanel(). The tile density
    // is then owned entirely by the texture's own `repeat`, set below.
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, pos.getX(i), pos.getZ(i));
    }
    uv.needsUpdate = true;

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'WetApron';
    this.mesh.position.y = waterLevel;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.layers.set(LAYER.WORLD);
    this.hiddenDuringReflection.push(this.mesh);

    this.setQuality(quality);
    this.refresh();
  }

  /** Extra objects to hide in the mirrored pass (particles, decals, etc). */
  excludeFromReflection(object: THREE.Object3D): void {
    this.hiddenDuringReflection.push(object);
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.reflectionRT?.dispose();
    this.reflectionRT = null;
    if (!quality.planarReflection) {
      this.uniforms.uHasReflection.value = 0;
      return;
    }
    // MUST match the main framebuffer's aspect: the reflection is sampled with
    // normalised screen coordinates, so a target with a different shape maps
    // the mirrored image onto the deck stretched.
    const aspect = this.screenWidth / Math.max(this.screenHeight, 1);
    const height = Math.max(64, Math.round(720 * quality.reflectionScale));
    const width = Math.max(64, Math.round(height * aspect));
    this.reflectionRT = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.uniforms.uReflection.value = this.reflectionRT.texture;
    this.uniforms.uHasReflection.value = 1;
  }

  refresh(): void {
    const w = this.visual.wetness;
    this.uniforms.uReflectionStrength.value = w.puddleReflectivity;
    this.uniforms.uRippleSpeed.value = w.rippleSpeed;
    this.uniforms.uRippleStrength.value = w.rippleStrength;
    this.uniforms.uRainAmount.value = w.rainAmount;
    this.uniforms.uWetness.value = w.global;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.uniforms.uHasReflection.value = value && this.reflectionRT ? 1 : 0;
  }

  /** Registers the apron as a flat collision floor. */
  registerCollision(world: CollisionWorld): void {
    world.addBox(
      new THREE.Vector3(-this.size / 2, this.waterLevel - 1, -this.size / 2),
      new THREE.Vector3(this.size / 2, this.waterLevel, this.size / 2),
      'concrete',
      true,
    );
    world.addRaycastTarget(this.mesh);
  }

  private impactCursor = 0;

  /** Spawns an expanding ripple ring. Radius grows in the shader. */
  addRipple(x: number, z: number, strength = 1, speed = 2.6): void {
    const arr = this.uniforms.uImpacts.value as THREE.Vector4[];
    const v = arr[this.impactCursor];
    // xy = position, z = birth time, w = strength (negative speed packed in)
    v.set(x, z, this.uniforms.uTime.value as number, strength * speed);
    this.impactCursor = (this.impactCursor + 1) % arr.length;
  }

  update(elapsed: number): void {
    this.uniforms.uTime.value = elapsed;
  }

  /**
   * Renders the mirrored view. Must run BEFORE the main scene render.
   * Costs one extra scene pass; disabled entirely on the low preset.
   */
  renderReflection(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): void {
    if (!this.enabled || !this.reflectionRT || !this.quality.planarReflection) return;

    const rc = this.reflectionCamera;
    rc.copy(camera);
    rc.layers.set(LAYER.WORLD);
    // Mirror the camera transform through the plane y = waterLevel.
    this.reflectionMatrix.makeTranslation(0, -this.waterLevel, 0);
    this.reflectionMatrix.premultiply(new THREE.Matrix4().makeScale(1, -1, 1));
    this.reflectionMatrix.premultiply(new THREE.Matrix4().makeTranslation(0, this.waterLevel, 0));
    rc.matrixAutoUpdate = false;
    rc.matrixWorld.copy(camera.matrixWorld).premultiply(this.reflectionMatrix);
    rc.matrixWorldInverse.copy(rc.matrixWorld).invert();
    rc.projectionMatrix.copy(camera.projectionMatrix);
    rc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    // Mirroring flips handedness; without this the reflection culls inside-out.
    const previousSide = renderer.getRenderTarget();

    for (const obj of this.hiddenDuringReflection) obj.visible = false;

    const previousShadowAuto = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;

    // Clip everything below the water line for this pass only.
    if (!renderer.clippingPlanes.includes(this.clipPlane)) {
      renderer.clippingPlanes = [...renderer.clippingPlanes, this.clipPlane];
    }
    this.clipPlane.constant = -this.waterLevel + 0.02;

    renderer.setRenderTarget(this.reflectionRT);
    // Clear to the scene's fog colour, not to black. At grazing angles a real
    // reflection shows distant haze, so where the clipped geometry leaves a
    // gap near the reflected horizon the correct answer is atmosphere.
    const fog = scene.fog as THREE.FogExp2 | null;
    renderer.getClearColor(tmpClearColor);
    const previousClearAlpha = renderer.getClearAlpha();
    if (fog) renderer.setClearColor(fog.color, 1);
    renderer.clear(true, true, false);
    // Mirrored geometry winds backwards; flip the front face for this pass.
    const previousFlip = (renderer as unknown as { _reflectionFlip?: boolean })._reflectionFlip;
    void previousFlip;
    const gl = renderer.getContext();
    gl.frontFace(gl.CW);
    renderer.render(scene, rc);
    gl.frontFace(gl.CCW);

    // Disable the clip plane again by pushing it out of range (never remove it
    // from the array - that would recompile every material).
    this.clipPlane.constant = WetGround.CLIP_DISABLED;
    renderer.setClearColor(tmpClearColor, previousClearAlpha);
    renderer.setRenderTarget(previousSide);
    renderer.shadowMap.needsUpdate = previousShadowAuto;

    for (const obj of this.hiddenDuringReflection) obj.visible = true;

  }

  /** Main framebuffer size in device pixels - gl_FragCoord is measured in it. */
  setScreenSize(width: number, height: number): void {
    (this.uniforms.uResolution.value as THREE.Vector2).set(width, height);
    const aspectChanged =
      Math.abs(width / Math.max(height, 1) - this.screenWidth / Math.max(this.screenHeight, 1)) > 0.01;
    this.screenWidth = width;
    this.screenHeight = height;
    // Rebuild the reflection target when the viewport shape changes.
    if (aspectChanged && this.reflectionRT) this.setQuality(this.quality);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const tex of this.ownedTextures) tex.dispose();
    this.ownedTextures.length = 0;
    this.puddleTexture.dispose();
    this.reflectionRT?.dispose();
  }
}

/** ?wetdebug=mask|rough|reflect -> 1 | 2 | 3, otherwise 0. */
function debugModeFromUrl(): number {
  const mode = new URLSearchParams(window.location.search).get('wetdebug');
  if (mode === 'mask') return 1;
  if (mode === 'rough') return 2;
  if (mode === 'reflect') return 3;
  return 0;
}

/**
 * Puddle mask. Standing water collects in broad shallow depressions with
 * hard-ish edges, not in soft blobs - the mask is a thresholded low-frequency
 * fbm, then eroded slightly so puddle rims stay crisp.
 */
function buildPuddleMask(res: number): THREE.DataTexture {
  const rng = new Rng(0x9a11e2);
  const seedA = rng.int(0, 9999);
  const seedB = rng.int(0, 9999);
  const data = new Uint8ClampedArray(res * res * 4);

  const hash = (x: number, y: number, s: number): number => {
    const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const noise = (x: number, y: number, period: number, s: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const w = (t: number): number => t * t * (3 - 2 * t);
    const p = (v: number): number => ((v % period) + period) % period;
    const a = hash(p(xi), p(yi), s);
    const b = hash(p(xi + 1), p(yi), s);
    const c = hash(p(xi), p(yi + 1), s);
    const d = hash(p(xi + 1), p(yi + 1), s);
    return (
      (a * (1 - w(xf)) + b * w(xf)) * (1 - w(yf)) + (c * (1 - w(xf)) + d * w(xf)) * w(yf)
    );
  };
  const fbm = (x: number, y: number, period: number, s: number, octaves: number): number => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    let per = period;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * freq, y * freq, per, s + i * 17) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
      per *= 2;
    }
    return sum / norm;
  };

  const seedC = rng.int(0, 9999);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const u = x / res;
      const v = y / res;

      // DOMAIN WARP. Straight fbm produces round, evenly-spaced blobs that read
      // as procedural noise. Warping the sample position with a second noise
      // field before thresholding gives lobed, interlocking pools with the
      // uneven outlines standing water actually has. The warp field is itself
      // periodic, so the mask still tiles.
      const warpU = fbm(u * 2, v * 2, 2, seedC, 3) - 0.5;
      const warpV = fbm(u * 2 + 0.37, v * 2 + 0.71, 2, seedC + 61, 3) - 0.5;
      const wu = u * 3 + warpU * 1.15;
      const wv = v * 3 + warpV * 1.15;

      const broad = fbm(wu, wv, 3, seedA, 4);
      const detail = fbm(u * 11, v * 11, 11, seedB, 3);

      // fbm output clusters tightly around 0.5, which makes the threshold
      // hypersensitive. Stretch the distribution so "water level" is a
      // controllable number rather than a knife edge.
      const depth = (broad - 0.5) * 1.9 + 0.5;

      // STORE THE HEIGHT FIELD, NOT A THRESHOLDED MASK.
      //
      // This is the single most important line in the file. Storing a
      // pre-thresholded 0/1 puddle mask looks correct up close, but mipmaps
      // AVERAGE it: at distance every texel becomes the local coverage
      // fraction (~0.4), so the far deck reads as "40% puddle everywhere"
      // while the near deck still has crisp pools - and the mip transition
      // between the two draws a hard horizontal line across the screen.
      //
      // Storing the smooth depth field instead means mipmaps blur the FIELD
      // (which is correct and harmless) and the threshold is applied per-pixel
      // in the shader, so waterlines stay crisp at any distance.
      const i = (y * res + x) * 4;
      data[i] = Math.max(0, Math.min(1, depth)) * 255;
      data[i + 1] = detail * 255;
      // Fine surface variation, used to break up the water roughness so the
      // pools are not uniformly mirror-smooth.
      data[i + 2] = fbm(u * 23, v * 23, 23, seedB + 5, 2) * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const GROUND_PARS = /* glsl */ `
varying vec3 vGroundWorld;
uniform sampler2D uPuddleMask;
uniform sampler2D uReflection;
uniform float uReflectionStrength;
uniform float uHasReflection;
uniform float uTime;
uniform float uRippleSpeed;
uniform float uRippleStrength;
uniform float uRainAmount;
uniform float uWetness;
uniform vec2 uResolution;
uniform vec4 uImpacts[ 8 ];
uniform float uDebugMode;

float gPuddle;
/** 0 at the waterline, 1 in the deep centre of a pool. */
float gDepthAmt;
float gDamp;
float gSurface;
float gChop;
vec2 gRipple;

float gHash( vec2 p ) {
  p = fract( p * vec2( 443.897, 441.423 ) );
  p += dot( p, p + 19.19 );
  return fract( p.x * p.y );
}

// Rain rings: each cell of a hashed grid hosts one drop with its own phase.
vec2 rainRipple( vec2 world, float amount ) {
  if ( amount <= 0.001 ) return vec2( 0.0 );
  vec2 grid = world * 1.7;
  vec2 cell = floor( grid );
  vec2 local = fract( grid ) - 0.5;
  float rnd = gHash( cell );
  if ( rnd > amount ) return vec2( 0.0 );
  float phase = fract( uTime * 0.9 + rnd * 7.3 );
  float radius = phase * 0.42;
  float d = length( local - ( vec2( gHash( cell + 3.7 ), gHash( cell + 8.1 ) ) - 0.5 ) * 0.6 );
  float ring = exp( -abs( d - radius ) * 34.0 ) * ( 1.0 - phase );
  return normalize( local + 1e-5 ) * ring * 0.9;
}

// Gameplay-driven rings (footsteps, bullet impacts, blasts).
vec2 impactRipple( vec2 world ) {
  vec2 sum = vec2( 0.0 );
  for ( int i = 0; i < 8; i++ ) {
    vec4 imp = uImpacts[ i ];
    if ( imp.w <= 0.0 ) continue;
    float age = uTime - imp.z;
    if ( age < 0.0 || age > 1.6 ) continue;
    vec2 delta = world - imp.xy;
    float d = length( delta );
    float radius = age * imp.w;
    float ring = exp( -abs( d - radius ) * 9.0 ) * ( 1.0 - age / 1.6 );
    sum += normalize( delta + 1e-5 ) * ring * 0.6;
  }
  return sum;
}
`;

const GROUND_MASK = /* glsl */ `
  // TWO SCALES. One 17m tile carries the large pools, a second 5.3m tile
  // (rotated, so the two lattices never line up) carries small puddles and
  // erodes the edges of the large ones. Sampling a single tile made the
  // repeat obvious the moment the player walked more than a tile's width.
  // 12.5m repeat, offset so the pool layout is not centred on the level origin
  // (the player spawn sat inside a single large pool, which reads as a flat
  // sheet rather than as standing water).
  vec2 gUvBig = ( vGroundWorld.xz + vec2( 6.3, -4.1 ) ) * 0.080;
  vec2 gRot = vec2( 0.86, 0.51 );
  vec2 gUvSmall = vec2(
    vGroundWorld.x * gRot.x - vGroundWorld.z * gRot.y,
    vGroundWorld.x * gRot.y + vGroundWorld.z * gRot.x
  ) * 0.235;

  // R = smooth depth field, G = detail field, B = fine surface variation.
  vec3 gBig = texture2D( uPuddleMask, gUvBig ).rgb;
  vec3 gSmall = texture2D( uPuddleMask, gUvSmall ).rgb;

  // ONE field, PERTURBED - not a weighted average of two.
  //
  // Averaging two independent fields shrinks the combined variance (the sum of
  // independent variables is more tightly clustered than either), which pushes
  // the whole distribution against the threshold and makes coverage swing wildly
  // for a tiny change in water level. Perturbing a single normalised field keeps
  // its distribution, so the histogram normalisation above still holds and the
  // authored coverage is the coverage you get.
  float gDepth = gBig.r;
  // The second scale erodes and adds to the outlines so a pool is never a clean
  // copy of the texture, and the two lattices never line up into a repeat.
  gDepth += ( gSmall.r - 0.5 ) * 0.30;
  // Ragged waterline from the detail field.
  gDepth += ( gBig.g - 0.5 ) * 0.11 + ( gSmall.g - 0.5 ) * 0.05;

  // The field is histogram-normalised at build time so 0.5 IS the authored
  // coverage AND the value mipmaps converge to. Keeping the level near 0.5 is
  // exactly what makes puddle coverage distance-stable; wetness only nudges it.
  float gLevel = mix( 0.545, 0.495, uWetness );
  // DRY ISLANDS. High points of the fine field poke back through the water, so
  // a large pool is broken by patches of exposed deck instead of reading as one
  // continuous sheet. This is the difference between "standing water in a yard"
  // and "a designed platform".
  float islands = smoothstep( 0.62, 0.80, gSmall.b * 0.6 + gBig.b * 0.4 );
  gDepth -= islands * 0.075;

  // Threshold AFTER filtering -> crisp waterlines at every distance.
  gPuddle = smoothstep( gLevel, gLevel + 0.045, gDepth );

  // WATER DEPTH, as distinct from water PRESENCE. A pool is shallow at its rim
  // and deep at its centre; driving the reflection from presence alone is what
  // made the far edge of a pool read as a raised step, because the mirror
  // switched on across a 4cm band.
  gDepthAmt = smoothstep( gLevel + 0.01, gLevel + 0.17, gDepth );

  // Damp halo: a wide, soft band of merely-damp concrete around each pool.
  gDamp = smoothstep( gLevel - 0.22, gLevel + 0.02, gDepth ) * uWetness;
  gSurface = gBig.b * 0.6 + gSmall.b * 0.4;

  // Two crossing wave trains give directional chop; the rings add life.
  vec2 w = vGroundWorld.xz;
  float t = uTime * uRippleSpeed;
  vec2 wave = vec2(
    sin( w.x * 3.1 + t * 1.7 ) + sin( w.x * 1.3 - w.y * 2.1 + t * 1.1 ),
    cos( w.y * 2.7 - t * 1.4 ) + sin( w.y * 1.1 + w.x * 1.9 - t * 0.9 )
  ) * 0.035;
  gRipple = ( wave + rainRipple( w, uRainAmount ) + impactRipple( w ) ) * uRippleStrength * gPuddle;
  gChop = length( gRipple );
`;

const GROUND_NORMAL = /* glsl */ `
  {
    // Replace the concrete normal with a water surface inside puddles.
    vec3 waterNormalWorld = normalize( vec3( -gRipple.x, 1.0, -gRipple.y ) );
    vec3 waterNormalView = normalize( ( viewMatrix * vec4( waterNormalWorld, 0.0 ) ).xyz );
    normal = normalize( mix( normal, waterNormalView, gPuddle * gDepthAmt * 0.92 ) );
  }
`;

const GROUND_REFLECTION = /* glsl */ `
  {
    if ( uDebugMode > 0.5 ) {
      if ( uDebugMode < 1.5 ) outgoingLight = vec3( gPuddle );
      else if ( uDebugMode < 2.5 ) outgoingLight = vec3( gDepthAmt, gDamp, gChop * 8.0 );
      else outgoingLight = texture2D( uReflection, gl_FragCoord.xy / uResolution ).rgb;
      diffuseColor.a = 1.0;
    } else {
    // Damp concrete outside the puddles: darker albedo, tighter specular.
    outgoingLight *= mix( 1.0, 0.72, gDamp * 0.8 );
    // SILT at the waterline. Where water is present but shallow, sediment has
    // settled - a warm-grey band that follows the pool outline and keeps the
    // edge from reading as a clean cut in the surface.
    float rim = gPuddle * ( 1.0 - gDepthAmt );
    outgoingLight = mix( outgoingLight, outgoingLight * vec3( 1.12, 1.05, 0.92 ), rim * 0.5 );

    if ( uHasReflection > 0.5 && gPuddle * gDepthAmt > 0.002 ) {
      // Screen-space sample: exact for a planar mirror rendered with the
      // mirrored camera. uResolution is the MAIN framebuffer size (what
      // gl_FragCoord is measured in), not the reflection target size - the
      // reflection RT is a scaled copy of the same view, so normalised UVs
      // match regardless of its resolution.
      vec2 screenUv = gl_FragCoord.xy / uResolution;
      // Distortion scales with puddle depth: a shallow film barely bends the
      // image, a deep pool breaks it up.
      screenUv += gRipple * ( 0.35 + gDepthAmt * 0.75 );
      screenUv = clamp( screenUv, vec2( 0.002 ), vec2( 0.998 ) );
      vec3 reflectionColor = texture2D( uReflection, screenUv ).rgb;

      // Schlick fresnel: reflections strengthen at grazing angles, which is
      // what makes a wet apron read as wet from standing eye height.
      //
      // The floor matters as much as the curve. At 0.18 the puddles around the
      // player's own feet - the ones they look at most - were almost dry,
      // because a standing player views nearby ground at a steep angle. 0.38
      // keeps near pools legible while distant ones still go near-mirror.
      vec3 viewDir = normalize( vViewPosition );
      float fresnel = pow( 1.0 - clamp( dot( viewDir, normal ), 0.0, 1.0 ), 4.0 );
      float strength = uReflectionStrength * gPuddle * gDepthAmt * mix( 0.38, 1.0, fresnel );
      outgoingLight = mix( outgoingLight, reflectionColor, clamp( strength, 0.0, 0.94 ) );
    }
    }
  }
`;

const tmpClearColor = new THREE.Color();
