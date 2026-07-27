import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { Rng, LEVEL_SEED } from '@/core/Rng';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import { applyWind, setWindWeights } from '@/materials/WindMaterial';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';
import type { CollisionWorld } from '@/physics/CollisionWorld';
import { catenaryPoints, chamferBox, corrugatedPanel, iBeam, trs, tubeAlong } from './GeometryKit';
import { LevelBuilder } from './LevelBuilder';
import { Practicals } from './Practicals';
import { PropKit, type Piece } from './Props';
import { WetGround } from './WetGround';
import { DistantScenery } from './DistantScenery';

/**
 * "BERTH 7" - the playable harbour.
 *
 * LAYOUT AND FLOW (all measurements in metres, player walks toward +X):
 *
 *      +Z (north, inland)
 *       |   [ WAREHOUSE  z 10..26 ]        [ CONTROL TOWER ]
 *       |        catwalk over x=36
 *   ----+----------------------------------------------------->  +X
 *       |  A:BAY      B:CONTAINER CANYON    C:YARD    D:PIER HEAD
 *       |  x -6..8      x 8..30             x 30..46   x 46..58
 *       |   [ QUAY EDGE / SEA  z < -13 ]
 *      -Z (south, seaward)
 *
 * Composition intent:
 *  - The player starts under a dark canopy: a framed, high-contrast opening
 *    shot with the lit yard and the extraction strobe visible at the far end.
 *    Foreground silhouette + midground light + background sky = depth on the
 *    very first frame.
 *  - The sun sits low to the EAST, i.e. straight down the player's path, so
 *    every container is rim-lit and back-lit through the haze. The player
 *    always sees shadowed faces with bright edges - the cheapest source of
 *    perceived material quality.
 *  - The canyon is deliberately NOT a straight corridor. A cross-stacked
 *    container at x=19 forces a jog, and side alleys open north and south so
 *    new information enters the frame every few seconds.
 *  - Verticality: containers 1-2 high, a catwalk at y=5.2, a crane leg at
 *    y=22, a warehouse at y=11. The eye is pulled up three times on the route.
 */
export interface EnemySpawn {
  position: THREE.Vector3;
  /** Second point the enemy strafes toward; defines its firing lane. */
  patrolTo: THREE.Vector3;
  /** Enemies further along the route wake up later. */
  activationX: number;
  elevated: boolean;
}

export class HarborLevel {
  readonly root = new THREE.Group();
  readonly practicals: Practicals;
  readonly wetGround: WetGround;
  readonly distant: DistantScenery;

  readonly playerSpawn = new THREE.Vector3(-1.5, 0, 0.5);
  /** forward = (-sin(yaw), 0, -cos(yaw)); -PI/2 looks down +X, toward the pier. */
  readonly playerSpawnYaw = -Math.PI / 2;
  readonly extractionPoint = new THREE.Vector3(53, 0, -2);
  readonly enemySpawns: EnemySpawn[] = [];
  readonly explosivePositions: THREE.Vector3[] = [];

  private kit: PropKit;
  private builder: LevelBuilder;
  private rng = new Rng(LEVEL_SEED);
  private windMeshes: THREE.Mesh[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  stats = { meshes: 0, triangles: 0 };

  constructor(
    private readonly mats: MaterialLibrary,
    visual: MutableVisual,
    quality: QualitySettings,
    private readonly collision: CollisionWorld,
  ) {
    this.root.name = 'Harbor';
    this.kit = new PropKit(mats);
    this.builder = new LevelBuilder(this.root);
    this.practicals = new Practicals(mats, visual, quality);
    this.root.add(this.practicals.group);

    this.wetGround = new WetGround(mats, visual, quality, 0, 240);
    this.root.add(this.wetGround.mesh);
    this.wetGround.registerCollision(collision);

    this.distant = new DistantScenery(mats, visual, quality);
    this.root.add(this.distant.group);
    this.wetGround.excludeFromReflection(this.distant.rainGroup);

    this.buildBay();
    this.buildCanyon();
    this.buildYard();
    this.buildWarehouse();
    this.buildQuay();
    this.buildPierHead();
    this.buildOverheadCables();
    this.placeEnemies();

    this.stats = this.builder.build(collision);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /** Places a prop's pieces at a world transform. */
  private prop(
    zone: string,
    pieces: Piece[],
    world: THREE.Matrix4,
    collideBox?: { size: THREE.Vector3; offset?: THREE.Vector3; surface?: 'metal' | 'concrete' | 'thinMetal' },
  ): void {
    for (const piece of pieces) {
      this.builder.place(zone, piece.mat, piece.geo, world.clone().multiply(piece.local), piece.opts);
    }
    if (collideBox) {
      const center = new THREE.Vector3().setFromMatrixPosition(world).add(collideBox.offset ?? zeroVec);
      const half = collideBox.size.clone().multiplyScalar(0.5);
      // Respect the prop's Y rotation when it is a quarter turn.
      const rot = new THREE.Euler().setFromRotationMatrix(world);
      if (Math.abs(Math.abs(rot.y) - Math.PI / 2) < 0.3) {
        const t = half.x;
        half.x = half.z;
        half.z = t;
      }
      this.collision.addBox(
        new THREE.Vector3(center.x - half.x, center.y - half.y, center.z - half.z),
        new THREE.Vector3(center.x + half.x, center.y + half.y, center.z + half.z),
        collideBox.surface ?? 'metal',
        true,
      );
    }
  }

  /** Concrete slab / wall helper with world-scale UVs already applied. */
  private slab(
    zone: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material = this.mats.concreteWall(),
    collide = true,
  ): void {
    const geo = chamferBox(w, h, d, 0.03, 1);
    this.disposables.push(geo);
    this.builder.place(zone, material, geo, trs(x, y, z), { collide });
  }

  /**
   * Scatters small rubble at the base of a large object.
   * Objects that meet the ground in a perfectly clean line look pasted on;
   * a handful of chips and a puddle of grit anchors them.
   */
  private scatterDebris(zone: string, x: number, z: number, radius: number, count: number, seed: number): void {
    const rng = this.rng.fork(seed);
    const mat = this.mats.concrete();
    for (let i = 0; i < count; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const r = radius * Math.sqrt(rng.next());
      const s = rng.range(0.05, 0.19);
      const geo = chamferBox(s, s * rng.range(0.3, 0.7), s * rng.range(0.6, 1.4), s * 0.15, 1);
      this.disposables.push(geo);
      this.builder.place(
        zone,
        mat,
        geo,
        trs(x + Math.cos(angle) * r, s * 0.15, z + Math.sin(angle) * r, rng.spread(0.3), rng.range(0, 6.28), rng.spread(0.3)),
        { collide: false, castShadow: true },
      );
    }
  }

  // ------------------------------------------------------------------
  // A. Loading bay - the opening shot
  // ------------------------------------------------------------------

  private buildBay(): void {
    const zone = 'bay';
    const steel = this.mats.steelPainted();

    // Back wall with a closed roller door: closes the composition behind the
    // player so the first frame reads as an interior looking out.
    this.slab(zone, 0.5, 6.4, 17, -6.4, 3.2, 0);
    const doorGeo = corrugatedPanel(5.2, 4.4, 26, 0.03);
    this.disposables.push(doorGeo);
    this.builder.place(zone, this.mats.cladding('Rust'), doorGeo, trs(-6.1, 2.3, 0, 0, Math.PI / 2, 0));
    // Door guide rails and a lintel beam.
    for (const z of [-2.75, 2.75]) {
      const rail = chamferBox(0.14, 4.8, 0.16, 0.02, 1);
      this.disposables.push(rail);
      this.builder.place(zone, steel, rail, trs(-6.05, 2.4, z));
    }
    const lintel = iBeam(6.2, 0.34, 0.18, 0.022);
    this.disposables.push(lintel);
    this.builder.place(zone, steel, lintel, trs(-6.0, 4.85, 0));

    // Side walls, kept short so light rakes in from the sides.
    this.slab(zone, 14, 5.4, 0.45, -0.5, 2.7, 8.2);
    this.slab(zone, 9, 5.4, 0.45, -2.5, 2.7, -8.2);

    // Canopy: the dark frame at the top of the opening shot.
    const canopyBeam = iBeam(17.4, 0.42, 0.2, 0.026);
    this.disposables.push(canopyBeam);
    for (const x of [-5.6, -0.6, 4.4]) {
      this.builder.place(zone, steel, canopyBeam, trs(x, 5.3, 0, 0, Math.PI / 2, 0));
    }
    const purlin = iBeam(11, 0.26, 0.13, 0.018);
    this.disposables.push(purlin);
    for (const z of [-7.4, -3.7, 0, 3.7, 7.4]) {
      this.builder.place(zone, steel, purlin, trs(-0.6, 5.62, z));
    }
    const roofGeo = corrugatedPanel(11.2, 17.2, 34, 0.04);
    this.disposables.push(roofGeo);
    this.builder.place(zone, this.mats.cladding('Pale'), roofGeo, trs(-0.6, 5.86, 0, -Math.PI / 2, 0, Math.PI / 2));

    // Support columns, with a hazard-striped kick guard at the base.
    for (const x of [-5.6, 4.4]) {
      for (const z of [-7.4, 7.4]) {
        const col = chamferBox(0.34, 5.3, 0.34, 0.03, 1);
        this.disposables.push(col);
        this.builder.place(zone, steel, col, trs(x, 2.65, z), { collide: true });
        const guard = chamferBox(0.44, 0.55, 0.44, 0.02, 1);
        this.disposables.push(guard);
        this.builder.place(zone, this.mats.hazard(), guard, trs(x, 0.28, z));
        this.scatterDebris(zone, x, z, 0.9, 4, x * 31 + z);
      }
    }

    // Lighting: two failing strip lights under the canopy plus a hanging lamp.
    this.practicals.addStripLight(new THREE.Vector3(-3.4, 5.05, 3.2), Math.PI / 2, 2.4);
    this.practicals.addStripLight(new THREE.Vector3(2.2, 5.05, -3.6), Math.PI / 2, 2.4);
    this.practicals.addHangingLamp(new THREE.Vector3(-2.2, 5.2, -0.6), 0.85);
    this.practicals.addHangingLamp(new THREE.Vector3(3.1, 5.2, 4.4), 1.15);

    // Clutter: pallets, drums, a cabinet and a tarp that moves in the draught.
    this.prop(zone, this.kit.pallet(), trs(-4.2, 0, -5.6, 0, 0.4, 0));
    this.prop(zone, this.kit.pallet(), trs(-4.15, 0.145, -5.55, 0, 0.7, 0));
    this.prop(zone, this.kit.pallet(), trs(-3.1, 0, 5.9, 0, -0.2, 0));
    this.prop(zone, this.kit.drum(true), trs(-5.2, 0, 6.6), { size: new THREE.Vector3(0.6, 0.88, 0.6) });
    this.prop(zone, this.kit.drum(false), trs(-5.3, 0, 5.85), { size: new THREE.Vector3(0.6, 0.88, 0.6) });
    this.prop(zone, this.kit.cabinet(), trs(-6.0, 1.35, -4.2, 0, Math.PI / 2, 0));
    this.prop(zone, this.kit.cone(), trs(1.8, 0, -2.4));
    this.prop(zone, this.kit.cone(), trs(2.6, 0, 3.1, 0, 0.6, 0));
    this.prop(zone, this.kit.cableSpool(), trs(-4.8, 0, 2.2, 0, 0.5, 0), {
      size: new THREE.Vector3(1.6, 1.56, 1),
      offset: new THREE.Vector3(0, 0.78, 0),
    });

    this.addTarp(new THREE.Vector3(-4.2, 1.05, -5.6), 1.5, 1.2, 0.35);

    // Painted floor markings: a hazard-striped kerb at the bay mouth.
    const kerb = chamferBox(0.5, 0.12, 16, 0.02, 1);
    this.disposables.push(kerb);
    this.builder.place(zone, this.mats.hazard(), kerb, trs(7.6, 0.06, 0), { collide: false });
  }

  // ------------------------------------------------------------------
  // B. Container canyon
  // ------------------------------------------------------------------

  private buildCanyon(): void {
    const zone = 'canyon';
    const variants = ['Red', 'Blue', 'Green', 'Rust'] as const;
    const halfBox = (long: boolean): THREE.Vector3 =>
      new THREE.Vector3(long ? 12.19 : 6.06, 2.59, 2.44);

    /** Places a container and its collision box + ground grime. */
    const place = (x: number, y: number, z: number, yaw: number, long: boolean, seed: number): void => {
      const variant = variants[Math.abs(seed) % variants.length];
      this.prop(zone, this.kit.container(long, variant, seed), trs(x, y + 1.295, z, 0, yaw, 0), {
        size: halfBox(long),
        offset: new THREE.Vector3(0, 1.295, 0),
        surface: 'thinMetal',
      });
      if (y < 0.1) this.scatterDebris(zone, x, z, long ? 6 : 3.2, 6, seed);
    };

    // --- south stack (seaward side) ---
    place(12.5, 0, -6.1, 0, true, 101);
    place(12.9, 2.59, -6.3, 0, true, 102);
    place(25.5, 0, -6.4, 0.02, true, 103);
    place(21.0, 0, -9.6, 0, false, 104);
    place(21.1, 2.59, -9.5, 0.03, false, 105);

    // --- north stack (inland side) ---
    place(11.0, 0, 5.9, 0, false, 106);
    place(17.6, 0, 6.1, 0, false, 107);
    place(14.3, 2.59, 6.0, 0.015, true, 108);
    place(26.0, 0, 6.6, -0.02, true, 109);
    place(26.4, 2.59, 6.4, 0, false, 110);

    // --- the jog: a container across the lane, offset so a gap remains ---
    place(19.4, 0, 1.2, Math.PI / 2, false, 111);
    place(19.3, 2.59, 1.4, Math.PI / 2, false, 112);
    // Its leaning neighbour, tipped a few degrees: instant "this is a place,
    // not a grid" signal.
    this.prop(zone, this.kit.container(false, 'Rust', 113), trs(19.5, 1.34, -2.2, 0.06, Math.PI / 2 + 0.05, 0.11), {
      size: new THREE.Vector3(2.6, 2.59, 6.2),
      offset: new THREE.Vector3(0, 1.295, 0),
      surface: 'thinMetal',
    });

    // Ground clutter through the canyon: cover the player can actually use.
    this.prop(zone, this.kit.jerseyBarrier(), trs(15.4, 0, -1.6, 0, 0.18, 0), {
      size: new THREE.Vector3(0.62, 0.72, 1.9),
      offset: new THREE.Vector3(0, 0.36, 0),
      surface: 'concrete',
    });
    this.prop(zone, this.kit.jerseyBarrier(), trs(15.3, 0, 0.4, 0, 0.14, 0), {
      size: new THREE.Vector3(0.62, 0.72, 1.9),
      offset: new THREE.Vector3(0, 0.36, 0),
      surface: 'concrete',
    });
    this.prop(zone, this.kit.jerseyBarrier(), trs(23.6, 0, 2.6, 0, Math.PI / 2 + 0.1, 0), {
      size: new THREE.Vector3(1.9, 0.72, 0.62),
      offset: new THREE.Vector3(0, 0.36, 0),
      surface: 'concrete',
    });
    this.prop(zone, this.kit.pallet(), trs(22.4, 0, -3.4, 0, 0.9, 0));
    this.prop(zone, this.kit.drum(true), trs(23.2, 0, -3.9), { size: new THREE.Vector3(0.6, 0.88, 0.6) });
    this.prop(zone, this.kit.cone(), trs(10.2, 0, 1.4));
    this.prop(zone, this.kit.cone(), trs(16.9, 0, 2.9, 0, 0.4, 0));
    this.prop(zone, this.kit.ladder(4.9), trs(24.6, 0, 5.2, 0, Math.PI, 0));

    // Explosive drums, clustered where a chain reaction is legible.
    this.explosivePositions.push(new THREE.Vector3(18.2, 0, -4.6), new THREE.Vector3(18.9, 0, -5.0));

    // Lighting: a mast at the mouth, a beacon on the cross container, and a
    // failing lamp deep in the canyon to break the darkness.
    this.addFloodMast(new THREE.Vector3(9.6, 0, 9.4), 6.4, new THREE.Vector3(16, 0.4, 0), 0);
    this.addFloodMast(new THREE.Vector3(28.6, 0, -10.4), 5.8, new THREE.Vector3(23, 0.4, -2), 0.55);
    this.practicals.addBeacon(new THREE.Vector3(19.4, 2.72, 1.2));
    this.practicals.addHangingLamp(new THREE.Vector3(21.0, 5.4, -8.2), 0.7, 0xffc98a);

    // A cable draped between the stacks, catching the rim light.
    this.addCable(new THREE.Vector3(12.9, 5.3, -5.2), new THREE.Vector3(14.3, 5.3, 4.9), 1.1, 0.028);
    this.addCable(new THREE.Vector3(26.0, 5.3, 5.4), new THREE.Vector3(25.5, 2.7, -5.2), 0.9, 0.022);
  }

  // ------------------------------------------------------------------
  // C. Open yard with the overhead catwalk
  // ------------------------------------------------------------------

  private buildYard(): void {
    const zone = 'yard';
    const steel = this.mats.steelPainted();

    // Catwalk columns + span crossing the player's path at head height + 3m.
    const columnGeo = chamferBox(0.42, 5.2, 0.42, 0.035, 1);
    this.disposables.push(columnGeo);
    for (const z of [-8.4, -2.6, 3.2, 9]) {
      this.builder.place(zone, steel, columnGeo, trs(36.2, 2.6, z), { collide: true });
      // Gusset plates where the column meets the walkway.
      const gusset = chamferBox(0.7, 0.5, 0.06, 0.012, 1);
      this.disposables.push(gusset);
      this.builder.place(zone, steel, gusset, trs(36.2, 4.95, z + 0.24));
    }
    this.prop(zone, this.kit.catwalk(19.4, 1.6), trs(36.2, 5.22, 0.3, 0, Math.PI / 2, 0));
    // Collision for the walkway deck so an enemy can stand on it.
    this.collision.addBox(
      new THREE.Vector3(35.4, 5.15, -9.4),
      new THREE.Vector3(37.0, 5.24, 10.0),
      'metal',
      true,
    );
    // Stair access from the yard up to the catwalk.
    this.prop(zone, this.kit.stairs(14, 0.2, 0.29, 1.15), trs(32.0, 2.42, 9.4, 0, 0, 0));
    this.prop(zone, this.kit.catwalk(4.4, 1.3), trs(34.4, 5.22, 9.4, 0, 0, 0));
    this.collision.addBox(
      new THREE.Vector3(32.0, 2.3, 8.7),
      new THREE.Vector3(36.6, 5.24, 10.1),
      'metal',
      true,
    );

    // Fuel dump: the set-piece explosion. Drums against a low concrete kerb.
    for (const [dx, dz] of [
      [0, 0],
      [0.68, 0.12],
      [0.34, 0.66],
      [1.3, 0.44],
    ] as const) {
      this.explosivePositions.push(new THREE.Vector3(32.6 + dx, 0, -5.4 + dz));
    }
    this.slab(zone, 3.4, 0.42, 0.3, 33.2, 0.21, -6.6, this.mats.concreteWall());
    this.scatterDebris(zone, 33, -5.6, 2.6, 8, 77);

    // Sandbag firing position - readable cover that says "someone fought here".
    this.prop(zone, this.kit.sandbagWall(3.4, 4, 909), trs(39.4, 0, 2.6, 0, 0.12, 0), {
      size: new THREE.Vector3(3.5, 1.0, 0.8),
      offset: new THREE.Vector3(0, 0.5, 0),
      surface: 'concrete',
    });
    this.prop(zone, this.kit.sandbagWall(2.2, 3, 910), trs(41.6, 0, 0.6, 0, Math.PI / 2 - 0.1, 0), {
      size: new THREE.Vector3(0.8, 0.78, 2.3),
      offset: new THREE.Vector3(0, 0.39, 0),
      surface: 'concrete',
    });

    // Assorted yard clutter, deliberately not symmetric.
    this.prop(zone, this.kit.cableSpool(), trs(43.4, 0, -6.2, 0, 0.9, 0), {
      size: new THREE.Vector3(1.6, 1.56, 1),
      offset: new THREE.Vector3(0, 0.78, 0),
    });
    this.prop(zone, this.kit.cableSpool(), trs(44.6, 0, -5.4, 0, 0.2, 0), {
      size: new THREE.Vector3(1.6, 1.56, 1),
      offset: new THREE.Vector3(0, 0.78, 0),
    });
    this.prop(zone, this.kit.pallet(), trs(38.2, 0, -8.4, 0, 0.3, 0));
    this.prop(zone, this.kit.pallet(), trs(38.3, 0.145, -8.3, 0, 1.1, 0));
    this.prop(zone, this.kit.drum(false), trs(41.9, 0, -8.9), { size: new THREE.Vector3(0.6, 0.88, 0.6) });
    this.prop(zone, this.kit.cone(), trs(30.6, 0, 1.2));
    this.prop(zone, this.kit.cone(), trs(34.8, 0, -2.6, 0, 0.7, 0));
    this.prop(zone, this.kit.jerseyBarrier(), trs(43.0, 0, 3.4, 0, Math.PI / 2, 0), {
      size: new THREE.Vector3(1.9, 0.72, 0.62),
      offset: new THREE.Vector3(0, 0.36, 0),
      surface: 'concrete',
    });
    this.addTarp(new THREE.Vector3(38.25, 0.32, -8.4), 1.4, 1.3, 0.4);

    // Gantry crane leg: the vertical landmark that pulls the eye up and gives
    // the yard its sense of scale.
    this.buildCraneLeg(zone, 30.5, -12.5);
    this.buildCraneLeg(zone, 45.5, -12.5);
    const craneBeam = iBeam(17, 1.5, 0.9, 0.09);
    this.disposables.push(craneBeam);
    this.builder.place(zone, this.mats.steelBare(), craneBeam, trs(38, 21.4, -12.5, 0, Math.PI / 2, 0));
    const craneBeam2 = iBeam(17, 0.9, 0.6, 0.07);
    this.disposables.push(craneBeam2);
    this.builder.place(zone, this.mats.steelBare(), craneBeam2, trs(38, 19.2, -12.5, 0, Math.PI / 2, 0));
    this.practicals.addBeacon(new THREE.Vector3(30.5, 22.2, -12.5), 0xff4a2a);

    // Yard floodlights - the main readable light in the combat space.
    this.addFloodMast(new THREE.Vector3(31.2, 0, 8.6), 7.2, new THREE.Vector3(36, 0.4, -2), 0);
    this.addFloodMast(new THREE.Vector3(44.2, 0, -9.2), 6.6, new THREE.Vector3(39, 0.4, 0), 0.35);
    this.practicals.addFloodlight(
      new THREE.Vector3(36.2, 5.9, -8.4),
      new THREE.Vector3(33, 0, -5.4),
      { intensity: 30, angle: 0.44, instability: 0.7 },
    );

    // Pipes running along the ground beside the catwalk.
    this.prop(
      zone,
      this.kit.pipeRun(
        [
          new THREE.Vector3(29, 0.36, 10.6),
          new THREE.Vector3(36, 0.36, 10.9),
          new THREE.Vector3(44, 0.36, 10.4),
          new THREE.Vector3(48, 0.36, 9.2),
        ],
        [0.14, 0.09],
      ),
      trs(0, 0, 0),
    );
  }

  private buildCraneLeg(zone: string, x: number, z: number): void {
    const steel = this.mats.steelBare();
    const leg = iBeam(21.6, 0.62, 0.4, 0.05);
    this.disposables.push(leg);
    for (const dz of [-1.6, 1.6]) {
      this.builder.place(zone, steel, leg, trs(x, 10.8, z + dz, Math.PI / 2, 0, 0), { collide: true });
    }
    // Lattice bracing - a solid column here would look like a pillar, not a crane.
    const brace = chamferBox(3.6, 0.14, 0.14, 0.02, 1);
    this.disposables.push(brace);
    for (let i = 0; i < 7; i++) {
      const y = 2.2 + i * 2.8;
      this.builder.place(zone, steel, brace, trs(x, y, z, Math.PI / 2 - 0.6 * (i % 2 === 0 ? 1 : -1), 0, 0));
    }
    const foot = chamferBox(1.5, 0.5, 4.4, 0.04, 1);
    this.disposables.push(foot);
    this.builder.place(zone, this.mats.concreteWall(), foot, trs(x, 0.25, z), { collide: true });
    this.scatterDebris(zone, x, z, 2.6, 6, x * 7);
  }

  // ------------------------------------------------------------------
  // D. Warehouse facade (north wall of the whole level)
  // ------------------------------------------------------------------

  private buildWarehouse(): void {
    const zone = 'warehouse';
    const cladPale = this.mats.cladding('Pale');
    const cladRust = this.mats.cladding('Rust');
    const steel = this.mats.steelPainted();
    const x0 = 12;
    const x1 = 46;
    const zFace = 12.5;
    const height = 11.5;

    // Facade built from separate bays so the cladding has visible joints.
    const bayWidth = (x1 - x0) / 8;
    for (let i = 0; i < 8; i++) {
      const cx = x0 + bayWidth * (i + 0.5);
      const panel = corrugatedPanel(bayWidth - 0.12, height, Math.round(bayWidth * 3.4), 0.045);
      this.disposables.push(panel);
      this.builder.place(zone, i % 3 === 1 ? cladRust : cladPale, panel, trs(cx, height / 2, zFace, 0, Math.PI, 0));
      // Vertical joint mullion between bays.
      const mullion = chamferBox(0.16, height, 0.2, 0.02, 1);
      this.disposables.push(mullion);
      this.builder.place(zone, steel, mullion, trs(x0 + bayWidth * i, height / 2, zFace - 0.06));
    }
    // Structural mass behind the cladding (collision + occlusion).
    this.slab(zone, x1 - x0, height, 13, (x0 + x1) / 2, height / 2, zFace + 6.6, this.mats.concreteWall());
    // Parapet and roof edge.
    const parapet = chamferBox(x1 - x0, 0.9, 0.5, 0.03, 1);
    this.disposables.push(parapet);
    this.builder.place(zone, this.mats.concreteWall(), parapet, trs((x0 + x1) / 2, height + 0.45, zFace - 0.1));

    // Roof silhouette: vents and a stair head, so the roofline is not a
    // straight razor cut against the sky.
    this.prop(zone, this.kit.ventUnit(2.2, 1.6, 1.1), trs(19, height + 0.9, 15.5, 0, 0.2, 0));
    this.prop(zone, this.kit.ventUnit(1.4, 1.4, 0.8), trs(28, height + 0.9, 17.2, 0, -0.3, 0));
    this.prop(zone, this.kit.ventUnit(2.6, 1.8, 1.3), trs(38, height + 0.9, 16.0, 0, 0.1, 0));
    this.slab(zone, 3.2, 2.6, 3, 43.5, height + 1.3, 16.5, this.mats.concreteWall(), false);

    // Roller door, open, spilling warm light into the yard: the strongest
    // "somewhere to look" cue on the north side.
    const doorW = 5.4;
    const doorH = 5.2;
    const doorX = 33.4;
    this.slab(zone, doorW + 1.0, 0.7, 0.6, doorX, doorH + 0.35, zFace - 0.05, this.mats.concreteWall(), false);
    const shutter = corrugatedPanel(doorW, 1.1, 18, 0.03);
    this.disposables.push(shutter);
    this.builder.place(zone, cladRust, shutter, trs(doorX, doorH - 0.55, zFace - 0.12, 0, Math.PI, 0));
    for (const sx of [-1, 1]) {
      const jamb = chamferBox(0.22, doorH, 0.4, 0.02, 1);
      this.disposables.push(jamb);
      this.builder.place(zone, steel, jamb, trs(doorX + (sx * (doorW + 0.24)) / 2, doorH / 2, zFace - 0.1), {
        collide: true,
      });
    }
    // Interior box behind the door so the opening is not a black void.
    this.slab(zone, doorW + 3, 6.4, 0.4, doorX, 3.2, zFace + 7.4, this.mats.concreteWall(), false);
    this.practicals.addStripLight(new THREE.Vector3(doorX - 1.2, 4.6, zFace + 3.2), 0, 3);
    this.practicals.addStripLight(new THREE.Vector3(doorX + 1.4, 4.6, zFace + 5.6), 0, 3);
    this.practicals.addHangingLamp(new THREE.Vector3(doorX, 5.0, zFace + 1.6), 0.9, 0xffcf9a);
    this.prop(zone, this.kit.drum(true), trs(doorX - 1.9, 0, zFace + 1.2), {
      size: new THREE.Vector3(0.6, 0.88, 0.6),
    });
    this.prop(zone, this.kit.pallet(), trs(doorX + 1.6, 0, zFace + 2.4, 0, 0.5, 0));

    // Windows: a strip of lit glazing high on the wall gives the facade rhythm.
    const glass = this.mats.glass();
    const glow = this.mats.emissive('windowGlow', 0xffb469, 1.6);
    for (let i = 0; i < 9; i++) {
      const wx = x0 + 2.4 + i * 3.7;
      const pane = chamferBox(2.2, 1.5, 0.08, 0.01, 1);
      this.disposables.push(pane);
      const lit = i % 3 !== 2;
      this.builder.place(zone, lit ? glow : glass, pane, trs(wx, 8.4, zFace - 0.16), { castShadow: false });
      const frame = chamferBox(2.5, 1.8, 0.12, 0.02, 1);
      this.disposables.push(frame);
      this.builder.place(zone, steel, frame, trs(wx, 8.4, zFace - 0.1), { castShadow: false });
    }

    // Facade pipework and conduit - the detail that removes the "flat wall" read.
    this.prop(
      zone,
      this.kit.pipeRun(
        [
          new THREE.Vector3(13, 3.4, zFace - 0.45),
          new THREE.Vector3(24, 3.5, zFace - 0.5),
          new THREE.Vector3(31, 3.4, zFace - 0.45),
          new THREE.Vector3(45, 3.6, zFace - 0.5),
        ],
        [0.11, 0.07, 0.05],
      ),
      trs(0, 0, 0),
    );
    for (const bx of [15, 22, 29, 41]) {
      const bracket = chamferBox(0.1, 0.1, 0.5, 0.012, 1);
      this.disposables.push(bracket);
      this.builder.place(zone, steel, bracket, trs(bx, 3.45, zFace - 0.28));
    }
    this.prop(zone, this.kit.ladder(11.2), trs(16.4, 0, zFace - 0.5, 0, Math.PI, 0));
    this.prop(zone, this.kit.cabinet(), trs(26.5, 1.5, zFace - 0.24, 0, Math.PI, 0));

    // Facade floodlights aimed down into the yard - the motivation for the
    // pools of light the player fights in.
    for (const [lx, tx] of [
      [20, 18],
      [29, 30],
      [41, 42],
    ] as const) {
      const wl = this.kit.wallLight();
      this.prop(zone, wl.pieces, trs(lx, 7.2, zFace - 0.35, 0, Math.PI, 0));
      this.practicals.addFloodlight(
        new THREE.Vector3(lx, 6.9, zFace - 1.0),
        new THREE.Vector3(tx, 0, 1.5),
        { angle: 0.55, intensity: 42 },
      );
    }
    this.practicals.addBeacon(new THREE.Vector3(x1 - 0.6, height + 1.1, zFace - 0.4), 0xff5030);
  }

  // ------------------------------------------------------------------
  // E. Quay edge and sea
  // ------------------------------------------------------------------

  private buildQuay(): void {
    const zone = 'quay';

    // Quay coping: a raised lip along the whole seaward edge.
    const coping = chamferBox(70, 0.55, 1.2, 0.04, 1);
    this.disposables.push(coping);
    this.builder.place(zone, this.mats.concreteWall(), coping, trs(24, 0.27, -15.2), { collide: true });
    const hazardKerb = chamferBox(70, 0.09, 0.4, 0.02, 1);
    this.disposables.push(hazardKerb);
    this.builder.place(zone, this.mats.hazard(), hazardKerb, trs(24, 0.58, -14.7), { collide: false });

    // The quay wall dropping to the water, with rubber fenders.
    const wall = chamferBox(70, 3.4, 1.6, 0.05, 1);
    this.disposables.push(wall);
    this.builder.place(zone, this.mats.concreteWall(), wall, trs(24, -1.7, -15.9));
    for (let i = 0; i < 9; i++) {
      const fx = -4 + i * 7.2;
      const fender = new THREE.CylinderGeometry(0.3, 0.3, 1.9, 10);
      this.disposables.push(fender);
      this.builder.place(zone, this.mats.gunRubber(), fender, trs(fx, -0.9, -16.6));
    }
    for (let i = 0; i < 8; i++) {
      this.prop(zone, this.kit.bollard(), trs(-2 + i * 7.6, 0.5, -14.4), {
        size: new THREE.Vector3(0.5, 0.8, 0.5),
        offset: new THREE.Vector3(0, 0.9, 0),
      });
    }

    // Perimeter fence along part of the quay: a see-through occluder that adds
    // depth without blocking the sea view.
    this.prop(zone, this.kit.fence(15.6), trs(4, 0.55, -13.4, 0, 0, 0));
    this.prop(zone, this.kit.fence(11.2), trs(48, 0.55, -13.4, 0, 0, 0));

    this.addFloodMast(new THREE.Vector3(16.5, 0.55, -13.9), 6.8, new THREE.Vector3(14, 0.4, -6), 0);
    this.practicals.addBeacon(new THREE.Vector3(40, 1.2, -14.4), 0xff5a2a);
  }

  // ------------------------------------------------------------------
  // F. Pier head - the objective
  // ------------------------------------------------------------------

  private buildPierHead(): void {
    const zone = 'pier';
    const concrete = this.mats.concreteWall();

    // A low blockhouse framing the extraction pad, so the end of the level
    // reads as a destination rather than the edge of the geometry.
    this.slab(zone, 7, 3.6, 6, 57.5, 1.8, 5.5, concrete);
    this.slab(zone, 5, 3.0, 5, 58.5, 1.5, -9.0, concrete);
    this.slab(zone, 0.6, 4.2, 14, 61.0, 2.1, -2.0, concrete);
    this.prop(zone, this.kit.ladder(3.4), trs(55.2, 0, 5.0, 0, Math.PI, 0));
    this.prop(zone, this.kit.ventUnit(1.6, 1.2, 0.8), trs(57.5, 3.6, 5.5, 0, 0.3, 0));

    // The pad itself: a raised, hazard-edged square with a strobe.
    const pad = chamferBox(6.4, 0.22, 6.4, 0.04, 1);
    this.disposables.push(pad);
    this.builder.place(zone, this.mats.concrete(), pad, trs(53, 0.11, -2), { collide: true });
    const edge = chamferBox(6.8, 0.1, 0.36, 0.02, 1);
    this.disposables.push(edge);
    for (const [dz, rot] of [
      [-3.2, 0],
      [3.2, 0],
    ] as const) {
      this.builder.place(zone, this.mats.hazard(), edge, trs(53, 0.24, -2 + dz, 0, rot, 0), { collide: false });
    }
    for (const dx of [-3.2, 3.2]) {
      this.builder.place(zone, this.mats.hazard(), edge, trs(53 + dx, 0.24, -2, 0, Math.PI / 2, 0), {
        collide: false,
      });
    }

    // Green strobe on a short mast: visible from the player's spawn down the
    // whole length of the level. This is the primary wayfinding beacon.
    const mast = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8);
    this.disposables.push(mast);
    this.builder.place(zone, this.mats.steelPainted(), mast, trs(53, 1.6, -5.4));
    this.practicals.addBeacon(new THREE.Vector3(53, 3.3, -5.4), 0x38ff8a);
    this.practicals.addFloodlight(
      new THREE.Vector3(56.8, 4.4, 2.6),
      new THREE.Vector3(53, 0, -2),
      { angle: 0.5, intensity: 40, color: 0xbfe0ff },
    );

    this.prop(zone, this.kit.sandbagWall(3.0, 3, 5150), trs(50.4, 0, 1.6, 0, Math.PI / 2, 0), {
      size: new THREE.Vector3(0.8, 0.78, 3.1),
      offset: new THREE.Vector3(0, 0.39, 0),
      surface: 'concrete',
    });
    this.prop(zone, this.kit.drum(false), trs(55.4, 0, -6.4), { size: new THREE.Vector3(0.6, 0.88, 0.6) });
    this.prop(zone, this.kit.cone(), trs(49.8, 0, -3.2));
    this.scatterDebris(zone, 52, -1, 4, 10, 313);

    // Boundary fence so the player understands where the slice ends.
    this.prop(zone, this.kit.fence(13), trs(59.5, 0, 6.4, 0, Math.PI / 2, 0));
  }

  // ------------------------------------------------------------------
  // Overhead cables and cloth
  // ------------------------------------------------------------------

  private buildOverheadCables(): void {
    // Power lines spanning the whole level: strong leading lines that point at
    // the objective and give the sky something to be measured against.
    this.addCable(new THREE.Vector3(9.6, 6.5, 9.4), new THREE.Vector3(31.2, 7.3, 8.6), 1.6, 0.03);
    this.addCable(new THREE.Vector3(9.6, 6.3, 9.6), new THREE.Vector3(31.2, 7.1, 8.9), 1.9, 0.024);
    this.addCable(new THREE.Vector3(31.2, 7.3, 8.6), new THREE.Vector3(46, 8.4, 12.0), 1.4, 0.03);
    this.addCable(new THREE.Vector3(16.5, 6.9, -13.9), new THREE.Vector3(28.6, 5.9, -10.4), 1.2, 0.026);
    this.addCable(new THREE.Vector3(28.6, 5.9, -10.4), new THREE.Vector3(44.2, 6.7, -9.2), 1.5, 0.026);
  }

  /** A sagging cable that sways in the wind. */
  private addCable(from: THREE.Vector3, to: THREE.Vector3, sag: number, radius: number): void {
    const points = catenaryPoints(from, to, sag, 18);
    const geo = tubeAlong(points, radius, 5);
    // Free in the middle, pinned at both ends.
    setWindWeights(geo, (_x, _y, _z, i) => {
      const t = (i / geo.attributes.position.count) % 1;
      void t;
      return 0;
    });
    // TubeGeometry orders vertices ring-by-ring along the curve; derive the
    // sway weight from the ring index so the midspan moves most.
    const count = geo.attributes.position.count;
    const rings = 18 * 3 + 1;
    const perRing = Math.max(1, Math.round(count / rings));
    const weights = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const ring = Math.floor(i / perRing) / (rings - 1);
      weights[i] = Math.sin(Math.min(1, Math.max(0, ring)) * Math.PI);
    }
    geo.setAttribute('aWind', new THREE.BufferAttribute(weights, 1));

    const mat = this.mats.gunRubber().clone();
    mat.name = 'cable';
    mat.userData = { surface: 'metal' };
    applyWind(mat, 0.09, 0.8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.set(LAYER.WORLD);
    this.root.add(mesh);
    this.windMeshes.push(mesh);
    this.disposables.push(geo, mat);
  }

  /** Loose tarpaulin pinned along one edge - flaps in the wind and in blasts. */
  private addTarp(position: THREE.Vector3, width: number, depth: number, droop: number): void {
    const geo = new THREE.PlaneGeometry(width, depth, 6, 6);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getZ(i) / depth + 0.5);
      pos.setY(i, -droop * t * t);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    setWindWeights(geo, (_x, _y, z) => Math.max(0, z / depth + 0.5));

    const mat = this.mats.tarp().clone();
    mat.name = 'tarpDynamic';
    mat.userData = { surface: 'wood' };
    applyWind(mat, 0.055, 1.6);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.WORLD);
    this.root.add(mesh);
    this.windMeshes.push(mesh);
    this.disposables.push(geo, mat);
  }

  private addFloodMast(base: THREE.Vector3, height: number, aim: THREE.Vector3, instability: number): void {
    const mast = this.kit.floodlightMast(height);
    this.prop('lights', mast.pieces, trs(base.x, base.y, base.z, 0, Math.atan2(aim.x - base.x, aim.z - base.z), 0), {
      size: new THREE.Vector3(0.5, height, 0.5),
      offset: new THREE.Vector3(0, height / 2, 0),
    });
    const dir = new THREE.Vector3(aim.x - base.x, 0, aim.z - base.z).normalize();
    const head = new THREE.Vector3(
      base.x + dir.x * mast.headOffset.z,
      base.y + mast.headOffset.y,
      base.z + dir.z * mast.headOffset.z,
    );
    this.practicals.addFloodlight(head, aim, { instability });
  }

  // ------------------------------------------------------------------
  // Encounter placement
  // ------------------------------------------------------------------

  private placeEnemies(): void {
    const spawn = (
      x: number,
      z: number,
      tx: number,
      tz: number,
      activationX: number,
      y = 0,
      elevated = false,
    ): void => {
      this.enemySpawns.push({
        position: new THREE.Vector3(x, y, z),
        patrolTo: new THREE.Vector3(tx, y, tz),
        activationX,
        elevated,
      });
    };

    // Canyon: contact at medium range, using container cover.
    spawn(17.5, -2.4, 15.0, -3.6, 3);
    spawn(22.5, 3.2, 24.5, 1.4, 7);
    spawn(27.0, -3.0, 25.0, -1.0, 11);

    // Yard: the main firefight, layered near/far and high/low.
    spawn(34.5, 4.8, 32.0, 2.0, 22);
    spawn(37.5, -6.2, 40.0, -4.4, 24);
    spawn(42.0, 5.4, 44.0, 2.6, 26);
    spawn(40.0, -1.0, 37.0, -2.2, 27);
    // Catwalk pair: forces the player to look up mid-fight.
    spawn(36.2, 6.0, 36.2, -4.0, 24, 5.24, true);
    spawn(36.2, -6.5, 36.2, 2.0, 26, 5.24, true);

    // Pier head: the last stand at the objective.
    spawn(50.5, -5.4, 52.0, -3.0, 42);
    spawn(54.5, 2.6, 51.5, 1.4, 44);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  refresh(): void {
    this.wetGround.refresh();
    this.practicals.refresh();
    this.distant.refresh();
  }

  setQuality(quality: QualitySettings): void {
    this.wetGround.setQuality(quality);
    this.practicals.setQuality(quality);
    this.distant.setQuality(quality);
  }

  update(dt: number, elapsed: number, cameraPosition: THREE.Vector3): void {
    this.practicals.update(dt, elapsed);
    this.wetGround.update(elapsed);
    this.distant.update(dt, elapsed, cameraPosition);
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.kit.dispose();
    this.practicals.dispose();
    this.wetGround.dispose();
    this.distant.dispose();
    this.windMeshes.length = 0;
    this.root.removeFromParent();
  }
}

const zeroVec = new THREE.Vector3();
