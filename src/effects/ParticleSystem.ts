import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { clamp01 } from '@/core/MathUtils';
import { PARTICLE_ADDITIVE_FRAG, PARTICLE_LIT_FRAG, PARTICLE_VERT } from '@/shaders/ParticleShader';

/**
 * Fixed-budget instanced particle pool.
 *
 * ONE InstancedMesh per blend mode, allocated at construction and never grown.
 * When the pool is full the oldest particle is recycled, so a chain of
 * explosions degrades gracefully instead of tanking the frame rate.
 *
 * Simulation runs on the CPU (needed for gravity, drag, turbulence and ground
 * bounce) but only the live prefix of each attribute array is uploaded, and the
 * arrays are written in one pass, so 1000 live particles cost well under 0.2ms.
 */

export interface ParticleSpec {
  lifetime: number;
  /** Randomised +-, added to lifetime. */
  lifetimeJitter?: number;
  size: number;
  sizeJitter?: number;
  /** Multiplier applied to size over the particle's life. */
  sizeCurve?: (t: number) => number;
  /** Alpha over life. Defaults to a smooth fade in/out. */
  alphaCurve?: (t: number) => number;
  /** Colour at birth and at death. */
  colorStart: THREE.Color;
  colorEnd?: THREE.Color;
  /** Extra brightness for additive/emissive particles. */
  brightness?: number;
  brightnessCurve?: (t: number) => number;
  gravity?: number;
  /** Per-second velocity damping factor (1 = none, 0.2 = heavy air drag). */
  drag?: number;
  rotationSpeed?: number;
  /** Curl-noise-ish wander strength, in m/s^2. */
  turbulence?: number;
  /** Bounce off the ground plane instead of passing through it. */
  collideGround?: boolean;
  restitution?: number;
  /** World Y of the ground plane for the collision test. */
  groundY?: number;
}

type Blend = 'additive' | 'lit';

interface ParticleState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  spec: ParticleSpec;
  active: boolean;
  seed: number;
}

class ParticleBatch {
  readonly mesh: THREE.InstancedMesh | THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.InstancedBufferGeometry;
  private states: ParticleState[] = [];
  private cursor = 0;
  private liveCount = 0;

  private aPosition: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aRotation: THREE.InstancedBufferAttribute;
  private aAlpha: THREE.InstancedBufferAttribute;
  private aParams: THREE.InstancedBufferAttribute;

  private tmpColor = new THREE.Color();

  constructor(
    readonly capacity: number,
    blend: Blend,
    texture: THREE.Texture,
    sharedUniforms: Record<string, THREE.IUniform>,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.attributes.position = quad.attributes.position;
    this.geometry.attributes.uv = quad.attributes.uv;
    quad.dispose();

    this.aPosition = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aRotation = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    for (const attr of [this.aPosition, this.aColor, this.aSize, this.aRotation, this.aAlpha, this.aParams]) {
      attr.setUsage(THREE.DynamicDrawUsage);
    }
    this.geometry.setAttribute('aPosition', this.aPosition);
    this.geometry.setAttribute('aColor', this.aColor);
    this.geometry.setAttribute('aSize', this.aSize);
    this.geometry.setAttribute('aRotation', this.aRotation);
    this.geometry.setAttribute('aAlpha', this.aAlpha);
    this.geometry.setAttribute('aParams', this.aParams);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: blend === 'additive' ? PARTICLE_ADDITIVE_FRAG : PARTICLE_LIT_FRAG,
      uniforms: { uTexture: { value: texture }, ...sharedUniforms },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = blend === 'additive' ? 12 : 10;
    this.mesh.layers.set(LAYER.WORLD);

    for (let i = 0; i < capacity; i++) {
      this.states.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        age: 0, life: 1, size: 1, rotation: 0, rotationSpeed: 0,
        spec: null as unknown as ParticleSpec, active: false, seed: Math.random(),
      });
    }
  }

  get live(): number {
    return this.liveCount;
  }

  spawn(
    spec: ParticleSpec,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
  ): void {
    // Round-robin: when full, the oldest slot is overwritten.
    let index = -1;
    for (let i = 0; i < this.capacity; i++) {
      const candidate = (this.cursor + i) % this.capacity;
      if (!this.states[candidate].active) {
        index = candidate;
        break;
      }
    }
    if (index < 0) index = this.cursor;
    else this.liveCount++;
    this.cursor = (index + 1) % this.capacity;

    const p = this.states[index];
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.age = 0;
    p.life = spec.lifetime + (spec.lifetimeJitter ? (Math.random() * 2 - 1) * spec.lifetimeJitter : 0);
    p.size = spec.size * (1 + (spec.sizeJitter ?? 0) * (Math.random() * 2 - 1));
    p.rotation = Math.random() * Math.PI * 2;
    p.rotationSpeed = (spec.rotationSpeed ?? 0) * (Math.random() * 2 - 1);
    p.spec = spec;
    p.active = true;
    p.seed = Math.random();
  }

  update(dt: number, elapsed: number): void {
    let writeIndex = 0;
    const pos = this.aPosition.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    const rot = this.aRotation.array as Float32Array;
    const alpha = this.aAlpha.array as Float32Array;
    const params = this.aParams.array as Float32Array;

    for (let i = 0; i < this.capacity; i++) {
      const p = this.states[i];
      if (!p.active) continue;
      const spec = p.spec;

      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        this.liveCount--;
        continue;
      }
      const t = clamp01(p.age / p.life);

      if (spec.gravity) p.vy -= spec.gravity * dt;
      if (spec.drag !== undefined && spec.drag < 1) {
        const damping = Math.pow(spec.drag, dt);
        p.vx *= damping;
        p.vy *= damping;
        p.vz *= damping;
      }
      if (spec.turbulence) {
        // Cheap pseudo-curl: three detuned sines seeded per particle.
        const s = p.seed * 40;
        p.vx += Math.sin(elapsed * 1.7 + s) * spec.turbulence * dt;
        p.vy += Math.sin(elapsed * 1.3 + s * 1.7) * spec.turbulence * 0.5 * dt;
        p.vz += Math.cos(elapsed * 1.9 + s * 2.3) * spec.turbulence * dt;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rotation += p.rotationSpeed * dt;

      if (spec.collideGround) {
        const groundY = spec.groundY ?? 0;
        if (p.y < groundY) {
          p.y = groundY;
          p.vy = -p.vy * (spec.restitution ?? 0.3);
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
      }

      // --- write instance attributes ---
      const sizeMul = spec.sizeCurve ? spec.sizeCurve(t) : 1;
      const a = spec.alphaCurve ? spec.alphaCurve(t) : defaultAlphaCurve(t);
      if (a <= 0.002) continue;

      this.tmpColor.copy(spec.colorStart);
      if (spec.colorEnd) this.tmpColor.lerp(spec.colorEnd, t);

      pos[writeIndex * 3] = p.x;
      pos[writeIndex * 3 + 1] = p.y;
      pos[writeIndex * 3 + 2] = p.z;
      col[writeIndex * 3] = this.tmpColor.r;
      col[writeIndex * 3 + 1] = this.tmpColor.g;
      col[writeIndex * 3 + 2] = this.tmpColor.b;
      size[writeIndex] = p.size * sizeMul;
      rot[writeIndex] = p.rotation;
      alpha[writeIndex] = a;
      params[writeIndex * 2] =
        (spec.brightness ?? 0) * (spec.brightnessCurve ? spec.brightnessCurve(t) : 1);
      params[writeIndex * 2 + 1] = t;
      writeIndex++;
    }

    this.geometry.instanceCount = writeIndex;
    if (writeIndex > 0) {
      this.aPosition.addUpdateRange(0, writeIndex * 3);
      this.aColor.addUpdateRange(0, writeIndex * 3);
      this.aSize.addUpdateRange(0, writeIndex);
      this.aRotation.addUpdateRange(0, writeIndex);
      this.aAlpha.addUpdateRange(0, writeIndex);
      this.aParams.addUpdateRange(0, writeIndex * 2);
      this.aPosition.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aRotation.needsUpdate = true;
      this.aAlpha.needsUpdate = true;
      this.aParams.needsUpdate = true;
    }
  }

  clear(): void {
    for (const p of this.states) p.active = false;
    this.liveCount = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const defaultAlphaCurve = (t: number): number =>
  Math.min(1, t / 0.12) * (1 - Math.pow(t, 2.2));

/**
 * Owns both particle batches plus the uniforms they share with the renderer
 * (depth texture for soft particles, sun/ambient for smoke lighting).
 */
export class ParticleSystem {
  readonly group = new THREE.Group();
  private additive: ParticleBatch;
  private lit: ParticleBatch;
  private sharedUniforms: Record<string, THREE.IUniform>;

  constructor(budget: number, sparkTexture: THREE.Texture, smokeTexture: THREE.Texture) {
    this.group.name = 'Particles';
    this.sharedUniforms = {
      uDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.05 },
      uFar: { value: 700 },
      uSoftness: { value: 0 },
      uSunDirection: { value: new THREE.Vector3(1, 0.1, 0) },
      uSunColor: { value: new THREE.Color(0xffb070) },
      uAmbientColor: { value: new THREE.Color(0x3d5a7a) },
      uAmbientIntensity: { value: 0.85 },
    };
    // Sparks and fire are the smaller half of the budget: smoke needs more
    // instances to build up density.
    this.additive = new ParticleBatch(Math.round(budget * 0.45), 'additive', sparkTexture, this.sharedUniforms);
    this.lit = new ParticleBatch(Math.round(budget * 0.55), 'lit', smokeTexture, this.sharedUniforms);
    this.group.add(this.additive.mesh, this.lit.mesh);
  }

  /** Wired once per frame by the renderer so soft particles can read depth. */
  setDepthTexture(depth: THREE.Texture | null, width: number, height: number, near: number, far: number): void {
    this.sharedUniforms.uDepth.value = depth;
    (this.sharedUniforms.uResolution.value as THREE.Vector2).set(width, height);
    this.sharedUniforms.uNear.value = near;
    this.sharedUniforms.uFar.value = far;
    this.sharedUniforms.uSoftness.value = depth ? 0.55 : 0;
  }

  setLighting(sunDirection: THREE.Vector3, sunColor: THREE.Color, ambientColor: THREE.Color, ambientIntensity: number): void {
    (this.sharedUniforms.uSunDirection.value as THREE.Vector3).copy(sunDirection);
    (this.sharedUniforms.uSunColor.value as THREE.Color).copy(sunColor);
    (this.sharedUniforms.uAmbientColor.value as THREE.Color).copy(ambientColor);
    this.sharedUniforms.uAmbientIntensity.value = ambientIntensity * 0.5;
  }

  emit(
    blend: Blend,
    spec: ParticleSpec,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
  ): void {
    const batch = blend === 'additive' ? this.additive : this.lit;
    batch.spawn(spec, position.x, position.y, position.z, velocity.x, velocity.y, velocity.z);
  }

  emitBurst(
    blend: Blend,
    spec: ParticleSpec,
    count: number,
    position: THREE.Vector3,
    direction: THREE.Vector3,
    speed: number,
    spread: number,
    positionJitter = 0,
  ): void {
    const batch = blend === 'additive' ? this.additive : this.lit;
    for (let i = 0; i < count; i++) {
      // Cone around `direction`, uniformly distributed.
      tmpDir.copy(direction).normalize();
      tmpDir.x += (Math.random() * 2 - 1) * spread;
      tmpDir.y += (Math.random() * 2 - 1) * spread;
      tmpDir.z += (Math.random() * 2 - 1) * spread;
      tmpDir.normalize().multiplyScalar(speed * (0.45 + Math.random() * 0.9));
      batch.spawn(
        spec,
        position.x + (Math.random() * 2 - 1) * positionJitter,
        position.y + (Math.random() * 2 - 1) * positionJitter,
        position.z + (Math.random() * 2 - 1) * positionJitter,
        tmpDir.x,
        tmpDir.y,
        tmpDir.z,
      );
    }
  }

  update(dt: number, elapsed: number): void {
    this.additive.update(dt, elapsed);
    this.lit.update(dt, elapsed);
  }

  get liveCount(): number {
    return this.additive.live + this.lit.live;
  }

  clear(): void {
    this.additive.clear();
    this.lit.clear();
  }

  dispose(): void {
    this.additive.dispose();
    this.lit.dispose();
    this.group.removeFromParent();
  }
}

const tmpDir = new THREE.Vector3();
