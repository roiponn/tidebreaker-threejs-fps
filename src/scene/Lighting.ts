import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { sharedFogUniforms } from '@/materials/FogPatch';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';
import type { SkyDome } from './SkyDome';

/**
 * Key light, fill, atmosphere and the environment probe.
 *
 * Design rules for this scene:
 *  - ONE shadow-casting directional light. Every additional shadow map is a
 *    full extra scene render; the practicals fake their contact darkening with
 *    baked-in AO instead.
 *  - The hemisphere fill is deliberately generous (0.85). "Cinematic" does not
 *    mean crushed blacks - an enemy standing in shadow must still be readable,
 *    which is a gameplay requirement, not a taste one.
 *  - The environment probe is generated from the sky dome only, so reflections
 *    on wet asphalt and gun metal agree with the sky the player can see.
 */
export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemisphere: THREE.HemisphereLight;
  private envScene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private shadowTargetOffset = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private sky: SkyDome,
    private visual: MutableVisual,
    renderer: THREE.WebGLRenderer,
    quality: QualitySettings,
  ) {
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.name = 'KeyLight';
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    this.sun.shadow.bias = visual.sun.shadowBias;
    this.sun.shadow.normalBias = visual.sun.shadowNormalBias;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = visual.sun.shadowFar;
    // Lights must be visible to BOTH cameras so the view-model is lit too.
    this.sun.layers.enable(LAYER.VIEWMODEL);
    this.sun.target.layers.enable(LAYER.VIEWMODEL);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.hemisphere.name = 'AmbientFill';
    this.hemisphere.layers.enable(LAYER.VIEWMODEL);
    scene.add(this.hemisphere);

    scene.fog = new THREE.FogExp2(visual.fog.color, visual.fog.density);

    // Probe scene: just the sky. Rendering the whole harbour into a cubemap
    // would be slow and would double-count light that is already direct.
    this.envScene = new THREE.Scene();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.refresh();
    this.rebuildEnvironment(renderer);
  }

  /** Re-reads the visual config. Called on boot and by the debug panel. */
  refresh(): void {
    const v = this.visual;
    const t = v.sky.timeOfDay;

    this.sun.color.copy(this.sky.sunColor);
    this.sun.intensity = THREE.MathUtils.lerp(v.sun.intensityDay, v.sun.intensityNight, t);
    this.sun.shadow.bias = v.sun.shadowBias;
    this.sun.shadow.normalBias = v.sun.shadowNormalBias;

    const cam = this.sun.shadow.camera;
    const r = v.sun.shadowRadius;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.far = v.sun.shadowFar;
    cam.updateProjectionMatrix();

    this.hemisphere.color.setHex(v.ambient.skyColor);
    this.hemisphere.groundColor.setHex(v.ambient.groundColor);
    this.hemisphere.intensity = v.ambient.intensity;

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setHex(v.fog.color);
    fog.density = v.fog.density;

    sharedFogUniforms.uMistHeight.value = v.fog.mistHeight;
    sharedFogUniforms.uMistDensity.value = v.fog.mistDensity;
    (sharedFogUniforms.uAerialColor.value as THREE.Color).setHex(v.fog.aerialColor);
    sharedFogUniforms.uAerialStrength.value = v.fog.aerialStrength;
    (sharedFogUniforms.uFogSunDir.value as THREE.Vector3).copy(this.sky.sunDirection);
    (sharedFogUniforms.uFogSunColor.value as THREE.Color).copy(this.sky.sunColor);
    // Sun scatter fades as night falls, otherwise the fog glows for no reason.
    sharedFogUniforms.uFogSunStrength.value = THREE.MathUtils.lerp(0.55, 0.06, t);

    this.scene.background = null;
  }

  /** Regenerates the PMREM probe from the current sky. Cheap enough to redo
   *  whenever time-of-day changes, but not something to run every frame. */
  rebuildEnvironment(renderer: THREE.WebGLRenderer): void {
    const previous = this.envTarget;
    this.envScene.add(this.sky.mesh);
    // The probe must see the dome from the origin, unscaled by camera position.
    this.sky.mesh.position.set(0, 0, 0);
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.04, 0.1, 1000);
    this.scene.add(this.sky.mesh);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.visual.ambient.envIntensity;
    previous?.dispose();
    void renderer;
  }

  setEnvIntensity(value: number): void {
    this.scene.environmentIntensity = value;
  }

  setShadowsEnabled(enabled: boolean, mapSize: number): void {
    this.sun.castShadow = enabled;
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  /**
   * Keeps the shadow frustum wrapped tightly around the player.
   * A static 200m ortho box at 2048 would give ~10cm texels; following the
   * camera with a 46m box gives ~2cm, which is what makes the contact shadows
   * under crates read as contact rather than mush.
   */
  update(cameraPosition: THREE.Vector3): void {
    const dir = this.sky.sunDirection;
    // Snap the shadow centre to texel-sized steps to stop shadow edges
    // crawling as the player walks - the classic "shimmering shadow" bug.
    const texelWorldSize = (this.visual.sun.shadowRadius * 2) / this.sun.shadow.mapSize.x;
    const snap = (v: number): number => Math.round(v / texelWorldSize) * texelWorldSize;
    this.shadowTargetOffset.set(snap(cameraPosition.x), snap(cameraPosition.y), snap(cameraPosition.z));

    this.sun.target.position.copy(this.shadowTargetOffset);
    this.sun.position.copy(this.shadowTargetOffset).addScaledVector(dir, 80);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sun.dispose();
    this.hemisphere.dispose();
  }
}
