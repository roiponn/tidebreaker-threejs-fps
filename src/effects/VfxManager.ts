import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import type { EventBus, SurfaceKind } from '@/core/EventBus';
import { Pool } from '@/core/Pool';
import { clamp01 } from '@/core/MathUtils';
import type { TextureFactory } from '@/materials/TextureFactory';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';
import { triggerGust } from '@/materials/WindMaterial';
import { ParticleSystem, type ParticleSpec } from './ParticleSystem';
import { DecalSystem } from './DecalSystem';
import { IMPACT_PRESETS } from './ImpactPresets';

/**
 * Orchestrates every visual effect and, critically, their SYNCHRONISATION.
 *
 * The brief's requirement that the flash, the light, the smoke, the casing,
 * the tracer, the impact and the sound all land together is met structurally:
 * everything here is driven from the same EventBus events on the same frame as
 * the gameplay that caused them. Nothing is on an independent timer, and
 * nothing is scheduled a frame later.
 *
 * Budgets are hard. Pools never grow; when they are full the oldest element is
 * recycled. That is a deliberate visual compromise in favour of a stable frame
 * time.
 */
export class VfxManager {
  readonly group = new THREE.Group();
  readonly particles: ParticleSystem;
  readonly decals: DecalSystem;

  /** One shared light for muzzle flashes, one for explosions. */
  private muzzleLight: THREE.PointLight;
  private muzzleLightTimer = 0;
  private explosionLight: THREE.PointLight;
  private explosionLightTimer = 0;
  private explosionLightPeak = 0;
  /** Animated blast-light state; see updateExplosionLight(). */
  private explosionAge = 0;
  /**
   * Debug only (?boomhold=): pins the blast light to a fixed point on its
   * life curve so a specific moment - the peak, early decay, the ember - can
   * be captured deliberately instead of being chased across a 0.6s window.
   */
  blastHoldLife: number | null = null;
  private readonly explosionHot = new THREE.Color(0xfff0cc);
  private readonly explosionCool = new THREE.Color(0xff4a12);
  private readonly explosionTint = new THREE.Color();

  private flashMesh: THREE.Mesh;
  private flashTimer = 0;
  private flashScale = 1;

  private tracers: THREE.InstancedMesh;
  private tracerPool: Pool<TracerState>;
  private casings: THREE.InstancedMesh;
  private casingPool: Pool<CasingState>;
  private shockwaves: THREE.InstancedMesh;
  private shockwavePool: Pool<ShockwaveState>;

  private disposables: Array<{ dispose(): void }> = [];
  private unsubscribe: Array<() => void> = [];

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private cameraPosition = new THREE.Vector3();

  /** Callbacks the game wires up so VFX can nudge the world. */
  onGroundRipple: ((x: number, z: number, strength: number) => void) | null = null;
  onLampShock: ((position: THREE.Vector3, power: number) => void) | null = null;
  onCameraShake: ((amplitude: number, frequency: number) => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    textures: TextureFactory,
    mats: MaterialLibrary,
    private readonly visual: MutableVisual,
    quality: QualitySettings,
  ) {
    this.group.name = 'VFX';

    this.particles = new ParticleSystem(
      quality.particleBudget,
      textures.radialSprite('spark', 2.6, 0.05),
      textures.smokeSprite(),
    );
    this.group.add(this.particles.group);

    this.decals = new DecalSystem(textures, quality.decalBudget);
    this.group.add(this.decals.group);

    // --- muzzle flash: a cross of two additive quads + a shared point light ---
    const flashGeo = new THREE.PlaneGeometry(1, 1);
    const flashTex = textures.radialSprite('flash', 1.5, 0.18);
    const flashMat = new THREE.MeshBasicMaterial({
      map: flashTex,
      color: 0xffd9a0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: true,
      side: THREE.DoubleSide,
    });
    this.flashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.flashMesh.visible = false;
    this.flashMesh.renderOrder = 20;
    this.flashMesh.frustumCulled = false;
    // The flash belongs to the view-model layer so it is never clipped by the
    // world depth and always sits right at the muzzle the player can see.
    this.flashMesh.layers.set(LAYER.VIEWMODEL);
    this.disposables.push(flashGeo, flashMat);

    this.muzzleLight = new THREE.PointLight(0xffc98a, 0, visual.muzzle.lightDistance, 2);
    this.muzzleLight.layers.enable(LAYER.VIEWMODEL);
    this.muzzleLight.castShadow = false;
    this.group.add(this.muzzleLight);

    this.explosionLight = new THREE.PointLight(0xff9a44, 0, visual.explosion.lightDistance, 2);
    this.explosionLight.layers.enable(LAYER.VIEWMODEL);
    this.explosionLight.castShadow = false;
    this.group.add(this.explosionLight);

    // --- tracers ---
    const tracerGeo = new THREE.PlaneGeometry(1, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      map: textures.radialSprite('tracer', 1.8, 0.0),
      color: 0xffb060,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
      side: THREE.DoubleSide,
    });
    this.tracers = new THREE.InstancedMesh(tracerGeo, tracerMat, 28);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.layers.set(LAYER.WORLD);
    this.tracers.renderOrder = 14;
    this.group.add(this.tracers);
    this.disposables.push(tracerGeo, tracerMat);
    this.tracerPool = new Pool<TracerState>(28, () => ({
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      distance: 0,
      travelled: 0,
      speed: 340,
      width: 0.04,
      fromPlayer: true,
    }));

    // --- shell casings ---
    const casingGeo = new THREE.CylinderGeometry(0.0048, 0.0052, 0.031, 6);
    this.casings = new THREE.InstancedMesh(casingGeo, mats.copper(), 18);
    this.casings.frustumCulled = false;
    this.casings.count = 0;
    this.casings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.casings.castShadow = false;
    this.casings.layers.set(LAYER.WORLD);
    this.group.add(this.casings);
    this.disposables.push(casingGeo);
    this.casingPool = new Pool<CasingState>(18, () => ({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      age: 0,
      life: 4,
      resting: false,
      bounced: 0,
    }));

    // --- explosion shockwave rings ---
    const ringGeo = new THREE.RingGeometry(0.72, 1, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd0a0,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.shockwaves = new THREE.InstancedMesh(ringGeo, ringMat, 6);
    this.shockwaves.frustumCulled = false;
    this.shockwaves.count = 0;
    this.shockwaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shockwaves.layers.set(LAYER.WORLD);
    this.shockwaves.renderOrder = 13;
    this.group.add(this.shockwaves);
    this.disposables.push(ringGeo, ringMat);
    this.shockwavePool = new Pool<ShockwaveState>(6, () => ({
      position: new THREE.Vector3(),
      age: 0,
      life: 0.75,
      maxRadius: 8,
    }));

    this.bindEvents();
  }

  private bindEvents(): void {
    this.unsubscribe.push(
      this.bus.on('weapon:fired', ({ origin, direction }) => this.onWeaponFired(origin, direction)),
      this.bus.on('impact:surface', (payload) => this.onImpact(payload)),
      this.bus.on('impact:enemy', ({ point, normal, headshot }) => this.onEnemyImpact(point, normal, headshot)),
      this.bus.on('explosion', ({ position, radius, power }) => this.spawnExplosion(position, radius, power)),
      this.bus.on('weapon:magOut', () => undefined),
    );
  }

  // ------------------------------------------------------------------
  // Weapon
  // ------------------------------------------------------------------

  private onWeaponFired(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const v = this.visual.muzzle;

    // Flash: two crossed quads, randomly rolled, scaled per shot so no two
    // flashes are identical. Lasts ~2 frames.
    this.flashMesh.visible = true;
    this.flashTimer = v.lightDuration * 1.35;
    this.flashScale = v.flashScale * (0.82 + Math.random() * 0.42);
    this.flashMesh.rotation.z = Math.random() * Math.PI * 2;

    // The light is what makes the flash affect the WORLD, not just the screen.
    this.muzzleLight.position.copy(origin);
    this.muzzleLight.intensity = v.lightIntensity * (0.85 + Math.random() * 0.3);
    this.muzzleLightTimer = v.lightDuration;

    // Muzzle smoke: a small hot puff pushed forward, plus slow drifting smoke.
    this.particles.emitBurst('additive', SPEC.muzzleFlare, 3, origin, direction, 5.5, 0.35, 0.02);
    this.particles.emitBurst('lit', SPEC.muzzleSmoke, 2, origin, direction, 2.4, 0.4, 0.03);
    // Muzzle-blast dust kicked sideways by the brake ports.
    this.tmpVec.copy(direction).cross(UP).normalize();
    this.particles.emitBurst('additive', SPEC.muzzleFlare, 2, origin, this.tmpVec, 3.2, 0.55, 0.01);

    this.spawnCasing(origin, direction);
  }

  /** Called by the ballistics system so the tracer matches the actual shot. */
  spawnTracer(origin: THREE.Vector3, direction: THREE.Vector3, distance: number, fromPlayer: boolean): void {
    const { item } = this.tracerPool.acquire();
    item.origin.copy(origin);
    item.direction.copy(direction).normalize();
    item.distance = distance;
    item.travelled = fromPlayer ? 2.5 : 0;
    item.speed = fromPlayer ? 420 : 260;
    item.width = fromPlayer ? 0.035 : 0.055;
    item.fromPlayer = fromPlayer;
  }

  private spawnCasing(muzzle: THREE.Vector3, direction: THREE.Vector3): void {
    const { item } = this.casingPool.acquire();
    // Eject from the port, not the muzzle: offset back along the barrel and to
    // the right of the aim.
    this.tmpVec.copy(direction).cross(UP).normalize();
    item.position.copy(muzzle).addScaledVector(direction, -0.42).addScaledVector(this.tmpVec, 0.06);
    item.position.y += 0.03;
    item.velocity
      .copy(this.tmpVec)
      .multiplyScalar(2.4 + Math.random() * 1.1)
      .addScaledVector(UP, 1.5 + Math.random() * 0.8)
      .addScaledVector(direction, -0.5 - Math.random() * 0.4);
    item.spin.set(
      (Math.random() * 2 - 1) * 22,
      (Math.random() * 2 - 1) * 26,
      (Math.random() * 2 - 1) * 30,
    );
    item.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    item.age = 0;
    item.life = 5.5;
    item.resting = false;
    item.bounced = 0;
  }

  // ------------------------------------------------------------------
  // Impacts
  // ------------------------------------------------------------------

  private onImpact(payload: {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    surface: SurfaceKind;
    incident: THREE.Vector3;
  }): void {
    const preset = IMPACT_PRESETS[payload.surface] ?? IMPACT_PRESETS.concrete;

    // Debris is thrown along the reflection of the incoming round, not along
    // the surface normal - that difference is what makes an angled hit look
    // like an angled hit.
    this.tmpVec.copy(payload.incident).reflect(payload.normal).normalize();
    // Bias back toward the normal so nothing sprays into the wall.
    this.tmpVec.lerp(payload.normal, 0.45).normalize();

    if (preset.sparks > 0) {
      this.particles.emitBurst(
        'additive',
        SPEC.spark,
        preset.sparks,
        payload.point,
        this.tmpVec,
        preset.sparkSpeed,
        preset.sparkSpread,
        0.02,
      );
    }
    if (preset.dust > 0) {
      this.particles.emitBurst(
        'lit',
        preset.dustSpec === 'water' ? SPEC.splash : SPEC.dust,
        preset.dust,
        payload.point,
        this.tmpVec,
        preset.dustSpeed,
        0.55,
        0.04,
      );
    }
    if (preset.chunks > 0) {
      this.particles.emitBurst(
        'lit',
        SPEC.chunk,
        preset.chunks,
        payload.point,
        this.tmpVec,
        preset.sparkSpeed * 0.55,
        0.5,
        0.03,
      );
    }
    if (preset.decal) {
      this.decals.add(payload.point, payload.normal, payload.surface);
    }
    if (payload.surface === 'water' || (payload.surface === 'concrete' && payload.point.y < 0.12)) {
      this.onGroundRipple?.(payload.point.x, payload.point.z, 0.55);
    }
  }

  private onEnemyImpact(point: THREE.Vector3, normal: THREE.Vector3, headshot: boolean): void {
    // Non-gore hit feedback: a burst of dark spall and a short dust puff, so
    // hits are unambiguous without the scene turning into a gore showcase.
    this.particles.emitBurst('additive', SPEC.hitSpall, headshot ? 10 : 6, point, normal, 3.4, 0.6, 0.02);
    this.particles.emitBurst('lit', SPEC.hitMist, headshot ? 5 : 3, point, normal, 1.6, 0.7, 0.03);
  }

  // ------------------------------------------------------------------
  // Explosions
  // ------------------------------------------------------------------

  spawnExplosion(position: THREE.Vector3, radius: number, power: number): void {
    const v = this.visual.explosion;

    // Light first: the flash has to be on the same frame as the fireball.
    this.explosionLight.position.copy(position).add(UP_HALF);
    this.explosionLightPeak = v.lightIntensity * power;
    this.explosionLightTimer = v.lightDuration;
    this.explosionAge = 0;

    // Core fireball: fast, bright, short-lived.
    this.particles.emitBurst('additive', SPEC.fireball, 14, position, UP, 6.5, 1.0, 0.25);
    // The rising smoke column that persists afterwards.
    this.particles.emitBurst('lit', SPEC.explosionSmoke, 16, position, UP, 4.2, 0.85, 0.4);
    // A low, fast-spreading ground ring of dust.
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      this.tmpVec.set(Math.cos(angle), 0.16, Math.sin(angle));
      this.particles.emitBurst('lit', SPEC.groundDust, 1, position, this.tmpVec, 9.5, 0.15, 0.2);
    }
    // Sparks and glowing debris arcing away.
    this.particles.emitBurst('additive', SPEC.debrisSpark, 22, position, UP, 11, 0.85, 0.2);
    this.particles.emitBurst('lit', SPEC.chunk, 10, position, UP, 8, 0.8, 0.2);

    // Shockwave ring on the ground.
    const { item: wave } = this.shockwavePool.acquire();
    wave.position.copy(position).setY(0.06);
    wave.age = 0;
    wave.life = 0.62;
    wave.maxRadius = radius * 1.35;

    this.decals.addScorch(new THREE.Vector3(position.x, 0.02, position.z), UP, radius * 0.85);

    // World reactions - all on this same frame.
    this.onCameraShake?.(0.55 * power, 17);
    this.onLampShock?.(position, 2.4 * power);
    this.onGroundRipple?.(position.x, position.z, 2.2 * power);
    triggerGust(position, 0.55 * power);
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera, muzzleWorld: THREE.Vector3): void {
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);

    // --- muzzle flash + light decay ---
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const t = clamp01(this.flashTimer / (this.visual.muzzle.lightDuration * 1.35));
      this.flashMesh.position.copy(muzzleWorld);
      // Billboard toward the camera.
      this.flashMesh.quaternion.copy(camera.quaternion);
      this.flashMesh.rotateZ(this.flashMesh.rotation.z);
      const scale = this.flashScale * (0.45 + t * 0.75);
      this.flashMesh.scale.set(scale, scale, scale);
      (this.flashMesh.material as THREE.MeshBasicMaterial).opacity = t;
      if (this.flashTimer <= 0) this.flashMesh.visible = false;
    }
    if (this.muzzleLightTimer > 0) {
      this.muzzleLightTimer -= dt;
      this.muzzleLight.intensity *= Math.pow(0.0008, dt);
      if (this.muzzleLightTimer <= 0) this.muzzleLight.intensity = 0;
    }
    this.updateExplosionLight(dt);

    this.updateTracers(dt);
    this.updateCasings(dt);
    this.updateShockwaves(dt);
    this.particles.update(dt, elapsed);
    this.decals.update(dt);
  }

  /**
   * Blast light over time.
   *
   * A constant-radius point light at a fixed colour lights the whole scene by
   * the same proportion, which is why the earlier explosion read as a uniform
   * screen tint rather than as something happening at a place. Three things
   * change together:
   *
   *   INTENSITY  a near-instant attack (~25ms) then a steep exponential decay,
   *              so the eye reads a flash rather than a lamp switching on.
   *   RADIUS     starts SMALL (the fireball is a few metres across) and expands
   *              as it decays. three windows the falloff toward `distance`, so
   *              a small radius means distant geometry receives almost nothing
   *              while nearby surfaces are hammered - which is exactly the
   *              near-field/far-field contrast that was missing.
   *   COLOUR     a near-white hot core cooling to deep orange, so the light
   *              itself carries the temperature drop of the fireball.
   */
  private updateExplosionLight(dt: number): void {
    if (this.explosionLightTimer <= 0) {
      if (this.explosionLight.intensity !== 0) {
        this.explosionLight.intensity = 0;
        this.particles.setFlashLight(this.explosionLight.position, 0, this.explosionCool);
      }
      return;
    }
    this.explosionLightTimer -= dt;
    this.explosionAge += dt;

    const duration = this.visual.explosion.lightDuration;
    let life = clamp01(this.explosionAge / Math.max(duration, 0.0001));
    if (this.blastHoldLife !== null) {
      life = this.blastHoldLife;
      this.explosionAge = life * duration;
      this.explosionLightTimer = duration; // never expires while held
    }
    // Attack over the first 8% of the life, then decay.
    const attack = clamp01(this.explosionAge / (duration * 0.08));
    const decay = Math.exp(-5.2 * life);
    const intensity = this.explosionLightPeak * attack * decay;
    this.explosionLight.intensity = intensity;

    // Radius grows from a tight fireball to a broad afterglow.
    this.explosionLight.distance = this.visual.explosion.lightDistance * (0.34 + life * 0.66);
    // Hot core cooling to ember.
    this.explosionTint.copy(this.explosionHot).lerp(this.explosionCool, Math.pow(life, 0.6));
    this.explosionLight.color.copy(this.explosionTint);

    // Feed the smoke shader so the column is lit by the same blast.
    this.particles.setFlashLight(
      this.explosionLight.position,
      intensity * 0.005,
      this.explosionTint,
    );

    if (this.explosionLightTimer <= 0) {
      this.explosionLight.intensity = 0;
      this.particles.setFlashLight(this.explosionLight.position, 0, this.explosionCool);
    }
  }

  private updateTracers(dt: number): void {
    let count = 0;
    this.tracerPool.forEachAlive((tracer, index) => {
      tracer.travelled += tracer.speed * dt;
      if (tracer.travelled > tracer.distance + 3) {
        this.tracerPool.release(index);
        return;
      }
      // The visible streak is a segment trailing behind the round.
      const head = Math.min(tracer.travelled, tracer.distance);
      const length = Math.min(head, tracer.fromPlayer ? 7 : 11);
      if (length < 0.3) return;
      const tail = head - length;
      this.tmpVec.copy(tracer.origin).addScaledVector(tracer.direction, (head + tail) * 0.5);

      // Orient: local +Y along travel, quad rolled to face the camera.
      this.tmpVec2.subVectors(this.cameraPosition, this.tmpVec).normalize();
      const yAxis = tracer.direction;
      const xAxis = new THREE.Vector3().crossVectors(yAxis, this.tmpVec2).normalize();
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
      const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
      this.tmpQuat.setFromRotationMatrix(basis);
      this.tmpScale.set(tracer.width, length, 1);
      this.tmpMatrix.compose(this.tmpVec, this.tmpQuat, this.tmpScale);
      this.tracers.setMatrixAt(count, this.tmpMatrix);
      count++;
    });
    this.tracers.count = count;
    if (count > 0) this.tracers.instanceMatrix.needsUpdate = true;
  }

  private updateCasings(dt: number): void {
    let count = 0;
    this.casingPool.forEachAlive((casing, index) => {
      casing.age += dt;
      if (casing.age > casing.life) {
        this.casingPool.release(index);
        return;
      }
      if (!casing.resting) {
        casing.velocity.y -= 17 * dt;
        casing.position.addScaledVector(casing.velocity, dt);
        casing.rotation.x += casing.spin.x * dt;
        casing.rotation.y += casing.spin.y * dt;
        casing.rotation.z += casing.spin.z * dt;
        if (casing.position.y < 0.008) {
          casing.position.y = 0.008;
          casing.bounced++;
          if (casing.bounced > 2 || casing.velocity.length() < 0.5) {
            casing.resting = true;
            casing.rotation.x = Math.PI / 2;
            casing.rotation.z = 0;
          } else {
            casing.velocity.y = -casing.velocity.y * 0.38;
            casing.velocity.x *= 0.55;
            casing.velocity.z *= 0.55;
            casing.spin.multiplyScalar(0.5);
            this.bus.emit('impact:surface', {
              point: casing.position.clone(),
              normal: UP.clone(),
              surface: 'metal',
              incident: DOWN.clone(),
              distance: casing.position.distanceTo(this.cameraPosition),
            });
          }
        }
      }
      this.tmpQuat.setFromEuler(casing.rotation);
      // Fade out by shrinking in the last half second.
      const remaining = casing.life - casing.age;
      const s = remaining < 0.5 ? remaining / 0.5 : 1;
      this.tmpScale.set(s, s, s);
      this.tmpMatrix.compose(casing.position, this.tmpQuat, this.tmpScale);
      this.casings.setMatrixAt(count, this.tmpMatrix);
      count++;
    });
    this.casings.count = count;
    if (count > 0) this.casings.instanceMatrix.needsUpdate = true;
  }

  private updateShockwaves(dt: number): void {
    let count = 0;
    const material = this.shockwaves.material as THREE.MeshBasicMaterial;
    let maxOpacity = 0;
    this.shockwavePool.forEachAlive((wave, index) => {
      wave.age += dt;
      const t = wave.age / wave.life;
      if (t >= 1) {
        this.shockwavePool.release(index);
        return;
      }
      const radius = wave.maxRadius * Math.pow(t, 0.55);
      const opacity = (1 - t) * (1 - t) * 0.55;
      maxOpacity = Math.max(maxOpacity, opacity);
      this.tmpQuat.identity();
      this.tmpScale.set(radius, 1, radius);
      this.tmpMatrix.compose(wave.position, this.tmpQuat, this.tmpScale);
      this.shockwaves.setMatrixAt(count, this.tmpMatrix);
      count++;
    });
    this.shockwaves.count = count;
    material.opacity = maxOpacity;
    if (count > 0) this.shockwaves.instanceMatrix.needsUpdate = true;
  }

  setQuality(quality: QualitySettings): void {
    this.decals.setCapacityHint(quality.decalBudget);
  }

  get stats(): { particles: number; decals: number } {
    return { particles: this.particles.liveCount, decals: this.decals.liveCount };
  }

  /** Dynamic lights currently contributing. Used by the chain-reaction test. */
  get activeLights(): number {
    return this.explosionLight.intensity > 0 ? 1 : 0;
  }

  /** Blast-light readout for the diagnostics data attributes. */
  get blastState(): string {
    const l = this.explosionLight;
    return `${l.intensity.toFixed(0)}/${l.distance.toFixed(1)}m@${l.position.x.toFixed(1)},${l.position.y.toFixed(1)},${l.position.z.toFixed(1)}`;
  }

  clear(): void {
    this.particles.clear();
    this.decals.clear();
    this.tracerPool.releaseAll();
    this.casingPool.releaseAll();
    this.shockwavePool.releaseAll();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.particles.dispose();
    this.decals.dispose();
    this.tracers.dispose();
    this.casings.dispose();
    this.shockwaves.dispose();
    this.muzzleLight.dispose();
    this.explosionLight.dispose();
    this.group.removeFromParent();
  }
}

interface TracerState {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
  travelled: number;
  speed: number;
  width: number;
  fromPlayer: boolean;
}

interface CasingState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  rotation: THREE.Euler;
  age: number;
  life: number;
  resting: boolean;
  bounced: number;
}

interface ShockwaveState {
  position: THREE.Vector3;
  age: number;
  life: number;
  maxRadius: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
/**
 * The blast light sits well above the charge, not at it. A point light 0.6m
 * off the deck puts its 1/d^2 singularity almost ON the ground plane, so the
 * few square metres underneath clip to white while nothing further away
 * receives much - the falloff happens inside the blown-out region where it
 * cannot be seen. Lifting it to chest height moves the falloff out into the
 * visible range, which is what makes the pool of light read as a pool.
 */
const UP_HALF = new THREE.Vector3(0, 1.45, 0);

/**
 * Particle presets. Kept as module constants so every emission of a given kind
 * is identical and the whole VFX look can be re-tuned from one place.
 */
const SPEC: Record<string, ParticleSpec> = {
  muzzleFlare: {
    lifetime: 0.075,
    lifetimeJitter: 0.02,
    size: 0.11,
    sizeJitter: 0.5,
    sizeCurve: (t) => 1 + t * 2.2,
    alphaCurve: (t) => Math.pow(1 - t, 1.6),
    colorStart: new THREE.Color(0xfff0c0),
    colorEnd: new THREE.Color(0xff7a2a),
    brightness: 7,
    drag: 0.02,
  },
  muzzleSmoke: {
    lifetime: 0.85,
    lifetimeJitter: 0.25,
    size: 0.1,
    sizeJitter: 0.4,
    sizeCurve: (t) => 1 + t * 4.5,
    alphaCurve: (t) => Math.min(1, t / 0.1) * Math.pow(1 - t, 2) * 0.42,
    colorStart: new THREE.Color(0x9a9186),
    colorEnd: new THREE.Color(0x50555c),
    brightness: 0.35,
    drag: 0.12,
    gravity: -0.55,
    rotationSpeed: 1.1,
    turbulence: 0.35,
  },
  spark: {
    lifetime: 0.5,
    lifetimeJitter: 0.28,
    size: 0.026,
    sizeJitter: 0.6,
    sizeCurve: (t) => 1 - t * 0.55,
    alphaCurve: (t) => Math.pow(1 - t, 1.1),
    colorStart: new THREE.Color(0xfff2c8),
    colorEnd: new THREE.Color(0xff4400),
    brightness: 9,
    brightnessCurve: (t) => Math.pow(1 - t, 1.5),
    gravity: 11,
    drag: 0.5,
    collideGround: true,
    restitution: 0.32,
  },
  dust: {
    lifetime: 1.05,
    lifetimeJitter: 0.35,
    size: 0.14,
    sizeJitter: 0.5,
    sizeCurve: (t) => 1 + t * 2.6,
    alphaCurve: (t) => Math.min(1, t / 0.08) * Math.pow(1 - t, 1.9) * 0.65,
    colorStart: new THREE.Color(0xa9a094),
    colorEnd: new THREE.Color(0x5d5a55),
    brightness: 0,
    gravity: 1.1,
    drag: 0.16,
    rotationSpeed: 1.4,
    turbulence: 0.3,
  },
  chunk: {
    lifetime: 1.4,
    lifetimeJitter: 0.5,
    size: 0.035,
    sizeJitter: 0.7,
    alphaCurve: (t) => (t > 0.86 ? (1 - t) / 0.14 : 1),
    colorStart: new THREE.Color(0x6a6560),
    colorEnd: new THREE.Color(0x3e3b38),
    brightness: 0,
    gravity: 15,
    drag: 0.75,
    rotationSpeed: 8,
    collideGround: true,
    restitution: 0.24,
  },
  splash: {
    lifetime: 0.6,
    lifetimeJitter: 0.2,
    size: 0.09,
    sizeJitter: 0.5,
    sizeCurve: (t) => 1 + t * 1.6,
    alphaCurve: (t) => Math.pow(1 - t, 1.4) * 0.8,
    colorStart: new THREE.Color(0xc8d8e4),
    colorEnd: new THREE.Color(0x6d8494),
    brightness: 0.5,
    gravity: 9,
    drag: 0.4,
  },
  hitSpall: {
    lifetime: 0.32,
    lifetimeJitter: 0.12,
    size: 0.02,
    sizeJitter: 0.5,
    alphaCurve: (t) => Math.pow(1 - t, 1.3),
    colorStart: new THREE.Color(0xff9a6a),
    colorEnd: new THREE.Color(0x8a2a12),
    brightness: 2.2,
    gravity: 9,
    drag: 0.45,
  },
  hitMist: {
    lifetime: 0.5,
    lifetimeJitter: 0.15,
    size: 0.07,
    sizeJitter: 0.4,
    sizeCurve: (t) => 1 + t * 2,
    alphaCurve: (t) => Math.pow(1 - t, 2) * 0.5,
    colorStart: new THREE.Color(0x5a3630),
    colorEnd: new THREE.Color(0x2e2220),
    brightness: 0,
    gravity: 1.6,
    drag: 0.25,
  },
  fireball: {
    lifetime: 0.34,
    lifetimeJitter: 0.12,
    size: 0.42,
    sizeJitter: 0.45,
    // Grows less than before: a fireball that expands to fill the screen is
    // what made the flash read as a global tint instead of a local event.
    sizeCurve: (t) => 0.5 + t * 1.5,
    alphaCurve: (t) => Math.pow(1 - t, 1.5),
    colorStart: new THREE.Color(0xffe9b0),
    colorEnd: new THREE.Color(0xff3c08),
    // 11 was enough to clip the frame to white on its own once the blast light
    // was added on top. The fireball should read as hot, not as a lens flare.
    brightness: 5.5,
    brightnessCurve: (t) => Math.pow(1 - t, 1.8),
    drag: 0.1,
    gravity: -3.5,
    rotationSpeed: 2.2,
  },
  explosionSmoke: {
    lifetime: 3.1,
    lifetimeJitter: 1.1,
    size: 0.75,
    sizeJitter: 0.5,
    sizeCurve: (t) => 0.6 + t * 3.0,
    // Alpha must fall FASTER than the puff grows. A fixed mass of smoke
    // spread over a 3x larger radius is roughly an order of magnitude less
    // dense, so holding alpha near its peak while the sprite triples in size
    // manufactures smoke out of nothing - and 16 of those at 7m turn the
    // whole frame, sky included, into a flat coloured veil.
    alphaCurve: (t) => Math.min(1, t / 0.06) * Math.pow(1 - t, 2.4) * 0.6,
    colorStart: new THREE.Color(0x6a5a4c),
    colorEnd: new THREE.Color(0x2f3339),
    brightness: 0.9,
    brightnessCurve: (t) => Math.pow(1 - t, 3),
    gravity: -1.5,
    drag: 0.28,
    rotationSpeed: 0.9,
    turbulence: 0.55,
  },
  groundDust: {
    lifetime: 1.9,
    lifetimeJitter: 0.6,
    size: 0.5,
    sizeJitter: 0.4,
    sizeCurve: (t) => 0.5 + t * 2.9,
    alphaCurve: (t) => Math.min(1, t / 0.05) * Math.pow(1 - t, 2.2) * 0.45,
    colorStart: new THREE.Color(0x8f857a),
    colorEnd: new THREE.Color(0x45464a),
    brightness: 0.2,
    gravity: 0.6,
    drag: 0.12,
    rotationSpeed: 1.2,
    turbulence: 0.4,
  },
  debrisSpark: {
    lifetime: 1.5,
    lifetimeJitter: 0.7,
    size: 0.035,
    sizeJitter: 0.7,
    sizeCurve: (t) => 1 - t * 0.4,
    alphaCurve: (t) => Math.pow(1 - t, 1.2),
    colorStart: new THREE.Color(0xffe0a0),
    colorEnd: new THREE.Color(0xd02a00),
    brightness: 4.5,
    brightnessCurve: (t) => Math.pow(1 - t, 2),
    gravity: 13,
    drag: 0.72,
    collideGround: true,
    restitution: 0.38,
  },
};
