import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { chamferBox, mergeGeometries, trs } from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';

/**
 * GATEKEEPER - the exterior mid-boss that holds the loading shutter.
 *
 * WHAT THIS THING IS, AND WHY IT LOOKS LIKE THIS
 *
 * The director's note is that this is a *security* physical-AI, not a war
 * machine and emphatically not a humanoid. That is a silhouette instruction
 * before it is a story one. Everything below is chosen so the player reads
 * "industrial safety equipment that has been told to stop you" in the first
 * quarter second of seeing it:
 *
 *   - a heavy TRACKED base, not legs. Legs read as military; tracks read as
 *     plant machinery. It also means the thing can never chase the player into
 *     a corner, which is what lets the encounter be about positioning.
 *   - a slab FRONT SHIELD that is physically larger than the body behind it.
 *     The shield is the fight, so it has to be the loudest shape in the
 *     silhouette and it has to be obviously *armour*, not decoration.
 *   - hazard chevrons on the shield's leading edges. Yellow-black diagonal is
 *     the most universally understood "do not put your hand here" signal there
 *     is, and it is doing real work: it tells the player not to shoot the face
 *     without a tutorial line.
 *   - the ACCESS MODULE bolted to its back, pale and lit, so the objective is
 *     visibly ON the enemy. The player should want to get behind it before
 *     anyone tells them to.
 *   - an exposed COOLING COIL on the chest, hidden behind the shield until it
 *     vents. That is the weak point, and it is deliberately placed where the
 *     shield covers it, so "open" and "vulnerable" are the same event.
 *
 * WHY THERE IS NO SKELETON
 *
 * Same reasoning as EnemySoldier: rigid parts driven by a handful of angles.
 * A machine is the one case where rigid parts are not a compromise at all -
 * real tracked plant genuinely is a stack of rigid weldments on hinges, so the
 * rig and the fiction agree. Every joint here is a real hinge with a real
 * pivot, and the only "animation" is six numbers written by the controller.
 *
 * DRAW-CALL BUDGET
 *
 * The level budget is ~640 draw calls, so a single unit that eats 40 of them
 * is not affordable no matter how good it looks. Parts are merged aggressively
 * by (material, moving group): a piece only gets its own mesh if it has to
 * move independently OR wears a different material. That lands this at 17
 * meshes, five of which are emissive and do not cast shadows, so the shadow
 * pass only sees 12.
 *
 * MATERIAL NOTE - why not gunMetal()
 *
 * `gunMetal()` tiles at 26 repeats per metre because it was authored for
 * centimetre-scale receiver parts. On a 2m shield plate that resolves as pure
 * noise - the exact failure MaterialLibrary.soldierFatigue() was written to fix
 * when the hostiles borrowed weapon materials. `steelPainted()` and
 * `steelBare()` tile at 1.4/m, which is the right texel density for a vehicle,
 * and they are already shared with half the harbour so they batch for free.
 */

/** Angles the controller writes. Nothing else touches the transform tree. */
export interface GatekeeperPose {
  /** Chassis heading, radians. Slow - this is a tracked vehicle. */
  hullYaw: number;
  /** Superstructure heading. Faster than the hull, but rate-limited: the gap
   *  between the two is what creates flankable side aspect. */
  turretYaw: number;
  /** Sensor head pan/tilt, relative to the turret. */
  headYaw: number;
  headPitch: number;
  /** 0 = shield stowed flat over the hull, 1 = raised and locked forward. */
  shieldDeploy: number;
  /** 0 = leaves closed, 1 = clamshell thrown wide. This is the whole fight. */
  shieldOpen: number;
  /** Work arm shoulder / elbow. */
  armPitch: number;
  armElbow: number;
  /** Suspension: chassis pitch and roll from acceleration and recoil. */
  hullPitch: number;
  hullRoll: number;
}

export interface GatekeeperRig {
  root: THREE.Group;
  /** Rotating superstructure. Shield, arm, module, vent and head hang off it. */
  turret: THREE.Group;
  head: THREE.Group;
  /** Clamshell hinges. index 0 = left (-X), 1 = right (+X). */
  shieldHinges: [THREE.Group, THREE.Group];
  arm: THREE.Group;
  elbow: THREE.Group;
  /** The objective. Detached from `turret` and dropped on death. */
  moduleMount: THREE.Group;
  /** Emissive parts the controller drives directly. */
  lens: THREE.Mesh;
  coil: THREE.Mesh;
  warnLights: THREE.Mesh;
  moduleGlow: THREE.Mesh;
  steam: THREE.Mesh;
  /** Muzzle for the suppressive fire, in world space via getWorldPosition. */
  muzzle: THREE.Object3D;

  // --- hit volumes, in ROOT-LOCAL space (see GatekeeperController.damage) ---
  /** Centre and radius of the body sphere. */
  hullOffset: THREE.Vector3;
  hullRadius: number;
  /** The cooling coil - the only place full damage lands. */
  coilOffset: THREE.Vector3;
  coilRadius: number;
  /** Front shield slab, approximated for the hitscan test. */
  shieldOffset: THREE.Vector3;
  shieldRadius: number;

  /** Writes a pose onto the transform tree. Pure transform maths, no state. */
  apply(pose: GatekeeperPose): void;
  dispose(): void;
}

/** Local convenience: emissive colours, kept together so the palette is one edit. */
const COLOR = {
  /** Sensor eye. Amber when patrolling, driven red when hunting. */
  lens: 0xffb347,
  /** Cooling coil. Cyan-white at full vent - the coldest, brightest thing in
   *  the yard, which is what makes it findable through rain and fog. */
  coil: 0x9fe8ff,
  /** Beacons. Standard plant-machinery amber. */
  warn: 0xffa022,
  /** Access module. A different hue from every threat signal on the unit, so
   *  "objective" and "danger" are never the same colour on screen. */
  module: 0x46f0c8,
  /** Vent plume. Barely-lit water vapour, not fire. */
  steam: 0xbcd2dc,
} as const;

export function buildGatekeeper(mats: MaterialLibrary): GatekeeperRig {
  const owned: THREE.BufferGeometry[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => {
    owned.push(g);
    return g;
  };

  // Painted plant machinery for the load-bearing armour, bare steel for the
  // mechanism. The visual difference between "the thing that stops bullets"
  // and "the thing that moves" is worth one material break.
  const painted = mats.steelPainted();
  const bare = mats.steelBare();
  const belt = mats.rubber();
  const chevron = mats.hazard();
  const caddy = mats.plasticWhite();

  /**
   * Merges parts into a single mesh. Identical in spirit to EnemySoldier's -
   * a part earns its own draw call by MOVING or by wearing a different
   * material, and by nothing else.
   */
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
    return mesh;
  };

  /** Cylinder lying along X - road wheels, sprockets, cross-shafts. */
  const shaft = (radius: number, length: number, segments = 12): THREE.BufferGeometry => {
    const g = keep(new THREE.CylinderGeometry(radius, radius, length, segments));
    g.rotateZ(Math.PI / 2);
    return g;
  };

  const root = new THREE.Group();
  root.name = 'Gatekeeper';

  // ==================================================================
  // CHASSIS - hull, tracks' running gear, skirts
  // ==================================================================
  //
  // Root origin sits on the ground between the tracks, so `spawn(position)`
  // takes a floor position exactly like an enemy spawn does. Everything here
  // is one merged painted-steel mesh: the hull never deforms and never
  // articulates, so splitting it would buy nothing but draw calls.
  //
  // The SILHOUETTE RULE applied here: wide and low. 2.6m across the skirts
  // against 0.9m for a soldier, but only ~1.5m tall at the deck. The player
  // should read "I cannot get past this" and "it cannot follow me up there"
  // from the proportions alone.
  const chassisParts: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [
    // Hull tub.
    [keep(chamferBox(1.9, 0.8, 2.55, 0.06, 2)), trs(0, 1.0, 0)],
    // Sloped glacis. A raked front plate is the single cheapest way to say
    // "armoured vehicle" rather than "box on tracks".
    [keep(chamferBox(1.8, 0.55, 0.3, 0.05, 2)), trs(0, 0.8, 1.22, -0.55)],
    // Rear counterweight. Also justifies the module sitting so far back.
    [keep(chamferBox(1.7, 0.62, 0.42, 0.05, 2)), trs(0, 0.95, -1.28)],
    // Turret ring. Conical so the join reads as a bearing, not a seam.
    [keep(new THREE.CylinderGeometry(0.78, 0.88, 0.24, 16)), trs(0, 1.45, 0)],
    // Bumper / tow lugs.
    [keep(chamferBox(1.5, 0.18, 0.16, 0.04, 1)), trs(0, 0.42, 1.48)],
  ];
  for (const side of [-1, 1]) {
    chassisParts.push(
      // Fender over the track.
      [keep(chamferBox(0.52, 0.16, 3.05, 0.04, 1)), trs(side * 1.06, 0.86, 0)],
      // Side skirt. Hides the top of the belt and gives the profile a long
      // horizontal line, which is what makes it read as heavy.
      [keep(chamferBox(0.1, 0.52, 2.85, 0.03, 1)), trs(side * 1.32, 0.55, 0)],
      // Drive sprocket (rear) and idler (front).
      [shaft(0.3, 0.3), trs(side * 1.06, 0.45, -1.31)],
      [shaft(0.24, 0.3), trs(side * 1.06, 0.45, 1.31)],
      // Suspension arms.
      [keep(chamferBox(0.1, 0.3, 0.12, 0.02, 1)), trs(side * 0.98, 0.55, -0.63)],
      [keep(chamferBox(0.1, 0.3, 0.12, 0.02, 1)), trs(side * 0.98, 0.55, 0)],
      [keep(chamferBox(0.1, 0.3, 0.12, 0.02, 1)), trs(side * 0.98, 0.55, 0.63)],
      // Hull ram / lift piston running up to the glacis.
      [keep(new THREE.CylinderGeometry(0.055, 0.055, 0.7, 8)), trs(side * 0.86, 0.98, 1.0, 0.6)],
      // Exhaust stack. Vertical lines break up an otherwise very horizontal
      // shape and read at 40m when the detail does not.
      [keep(new THREE.CylinderGeometry(0.085, 0.095, 0.6, 8)), trs(side * 0.56, 1.5, -1.15)],
    );
  }
  root.add(meshFrom(chassisParts, painted, 'gkChassis'));

  // ==================================================================
  // TRACKS - one merged rubber mesh for both belts
  // ==================================================================
  //
  // The belts do not scroll. There is no cheap way to animate them without
  // either a per-instance material (kills batching) or a vertex shader (a
  // one-off material, which the project bans where a library material fits).
  // Motion is instead sold by the chassis PITCHING when it starts and stops -
  // see GatekeeperPose.hullPitch. At the ranges this fight happens at, a
  // suspension that reacts is far more convincing than a texture that slides.
  const trackParts: Array<[THREE.BufferGeometry, THREE.Matrix4]> = [];
  for (const side of [-1, 1]) {
    trackParts.push(
      // Upper and lower runs of the belt.
      [keep(chamferBox(0.44, 0.13, 2.62, 0.03, 1)), trs(side * 1.06, 0.8, 0)],
      [keep(chamferBox(0.44, 0.13, 2.62, 0.03, 1)), trs(side * 1.06, 0.1, 0)],
      // The curved ends, which is what stops the belt reading as two planks.
      [shaft(0.35, 0.44, 14), trs(side * 1.06, 0.45, 1.31)],
      [shaft(0.35, 0.44, 14), trs(side * 1.06, 0.45, -1.31)],
    );
    for (const z of [-0.95, -0.32, 0.32, 0.95]) {
      trackParts.push([shaft(0.24, 0.34), trs(side * 1.06, 0.32, z)]);
    }
  }
  root.add(meshFrom(trackParts, belt, 'gkTracks'));

  // ==================================================================
  // TURRET - the rotating superstructure
  // ==================================================================
  //
  // Everything that must face the player hangs off this: shield, vent, arm,
  // head, and the module on the back. The controller rate-limits its yaw, and
  // THAT is the mechanic behind the handler's "work the sides" line - a player
  // who strafes hard can out-turn it and see hull, a player who stands still
  // only ever sees shield.
  const turret = new THREE.Group();
  turret.name = 'gkTurret';
  turret.position.y = 1.55;
  root.add(turret);

  turret.add(
    meshFrom(
      [
        [keep(chamferBox(1.52, 0.74, 1.3, 0.06, 2)), trs(0, 0.3, 0)],
        // Shoulder yoke for the work arm, on the right only. Asymmetry is what
        // stops a machine reading as a prop; a symmetrical unit looks placed,
        // an asymmetric one looks built for a job.
        [keep(chamferBox(0.34, 0.46, 0.46, 0.05, 1)), trs(0.86, 0.05, 0.12)],
        // Shield hinge posts.
        [keep(chamferBox(0.2, 0.66, 0.24, 0.04, 1)), trs(-0.8, -0.06, 0.9)],
        [keep(chamferBox(0.2, 0.66, 0.24, 0.04, 1)), trs(0.8, -0.06, 0.9)],
        // Module cradle on the back.
        [keep(chamferBox(0.92, 0.6, 0.2, 0.04, 1)), trs(0, 0.34, -0.68)],
        // Neck collar. Sits at the head pivot so head rotation cannot open a
        // seam - the same trick EnemySoldier uses at the soldier's neck.
        [keep(new THREE.CylinderGeometry(0.26, 0.34, 0.3, 12)), trs(0, 0.72, 0.05)],
        // Visor hood over the sensor. Gives the head a brow, which is what
        // makes a lens read as an eye rather than as a lamp.
        [keep(chamferBox(0.78, 0.14, 0.4, 0.03, 1)), trs(0, 0.86, 0.34, -0.3)],
      ],
      painted,
      'gkTurretBody',
    ),
  );

  // ==================================================================
  // SENSOR HEAD
  // ==================================================================
  //
  // Pans and tilts independently of the turret and LEADS it, exactly as the
  // soldier's head leads his torso. On a machine this is doing something
  // slightly different though: because the head can track the player while the
  // shield is still swinging round, the player gets an unambiguous "it has
  // seen me" beat that is separate from "it is aimed at me".
  const head = new THREE.Group();
  head.name = 'gkHead';
  head.position.set(0, 0.86, 0.05);
  turret.add(head);

  head.add(
    meshFrom(
      [
        [keep(chamferBox(0.56, 0.34, 0.44, 0.05, 2)), trs(0, 0.06, 0)],
        // Lens hood.
        [keep(new THREE.CylinderGeometry(0.19, 0.21, 0.14, 12)), trs(0, 0.06, 0.24, Math.PI / 2)],
        // Side pods (secondary sensors).
        [keep(chamferBox(0.1, 0.2, 0.26, 0.02, 1)), trs(-0.33, 0.06, -0.02)],
        [keep(chamferBox(0.1, 0.2, 0.26, 0.02, 1)), trs(0.33, 0.06, -0.02)],
        // Comms mast. One thin vertical line, for the same reason the soldier
        // has an antenna: it makes the silhouette legible when the unit is a
        // few dozen pixels tall.
        [keep(new THREE.CylinderGeometry(0.03, 0.042, 0.55, 6)), trs(-0.21, 0.42, -0.1, 0, 0, 0.1)],
        [keep(chamferBox(0.5, 0.05, 0.06, 0.01, 1)), trs(0, 0.25, -0.08)],
      ],
      bare,
      'gkSensorHead',
    ),
  );

  // The eye. Emissive materials are pooled by key in MaterialLibrary, and the
  // controller writes emissiveIntensity/emissive on them every frame - which
  // is only safe because there is exactly ONE Gatekeeper in the mission. If a
  // second one is ever spawned they will share a lens colour; that is a known
  // and accepted limit, identical to the soldier strobe's.
  const lens = meshFrom(
    [
      [scaledGeo(keep(new THREE.SphereGeometry(0.145, 14, 10)), 1, 1, 0.62), trs(0, 0.06, 0.27)],
      [keep(new THREE.TorusGeometry(0.155, 0.022, 6, 16)), trs(0, 0.06, 0.28)],
    ],
    mats.emissive('gkLens', COLOR.lens, 3),
    'gkLens',
    false,
  );
  head.add(lens);

  // ==================================================================
  // FRONT SHIELD - the core of the fight
  // ==================================================================
  //
  // Two leaves on vertical hinges at the turret's front corners. Two axes:
  //
  //   shieldDeploy  hinge.rotation.x   stowed flat over the hull -> up, locked
  //   shieldOpen    hinge.rotation.y   closed -> thrown wide like double doors
  //
  // Splitting deploy from open matters. Deploy is the "it has noticed you"
  // beat and happens once; open is the vent tell and happens every cycle. If
  // both were one number the player could not tell the two events apart, and
  // the vent is the only window they have.
  //
  // The leaves are the ONE place the unit spends draw calls freely: four
  // meshes for two leaves, because the hazard chevron has to be a separate
  // material and because each leaf moves on its own. The alternative - a
  // single plate that tilts - was rejected: a clamshell parting in the middle
  // puts the opening exactly where the player is already aiming.
  const shieldHinges: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const hinge = shieldHinges[i];
    hinge.name = i === 0 ? 'gkShieldL' : 'gkShieldR';
    hinge.position.set(side * 0.8, -0.15, 0.94);
    turret.add(hinge);

    // Plate extends INWARD from the hinge, so the two leaves meet on the
    // centreline when closed and expose the coil dead ahead when they part.
    const inward = -side;
    hinge.add(
      meshFrom(
        [
          [keep(chamferBox(0.86, 1.52, 0.13, 0.035, 2)), trs(inward * 0.44, 0.62, 0)],
          // Stiffening rib. Real armour is ribbed, and the rib catches a
          // highlight that separates the plate from the dark hull behind it.
          [keep(chamferBox(0.1, 1.4, 0.09, 0.02, 1)), trs(inward * 0.44, 0.62, 0.1)],
          // Hinge boss, on the rotation axis so no angle opens a gap.
          [keep(new THREE.CylinderGeometry(0.095, 0.095, 1.6, 10)), trs(0, 0.6, 0)],
          // Top lip, angled forward. Gives the shield a brow of its own.
          [keep(chamferBox(0.86, 0.14, 0.24, 0.03, 1)), trs(inward * 0.44, 1.35, 0.05, -0.35)],
        ],
        painted,
        `gkShieldPlate${i}`,
      ),
    );
    // HAZARD CHEVRON on the leading edge and the foot of each leaf.
    // This is not decoration - it is the tutorial. Diagonal yellow-black on
    // the exact surface the player must not shoot is understood instantly and
    // never has to be said out loud.
    hinge.add(
      meshFrom(
        [
          [keep(chamferBox(0.16, 1.5, 0.17, 0.02, 1)), trs(inward * 0.85, 0.62, 0.02)],
          [keep(chamferBox(0.86, 0.16, 0.17, 0.02, 1)), trs(inward * 0.44, -0.12, 0.02)],
        ],
        chevron,
        `gkShieldTrim${i}`,
      ),
    );
  }

  // ==================================================================
  // VENT ASSEMBLY - housing and the coil weak point
  // ==================================================================
  //
  // Deliberately mounted low and central on the turret front, INSIDE the arc
  // the closed shield covers. Sight-line honesty is the whole design: if the
  // player can see the coil, they can shoot it, and if they cannot see it,
  // nothing they do to the front matters. There is no invisible rule.
  turret.add(
    meshFrom(
      [
        [keep(chamferBox(0.92, 0.62, 0.3, 0.05, 2)), trs(0, -0.1, 0.55)],
        // Louvre fins across the intake.
        [keep(chamferBox(0.84, 0.05, 0.1, 0.012, 1)), trs(0, -0.34, 0.7)],
        [keep(chamferBox(0.84, 0.05, 0.1, 0.012, 1)), trs(0, -0.22, 0.7)],
        [keep(chamferBox(0.84, 0.05, 0.1, 0.012, 1)), trs(0, 0.1, 0.7)],
        // Side ducts running back into the hull.
        [shaft(0.1, 0.34, 10), trs(-0.52, -0.1, 0.52)],
        [shaft(0.1, 0.34, 10), trs(0.52, -0.1, 0.52)],
        // Bezel ring around the coil. Frames the weak point so it reads as a
        // deliberate aperture rather than as battle damage.
        [keep(new THREE.TorusGeometry(0.3, 0.055, 8, 18)), trs(0, -0.08, 0.66)],
      ],
      bare,
      'gkVentHousing',
    ),
  );

  // THE WEAK POINT.
  //
  // Its idle intensity is near zero and its vent intensity is enormous - a 60x
  // swing, not a 2x one. The brief asks for an unmissable tell, and bloom is
  // multiplicative, so anything less than an order of magnitude just looks
  // like the light changed. At full vent this is by a wide margin the
  // brightest object in the yard.
  const coil = meshFrom(
    [
      [keep(new THREE.SphereGeometry(0.2, 14, 10)), trs(0, -0.08, 0.68)],
      [keep(new THREE.TorusGeometry(0.24, 0.035, 6, 16)), trs(0, -0.08, 0.6)],
      [keep(new THREE.TorusGeometry(0.155, 0.03, 6, 14)), trs(0, -0.08, 0.79)],
    ],
    mats.emissive('gkCoil', COLOR.coil, 0.2),
    'gkCoil',
    false,
  );
  turret.add(coil);

  // Vent plume. Nested spheres scaled up from nothing and faded out, which is
  // a cheap silhouette-level read of escaping vapour. It is a SEPARATE tell
  // from the coil bloom on purpose: bloom is lost against the sodium lamps at
  // some angles, but a shape that grows is readable everywhere. The particle
  // workstream can layer real steam on the `gatekeeper:vent` event; this mesh
  // guarantees the tell exists even if it never does.
  const steamMat = mats.emissive('gkSteam', COLOR.steam, 0.8);
  steamMat.transparent = true;
  steamMat.depthWrite = false;
  steamMat.opacity = 0;
  const steam = meshFrom(
    [
      [keep(new THREE.SphereGeometry(0.32, 10, 8)), trs(0, 0.02, 0.95)],
      [keep(new THREE.SphereGeometry(0.24, 10, 8)), trs(-0.26, 0.18, 1.16)],
      [keep(new THREE.SphereGeometry(0.21, 10, 8)), trs(0.27, 0.12, 1.12)],
      [keep(new THREE.SphereGeometry(0.16, 8, 6)), trs(0, 0.36, 1.34)],
    ],
    steamMat,
    'gkSteam',
    false,
  );
  steam.visible = false;
  turret.add(steam);

  // ==================================================================
  // WORK / SECURITY ARM
  // ==================================================================
  //
  // Not a weapon. It is a manipulator with a clamp, which is the point: this
  // unit was built to move pallets and has been repurposed to stop people. It
  // also does the encounter a favour - the arm sweeping up is a wind-up the
  // player can see before pressure starts, and it folds in during the vent,
  // which reinforces "this thing is currently busy".
  const arm = new THREE.Group();
  arm.name = 'gkArm';
  arm.position.set(0.9, 0.05, 0.14);
  turret.add(arm);
  arm.add(
    meshFrom(
      [
        // Shoulder ball ON the pivot - the joint rule from EnemySoldier: a
        // sphere rotating about its own centre cannot open a gap.
        [keep(new THREE.SphereGeometry(0.18, 10, 8)), trs(0, 0, 0)],
        [keep(chamferBox(0.24, 0.78, 0.26, 0.04, 1)), trs(0, -0.36, 0)],
        [keep(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 8)), trs(0.14, -0.3, 0.12)],
      ],
      bare,
      'gkArmUpper',
    ),
  );

  const elbow = new THREE.Group();
  elbow.position.y = -0.72;
  arm.add(elbow);
  elbow.add(
    meshFrom(
      [
        [keep(new THREE.SphereGeometry(0.14, 10, 8)), trs(0, 0, 0)],
        [keep(chamferBox(0.2, 0.62, 0.22, 0.035, 1)), trs(0, -0.3, 0)],
        // Clamp jaws, splayed slightly open.
        [keep(chamferBox(0.07, 0.28, 0.1, 0.02, 1)), trs(-0.1, -0.7, 0.02, 0, 0, 0.26)],
        [keep(chamferBox(0.07, 0.28, 0.1, 0.02, 1)), trs(0.1, -0.7, 0.02, 0, 0, -0.26)],
        [keep(new THREE.CylinderGeometry(0.02, 0.055, 0.24, 8)), trs(0, -0.74, -0.08)],
      ],
      bare,
      'gkArmFore',
    ),
  );

  // Suppressive fire originates from a port under the shield brow rather than
  // from the arm: rounds must not appear to come out of a clamp, and a fixed
  // muzzle means the tracer origin never swings around during the arm sweep.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.34, 0.36, 0.78);
  turret.add(muzzle);

  // ==================================================================
  // ACCESS MODULE - the objective, worn on its back
  // ==================================================================
  //
  // Pale shell against a dark unit, lit in a hue used nowhere else on the
  // model. The player has to want it before the handler mentions it, and the
  // only way to see it clearly is to get behind the thing - which is also the
  // only place hull damage lands. Objective and correct positioning are the
  // same lesson.
  //
  // Parented through its own mount group so death can reparent it to the
  // world with one call, preserving its world transform.
  const moduleMount = new THREE.Group();
  moduleMount.name = 'gkModuleMount';
  moduleMount.position.set(0, 0.34, -0.82);
  turret.add(moduleMount);

  moduleMount.add(
    meshFrom(
      [
        [keep(chamferBox(0.6, 0.42, 0.3, 0.05, 2)), trs(0, 0, 0)],
        [keep(chamferBox(0.3, 0.07, 0.1, 0.02, 1)), trs(0, 0.26, 0)],
        [keep(chamferBox(0.08, 0.1, 0.34, 0.02, 1)), trs(-0.32, -0.06, 0)],
        [keep(chamferBox(0.08, 0.1, 0.34, 0.02, 1)), trs(0.32, -0.06, 0)],
      ],
      caddy,
      'gkModuleShell',
    ),
  );
  const moduleGlow = meshFrom(
    [
      [keep(chamferBox(0.46, 0.08, 0.06, 0.015, 1)), trs(0, 0.07, -0.17)],
      [keep(new THREE.SphereGeometry(0.052, 10, 8)), trs(0, -0.1, -0.18)],
      [keep(chamferBox(0.05, 0.24, 0.05, 0.012, 1)), trs(-0.31, 0.02, -0.1)],
      [keep(chamferBox(0.05, 0.24, 0.05, 0.012, 1)), trs(0.31, 0.02, -0.1)],
    ],
    mats.emissive('gkModule', COLOR.module, 5),
    'gkModuleGlow',
    false,
  );
  moduleMount.add(moduleGlow);

  // ==================================================================
  // WARNING BEACONS
  // ==================================================================
  //
  // Four amber domes. They exist for the same reason the soldiers carry an IR
  // strobe: this level is dark and cinematic, and the answer to "can you find
  // the enemy" must never be "turn the ambient up until the image is flat".
  // Their blink RATE is state, not decoration - slow while dormant, hard and
  // fast once engaged, dead the instant it dies.
  const warnLights = meshFrom(
    [
      [keep(new THREE.SphereGeometry(0.08, 10, 8)), trs(-0.64, 0.7, -0.54)],
      [keep(new THREE.SphereGeometry(0.08, 10, 8)), trs(0.64, 0.7, -0.54)],
      [keep(new THREE.SphereGeometry(0.07, 10, 8)), trs(-0.7, 0.62, 0.42)],
      [keep(new THREE.SphereGeometry(0.07, 10, 8)), trs(0.7, 0.62, 0.42)],
    ],
    mats.emissive('gkWarn', COLOR.warn, 2),
    'gkWarnLights',
    false,
  );
  turret.add(warnLights);

  root.traverse((node) => node.layers.set(LAYER.WORLD));

  // ------------------------------------------------------------------
  // Pose application
  // ------------------------------------------------------------------
  //
  // Kept in the rig rather than the controller so the controller only ever
  // deals in gameplay quantities (timers, health, heat) and never in hinge
  // offsets. That separation is what lets the shield geometry be re-authored
  // without touching a line of fight logic.
  const apply = (pose: GatekeeperPose): void => {
    root.rotation.y = pose.hullYaw;
    root.rotation.x = pose.hullPitch;
    root.rotation.z = pose.hullRoll;

    turret.rotation.y = pose.turretYaw - pose.hullYaw;

    head.rotation.y = pose.headYaw;
    head.rotation.x = pose.headPitch;

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      // Deploy: 1.45 rad of stow tilts the leaves back flat over the hull.
      shieldHinges[i].rotation.x = (1 - pose.shieldDeploy) * 1.45;
      // Open: leaves swing away from the centreline. The sign is per-side and
      // getting it wrong folds the shield INTO the vent, so it is derived
      // from `side` rather than written twice.
      shieldHinges[i].rotation.y = side * pose.shieldOpen * 0.95;
    }

    arm.rotation.x = pose.armPitch;
    elbow.rotation.x = pose.armElbow;
  };

  // Start stowed and closed so a spawned-but-dormant unit reads as parked.
  apply({
    hullYaw: 0,
    turretYaw: 0,
    headYaw: 0,
    headPitch: 0,
    shieldDeploy: 0,
    shieldOpen: 0,
    armPitch: 0.35,
    armElbow: 0.9,
    hullPitch: 0,
    hullRoll: 0,
  });

  return {
    root,
    turret,
    head,
    shieldHinges,
    arm,
    elbow,
    moduleMount,
    lens,
    coil,
    warnLights,
    moduleGlow,
    steam,
    muzzle,
    // Hit volumes. Root-local, so the controller only has to undo the root
    // transform once per shot instead of maintaining world-space copies.
    hullOffset: new THREE.Vector3(0, 1.35, -0.1),
    hullRadius: 1.45,
    coilOffset: new THREE.Vector3(0, 1.47, 0.68),
    coilRadius: 0.44,
    shieldOffset: new THREE.Vector3(0, 2.05, 1.05),
    shieldRadius: 1.25,
    apply,
    dispose(): void {
      for (const g of owned) g.dispose();
      owned.length = 0;
    },
  };
}

/** Non-uniform scale in place - squashed lenses and domes. */
function scaledGeo(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  g.scale(x, y, z);
  return g;
}
