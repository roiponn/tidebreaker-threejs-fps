import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { chamferBox, trs } from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import {
  createPartFactory,
  ductRing,
  lensDisc,
  robotMaterials,
  rotorBlades,
  type Part,
  type RobotRig,
} from './RobotKit';

/**
 * SCOUT - light recon drone.
 *
 * Role, because the shape follows from it: this thing finds you and tells
 * everyone else. It is not a fight, it is a timer. Low health, a token chin
 * gun, and the only interesting decision it forces is "do I spend a magazine
 * and my position shooting it down before it calls this in".
 *
 * THE SILHOUETTE PROBLEM, and how this rig solves it.
 *
 * Scout and Sentinel have to be told apart at 40m in a wet dusk, in maybe a
 * fifth of a second, by a player who is already busy. That is far too little
 * time to read surface detail, so the two units are separated on the three
 * channels that survive distance:
 *
 *   1. ORIENTATION. Scout is a WIDE, FLAT, HORIZONTAL cross - about 1.1m across
 *      and 0.25m tall. Sentinel is a TALL VERTICAL BLOCK. At any range where
 *      both are a smudge, the smudges are still landscape versus portrait.
 *   2. ALTITUDE. Scout hovers at head height and above the skyline of the
 *      containers it patrols; Sentinel is always sitting on the deck. A
 *      silhouette against sky is a different read from one against clutter.
 *   3. LIGHT SHAPE. Scout's tell is a single round POINT of cyan. Sentinel's is
 *      a horizontal BAR of it. Dot versus dash is the most robust distinction
 *      that survives bloom, fog and a half-pixel target.
 *
 * Everything else on this model - the tail fin, the duct rings, the nose rake -
 * exists to reinforce channel 1. There is no greeble on this rig at all; it
 * would not survive to the screen, and the bosses need the detail budget more.
 *
 * DRAW CALLS: 4 while passive, 5 once the alarm beacon lights. Everything that
 * does not move independently is one merged hull mesh.
 */
export interface ScoutRig extends RobotRig {
  root: THREE.Group;
  /**
   * The airframe. Everything above the ground; bob, pitch and roll go here so
   * the root stays a clean ground-plane anchor like the soldier's.
   */
  chassis: THREE.Group;
  /** Gimbal ball. Yaw/pitch this to track the player - it is the whole "AI". */
  sensorHead: THREE.Group;
  rotorLeft: THREE.Group;
  rotorRight: THREE.Group;
  sensorMesh: THREE.Mesh;
  /**
   * Hidden until the drone has actually called it in. Toggle `.visible`, never
   * the material colour - see the pooling note in RobotKit.
   */
  alarmBeacon: THREE.Mesh;
  muzzle: THREE.Object3D;
  dispose(): void;
}

/**
 * Resting hover height of the airframe above the drone's ground anchor.
 *
 * 1.45m is chosen against the player, not against realism: it puts the sensor
 * eye just above a standing player's eyeline, so the drone is a natural target
 * without being a neck-craning one, and it clears the 1.2m concrete barriers on
 * the berth so the silhouette is never cut in half by cover.
 *
 * Exported because the spawner needs it to place a drone at a sensible altitude
 * and the animator needs it as the centre the bob oscillates around. A magic
 * 1.45 copied into three files is how those three drift apart.
 */
export const SCOUT_HOVER_HEIGHT = 1.45;

export function buildScout(mats: MaterialLibrary): ScoutRig {
  const parts = createPartFactory();
  const mat = robotMaterials(mats);

  const root = new THREE.Group();
  root.name = 'ScoutDrone';

  const chassis = new THREE.Group();
  chassis.position.y = SCOUT_HOVER_HEIGHT;
  root.add(chassis);

  // ------------------------------------------------------------------
  // HULL - one mesh, one draw call, everything rigid.
  // ------------------------------------------------------------------
  // The nose sections sit a centimetre low rather than the whole chassis being
  // pitched forward. A rake baked into the GEOMETRY survives the animator
  // writing `chassis.rotation.x` every frame; a rest pose stored on the group
  // itself would be overwritten on the first update and the drone would go
  // spirit-level flat the moment it started moving.
  const hullParts: Part[] = [
    // Central body. Long and thin: the fore/aft length is what stops the drone
    // reading as a floating brick when seen from directly ahead.
    [chamferBox(0.34, 0.13, 0.46, 0.03, 2), trs(0, 0, 0)],
    [chamferBox(0.26, 0.10, 0.20, 0.025, 2), trs(0, -0.012, 0.30)],

    // Tail boom and fin. The fin is the cheapest possible asymmetry and it is
    // doing real work: it is what tells the player which way the drone is
    // FACING at a range where the sensor eye is one pixel. A symmetrical disc
    // drone gives you no heading information at all, and heading is what the
    // player needs to know whether they have been seen.
    [chamferBox(0.08, 0.06, 0.26, 0.015, 1), trs(0, 0.012, -0.34)],
    [chamferBox(0.025, 0.24, 0.20, 0.01, 1), trs(0, 0.13, -0.44)],

    // Outrigger arms out to the fans. Kept as plain bars because they are read
    // as a line, never as a surface.
    [chamferBox(0.30, 0.05, 0.10, 0.015, 1), trs(-0.26, 0.02, 0.02)],
    [chamferBox(0.30, 0.05, 0.10, 0.015, 1), trs(0.26, 0.02, 0.02)],

    // Fan shrouds. These are the widest points and therefore ARE the landscape
    // silhouette; the rings also stop the spinning rotors from reading as loose
    // floating blades.
    [ductRing(0.145, 0.026), trs(-0.40, 0.03, 0.02)],
    [ductRing(0.145, 0.026), trs(0.40, 0.03, 0.02)],

    // Chin gun. Deliberately stubby - the weapon should look like an
    // afterthought, because the drone's threat is the radio, not the gun, and
    // the player should be able to see that from the model.
    [chamferBox(0.10, 0.08, 0.26, 0.015, 1), trs(0, -0.10, 0.20)],

    // GIMBAL CRADLE. This belongs to the HULL, not to the sensor head, for the
    // same reason the soldier's pauldrons belong to the torso: a fixed frame
    // with a moving element inside it is what makes rotation legible. If the
    // cradle turned with the eye there would be nothing stationary to read the
    // motion against.
    [chamferBox(0.03, 0.15, 0.15, 0.01, 1), trs(-0.12, -0.01, 0.40)],
    [chamferBox(0.03, 0.15, 0.15, 0.01, 1), trs(0.12, -0.01, 0.40)],
    [chamferBox(0.27, 0.03, 0.13, 0.01, 1), trs(0, 0.07, 0.40)],
  ];
  chassis.add(parts.merged(hullParts, mat.shell, 'scoutHull'));

  // ------------------------------------------------------------------
  // ROTORS - two meshes, and the only reason this rig is not three total.
  // ------------------------------------------------------------------
  // They cannot be merged into one: two rotors spinning about two different
  // off-centre axes is not expressible as one rigid transform, and faking it by
  // spinning a single merged mesh about the drone's centre makes the fans ORBIT
  // the hull instead of turning in place. Two draw calls is the honest price of
  // the strongest "this thing is flying" cue on the model.
  //
  // No shadows: thin fast-moving blades produce nothing but shadow-map aliasing
  // and they are inside a shroud that already casts a proper shadow.
  const makeRotor = (side: number): THREE.Group => {
    const group = new THREE.Group();
    group.position.set(side * 0.40, 0.03, 0.02);
    const mesh = parts.mesh(rotorBlades(0.125, 0.05, 0.026), mat.frame, 'scoutRotor');
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    // Counter-rotating in the rest pose so the two discs are never in phase.
    // In-phase rotors read as one wide bar flickering; out of phase they read
    // as two independent machines, which is what a quadrotor looks like.
    group.rotation.y = side > 0 ? 0.52 : 0;
    return group;
  };
  const rotorLeft = makeRotor(-1);
  const rotorRight = makeRotor(1);
  chassis.add(rotorLeft, rotorRight);

  // ------------------------------------------------------------------
  // SENSOR - the visual tell.
  // ------------------------------------------------------------------
  const sensorHead = new THREE.Group();
  sensorHead.position.set(0, -0.01, 0.40);
  chassis.add(sensorHead);

  const sensorMesh = parts.mesh(lensDisc(0.082), mat.sensor, 'scoutEye');
  // An emissive lens must not cast shadows: the shadow of a light source is a
  // contradiction the eye notices immediately, and it costs a shadow-map draw
  // for a 16cm object.
  sensorMesh.castShadow = false;
  sensorMesh.receiveShadow = false;
  sensorHead.add(sensorMesh);

  // ------------------------------------------------------------------
  // ALARM BEACON - a state readout, not decoration.
  // ------------------------------------------------------------------
  // Mounted on the spine, on TOP, because the moment it matters is the moment
  // the player is trying to decide whether to break cover; it has to be visible
  // from behind and from below, which the nose-mounted eye is not.
  //
  // It is a separate hidden mesh rather than a colour change on the eye because
  // MaterialLibrary pools emissive materials by key: recolouring the eye would
  // recolour every robot on the level, including the ones that have not seen
  // anybody. `.visible` is per-object and free.
  const alarmBeacon = parts.mesh(new THREE.SphereGeometry(0.036, 10, 8), mat.alarm, 'scoutAlarm');
  alarmBeacon.position.set(0, 0.125, -0.06);
  alarmBeacon.castShadow = false;
  alarmBeacon.receiveShadow = false;
  alarmBeacon.visible = false;
  chassis.add(alarmBeacon);

  // Muzzle empty at the tip of the chin gun. An Object3D, so it is free.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -0.10, 0.34);
  chassis.add(muzzle);

  root.traverse((node) => node.layers.set(LAYER.WORLD));

  // Published rather than hard-coded in a comment, because a comment saying
  // "this rig is 5 draw calls" is wrong the first time somebody adds a mesh and
  // nobody finds out until the frame budget is gone. The debug panel reads it.
  root.userData.drawCalls = parts.drawCalls;

  return {
    root,
    chassis,
    sensorHead,
    rotorLeft,
    rotorRight,
    sensorMesh,
    alarmBeacon,
    muzzle,
    // HIT VOLUMES. A drone has no neck, so "head" and "torso" nearly coincide;
    // they are kept as two spheres purely so the same hitscan code path serves
    // robots and soldiers. Both are ON THE YAW AXIS on purpose - the drone
    // spins to face the player constantly, and an off-axis offset would have to
    // be re-transformed every frame to stay meaningful.
    headOffset: new THREE.Vector3(0, SCOUT_HOVER_HEIGHT + 0.02, 0),
    torsoOffset: new THREE.Vector3(0, SCOUT_HOVER_HEIGHT - 0.02, 0),
    // The scout's weak point IS its eye. It is too small to carry a second
    // exposed subsystem, and a unit this simple should teach one lesson only:
    // shoot the glowing bit. Sentinel is where that lesson gets complicated.
    //
    // THE TRAP, same as SENTINEL's: this one is NOT on the yaw axis - the eye
    // is 0.40m out on the nose, which is nearly half the airframe. The value
    // below is only correct at zero yaw. Anything that needs the real position
    // has to use `sensorMesh.getWorldPosition()`.
    weakPointOffset: new THREE.Vector3(0, SCOUT_HOVER_HEIGHT - 0.01, 0.40),
    weakPoint: sensorMesh,
    dispose(): void {
      parts.dispose();
    },
  };
}
