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
import { GatekeeperController } from '@/bosses/GatekeeperController';
import { Warden03Controller } from '@/bosses/Warden03Controller';

import { PlayerCamera } from '@/player/PlayerCamera';
import { Player } from '@/player/Player';
import { WeaponController } from '@/weapons/WeaponController';
import { Ballistics } from '@/weapons/Ballistics';
import { EnemyManager } from '@/enemies/EnemyManager';
import { RobotEnemyManager, type RobotSpawn } from '@/enemies/RobotEnemyManager';
import { ChainTest } from '@/debug/ChainTest';
import { VfxManager } from '@/effects/VfxManager';
import { AudioEngine } from '@/audio/AudioEngine';

import { Hud } from '@/ui/Hud';
import { MobileControls } from '@/ui/MobileControls';
import { Overlays } from '@/ui/Overlays';
import { DebugPanel, type DebugState } from '@/debug/DebugPanel';
import { MissionDirector, formatTime } from './MissionDirector';
import { TruthReveal } from '@/story/TruthReveal';
import {
  CHECKPOINT_OF,
  MISSION_ORDER,
  type Checkpoint,
  type MissionState,
} from '@/mission/MissionState';
import { CAST } from '@/config/mission';

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
  private humanoids!: EnemyManager;
  private enemies!: RobotEnemyManager;
  private gatekeeper!: GatekeeperController;
  private warden!: Warden03Controller;
  private ballistics!: Ballistics;
  private vfx!: VfxManager;
  private audio = new AudioEngine();

  private hud!: Hud;
  private mobileControls!: MobileControls;
  private overlays!: Overlays;
  private debugPanel!: DebugPanel;
  private director!: MissionDirector;
  private readonly truthReveal = new TruthReveal();
  private accessModule: THREE.Object3D | null = null;
  private retries = 0;
  private hazardDamageCooldown = 0;

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
  private skipIntro = false;
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

      await this.stage(0.05, 'シェーダーを準備中', () => {
        // Must happen before ANY material is compiled.
        installFogPatch();
        this.renderSystem = new RenderSystem(this.canvas, quality, this.visual);
        this.disposer.track(this.renderSystem);
      });

      await this.stage(0.2, '質感データを生成中', () => {
        this.textures = new TextureFactory(quality.anisotropy);
        this.disposer.track(this.textures);
        this.materials = new MaterialLibrary(this.textures);
        this.disposer.track(this.materials);
        this.materials.setEnvIntensity(this.visual.ambient.envIntensity);
      });

      await this.stage(0.45, '空と照明を構築中', () => {
        this.sky = new SkyDome(this.visual);
        this.disposer.track(this.sky);
        this.scene.add(this.sky.mesh);
        this.lighting = new Lighting(this.scene, this.sky, this.visual, this.renderSystem.renderer, quality);
        this.disposer.track(this.lighting);
      });

      await this.stage(0.6, '第7バースを構築中', () => {
        this.level = new HarborLevel(this.materials, this.visual, quality, this.collision);
        this.disposer.track(this.level);
        this.scene.add(this.level.root);
        this.materials.setWetness(this.visual.wetness.global);
      });

      await this.stage(0.75, '敵ユニットを配置中', () => {
        this.view = new PlayerCamera(this.visual);
        this.renderSystem.configureCameras(this.view.camera, this.view.weaponCamera);
        this.scene.add(this.view.camera, this.view.weaponCamera);

        this.player = new Player(this.collision, this.view, this.bus);
        this.humanoids = new EnemyManager(this.materials, this.collision, this.bus);
        this.disposer.track(this.humanoids);
        this.scene.add(this.humanoids.group);
        this.humanoids.spawnAll(this.level.enemySpawns);

        this.enemies = new RobotEnemyManager(this.materials, this.collision, this.bus);
        this.disposer.track(this.enemies);
        this.scene.add(this.enemies.group);
        this.enemies.spawnAll(this.buildRobotSpawns());

        this.gatekeeper = new GatekeeperController(this.materials, this.bus, this.collision);
        this.gatekeeper.spawn(this.level.factory.gatekeeperSpawn);
        this.gatekeeper.group.visible = false;
        this.scene.add(this.gatekeeper.group);
        this.disposer.onDispose(() => this.gatekeeper.dispose());

        this.warden = new Warden03Controller(this.materials, this.bus, {
          protectedVolume: this.level.factory.protectedVolume,
          arena: {
            center: this.level.factory.objectivePoints.bossArena.clone(),
            radius: this.level.factory.bossArenaRadius,
          },
        });
        this.scene.add(this.warden.group);
        this.disposer.onDispose(() => this.warden.dispose());

        this.explosives = new Explosives(this.materials, this.bus, this.visual, this.collision);
        this.disposer.track(this.explosives);
        this.scene.add(this.explosives.group);
        this.explosives.spawnAt(this.level.explosivePositions);
      });

      await this.stage(0.88, '照準器を調整中', () => {
        this.vfx = new VfxManager(this.bus, this.textures, this.materials, this.visual, quality);
        this.disposer.track(this.vfx);
        this.scene.add(this.vfx.group);
        this.level.wetGround.excludeFromReflection(this.vfx.group);

        this.weapon = new WeaponController(this.materials, this.view, this.collision, this.bus, this.visual);
        this.disposer.track(this.weapon);

        this.ballistics = new Ballistics(
          this.collision,
          [this.humanoids, this.enemies],
          this.vfx,
          this.bus,
          this.player,
          this.gatekeeper,
          this.warden,
        );
      });

      await this.stage(0.97, '作戦回線に接続中', () => {
        this.hud = new Hud(this.uiRoot, this.bus);
        this.disposer.track(this.hud);
        this.director = new MissionDirector(this.bus);
        this.truthReveal.onFrame = (frame) => {
          if (frame) this.overlays.showTruth(frame);
          else this.overlays.hideTruth();
        };
        this.truthReveal.onLine = (speaker, text) => this.overlays.setChatter(speaker, text);
        this.debugPanel = new DebugPanel(this.visual, this.debugState, this.buildDebugHooks());
        this.disposer.track(this.debugPanel);

        this.input = new Input(this.canvas);
        this.disposer.track(this.input);
        this.mobileControls = new MobileControls(this.uiRoot, this.input);
        this.disposer.track(this.mobileControls);
        this.wireEvents();
        this.applyQuality(this.qualityLevel);
      });

      this.player.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);
      const params = new URLSearchParams(window.location.search);
      this.player.invincible = params.has('god');
      // ?posetest=1 lines hostiles up at fixed distances with the AI frozen,
      // so joint quality can be inspected repeatably.
      if (params.has('posetest')) {
        this.humanoids.setPoseTest(
          true,
          this.level.playerSpawn,
          this.level.playerSpawnYaw,
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
      // ?skipintro=1 hands control over immediately. The intro is 6.5s of
      // simulated time and this browser throttles a scripted page hard enough
      // that it can take minutes of wall clock to elapse.
      if (params.has('skipintro')) this.skipIntro = true;
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

      this.overlays.setLoadProgress(1, '準備完了');
      this.overlays.hideLoader();
      this.overlays.showBriefing(false);
      this.start();
      const requestedState = params.get('mission') as MissionState | null;
      if (requestedState && MISSION_ORDER.includes(requestedState)) {
        this.debugJumpTo(requestedState);
      }
      if (params.has('dead')) {
        this.tmpVec.copy(this.player.position).add(new THREE.Vector3(1, 0, 0));
        this.player.damage(999, this.tmpVec);
      }
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

  private buildRobotSpawns(): RobotSpawn[] {
    const interior: RobotSpawn[] = this.level.factory.robotSpawns.map((spawn) => ({
      kind: spawn.type === 'scout' ? 'SCOUT' : 'SENTINEL',
      zone: 'interior',
      position: spawn.position.clone(),
      patrolTo: spawn.patrolTo.clone(),
      activationX: spawn.activationZ,
    }));
    return interior;
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

    // POINTER LOCK IS NOT A GATE ON MISSION PROGRESS.
    //
    // beginMission() used to be called only from here, on lock acquired. That
    // makes the entire game unreachable in any browser or embedded context
    // that refuses pointer lock, and it makes "did the game start" depend on a
    // permission the player never sees. The two concerns are now separate:
    // clicking the briefing starts the mission, and pointer lock is requested
    // alongside it as a comfort feature that can fail without consequence.
    this.input.onLockChange = (locked, mode) => {
      if (locked && (mode === 'real' || mode === 'touch')) {
        this.overlays.hideMouseHint();
        return;
      }
      // Lost lock mid-mission: offer it back without throwing the player out
      // of the run. The mission keeps its state; only the look input pauses.
      if (this.director.inputPermissions.look) {
        this.overlays.showMouseHint();
      }
    };

    this.overlays.onStart = () => {
      void this.audio.start();
      // Start the mission first, unconditionally. The lock request is a
      // separate, best-effort call; if the browser refuses it the player still
      // gets a playable game and a prompt to click for mouse look.
      this.overlays.hideBriefing();
      if (this.director.phase === 'briefing') this.beginMission();
      this.mobileControls.setActive(true);
      this.input.requestLock();
      this.overlays.onRecaptureMouse = () => this.input.requestLock();
    };
    this.overlays.onRestart = () => {
      this.overlays.hideEnd();
      if (this.director.restartAtCheckpoint()) {
        // Restore before the next frame can mirror stale world flags back into
        // the freshly restored checkpoint context.
        this.restoreCheckpointWorld(this.director.checkpoint);
      } else {
        this.restartFromBriefing(false);
      }
      this.mobileControls.setActive(true);
      this.input.requestLock();
    };
    this.overlays.onTitle = () => {
      this.overlays.hideEnd();
      this.input.exitLock();
      this.mobileControls.setActive(false);
      this.restartFromBriefing(true);
      this.overlays.showBriefing(false);
    };

    this.director.onChatter = (speaker, text) => this.overlays.setChatter(speaker, text);
    this.director.onLetterbox = (show) => this.overlays.setLetterbox(show);
    this.director.onStateChange = (state, previous) => this.onMissionStateChanged(state, previous);
    this.disposer.onDispose(
      this.bus.on('mission:radio', ({ speaker, text }) => this.overlays.setChatter(speaker, text)),
    );

    this.disposer.onDispose(this.bus.on('mission:gatekeeperSpawn', () => {
      this.gatekeeper.reset();
      this.gatekeeper.group.visible = true;
    }));
    this.disposer.onDispose(this.bus.on('gatekeeper:defeated', () => {
      this.director.setFlag('gatekeeperAlive', false);
      this.director.setFlag('gatekeeperDefeated', true);
    }));
    this.disposer.onDispose(this.bus.on('gatekeeper:moduleDropped', ({ object }) => {
      this.accessModule = object;
    }));
    this.disposer.onDispose(this.bus.on('mission:gateOpen', () => this.level.factory.openGate()));
    this.disposer.onDispose(this.bus.on('mission:bossSpawn', () => {
      this.warden.reset();
      this.warden.spawn(this.level.factory.bossSpawn);
    }));
    this.disposer.onDispose(this.bus.on('boss:relayDown', ({ remaining }) => {
      this.director.setFlag('bossRelaysDown', 2 - remaining);
    }));
    this.disposer.onDispose(this.bus.on('boss:coolantDown', () => {
      this.director.setFlag('bossCoolantDown', true);
    }));
    this.disposer.onDispose(this.bus.on('boss:coreDown', () => {
      this.director.setFlag('bossCoreDown', true);
    }));
    this.disposer.onDispose(this.bus.on('boss:defeated', () => {
      this.level.factory.setBossDefeated(true);
    }));
    this.disposer.onDispose(this.bus.on('boss:playerHit', ({ amount, fromDirection }) => {
      this.tmpVec2.copy(this.player.position).add(fromDirection);
      this.player.damage(amount, this.tmpVec2);
    }));
    this.disposer.onDispose(this.bus.on('camera:shake', ({ amplitude, frequency }) => {
      this.view.addShake(amplitude, frequency ?? 12);
    }));
    this.disposer.onDispose(this.bus.on('mission:truthReveal', () => this.truthReveal.start()));

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
      this.bus.on('explosion', ({ position, radius, power, damagesPlayer }) => {
        if (this.chainTest) this.chainTest.explosionsSeen++;
        this.audio.playExplosion(position, power);
        // Blast damage to the player, plus a hard screen kick.
        const damage = damagesPlayer === false
          ? 0
          : this.explosives.getBlastDamage(position, this.player.position);
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
      setEnemiesEnabled: (enabled: boolean): void => {
        this.humanoids.setEnabled(enabled);
        this.enemies.setEnabled(enabled);
      },
      setParticleScale: (scale: number): void => {
        this.particleScale = scale;
      },
      respawn: (): void => this.restartFromBriefing(false),
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

  private restartFromBriefing(returnToBriefing: boolean): void {
    this.director.reset();
    this.restoreCheckpointWorld('EXTERIOR_ENTRY');
    this.retries = 0;
    if (returnToBriefing) return;
    this.beginMission();
  }

  private restoreCheckpointWorld(checkpoint: Checkpoint): void {
    this.humanoids.reset();
    this.enemies.reset();
    this.gatekeeper.reset();
    this.gatekeeper.group.visible = false;
    this.warden.reset();
    this.level.factory.reset();
    this.explosives.reset();
    this.vfx.clear();
    this.truthReveal.reset();
    this.overlays.hideTruth();
    this.weapon.resupply();
    this.ballistics.reset();
    this.accessModule = null;
    this.hazardDamageCooldown = 0;
    this.engagementOpen = false;
    this.engagementGrace = 0;

    if (checkpoint === 'EXTERIOR_ENTRY') {
      this.player.spawn(this.level.playerSpawn, this.level.playerSpawnYaw);
      return;
    }

    this.humanoids.clearAll();
    this.director.setFlag('moduleAcquired', true);
    this.level.factory.setAccessModuleAcquired(true);
    if (checkpoint === 'GATEKEEPER_DEFEATED') {
      this.player.spawn(new THREE.Vector3(44, 0, 7.5), 2.4);
      return;
    }

    this.level.factory.openGate();
    if (checkpoint === 'FACTORY_ENTRY') {
      this.player.spawn(new THREE.Vector3(33.4, 0, 16), Math.PI);
      return;
    }

    this.enemies.clearZone('interior');
    this.level.factory.setBossDefeated(false);
    this.player.spawn(new THREE.Vector3(31, 0, 39), Math.PI);
  }

  /** Dev console / ?mission=STATE entry that restores matching world state. */
  debugJumpTo(state: MissionState): void {
    const stateIndex = MISSION_ORDER.indexOf(state);
    const atOrPast = (milestone: MissionState): boolean =>
      stateIndex >= MISSION_ORDER.indexOf(milestone);

    this.director.reset();
    this.restoreCheckpointWorld(CHECKPOINT_OF[state]);
    this.overlays.hideBriefing();
    this.overlays.hideEnd();
    this.director.begin();
    this.director.finishIntro();
    this.engagementOpen = true;

    if (atOrPast('GATEKEEPER_INTRO')) {
      this.humanoids.clearAll();
      this.director.setFlag('exteriorHostilesRemaining', 0);
    }
    if (state === 'GATEKEEPER_INTRO' || state === 'GATEKEEPER_ACTIVE') {
      this.gatekeeper.reset();
      this.gatekeeper.group.visible = true;
      this.player.spawn(new THREE.Vector3(39, 0, -2), -Math.PI / 2);
      this.director.setFlag('gatekeeperAlive', true);
      this.director.setFlag('gatekeeperDefeated', false);
    } else if (atOrPast('GATEKEEPER_DEFEATED')) {
      this.gatekeeper.group.visible = false;
      this.director.setFlag('gatekeeperAlive', false);
      this.director.setFlag('gatekeeperDefeated', true);
    }
    if (atOrPast('ACCESS_MODULE_ACQUIRED')) {
      this.director.setFlag('moduleAcquired', true);
      this.level.factory.setAccessModuleAcquired(true);
    }
    if (atOrPast('GATE_OPENING')) {
      this.director.setFlag('gateOpen', true);
      this.level.factory.openGate();
    }
    if (atOrPast('FACTORY_ENTRY')) this.director.setFlag('insideFactory', true);
    if (atOrPast('HOSTAGES_DISCOVERED')) this.director.setFlag('hostagesSeen', true);
    if (atOrPast('BOSS_INTRO')) {
      this.director.setFlag('reachedControlRoom', true);
      this.enemies.clearZone('interior');
    }

    if (state === 'BOSS_INTRO' || state === 'BOSS_PHASE_1' || state === 'BOSS_PHASE_2' || state === 'BOSS_PHASE_3') {
      this.warden.reset();
      this.warden.spawn(this.level.factory.bossSpawn);
      const phase = state === 'BOSS_PHASE_2' ? 2 : state === 'BOSS_PHASE_3' ? 3 : 1;
      this.warden.debugSetPhase(phase);
      if (phase >= 2) this.director.setFlag('bossRelaysDown', 2);
      if (phase >= 3) this.director.setFlag('bossCoolantDown', true);
    }
    if (atOrPast('BOSS_DEFEATED')) {
      this.warden.group.visible = false;
      this.director.setFlag('bossRelaysDown', 2);
      this.director.setFlag('bossCoolantDown', true);
      this.director.setFlag('bossCoreDown', true);
      this.level.factory.setBossDefeated(true);
    }
    if (atOrPast('EXTRACTION')) {
      this.level.factory.releaseHostages();
      this.director.setFlag('hostagesReleased', true);
    }

    this.director.debugForceState(state);
    this.input.requestLock();
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
    const permissions = this.director.inputPermissions;
    const lookAllowed = permissions.look && Boolean(this.input?.locked);
    const moveAllowed = permissions.move;
    const fireAllowed = permissions.fire;

    // --- 2. mission ---
    // Only the intro phase drives the camera; every other phase uses the
    // player's own eye transform untouched.
    const introBlend = this.director.phase === 'intro' ? this.director.introBlend : 0;
    if (introBlend > 0) this.director.getIntroOffset(this.introOffset);
    if (lookAllowed) {
      this.view.applyLook(lookX, lookY, this.weapon.adsBlend);
    }

    // --- 3. player + camera ---
    const wantsAds = fireAllowed
      ? this.input.aiming || this.input.firing || this.weapon.forcingAds
      : false;
    this.player.setFrozen(!moveAllowed);
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
      // The weapon's blend is the single ADS authority - see PlayerCamera.update.
      this.weapon.adsBlend,
      this.player.sprinting,
    );

    // --- 4. weapon (after the camera: the view-model is parented to it) ---
    if (fireAllowed) {
      this.weapon.setTrigger(this.input.firing, this.input.firePressed);
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

    if (this.skipIntro && this.director.phase === 'intro') {
      this.director.finishIntro();
    }

    // --- 5. enemies ---
    if (!this.engagementOpen && this.director.combatActive) {
      this.engagementGrace += dt;
      const acting =
        this.player.speed > 0.4 || this.input.firing || this.input.aiming || !this.player.grounded;
      if (acting || this.engagementGrace > 4) this.engagementOpen = true;
    }
    const combatEngaged = this.director.combatActive && this.engagementOpen;
    this.humanoids.update(dt, elapsed, this.player.eye, this.player.alive, combatEngaged);
    this.enemies.update(dt, elapsed, this.player.eye, this.player.alive, combatEngaged);
    this.gatekeeper.update(
      dt,
      elapsed,
      this.player.eye,
      this.director.state === 'GATEKEEPER_ACTIVE',
    );
    this.warden.update(
      dt,
      elapsed,
      this.player.eye,
      this.director.state === 'BOSS_PHASE_1' ||
        this.director.state === 'BOSS_PHASE_2' ||
        this.director.state === 'BOSS_PHASE_3',
    );

    // --- 6. world ---
    this.explosives.update(dt, elapsed);
    updateWind(elapsed, dt);
    this.level.update(dt, elapsed, this.view.camera.position);
    this.updateFactoryHazards(dt);
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
    this.updateMissionFlags();
    const extractionDistance = this.player.position.distanceTo(
      this.level.factory.objectivePoints.factoryEntry,
    );
    this.director.update(
      dt,
      this.player.position.x,
      this.humanoids.aliveCount,
      extractionDistance,
      this.player.alive,
    );
    this.truthReveal.update(dt);

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

    this.updateHud(dt);

    // Mission state is mirrored onto <body> as data attributes. This is the
    // only diagnostic that survives an isolated-world console (automated
    // screenshots, embedded previews) and costs one DOM write per change.
    if (document.body.dataset.phase !== this.director.phase) {
      document.body.dataset.phase = this.director.phase;
    }
    if (document.body.dataset.missionState !== this.director.state) {
      document.body.dataset.missionState = this.director.state;
    }
    document.body.dataset.checkpoint = this.director.checkpoint;
    document.body.dataset.missionFlags = this.missionFlagTrace();
    document.body.dataset.bossPhase = String(this.warden.phase);
    const tick = Math.floor(this.clock.elapsed).toString();
    if (document.body.dataset.tick !== tick) document.body.dataset.tick = tick;
    document.body.dataset.blast = this.vfx.blastState;
    if (this.enemyTrace) {
      document.body.dataset.enemies = `H:${this.humanoids.stateTrace} R:${this.enemies.stateTrace} GK:${this.gatekeeper.stateTrace}`;
    }
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
      if (this.director.restartAtCheckpoint()) {
        this.restoreCheckpointWorld(this.director.checkpoint);
      } else {
        this.restartFromBriefing(false);
      }
    }
    if (this.input.wasPressed('interact')) this.handleInteraction();
  }

  private handleInteraction(): void {
    if (!this.director.inputPermissions.interact) return;
    if (this.accessModule?.visible && this.director.state === 'ACCESS_MODULE_DROPPED') {
      this.accessModule.getWorldPosition(this.tmpVec);
      if (this.tmpVec.distanceTo(this.player.position) <= 4.2 && this.recoverAccessModule()) return;
    }

    const result = this.level.factory.interact(this.player.position);
    if (!result.handled) return;
    if (result.kind === 'gate_terminal') {
      this.director.setFlag('atGateTerminal', true);
      this.director.setFlag('gateOpen', true);
    } else if (result.kind === 'hostage_release_terminal') {
      this.director.setFlag('hostagesReleased', true);
    }
  }

  private recoverAccessModule(): boolean {
    if (!this.accessModule?.visible) return false;
    this.accessModule.visible = false;
    this.accessModule = null;
    this.director.setFlag('moduleAcquired', true);
    this.level.factory.setAccessModuleAcquired(true);
    return true;
  }

  private updateFactoryHazards(dt: number): void {
    this.hazardDamageCooldown = Math.max(0, this.hazardDamageCooldown - dt);
    if (!this.director.inputPermissions.move) return;
    const hazard = this.level.factory.queryHazard(this.player.position);
    if (!hazard?.active) return;
    this.player.velocity.addScaledVector(hazard.pushVelocity, Math.min(1, dt * 4));
    if (hazard.damagePerSecond > 0 && this.hazardDamageCooldown <= 0) {
      this.hazardDamageCooldown = 0.25;
      this.tmpVec.copy(this.player.position).sub(hazard.pushVelocity);
      this.player.damage(hazard.damagePerSecond * 0.25, this.tmpVec);
    }
  }

  private updateMissionFlags(): void {
    const factory = this.level.factory;
    const position = this.player.position;
    // Walking directly over the bright module is enough to collect it. The
    // wider manual USE/F radius remains for players who stop beside the wreck.
    if (this.accessModule?.visible && this.director.state === 'ACCESS_MODULE_DROPPED') {
      this.accessModule.getWorldPosition(this.tmpVec);
      if (this.tmpVec.distanceTo(position) <= 1.65) this.recoverAccessModule();
    }
    const inside = position.z > 14 && position.x > 12 && position.x < 46;
    if (inside) this.director.setFlag('insideFactory', true);
    if (position.distanceTo(factory.objectivePoints.hostageObservation) < 11) {
      this.director.setFlag('hostagesSeen', true);
    }
    if (
      this.enemies.aliveInZone('interior') === 0 &&
      position.distanceTo(factory.objectivePoints.bossArena) < factory.bossArenaRadius + 1.5
    ) {
      this.director.setFlag('reachedControlRoom', true);
    }
    if (factory.gateState !== 'closed') this.director.setFlag('gateOpen', true);
    if (factory.hostagesReleased) this.director.setFlag('hostagesReleased', true);
    if (this.gatekeeper.defeated) {
      this.director.setFlag('gatekeeperAlive', false);
      this.director.setFlag('gatekeeperDefeated', true);
    }
    this.director.setFlag('bossRelaysDown', this.warden.phase > 1 ? 2 : this.director.flags.bossRelaysDown);
    if (this.warden.phase > 2) this.director.setFlag('bossCoolantDown', true);
    if (this.warden.defeated) this.director.setFlag('bossCoreDown', true);

    const interaction = factory.queryInteraction(position);
    if (interaction?.kind === 'gate_terminal' && this.director.flags.moduleAcquired) {
      this.director.setFlag('atGateTerminal', true);
    }
  }

  private updateHud(dt: number): void {
    const state = this.director.state;
    const exteriorRemaining = this.humanoids.aliveCount;
    const interiorRemaining = this.enemies.aliveInZone('interior');
    const counterLabel = state.startsWith('BOSS_')
      ? `弱点耐久 ${(this.warden.weakPointHealth01 * 100).toFixed(0)}%`
      : state.startsWith('GATEKEEPER_')
        ? `装甲コア ${(this.gatekeeper.healthFraction * 100).toFixed(0)}%`
        : this.director.flags.insideFactory
          ? `ロボット残存 ${String(interiorRemaining).padStart(2, '0')}`
          : `ヤード敵残存 ${String(exteriorRemaining).padStart(2, '0')}`;
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
      enemiesRemaining: this.humanoids.aliveCount + this.enemies.aliveCount,
      enemiesTotal: this.humanoids.totalCount + this.enemies.totalCount,
      cameraYaw: this.view.yaw,
      counterLabel,
    });

    this.updateInteractionPrompt();
    if (state.startsWith('BOSS_') && state !== 'BOSS_DEFEATED') {
      this.hud.setBoss(CAST.boss, this.warden.phase, this.warden.weakPointHealth01, true);
    } else if (state === 'GATEKEEPER_INTRO' || state === 'GATEKEEPER_ACTIVE') {
      this.hud.setBoss(CAST.gatekeeper, 1, this.gatekeeper.healthFraction, true);
    } else {
      this.hud.setBoss('', 0, 0, false);
    }

    const objectivePoint = this.getObjectivePoint(this.tmpVec2);
    const objectiveDistance = objectivePoint.distanceTo(this.player.position);
    this.hud.updateMarker(
      objectivePoint,
      this.view.camera,
      this.director.phase === 'active' && state !== 'TRUTH_REVEAL',
      state === 'ACCESS_MODULE_DROPPED'
        ? `アクセスモジュール // ${objectiveDistance.toFixed(0)}m`
        : `${objectiveDistance.toFixed(0)}m`,
      state === 'ACCESS_MODULE_DROPPED',
    );

    const stats = this.vfx.stats;
    const fps = this.clock.fps;
    this.hud.setPerf(
      [
        `<b>${fps.toFixed(0)}</b> fps &nbsp; <b>${this.clock.smoothedFrameMs.toFixed(1)}</b> ms`,
        `描画回数 <b>${this.renderSystem.drawCalls}</b>`,
        `三角形 <b>${(this.renderSystem.triangles / 1000).toFixed(0)}k</b>`,
        `テクスチャ <b>${this.renderSystem.textureCount}</b>`,
        `粒子 <b>${stats.particles}</b> &nbsp; 弾痕 <b>${stats.decals}</b>`,
        `光源 <b>${this.level.practicals.count + 3}</b> &nbsp; 衝突箱 <b>${this.collision.boxCount}</b>`,
        `画質 <b>${QUALITY_PRESETS[this.qualityLevel].label}</b>`,
        fps < 50 ? '<span class="warn">処理負荷が高めです — 画質を下げてください</span>' : '',
      ].join('<br>'),
    );
  }

  private updateInteractionPrompt(): void {
    if (!this.director.inputPermissions.interact) {
      this.hud.setInteraction(null);
      return;
    }
    if (this.accessModule?.visible && this.director.state === 'ACCESS_MODULE_DROPPED') {
      this.accessModule.getWorldPosition(this.tmpVec);
      if (this.tmpVec.distanceTo(this.player.position) <= 4.2) {
        this.hud.setInteraction('発光するアクセスモジュールを回収');
        return;
      }
    }
    const interaction = this.level.factory.queryInteraction(this.player.position);
    this.hud.setInteraction(interaction ? interaction.prompt : null);
  }

  private getObjectivePoint(out: THREE.Vector3): THREE.Vector3 {
    const points = this.level.factory.objectivePoints;
    switch (this.director.state) {
      case 'ACCESS_MODULE_DROPPED':
        if (this.accessModule?.visible) return this.accessModule.getWorldPosition(out).setY(1.3);
        return out.copy(this.level.factory.gatekeeperSpawn).setY(1.3);
      case 'ACCESS_MODULE_ACQUIRED':
      case 'GATE_TERMINAL_ACTIVE':
      case 'GATE_OPENING':
        return out.copy(points.gateTerminal).setY(1.8);
      case 'FACTORY_ENTRY':
        return out.copy(points.factoryEntry).setY(1.8);
      case 'INTERIOR_APPROACH':
        return out.copy(points.hostageObservation).setY(1.8);
      case 'HOSTAGES_DISCOVERED':
      case 'BOSS_INTRO':
        return out.copy(points.bossArena).setY(2.2);
      case 'BOSS_PHASE_1':
      case 'BOSS_PHASE_2':
      case 'BOSS_PHASE_3':
        return this.warden.weakPointPosition(out);
      case 'HOSTAGE_RELEASE':
        return out.copy(points.releaseTerminal).setY(1.8);
      case 'EXTRACTION':
        return out.copy(points.factoryEntry).setY(1.8);
      default:
        return out.copy(this.level.factory.gatekeeperSpawn).setY(2.2);
    }
  }

  private missionFlagTrace(): string {
    const f = this.director.flags;
    return `ext=${f.exteriorHostilesRemaining} gk=${Number(f.gatekeeperDefeated)} ` +
      `mod=${Number(f.moduleAcquired)} gate=${Number(f.gateOpen)} inside=${Number(f.insideFactory)} ` +
      `hostages=${Number(f.hostagesSeen)}/${Number(f.hostagesReleased)} ` +
      `boss=${f.bossRelaysDown}/${Number(f.bossCoolantDown)}/${Number(f.bossCoreDown)}`;
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

  private onMissionStateChanged(state: MissionState, previous: MissionState): void {
    if (state === 'RESTARTING') {
      this.retries++;
      this.overlays.hideEnd();
      this.restoreCheckpointWorld(this.director.checkpoint);
      this.mobileControls.setActive(true);
      this.input.requestLock();
      return;
    }
    // The exterior mission is stage one. Refill both the magazine and reserve
    // exactly once as the factory (stage two) begins.
    if (state === 'FACTORY_ENTRY' && previous === 'GATE_OPENING') {
      this.weapon.resupply();
    }
    if (state === 'HOSTAGE_RELEASE') {
      this.truthReveal.reset();
      this.overlays.hideTruth();
    }
    if (state === 'BOSS_DEFEATED') this.level.factory.setBossDefeated(true);
    if (state === 'PLAYER_DEAD') this.onMissionEnded(false);
    if (state === 'MISSION_COMPLETE') this.onMissionEnded(true);
  }

  private onMissionEnded(success: boolean): void {
    this.input.exitLock();
    this.mobileControls.setActive(false);
    this.player.setFrozen(true);
    this.audio.setAmbienceLevel(0.2);
    const accuracy = this.ballistics.accuracy * 100;
    this.overlays.showEnd(success, [
      ['経過時間', formatTime(this.director.missionTime)],
      [
        '撃破数',
        `${this.humanoids.killCount + this.enemies.killCount} / ${this.humanoids.totalCount + this.enemies.totalCount}`,
      ],
      ['命中率', `${accuracy.toFixed(0)}%`],
      ['発射弾数', String(this.ballistics.shotsFired)],
      ['再開回数', String(this.retries)],
    ]);
    if (success) {
      this.bus.emit('mission:complete', {
        timeSec: this.director.missionTime,
        kills: this.humanoids.killCount + this.enemies.killCount,
        accuracy: this.ballistics.accuracy,
      });
    }
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
