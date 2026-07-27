import * as THREE from 'three';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import { Rng } from '@/core/Rng';
import { chamferBox, corrugatedPanel, iBeam, squareTube, tubeAlong, trs } from './GeometryKit';
import type { PlaceOptions } from './LevelBuilder';

/**
 * Prop kit for the harbour.
 *
 * Each builder returns a list of {geometry, material, local transform} pieces
 * rather than a Mesh, so the level builder can bake them into merged static
 * batches. Geometries are cached per-kit and shared between every instance of
 * a prop; only the matrices differ.
 *
 * Art direction rules applied throughout:
 *  - every hard-surface piece is a chamferBox (edge highlights),
 *  - props are built from several parts in different materials, because a
 *    single-material object is the clearest "AI made this" tell,
 *  - small asymmetries (a bent bar, a missing panel, an open door) are added
 *    from a seeded RNG so repeated props never read as copies.
 */

export interface Piece {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  local: THREE.Matrix4;
  opts?: PlaceOptions;
}

export class PropKit {
  private cache = new Map<string, THREE.BufferGeometry>();
  readonly disposables: THREE.BufferGeometry[] = [];

  constructor(private readonly mats: MaterialLibrary) {}

  private geo(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.cache.get(key);
    if (!g) {
      g = build();
      this.cache.set(key, g);
      this.disposables.push(g);
    }
    return g;
  }

  // ------------------------------------------------------------------
  // Shipping containers - the signature silhouette of the whole level
  // ------------------------------------------------------------------

  /** ISO container. `long` = 40ft (12.19m), otherwise 20ft (6.06m). */
  container(long: boolean, variant: 'Red' | 'Blue' | 'Green' | 'Rust', seed: number): Piece[] {
    const L = long ? 12.19 : 6.06;
    const H = 2.59;
    const D = 2.44;
    const rng = new Rng(seed);
    const skin = this.mats.container(variant);
    const steel = this.mats.steelPainted();
    const pieces: Piece[] = [];

    // Corner castings + frame rails: the load-bearing skeleton, in bare steel.
    const rail = this.geo(`ctr_rail_${long}`, () => chamferBox(L, 0.14, 0.14, 0.025, 1));
    const post = this.geo('ctr_post', () => chamferBox(0.15, H - 0.28, 0.15, 0.025, 1));
    const casting = this.geo('ctr_cast', () => chamferBox(0.22, 0.19, 0.22, 0.03, 1));
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pieces.push({
          geo: rail,
          mat: steel,
          local: trs(0, (sy * (H - 0.14)) / 2, (sz * (D - 0.14)) / 2),
        });
      }
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pieces.push({ geo: post, mat: steel, local: trs((sx * (L - 0.15)) / 2, 0, (sz * (D - 0.15)) / 2) });
        for (const sy of [-1, 1]) {
          pieces.push({
            geo: casting,
            mat: steel,
            local: trs((sx * (L - 0.22)) / 2, (sy * (H - 0.19)) / 2, (sz * (D - 0.22)) / 2),
          });
        }
      }
    }

    // Corrugated skin, inset so the frame reads proud of it.
    const sidePanel = this.geo(`ctr_side_${long}`, () =>
      corrugatedPanel(L - 0.3, H - 0.32, Math.round(L * 2.6), 0.026),
    );
    const endPanel = this.geo('ctr_end', () => corrugatedPanel(D - 0.3, H - 0.32, 7, 0.022));
    pieces.push({ geo: sidePanel, mat: skin, local: trs(0, 0, D / 2 - 0.08) });
    pieces.push({ geo: sidePanel, mat: skin, local: trs(0, 0, -D / 2 + 0.08, 0, Math.PI, 0) });
    pieces.push({ geo: endPanel, mat: skin, local: trs(-L / 2 + 0.08, 0, 0, 0, -Math.PI / 2, 0) });

    // Roof (slightly domed by using a thin chamfered slab, not a plane).
    const roof = this.geo(`ctr_roof_${long}`, () => chamferBox(L - 0.24, 0.07, D - 0.24, 0.02, 1));
    pieces.push({ geo: roof, mat: skin, local: trs(0, H / 2 - 0.09, 0) });
    const floor = this.geo(`ctr_floor_${long}`, () => chamferBox(L - 0.24, 0.09, D - 0.24, 0.02, 1));
    pieces.push({ geo: floor, mat: steel, local: trs(0, -H / 2 + 0.1, 0) });

    // Door end: four locking bars, hinges, handles - the detail that makes a
    // container legible at a glance instead of "a big box".
    const doorPanel = this.geo('ctr_door', () => chamferBox(D / 2 - 0.2, H - 0.34, 0.06, 0.015, 1));
    const bar = this.geo('ctr_bar', () => new THREE.CylinderGeometry(0.026, 0.026, H - 0.5, 8));
    const handle = this.geo('ctr_handle', () => chamferBox(0.05, 0.3, 0.07, 0.012, 1));
    const hinge = this.geo('ctr_hinge', () => chamferBox(0.07, 0.13, 0.1, 0.015, 1));
    // One container in four has a door swung open - instant asymmetry.
    const doorOpen = rng.chance(0.24);
    for (const side of [-1, 1]) {
      const swing = doorOpen && side === 1 ? rng.range(0.9, 1.35) : 0;
      const hingeX = L / 2 - 0.06;
      const hingeZ = (side * (D - 0.16)) / 2;
      const doorMatrix = new THREE.Matrix4()
        .makeTranslation(hingeX, 0, hingeZ)
        .multiply(new THREE.Matrix4().makeRotationY(-side * swing))
        .multiply(new THREE.Matrix4().makeTranslation(0, 0, (-side * (D / 2 - 0.2)) / 2));
      pieces.push({ geo: doorPanel, mat: skin, local: doorMatrix.clone().multiply(trs(0, 0, 0, 0, Math.PI / 2, 0)) });
      for (let b = 0; b < 2; b++) {
        const off = (b - 0.5) * 0.42;
        pieces.push({
          geo: bar,
          mat: steel,
          local: doorMatrix.clone().multiply(trs(-0.06, 0, off)),
        });
        pieces.push({
          geo: handle,
          mat: steel,
          local: doorMatrix.clone().multiply(trs(-0.09, -0.2, off)),
        });
      }
      for (const hy of [-0.85, 0, 0.85]) {
        pieces.push({ geo: hinge, mat: steel, local: trs(hingeX, hy, hingeZ) });
      }
    }

    return pieces;
  }

  // ------------------------------------------------------------------
  // Ground clutter
  // ------------------------------------------------------------------

  /** Jersey barrier with its characteristic sloped profile. */
  jerseyBarrier(): Piece[] {
    const mat = this.mats.concreteWall();
    const geo = this.geo('jersey', () => {
      const shape = new THREE.Shape();
      shape.moveTo(-0.31, 0);
      shape.lineTo(0.31, 0);
      shape.lineTo(0.21, 0.28);
      shape.lineTo(0.09, 0.72);
      shape.lineTo(-0.09, 0.72);
      shape.lineTo(-0.21, 0.28);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: 1.9,
        bevelEnabled: true,
        bevelThickness: 0.015,
        bevelSize: 0.015,
        bevelSegments: 1,
        steps: 1,
      });
      g.translate(0, 0, -0.95);
      g.computeVertexNormals();
      // Concrete tiles at world scale: reuse position as UV.
      const pos = g.attributes.position as THREE.BufferAttribute;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = pos.getZ(i) * 0.6;
        uv[i * 2 + 1] = pos.getY(i) * 0.6;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return g;
    });
    return [{ geo, mat, local: trs(0, 0, 0) }];
  }

  /** 200L steel drum with rolling hoops. */
  drum(rusty: boolean): Piece[] {
    const body = this.geo('drum_body', () => new THREE.CylinderGeometry(0.29, 0.29, 0.86, 16, 1, false));
    const hoop = this.geo('drum_hoop', () => new THREE.TorusGeometry(0.295, 0.022, 6, 16));
    const lid = this.geo('drum_lid', () => new THREE.CylinderGeometry(0.3, 0.29, 0.05, 16));
    const mat = rusty ? this.mats.container('Rust') : this.mats.container('Blue');
    const steel = this.mats.steelBare();
    return [
      { geo: body, mat, local: trs(0, 0.43, 0) },
      { geo: lid, mat: steel, local: trs(0, 0.87, 0) },
      { geo: lid, mat: steel, local: trs(0, 0.02, 0) },
      { geo: hoop, mat: steel, local: trs(0, 0.3, 0, Math.PI / 2, 0, 0) },
      { geo: hoop, mat: steel, local: trs(0, 0.58, 0, Math.PI / 2, 0, 0) },
    ];
  }

  /** Mooring bollard, cast iron, bolted to the quay. */
  bollard(): Piece[] {
    const mat = this.mats.steelBare();
    const body = this.geo('bollard', () => new THREE.CylinderGeometry(0.16, 0.22, 0.68, 12));
    const cap = this.geo('bollard_cap', () => new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2));
    const base = this.geo('bollard_base', () => chamferBox(0.52, 0.07, 0.52, 0.02, 1));
    return [
      { geo: base, mat, local: trs(0, 0.035, 0) },
      { geo: body, mat, local: trs(0, 0.41, 0) },
      { geo: cap, mat, local: trs(0, 0.74, 0) },
    ];
  }

  /** Euro pallet - visible plank structure, never a solid slab. */
  pallet(): Piece[] {
    const mat = this.mats.rubber();
    const plank = this.geo('pallet_plank', () => chamferBox(1.2, 0.022, 0.1, 0.006, 1));
    const block = this.geo('pallet_block', () => chamferBox(0.1, 0.08, 0.1, 0.008, 1));
    const runner = this.geo('pallet_runner', () => chamferBox(1.2, 0.022, 0.09, 0.006, 1));
    const pieces: Piece[] = [];
    for (let i = 0; i < 5; i++) {
      pieces.push({ geo: plank, mat, local: trs(0, 0.13, -0.4 + i * 0.2) });
    }
    for (const z of [-0.4, 0, 0.4]) {
      pieces.push({ geo: runner, mat, local: trs(0, 0.011, z) });
      for (const x of [-0.55, 0, 0.55]) {
        pieces.push({ geo: block, mat, local: trs(x, 0.062, z) });
      }
    }
    return pieces;
  }

  /** Sandbag emplacement - staggered rows, each bag slightly rotated. */
  sandbagWall(length: number, rows: number, seed: number): Piece[] {
    const mat = this.mats.sandbag();
    const bag = this.geo('sandbag', () => {
      const g = new THREE.SphereGeometry(0.26, 8, 6);
      g.scale(1.0, 0.52, 0.68);
      return g;
    });
    const rng = new Rng(seed);
    const pieces: Piece[] = [];
    const perRow = Math.max(2, Math.round(length / 0.44));
    for (let r = 0; r < rows; r++) {
      const y = 0.13 + r * 0.24;
      const offset = (r % 2) * 0.22;
      const inset = r * 0.045;
      for (let i = 0; i < perRow - (r % 2); i++) {
        const x = -length / 2 + 0.22 + offset + i * 0.44;
        pieces.push({
          geo: bag,
          mat,
          local: trs(
            x + rng.spread(0.02),
            y,
            inset * (rng.next() > 0.5 ? 1 : -1) + rng.spread(0.03),
            rng.spread(0.09),
            rng.spread(0.25),
            rng.spread(0.09),
            1,
            1,
            1,
          ),
        });
      }
    }
    return pieces;
  }

  /** Traffic cone with its reflective band. */
  cone(): Piece[] {
    const body = this.geo('cone', () => new THREE.ConeGeometry(0.17, 0.62, 10, 1, true));
    const base = this.geo('cone_base', () => chamferBox(0.34, 0.035, 0.34, 0.012, 1));
    const band = this.geo('cone_band', () => new THREE.CylinderGeometry(0.115, 0.135, 0.09, 10, 1, true));
    const orange = this.mats.emissive('coneOrange', 0xff5a1e, 0.06);
    const white = this.mats.plasticWhite();
    return [
      { geo: base, mat: white, local: trs(0, 0.018, 0) },
      { geo: body, mat: orange, local: trs(0, 0.33, 0) },
      { geo: band, mat: white, local: trs(0, 0.36, 0) },
    ];
  }

  /** Cable drum lying on its side or standing. */
  cableSpool(): Piece[] {
    const cheek = this.geo('spool_cheek', () => new THREE.CylinderGeometry(0.78, 0.78, 0.07, 20));
    const core = this.geo('spool_core', () => new THREE.CylinderGeometry(0.34, 0.34, 0.72, 16));
    const wound = this.geo('spool_wound', () => new THREE.CylinderGeometry(0.62, 0.62, 0.66, 20));
    const wood = this.mats.rubber();
    const cable = this.mats.gunRubber();
    return [
      { geo: cheek, mat: wood, local: trs(0, 0.78, 0.39, Math.PI / 2, 0, 0) },
      { geo: cheek, mat: wood, local: trs(0, 0.78, -0.39, Math.PI / 2, 0, 0) },
      { geo: core, mat: wood, local: trs(0, 0.78, 0, Math.PI / 2, 0, 0) },
      { geo: wound, mat: cable, local: trs(0, 0.78, 0, Math.PI / 2, 0, 0) },
    ];
  }

  /** Wall-mounted electrical cabinet with conduit stubs. */
  cabinet(): Piece[] {
    const steel = this.mats.steelPainted();
    const body = this.geo('cab_body', () => chamferBox(0.62, 0.9, 0.26, 0.02, 1));
    const door = this.geo('cab_door', () => chamferBox(0.54, 0.8, 0.03, 0.012, 1));
    const conduit = this.geo('cab_conduit', () => new THREE.CylinderGeometry(0.028, 0.028, 0.5, 8));
    const hazard = this.mats.hazard();
    const plate = this.geo('cab_plate', () => chamferBox(0.2, 0.13, 0.012, 0.004, 1));
    return [
      { geo: body, mat: steel, local: trs(0, 0, 0) },
      { geo: door, mat: steel, local: trs(0, 0, 0.145) },
      { geo: plate, mat: hazard, local: trs(0.14, 0.28, 0.165) },
      { geo: conduit, mat: steel, local: trs(-0.18, -0.68, 0) },
      { geo: conduit, mat: steel, local: trs(0.18, -0.68, 0) },
    ];
  }

  /** Roof-top HVAC unit - fills empty roof silhouettes. */
  ventUnit(width = 1.6, depth = 1.2, height = 0.9): Piece[] {
    const steel = this.mats.steelPainted();
    const grate = this.mats.grating();
    const body = this.geo(`vent_${width}_${depth}_${height}`, () =>
      chamferBox(width, height, depth, 0.03, 1),
    );
    const fan = this.geo('vent_fan', () => new THREE.CylinderGeometry(0.38, 0.38, 0.12, 14));
    const leg = this.geo('vent_leg', () => chamferBox(0.09, 0.22, 0.09, 0.01, 1));
    const pieces: Piece[] = [{ geo: body, mat: steel, local: trs(0, height / 2 + 0.2, 0) }];
    pieces.push({ geo: fan, mat: grate, local: trs(0, height + 0.24, 0) });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pieces.push({ geo: leg, mat: steel, local: trs((sx * width) / 2.6, 0.11, (sz * depth) / 2.6) });
      }
    }
    return pieces;
  }

  /** Vertical ladder with cage hoops. */
  ladder(height: number): Piece[] {
    const steel = this.mats.steelBare();
    const rail = this.geo(`ladder_rail_${height.toFixed(1)}`, () => squareTube(height, 0.045));
    const rung = this.geo('ladder_rung', () => new THREE.CylinderGeometry(0.017, 0.017, 0.46, 6));
    const hoop = this.geo('ladder_hoop', () =>
      new THREE.TorusGeometry(0.36, 0.018, 5, 14, Math.PI * 1.35),
    );
    const pieces: Piece[] = [
      { geo: rail, mat: steel, local: trs(-0.23, height / 2, 0, Math.PI / 2, 0, 0) },
      { geo: rail, mat: steel, local: trs(0.23, height / 2, 0, Math.PI / 2, 0, 0) },
    ];
    const rungs = Math.floor(height / 0.31);
    for (let i = 1; i < rungs; i++) {
      pieces.push({ geo: rung, mat: steel, local: trs(0, i * 0.31, 0, 0, 0, Math.PI / 2) });
    }
    for (let i = 1; i * 0.62 < height - 0.6; i++) {
      pieces.push({ geo: hoop, mat: steel, local: trs(0, 1.2 + i * 0.62, 0.18, 0, 0, -Math.PI * 0.32) });
    }
    return pieces;
  }

  // ------------------------------------------------------------------
  // Structure
  // ------------------------------------------------------------------

  /**
   * Catwalk span: two I-beam stringers, grating deck, kick plate and railing.
   * Runs along +X, centred on the origin.
   */
  catwalk(length: number, width = 1.5, railHeight = 1.06): Piece[] {
    const steel = this.mats.steelPainted();
    const tread = this.mats.tread();
    const grate = this.mats.grating();
    const key = `${length.toFixed(1)}_${width.toFixed(1)}`;
    const stringer = this.geo(`cw_str_${key}`, () => iBeam(length, 0.3, 0.14, 0.018));
    const deck = this.geo(`cw_deck_${key}`, () => {
      const g = new THREE.BoxGeometry(length, 0.035, width);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) * 0.5, pos.getZ(i) * 0.5);
      uv.needsUpdate = true;
      return g;
    });
    const kick = this.geo(`cw_kick_${key}`, () => chamferBox(length, 0.11, 0.02, 0.006, 1));
    const rail = this.geo(`cw_rail_${key}`, () => new THREE.CylinderGeometry(0.024, 0.024, length, 8));
    const post = this.geo('cw_post', () => squareTube(railHeight, 0.038));

    const pieces: Piece[] = [
      { geo: stringer, mat: steel, local: trs(0, -0.16, width / 2 - 0.07, 0, Math.PI / 2, 0) },
      { geo: stringer, mat: steel, local: trs(0, -0.16, -width / 2 + 0.07, 0, Math.PI / 2, 0) },
      { geo: deck, mat: tread, local: trs(0, 0.017, 0), opts: { collide: true } },
    ];
    void grate;
    for (const sz of [-1, 1]) {
      const z = (sz * width) / 2;
      pieces.push({ geo: kick, mat: steel, local: trs(0, 0.09, z) });
      pieces.push({ geo: rail, mat: steel, local: trs(0, railHeight, z, 0, 0, Math.PI / 2) });
      pieces.push({ geo: rail, mat: steel, local: trs(0, railHeight * 0.55, z, 0, 0, Math.PI / 2) });
      const posts = Math.max(2, Math.round(length / 1.6));
      for (let i = 0; i <= posts; i++) {
        const x = -length / 2 + (i * length) / posts;
        pieces.push({ geo: post, mat: steel, local: trs(x, railHeight / 2, z, Math.PI / 2, 0, 0) });
      }
    }
    return pieces;
  }

  /** Straight stair flight climbing along +X. */
  stairs(steps: number, rise = 0.19, run = 0.27, width = 1.2): Piece[] {
    const steel = this.mats.steelPainted();
    const tread = this.mats.tread();
    const step = this.geo(`stair_step_${width}`, () => chamferBox(run, 0.035, width, 0.008, 1));
    const riser = this.geo(`stair_riser_${width}`, () => chamferBox(0.02, rise, width, 0.005, 1));
    const length = Math.hypot(steps * run, steps * rise);
    const stringer = this.geo(`stair_str_${steps}`, () => chamferBox(length, 0.26, 0.03, 0.008, 1));
    const angle = Math.atan2(steps * rise, steps * run);
    const pieces: Piece[] = [];
    for (let i = 0; i < steps; i++) {
      pieces.push({ geo: step, mat: tread, local: trs(i * run + run / 2, (i + 1) * rise, 0) });
      pieces.push({ geo: riser, mat: steel, local: trs(i * run, (i + 0.5) * rise, 0) });
    }
    for (const sz of [-1, 1]) {
      pieces.push({
        geo: stringer,
        mat: steel,
        local: trs((steps * run) / 2, (steps * rise) / 2 - 0.06, (sz * width) / 2 + sz * 0.02, 0, 0, angle),
      });
    }
    return pieces;
  }

  /**
   * Chain-link fence run along +X. Alpha-mapped sheet plus real posts and a
   * barbed-wire top - modelling every wire would cost thousands of triangles
   * for a silhouette an alpha map gives away for free.
   */
  fence(length: number, height = 2.4): Piece[] {
    const steel = this.mats.steelBare();
    const mesh = this.mats.chainLink();
    const key = `${length.toFixed(1)}_${height.toFixed(1)}`;
    const sheet = this.geo(`fence_sheet_${key}`, () => {
      const g = new THREE.PlaneGeometry(length, height);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * (length / 2.4), uv.getY(i) * (height / 2.4));
      }
      uv.needsUpdate = true;
      return g;
    });
    const post = this.geo(`fence_post_${height}`, () => new THREE.CylinderGeometry(0.045, 0.05, height + 0.3, 8));
    const rail = this.geo(`fence_rail_${key}`, () => new THREE.CylinderGeometry(0.03, 0.03, length, 6));
    const arm = this.geo('fence_arm', () => new THREE.CylinderGeometry(0.022, 0.022, 0.42, 6));

    const pieces: Piece[] = [
      { geo: sheet, mat: mesh, local: trs(0, height / 2, 0), opts: { castShadow: false, collide: false } },
      { geo: rail, mat: steel, local: trs(0, height, 0, 0, 0, Math.PI / 2) },
      { geo: rail, mat: steel, local: trs(0, 0.08, 0, 0, 0, Math.PI / 2) },
    ];
    const posts = Math.max(2, Math.round(length / 2.6));
    for (let i = 0; i <= posts; i++) {
      const x = -length / 2 + (i * length) / posts;
      pieces.push({ geo: post, mat: steel, local: trs(x, height / 2, 0) });
      pieces.push({ geo: arm, mat: steel, local: trs(x, height + 0.18, 0.1, -0.6, 0, 0) });
    }
    // Three strands of barbed wire on the outriggers.
    for (let s = 0; s < 3; s++) {
      pieces.push({
        geo: rail,
        mat: steel,
        local: trs(0, height + 0.08 + s * 0.14, 0.06 + s * 0.09, 0, 0, Math.PI / 2, 1, 0.22, 0.22),
      });
    }
    return pieces;
  }

  /** Pipe run: a bundle of parallel pipes with support brackets. */
  pipeRun(points: THREE.Vector3[], radii: number[]): Piece[] {
    const steel = this.mats.steelBare();
    const painted = this.mats.steelPainted();
    const pieces: Piece[] = [];
    radii.forEach((r, i) => {
      const offsetPoints = points.map((p) => p.clone().add(new THREE.Vector3(0, i * (r * 2.6), 0)));
      const g = tubeAlong(offsetPoints, r, 8);
      this.disposables.push(g);
      pieces.push({ geo: g, mat: i % 2 === 0 ? steel : painted, local: trs(0, 0, 0) });
    });
    return pieces;
  }

  /** Floodlight mast: pole, brace, head housing and cowl. Light added separately. */
  floodlightMast(height: number): { pieces: Piece[]; headOffset: THREE.Vector3 } {
    const steel = this.mats.steelPainted();
    const pole = this.geo(`flood_pole_${height.toFixed(1)}`, () =>
      new THREE.CylinderGeometry(0.075, 0.11, height, 10),
    );
    const base = this.geo('flood_base', () => chamferBox(0.44, 0.12, 0.44, 0.02, 1));
    const arm = this.geo('flood_arm', () => new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8));
    const housing = this.geo('flood_housing', () => chamferBox(0.52, 0.34, 0.28, 0.035, 2));
    const cowl = this.geo('flood_cowl', () => chamferBox(0.58, 0.05, 0.34, 0.015, 1));
    const brace = this.geo('flood_brace', () => new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6));
    const pieces: Piece[] = [
      { geo: base, mat: steel, local: trs(0, 0.06, 0) },
      { geo: pole, mat: steel, local: trs(0, height / 2, 0) },
      { geo: arm, mat: steel, local: trs(0, height - 0.12, 0.3, Math.PI / 2.4, 0, 0) },
      { geo: brace, mat: steel, local: trs(0, height - 0.55, 0.22, Math.PI / 3.4, 0, 0) },
      { geo: housing, mat: steel, local: trs(0, height + 0.06, 0.58, 0.34, 0, 0) },
      { geo: cowl, mat: steel, local: trs(0, height + 0.26, 0.52, 0.34, 0, 0) },
    ];
    return { pieces, headOffset: new THREE.Vector3(0, height - 0.02, 0.68) };
  }

  /** Wall-mounted floodlight for building facades. */
  wallLight(): { pieces: Piece[]; headOffset: THREE.Vector3 } {
    const steel = this.mats.steelPainted();
    const bracket = this.geo('wl_bracket', () => chamferBox(0.1, 0.3, 0.38, 0.015, 1));
    const housing = this.geo('wl_housing', () => chamferBox(0.4, 0.28, 0.24, 0.03, 2));
    const cowl = this.geo('wl_cowl', () => chamferBox(0.46, 0.04, 0.3, 0.012, 1));
    return {
      pieces: [
        { geo: bracket, mat: steel, local: trs(0, 0, 0.18) },
        { geo: housing, mat: steel, local: trs(0, -0.1, 0.46, 0.42, 0, 0) },
        { geo: cowl, mat: steel, local: trs(0, 0.04, 0.44, 0.42, 0, 0) },
      ],
      headOffset: new THREE.Vector3(0, -0.16, 0.58),
    };
  }

  dispose(): void {
    for (const g of this.disposables) g.dispose();
    this.disposables.length = 0;
    this.cache.clear();
  }
}
