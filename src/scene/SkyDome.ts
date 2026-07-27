import * as THREE from 'three';
import { SKY_FRAG, SKY_VERT } from '@/shaders/SkyShader';
import type { MutableVisual } from '@/config/visual';
import { DEG } from '@/core/MathUtils';

/**
 * The sky dome and the authoritative source of the sun direction.
 *
 * Everything else - the directional light, the fog sun-scatter term, the
 * environment probe - reads `sunDirection` from here, so the sun in the sky and
 * the shadows on the ground can never disagree. That single source of truth is
 * what makes the lighting look "grounded" instead of arbitrary.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly sunDirection = new THREE.Vector3();
  /** Sun colour after time-of-day interpolation - used by the key light. */
  readonly sunColor = new THREE.Color();
  /** 0 at dusk, 1 at full night. */
  night = 0;

  private material: THREE.ShaderMaterial;
  private geometry: THREE.SphereGeometry;

  constructor(private visual: MutableVisual) {
    this.geometry = new THREE.SphereGeometry(1, 48, 32);
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uUpper: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunColor: { value: new THREE.Color() },
        uSunDirection: { value: new THREE.Vector3(1, 0.05, 0) },
        uSunGlowPower: { value: 220 },
        uNight: { value: 0 },
        uStarIntensity: { value: 0.55 },
        uCloudCoverage: { value: 0.62 },
        uCloudSpeed: { value: 0.0035 },
        uTime: { value: 0 },
        uHazeColor: { value: new THREE.Color(0x223047) },
        uHazeStrength: { value: 0.72 },
        uStormDirection: { value: new THREE.Vector3(-0.75, 0, 0.66).normalize() },
        uStormStrength: { value: 0.55 },
        uFlashColor: { value: new THREE.Color(0xffb066) },
        uFlashStrength: { value: 0 },
        uFlashDirection: { value: new THREE.Vector3(-1, 0.1, 0.4) },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'SkyDome';
    // The dome is pinned to the camera, so a modest radius is enough; the
    // vertex shader pushes it to the far plane anyway.
    this.mesh.scale.setScalar(400);
    this.mesh.frustumCulled = false;
    // Draw the dome LAST in the opaque pass, not first.
    //
    // The sky is now the most expensive fragment shader in the scene (two
    // cloud decks, ~13 octaves of noise). At renderOrder -1000 it shaded every
    // pixel of the screen and was then overdrawn by the entire harbour. With
    // depthWrite off and depthTest on, drawing it after the opaque geometry
    // lets the depth buffer reject everything that is already covered.
    this.mesh.renderOrder = 1000;
    this.mesh.matrixAutoUpdate = true;

    this.refresh();
  }

  /** Recomputes every derived value from the visual config. Call after edits. */
  refresh(): void {
    const sky = this.visual.sky;
    const sun = this.visual.sun;
    const t = THREE.MathUtils.clamp(sky.timeOfDay, 0, 1);
    this.night = t;

    const u = this.material.uniforms;
    (u.uZenith.value as THREE.Color).setHex(sky.zenithDay).lerp(new THREE.Color(sky.zenithNight), t);
    (u.uUpper.value as THREE.Color).setHex(sky.upperDay).lerp(new THREE.Color(sky.upperNight), t);
    (u.uHorizon.value as THREE.Color).setHex(sky.horizonDay).lerp(new THREE.Color(sky.horizonNight), t);
    (u.uGround.value as THREE.Color).setHex(sky.groundHaze);
    this.sunColor.setHex(sun.colorDay).lerp(new THREE.Color(sun.colorNight), t);
    (u.uSunColor.value as THREE.Color).copy(this.sunColor);
    u.uSunGlowPower.value = sky.sunGlowPower;
    u.uNight.value = t;
    u.uStarIntensity.value = sky.starIntensity;
    u.uCloudCoverage.value = sky.cloudCoverage;
    u.uCloudSpeed.value = sky.cloudSpeed;
    u.uHazeStrength.value = sky.hazeStrength;
    u.uStormStrength.value = sky.stormStrength;
    (u.uStormDirection.value as THREE.Vector3)
      .set(Math.sin(sky.stormAzimuth * DEG), 0, Math.cos(sky.stormAzimuth * DEG))
      .normalize();

    // Elevation drops and azimuth swings slightly as the slice progresses.
    const elevation = sun.elevation * DEG;
    const azimuth = sun.azimuth * DEG;
    this.sunDirection.set(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );
    (u.uSunDirection.value as THREE.Vector3).copy(this.sunDirection);
  }

  /**
   * The horizon haze band is painted with the SCENE's fog colour, so the dome
   * and the distant scenery dissolve into one another. Lighting owns the fog
   * colour, so it pushes it here whenever it changes.
   */
  setHazeColor(color: THREE.Color): void {
    (this.material.uniforms.uHazeColor.value as THREE.Color).copy(color);
  }

  /** Distant artillery lighting the cloud base. */
  setFlash(strength: number, direction: THREE.Vector3, color: THREE.Color): void {
    this.material.uniforms.uFlashStrength.value = strength;
    (this.material.uniforms.uFlashDirection.value as THREE.Vector3).copy(direction);
    (this.material.uniforms.uFlashColor.value as THREE.Color).copy(color);
  }

  update(elapsed: number, cameraPosition: THREE.Vector3): void {
    this.material.uniforms.uTime.value = elapsed;
    this.mesh.position.copy(cameraPosition);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
