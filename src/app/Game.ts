import * as THREE from 'three';
import { cloneVisualConfig, type MutableVisual } from '@/config/visual';
import { WEAPON_CONFIG } from '@/config/gameplay';
import { DEFAULT_QUALITY, QUALITY_PRESETS, detectQuality, type QualityLevel } from '@/config/quality';

import { GameClock } from '@/core/Clock';
import { Disposer, listen } from '@/core/Disposal';
import { EventBus } from '@/core/EventBus';
import { Input } from '@/core/Input';
import { LAYER } from '@/core/Layers';
import { clamp01 } from '@/core/MathUtils';
import { RenderSystem } from '@/core/RenderSystem';

import { installFogPatch } from '@/materials/FogPatch';
import { MaterialLibrary } from '@/materials/MaterialLibrary';
import { TextureFactory } from '@/materials/TextureFactory';
import { updateWind } from '@/materials/WindMaterial';

import { SkyDome } from '@/scene/SkyDome';
import { Lighting } from '@/scene/Lighting';
import { HarborLevel } from '@/environment/HarborLevel';
import { Explosives } from '@/environment/Explosives';
import { CollisionWorld } from '@/physics/CollisionWorld';

import { PlayerCamera } from '@/player/PlayerCamera';
import { Player } from '@/player/Player';
import { WeaponController } from '@/weapons/WeaponController';
import { Ballistics } from '@/weapons/Ballistics';
import { EnemyManager } from '@/enemies/EnemyManager';
import { ChainTest } from '@/debug/ChainTest';
import { VfxManager } from '@/effects/VfxManager';
import { AudioEngine } from '@/audio/AudioEngine';

import { Hud } from '@/ui/Hud';
import { Overlays } from '@/ui/Overlays';
import { DebugPanel, type DebugState } from '@/debug/DebugPanel';
import { MissionDirector, formatTime } from './MissionDirector';

/**
 * The game. Owns every system, owns the frame, owns teardown.
 *
 * FRAME ORDER (this is the contract every system relies on):
 *   1. input drain
 *   2. mission director (may drive the camera during the intro)
 *   3. player movement -> camera transform
 *   4. weapon animation (needs the final camera transform)
 *   5. enemies + AI fire
 *   6. world reactions (explosives, wind, practicals, level)
 *   7. VFX (needs the final camera + muzzle transform for billboards)
 *   8. audio listener
 *   9. HUD
 *  10. planar reflection pass, then the main render
 *
 * Step 4 must come after step 3 or the view-model lags the view by a frame,
 * which is instantly visible as the weapon "swimming". Step 7 must come after
 * step 4 for the same reason regarding the muzzle flash.
 */
export class Game {
  private readonly disposer = new Disposer();
  private readonly bus = new EventBus();
  private readonly clock = new GameClock();
  private readonly visual: MutableVisual = cloneVisualConfig();

  private qualityLevel: QualityLevel;
  private renderSystem!: RenderSystem;
  private scene = new THREE.Scene();

  private textures!: TextureFactory;
  private materials!: MaterialLibrary;
  private sky!: SkyDome;
  private lighting!: Lighting;
  private collision = new CollisionWorld();
  private level!: HarborLevel;
  private explosives!: Explosives;

  private view!: PlayerCamera;
  private player!: Player;
  private weapon!: WeaponController;
  private enemies!: EnemyManager;
  private ballistics!: Ballistics;
  private vfx!: VfxManager;
  private audio = new AudioEngine();

  private hud!: Hud;
  private overlays!: Overlays;
  private debugPanel!: DebugPanel;
  private director!: MissionDirector;

  private running = false;
  private rafHandle = 0;
  private started = false;
  private particleScale = 1;
  /**
   * Latches true the moment the player is actually in the fight.
   *
   * Hostiles used to open fire during the intro sweep, while the player is
   * frozen and the camera is still flying - so the condition bar was already
   * dropping before the first frame the player could act on. The garrison now
   * waits for the mission to be active AND for the player to do something:
   * move, aim or shoot. A short fallback covers a player who deliberately
   * stands still, so the encounter cannot be stalled indefinitely.
   */
  private engagementOpen = false;
  private engagementGrace = 0;

  /** ?enemytrace=1 - mirrors every hostile's state and magazine onto <body>. */
  private enemyTrace = false;
  /** Non-null while ?chaintest= is running. */
  private chainTest: ChainTest | null = null;
  /** >0 while a ?boom= test detonation is pending; repeats on an interval. */
  private boomTimer = 0;
  private boomInterval = 0;
  private boomCount = 0;

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly introOffset = { heightOffset: 0, yawOffset: 0, pitchOffset: 0 };

  private debugState: DebugState;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly uiRoot: HTMLElement,
  ) {
    this.qualityLevel = detectQuality() ?? DEFAULT_QUALITY;
    this.debugState = {
      quality: this.qualityLevel,
      enemiesEnabled: true,
      particleScale: 1,
      recoilScale: 1,
      cameraShakeScale: 1,
      muzzleFlashScale: 1,
      showPerf: false,
    };
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  /**
   * Asynchronous boot with progress reporting. Texture generation is the slow
   * part (~0.4s of CPU); yielding between stages keeps the loader animating
   * instead of freezing on a white screen.
   */
  async boot(): Promise<void> {
    this.overlays = new Overlays(this.uiRoot);
    this.disposer.track(this.overlays);

    try {
      const quality = QUALITY_PRESETS[this.qualityLevel];

      await this.stage(0.05, 'INSTALLING SHADERS', () => {
        // Must happen before ANY material is compiled.
        installFogPatch();
        this.renderSystem = new RenderSystem(this.canvas, quality, this.visual);
        this.disposer.track(this.renderSystem);
      });

      await this.stage(0.2, 'GENERATING MATERIALS', () => {
        this.textures = new TextureFactory(quality.anisotropy);
        this.disposer.track(this.textures);
        this.materials = new MaterialLibrary(this.textures);
        this.disposer.track(this.materials);
        this.materials.setEnvIntensity(this.visual.ambient.envIntensity);
      });

      await this.stage(0.45, 'BUILDING SKY', () => {
        this.sky = new SkyDome(this.visual);
        this.disposer.track(this.sky);
        this.scene.add(this.sky.mesh);
        this.lighting = new Lighting(this.scene, this.sky, this.visual, this.renderSystem.renderer, quality);
        this.disposer.track(this.lighting);
      });

      await this.stage(0.6, 'ASSEMBLING BERTH 7', () => {
        this.level = new HarborLevel(this.materials, this.visual, quality, this.collision);
        this.disposer.track(this.level);
        this.scene.add(this.level.root);
        this.materials.setWetness(this.visual.wetness.global);
      });

      await this.stage(0.75, 'PLACING HOSTILES', () => {
        this.view = new PlayerCamera(this.visual);
        this.renderSystem.configureCameras(this.view.camera, this.view.weaponCamera);
        this.scene.add(this.view.camera, this.view.weaponCamera);

        this.player = new Player(this.collision, this.view, this.bus);
        this.enemies = new EnemyManager(this.materials, this.collision, this.bus);
        this.disposer.track(this.enemies);
        this.scene.add(this.enemies.group);
        this.enemies.spawnAll(this.level.enemySpawns);

        this.explosives = new Explosives(this.materials, this.bus, this.visual, this.collision);
        this.disposer.track(this.explosives);
        this.scene.add(this.explosives.group);
        this.explosives.spawnAt(this.level.explosivePositions);
      });

      await this.stage(0.88, 'CALIBRATING OPTICS', () => {
        this.vfx = new VfxManager(this.bus, this.textures, this.materials, this.visual, quality);
        this.disposer.track(this.vfx);
        this.scene.add(this.vfx.group);
        this.level.wetGround.excludeFromReflection(this.vfx.group);

        this.weapon = new WeaponController(this.materials, this.view, this.collision, this.bus, this.visual);
        this.disposer.track(this.weapon);

        this.ballistics = new Ballistics(this.collision, this.enemies, this.vfx, this.bus, this.player);
      });

      await this.stage(0.97, 'ESTABLISHING LINK', () => {
        this.hud = new Hud(this.uiRoot, this.bus);
        this.disposer.track(this.hud);
        this.director = new MissionDirector(this.bus);
        this.debugPanel = new DebugPanel(this.visual, this.debugState, this.buildDebugHooks());
        this.disposer.track(this.debugPanel);

        this.input = new Input(this.canvas);
        this.disposer.track(this.input);
        this.wireEvents();
        this.applyQuality(this.qualityLevel);
      });

      this.player.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);
      const params = new URLSearchParams(window.location.search);
      // ?posetest=1 lines hostiles up at fixed distances with the AI frozen,
      // so joint quality can be inspected repeatably.
      if (params.has('posetest')) {
        this.enemies.setPoseTest(
          true,
          this.level.playerSpawn,
          this.level.playerSpawnYaw,
          params.get('posetest') ?? '',
        );
      }
      // ?exposure=N overrides the authored exposure. The debug panel has the
      // same control, but a URL form is scriptable, which is what makes
      // "inspect this asset lit rather than as a silhouette" repeatable.
      const exposure = Number(params.get('exposure'));
      if (Number.isFinite(exposure) && exposure > 0) this.visual.exposure.base = exposure;
      // ?boom=N detonates a charge N seconds into play, 7m ahead of the
      // player. Verifying blast brightness by trying to shoot a fuel drum with
      // synthetic input is not repeatable; this is.
      // ?chaintest=1 runs the deterministic drum chain-reaction test; see
      // src/debug/ChainTest.ts for why this cannot be done by hand.
      if (params.has('chaintest')) {
        const runs = Number(params.get('chaintest'));
        this.chainTest = new ChainTest(
          this.explosives,
          () => ({ particles: this.vfx.stats.particles, lights: this.vfx.activeLights }),
          // Which drum to shoot. Default is the 4-drum fuel dump; drums 0 and
          // 1 sit 14m away and must survive it. ?chainseed=0 tests the pair.
          // (`|| 2` would be wrong here: drum 0 is a valid, falsy index.)
          params.has('chainseed') ? Number(params.get('chainseed')) : 2,
          Number.isFinite(runs) && runs > 0 ? Math.min(runs, 5) : 3,
        );
        this.chainTest.start(1.5);
      }
      // ?boomslow=N stretches the blast light's lifetime by N. The decay curve
      // is normalised over the lifetime, so every life fraction looks exactly
      // as it does at speed - it just holds long enough to be screenshotted.
      // (Particles keep their own timing, so only the LIGHT is meaningful in
      // a slowed capture.)
      // ?weaponpose=hip|ads|sprint|retract pins the view-model pose so each
      // extreme can be inspected. Sprint and wall-retract only occur
      // transiently in play, which is how their rotations went unchecked.
      if (params.has('weapontrace')) this.weapon.debugTrace = true;
      if (params.has('enemytrace')) this.enemyTrace = true;
      const pose = params.get('weaponpose');
      if (pose === 'hip' || pose === 'ads' || pose === 'sprint' || pose === 'retract') {
        this.weapon.debugPose = pose;
      }
      // ?boomhold=L pins the blast light at life fraction L (0 = ignition,
      // 0.08 = peak, 1 = extinguished) so each point on the curve can be
      // screenshotted without racing a sub-second event.
      const boomHold = Number(params.get('boomhold'));
      if (params.has('boomhold') && Number.isFinite(boomHold)) {
        this.vfx.blastHoldLife = Math.max(0, Math.min(1, boomHold));
      }
      const boomSlow = Number(params.get('boomslow'));
      if (Number.isFinite(boomSlow) && boomSlow > 1) {
        this.visual.explosion.lightDuration *= boomSlow;
      }
      if (params.has('boom')) {
        const delay = Number(params.get('boom'));
        this.boomInterval = Number.isFinite(delay) && delay > 0 ? delay : 4;
        this.boomTimer = this.boomInterval;
      }
      this.handleResize();

      // Render one frame before hiding the loader so the first thing the
      // player sees is the scene, not a black flash.
      this.renderFrame(0);

      this.overlays.setLoadProgress(1, 'READY');
      this.overlays.hideLoader();
      this.overlays.showBriefing(false);
      this.start();
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
      console.error('[Game] boot failed', error);
      this.overlays.showFatal(message);
    }
  }

  private input!: Input;

  /** Runs a boot stage, reporting progress and yielding to the browser. */
  private async stage(progress: number, label: string, work: () => void): Promise<void> {
    this.overlays.setLoadProgress(progress, label);
    // Two rAFs guarantee the loader has actually painted before we block.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    work();
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  private wireEvents(): void {
    this.disposer.onDispose(listen(window, 'resize', () => this.handleResize()));
    // The canvas can also change size without a window resize (CSS layout,
    // devtools docking, embedded panes), so observe the element itself.
    const observer = new ResizeObserver(() => this.handleResize());
    observer.observe(this.canvas);
    this.disposer.onDispose(() => observer.disconnect());

    this.input.onLockChange = (locked) => {
      if (locked) {
        this.overlays.hideBriefing();
        if (this.director.phase === 'briefing') this.beginMission();
      } else if (this.director.phase === 'active' || this.director.phase === 'intro') {
        this.overlays.showBriefing(true);
      }
    };

    this.overlays.onStart = () => {
      void this.audio.start();
      this.input.requestLock();
    };
    this.overlays.onRestart = () => {
      this.overlays.hideEnd();
      this.restart();
      this.input.requestLock();
    };

    this.director.onChatter = (speaker, text) => this.overlays.setChatter(speaker, text);
    this.director.onLetterbox = (show) => this.overlays.setLetterbox(show);

    // --- VFX <-> world reactions ---
    this.vfx.onGroundRipple = (x, z, strength) => this.level.wetGround.addRipple(x, z, strength);
    this.vfx.onLampShock = (position, power) => this.level.practicals.applyShock(position, power);
    this.vfx.onCameraShake = (amplitude, frequency) => this.view.addShake(amplitude, frequency);
    this.explosives.onVentTick = (position) => {
      this.vfx.particles.emitBurst('additive', VENT_FIRE, 1, position, UP, 3.2, 0.35, 0.05);
      this.vfx.particles.emitBurst('lit', VENT_SMOKE, 1, position, UP, 1.6, 0.4, 0.05);
    };
    this.level.distant.onDistantBlast = (delay, intensity) => this.audio.playDistantBlast(delay, intensity);

    // --- audio, driven by the same events as the visuals ---
    this.disposer.onDispose(
      this.bus.on('weapon:fired', ({ origin, direction }) => {
        this.audio.playWeaponFire();
        // Shooting rattles nearby hanging lamps: a small but constant reminder
        // that the world reacts to the player.
        this.level.practicals.applyShock(origin, 0.22);
        this.ballistics.firePlayerShot(origin, direction, this.view.camera.position);
      }),
    );
    this.disposer.onDispose(
      this.bus.on('enemy:fired', ({ origin, direction }) => {
        this.audio.playEnemyFire(origin);
        this.ballistics.fireEnemyShot(origin, direction, this.view.camera.position);
      }),
    );
    this.disposer.onDispose(
      this.bus.on('impact:surface', ({ point, surface, distance }) => {
        this.audio.playImpact(point, surface);
        // Rounds landing near a drum damage it. Cheap proximity test, no rays.
        this.explosives.registerImpact(point, WEAPON_CONFIG.damage);
        void distance;
      }),
    );
    this.disposer.onDispose(this.bus.on('hitmarker', ({ killed }) => this.audio.playHitmarker(killed)));
    this.disposer.onDispose(this.bus.on('weapon:magOut', () => this.audio.playMech('magOut')));
    this.disposer.onDispose(this.bus.on('weapon:magIn', () => this.audio.playMech('magIn')));
    this.disposer.onDispose(this.bus.on('weapon:boltRelease', () => this.audio.playMech('bolt')));
    this.disposer.onDispose(this.bus.on('weapon:dryFire', () => this.audio.playMech('dry')));
    this.disposer.onDispose(this.bus.on('weapon:adsChanged', () => this.audio.playMech('ads')));
    this.disposer.onDispose(
      this.bus.on('player:footstep', ({ sprinting }) => {
        this.audio.playFootstep(sprinting);
        // Footsteps disturb the standing water underfoot.
        this.level.wetGround.addRipple(this.player.position.x, this.player.position.z, 0.28, 1.6);
      }),
    );
    this.disposer.onDispose(
      this.bus.on('player:damaged', ({ amount }) => {
        this.audio.playPlayerHit();
        // Proportional to the hit, with a floor so even a graze registers.
        this.renderSystem.pulseDamage(0.18 + Math.min(amount, 45) / 45 * 0.62);
      }),
    );
    this.disposer.onDispose(
      this.bus.on('explosion', ({ position, radius, power }) => {
        if (this.chainTest) this.chainTest.explosionsSeen++;
        this.audio.playExplosion(position, power);
        // Blast damage to the player, plus a hard screen kick.
        const damage = this.explosives.getBlastDamage(position, this.player.position);
        if (damage > 0) {
          // player.damage() emits player:damaged, which already pulses the
          // screen in proportion to the hit. Adding a second fixed pulse here
          // meant a 0.4-damage graze at the edge of the blast produced the
          // same full-strength red as a lethal one.
          this.player.damage(damage, position);
        }
        void radius;
      }),
    );
    this.disposer.onDispose(
      this.bus.on('player:landed', ({ impact }) => {
        if (impact > 4) this.audio.playFootstep(true);
        this.level.wetGround.addRipple(this.player.position.x, this.player.position.z, 0.6, 2.2);
      }),
    );

    this.disposer.onDispose(() => this.audio.dispose());
  }

  private buildDebugHooks() {
    return {
      applyLighting: (): void => {
        this.sky.refresh();
        this.lighting.refresh();
        this.lighting.rebuildEnvironment(this.renderSystem.renderer);
        this.materials.setEnvIntensity(this.visual.ambient.envIntensity);
      },
      applyWetness: (): void => {
        this.level.refresh();
        this.materials.setWetness(this.visual.wetness.global);
      },
      applyPracticals: (): void => this.level.practicals.refresh(),
      setQuality: (level: QualityLevel): void => this.applyQuality(level),
      setEnemiesEnabled: (enabled: boolean): void => this.enemies.setEnabled(enabled),
      setParticleScale: (scale: number): void => {
        this.particleScale = scale;
      },
      respawn: (): void => this.restart(),
    };
  }

  private applyQuality(level: QualityLevel): void {
    this.qualityLevel = level;
    this.debugState.quality = level;
    const quality = QUALITY_PRESETS[level];
    this.renderSystem.setQuality(quality);
    this.lighting.setShadowsEnabled(quality.shadows, quality.shadowMapSize);
    this.level.setQuality(quality);
    this.vfx.setQuality(quality);
    this.textures.setAnisotropy(quality.anisotropy);
    this.handleResize();
    this.bus.emit('quality:changed');
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  private beginMission(): void {
    this.director.begin();
    this.player.setFrozen(true);
    this.audio.setAmbienceLevel(0.5);
  }

  private restart(): void {
    this.player.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);
    this.enemies.reset();
    this.explosives.reset();
    this.vfx.clear();
    this.weapon.resupply();
    this.ballistics.reset();
    this.director.reset();
    this.engagementOpen = false;
    this.engagementGrace = 0;
    this.beginMission();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.started = true;
    const loop = (now: number): void => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(loop);
      try {
        this.renderFrame(now);
      } catch (error) {
        // A per-frame exception must not kill the RAF chain; log once per
        // second so the console does not flood.
        this.reportFrameError(error);
      }
    };
    this.rafHandle = requestAnimationFrame(loop);
    this.disposer.onDispose(() => this.stop());
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  private lastErrorLog = 0;
  private reportFrameError(error: unknown): void {
    const now = performance.now();
    if (now - this.lastErrorLog > 1000) {
      this.lastErrorLog = now;
      console.error('[Game] frame error', error);
    }
  }

  private handleResize(): void {
    // Use the canvas's own layout box, not window.innerWidth: the canvas may
    // be inside a scaled or letterboxed container (embedded previews, split
    // panes), and a mismatch here silently breaks the planar-reflection UVs.
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderSystem.resize(width, height);
    this.view.setAspect(width / height);
    const canvas = this.renderSystem.renderer.domElement;
    this.level.wetGround.setScreenSize(canvas.width, canvas.height);
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  private renderFrame(now: number): void {
    const dt = this.clock.tick(now);
    const elapsed = this.clock.elapsed;

    // --- 1. input ---
    if (this.started) this.handleHotkeys();
    const lookX = this.input?.mouseDeltaX ?? 0;
    const lookY = this.input?.mouseDeltaY ?? 0;
    const playable = this.director.isPlayable && this.input?.locked;

    // --- 2. mission ---
    // Only the intro phase drives the camera; every other phase uses the
    // player's own eye transform untouched.
    const introBlend = this.director.phase === 'intro' ? this.director.introBlend : 0;
    if (introBlend > 0) this.director.getIntroOffset(this.introOffset);
    if (playable) {
      this.view.applyLook(lookX, lookY, this.weapon.adsBlend > 0.5);
    }

    // --- 3. player + camera ---
    const wantsAds = playable ? this.input.aiming : false;
    this.player.setFrozen(!playable);
    this.player.update(dt, this.input, wantsAds && this.weapon.state !== 'reloading');

    const eye = this.tmpVec.copy(this.player.eye);
    if (introBlend > 0.001) {
      // The intro rises the camera and sweeps the view. These are additive
      // offsets on top of the player's aim, so nothing is left behind when the
      // sequence blends out.
      eye.y += this.introOffset.heightOffset * introBlend;
      this.view.introYawOffset = this.introOffset.yawOffset * introBlend;
      this.view.introPitchOffset = this.introOffset.pitchOffset * introBlend;
    } else {
      this.view.introYawOffset = 0;
      this.view.introPitchOffset = 0;
    }
    this.view.shakeScale = this.debugState.cameraShakeScale;
    this.view.update(
      dt,
      elapsed,
      eye,
      this.player.speed,
      this.player.grounded,
      this.weapon.adsBlend > 0.35,
      this.player.sprinting,
    );

    // --- 4. weapon (after the camera: the view-model is parented to it) ---
    if (playable) {
      this.weapon.setTrigger(this.input.firing);
      if (this.input.wasPressed('reload')) this.weapon.requestReload();
    } else {
      this.weapon.setTrigger(false);
    }
    this.weapon.recoilScale = this.debugState.recoilScale;
    this.weapon.update(
      dt,
      elapsed,
      wantsAds,
      this.player.sprinting,
      this.player.speed,
      this.player.grounded,
      this.player.stance === 'crouch',
      lookX,
      lookY,
    );

    // --- 5. enemies ---
    if (!this.engagementOpen && this.director.phase === 'active') {
      this.engagementGrace += dt;
      const acting =
        this.player.speed > 0.4 || this.input.firing || this.input.aiming || !this.player.grounded;
      if (acting || this.engagementGrace > 4) this.engagementOpen = true;
    }
    this.enemies.update(dt, elapsed, this.player.eye, this.player.alive, this.engagementOpen);

    // --- 6. world ---
    this.explosives.update(dt, elapsed);
    updateWind(elapsed, dt);
    this.level.update(dt, elapsed, this.view.camera.position);
    this.lighting.update(this.view.camera.position, this.view.camera.quaternion);
    this.sky.update(elapsed, this.view.camera.position);
    const flash = this.level.distant.battleFlash;
    this.sky.setFlash(flash.strength, flash.direction, flash.color);

    // --- 7. VFX ---
    this.weapon.getMuzzleWorld(this.tmpVec2);
    this.vfx.particles.setLighting(
      this.sky.sunDirection,
      this.sky.sunColor,
      this.lighting.hemisphere.color,
      this.visual.ambient.intensity,
    );
    this.vfx.update(dt * this.particleScale, elapsed, this.view.camera, this.tmpVec2);

    // --- 8. audio ---
    this.audio.setListener(this.view.camera.position, this.view.camera.quaternion);

    // --- 9. mission state + HUD ---
    const extractionDistance = this.player.position.distanceTo(this.level.extractionPoint);
    const previousPhase = this.director.phase;
    this.director.update(dt, this.player.position.x, this.enemies.aliveCount, extractionDistance, this.player.alive);
    if (previousPhase === 'active' && this.director.phase !== 'active') {
      this.onMissionEnded(this.director.phase === 'complete');
    }

    if (this.chainTest) this.chainTest.update(dt);

    // Deliberately phase-independent: it must work on the attract/briefing
    // view too, where nothing else is perturbing the scene.
    if (this.boomTimer > 0) {
      this.boomTimer -= dt;
      if (this.boomTimer <= 0) {
        // In ?boomhold= mode the light is frozen on its curve, so a repeating
        // detonation would just stack fireball particles into a screen-wide
        // wash and hide the very thing being inspected. One shot only.
        this.boomTimer = this.vfx.blastHoldLife !== null ? 0 : this.boomInterval;
        this.view.getAimDirection(this.tmpVec2);
        this.tmpVec2.y = 0;
        this.tmpVec2.normalize().multiplyScalar(7).add(this.player.position);
        this.tmpVec2.y += 0.6;
        this.bus.emit('explosion', {
          position: this.tmpVec2.clone(),
          radius: this.visual.explosion.radius,
          power: 1,
        });
        this.boomCount++;
        document.body.dataset.booms = String(this.boomCount);
      }
    }

    this.updateHud(dt, extractionDistance);

    // Mission state is mirrored onto <body> as data attributes. This is the
    // only diagnostic that survives an isolated-world console (automated
    // screenshots, embedded previews) and costs one DOM write per change.
    if (document.body.dataset.phase !== this.director.phase) {
      document.body.dataset.phase = this.director.phase;
    }
    const tick = Math.floor(this.clock.elapsed).toString();
    if (document.body.dataset.tick !== tick) document.body.dataset.tick = tick;
    document.body.dataset.blast = this.vfx.blastState;
    if (this.enemyTrace) document.body.dataset.enemies = this.enemies.stateTrace;
    // Render statistics, mirrored for the same reason as everything else here:
    // the debug panel needs a keypress and a focused canvas, neither of which
    // a scripted capture session reliably has.
    document.body.dataset.stats =
      `calls=${this.renderSystem.drawCalls} tris=${this.renderSystem.triangles} ` +
      `lights=${countLights(this.scene)} particles=${this.vfx.stats.particles}`;

    // --- 10. render ---
    this.renderSystem.setMotion(this.view.motion.x, this.view.motion.y, this.view.motionStrength);
    this.renderSystem.setFocusDistance(this.weapon.getFocusDistance());
    this.renderSystem.setFade(this.director.fade);

    // The planar reflection must be rendered before the main pass.
    this.level.wetGround.renderReflection(this.renderSystem.renderer, this.scene, this.view.camera);
    this.renderSystem.render(this.scene, this.view.camera, this.view.weaponCamera, dt, elapsed);

    // Soft particles need the depth texture from the frame we just rendered;
    // wiring it here means they use last frame's depth, which is imperceptible
    // and avoids a second depth resolve.
    this.vfx.particles.setDepthTexture(
      this.renderSystem.depthTexture,
      this.renderSystem.renderer.domElement.width,
      this.renderSystem.renderer.domElement.height,
      this.view.camera.near,
      this.view.camera.far,
    );

    this.input?.endFrame();
  }

  private handleHotkeys(): void {
    if (this.input.wasPressed('toggleDebug')) {
      this.debugPanel.toggle();
      // Release the pointer so the panel can be used.
      if (this.debugPanel.isVisible) this.input.exitLock();
    }
    if (this.input.wasPressed('toggleHud')) {
      this.hud.setHidden(!this.hud.isHidden);
    }
    if (this.input.wasPressed('restart')) {
      this.overlays.hideEnd();
      this.restart();
    }
    // F cycles the performance readout.
    if (this.input.wasPressed('interact')) this.hud.togglePerf();
  }

  private updateHud(dt: number, extractionDistance: number): void {
    this.hud.update(dt, {
      mag: this.weapon.magAmmo,
      reserve: this.weapon.reserveAmmo,
      spread: this.weapon.spread,
      adsBlend: this.weapon.adsBlend,
      reloadProgress: this.weapon.state === 'reloading' ? this.reloadProgress() : 0,
      reloading: this.weapon.state === 'reloading',
      health: this.player.healthFraction,
      crouched: this.player.stance === 'crouch',
      sprinting: this.player.sprinting,
      enemiesRemaining: this.enemies.aliveCount,
      enemiesTotal: this.enemies.totalCount,
      cameraYaw: this.view.yaw,
    });

    this.hud.updateMarker(
      this.tmpVec2.copy(this.level.extractionPoint).setY(2.4),
      this.view.camera,
      this.director.phase === 'active',
      `${extractionDistance.toFixed(0)}M`,
    );

    const stats = this.vfx.stats;
    const fps = this.clock.fps;
    this.hud.setPerf(
      [
        `<b>${fps.toFixed(0)}</b> fps &nbsp; <b>${this.clock.smoothedFrameMs.toFixed(1)}</b> ms`,
        `draw calls <b>${this.renderSystem.drawCalls}</b>`,
        `triangles <b>${(this.renderSystem.triangles / 1000).toFixed(0)}k</b>`,
        `textures <b>${this.renderSystem.textureCount}</b>`,
        `particles <b>${stats.particles}</b> &nbsp; decals <b>${stats.decals}</b>`,
        `lights <b>${this.level.practicals.count + 3}</b> &nbsp; boxes <b>${this.collision.boxCount}</b>`,
        `quality <b>${QUALITY_PRESETS[this.qualityLevel].label}</b>`,
        fps < 50 ? '<span class="warn">BELOW TARGET - try a lower preset</span>' : '',
      ].join('<br>'),
    );
  }

  private reloadProgress(): number {
    // The weapon owns the timer; the HUD only needs the normalised value.
    return clamp01(this.weaponReloadFraction);
  }

  /** Mirror of the weapon's internal reload timer for HUD display. */
  private get weaponReloadFraction(): number {
    const w = this.weapon as unknown as { reloadTimer: number; reloadDuration: number };
    return w.reloadDuration > 0 ? w.reloadTimer / w.reloadDuration : 0;
  }

  private onMissionEnded(success: boolean): void {
    this.input.exitLock();
    this.player.setFrozen(true);
    this.audio.setAmbienceLevel(0.2);
    const accuracy = this.ballistics.accuracy * 100;
    this.overlays.showEnd(success, [
      ['TIME', formatTime(this.director.missionTime)],
      ['HOSTILES DOWN', `${this.enemies.killCount} / ${this.enemies.totalCount}`],
      ['ACCURACY', `${accuracy.toFixed(0)}%`],
      ['ROUNDS FIRED', String(this.ballistics.shotsFired)],
    ]);
    this.bus.emit('mission:complete', {
      timeSec: this.director.missionTime,
      kills: this.enemies.killCount,
      accuracy: this.ballistics.accuracy,
    });
  }

  dispose(): void {
    this.stop();
    this.disposer.dispose();
    this.bus.clear();
    this.scene.clear();
  }
}

/** Lights actually in the graph and enabled - the forward-renderer cost driver. */
function countLights(scene: THREE.Scene): number {
  let n = 0;
  scene.traverse((o) => {
    const light = o as THREE.Light;
    if (light.isLight && light.visible && light.intensity > 0) n++;
  });
  return n;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Fire and smoke jetting from a venting drum just before it detonates. */
const VENT_FIRE = {
  lifetime: 0.28,
  lifetimeJitter: 0.1,
  size: 0.14,
  sizeJitter: 0.5,
  sizeCurve: (t: number) => 1 + t * 1.6,
  alphaCurve: (t: number) => Math.pow(1 - t, 1.4),
  colorStart: new THREE.Color(0xffe0a0),
  colorEnd: new THREE.Color(0xff4a10),
  brightness: 6,
  gravity: -2.5,
  drag: 0.3,
};

const VENT_SMOKE = {
  lifetime: 1.4,
  lifetimeJitter: 0.4,
  size: 0.2,
  sizeJitter: 0.4,
  sizeCurve: (t: number) => 1 + t * 3,
  alphaCurve: (t: number) => Math.min(1, t / 0.1) * Math.pow(1 - t, 1.8) * 0.5,
  colorStart: new THREE.Color(0x5f5a52),
  colorEnd: new THREE.Color(0x2c2f34),
  brightness: 0.4,
  gravity: -1.2,
  drag: 0.2,
  turbulence: 0.5,
  rotationSpeed: 1.2,
};

void LAYER;
