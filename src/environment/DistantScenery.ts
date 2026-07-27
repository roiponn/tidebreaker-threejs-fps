import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { Rng } from '@/core/Rng';
import { applyFogUniforms } from '@/materials/FogPatch';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';
import { chamferBox, mergeGeometries, trs } from './GeometryKit';
import { RAIN_FRAG, RAIN_VERT } from '@/shaders/RainShader';

/**
 * Everything beyond the playable area: the sea, the far industrial skyline,
 * the war happening somewhere else, and the drizzle.
 *
 * This layer does most of the work of making a 70x40m playspace feel like part
 * of a large world. It is also nearly free: the skyline is one merged mesh, the
 * sea is one plane, and the rain is a single instanced draw driven entirely on
 * the GPU.
 */
export class DistantScenery {
  readonly group = new THREE.Group();
  /** Rain is excluded from the planar reflection pass (it would double up). */
  readonly rainGroup = new THREE.Group();

  private sea!: THREE.Mesh;
  private seaUniforms: Record<string, THREE.IUniform> = {};
  private rain: THREE.Mesh | null = null;
  private rainUniforms: Record<string, THREE.IUniform> = {};
  private aviationLights: Array<{ mesh: THREE.Mesh; phase: number; speed: number }> = [];
  private disposables: Array<{ dispose(): void }> = [];
  private rng = new Rng(0x5ea51de);

  /** Distant-battle state, consumed by the sky and the audio system. */
  private flashTimer = 2.5;
  private flashStrength = 0;
  private flashDirection = new THREE.Vector3(-0.6, 0.12, -0.8).normalize();
  private flashColor = new THREE.Color(0xffb066);
  /** Set by the level each time a distant detonation fires. */
  onDistantBlast: ((delaySec: number, intensity: number) => void) | null = null;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly visual: MutableVisual,
    private quality: QualitySettings,
  ) {
    this.group.name = 'DistantScenery';
    this.group.add(this.rainGroup);
    this.buildSea();
    this.buildSkyline();
    this.buildRain();
  }

  // ------------------------------------------------------------------

  private buildSea(): void {
    const geo = new THREE.PlaneGeometry(900, 900, 64, 64);
    geo.rotateX(-Math.PI / 2);
    this.disposables.push(geo);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d1620,
      roughness: 0.08,
      metalness: 0.0,
      envMapIntensity: 1.4,
    });
    mat.name = 'sea';
    mat.userData = { surface: 'water' };

    this.seaUniforms = { uTime: { value: 0 } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.seaUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaWorld;\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  // Large-scale swell only; the fine chop lives in the normal.
  transformed.y += sin( wp.x * 0.055 + uTime * 0.55 ) * 0.14
                 + sin( wp.z * 0.041 - uTime * 0.42 ) * 0.11;
  vSeaWorld = wp;
}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaWorld;\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{
  // Three crossing wave trains give a plausible chop without a normal map.
  vec2 p = vSeaWorld.xz;
  float t = uTime;
  vec2 n = vec2( 0.0 );
  n += vec2( cos( p.x * 0.9 + t * 1.4 ), cos( p.z * 0.8 - t * 1.1 ) ) * 0.05;
  n += vec2( cos( p.x * 2.3 - p.z * 1.1 + t * 2.1 ), cos( p.z * 2.7 + p.x * 0.7 - t * 1.7 ) ) * 0.022;
  n += vec2( cos( p.x * 6.1 + t * 3.4 ), cos( p.z * 5.7 - t * 3.1 ) ) * 0.008;
  vec3 waveNormal = normalize( vec3( -n.x, 1.0, -n.y ) );
  normal = normalize( ( viewMatrix * vec4( waveNormal, 0.0 ) ).xyz );
}`,
        );
    };
    applyFogUniforms(mat);
    this.disposables.push(mat);

    this.sea = new THREE.Mesh(geo, mat);
    this.sea.position.set(30, -1.35, -220);
    this.sea.receiveShadow = false;
    this.sea.castShadow = false;
    this.sea.layers.set(LAYER.WORLD);
    this.group.add(this.sea);
  }

  /**
   * Far skyline: refineries, gantries, chimneys and tanks, merged into a
   * single dark mesh. At 120-400m the fog reduces them to silhouettes, so
   * detail would be wasted - what matters is a varied, believable outline.
   */
  private buildSkyline(): void {
    const detail = this.quality.distantDetail;
    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.Matrix4[] = [];
    const emissiveGeos: THREE.BufferGeometry[] = [];
    const emissiveMats: THREE.Matrix4[] = [];
    const rng = this.rng.fork(11);

    const box = (w: number, h: number, d: number): THREE.BufferGeometry => {
      const g = chamferBox(w, h, d, Math.min(w, d) * 0.04, 1);
      this.disposables.push(g);
      return g;
    };

    const clusterCount = Math.round(26 * detail) + 8;
    for (let i = 0; i < clusterCount; i++) {
      // Two bands: one across the water to the south, one inland to the north.
      const seaward = rng.chance(0.68);
      const x = rng.range(-140, 260);
      const z = seaward ? rng.range(-330, -110) : rng.range(70, 190);
      const scale = rng.range(0.7, 1.9);

      const kind = rng.next();
      if (kind < 0.3) {
        // Storage tank farm.
        const count = rng.int(2, 4);
        for (let t = 0; t < count; t++) {
          const r = rng.range(6, 13) * scale;
          const h = rng.range(9, 16) * scale;
          const g = new THREE.CylinderGeometry(r, r, h, 12);
          this.disposables.push(g);
          geos.push(g);
          mats.push(trs(x + t * r * 2.6, h / 2, z + rng.spread(8)));
        }
      } else if (kind < 0.55) {
        // Chimney stack with an aviation warning light on top.
        const h = rng.range(38, 78) * scale;
        const g = new THREE.CylinderGeometry(2.2 * scale, 4.2 * scale, h, 10);
        this.disposables.push(g);
        geos.push(g);
        mats.push(trs(x, h / 2, z));
        const lightGeo = new THREE.SphereGeometry(1.5, 6, 5);
        this.disposables.push(lightGeo);
        emissiveGeos.push(lightGeo);
        emissiveMats.push(trs(x, h + 1.5, z));
        this.addAviationLight(new THREE.Vector3(x, h + 1.5, z), rng.range(0, 6.28));
      } else if (kind < 0.8) {
        // Gantry crane silhouette: legs, boom and counterweight.
        const h = rng.range(26, 46) * scale;
        const span = rng.range(24, 44) * scale;
        for (const sx of [-1, 1]) {
          geos.push(box(2.4, h, 2.4));
          mats.push(trs(x + (sx * span) / 2, h / 2, z));
        }
        geos.push(box(span * 1.5, 3.2, 3.2));
        mats.push(trs(x + span * 0.15, h + 1.6, z));
        geos.push(box(8, 6, 6));
        mats.push(trs(x - span * 0.6, h + 1.4, z));
        this.addAviationLight(new THREE.Vector3(x + span * 0.55, h + 3.4, z), rng.range(0, 6.28));
      } else {
        // Warehouse block with a lit window strip.
        const w = rng.range(24, 60) * scale;
        const h = rng.range(10, 22) * scale;
        const d = rng.range(18, 40) * scale;
        geos.push(box(w, h, d));
        mats.push(trs(x, h / 2, z));
        const strip = box(w * 0.8, 1.2, 0.4);
        emissiveGeos.push(strip);
        emissiveMats.push(trs(x, h * 0.62, z + (z < 0 ? d / 2 : -d / 2)));
      }
    }

    if (geos.length > 0) {
      const merged = mergeGeometries(geos, mats);
      this.disposables.push(merged);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1b222c,
        roughness: 0.92,
        metalness: 0.25,
      });
      mat.name = 'skyline';
      mat.userData = { surface: 'concrete' };
      applyFogUniforms(mat);
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
    }

    if (emissiveGeos.length > 0) {
      const merged = mergeGeometries(emissiveGeos, emissiveMats);
      this.disposables.push(merged);
      const mesh = new THREE.Mesh(merged, this.mats.emissive('distantWindow', 0xffb877, 1.1));
      mesh.castShadow = false;
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
    }
  }

  /** Slow-blinking red obstruction light on a tall distant structure. */
  private addAviationLight(position: THREE.Vector3, phase: number): void {
    const geo = new THREE.SphereGeometry(1.1, 6, 5);
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, this.mats.emissive('aviation', 0xff2a1e, 6));
    mesh.position.copy(position);
    mesh.layers.set(LAYER.WORLD);
    this.group.add(mesh);
    this.aviationLights.push({ mesh, phase, speed: this.rng.range(0.5, 0.85) });
  }

  /**
   * Drizzle. One InstancedMesh of elongated quads; the vertex shader wraps each
   * streak inside a box that follows the camera, so there is no CPU work and
   * no particle budget consumed.
   */
  private buildRain(): void {
    const count = Math.round(2600 * this.quality.rainMultiplier);
    if (count <= 0) return;

    const base = new THREE.PlaneGeometry(0.012, 0.5);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    base.dispose();

    const offsets = new Float32Array(count * 3);
    const params = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      offsets[i * 3] = this.rng.range(-16, 16);
      offsets[i * 3 + 1] = this.rng.range(0, 18);
      offsets[i * 3 + 2] = this.rng.range(-16, 16);
      params[i * 2] = this.rng.range(0.7, 1.5);
      params[i * 2 + 1] = this.rng.range(0.4, 1);
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 2));
    geo.instanceCount = count;
    this.disposables.push(geo);

    this.rainUniforms = {
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      uAmount: { value: this.visual.wetness.rainAmount },
      uColor: { value: new THREE.Color(0xbfd4e8) },
      uWindDir: { value: new THREE.Vector3(-0.5, 0, 0.3) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: this.rainUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.disposables.push(mat);

    this.rain = new THREE.Mesh(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 8;
    this.rain.layers.set(LAYER.WORLD);
    this.rainGroup.add(this.rain);
  }

  // ------------------------------------------------------------------

  refresh(): void {
    if (this.rainUniforms.uAmount) this.rainUniforms.uAmount.value = this.visual.wetness.rainAmount;
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    if (this.rain) this.rain.visible = quality.rainMultiplier > 0;
  }

  /** Current distant-battle flash, read by the sky dome each frame. */
  get battleFlash(): { strength: number; direction: THREE.Vector3; color: THREE.Color } {
    return { strength: this.flashStrength, direction: this.flashDirection, color: this.flashColor };
  }

  update(dt: number, elapsed: number, cameraPosition: THREE.Vector3): void {
    this.seaUniforms.uTime.value = elapsed;
    if (this.rainUniforms.uTime) {
      this.rainUniforms.uTime.value = elapsed;
      (this.rainUniforms.uCameraPos.value as THREE.Vector3).copy(cameraPosition);
    }

    // Aviation lights: slow asynchronous blink.
    for (const light of this.aviationLights) {
      const t = Math.sin(elapsed * light.speed + light.phase);
      const on = t > 0.55 ? 1 : 0.04;
      (light.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 6 * on;
    }

    // Distant battle: a flash on the horizon now and then, followed by a
    // delayed rumble. The delay is what sells the distance.
    this.flashStrength = Math.max(0, this.flashStrength - dt * 5.5);
    this.flashTimer -= dt;
    if (this.flashTimer <= 0) {
      this.flashTimer = this.rng.range(3.4, 9.5);
      const intensity = this.rng.range(0.35, 1.2);
      this.flashStrength = intensity;
      const angle = this.rng.range(Math.PI * 0.6, Math.PI * 1.5);
      this.flashDirection.set(Math.cos(angle), this.rng.range(0.04, 0.16), Math.sin(angle)).normalize();
      this.flashColor.setHex(this.rng.chance(0.3) ? 0xffd9a0 : 0xff9a52);
      // ~340 m/s: a 1-2.5s delay reads as "a couple of kilometres away".
      this.onDistantBlast?.(this.rng.range(1.1, 2.8), intensity);
    }

    // Keep the sea centred under the horizon so it never runs out.
    this.sea.position.x = cameraPosition.x + 30;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.group.removeFromParent();
  }
}
