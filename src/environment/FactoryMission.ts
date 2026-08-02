import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import type { CollisionBoxHandle, CollisionWorld } from '@/physics/CollisionWorld';
import { chamferBox, corrugatedPanel } from './GeometryKit';

/** Shared dimensions used by the harbour shell and the playable mission space. */
export const FACTORY_LAYOUT = {
  xMin: 12,
  xMax: 46,
  frontZ: 12.5,
  rearZ: 62.5,
  height: 11.5,
  gateX: 33.4,
  gateWidth: 5.4,
  gateHeight: 5.2,
} as const;

export type FactoryZone = 'loading' | 'manufacturing' | 'control';
export type FactoryRobotType = 'scout' | 'sentinel';

export interface FactoryRobotSpawn {
  readonly type: FactoryRobotType;
  readonly zone: FactoryZone;
  readonly position: THREE.Vector3;
  readonly patrolTo: THREE.Vector3;
  readonly activationZ: number;
  readonly elevated: boolean;
}

export interface ProtectedVolume {
  readonly center: THREE.Vector3;
  readonly radius: number;
}

export type FactoryInteractionKind = 'gate_terminal' | 'hostage_release_terminal';
export type FactoryInteractionStatus = 'locked' | 'ready' | 'busy' | 'complete';

export interface FactoryInteraction {
  readonly kind: FactoryInteractionKind;
  readonly status: FactoryInteractionStatus;
  readonly prompt: string;
  readonly position: THREE.Vector3;
  readonly distance: number;
}

export interface FactoryInteractionResult {
  readonly handled: boolean;
  readonly kind: FactoryInteractionKind | null;
  readonly reason: 'ok' | 'out_of_range' | 'access_module_required' | 'boss_active' | 'already_complete';
}

export type FactoryHazardKind = 'robot_arm' | 'steam_vent' | 'conveyor';

/** Damage is per second; callers may apply pushVelocity for their own controller. */
export interface FactoryHazardContact {
  readonly kind: FactoryHazardKind;
  readonly damagePerSecond: number;
  readonly pushVelocity: THREE.Vector3;
  readonly telegraph: boolean;
  readonly active: boolean;
}

export interface FactoryObjectivePoints {
  readonly gateTerminal: THREE.Vector3;
  readonly factoryEntry: THREE.Vector3;
  readonly manufacturingLine: THREE.Vector3;
  readonly hostageObservation: THREE.Vector3;
  readonly bossArena: THREE.Vector3;
  readonly releaseTerminal: THREE.Vector3;
}

export type FactoryGateState = 'closed' | 'opening' | 'open' | 'closing';

const GATE_OPEN_SECONDS = 5.4;
const GATE_COLLISION_CLEAR_PROGRESS = 0.86;
const HOSTAGE_DOOR_SECONDS = 2.1;
const tmpMatrix = new THREE.Matrix4();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3(1, 1, 1);

/**
 * Dynamic layer placed inside HarborLevel's static factory shell.
 *
 * It owns mission-facing anchors, the two interaction terminals, the moving
 * shutter, three inexpensive industrial hazards and the protected hostage bay.
 * Combat/mission systems remain outside this class and consume its public API.
 */
export class FactoryMission {
  readonly group = new THREE.Group();

  readonly gatekeeperSpawn = new THREE.Vector3(53, 0, -2);
  readonly bossSpawn = new THREE.Vector3(31, 0, 50.5);
  readonly bossArenaRadius = 11.5;
  readonly bossArena: ProtectedVolume = {
    center: new THREE.Vector3(31, 0, 50.5),
    radius: this.bossArenaRadius,
  };
  readonly protectedVolume: ProtectedVolume = {
    center: new THREE.Vector3(16.5, 1.6, 52),
    radius: 4.7,
  };

  readonly objectivePoints: FactoryObjectivePoints = {
    gateTerminal: new THREE.Vector3(37.05, 1.15, 11.9),
    factoryEntry: new THREE.Vector3(33.4, 0, 17),
    manufacturingLine: new THREE.Vector3(29, 0, 30),
    hostageObservation: new THREE.Vector3(21.5, 0, 52),
    bossArena: new THREE.Vector3(31, 0, 50.5),
    releaseTerminal: new THREE.Vector3(21.0, 1.15, 49.6),
  };

  readonly robotSpawns: readonly FactoryRobotSpawn[] = [
    this.robotSpawn('sentinel', 'loading', 27, 19.5, 31, 20.5, 15),
    this.robotSpawn('sentinel', 'manufacturing', 38, 32, 35.5, 34.5, 27),
    this.robotSpawn('sentinel', 'control', 40, 43, 38, 47, 39),
  ];

  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly collision: CollisionWorld;
  private readonly gateCollision: CollisionBoxHandle;
  private readonly hostageDoorCollision: CollisionBoxHandle;
  private readonly shutter = new THREE.Group();
  private readonly hostageDoor = new THREE.Group();
  private readonly armPivot = new THREE.Group();
  private readonly armTip = new THREE.Vector3();
  private readonly conveyorCargo: THREE.Mesh[] = [];
  private armWarning!: THREE.Mesh;
  private steamWarning!: THREE.Mesh;
  private steamJet!: THREE.Mesh;
  private gateScreen!: THREE.Mesh;
  private releaseScreen!: THREE.Mesh;
  private readonly hostageRoots: THREE.Group[] = [];

  private gateProgress = 0;
  private gateTarget = 0;
  private hostageDoorProgress = 0;
  private accessModuleAcquired = false;
  private bossDefeated = false;
  private released = false;
  private armTelegraph = false;
  private armActive = false;
  private steamTelegraph = false;
  private steamActive = false;

  private readonly lockedMat: THREE.Material;
  private readonly readyMat: THREE.Material;
  private readonly completeMat: THREE.Material;

  constructor(mats: MaterialLibrary, collision: CollisionWorld) {
    this.collision = collision;
    this.group.name = 'FactoryMission';

    this.lockedMat = mats.emissive('factoryLocked', 0xff3527, 2.2);
    this.readyMat = mats.emissive('factoryReady', 0xffb22c, 2.5);
    this.completeMat = mats.emissive('factoryComplete', 0x55e7a1, 2.0);

    this.buildGate(mats);
    this.buildLoadingZone(mats);
    this.buildManufacturingZone(mats);
    this.buildControlZone(mats);
    this.buildHostageBay(mats);
    this.buildCeilingSignals(mats);

    this.group.traverse((node) => node.layers.set(LAYER.WORLD));
    this.group.updateWorldMatrix(true, true);
    this.collision.addRaycastTarget(this.group);

    const { gateX, gateWidth, gateHeight, frontZ } = FACTORY_LAYOUT;
    this.gateCollision = collision.addBox(
      new THREE.Vector3(gateX - gateWidth / 2, 0, frontZ - 0.22),
      new THREE.Vector3(gateX + gateWidth / 2, gateHeight, frontZ + 0.28),
      'thinMetal',
      true,
    );
    this.hostageDoorCollision = collision.addBox(
      new THREE.Vector3(19.72, 0, 50.95),
      new THREE.Vector3(19.94, 2.65, 53.05),
      'glass',
      true,
    );
    this.addEquipmentCollision(collision);
    this.reset();
  }

  get gateState(): FactoryGateState {
    if (this.gateProgress <= 0.001 && this.gateTarget === 0) return 'closed';
    if (this.gateProgress >= 0.999 && this.gateTarget === 1) return 'open';
    return this.gateTarget > this.gateProgress ? 'opening' : 'closing';
  }

  get hasAccessModule(): boolean {
    return this.accessModuleAcquired;
  }

  get hostagesReleased(): boolean {
    return this.released;
  }

  setAccessModuleAcquired(acquired = true): void {
    this.accessModuleAcquired = acquired;
    this.refreshTerminalMaterials();
  }

  setBossDefeated(defeated = true): void {
    this.bossDefeated = defeated;
    this.refreshTerminalMaterials();
  }

  openGate(): void {
    this.gateTarget = 1;
    this.refreshTerminalMaterials();
  }

  closeGate(): void {
    this.gateTarget = 0;
    this.refreshTerminalMaterials();
  }

  releaseHostages(): void {
    if (!this.bossDefeated) return;
    this.released = true;
    this.refreshTerminalMaterials();
  }

  /** Returns the nearest terminal within range, including why it is locked. */
  queryInteraction(position: THREE.Vector3, maxDistance = 2.5): FactoryInteraction | null {
    const gateDistance = position.distanceTo(this.objectivePoints.gateTerminal);
    const releaseDistance = position.distanceTo(this.objectivePoints.releaseTerminal);
    if (gateDistance > maxDistance && releaseDistance > maxDistance) return null;

    if (gateDistance <= releaseDistance) {
      const status = this.gateInteractionStatus();
      return {
        kind: 'gate_terminal',
        status,
        prompt: status === 'locked'
          ? 'アクセスモジュールが必要'
          : status === 'complete'
            ? '工場ゲート開放済み'
            : status === 'busy'
              ? '認証中 — シャッターから離れてください'
              : 'アクセスモジュールを挿入',
        position: this.objectivePoints.gateTerminal.clone(),
        distance: gateDistance,
      };
    }

    const status = this.releaseInteractionStatus();
    return {
      kind: 'hostage_release_terminal',
      status,
      prompt: status === 'locked'
        ? 'WARDEN-03のロックが有効'
        : status === 'complete'
          ? '保護対象を解放済み'
          : '保護対象の解放を承認',
      position: this.objectivePoints.releaseTerminal.clone(),
      distance: releaseDistance,
    };
  }

  /** Executes the current nearby interaction; useful as the player's F action. */
  interact(position: THREE.Vector3, maxDistance = 2.5): FactoryInteractionResult {
    const query = this.queryInteraction(position, maxDistance);
    if (!query) return { handled: false, kind: null, reason: 'out_of_range' };
    if (query.status === 'complete' || query.status === 'busy') {
      return { handled: false, kind: query.kind, reason: 'already_complete' };
    }
    if (query.status === 'locked') {
      return {
        handled: false,
        kind: query.kind,
        reason: query.kind === 'gate_terminal' ? 'access_module_required' : 'boss_active',
      };
    }
    if (query.kind === 'gate_terminal') this.openGate();
    else this.releaseHostages();
    return { handled: true, kind: query.kind, reason: 'ok' };
  }

  /**
   * Samples the three authored hazards at a player/AI feet position.
   * Telegraph contacts carry no damage and let the caller expose warning UI.
   */
  queryHazard(position: THREE.Vector3): FactoryHazardContact | null {
    if (position.y > 2.3) return null;

    const armDistanceSq = (position.x - this.armTip.x) ** 2 + (position.z - this.armTip.z) ** 2;
    if ((this.armActive || this.armTelegraph) && armDistanceSq < 2.15 * 2.15) {
      const push = new THREE.Vector3(position.x - this.armTip.x, 0, position.z - this.armTip.z)
        .normalize()
        .multiplyScalar(this.armActive ? 5.5 : 0);
      return {
        kind: 'robot_arm',
        damagePerSecond: this.armActive ? 22 : 0,
        pushVelocity: push,
        telegraph: this.armTelegraph,
        active: this.armActive,
      };
    }

    const steamDistanceSq = (position.x - 37.2) ** 2 + (position.z - 34.2) ** 2;
    if ((this.steamActive || this.steamTelegraph) && steamDistanceSq < 1.7 * 1.7) {
      return {
        kind: 'steam_vent',
        damagePerSecond: this.steamActive ? 15 : 0,
        pushVelocity: new THREE.Vector3(this.steamActive ? -2.2 : 0, 0, 0),
        telegraph: this.steamTelegraph,
        active: this.steamActive,
      };
    }

    if (Math.abs(position.x - 29) < 5.8 && Math.abs(position.z - 27.8) < 1.15) {
      return {
        kind: 'conveyor',
        damagePerSecond: 0,
        pushVelocity: new THREE.Vector3(1.35, 0, 0),
        telegraph: false,
        active: true,
      };
    }
    return null;
  }

  update(dt: number, elapsed: number): void {
    const gateStep = dt / GATE_OPEN_SECONDS;
    this.gateProgress = moveToward(this.gateProgress, this.gateTarget, gateStep);
    const gateLift = easeInOut(this.gateProgress) * (FACTORY_LAYOUT.gateHeight + 0.55);
    this.shutter.position.y = FACTORY_LAYOUT.gateHeight / 2 + gateLift;
    this.collision.setBoxSolid(this.gateCollision, this.gateProgress < GATE_COLLISION_CLEAR_PROGRESS);

    const hostageTarget = this.released ? 1 : 0;
    this.hostageDoorProgress = moveToward(
      this.hostageDoorProgress,
      hostageTarget,
      dt / HOSTAGE_DOOR_SECONDS,
    );
    this.hostageDoor.position.y = 1.325 + easeInOut(this.hostageDoorProgress) * 2.9;
    this.collision.setBoxSolid(this.hostageDoorCollision, this.hostageDoorProgress < 0.8);

    const armCycle = elapsed % 8.2;
    this.armTelegraph = armCycle >= 3.7 && armCycle < 5.4;
    this.armActive = armCycle >= 5.4 && armCycle < 6.75;
    const sweepT = THREE.MathUtils.clamp((armCycle - 5.4) / 1.35, 0, 1);
    this.armPivot.rotation.y = this.armActive
      ? THREE.MathUtils.lerp(-1.08, 1.08, easeInOut(sweepT))
      : -1.08;
    this.armPivot.updateWorldMatrix(true, true);
    this.armTip.set(4.1, 0, 0).applyMatrix4(this.armPivot.matrixWorld);
    this.armWarning.visible = this.armTelegraph || this.armActive;
    this.armWarning.scale.setScalar(this.armActive ? 1.25 : 0.8 + Math.sin(elapsed * 10) * 0.18);

    const steamCycle = (elapsed + 2.1) % 7.4;
    this.steamTelegraph = steamCycle >= 3.2 && steamCycle < 4.8;
    this.steamActive = steamCycle >= 4.8 && steamCycle < 6.15;
    this.steamWarning.visible = this.steamTelegraph || this.steamActive;
    this.steamWarning.scale.setScalar(this.steamActive ? 1.35 : 0.82 + Math.sin(elapsed * 12) * 0.16);
    this.steamJet.visible = this.steamActive;
    this.steamJet.scale.x = 0.75 + Math.sin(elapsed * 18) * 0.18;

    for (let i = 0; i < this.conveyorCargo.length; i++) {
      this.conveyorCargo[i].position.x = 23.7 + ((elapsed * 1.35 + i * 4.05) % 10.8);
    }

    for (let i = 0; i < this.hostageRoots.length; i++) {
      this.hostageRoots[i].position.y = 0.02 + Math.sin(elapsed * 1.4 + i * 1.7) * 0.018;
      if (this.released) this.hostageRoots[i].rotation.y = THREE.MathUtils.lerp(
        this.hostageRoots[i].rotation.y,
        -0.45 + i * 0.35,
        Math.min(1, dt * 2.2),
      );
    }
    this.refreshTerminalMaterials();
  }

  reset(): void {
    this.accessModuleAcquired = false;
    this.bossDefeated = false;
    this.released = false;
    this.gateProgress = 0;
    this.gateTarget = 0;
    this.hostageDoorProgress = 0;
    this.shutter.position.y = FACTORY_LAYOUT.gateHeight / 2;
    this.hostageDoor.position.y = 1.325;
    this.collision.setBoxSolid(this.gateCollision, true);
    this.collision.setBoxSolid(this.hostageDoorCollision, true);
    this.refreshTerminalMaterials();
  }

  dispose(): void {
    this.collision.removeRaycastTarget(this.group);
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.clear();
    this.group.removeFromParent();
  }

  private robotSpawn(
    type: FactoryRobotType,
    zone: FactoryZone,
    x: number,
    z: number,
    patrolX: number,
    patrolZ: number,
    activationZ: number,
  ): FactoryRobotSpawn {
    return {
      type,
      zone,
      position: new THREE.Vector3(x, 0, z),
      patrolTo: new THREE.Vector3(patrolX, 0, patrolZ),
      activationZ,
      elevated: false,
    };
  }

  private buildGate(mats: MaterialLibrary): void {
    this.shutter.name = 'FactoryRollerGate';
    this.shutter.position.set(FACTORY_LAYOUT.gateX, FACTORY_LAYOUT.gateHeight / 2, FACTORY_LAYOUT.frontZ - 0.08);
    const corrugated = this.geo(corrugatedPanel(FACTORY_LAYOUT.gateWidth, FACTORY_LAYOUT.gateHeight, 24, 0.04));
    const skin = new THREE.Mesh(corrugated, mats.cladding('Rust'));
    skin.rotation.y = Math.PI;
    skin.castShadow = true;
    skin.receiveShadow = true;
    this.shutter.add(skin);
    const backing = this.mesh(
      chamferBox(FACTORY_LAYOUT.gateWidth, FACTORY_LAYOUT.gateHeight, 0.09, 0.015, 1),
      mats.steelBare(),
      0,
      0,
      0.08,
    );
    this.shutter.add(backing);
    this.group.add(this.shutter);

    const terminal = new THREE.Group();
    terminal.name = 'FactoryGateTerminal';
    terminal.position.copy(this.objectivePoints.gateTerminal);
    terminal.add(this.mesh(chamferBox(0.62, 1.45, 0.35, 0.04, 1), mats.steelPainted(), 0, 0, 0));
    this.gateScreen = this.mesh(chamferBox(0.42, 0.28, 0.035, 0.01, 1), this.lockedMat, 0, 0.24, -0.19);
    terminal.add(this.gateScreen);
    terminal.rotation.y = Math.PI;
    this.group.add(terminal);

    const stripe = this.mesh(chamferBox(6.15, 0.08, 0.65, 0.015, 1), mats.hazard(), FACTORY_LAYOUT.gateX, 0.05, 12.86);
    this.group.add(stripe);
  }

  private buildLoadingZone(mats: MaterialLibrary): void {
    const zone = new THREE.Group();
    zone.name = 'FactoryZone_Loading';
    this.group.add(zone);

    const columnGeo = this.geo(chamferBox(0.34, 6.8, 0.34, 0.025, 1));
    const columns = new THREE.InstancedMesh(columnGeo, mats.steelPainted(), 6);
    const positions = [
      [15.2, 3.4, 17.5],
      [43.0, 3.4, 17.5],
      [15.2, 3.4, 23.0],
      [43.0, 3.4, 23.0],
      [21.5, 3.4, 23.0],
      [36.5, 3.4, 23.0],
    ];
    positions.forEach(([x, y, z], index) => columns.setMatrixAt(index, compose(x, y, z)));
    columns.instanceMatrix.needsUpdate = true;
    columns.castShadow = true;
    columns.receiveShadow = true;
    zone.add(columns);

    const barrierGeo = this.geo(chamferBox(2.6, 0.85, 0.28, 0.035, 1));
    for (const [x, z, rotation] of [[21, 19.6, 0.18], [40.5, 21.2, -0.22]] as const) {
      const barrier = new THREE.Mesh(barrierGeo, mats.concreteWall());
      barrier.position.set(x, 0.425, z);
      barrier.rotation.y = rotation;
      barrier.castShadow = barrier.receiveShadow = true;
      zone.add(barrier);
    }

    const lane = this.mesh(chamferBox(12, 0.06, 0.42, 0.01, 1), mats.hazard(), 29, 0.04, 23.55);
    zone.add(lane);
  }

  private buildManufacturingZone(mats: MaterialLibrary): void {
    const zone = new THREE.Group();
    zone.name = 'FactoryZone_Manufacturing';
    this.group.add(zone);

    const conveyor = this.mesh(chamferBox(12, 0.72, 2.4, 0.06, 2), mats.tread(), 29, 0.52, 27.8);
    conveyor.name = 'ActiveConveyor';
    zone.add(conveyor);
    const rollerGeo = this.geo(new THREE.CylinderGeometry(0.15, 0.15, 2.32, 8));
    const rollers = new THREE.InstancedMesh(rollerGeo, mats.steelBare(), 12);
    tmpQuaternion.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    for (let i = 0; i < 12; i++) {
      tmpMatrix.compose(new THREE.Vector3(23.5 + i, 0.94, 27.8), tmpQuaternion, tmpScale);
      rollers.setMatrixAt(i, tmpMatrix);
    }
    rollers.instanceMatrix.needsUpdate = true;
    rollers.castShadow = rollers.receiveShadow = true;
    zone.add(rollers);
    const cargoGeo = this.geo(chamferBox(0.85, 0.62, 1.35, 0.06, 2));
    for (let i = 0; i < 3; i++) {
      const cargo = new THREE.Mesh(cargoGeo, i === 1 ? mats.cladding('Rust') : mats.steelPainted());
      cargo.position.set(23.7 + i * 4.05, 1.35, 27.8);
      cargo.castShadow = cargo.receiveShadow = true;
      cargo.name = 'ConveyorCargo';
      this.conveyorCargo.push(cargo);
      zone.add(cargo);
    }

    const base = this.mesh(chamferBox(1.1, 1.05, 1.1, 0.08, 2), mats.hazard(), 23.5, 0.525, 33.1);
    zone.add(base);
    this.armPivot.name = 'TelegraphedRobotArm';
    this.armPivot.position.set(23.5, 2.25, 33.1);
    const mast = this.mesh(chamferBox(0.62, 3.4, 0.62, 0.05, 2), mats.steelPainted(), 0, 0, 0);
    this.armPivot.add(mast);
    const arm = this.mesh(chamferBox(4.6, 0.42, 0.55, 0.05, 2), mats.steelPainted(), 2.05, 0.9, 0);
    this.armPivot.add(arm);
    const head = this.mesh(chamferBox(0.75, 0.9, 0.75, 0.06, 2), mats.steelBare(), 4.15, 0.75, 0);
    this.armPivot.add(head);
    this.armWarning = this.mesh(new THREE.SphereGeometry(0.18, 8, 6), this.readyMat, 0, 2.0, 0);
    this.armPivot.add(this.armWarning);
    zone.add(this.armPivot);

    const pipe = this.mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.4, 10), mats.steelBare(), 37.2, 1.7, 34.2);
    zone.add(pipe);
    const nozzle = this.mesh(chamferBox(0.65, 0.65, 0.85, 0.07, 2), mats.hazard(), 37.2, 0.45, 34.2);
    zone.add(nozzle);
    this.steamWarning = this.mesh(new THREE.SphereGeometry(0.17, 8, 6), this.readyMat, 37.2, 2.6, 34.2);
    zone.add(this.steamWarning);
    this.steamJet = this.mesh(new THREE.CylinderGeometry(0.22, 0.65, 2.1, 8, 1, true), this.lockedMat, 36.05, 0.8, 34.2);
    this.steamJet.rotation.z = Math.PI / 2;
    this.steamJet.castShadow = false;
    zone.add(this.steamJet);

    for (const z of [24.2, 38.1]) {
      const threshold = this.mesh(chamferBox(31.8, 0.065, 0.36, 0.012, 1), mats.hazard(), 29, 0.04, z);
      zone.add(threshold);
    }
  }

  private buildControlZone(mats: MaterialLibrary): void {
    const zone = new THREE.Group();
    zone.name = 'FactoryZone_ControlAndBoss';
    this.group.add(zone);

    const ringGeo = this.geo(new THREE.TorusGeometry(this.bossArenaRadius, 0.07, 4, 72));
    const ring = new THREE.Mesh(ringGeo, mats.hazard());
    ring.position.copy(this.objectivePoints.bossArena);
    ring.position.y = 0.055;
    ring.rotation.x = Math.PI / 2;
    ring.receiveShadow = true;
    zone.add(ring);

    const consoleBody = this.mesh(chamferBox(4.8, 1.25, 1.05, 0.08, 2), mats.steelPainted(), 39.2, 0.625, 57.8);
    zone.add(consoleBody);
    const consoleScreen = this.mesh(chamferBox(3.6, 0.42, 0.04, 0.015, 1), this.lockedMat, 39.2, 1.2, 57.23);
    zone.add(consoleScreen);

    const cableGeo = this.geo(new THREE.TorusGeometry(0.7, 0.065, 5, 18, Math.PI));
    for (let i = 0; i < 4; i++) {
      const cable = new THREE.Mesh(cableGeo, mats.rubber());
      cable.position.set(37.9 + i * 0.85, 0.24, 58.6);
      cable.rotation.x = Math.PI / 2;
      zone.add(cable);
    }

    const bollardGeo = this.geo(chamferBox(0.18, 1.0, 0.18, 0.02, 1));
    const bollards = new THREE.InstancedMesh(bollardGeo, mats.hazard(), 8);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      bollards.setMatrixAt(i, compose(31 + Math.cos(angle) * 10.6, 0.5, 50.5 + Math.sin(angle) * 10.6));
    }
    bollards.instanceMatrix.needsUpdate = true;
    zone.add(bollards);
  }

  private buildHostageBay(mats: MaterialLibrary): void {
    const bay = new THREE.Group();
    bay.name = 'ProtectedSubjectIsolation';
    this.group.add(bay);

    const pad = this.mesh(chamferBox(6.7, 0.18, 6.2, 0.035, 1), mats.concrete(), 16.5, 0.09, 52);
    bay.add(pad);
    const glass = mats.glass();
    for (const [w, h, d, x, z] of [
      [6.5, 2.7, 0.09, 16.5, 48.95],
      [6.5, 2.7, 0.09, 16.5, 55.05],
      [0.09, 2.7, 6.1, 13.25, 52],
      [0.09, 2.7, 1.9, 19.8, 49.9],
      [0.09, 2.7, 1.9, 19.8, 54.1],
    ] as const) {
      bay.add(this.mesh(chamferBox(w, h, d, 0.015, 1), glass, x, 1.35, z, false));
    }

    this.hostageDoor.name = 'ProtectedSubjectDoor';
    this.hostageDoor.position.set(19.83, 1.325, 52);
    this.hostageDoor.add(this.mesh(chamferBox(0.11, 2.65, 2.0, 0.02, 1), glass, 0, 0, 0, false));
    bay.add(this.hostageDoor);

    const frameGeo = this.geo(chamferBox(0.12, 2.95, 0.12, 0.018, 1));
    const frames = new THREE.InstancedMesh(frameGeo, mats.steelBare(), 8);
    const corners = [
      [13.25, 48.95], [19.8, 48.95], [13.25, 55.05], [19.8, 55.05],
      [13.25, 50.9], [13.25, 53.1], [19.8, 50.9], [19.8, 53.1],
    ];
    corners.forEach(([x, z], index) => frames.setMatrixAt(index, compose(x, 1.475, z)));
    frames.instanceMatrix.needsUpdate = true;
    frames.castShadow = true;
    bay.add(frames);

    const terminal = new THREE.Group();
    terminal.name = 'HostageReleaseTerminal';
    terminal.position.copy(this.objectivePoints.releaseTerminal);
    terminal.add(this.mesh(chamferBox(0.58, 1.35, 0.38, 0.04, 1), mats.steelPainted(), 0, 0, 0));
    this.releaseScreen = this.mesh(chamferBox(0.4, 0.26, 0.035, 0.01, 1), this.lockedMat, 0, 0.2, -0.21);
    terminal.add(this.releaseScreen);
    terminal.rotation.y = -Math.PI / 2;
    bay.add(terminal);

    const lifeSupport = this.mesh(chamferBox(1.8, 1.3, 0.55, 0.05, 1), mats.plasticWhite(), 14.4, 0.72, 54.2);
    bay.add(lifeSupport);
    const vitalsGeo = this.geo(chamferBox(0.42, 0.24, 0.035, 0.008, 1));
    const vitals = new THREE.InstancedMesh(vitalsGeo, this.completeMat, 3);
    for (let i = 0; i < 3; i++) vitals.setMatrixAt(i, compose(13.47, 0.8 + i * 0.34, 54.05));
    vitals.instanceMatrix.needsUpdate = true;
    bay.add(vitals);

    const roleMats = [mats.steelPainted(), mats.plasticWhite(), mats.hazard()];
    const positions = [[15.2, 51.1], [17.0, 51.8], [15.7, 53.2]] as const;
    for (let i = 0; i < 3; i++) {
      const person = this.buildHostage(mats, roleMats[i], i);
      person.position.set(positions[i][0], 0.02, positions[i][1]);
      person.rotation.y = 0.15 + i * 0.45;
      this.hostageRoots.push(person);
      bay.add(person);
    }
  }

  /** Emissive fixtures add colour-temperature wayfinding without real lights. */
  private buildCeilingSignals(mats: MaterialLibrary): void {
    const fixtureGeo = this.geo(chamferBox(2.8, 0.09, 0.18, 0.018, 1));
    const cold = new THREE.InstancedMesh(
      fixtureGeo,
      mats.emissive('factoryWorkCold', 0xa9d8ff, 1.8),
      5,
    );
    const coldPositions = [[24, 19], [38, 20], [20, 31], [34, 35], [38, 53]];
    coldPositions.forEach(([x, z], index) => cold.setMatrixAt(index, compose(x, 10.9, z)));
    cold.instanceMatrix.needsUpdate = true;
    this.group.add(cold);

    const red = new THREE.InstancedMesh(
      fixtureGeo,
      mats.emissive('factoryEmergencyRed', 0xff3b2f, 2.2),
      4,
    );
    const redPositions = [[17, 42], [29, 42], [41, 42], [29, 59]];
    redPositions.forEach(([x, z], index) => red.setMatrixAt(index, compose(x, 10.9, z)));
    red.instanceMatrix.needsUpdate = true;
    this.group.add(red);
  }

  private buildHostage(mats: MaterialLibrary, clothing: THREE.Material, role: number): THREE.Group {
    const person = new THREE.Group();
    person.name = ['FactorySupervisor', 'RoboticsEngineer', 'LineWorker'][role];
    const heightScale = [1.03, 0.94, 0.99][role];
    const torso = this.mesh(chamferBox(0.46, 0.74, 0.26, 0.07, 2), clothing, 0, 1.08 * heightScale, 0);
    const head = this.mesh(new THREE.SphereGeometry(0.16, 8, 6), mats.plasticWhite(), 0, 1.59 * heightScale, 0);
    const legs = this.mesh(chamferBox(0.36, 0.72, 0.22, 0.05, 2), mats.soldierGear(), 0, 0.43 * heightScale, 0);
    person.add(torso, head, legs);
    if (role !== 1) {
      const helmet = this.mesh(new THREE.SphereGeometry(0.18, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), role === 0 ? mats.plasticWhite() : mats.hazard(), 0, 1.65 * heightScale, 0);
      person.add(helmet);
    }
    return person;
  }

  private addEquipmentCollision(collision: CollisionWorld): void {
    collision.addBox(new THREE.Vector3(22.8, 0, 26.55), new THREE.Vector3(35.2, 0.98, 29.05), 'metal', true);
    collision.addBox(new THREE.Vector3(22.9, 0, 32.55), new THREE.Vector3(24.1, 4.3, 33.65), 'metal', true);
    collision.addBox(new THREE.Vector3(36.8, 0, 33.75), new THREE.Vector3(37.6, 3.5, 34.65), 'metal', true);
    collision.addBox(new THREE.Vector3(13.15, 0, 48.85), new THREE.Vector3(19.9, 2.8, 49.05), 'glass', true);
    collision.addBox(new THREE.Vector3(13.15, 0, 54.95), new THREE.Vector3(19.9, 2.8, 55.15), 'glass', true);
    collision.addBox(new THREE.Vector3(13.15, 0, 48.85), new THREE.Vector3(13.35, 2.8, 55.15), 'glass', true);
    collision.addBox(new THREE.Vector3(19.7, 0, 48.85), new THREE.Vector3(19.9, 2.8, 50.95), 'glass', true);
    collision.addBox(new THREE.Vector3(19.7, 0, 53.05), new THREE.Vector3(19.9, 2.8, 55.15), 'glass', true);
  }

  private gateInteractionStatus(): FactoryInteractionStatus {
    if (this.gateProgress >= 0.999) return 'complete';
    if (this.gateTarget > 0) return 'busy';
    return this.accessModuleAcquired ? 'ready' : 'locked';
  }

  private releaseInteractionStatus(): FactoryInteractionStatus {
    if (this.released) return 'complete';
    return this.bossDefeated ? 'ready' : 'locked';
  }

  private refreshTerminalMaterials(): void {
    if (this.gateScreen) {
      const status = this.gateInteractionStatus();
      this.gateScreen.material = status === 'locked' ? this.lockedMat : status === 'complete' ? this.completeMat : this.readyMat;
    }
    if (this.releaseScreen) {
      const status = this.releaseInteractionStatus();
      this.releaseScreen.material = status === 'locked' ? this.lockedMat : status === 'complete' ? this.completeMat : this.readyMat;
    }
  }

  private mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    castShadow = true,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo(geometry), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }

  private geo<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }
}

function compose(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion(),
    new THREE.Vector3(1, 1, 1),
  );
}

function moveToward(current: number, target: number, amount: number): number {
  if (current < target) return Math.min(target, current + amount);
  return Math.max(target, current - amount);
}

function easeInOut(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
