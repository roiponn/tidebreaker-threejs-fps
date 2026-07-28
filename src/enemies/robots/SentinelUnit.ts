import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { chamferBox, trs } from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';
import {
  createPartFactory,
  metreUv,
  robotMaterials,
  trackLoop,
  type Part,
  type RobotRig,
} from './RobotKit';

/**
 * SENTINEL - armoured tracked ground unit. The main exterior enemy.
 *
 * This is the model the player will spend the most time looking at, which makes
 * it the model most at risk of being over-built. It is deliberately held below
 * the bosses: eight meshes, no surface greeble, and every form large enough to
 * be a silhouette element in its own right. If a part cannot be identified from
 * 40m it should not be on this rig - it is stealing detail budget from the
 * encounter the level is actually building towards.
 *
 * SILHOUETTE, versus SCOUT (see the long note in ScoutDrone.ts):
 *   - Sentinel is PORTRAIT. Roughly 2.0m tall, 1.45m wide, 1.9m long, and
 *     always on the deck. Scout is landscape and always airborne.
 *   - Sentinel's light tell is a horizontal BAR - a cyclops visor slot across
 *     the sensor head. Scout's is a round dot. Dash versus dot survives fog,
 *     bloom and a two-pixel target; colour and shape detail do not.
 *   - The top edge is deliberately broken by exactly two things, the sensor
 *     head and the power core, at almost the same height. Two horns on a heavy
 *     block is an instantly memorable outline, and it is the shape the player
 *     will learn to fear before they can see anything else about the unit.
 *
 * THE WEAK POINT is the reason most of the rest of the geometry is arranged
 * the way it is - see the block below the torso.
 *
 * DRAW CALLS: 8. Budget them at 8 per unit when placing these.
 */
export interface SentinelRig extends RobotRig {
  root: THREE.Group;
  /**
   * Everything above the ground plane. Suspension pitch and roll go here - a
   * tracked hull that never dips when it starts and stops reads as a prop on
   * rails. The root stays a clean ground anchor.
   */
  hull: THREE.Group;
  /** Yaws to face the target. This is the unit's primary "attention" signal. */
  turret: THREE.Group;
  /** Pitches. Small range - it is a sensor mount, not a neck. */
  head: THREE.Group;
  /** Elevates with the shot. */
  weaponPod: THREE.Group;
  sensorMesh: THREE.Mesh;
  weakPoint: THREE.Mesh;
  muzzle: THREE.Object3D;
  dispose(): void;
}

/** Ground-plane offsets used by both the rig and anything placing one. */
const TRACK_RADIUS = 0.30;
const TURRET_HEIGHT = 0.76;

export function buildSentinel(mats: MaterialLibrary): SentinelRig {
  const parts = createPartFactory();
  const mat = robotMaterials(mats);

  const root = new THREE.Group();
  root.name = 'SentinelUnit';

  const hull = new THREE.Group();
  root.add(hull);

  // ------------------------------------------------------------------
  // RUNNING GEAR - one mesh for both tracks.
  // ------------------------------------------------------------------
  // Tracks do not articulate independently here (the unit steers by yawing the
  // whole hull, like a skid-steer), so there is no animation reason to keep
  // them apart and every draw-call reason to merge them. Tread plate is the
  // material because its raised diamond pattern reads as track grousers for
  // free - a bespoke track texture would be a whole new bake for a surface the
  // player mostly sees edge-on.
  hull.add(
    parts.merged(
      [
        [trackLoop(1.60, TRACK_RADIUS, 0.34), trs(-0.55, TRACK_RADIUS, 0)],
        [trackLoop(1.60, TRACK_RADIUS, 0.34), trs(0.55, TRACK_RADIUS, 0)],
      ],
      mat.track,
      'sentinelTracks',
    ),
  );

  // ------------------------------------------------------------------
  // LOWER HULL - one mesh.
  // ------------------------------------------------------------------
  // The deck is lifted clear of the ground between the tracks rather than
  // filling the gap. That shadow gap under the belly is what makes the unit
  // read as a VEHICLE with ground clearance instead of a box with tracks
  // painted on the sides, and it is visible from every angle a player will
  // ever fight this thing from.
  const chassisParts: Part[] = [
    [chamferBox(0.98, 0.46, 1.34, 0.05, 2), trs(0, 0.46, 0)],
    // Sloped glacis. A single angled plane across the front does more for
    // "armoured" than any amount of panel-line detail, because a slope catches
    // a different value from the vertical sides and splits the front of the
    // unit into two readable tones under one light.
    [chamferBox(0.92, 0.34, 0.40, 0.04, 2), trs(0, 0.55, 0.64, -0.55)],
    [chamferBox(0.86, 0.30, 0.22, 0.04, 1), trs(0, 0.52, -0.68)],
    // Side skirts. They close the visual gap between deck and track top so the
    // lower half stays one solid mass; without them the hull looks like it is
    // floating between two separate track units.
    [chamferBox(0.08, 0.34, 1.30, 0.02, 1), trs(-0.52, 0.50, 0)],
    [chamferBox(0.08, 0.34, 1.30, 0.02, 1), trs(0.52, 0.50, 0)],
    // Turret ring. Merged into the STATIC hull, not the turret, so the turret
    // appears to rotate inside a fixed collar - the same trick as the scout's
    // gimbal cradle, and the thing that makes a yaw legible at distance.
    [metreUv(new THREE.CylinderGeometry(0.38, 0.40, 0.12, 14)), trs(0, 0.70, 0)],
  ];
  hull.add(parts.merged(chassisParts, mat.shell, 'sentinelChassis'));

  // ------------------------------------------------------------------
  // TURRET / TORSO - one mesh.
  // ------------------------------------------------------------------
  const turret = new THREE.Group();
  turret.position.y = TURRET_HEIGHT;
  hull.add(turret);

  const torsoParts: Part[] = [
    // Main armour box. One big form. Everything the player needs to know about
    // "this is armoured, do not expect to chip it down" is carried by its size
    // and its unbroken faces; adding bolt heads would only make it smaller.
    [chamferBox(0.84, 0.86, 0.90, 0.06, 2), trs(0, 0.44, 0)],
    [chamferBox(0.78, 0.52, 0.14, 0.03, 2), trs(0, 0.46, 0.45, -0.30)],
    // Rear counterweight. Structurally it justifies the weapon pod's mass; more
    // usefully it makes the unit asymmetric front-to-back, so a player who has
    // flanked it can tell at a glance which way it is looking.
    [chamferBox(0.60, 0.40, 0.26, 0.04, 1), trs(0, 0.30, -0.52)],

    // ---- the weak-point structure, on the LEFT shoulder ----
    //
    // Placement is the whole design here, so: the core is mounted OUTBOARD of
    // the armour box, on an open yoke, on the opposite side from the weapon.
    //
    //  - Outboard, not recessed, so it is a separate sub-form on the outline.
    //    A glow inside a slot is a texture; a glowing cylinder sticking off the
    //    shoulder is a SHAPE, and shapes are what the player parses at speed.
    //  - Opposite the weapon pod, so the two things the player must identify -
    //    "what shoots me" and "what I shoot" - are never on the same side and
    //    can never be mistaken for each other.
    //  - High, at head height, so it breaks the top edge of the silhouette and
    //    is not occluded by the cover this unit fights from.
    //  - Slightly canted outward, so it stays visible through the full frontal
    //    arc instead of disappearing behind the shoulder at three-quarter view.
    //
    // The cage is deliberately OPEN on the outboard face. A player should be
    // able to see that there is nothing between them and the core, because the
    // whole point is that the weak point looks structurally unprotected.
    [chamferBox(0.30, 0.20, 0.46, 0.03, 1), trs(-0.50, 0.68, -0.04)],
    [chamferBox(0.05, 0.34, 0.05, 0.012, 1), trs(-0.60, 0.92, 0.14)],
    [chamferBox(0.05, 0.34, 0.05, 0.012, 1), trs(-0.60, 0.92, -0.22)],
    [chamferBox(0.28, 0.06, 0.48, 0.02, 1), trs(-0.50, 1.12, -0.04)],
  ];
  turret.add(parts.merged(torsoParts, mat.shell, 'sentinelTorso'));

  // ------------------------------------------------------------------
  // WEAK POINT - the exposed power/cooling core.
  // ------------------------------------------------------------------
  // A CYLINDER, on a rig where literally every other form is a chamfered box.
  // That is not a stylistic choice, it is the readability mechanism: the player
  // does not have to notice a colour or read a label, they just have to notice
  // that one part of this machine is not shaped like the rest of it. Silhouette
  // difference is the only channel that works at range, in fog, and for a
  // colour-blind player.
  //
  // It does not cast shadows - a glowing object throwing a shadow is a
  // contradiction the eye catches instantly, and it would put a hard dark bar
  // across the very thing the player is being asked to find.
  const weakPoint = parts.mesh(
    metreUv(new THREE.CylinderGeometry(0.115, 0.115, 0.30, 14)),
    mat.core,
    'sentinelCore',
  );
  weakPoint.position.set(-0.50, 0.93, -0.04);
  weakPoint.rotation.z = -0.16;
  weakPoint.castShadow = false;
  weakPoint.receiveShadow = false;
  turret.add(weakPoint);

  // Hazard collars sandwiching the core, top and bottom.
  //
  // Berth 7 is lit by sodium floods, which means "hot orange glow" is a colour
  // the scene already contains in quantity - a lamp, a fire, a muzzle flash.
  // The chevrons are what promotes this particular orange from "light source"
  // to "interface element": black-and-yellow diagonal stripes are the one
  // marking every player already reads as "danger, this bit specifically".
  // Colour alone was never going to carry this; the stripes are the contract.
  //
  // NOTE: these two cylinders keep their NATIVE UVs on purpose. The hazard
  // texture is repeated 4x around U, so the cylinder's wrap-around parameter
  // marches the chevrons round the collar. Re-projecting them to metre UVs like
  // the rest of the rig would planar-project the stripes and mirror them down
  // the middle of the collar.
  const collarParts: Part[] = [
    [new THREE.CylinderGeometry(0.155, 0.175, 0.075, 14), trs(0, -0.175, 0)],
    [new THREE.CylinderGeometry(0.175, 0.155, 0.075, 14), trs(0, 0.175, 0)],
  ];
  const collars = parts.merged(collarParts, mat.hazard, 'sentinelCoreCollar');
  // Parented to the core so the collars inherit the cant for free. If the cant
  // is ever tuned, this cannot drift out of alignment with it.
  weakPoint.add(collars);

  // ------------------------------------------------------------------
  // SENSOR HEAD - two meshes (housing + visor).
  // ------------------------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0, 0.92, 0.30);
  turret.add(head);

  // The brow overhang is the only piece of "detail" that earns its place on
  // this rig. It puts the visor slot permanently in shadow, so the emissive bar
  // is always read against a dark recess rather than against lit metal - which
  // is what keeps it legible when the unit walks into a sodium pool and the
  // surrounding plate goes bright.
  const headParts: Part[] = [
    [chamferBox(0.54, 0.22, 0.34, 0.035, 2), trs(0, 0, 0)],
    [chamferBox(0.60, 0.07, 0.14, 0.02, 1), trs(0, 0.13, 0.12)],
    [chamferBox(0.09, 0.15, 0.22, 0.02, 1), trs(-0.28, -0.01, -0.02)],
    [chamferBox(0.09, 0.15, 0.22, 0.02, 1), trs(0.28, -0.01, -0.02)],
  ];
  head.add(parts.merged(headParts, mat.frame, 'sentinelHead'));

  // THE BAR. This single mesh is the unit's identity at range - see the
  // silhouette note at the top of the file. It is wide and thin because the
  // distinction from SCOUT's round eye has to survive being reduced to a few
  // bloomed pixels, and a wide bar reduces to a dash while a dot reduces to a
  // dot no matter how much bloom is applied.
  const sensorMesh = parts.mesh(chamferBox(0.40, 0.085, 0.05, 0.012, 1), mat.sensor, 'sentinelVisor');
  sensorMesh.position.set(0, 0.005, 0.17);
  sensorMesh.castShadow = false;
  sensorMesh.receiveShadow = false;
  head.add(sensorMesh);

  // ------------------------------------------------------------------
  // WEAPON POD - one mesh.
  // ------------------------------------------------------------------
  // Right shoulder, outboard, so it is a distinct lump on the outline rather
  // than a barrel poking out of a hole. The player has to be able to answer
  // "which way is it pointing" from the pod alone, because in a firefight the
  // pod is what they are watching, not the visor.
  const weaponPod = new THREE.Group();
  weaponPod.position.set(0.52, 0.62, 0.10);
  turret.add(weaponPod);

  const podParts: Part[] = [
    [chamferBox(0.28, 0.28, 0.72, 0.03, 2), trs(0, 0, 0)],
    // Twin barrels. Two, not one, because a single tube at this scale is lost
    // against the pod behind it; a pair reads as a gap and gaps survive
    // distance better than thin positive forms.
    [metreUv(new THREE.CylinderGeometry(0.048, 0.048, 0.44, 10)), trs(-0.07, -0.02, 0.52, Math.PI / 2)],
    [metreUv(new THREE.CylinderGeometry(0.048, 0.048, 0.44, 10)), trs(0.07, -0.02, 0.52, Math.PI / 2)],
    [chamferBox(0.24, 0.10, 0.16, 0.02, 1), trs(0, 0.15, -0.20)],
  ];
  weaponPod.add(parts.merged(podParts, mat.frame, 'sentinelPod'));

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -0.02, 0.76);
  weaponPod.add(muzzle);

  root.traverse((node) => node.layers.set(LAYER.WORLD));
  root.userData.drawCalls = parts.drawCalls;

  return {
    root,
    hull,
    turret,
    head,
    weaponPod,
    sensorMesh,
    weakPoint,
    muzzle,
    // HIT VOLUMES, in root-local space, matching SoldierRig's convention.
    // The "head" sphere covers the sensor head; the "torso" sphere covers the
    // armour box, which is most of the unit's projected area and should be the
    // low-reward body shot.
    headOffset: new THREE.Vector3(0, TURRET_HEIGHT + 0.92, 0),
    torsoOffset: new THREE.Vector3(0, TURRET_HEIGHT + 0.44, 0),
    // THE TRAP: unlike the other two, this offset is OFF-AXIS. It is only the
    // true weak-point position while the turret yaw is zero, because the core
    // rides the turret. Use it for a cheap early-out only; anything that needs
    // the real position - the hitscan test, the damage-number anchor, a tracer
    // target - must go through `weakPoint.getWorldPosition()`.
    weakPointOffset: new THREE.Vector3(-0.50, TURRET_HEIGHT + 0.93, -0.04),
    dispose(): void {
      parts.dispose();
    },
  };
}
