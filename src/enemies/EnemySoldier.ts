import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import { chamferBox, mergeGeometries, trs } from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';

/**
 * Hostile soldier - model and procedural animation.
 *
 * The brief asks for a *minimal* enemy, so there is no skeletal rig and no
 * animation clips. Instead the figure is a small hierarchy of rigid parts
 * driven by sine functions: hips, torso, head, two arms and two legs. At the
 * ranges this level fights at (10-40m) that reads convincingly, and it costs
 * essentially nothing.
 *
 * READABILITY: every soldier carries a small amber IR strobe on the shoulder
 * and has a lighter-toned helmet band. Dark scenes are only cinematic if the
 * player can still find the enemy - this is the deliberate mechanism for that,
 * rather than raising the ambient light and flattening the whole image.
 */
export interface SoldierRig {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  weaponMuzzle: THREE.Object3D;
  strobe: THREE.Mesh;
  /** Head and torso hit volumes in local space, used by the hitscan test. */
  headOffset: THREE.Vector3;
  torsoOffset: THREE.Vector3;
  dispose(): void;
}

export function buildSoldier(mats: MaterialLibrary): SoldierRig {
  const owned: THREE.BufferGeometry[] = [];
  const keep = <T extends THREE.BufferGeometry>(g: T): T => {
    owned.push(g);
    return g;
  };

  const fatigue = mats.soldierFatigue();
  const gear = mats.soldierGear();
  const metal = mats.steelBare();

  /** Non-uniformly scales a geometry in place (for squashed domes). */
  const scaled = (g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry => {
    g.scale(x, y, z);
    return g;
  };

  /** Merges a list of parts into one mesh to keep the draw call count down. */
  const meshFrom = (
    parts: Array<[THREE.BufferGeometry, THREE.Matrix4]>,
    material: THREE.Material,
    name: string,
  ): THREE.Mesh => {
    const merged = mergeGeometries(
      parts.map((p) => p[0]),
      parts.map((p) => p[1]),
    );
    owned.push(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const root = new THREE.Group();
  root.name = 'Soldier';

  // --- hips / pelvis ---
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);
  hips.add(
    meshFrom(
      [
        [keep(chamferBox(0.30, 0.20, 0.20, 0.03, 1)), trs(0, 0, 0)],
        // Drop pouches on the belt line.
        [keep(chamferBox(0.11, 0.14, 0.08, 0.02, 1)), trs(-0.17, -0.06, 0.02)],
        [keep(chamferBox(0.11, 0.14, 0.08, 0.02, 1)), trs(0.17, -0.06, 0.02)],
        // TROUSER SKIRT: a flared block hanging below the belt that overlaps
        // the top of BOTH thighs. The hips are the one joint a capsule cannot
        // close on its own, because two bones share one parent volume; a piece
        // of clothing that hangs over them is how real characters solve it.
        [scaled(keep(new THREE.SphereGeometry(0.168, 12, 8)), 1.05, 0.62, 0.92), trs(0, -0.082, 0)],
      ],
      gear,
      'hips',
    ),
  );

  // --- torso: chest, plate carrier with pouches, shoulders ---
  const torso = new THREE.Group();
  torso.position.y = 0.13;
  hips.add(torso);
  torso.add(
    meshFrom(
      [
        // Chest tapers to the shoulders rather than being a slab, and the
        // plate carrier is merged in - the material difference between fatigue
        // cloth and carrier nylon is not readable at combat range.
        [keep(chamferBox(0.34, 0.26, 0.21, 0.035, 2)), trs(0, 0.16, 0)],
        [keep(chamferBox(0.30, 0.14, 0.19, 0.03, 1)), trs(0, 0.01, 0)],
        [keep(chamferBox(0.32, 0.30, 0.10, 0.02, 1)), trs(0, 0.13, 0.075)],
        [keep(chamferBox(0.30, 0.28, 0.07, 0.02, 1)), trs(0, 0.13, -0.075)],
        // Magazine pouches - three across the front.
        [keep(chamferBox(0.075, 0.12, 0.055, 0.012, 1)), trs(-0.085, 0.05, 0.135)],
        [keep(chamferBox(0.075, 0.12, 0.055, 0.012, 1)), trs(0, 0.05, 0.14)],
        [keep(chamferBox(0.075, 0.12, 0.055, 0.012, 1)), trs(0.085, 0.05, 0.135)],
        // Radio on the left shoulder strap.
        [keep(chamferBox(0.06, 0.11, 0.045, 0.01, 1)), trs(-0.13, 0.25, 0.06)],
        // Pauldrons: squashed domes draping over the deltoid. They belong to
        // the TORSO so they stay put while the arm swings beneath them, which
        // is what hides a rigid shoulder - and they are merged in here rather
        // than being their own mesh, since they share this material and parent.
        [scaled(keep(new THREE.SphereGeometry(0.098, 10, 7)), 1.0, 0.78, 1.15), trs(-0.185, 0.248, 0)],
        [scaled(keep(new THREE.SphereGeometry(0.098, 10, 7)), 1.0, 0.78, 1.15), trs(0.185, 0.248, 0)],
        // Collar ring: closes the neck at every head angle.
        [keep(new THREE.CylinderGeometry(0.072, 0.085, 0.075, 10)), trs(0, 0.30, 0)],
      ],
      gear,
      'carrier',
    ),
  );

  // SHOULDER + NECK COVERAGE, parented to the torso.
  //
  // A capsule cap closes the joint geometrically, but the shoulder is where a
  // rigid rig reads worst because the arm swings through a large arc. These
  // pieces belong to the TORSO, so they stay put while the arm rotates beneath
  // them - exactly how a real pauldron and collar behave, and the standard way
  // to hide a rigid shoulder.

  // Neck column. The head pivots at its top, and the sphere at that pivot means
  // head rotation cannot open a seam.
  torso.add(
    meshFrom(
      [
        [keep(new THREE.CylinderGeometry(0.055, 0.058, 0.10, 8)), trs(0, 0.325, 0)],
        [keep(new THREE.SphereGeometry(0.058, 8, 6)), trs(0, 0.36, 0)],
      ],
      fatigue,
      'neck',
    ),
  );
  // Antenna: a thin vertical line that makes the silhouette instantly readable
  // as a soldier even at 40m and half a pixel wide.
  const antenna = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.004, 0.005, 0.42, 5)), metal);
  antenna.position.set(-0.14, 0.48, 0.02);
  antenna.rotation.z = 0.16;
  antenna.castShadow = false;
  antenna.receiveShadow = false;
  torso.add(antenna);

  // --- head: helmet with a rail, NVG mount and goggles ---
  const head = new THREE.Group();
  head.position.y = 0.36;
  torso.add(head);
  head.add(
    meshFrom(
      [[keep(chamferBox(0.15, 0.17, 0.16, 0.045, 2)), trs(0, 0.02, 0)]],
      fatigue,
      'head',
    ),
  );
  // Helmet, NVG mount, rails and visor merged into ONE gear-material mesh.
  // Eleven soldiers on screen make per-part meshes a real draw-call problem.
  const helmetGeo = keep(new THREE.SphereGeometry(0.115, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.62));
  helmetGeo.scale(1, 1.05, 1.1);
  head.add(
    meshFrom(
      [
        [helmetGeo, trs(0, 0.05, 0)],
        [keep(chamferBox(0.05, 0.045, 0.03, 0.008, 1)), trs(0, 0.09, 0.10)],
        [keep(chamferBox(0.02, 0.05, 0.10, 0.005, 1)), trs(-0.10, 0.05, 0)],
        [keep(chamferBox(0.02, 0.05, 0.10, 0.005, 1)), trs(0.10, 0.05, 0)],
        [keep(chamferBox(0.14, 0.05, 0.03, 0.008, 1)), trs(0, 0.03, 0.085)],
      ],
      gear,
      'helmet',
    ),
  );
  void metal;

  /**
   * THE JOINT RULE for this rigid-part rig.
   *
   * Every limb bone is a CAPSULE positioned so that its end-cap hemisphere
   * centres sit exactly on the two joint pivots it spans. Rotating a bone about
   * a pivot is then a rotation of a sphere about its own centre, which is
   * geometrically invariant - so the joint physically cannot open a gap at any
   * angle, and consecutive bones always share overlapping spherical volume.
   *
   * This is why the old rig failed: box limbs had FLAT ends at the pivots, so
   * every degree of rotation swung a square corner away from its neighbour and
   * opened a visible wedge. The fix is the shape, not the size - simply
   * inflating the boxes until the gaps closed would have produced swollen,
   * toy-like limbs.
   *
   * `bone(length, radius)` returns a capsule already offset so its TOP cap
   * centre is the local origin (the parent joint) and its BOTTOM cap centre is
   * at -length (the child joint).
   */
  const bone = (length: number, radius: number): THREE.BufferGeometry => {
    const g = keep(new THREE.CapsuleGeometry(radius, length, 3, 8));
    g.translate(0, -length / 2, 0);
    return g;
  };

  // --- arms ---
  const UPPER_ARM = 0.21;
  const FOREARM = 0.20;
  const makeArm = (side: number): THREE.Group => {
    const arm = new THREE.Group();
    // Pivot pulled inboard and down so it sits INSIDE the deltoid mass rather
    // than on the outer surface of the torso.
    arm.position.set(side * 0.178, 0.232, 0);

    // Upper arm + a deltoid bulge that overlaps the shoulder pad above it.
    arm.add(
      meshFrom(
        [
          [bone(UPPER_ARM, 0.051), trs(0, 0, 0)],
          [keep(new THREE.SphereGeometry(0.058, 8, 6)), trs(0, -0.014, 0)],
        ],
        fatigue,
        'upperArm',
      ),
    );

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM;
    arm.add(elbow);

    // Forearm (tapered by scaling the capsule) + glove at the wrist.
    const foreGeo = bone(FOREARM, 0.044);
    elbow.add(
      meshFrom(
        [
          [foreGeo, trs(0, 0, 0)],
          // Glove overlaps the forearm's lower cap, so the wrist never parts.
          [keep(chamferBox(0.072, 0.085, 0.078, 0.022, 1)), trs(0, -FOREARM - 0.018, 0)],
        ],
        fatigue,
        'forearm',
      ),
    );

    // Pre-pose. The two arms are NOT mirrored: the right hand holds the grip
    // and the left reaches across to the handguard, which is what makes the
    // figure read as carrying a weapon rather than as a symmetrical doll.
    // The Z term TUCKS the elbow toward the ribs. Positive Z swings the right
    // arm outward, so it has to be negative there and positive on the left -
    // getting this sign wrong is what left the figure standing with both arms
    // splayed like a doll.
    if (side > 0) {
      arm.rotation.set(-1.02, -0.26, -0.22);
      elbow.rotation.x = 0.70;
    } else {
      arm.rotation.set(-1.20, 0.50, 0.30);
      elbow.rotation.x = 1.05;
    }
    arm.userData.elbow = elbow;
    return arm;
  };
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);
  torso.add(leftArm, rightArm);

  // --- weapon (silhouette only: this is not the hero asset) ---
  const weapon = new THREE.Group();
  weapon.add(
    meshFrom(
      [
        [keep(chamferBox(0.05, 0.07, 0.36, 0.008, 1)), trs(0, 0, -0.06)],
        [keep(chamferBox(0.035, 0.05, 0.20, 0.006, 1)), trs(0, -0.005, -0.30)],
        [keep(chamferBox(0.032, 0.11, 0.045, 0.008, 1)), trs(0, -0.085, -0.02)],
        [keep(chamferBox(0.045, 0.08, 0.05, 0.008, 1)), trs(0, 0.05, 0.02)],
        [keep(chamferBox(0.04, 0.06, 0.12, 0.008, 1)), trs(0, -0.005, 0.16)],
      ],
      metal,
      'enemyWeapon',
    ),
  );
  // Mounted at the RIGHT HAND (the wrist is at -UPPER_ARM - FOREARM in arm
  // space), not floating above the elbow as before.
  weapon.position.set(0.02, -0.41, -0.10);
  weapon.rotation.set(0.10, 0.22, 0.04);
  rightArm.add(weapon);

  const weaponMuzzle = new THREE.Object3D();
  weaponMuzzle.position.set(0, -0.005, -0.42);
  weapon.add(weaponMuzzle);

  // --- legs ---
  const THIGH = 0.37;
  const SHIN = 0.37;
  const makeLeg = (side: number): THREE.Group => {
    const leg = new THREE.Group();
    // Hip pivot raised into the pelvis mass so the trouser skirt above can
    // overlap the thigh cap at every swing angle.
    leg.position.set(side * 0.105, -0.055, 0);

    leg.add(
      meshFrom(
        [
          [bone(THIGH, 0.078), trs(0, 0, 0)],
          // Upper-thigh bulge, hidden under the trouser skirt on the pelvis.
          [keep(new THREE.SphereGeometry(0.081, 8, 6)), trs(0, -0.022, 0)],
        ],
        fatigue,
        'thigh',
      ),
    );

    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    leg.add(knee);

    knee.add(
      meshFrom(
        [
          [bone(SHIN, 0.064), trs(0, 0, 0)],
          // Boot overlaps the shin's lower cap so the ankle stays closed.
          [keep(chamferBox(0.115, 0.105, 0.235, 0.02, 1)), trs(0, -SHIN - 0.012, 0.045)],
        ],
        fatigue,
        'lowerLeg',
      ),
    );
    // Knee pad is a separate GEAR-material piece straddling the pivot, so the
    // joint reads as armoured rather than as two tubes meeting.
    knee.add(
      meshFrom(
        [[keep(chamferBox(0.125, 0.125, 0.075, 0.028, 2)), trs(0, -0.012, 0.052)]],
        gear,
        'kneePad',
      ),
    );

    leg.userData.knee = knee;
    return leg;
  };
  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);
  hips.add(leftLeg, rightLeg);

  // --- IR strobe: the readability guarantee ---
  const strobeGeo = keep(new THREE.SphereGeometry(0.022, 8, 6));
  const strobe = new THREE.Mesh(strobeGeo, mats.emissive('enemyStrobe', 0xff8a2a, 8));
  strobe.position.set(0.14, 0.30, -0.09);
  torso.add(strobe);

  root.traverse((node) => node.layers.set(LAYER.WORLD));

  return {
    root,
    hips,
    torso,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    weaponMuzzle,
    strobe,
    headOffset: new THREE.Vector3(0, 1.63, 0),
    torsoOffset: new THREE.Vector3(0, 1.18, 0),
    dispose(): void {
      for (const g of owned) g.dispose();
      owned.length = 0;
    },
  };
}
