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

  constructor(
    materials: MaterialLibrary,
    private visual: MutableVisual,
    quality: QualitySettings,
    private readonly waterLevel = 0,
    private readonly size = 220,
  ) {
    this.quality = quality;
    this.puddleTexture = buildPuddleMask(512);

    const base = materials.asphalt();
    this.material = base.clone() as THREE.MeshStandardMaterial;
    this.material.name = 'wetApron';
    this.material.userData = { surface: 'concrete' };

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
          '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor * ( 1.0 - uWetness * 0.45 ), 0.035, gPuddle );',
        )
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GROUND_NORMAL}`)
        .replace('#include <opaque_fragment>', `${GROUND_REFLECTION}\n#include <opaque_fragment>`);
    };
    applyFogUniforms(this.material);

    // A modest subdivision lets the far apron pick up the vertex-interpolated
    // fog gradient smoothly; the plane itself stays flat.
    const geometry = new THREE.PlaneGeometry(size, size, 32, 32);
    geometry.rotateX(-Math.PI / 2);
    // World-scale UVs: one texture repeat per 4 metres, everywhere.
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, pos.getX(i) / 4, pos.getZ(i) / 4);
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
    const width = Math.max(64, Math.round(1280 * quality.reflectionScale));
    const height = Math.max(64, Math.round(720 * quality.reflectionScale));
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
    renderer.setRenderTarget(this.reflectionRT);
    renderer.clear(true, true, false);
    // Mirrored geometry winds backwards; flip the front face for this pass.
    const previousFlip = (renderer as unknown as { _reflectionFlip?: boolean })._reflectionFlip;
    void previousFlip;
    const gl = renderer.getContext();
    gl.frontFace(gl.CW);
    renderer.render(scene, rc);
    gl.frontFace(gl.CCW);
    renderer.setRenderTarget(previousSide);
    renderer.shadowMap.needsUpdate = previousShadowAuto;

    for (const obj of this.hiddenDuringReflection) obj.visible = true;

  }

  /** Main framebuffer size in device pixels - gl_FragCoord is measured in it. */
  setScreenSize(width: number, height: number): void {
    (this.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.puddleTexture.dispose();
    this.reflectionRT?.dispose();
  }
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

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const u = x / res;
      const v = y / res;
      const broad = fbm(u * 3, v * 3, 3, seedA, 4);
      const detail = fbm(u * 11, v * 11, 11, seedB, 3);
      // Threshold with a narrow ramp -> defined waterline, not a gradient.
      const depth = broad * 0.82 + detail * 0.18;
      const puddle = Math.max(0, Math.min(1, (depth - 0.52) * 6.5));
      // Damp halo around every puddle: the concrete is darker but not mirrored.
      const damp = Math.max(0, Math.min(1, (depth - 0.4) * 3.2));
      const i = (y * res + x) * 4;
      data[i] = puddle * 255;
      data[i + 1] = damp * 255;
      data[i + 2] = detail * 255;
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

float gPuddle;
float gDamp;
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
  vec2 gMaskUv = vGroundWorld.xz * 0.021;
  vec3 gMask = texture2D( uPuddleMask, gMaskUv ).rgb;
  gPuddle = clamp( gMask.r * uWetness * 1.25, 0.0, 1.0 );
  gDamp = clamp( gMask.g * uWetness, 0.0, 1.0 );

  // Two crossing wave trains give directional chop; the rings add life.
  vec2 w = vGroundWorld.xz;
  float t = uTime * uRippleSpeed;
  vec2 wave = vec2(
    sin( w.x * 3.1 + t * 1.7 ) + sin( w.x * 1.3 - w.z * 2.1 + t * 1.1 ),
    cos( w.z * 2.7 - t * 1.4 ) + sin( w.z * 1.1 + w.x * 1.9 - t * 0.9 )
  ) * 0.035;
  gRipple = ( wave + rainRipple( w, uRainAmount ) + impactRipple( w ) ) * uRippleStrength * gPuddle;
`;

const GROUND_NORMAL = /* glsl */ `
  {
    // Replace the concrete normal with a water surface inside puddles.
    vec3 waterNormalWorld = normalize( vec3( -gRipple.x, 1.0, -gRipple.y ) );
    vec3 waterNormalView = normalize( ( viewMatrix * vec4( waterNormalWorld, 0.0 ) ).xyz );
    normal = normalize( mix( normal, waterNormalView, gPuddle * 0.92 ) );
  }
`;

const GROUND_REFLECTION = /* glsl */ `
  {
    // Damp concrete outside the puddles: darker albedo, tighter specular.
    outgoingLight *= mix( 1.0, 0.72, gDamp * 0.8 );

    if ( uHasReflection > 0.5 && gPuddle > 0.002 ) {
      // Screen-space sample: exact for a planar mirror rendered with the
      // mirrored camera. uResolution is the MAIN framebuffer size (what
      // gl_FragCoord is measured in), not the reflection target size - the
      // reflection RT is a scaled copy of the same view, so normalised UVs
      // match regardless of its resolution.
      vec2 screenUv = gl_FragCoord.xy / uResolution;
      // Distort by the ripple normal so the reflection breaks up on chop.
      screenUv += gRipple * 0.55;
      screenUv = clamp( screenUv, vec2( 0.002 ), vec2( 0.998 ) );
      vec3 reflectionColor = texture2D( uReflection, screenUv ).rgb;

      // Schlick fresnel: reflections strengthen dramatically at grazing angles,
      // which is what makes a wet apron read as wet from standing eye height.
      vec3 viewDir = normalize( vViewPosition );
      float fresnel = pow( 1.0 - clamp( dot( viewDir, normal ), 0.0, 1.0 ), 4.0 );
      float strength = uReflectionStrength * gPuddle * mix( 0.18, 1.0, fresnel );
      outgoingLight = mix( outgoingLight, reflectionColor, clamp( strength, 0.0, 0.92 ) );
    }
  }
`;
