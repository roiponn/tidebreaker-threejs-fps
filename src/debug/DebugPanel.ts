import GUI from 'lil-gui';
import type { MutableVisual } from '@/config/visual';
import type { QualityLevel } from '@/config/quality';

/**
 * Live tuning panel (lil-gui).
 *
 * Hidden by default and toggled with the backquote key, so the shipped
 * experience never shows it. Every control writes into the mutable visual
 * config and then calls the matching `apply` callback, which is the same code
 * path used at boot - there is no second, panel-only rendering path that could
 * drift from the real one.
 *
 * The panel is created lazily on first toggle: lil-gui is ~30KB and there is
 * no reason to pay for it during the initial load.
 */
export interface DebugHooks {
  /** Re-reads sky/sun/ambient/fog and rebuilds the environment probe. */
  applyLighting(): void;
  /** Re-reads wetness / reflection settings. */
  applyWetness(): void;
  /** Re-reads the practical light settings. */
  applyPracticals(): void;
  setQuality(level: QualityLevel): void;
  setEnemiesEnabled(enabled: boolean): void;
  setParticleScale(scale: number): void;
  respawn(): void;
}

export interface DebugState {
  quality: QualityLevel;
  enemiesEnabled: boolean;
  particleScale: number;
  recoilScale: number;
  cameraShakeScale: number;
  muzzleFlashScale: number;
  showPerf: boolean;
}

export class DebugPanel {
  private gui: GUI | null = null;
  private visible = false;

  constructor(
    private readonly visual: MutableVisual,
    private readonly state: DebugState,
    private readonly hooks: DebugHooks,
  ) {}

  toggle(): void {
    if (!this.gui) this.build();
    this.visible = !this.visible;
    if (this.gui) this.gui.domElement.style.display = this.visible ? '' : 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private build(): void {
    const gui = new GUI({ title: 'TIDEBREAKER // DEBUG', width: 320 });
    this.gui = gui;
    gui.domElement.style.zIndex = '40';
    // lil-gui grabs pointer events; the game canvas keeps pointer lock, so the
    // panel is only usable when the player releases the mouse.
    gui.domElement.style.pointerEvents = 'auto';

    const lighting = this.hooks.applyLighting;
    const wetness = this.hooks.applyWetness;

    // --- time of day / sun ---
    const sky = gui.addFolder('Time of day & sun');
    sky.add(this.visual.sky, 'timeOfDay', 0, 1, 0.01).name('Time (dusk -> night)').onChange(lighting);
    sky.add(this.visual.sun, 'elevation', -4, 30, 0.1).name('Sun elevation').onChange(lighting);
    sky.add(this.visual.sun, 'azimuth', 0, 360, 1).name('Sun azimuth').onChange(lighting);
    sky.add(this.visual.sun, 'intensityDay', 0, 8, 0.05).name('Sun intensity').onChange(lighting);
    sky.addColor(this.visual.sun, 'colorDay').name('Sun colour').onChange(lighting);
    sky.add(this.visual.sky, 'cloudCoverage', 0, 1, 0.01).name('Cloud coverage').onChange(lighting);
    sky.add(this.visual.sky, 'starIntensity', 0, 2, 0.01).name('Stars').onChange(lighting);

    // --- ambient / environment ---
    const ambient = gui.addFolder('Ambient & environment');
    ambient.add(this.visual.ambient, 'intensity', 0, 3, 0.01).name('Hemisphere fill').onChange(lighting);
    ambient.addColor(this.visual.ambient, 'skyColor').name('Sky fill colour').onChange(lighting);
    ambient.addColor(this.visual.ambient, 'groundColor').name('Bounce colour').onChange(lighting);
    ambient.add(this.visual.ambient, 'envIntensity', 0, 3, 0.01).name('Env probe').onChange(lighting);

    // --- fog ---
    const fog = gui.addFolder('Atmosphere');
    fog.add(this.visual.fog, 'density', 0, 0.05, 0.0005).name('Fog density').onChange(lighting);
    fog.addColor(this.visual.fog, 'color').name('Fog colour').onChange(lighting);
    fog.add(this.visual.fog, 'mistHeight', 0.2, 12, 0.1).name('Mist height').onChange(lighting);
    fog.add(this.visual.fog, 'mistDensity', 0, 3, 0.01).name('Mist density').onChange(lighting);
    fog.add(this.visual.fog, 'aerialStrength', 0, 1.5, 0.01).name('Aerial perspective').onChange(lighting);
    fog.addColor(this.visual.fog, 'aerialColor').name('Aerial colour').onChange(lighting);

    // --- exposure / grade ---
    const grade = gui.addFolder('Exposure & grade');
    grade.add(this.visual.exposure, 'base', 0.2, 3, 0.01).name('Exposure');
    grade.add(this.visual.exposure, 'adaptionRange', 0, 0.8, 0.01).name('Auto-exposure range');
    grade.add(this.visual.exposure, 'adaptionSpeed', 0.05, 4, 0.05).name('Adaptation speed');
    grade.add(this.visual.bloom, 'strength', 0, 2, 0.01).name('Bloom strength');
    grade.add(this.visual.bloom, 'radius', 0.2, 2, 0.01).name('Bloom radius');
    grade.add(this.visual.bloom, 'threshold', 0, 4, 0.01).name('Bloom threshold');
    grade.add(this.visual.grade, 'contrast', 0.5, 1.8, 0.01).name('Contrast');
    grade.add(this.visual.grade, 'saturation', 0, 2, 0.01).name('Saturation');
    grade.addColor(this.visual.grade, 'splitToneShadow').name('Shadow tone');
    grade.addColor(this.visual.grade, 'splitToneHighlight').name('Highlight tone');
    grade.add(this.visual.grade, 'splitToneBalance', 0, 1, 0.01).name('Split balance');
    grade.add(this.visual.grade, 'vignette', 0, 1, 0.01).name('Vignette');
    grade.add(this.visual.grade, 'grain', 0, 0.15, 0.001).name('Grain');
    grade.add(this.visual.grade, 'chromaticAberration', 0, 0.01, 0.0001).name('Chromatic aberration');

    // --- shadows / AO / DoF ---
    const detail = gui.addFolder('Shadows, AO & focus');
    detail.add(this.visual.sun, 'shadowRadius', 10, 120, 1).name('Shadow range').onChange(lighting);
    detail.add(this.visual.sun, 'shadowBias', -0.005, 0.001, 0.0001).name('Shadow bias').onChange(lighting);
    detail.add(this.visual.sun, 'shadowNormalBias', 0, 0.2, 0.005).name('Shadow normal bias').onChange(lighting);
    detail.add(this.visual.ao, 'enabled').name('SSAO');
    detail.add(this.visual.ao, 'radius', 0.1, 3, 0.05).name('AO radius');
    detail.add(this.visual.ao, 'intensity', 0, 2, 0.01).name('AO intensity');
    detail.add(this.visual.dof, 'enabled').name('Depth of field');
    detail.add(this.visual.dof, 'strength', 0, 2, 0.01).name('DoF strength');
    detail.add(this.visual.motion, 'blurStrength', 0, 2, 0.01).name('Motion blur');

    // --- rain / puddles ---
    const wet = gui.addFolder('Rain & puddles');
    wet.add(this.visual.wetness, 'rainAmount', 0, 1, 0.01).name('Rain amount').onChange(wetness);
    wet.add(this.visual.wetness, 'global', 0, 1, 0.01).name('Surface wetness').onChange(wetness);
    wet.add(this.visual.wetness, 'puddleReflectivity', 0, 1, 0.01).name('Puddle reflection').onChange(wetness);
    wet.add(this.visual.wetness, 'rippleStrength', 0, 1.5, 0.01).name('Ripple strength').onChange(wetness);
    wet.add(this.visual.wetness, 'rippleSpeed', 0, 4, 0.01).name('Ripple speed').onChange(wetness);

    // --- practicals ---
    const lamps = gui.addFolder('Practical lights');
    lamps.add(this.visual.practicals, 'floodIntensity', 0, 160, 1).name('Floodlight intensity');
    lamps.add(this.visual.practicals, 'shaftOpacity', 0, 0.4, 0.002).name('Light shafts').onChange(this.hooks.applyPracticals);
    lamps.add(this.visual.practicals, 'beaconSpeed', 0, 6, 0.05).name('Beacon speed');

    // --- feel ---
    const feel = gui.addFolder('Weapon & camera feel');
    feel.add(this.state, 'recoilScale', 0, 3, 0.05).name('Recoil scale');
    feel.add(this.state, 'cameraShakeScale', 0, 3, 0.05).name('Camera shake');
    feel.add(this.visual.muzzle, 'lightIntensity', 0, 800, 5).name('Muzzle flash light');
    feel.add(this.visual.muzzle, 'flashScale', 0, 1.2, 0.01).name('Muzzle flash size');
    feel.add(this.visual.muzzle, 'lightDuration', 0.01, 0.2, 0.005).name('Flash duration');

    // --- systems ---
    const systems = gui.addFolder('Systems');
    systems
      .add(this.state, 'quality', ['low', 'medium', 'high'])
      .name('Quality preset')
      .onChange((value: QualityLevel) => this.hooks.setQuality(value));
    systems
      .add(this.state, 'enemiesEnabled')
      .name('Enemies active')
      .onChange((value: boolean) => this.hooks.setEnemiesEnabled(value));
    systems
      .add(this.state, 'particleScale', 0, 1, 0.05)
      .name('Particle amount')
      .onChange((value: number) => this.hooks.setParticleScale(value));
    systems.add({ respawn: () => this.hooks.respawn() }, 'respawn').name('Restart mission');

    // Start collapsed so the panel is scannable.
    for (const folder of [sky, ambient, fog, grade, detail, wet, lamps, feel, systems]) {
      folder.close();
    }
    gui.domElement.style.display = 'none';
  }

  dispose(): void {
    this.gui?.destroy();
    this.gui = null;
  }
}
