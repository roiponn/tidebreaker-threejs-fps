import * as THREE from 'three';
import { applyBoxUv, chamferBox, mergeGeometries } from '@/environment/GeometryKit';
import type { MaterialLibrary } from '@/materials/MaterialLibrary';

/**
 * Shared vocabulary for the factory robots (SCOUT, SENTINEL).
 *
 * Two rigs is already enough for the usual drift to start: each one invents its
 * own emissive key, its own idea of what "armour" is made of, its own copy of
 * the merge-and-track-geometry boilerplate. Six months later the sensor eyes
 * are three slightly different blues and the pool holds five materials that
 * should have been one. Everything the robots agree on lives here so that
 * agreement is *structural* rather than a convention someone has to remember.
 *
 * Nothing in this file allocates a material. `robotMaterials()` only names the
 * MaterialLibrary entries the robots are allowed to use; the library still owns
 * and pools them, so a rig's dispose() must never touch them.
 */

/** A geometry plus the local transform it is merged at. */
export type Part = [THREE.BufferGeometry, THREE.Matrix4];

/**
 * The palette both robots draw from.
 *
 * The three emissive keys are the whole reason this function exists. Emissive
 * materials in MaterialLibrary are keyed by string and pooled, so if SCOUT asks
 * for `emissive('scoutEye', ...)` and SENTINEL asks for `emissive('sentinelEye',
 * ...)` the renderer ends up with two materials that differ only by name - two
 * pipeline states, two uniform uploads, and two chances for the colours to
 * drift apart in a later tweak. One key per *meaning*, not per unit.
 *
 * The colour assignment is a readability contract, not decoration:
 *
 *  - SENSOR is cold cyan. Berth 7 is lit by warm sodium in the yard and cool
 *    mercury on the facade (see VISUAL_DESIGN section 2.3), so a saturated cyan
 *    is the one hue with no environmental competition - a machine eye never
 *    reads as a practical.
 *  - CORE is hot orange, and is *only* ever used on a weak point. It is
 *    deliberately the opposite end of the wheel from the sensor so that "the
 *    part that looks at you" and "the part you shoot" can never be confused at
 *    a glance. Orange does sit near the sodium floods, which is exactly why
 *    every core is framed by hazard-striped collars - the stripes are the
 *    disambiguator, the colour alone is not trusted to do the job.
 *  - ALARM is red, and appears on a mesh that is hidden until the unit has
 *    actually raised the alarm. It is a state readout, so it must be a colour
 *    the player never sees on a passive machine.
 */
export interface RobotMaterials {
  /** Painted armour plate. The large, flat, silhouette-defining surfaces. */
  shell: THREE.Material;
  /** Machined mechanism: sensor housings, weapon pods, rotors. Finer grain. */
  frame: THREE.Material;
  /** Track belts. Tread plate happens to be a perfect grouser pattern. */
  track: THREE.Material;
  /** Yellow/black chevrons. Reserved for framing weak points. */
  hazard: THREE.Material;
  sensor: THREE.MeshStandardMaterial;
  core: THREE.MeshStandardMaterial;
  alarm: THREE.MeshStandardMaterial;
}

export function robotMaterials(mats: MaterialLibrary): RobotMaterials {
  return {
    shell: mats.steelPainted(),
    frame: mats.gunMetal(),
    track: mats.tread(),
    hazard: mats.hazard(),
    // Intensities are tuned against the bloom threshold, not against each
    // other: the sensor should bloom softly at 40m, the core should bloom hard
    // enough to be found through smoke, and the alarm should be unmissable
    // because it fires for maybe two seconds in the whole encounter.
    sensor: mats.emissive('robotSensor', 0x4fd4ff, 7),
    core: mats.emissive('robotCore', 0xff7a1e, 10),
    alarm: mats.emissive('robotAlarm', 0xff2a18, 12),
  };
}

/**
 * Geometry bookkeeping shared by both rigs.
 *
 * This is the same idea as the `keep`/`meshFrom` pair inside EnemySoldier, with
 * one deliberate difference: `merged()` disposes its SOURCE geometries the
 * moment the merge is done. `mergeGeometries` copies vertex data into a fresh
 * buffer, so the inputs are dead weight afterwards - the soldier keeps them in
 * its owned list until the whole rig is torn down, which pins a few hundred
 * kilobytes per enemy for no reason. Call sites here therefore pass raw
 * geometries into `merged()` and never wrap them in `keep()`.
 *
 * `drawCalls` is not diagnostics for its own sake. The level budget is ~640
 * draw calls and these units spawn in numbers; being able to assert the cost of
 * a rig in one number is what stops a "just one more little detail mesh" from
 * quietly tripling it.
 */
export interface PartFactory {
  /** Take ownership of a geometry that will be used directly by a mesh. */
  keep<T extends THREE.BufferGeometry>(geometry: T): T;
  /** One geometry, one mesh, one draw call. */
  mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh;
  /** Many geometries collapsed into one mesh, one draw call. */
  merged(parts: Part[], material: THREE.Material, name: string): THREE.Mesh;
  /** How many meshes - and therefore draw calls - this rig has produced. */
  readonly drawCalls: number;
  dispose(): void;
}

export function createPartFactory(): PartFactory {
  const owned: THREE.BufferGeometry[] = [];
  let meshes = 0;

  const keep = <T extends THREE.BufferGeometry>(geometry: T): T => {
    owned.push(geometry);
    return geometry;
  };

  const finish = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // Robots are big solid objects in a scene with one shadow-casting key
    // light; they earn their shadows. Emissive and thin-spinning parts opt out
    // individually at the call site.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes++;
    return mesh;
  };

  return {
    keep,
    mesh: (geometry, material, name) => finish(keep(geometry), material, name),
    merged(parts, material, name) {
      const merged = mergeGeometries(
        parts.map((p) => p[0]),
        parts.map((p) => p[1]),
      );
      for (const part of parts) part[0].dispose();
      return finish(keep(merged), material, name);
    },
    get drawCalls(): number {
      return meshes;
    },
    dispose(): void {
      for (const geometry of owned) geometry.dispose();
      owned.length = 0;
    },
  };
}

/**
 * Re-project a primitive's UVs into metres.
 *
 * THE TRAP this exists for: every geometry that comes out of GeometryKit is
 * UV'd in world metres, but three's built-in primitives are UV'd 0..1 across
 * the whole shape. Merge a CylinderGeometry into a chamferBox mesh and the
 * cylinder's share of the surface samples one texture tile stretched across it,
 * so a 30cm strut ends up wearing a single enormous rust blotch while the plate
 * next to it tiles correctly. Metre UVs are the project-wide convention (see
 * `corrugatedPanel` in GeometryKit for the same note); anything joining a merge
 * has to be converted first.
 *
 * The exception is a primitive whose OWN parameterisation is the point - the
 * hazard collars want the cylinder's native wrap-around U so the chevrons
 * march around the circumference. Those skip this call on purpose.
 */
export function metreUv<T extends THREE.BufferGeometry>(geometry: T): T {
  applyBoxUv(geometry);
  return geometry;
}

/**
 * The shroud ring of a ducted fan, lying in the XZ plane.
 *
 * A torus rather than an open cylinder because an open-ended cylinder shows its
 * missing backfaces the moment the camera gets below the drone, and the shared
 * library materials are all front-side. A torus is closed, so there is no angle
 * that breaks it, and its rounded rim catches the same specular line that
 * `chamferBox` was invented to give the flat parts.
 *
 * It is squashed vertically because a circular-section rim reads as a doughnut;
 * a flattened one reads as sheet metal rolled into a hoop.
 */
export function ductRing(radius: number, tube: number, segments = 16): THREE.BufferGeometry {
  const geometry = new THREE.TorusGeometry(radius, tube, 6, segments);
  geometry.rotateX(Math.PI / 2);
  geometry.scale(1, 0.62, 1);
  return metreUv(geometry);
}

/**
 * A rotor: flat blades on a hub, ready to spin about local Y.
 *
 * Blade count is 3 rather than 2 because a two-blade rotor stroboscopes badly
 * against a 60Hz update - it visibly stutters and sometimes appears to run
 * backwards. Three blades at a non-harmonic spin rate reads as a blur.
 * The blades are pitched slightly so the disc catches light as it turns;
 * a perfectly flat disc goes matte-dark at most angles and the drone stops
 * looking powered.
 */
export function rotorBlades(radius: number, chord: number, hubRadius: number): THREE.BufferGeometry {
  const parts: Part[] = [];
  const hub = new THREE.CylinderGeometry(hubRadius, hubRadius * 1.15, 0.05, 10);
  parts.push([metreUv(hub), new THREE.Matrix4()]);
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const blade = chamferBox(chord, 0.012, radius - hubRadius, 0.004, 1);
    const matrix = new THREE.Matrix4()
      .makeRotationY(angle)
      .multiply(
        new THREE.Matrix4().compose(
          new THREE.Vector3(0, 0, (radius + hubRadius) / 2),
          // Pitch is about the SPAN axis (local Z), which is the axis the blade
          // runs along - rotating about anything else shears the blade instead
          // of angling it.
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.28)),
          new THREE.Vector3(1, 1, 1),
        ),
      );
    parts.push([blade, matrix]);
  }
  const merged = mergeGeometries(
    parts.map((p) => p[0]),
    parts.map((p) => p[1]),
  );
  for (const part of parts) part[0].dispose();
  return merged;
}

/**
 * The side profile of a tracked running gear, extruded across the track width.
 *
 * ONE geometry for the whole track loop instead of a belt plus road wheels plus
 * sprockets. The stadium outline - two circles joined by straight runs - is the
 * entire silhouette information a tracked vehicle carries at 40m; the wheels
 * inside it are invisible past about 8m and cost as much to draw as the hull.
 * This is the single biggest greeble cut on the SENTINEL and the director's
 * "silhouette over detail" note in practice.
 */
export function trackLoop(length: number, radius: number, width: number): THREE.BufferGeometry {
  const bevel = 0.018;
  const r = radius - bevel;
  const half = Math.max(0.001, length / 2 - radius);

  const shape = new THREE.Shape();
  shape.absarc(half, 0, r, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(-half, r);
  shape.absarc(-half, 0, r, Math.PI / 2, Math.PI * 1.5, false);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 7,
    steps: 1,
  });
  geometry.translate(0, 0, -(width - bevel * 2) / 2);
  // Extrude runs along +Z but a track runs fore/aft, so the profile has to be
  // stood up: rotate the ring into the XY plane of travel.
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  return metreUv(geometry);
}

/**
 * The glowing element of a sensor eye: a shallow lens disc.
 *
 * A sphere would be the obvious choice and is the wrong one - a sphere looks
 * identical from every angle, so a gimbal tracking the player produces no
 * visible motion at all. A flattened disc changes silhouette and specular as it
 * turns, which is what sells "it is looking at you" before the AI has done
 * anything. The small forward cone is the pupil; it gives the disc a centre so
 * the eye has an aim direction the player can read.
 */
export function lensDisc(radius: number): THREE.BufferGeometry {
  const parts: Part[] = [];
  const lens = new THREE.SphereGeometry(radius, 14, 10);
  lens.scale(1, 1, 0.42);
  parts.push([lens, new THREE.Matrix4()]);
  const pupil = new THREE.ConeGeometry(radius * 0.42, radius * 0.5, 12);
  pupil.rotateX(Math.PI / 2);
  parts.push([pupil, new THREE.Matrix4().makeTranslation(0, 0, radius * 0.34)]);
  const merged = mergeGeometries(
    parts.map((p) => p[0]),
    parts.map((p) => p[1]),
  );
  for (const part of parts) part[0].dispose();
  return merged;
}

/**
 * What every robot rig is guaranteed to expose.
 *
 * Shaped after `SoldierRig` so EnemyManager can treat a robot and a soldier the
 * same way for the parts it cares about: a root to place, a hit volume or two,
 * and a dispose(). The additions are the two things a machine has that a person
 * does not - a sensor that can be destroyed or dazzled, and a weak point.
 *
 * `dispose()` releases GEOMETRY ONLY. Materials belong to MaterialLibrary and
 * are shared with every other robot in the level; disposing one here would
 * blank the rest of them mid-fight.
 */
export interface RobotRig {
  root: THREE.Group;
  /** The emissive eye. Its material is POOLED - see the note below. */
  sensorMesh: THREE.Mesh;
  /** The emissive "shoot here" volume. Also pooled. */
  weakPoint: THREE.Mesh;
  /** Empty at the muzzle, for tracer origin and flash attachment. */
  muzzle: THREE.Object3D;
  /** Hit volume centres in ROOT-local space, matching SoldierRig's convention. */
  headOffset: THREE.Vector3;
  torsoOffset: THREE.Vector3;
  /**
   * Weak-point centre in root-local space, for a cheap broad-phase test.
   * THE TRAP: on SENTINEL this point is off-axis and rides the turret, so it is
   * only valid when the turret yaw is zero. Anything that needs the real
   * position must use `weakPoint.getWorldPosition()`.
   */
  weakPointOffset: THREE.Vector3;
  dispose(): void;
}

/**
 * PER-UNIT EMISSIVE STATE - read this before animating a robot.
 *
 * EnemySoldier's strobe blinks by writing `emissiveIntensity` on its material
 * every frame. That works there only because every soldier writes the same
 * value from the same clock, so the last writer winning is harmless. It is a
 * loaded gun: the materials are pooled, so the instant one unit wants a
 * DIFFERENT intensity or colour from another - a sentinel overheating while its
 * neighbour is idle - that write reaches every robot in the level.
 *
 * Two supported ways out, in order of preference:
 *
 *  1. Toggle `mesh.visible`. Costs nothing, is per-object, and is why the
 *     alarm beacon is its own hidden mesh rather than a recolour of the eye.
 *  2. Call `detachEmissive(mesh)` at spawn time to give that one unit a private
 *     clone of the material. This costs a material and a pipeline state per
 *     unit, so it is for the handful of units that genuinely need independent
 *     pulsing - not the default.
 *
 * The clone is owned by the caller and is not registered with MaterialLibrary,
 * so whoever calls this is responsible for disposing it.
 */
export function detachEmissive(mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  const source = mesh.material as THREE.MeshStandardMaterial;
  const clone = source.clone();
  mesh.material = clone;
  return clone;
}
