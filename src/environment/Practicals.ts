import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { Rng } from '@/core/Rng';
import { clamp01, fbm1 } from '@/core/MathUtils';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';
import { LIGHT_CONE_FRAG, LIGHT_CONE_VERT } from '@/shaders/LightConeShader';

/**
 * Practical lights - the lamps the player can actually see in the world.
 *
 * The rule this class enforces: EVERY pool of light on the ground has a
 * visible fixture that could plausibly produce it. Free-floating point lights
 * with no source are the fastest way to make a scene feel fake.
 *
 * Cost control:
 *  - only `quality.shadowCastingPracticals` spot lights cast shadows (each one
 *    is a full extra scene render);
 *  - the "volume" of light is a cone mesh with an additive falloff shader, not
 *    raymarched fog - two orders of magnitude cheaper and, at this scale,
 *    visually equivalent;
 *  - lamp housings are baked into the static level batches; only the emissive
 *    lenses and the light objects live here.
 */

interface Flicker {
  light: THREE.Light;
  emissive: THREE.Mesh | null;
  cone: THREE.Mesh | null;
  baseIntensity: number;
  /**
   * Emissive intensity captured ONCE when the fixture is registered.
   *
   * The previous code read a baseline off `material.userData` *after* it had
   * already written this frame's value to the same material, so the baseline
   * drifted; and because emissive materials are cached and shared between
   * fixtures, several flickers were writing to one material and capturing each
   * other's output. Both faults compounded over a long session. The base value
   * now lives here, per fixture, and each flickering fixture owns a cloned
   * material so nothing is shared.
   */
  baseEmissive: number;
  /** Per-lamp noise offset so no two flicker in sync. */
  phase: number;
  /** 0 = healthy, 1 = failing ballast. */
  instability: number;
  /** Set when the player shoots the fixture out. */
  destroyed: boolean;
  destroyTimer: number;
}

interface HangingLamp {
  group: THREE.Group;
  light: THREE.PointLight;
  /** Simple pendulum state, integrated in 2D. */
  angleX: number;
  angleZ: number;
  velX: number;
  velZ: number;
}

export class Practicals {
  readonly group = new THREE.Group();
  private flickers: Flicker[] = [];
  private hanging: HangingLamp[] = [];
  private beacons: Array<{ pivot: THREE.Object3D; light: THREE.PointLight; speed: number }> = [];
  private coneMaterials: THREE.ShaderMaterial[] = [];
  private shadowBudget: number;
  private rng = new Rng(0x10a11a);
  private disposables: Array<{ dispose(): void }> = [];
  private lightCount = 0;
  private masterScale = 1;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly visual: MutableVisual,
    private quality: QualitySettings,
  ) {
    this.group.name = 'Practicals';
    this.shadowBudget = quality.shadowCastingPracticals;
  }

  private makeCone(radiusTop: number, radiusBottom: number, length: number, color: THREE.Color): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 18, 4, true);
    geo.translate(0, -length / 2, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: LIGHT_CONE_VERT,
      fragmentShader: LIGHT_CONE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: color.clone() },
        uOpacity: { value: this.visual.practicals.shaftOpacity },
        uLength: { value: length },
        uTime: { value: 0 },
        uIntensity: { value: 1 },
      },
    });
    this.coneMaterials.push(mat);
    this.disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 5;
    mesh.frustumCulled = true;
    mesh.layers.set(LAYER.WORLD);
    return mesh;
  }

  /**
   * Floodlight. `position` is the lamp head, `target` the point it is aimed at.
   * Returns the light so the level can register it as shootable.
   */
  addFloodlight(
    position: THREE.Vector3,
    target: THREE.Vector3,
    options: { intensity?: number; color?: number; angle?: number; instability?: number; shafts?: boolean } = {},
  ): THREE.SpotLight {
    const p = this.visual.practicals;
    const color = new THREE.Color(options.color ?? p.floodColorWarm);
    const light = new THREE.SpotLight(
      color,
      options.intensity ?? p.floodIntensity,
      p.floodDistance,
      options.angle ?? p.floodAngle,
      p.floodPenumbra,
      2,
    );
    light.position.copy(position);
    light.target.position.copy(target);
    light.layers.enable(LAYER.VIEWMODEL);
    light.target.layers.enable(LAYER.VIEWMODEL);
    if (this.shadowBudget > 0) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = p.floodDistance;
      light.shadow.bias = -0.0016;
      light.shadow.normalBias = 0.04;
      this.shadowBudget--;
    }
    this.group.add(light, light.target);
    this.lightCount++;

    // Emissive lens so the source itself is visible and blooms.
    const lens = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 10, 8),
      this.mats.emissive(`flood_${color.getHexString()}`, color.getHex(), 7),
    );
    lens.position.copy(position);
    lens.scale.set(1.5, 1, 0.5);
    lens.lookAt(target);
    lens.layers.set(LAYER.WORLD);
    this.group.add(lens);

    let cone: THREE.Mesh | null = null;
    if (this.quality.lightShafts && (options.shafts ?? true)) {
      const length = Math.min(p.floodDistance * 0.75, position.distanceTo(target) * 1.15);
      const angle = options.angle ?? p.floodAngle;
      cone = this.makeCone(0.16, Math.tan(angle) * length, length, color);
      cone.position.copy(position);
      // Cylinder points down -Y by default; aim it at the target.
      const dir = new THREE.Vector3().subVectors(target, position).normalize();
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      this.group.add(cone);
    }

    this.registerFlicker(light, lens, cone, options.instability ?? 0);
    return light;
  }

  /** Rotating hazard beacon. Sweeps a coloured wedge across the scene. */
  addBeacon(position: THREE.Vector3, color = 0xff5a2a, withLight = false): void {
    const p = this.visual.practicals;
    const pivot = new THREE.Object3D();
    pivot.position.copy(position);
    this.group.add(pivot);

    // Same reasoning as addStripLight: most beacons are read from their glowing
    // dome and rotating shaft, not from the light they cast on the deck.
    const light = new THREE.PointLight(color, p.beaconIntensity, 24, 2);
    if (withLight) {
      light.layers.enable(LAYER.VIEWMODEL);
      pivot.add(light);
      this.lightCount++;
    }

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6),
      this.mats.emissive(`beacon_${color.toString(16)}`, color, 5),
    );
    dome.layers.set(LAYER.WORLD);
    pivot.add(dome);

    if (this.quality.lightShafts) {
      const cone = this.makeCone(0.1, 1.5, 8, new THREE.Color(color));
      cone.rotation.z = Math.PI / 2;
      cone.position.set(0, 0, 0);
      pivot.add(cone);
    }

    this.beacons.push({ pivot, light, speed: p.beaconSpeed * this.rng.range(0.85, 1.15) });
  }

  /**
   * Hanging industrial lamp on a cord. Swings from explosions and gunfire -
   * the single cheapest trick for making a static room feel alive.
   */
  addHangingLamp(anchor: THREE.Vector3, cordLength: number, color = 0xffd9a8, withLight = true): void {
    const group = new THREE.Group();
    group.position.copy(anchor);
    this.group.add(group);

    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, cordLength, 5),
      this.mats.steelBare(),
    );
    cord.position.y = -cordLength / 2;
    cord.layers.set(LAYER.WORLD);
    group.add(cord);

    const shadeGeo = new THREE.ConeGeometry(0.24, 0.2, 14, 1, true);
    const shade = new THREE.Mesh(shadeGeo, this.mats.steelPainted());
    shade.position.y = -cordLength - 0.06;
    shade.rotation.x = Math.PI;
    shade.layers.set(LAYER.WORLD);
    group.add(shade);

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 8, 6),
      this.mats.emissive('bulb', color, 9),
    );
    bulb.position.y = -cordLength - 0.13;
    bulb.layers.set(LAYER.WORLD);
    group.add(bulb);

    const light = new THREE.PointLight(color, 65, 16, 2);
    light.position.y = -cordLength - 0.14;
    if (withLight) {
      light.layers.enable(LAYER.VIEWMODEL);
      group.add(light);
      this.lightCount++;
    }

    this.disposables.push(cord.geometry, shadeGeo, bulb.geometry);
    this.hanging.push({ group, light, angleX: 0, angleZ: 0, velX: 0, velZ: 0 });
    this.registerFlicker(light, bulb, null, this.rng.chance(0.4) ? this.rng.range(0.3, 0.8) : 0);
  }

  /**
   * Cool fluorescent strip.
   *
   * `withLight` is OFF by default. three's forward renderer evaluates EVERY
   * light for every lit fragment, so each extra point light is a per-pixel cost
   * across the whole screen. A glowing emissive bar plus bloom reads as a lit
   * fixture on its own; only strips that need to actually spill light onto
   * geometry (the open roller door) pay for a real light.
   */
  addStripLight(
    position: THREE.Vector3,
    rotationY: number,
    length: number,
    withLight = false,
    intensityScale = 1,
    lightDistance = 13,
  ): void {
    const p = this.visual.practicals;
    const geo = new THREE.BoxGeometry(length, 0.06, 0.14);
    const mesh = new THREE.Mesh(geo, this.mats.emissive('strip', p.stripColor, 4.5));
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.layers.set(LAYER.WORLD);
    this.group.add(mesh);
    this.disposables.push(geo);

    let light: THREE.Light;
    if (withLight) {
      const point = new THREE.PointLight(
        p.stripColor,
        p.stripIntensity * length * intensityScale,
        lightDistance,
        2,
      );
      point.position.copy(position).add(new THREE.Vector3(0, -0.15, 0));
      point.layers.enable(LAYER.VIEWMODEL);
      this.group.add(point);
      this.lightCount++;
      light = point;
    } else {
      // A detached light object: the flicker system still drives its intensity,
      // which drives the emissive mesh, but it is never added to the scene and
      // so costs nothing in the shader.
      light = new THREE.PointLight(
        p.stripColor,
        p.stripIntensity * length * intensityScale,
        lightDistance,
        2,
      );
    }

    // Fluorescents are the classic failing fixture; most of these stutter.
    this.registerFlicker(light, mesh, null, this.rng.chance(0.55) ? this.rng.range(0.4, 1) : 0);
  }

  /**
   * Registers a fixture with the flicker system.
   * Clones the emissive material so this fixture owns it outright - the cached
   * materials are shared by every fixture of the same colour, and per-fixture
   * animation of a shared material is what caused values to accumulate.
   */
  private registerFlicker(
    light: THREE.Light,
    emissive: THREE.Mesh | null,
    cone: THREE.Mesh | null,
    instability: number,
  ): void {
    let baseEmissive = 1;
    if (emissive) {
      const shared = emissive.material as THREE.MeshStandardMaterial;
      const own = shared.clone();
      own.name = `${shared.name}_own`;
      emissive.material = own;
      this.disposables.push(own);
      baseEmissive = own.emissiveIntensity;
    }
    this.flickers.push({
      light,
      emissive,
      cone,
      baseIntensity: light.intensity,
      baseEmissive,
      phase: this.rng.range(0, 100),
      instability,
      destroyed: false,
      destroyTimer: 0,
    });
  }

  /** Nudges every hanging lamp near `position`. Called by explosions/gunfire. */
  applyShock(position: THREE.Vector3, power: number): void {
    for (const lamp of this.hanging) {
      const dx = lamp.group.position.x - position.x;
      const dz = lamp.group.position.z - position.z;
      const dy = lamp.group.position.y - position.y;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 16) continue;
      const falloff = power / (1 + dist * dist * 0.28);
      lamp.velX += (dx / (dist + 0.01)) * falloff;
      lamp.velZ += (dz / (dist + 0.01)) * falloff;
    }
  }

  /** Shoot out a lamp: flash, then dark. Registered per-fixture by the level. */
  destroyNearest(position: THREE.Vector3, radius = 0.9): boolean {
    let best: Flicker | null = null;
    let bestDist = radius;
    for (const f of this.flickers) {
      if (f.destroyed) continue;
      const d = f.light.getWorldPosition(tmpVec).distanceTo(position);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    if (!best) return false;
    best.destroyed = true;
    best.destroyTimer = 0;
    return true;
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    for (const f of this.flickers) {
      if (f.cone) f.cone.visible = quality.lightShafts;
    }
  }

  refresh(): void {
    for (const mat of this.coneMaterials) {
      mat.uniforms.uOpacity.value = this.visual.practicals.shaftOpacity;
    }
  }

  get count(): number {
    return this.lightCount;
  }

  update(dt: number, elapsed: number): void {
    // --- flicker ---
    for (const f of this.flickers) {
      let intensity = f.baseIntensity * this.masterScale;
      if (f.destroyed) {
        // Brief arc-flash as the fixture dies, then it stays dark.
        f.destroyTimer += dt;
        const t = f.destroyTimer;
        intensity = t < 0.16 ? f.baseIntensity * this.masterScale * (2.4 * Math.sin(t * 90) ** 2) : 0;
      } else if (f.instability > 0) {
        const n = fbm1(elapsed * 7 + f.phase, 3);
        // Mostly stable with occasional dropouts, not a strobe.
        const dip = n < -0.42 * (1 - f.instability * 0.5) ? this.rng.range(0.05, 0.4) : 1;
        intensity = f.baseIntensity * this.masterScale * (0.88 + n * 0.12) * dip;
      }
      f.light.intensity = intensity;
      // Always derived from the immutable base values, never from the current
      // (already animated) ones - that is what stops flicker accumulating.
      const ratio = intensity / Math.max(f.baseIntensity, 0.001);
      if (f.emissive) {
        (f.emissive.material as THREE.MeshStandardMaterial).emissiveIntensity = f.baseEmissive * ratio;
      }
      if (f.cone) {
        (f.cone.material as THREE.ShaderMaterial).uniforms.uIntensity.value = ratio;
      }
    }

    // --- beacons ---
    for (const b of this.beacons) {
      b.pivot.rotation.y += b.speed * dt;
    }

    // --- hanging lamps: damped pendulum ---
    for (const lamp of this.hanging) {
      const stiffness = 9.5;
      const damping = 1.35;
      lamp.velX += (-stiffness * lamp.angleX - damping * lamp.velX) * dt;
      lamp.velZ += (-stiffness * lamp.angleZ - damping * lamp.velZ) * dt;
      lamp.angleX = clamp01(Math.abs(lamp.angleX + lamp.velX * dt)) * Math.sign(lamp.angleX + lamp.velX * dt);
      lamp.angleZ = clamp01(Math.abs(lamp.angleZ + lamp.velZ * dt)) * Math.sign(lamp.angleZ + lamp.velZ * dt);
      // A permanent whisper of draught so the lamps are never perfectly still.
      lamp.angleX += Math.sin(elapsed * 0.7 + lamp.group.position.x) * 0.00035;
      lamp.group.rotation.set(lamp.angleZ * 0.55, 0, -lamp.angleX * 0.55);
    }

    for (const mat of this.coneMaterials) mat.uniforms.uTime.value = elapsed;
  }

  /**
   * Fades every practical (intro power-up, end sequence).
   * Stored as a multiplier the flicker loop applies, rather than written
   * directly onto the lights - two systems writing the same property is
   * exactly how the accumulation bug happened in the first place.
   */
  setMasterScale(scale: number): void {
    this.masterScale = scale;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.group.removeFromParent();
  }
}

const tmpVec = new THREE.Vector3();
