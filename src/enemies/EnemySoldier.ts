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

  const fatigue = mats.gunPolymer();
  const gear = mats.gunRubber();
  const metal = mats.steelBare();

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
        // Shoulder pads.
        [keep(chamferBox(0.10, 0.09, 0.16, 0.025, 1)), trs(-0.19, 0.25, 0)],
        [keep(chamferBox(0.10, 0.09, 0.16, 0.025, 1)), trs(0.19, 0.25, 0)],
      ],
      gear,
      'carrier',
    ),
  );
  // Antenna: a thin vertical line that makes the silhouette instantly readable
  // as a soldier even at 40m and half a pixel wide.
  const antenna = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.004, 0.005, 0.42, 5)), metal);
  antenna.position.set(-0.14, 0.48, 0.02);
  antenna.rotation.z = 0.16;
  antenna.castShadow = false;
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

  // --- arms: upper + forearm, posed in a low-ready weapon grip ---
  const makeArm = (side: number): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.21, 0.24, 0);
    const upper = new THREE.Mesh(keep(chamferBox(0.085, 0.20, 0.09, 0.025, 1)), fatigue);
    upper.position.y = -0.10;
    upper.castShadow = true;
    arm.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.20;
    arm.add(elbow);
    // Forearm + glove in one mesh.
    const fore = meshFrom(
      [
        [keep(chamferBox(0.075, 0.19, 0.08, 0.02, 1)), trs(0, -0.095, 0)],
        [keep(chamferBox(0.07, 0.08, 0.075, 0.02, 1)), trs(0, -0.20, 0)],
      ],
      fatigue,
      'forearm',
    );
    elbow.add(fore);
    // Pre-pose: elbows in, forearms forward.
    arm.rotation.set(-1.05, side * -0.18, side * 0.22);
    elbow.rotation.x = 0.55;
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
  weapon.position.set(0.16, -0.30, -0.16);
  weapon.rotation.set(0.2, -0.28, 0.1);
  rightArm.add(weapon);

  const weaponMuzzle = new THREE.Object3D();
  weaponMuzzle.position.set(0, -0.005, -0.42);
  weapon.add(weaponMuzzle);

  // --- legs ---
  const makeLeg = (side: number): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.11, -0.08, 0);
    const thigh = new THREE.Mesh(keep(chamferBox(0.125, 0.36, 0.14, 0.03, 1)), fatigue);
    thigh.position.y = -0.18;
    thigh.castShadow = true;
    leg.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.36;
    leg.add(knee);
    // Shin + boot + knee pad in one mesh.
    knee.add(
      meshFrom(
        [
          [keep(chamferBox(0.11, 0.36, 0.12, 0.025, 1)), trs(0, -0.18, 0)],
          [keep(chamferBox(0.12, 0.10, 0.24, 0.02, 1)), trs(0, -0.38, 0.04)],
          [keep(chamferBox(0.11, 0.09, 0.05, 0.02, 1)), trs(0, -0.02, 0.08)],
        ],
        fatigue,
        'lowerLeg',
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
