import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import {
  catenaryPoints,
  chamferBox,
  mergeGeometries,
  trs,
  tubeAlong,
} from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';

/**
 * WARDEN-03 - rig and geometry.
 *
 * THE WHOLE CHARACTER IS ONE IDEA: this is a RESCUE machine.
 *
 * It was built to pull people out of a burning fabrication floor - to lift
 * collapsed racking, cut a way in, smother a fire, seal a hazardous bay and
 * carry the injured out. Every single tool on it has a benign original purpose,
 * and the horror of the encounter is that none of them have been replaced. It
 * is not a weapon that has been given a rescue paint job; it is rescue plant
 * that is now being pointed at a person, and it has not been modified at all.
 *
 * So the modelling rules are:
 *   - NOTHING may read as ordnance. No barrels, no muzzle brakes, no magazines,
 *     no missile pods. The most dangerous things on it are a hydraulic clamp
 *     and a cutting torch, and both of them are recognisably maintenance tools.
 *   - HAZARD STRIPES, not camouflage. Yellow/black diagonals are the visual
 *     language of "heavy plant, stand clear" - the same stripes you see on a
 *     crane counterweight or a lift gate. They also happen to be the single
 *     most readable pattern in a dark factory, which is the reason the front
 *     armour (the thing the player must learn NOT to shoot) wears them.
 *   - The beacon on top is an ORANGE ROTATING LIGHT. That is the most
 *     domesticated object it is possible to put on a four-metre machine, and it
 *     is doing exactly the job it was installed to do: warning people to keep
 *     clear of a moving vehicle.
 *
 * SILHOUETTE. The small hostiles are 1.8m verticals. WARDEN-03 is 4.3m tall and
 * 3.2m across the shoulders, with a wide low carriage and a heavy asymmetric
 * back stack. From any angle, at any light level, the reads are:
 *
 *      front  - a broad flat wall of yellow stripes (DO NOT SHOOT)
 *      side   - a bright green lamp on a boxy relay pod (SHOOT THIS)
 *      back   - a tall glowing stack (SHOOT THIS, LATER)
 *      centre - once the armour is gone, one cold eye in the chest
 *
 * Each phase's weak point sits on a DIFFERENT face of the machine, so the fight
 * is a sequence of positional problems rather than three health bars. The
 * player never has to be told to flank; the green lamps do it.
 *
 * BUDGET. 36 meshes, built with the same merge discipline as the soldier: every
 * group of parts that shares a material and a parent becomes one buffer. The
 * boss is the hero asset of the level and is allowed to be the most expensive
 * single object in it, but 36 is still under a twentieth of the level budget.
 *
 * JOINT RULE. Identical to EnemySoldier: every limb bone is a capsule whose
 * end-cap hemisphere centres sit exactly on the joint pivots it spans, so
 * rotating a bone is rotating a sphere about its own centre and the joint
 * physically cannot open a seam. On a machine this is doubly important, because
 * a gap in a metal casing reads as a modelling error rather than as clothing.
 */

/** One walker leg. Digitigrade: the knee breaks BACKWARD, like plant gear. */
export interface WardenLeg {
  root: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
}

/** One manipulator arm. `tip` is where its tool acts from. */
export interface WardenArm {
  root: THREE.Group;
  elbow: THREE.Group;
  tip: THREE.Object3D;
}

/** A side power relay - the phase 1 weak point. Two of them, one per flank. */
export interface WardenRelay {
  root: THREE.Group;
  /** World-space hit centre is read from this every frame. */
  anchor: THREE.Object3D;
  lamp: THREE.Mesh;
  lampMaterial: THREE.MeshStandardMaterial;
}

/** The back-mounted coolant stack - the phase 2 weak point. */
export interface WardenCoolant {
  root: THREE.Group;
  doorLeft: THREE.Group;
  doorRight: THREE.Group;
  fins: THREE.Mesh;
  finMaterial: THREE.MeshStandardMaterial;
  anchor: THREE.Object3D;
  /** Steam origins. Two on the stack shoulders, one at the crown. */
  vents: THREE.Object3D[];
  beaconMaterial: THREE.MeshStandardMaterial;
}

/** The chest AI core - the phase 3 weak point, and the thing that talks. */
export interface WardenCore {
  root: THREE.Group;
  lens: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  anchor: THREE.Object3D;
}

export interface WardenRig {
  root: THREE.Group;
  carriage: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  legs: [WardenLeg, WardenLeg];
  /** Left arm carries the rescue grapple; right carries nozzle + torch. */
  grappleArm: WardenArm;
  toolArm: WardenArm;
  clampJaws: [THREE.Group, THREE.Group];
  /** Front clamshell armour. Hinged, opened and shed at phase 3. */
  armourLeft: THREE.Group;
  armourRight: THREE.Group;
  relays: WardenRelay[];
  coolant: WardenCoolant;
  core: WardenCore;
  sensorMaterial: THREE.MeshStandardMaterial;
  floodMaterial: THREE.MeshStandardMaterial;
  torchMaterial: THREE.MeshStandardMaterial;
  /** Nozzle mouth: the suppressant cone is built from here. */
  nozzleTip: THREE.Object3D;
  /** Torch head: the cutting arc is drawn from here. */
  torchTip: THREE.Object3D;
  /**
   * Where the factory umbilical would terminate. The boss carries its own
   * short trailing cable, but the level workstream owns anything that has to
   * be anchored to real world geometry, so it gets a documented socket here
   * rather than the boss guessing where the ceiling is.
   */
  tetherAnchor: THREE.Object3D;
  /** Sparks/steam origins on the shoulders and hips. */
  damageVents: THREE.Object3D[];
  meshCount: number;
  dispose(): void;
}

/**
 * Numbers the controller needs to reason about the fight without re-deriving
 * them from the geometry. Heights are metres above the machine's feet.
 */
export const WARDEN_METRICS = {
  height: 4.32,
  /** Radius of the carriage footprint; used for keep-out and collision. */
  bodyRadius: 1.45,
  hipY: 1.95,
  /** Chest height - the arm sweep passes through here, so it can be ducked. */
  sweepY: 2.55,
  /** Hit sphere radii for the three weak points, in metres.
   *
   * These are DELIBERATELY generous. The coolant stack in particular is the
   * target the forced-ADS system exists for: a scoped shot at a 0.94m sphere
   * on a slow-moving four-metre machine is an aiming beat, not a pixel hunt.
   * Shrinking these to "realistic" sizes is the fastest way to turn phase 2
   * from satisfying into miserable. */
  relayRadius: 0.76,
  coolantRadius: 0.94,
  coreRadius: 0.72,
} as const;

export function buildWarden03(mats: MaterialLibrary): WardenRig {
  const owned: THREE.BufferGeometry[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => {
    owned.push(g);
    return g;
  };

  // Painted steel for the big structural masses, bare steel for the limbs,
  // gun metal only for parts small enough that its 26-tiles-per-metre texture
  // resolves as machining rather than as noise, hazard stripes for everything
  // that is trying to warn you, tread plate for surfaces a technician stands on.
  const shell = mats.steelPainted();
  const limb = mats.steelBare();
  const fine = mats.gunMetal();
  const stripes = mats.hazard();
  const deck = mats.tread();
  const cable = mats.rubber();

  // Emissive keys are unique to this boss because the library caches and SHARES
  // materials by key: the controller mutates intensity and colour on these
  // every frame, and a key collision would drag some lamp elsewhere in the
  // level along with it.
  const sensorMaterial = mats.emissive('wardenSensor', 0xffb347, 5);
  const floodMaterial = mats.emissive('wardenFlood', 0xfff0d2, 4);
  const coreMaterial = mats.emissive('wardenCore', 0x59d8ff, 3);
  const heatMaterial = mats.emissive('wardenHeat', 0xff5a1e, 0.15);
  const beaconMaterial = mats.emissive('wardenBeacon', 0xffa022, 6);
  const torchMaterial = mats.emissive('wardenTorch', 0xbfe6ff, 0.1);

  let meshCount = 0;
  const meshFrom = (
    parts: Array<[THREE.BufferGeometry, THREE.Matrix4]>,
    material: THREE.Material,
    name: string,
    shadows = true,
  ): THREE.Mesh => {
    const merged = mergeGeometries(
      parts.map((p) => p[0]),
      parts.map((p) => p[1]),
    );
    owned.push(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    meshCount++;
    return mesh;
  };

  /**
   * Capsule bone, offset so its TOP cap centre is the local origin (the parent
   * joint) and its BOTTOM cap centre is at -length. See the joint rule above.
   */
  const bone = (length: number, radius: number): THREE.BufferGeometry => {
    const g = keep(new THREE.CapsuleGeometry(radius, length, 3, 10));
    g.translate(0, -length / 2, 0);
    return g;
  };

  const root = new THREE.Group();
  root.name = 'Warden03';

  // ===================================================================
  // CARRIAGE - the wide low chassis the whole machine balances on
  // ===================================================================
  //
  // Wide and heavy on purpose. A tall narrow boss reads as a person; a broad
  // one with its mass slung low reads as PLANT, and it also gives the player a
  // silhouette they can judge distance from at a glance in a smoky room.
  const carriage = new THREE.Group();
  carriage.position.y = WARDEN_METRICS.hipY;
  root.add(carriage);

  carriage.add(
    meshFrom(
      [
        // Main chassis block.
        [keep(chamferBox(1.95, 0.8, 1.45, 0.07, 2)), trs(0, 0, 0)],
        // Hip yokes: the legs hang off these, and they are deep enough that the
        // thigh capsule's top cap is buried inside them at every swing angle.
        [keep(chamferBox(0.44, 0.58, 0.66, 0.05, 1)), trs(-0.86, -0.14, 0)],
        [keep(chamferBox(0.44, 0.58, 0.66, 0.05, 1)), trs(0.86, -0.14, 0)],
        // Counterweight / battery bank hung off the back. This is what makes
        // the profile read as a machine that lifts things: the mass behind the
        // hips is there to balance a load held out in front.
        [keep(chamferBox(1.4, 0.64, 0.58, 0.06, 2)), trs(0, 0.04, -0.92)],
        // Emergency power cells, three upright cylinders on the counterweight.
        // In phase 3 these are what it is running on.
        [keep(new THREE.CylinderGeometry(0.15, 0.15, 0.46, 10)), trs(-0.45, 0.5, -0.92)],
        [keep(new THREE.CylinderGeometry(0.15, 0.15, 0.46, 10)), trs(0, 0.5, -0.92)],
        [keep(new THREE.CylinderGeometry(0.15, 0.15, 0.46, 10)), trs(0.45, 0.5, -0.92)],
        // Lifting eyes: this thing has been craned into place many times.
        [keep(chamferBox(0.1, 0.16, 0.1, 0.02, 1)), trs(-0.72, 0.44, 0.5)],
        [keep(chamferBox(0.1, 0.16, 0.1, 0.02, 1)), trs(0.72, 0.44, 0.5)],
        // Front bumper / obstacle plough. It has spent its life pushing debris.
        [keep(chamferBox(1.7, 0.3, 0.24, 0.05, 2)), trs(0, -0.24, 0.78)],
      ],
      shell,
      'wardenChassis',
    ),
  );

  // Maintenance deck on top of the chassis - grip plate, because a person is
  // supposed to be able to stand there and work on it.
  const deckPlate = meshFrom(
    [[keep(chamferBox(1.5, 0.07, 1.0, 0.015, 1)), trs(0, 0.43, 0.08)]],
    deck,
    'wardenDeck',
  );
  carriage.add(deckPlate);

  // Hazard band around the chassis skirt. Proud of the block by 3cm so it
  // catches its own edge highlight rather than z-fighting.
  carriage.add(
    meshFrom(
      [[keep(chamferBox(2.01, 0.24, 1.51, 0.02, 1)), trs(0, -0.3, 0)]],
      stripes,
      'wardenHazardBand',
    ),
  );

  // ===================================================================
  // LEGS - two heavy digitigrade walkers
  // ===================================================================
  const THIGH = 0.95;
  const SHIN = 0.82;
  const makeLeg = (side: number): WardenLeg => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.86, -0.2, 0);

    leg.add(
      meshFrom(
        [
          [bone(THIGH, 0.2), trs(0, 0, 0)],
          // Actuator ram alongside the thigh: the visual reason the joint moves.
          [keep(chamferBox(0.12, 0.6, 0.12, 0.025, 1)), trs(side * 0.22, -0.36, 0.14)],
          // Hip sphere, buried in the yoke above.
          [keep(new THREE.SphereGeometry(0.23, 10, 8)), trs(0, -0.02, 0)],
        ],
        limb,
        'wardenThigh',
      ),
    );

    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    leg.add(knee);
    knee.add(
      meshFrom(
        [
          [bone(SHIN, 0.16), trs(0, 0, 0)],
          [keep(new THREE.SphereGeometry(0.19, 10, 8)), trs(0, -0.01, 0)],
          // Shin guard, straddling the knee pivot so the joint reads armoured.
          [keep(chamferBox(0.3, 0.42, 0.16, 0.04, 2)), trs(0, -0.16, 0.15)],
        ],
        limb,
        'wardenShin',
      ),
    );

    const ankle = new THREE.Group();
    ankle.position.y = -SHIN;
    knee.add(ankle);
    // Broad flat foot pad. A machine this heavy needs a footprint, and a wide
    // foot is also what makes the ground slam read as credible.
    ankle.add(
      meshFrom(
        [
          [keep(chamferBox(0.62, 0.16, 1.05, 0.04, 2)), trs(0, -0.09, 0.12)],
          [keep(new THREE.SphereGeometry(0.17, 10, 8)), trs(0, -0.01, 0)],
          [keep(chamferBox(0.5, 0.1, 0.3, 0.03, 1)), trs(0, -0.16, 0.5)],
        ],
        deck,
        'wardenFoot',
      ),
    );

    return { root: leg, knee, ankle };
  };
  const legs: [WardenLeg, WardenLeg] = [makeLeg(-1), makeLeg(1)];
  carriage.add(legs[0].root, legs[1].root);

  // ===================================================================
  // TORSO - hull, shoulders, spine
  // ===================================================================
  const torso = new THREE.Group();
  torso.position.y = 0.62;
  carriage.add(torso);

  torso.add(
    meshFrom(
      [
        [keep(chamferBox(1.55, 1.15, 1.05, 0.08, 2)), trs(0, 0, 0)],
        // Shoulder yokes. Wide, so the arms hang clear of the hull and the
        // silhouette has real width at 30m.
        [keep(chamferBox(0.52, 0.62, 0.72, 0.06, 1)), trs(-0.9, 0.3, 0.02)],
        [keep(chamferBox(0.52, 0.62, 0.72, 0.06, 1)), trs(0.9, 0.3, 0.02)],
        // Spine housing the coolant runs.
        [keep(chamferBox(0.82, 1.0, 0.36, 0.05, 2)), trs(0, 0.1, -0.6)],
        // Neck column + collar sphere. The head pivots at the sphere's centre,
        // so head rotation cannot open the neck.
        [keep(new THREE.CylinderGeometry(0.2, 0.24, 0.34, 10)), trs(0, 0.66, 0.1)],
        [keep(new THREE.SphereGeometry(0.24, 10, 8)), trs(0, 0.8, 0.1)],
        // Hose runs down the front chest, either side of the core recess.
        [keep(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8)), trs(-0.44, -0.02, 0.5)],
        [keep(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8)), trs(0.44, -0.02, 0.5)],
      ],
      shell,
      'wardenTorso',
    ),
  );

  // ===================================================================
  // CHEST AI CORE - the phase 3 weak point
  // ===================================================================
  //
  // Recessed into the chest and completely hidden behind the clamshell armour
  // until the machine cuts that armour loose itself. The lens is a single cold
  // eye: it is the only part of WARDEN-03 that looks like it is LOOKING at you,
  // and the only part that is not obviously a tool. That is the point - the
  // thing making the decisions is the one part that was never designed to touch
  // anybody, and it is the part the player finally has to shoot.
  const core = new THREE.Group();
  core.position.set(0, -0.05, 0.46);
  torso.add(core);
  core.add(
    meshFrom(
      [
        [keep(chamferBox(0.8, 0.8, 0.3, 0.05, 2)), trs(0, 0, 0)],
        // Bezel ring, so the lens sits in a housing rather than floating.
        [keep(new THREE.CylinderGeometry(0.33, 0.33, 0.1, 14)), trs(0, 0, 0.15, Math.PI / 2, 0, 0)],
      ],
      fine,
      'wardenCoreShell',
    ),
  );
  const coreLens = meshFrom(
    [[keep(new THREE.SphereGeometry(0.27, 14, 10)), trs(0, 0, 0.14)]],
    coreMaterial,
    'wardenCoreLens',
    false,
  );
  core.add(coreLens);
  const coreAnchor = new THREE.Object3D();
  coreAnchor.position.set(0, 0, 0.1);
  core.add(coreAnchor);

  // ===================================================================
  // FRONT CLAMSHELL ARMOUR - the phase 1 "do not shoot this" surface
  // ===================================================================
  //
  // Two hinged plates that meet on the centreline and completely cover the
  // core. They wear hazard stripes because that is the single loudest visual
  // signal available and it needs to be legible the instant the fight starts:
  // the player's first magazine WILL go into this, and the yellow has to be
  // memorable enough that the third magazine does not.
  //
  // Sealed frontal damage is scaled by MISSION_V2.boss.sealedDamageScale, which
  // is 0.03. That is near zero on purpose. A 0.3 scale would make shooting the
  // front a slow but valid strategy, and phase 1 would stop being a positional
  // puzzle and start being a patience test.
  const makeArmourPlate = (side: number): THREE.Group => {
    const hinge = new THREE.Group();
    hinge.position.set(side * 0.78, -0.02, 0.4);
    torso.add(hinge);
    hinge.add(
      meshFrom(
        [
          [keep(chamferBox(0.84, 1.3, 0.17, 0.05, 2)), trs(-side * 0.4, 0, 0.12)],
          // Rib stiffeners across the plate - it is a shield made of structure,
          // not a slab.
          [keep(chamferBox(0.86, 0.1, 0.06, 0.02, 1)), trs(-side * 0.4, 0.42, 0.22)],
          [keep(chamferBox(0.86, 0.1, 0.06, 0.02, 1)), trs(-side * 0.4, -0.42, 0.22)],
        ],
        stripes,
        'wardenArmourPlate',
      ),
    );
    return hinge;
  };
  const armourLeft = makeArmourPlate(-1);
  const armourRight = makeArmourPlate(1);

  // ===================================================================
  // SIDE POWER RELAYS - the phase 1 weak points
  // ===================================================================
  //
  // Deliberately on the FLANKS and deliberately lit bright green. Green because
  // nothing else in this factory is green, so a single lamp is unmistakable in
  // peripheral vision; on the flanks because that forces the player to move
  // around a machine whose whole front is a wall. The lamp is also the phase 1
  // progress bar: it dims as the relay takes damage and dies black.
  const makeRelay = (side: number, index: number): WardenRelay => {
    const relay = new THREE.Group();
    relay.position.set(side * 0.94, -0.12, -0.1);
    torso.add(relay);
    relay.add(
      meshFrom(
        [
          [keep(chamferBox(0.36, 0.66, 0.54, 0.05, 2)), trs(0, 0, 0)],
          // Conduit into the hull, so the relay reads as feeding something.
          [keep(new THREE.CylinderGeometry(0.07, 0.07, 0.24, 8)), trs(-side * 0.2, 0.1, 0, 0, 0, Math.PI / 2)],
          // Cooling fins on the outer face.
          [keep(chamferBox(0.06, 0.5, 0.44, 0.012, 1)), trs(side * 0.2, 0, 0)],
        ],
        fine,
        'wardenRelayHousing',
      ),
    );
    const lampMaterial = mats.emissive(`wardenRelay${index}`, 0x66ff9e, 7);
    const lamp = meshFrom(
      [
        [keep(chamferBox(0.06, 0.34, 0.3, 0.02, 1)), trs(side * 0.19, 0.02, 0)],
        [keep(new THREE.SphereGeometry(0.08, 10, 8)), trs(side * 0.2, 0.26, 0)],
      ],
      lampMaterial,
      'wardenRelayLamp',
      false,
    );
    relay.add(lamp);
    const anchor = new THREE.Object3D();
    anchor.position.set(side * 0.12, 0, 0);
    relay.add(anchor);
    return { root: relay, anchor, lamp, lampMaterial };
  };
  const relays = [makeRelay(-1, 0), makeRelay(1, 1)];

  // ===================================================================
  // BACK COOLANT STACK - the phase 2 weak point
  // ===================================================================
  //
  // A fire-suppression rig carries an enormous thermal budget: it works inside
  // burning buildings. That budget is the flaw. With the relays gone it cannot
  // regulate, so the stack's shroud doors blow open and the fin bank behind
  // them is exposed - a big, bright, slow-moving orange target mounted high on
  // its back.
  //
  // This is the target the forced-ADS system was built for. So it is:
  //   - LARGE (0.62m hit sphere),
  //   - HIGH (3.3m, above the smoke and above cover),
  //   - and it MOVES PREDICTABLY - it only translates with the walk cycle and
  //     yaws with the body, never snapping.
  // A player who scopes in and leads it slightly is rewarded. There is nothing
  // twitchy to hunt for.
  const coolant = new THREE.Group();
  coolant.position.set(0, 0.35, -0.74);
  torso.add(coolant);

  coolant.add(
    meshFrom(
      [
        [keep(chamferBox(1.3, 1.5, 0.56, 0.07, 2)), trs(0, 0.32, 0)],
        // Header tank across the crown.
        [keep(new THREE.CylinderGeometry(0.26, 0.26, 1.2, 12)), trs(0, 1.14, 0.02, 0, 0, Math.PI / 2)],
        // Riser pipes from the torso into the stack.
        [keep(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 8)), trs(-0.5, -0.2, 0.24)],
        [keep(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 8)), trs(0.5, -0.2, 0.24)],
        // Relief valve bonnets - where the steam comes from.
        [keep(new THREE.CylinderGeometry(0.1, 0.13, 0.2, 8)), trs(-0.52, 1.02, -0.2)],
        [keep(new THREE.CylinderGeometry(0.1, 0.13, 0.2, 8)), trs(0.52, 1.02, -0.2)],
      ],
      shell,
      'wardenCoolantStack',
    ),
  );

  // The fin bank. Hidden behind the doors while sealed; the controller ramps
  // this material from a dull ember to white-hot across phase 2, which is the
  // player's damage readout - they can see how close it is to failing without
  // ever looking at a HUD number.
  const finParts: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
  for (let i = 0; i < 7; i++) {
    finParts.push([keep(chamferBox(1.06, 0.14, 0.26, 0.015, 1)), trs(0, 0.32 + (i - 3) * 0.19, -0.16)]);
  }
  const fins = meshFrom(finParts, heatMaterial, 'wardenCoolantFins', false);
  coolant.add(fins);

  // Shroud doors. Closed flush in phase 1, flung wide in phase 2.
  const makeDoor = (side: number): THREE.Group => {
    const hinge = new THREE.Group();
    hinge.position.set(side * 0.64, 0.32, -0.28);
    coolant.add(hinge);
    hinge.add(
      meshFrom(
        [
          [keep(chamferBox(0.66, 1.44, 0.12, 0.04, 2)), trs(-side * 0.32, 0, 0)],
          [keep(chamferBox(0.16, 0.16, 0.1, 0.02, 1)), trs(-side * 0.58, 0, -0.06)],
        ],
        shell,
        'wardenCoolantDoor',
      ),
    );
    return hinge;
  };
  const doorLeft = makeDoor(-1);
  const doorRight = makeDoor(1);

  const coolantAnchor = new THREE.Object3D();
  coolantAnchor.position.set(0, 0.32, -0.3);
  coolant.add(coolantAnchor);

  const vents: THREE.Object3D[] = [];
  for (const p of [
    new THREE.Vector3(-0.52, 1.06, -0.24),
    new THREE.Vector3(0.52, 1.06, -0.24),
    new THREE.Vector3(0, 0.32, -0.42),
  ]) {
    const v = new THREE.Object3D();
    v.position.copy(p);
    coolant.add(v);
    vents.push(v);
  }

  // The rotating beacon. The most humane object on the machine, and it never
  // stops working: it is still, correctly, warning people to stand clear.
  const beacon = meshFrom(
    [
      [keep(new THREE.CylinderGeometry(0.14, 0.14, 0.18, 12)), trs(0, 1.44, 0.02)],
      [keep(new THREE.SphereGeometry(0.13, 12, 8)), trs(0, 1.52, 0.02)],
    ],
    beaconMaterial,
    'wardenBeacon',
    false,
  );
  coolant.add(beacon);

  const tetherAnchor = new THREE.Object3D();
  tetherAnchor.position.set(0, 1.3, -0.3);
  coolant.add(tetherAnchor);

  // ===================================================================
  // HEAD / SENSOR CLUSTER
  // ===================================================================
  //
  // Not a face. A survey head: a wide sensor bar for finding people through
  // smoke, and two work floodlights for lighting a casualty while it treats
  // them. The floodlights are the reason the player can always tell which way
  // it is looking, which is the whole basis of reading its wind-ups.
  const head = new THREE.Group();
  head.position.set(0, 0.8, 0.1);
  torso.add(head);
  head.add(
    meshFrom(
      [
        [keep(chamferBox(0.74, 0.46, 0.62, 0.08, 2)), trs(0, 0.08, 0)],
        [keep(chamferBox(0.68, 0.2, 0.1, 0.03, 1)), trs(0, 0.04, 0.3)],
        // Floodlight housings.
        [keep(new THREE.CylinderGeometry(0.12, 0.12, 0.14, 10)), trs(-0.42, 0.04, 0.26, Math.PI / 2, 0, 0)],
        [keep(new THREE.CylinderGeometry(0.12, 0.12, 0.14, 10)), trs(0.42, 0.04, 0.26, Math.PI / 2, 0, 0)],
        // Antenna mast: a thin vertical that keeps the head readable at range.
        [keep(new THREE.CylinderGeometry(0.02, 0.026, 0.6, 6)), trs(-0.28, 0.5, -0.16)],
      ],
      shell,
      'wardenHead',
    ),
  );
  const sensorBar = meshFrom(
    [[keep(chamferBox(0.52, 0.11, 0.06, 0.015, 1)), trs(0, 0.04, 0.34)]],
    sensorMaterial,
    'wardenSensorBar',
    false,
  );
  head.add(sensorBar);
  const floods = meshFrom(
    [
      [keep(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 10)), trs(-0.42, 0.04, 0.33, Math.PI / 2, 0, 0)],
      [keep(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 10)), trs(0.42, 0.04, 0.33, Math.PI / 2, 0, 0)],
    ],
    floodMaterial,
    'wardenFloods',
    false,
  );
  head.add(floods);

  // ===================================================================
  // ARMS - industrial manipulators
  // ===================================================================
  const UPPER = 0.95;
  const FORE = 0.85;
  const makeArm = (side: number): WardenArm => {
    const arm = new THREE.Group();
    arm.position.set(side * 1.0, 0.28, 0.02);
    torso.add(arm);
    arm.add(
      meshFrom(
        [
          [bone(UPPER, 0.19), trs(0, 0, 0)],
          [keep(new THREE.SphereGeometry(0.23, 10, 8)), trs(0, -0.02, 0)],
          // Hydraulic ram along the outside of the upper arm.
          [keep(chamferBox(0.1, 0.62, 0.1, 0.02, 1)), trs(side * 0.2, -0.4, -0.1)],
        ],
        limb,
        'wardenUpperArm',
      ),
    );
    const elbow = new THREE.Group();
    elbow.position.y = -UPPER;
    arm.add(elbow);
    elbow.add(
      meshFrom(
        [
          [bone(FORE, 0.155), trs(0, 0, 0)],
          [keep(new THREE.SphereGeometry(0.185, 10, 8)), trs(0, -0.01, 0)],
          [keep(chamferBox(0.26, 0.34, 0.2, 0.04, 2)), trs(0, -0.5, 0.06)],
        ],
        limb,
        'wardenForearm',
      ),
    );
    const tip = new THREE.Object3D();
    tip.position.y = -FORE - 0.55;
    elbow.add(tip);
    return { root: arm, elbow, tip };
  };
  const grappleArm = makeArm(-1);
  const toolArm = makeArm(1);

  // --- LEFT TOOL: the rescue grapple ---------------------------------
  //
  // This is the tool that lifted collapsed racking off people. It is a clamp:
  // two hydraulic jaws on a rotating head, striped yellow because it is a
  // crush hazard. It has never been anything else, and it is now the reason
  // the player has to watch its left side.
  const clampBase = meshFrom(
    [
      [keep(chamferBox(0.44, 0.32, 0.56, 0.05, 2)), trs(0, -FORE - 0.18, 0.04)],
      [keep(new THREE.CylinderGeometry(0.14, 0.14, 0.2, 10)), trs(0, -FORE - 0.02, 0.04)],
    ],
    fine,
    'wardenClampBase',
  );
  grappleArm.elbow.add(clampBase);

  const makeJaw = (side: number): THREE.Group => {
    const jaw = new THREE.Group();
    jaw.position.set(side * 0.15, -FORE - 0.3, 0.04);
    grappleArm.elbow.add(jaw);
    jaw.add(
      meshFrom(
        [
          [keep(chamferBox(0.14, 0.46, 0.42, 0.035, 2)), trs(side * 0.03, -0.2, 0.02)],
          // Tooth: the bit that would have bitten into a steel joist.
          [keep(chamferBox(0.12, 0.16, 0.3, 0.03, 1)), trs(side * 0.06, -0.44, 0.08)],
        ],
        stripes,
        'wardenClampJaw',
      ),
    );
    return jaw;
  };
  const clampJaws: [THREE.Group, THREE.Group] = [makeJaw(-1), makeJaw(1)];

  // --- RIGHT TOOL: suppression nozzle + cutting torch -----------------
  //
  // Both on the same wrist, because on the real machine they are the two ends
  // of one intervention: cut your way in, then put the fire out. Merged into a
  // single mesh - they share a material and a parent, and nothing about them
  // articulates independently.
  const toolHead = meshFrom(
    [
      // Suppressant nozzle: a tapering monitor with a spreader ring.
      [keep(new THREE.CylinderGeometry(0.13, 0.19, 0.5, 12)), trs(0, -FORE - 0.28, 0.02)],
      [keep(new THREE.CylinderGeometry(0.2, 0.16, 0.14, 12)), trs(0, -FORE - 0.56, 0.02)],
      [keep(chamferBox(0.34, 0.2, 0.34, 0.04, 2)), trs(0, -FORE - 0.06, 0.02)],
      // Supply hose looping back up the forearm.
      [keep(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8)), trs(-0.16, -FORE - 0.1, -0.14)],
      // Cutting torch, mounted alongside on a short stalk.
      [keep(new THREE.CylinderGeometry(0.05, 0.06, 0.44, 8)), trs(0.24, -FORE - 0.24, 0.1)],
      [keep(chamferBox(0.14, 0.16, 0.14, 0.02, 1)), trs(0.24, -FORE + 0.02, 0.1)],
    ],
    fine,
    'wardenToolHead',
  );
  toolArm.elbow.add(toolHead);

  const torchGlow = meshFrom(
    [[keep(new THREE.SphereGeometry(0.075, 10, 8)), trs(0.24, -FORE - 0.48, 0.1)]],
    torchMaterial,
    'wardenTorchTip',
    false,
  );
  toolArm.elbow.add(torchGlow);

  const nozzleTip = new THREE.Object3D();
  nozzleTip.position.set(0, -FORE - 0.64, 0.02);
  toolArm.elbow.add(nozzleTip);
  const torchTip = new THREE.Object3D();
  torchTip.position.set(0.24, -FORE - 0.5, 0.1);
  toolArm.elbow.add(torchTip);

  // Rest pose: arms hanging slightly forward and out. Not a fighting stance -
  // this machine has no fighting stance, which is exactly what should unsettle
  // the player when it suddenly uses one.
  grappleArm.root.rotation.set(-0.22, 0, 0.14);
  grappleArm.elbow.rotation.x = 0.42;
  toolArm.root.rotation.set(-0.18, 0, -0.16);
  toolArm.elbow.rotation.x = 0.38;
  clampJaws[0].rotation.z = 0.16;
  clampJaws[1].rotation.z = -0.16;

  // ===================================================================
  // UMBILICAL - the cables it is still tethered by
  // ===================================================================
  //
  // It never disconnected. It is still plugged into the factory that told it
  // to do this, and it drags the cable behind it everywhere it goes. Two tubes
  // merged into one mesh; they are parented to the ROOT rather than the torso
  // so they trail from the machine as a whole.
  const cableGeos: THREE.BufferGeometry[] = [];
  for (const [ox, oz, tx, tz, sag] of [
    [0.36, -1.05, 0.55, -3.3, 0.85],
    [-0.36, -1.05, -0.78, -3.8, 1.05],
  ]) {
    const pts = catenaryPoints(
      new THREE.Vector3(ox, 4.02, oz),
      new THREE.Vector3(tx, 0.06, tz),
      sag,
      12,
    );
    cableGeos.push(keep(tubeAlong(pts, 0.055, 6)));
  }
  const cables = meshFrom(
    cableGeos.map((g) => [g, trs(0, 0, 0)] as [THREE.BufferGeometry, THREE.Matrix4]),
    cable,
    'wardenCables',
    false,
  );
  root.add(cables);

  // Sparks/steam origins used once it starts coming apart.
  const damageVents: THREE.Object3D[] = [];
  for (const p of [
    new THREE.Vector3(-0.86, 0.62, 0.1),
    new THREE.Vector3(0.86, 0.62, 0.1),
    new THREE.Vector3(0, -0.3, 0.6),
    new THREE.Vector3(0, 0.2, -0.6),
  ]) {
    const v = new THREE.Object3D();
    v.position.copy(p);
    torso.add(v);
    damageVents.push(v);
  }

  root.traverse((node) => node.layers.set(LAYER.WORLD));

  return {
    root,
    carriage,
    torso,
    head,
    legs,
    grappleArm,
    toolArm,
    clampJaws,
    armourLeft,
    armourRight,
    relays,
    coolant: {
      root: coolant,
      doorLeft,
      doorRight,
      fins,
      finMaterial: heatMaterial,
      anchor: coolantAnchor,
      vents,
      beaconMaterial,
    },
    core: { root: core, lens: coreLens, material: coreMaterial, anchor: coreAnchor },
    sensorMaterial,
    floodMaterial,
    torchMaterial,
    nozzleTip,
    torchTip,
    tetherAnchor,
    damageVents,
    meshCount,
    dispose(): void {
      for (const g of owned) g.dispose();
      owned.length = 0;
    },
  };
}
