import * as THREE from 'three';
import type { SurfaceKind } from '@/core/EventBus';

/**
 * Lightweight collision.
 *
 * Deliberately NOT a physics engine. A 90-second slice on flat ground needs
 * exactly two things: an axis-aligned box world the player capsule can be
 * pushed out of, and a ray query for bullets. Rapier would add ~1MB of wasm
 * and a fixed-timestep loop for no visible benefit, so the few genuinely
 * dynamic objects (casings, debris, swinging lamps) run their own tiny
 * integrators in the systems that own them.
 */

export interface CollisionBox {
  min: THREE.Vector3;
  max: THREE.Vector3;
  surface: SurfaceKind;
  /** Blocks movement. Some boxes exist only for bullets (e.g. thin railings). */
  solid: boolean;
}

export interface RaycastHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceKind;
  object: THREE.Object3D | null;
}

/** Stable index returned for collision boxes whose solid state changes at runtime. */
export type CollisionBoxHandle = number;

const tmpBox = new THREE.Box3();
const tmpVec = new THREE.Vector3();

export class CollisionWorld {
  private boxes: CollisionBox[] = [];
  /** Meshes bullets can hit. Kept separate and small - not the whole scene. */
  private raycastTargets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  /** Uniform grid so player resolution does not test every box every frame. */
  private grid = new Map<number, number[]>();
  private readonly cellSize = 6;

  addBox(
    min: THREE.Vector3,
    max: THREE.Vector3,
    surface: SurfaceKind,
    solid = true,
  ): CollisionBoxHandle {
    const box: CollisionBox = { min: min.clone(), max: max.clone(), surface, solid };
    const index = this.boxes.length;
    this.boxes.push(box);
    // Non-solid boxes are indexed too so a dynamic obstacle (a roller door,
    // for example) can be enabled later without rebuilding the spatial grid.
    const x0 = Math.floor(min.x / this.cellSize);
    const x1 = Math.floor(max.x / this.cellSize);
    const z0 = Math.floor(min.z / this.cellSize);
    const z1 = Math.floor(max.z / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = this.key(x, z);
        let cell = this.grid.get(key);
        if (!cell) {
          cell = [];
          this.grid.set(key, cell);
        }
        cell.push(index);
      }
    }
    return index;
  }

  /** Enables/disables movement blocking without changing bullet raycasts. */
  setBoxSolid(handle: CollisionBoxHandle, solid: boolean): void {
    const box = this.boxes[handle];
    if (!box) return;
    box.solid = solid;
  }

  isBoxSolid(handle: CollisionBoxHandle): boolean {
    return this.boxes[handle]?.solid ?? false;
  }

  /** Registers an object3D from its world bounding box. */
  addFromObject(object: THREE.Object3D, surface: SurfaceKind, solid = true, shrink = 0): void {
    object.updateWorldMatrix(true, true);
    tmpBox.setFromObject(object);
    if (tmpBox.isEmpty()) return;
    if (shrink !== 0) tmpBox.expandByScalar(-shrink);
    this.addBox(tmpBox.min, tmpBox.max, surface, solid);
  }

  addRaycastTarget(object: THREE.Object3D): void {
    this.raycastTargets.push(object);
  }

  removeRaycastTarget(object: THREE.Object3D): void {
    const i = this.raycastTargets.indexOf(object);
    if (i >= 0) this.raycastTargets.splice(i, 1);
  }

  private key(x: number, z: number): number {
    // Cantor-ish pack; cell coords stay well inside +-1000.
    return (x + 1024) * 4096 + (z + 1024);
  }

  private candidatesAround(position: THREE.Vector3, radius: number, out: Set<number>): void {
    out.clear();
    const x0 = Math.floor((position.x - radius) / this.cellSize);
    const x1 = Math.floor((position.x + radius) / this.cellSize);
    const z0 = Math.floor((position.z - radius) / this.cellSize);
    const z1 = Math.floor((position.z + radius) / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const cell = this.grid.get(this.key(x, z));
        if (!cell) continue;
        for (const i of cell) out.add(i);
      }
    }
  }

  private candidateSet = new Set<number>();

  /**
   * Resolves a vertical capsule (approximated as an AABB) out of the world.
   * Returns the ground height under the player and whether it is standing.
   *
   * Uses minimum-translation-vector push-out with the vertical axis handled
   * first, which is what allows the step-up behaviour: if a horizontal
   * penetration is shallow AND the top of the obstacle is within stepHeight,
   * the player is lifted instead of blocked.
   */
  resolveCapsule(
    position: THREE.Vector3,
    radius: number,
    height: number,
    stepHeight: number,
  ): { grounded: boolean; groundY: number; hitWall: boolean } {
    this.candidatesAround(position, radius + 0.6, this.candidateSet);

    let grounded = false;
    let groundY = -Infinity;
    let hitWall = false;

    // --- vertical: find the highest surface we are standing on ---
    for (const index of this.candidateSet) {
      const box = this.boxes[index];
      if (!box.solid) continue;
      if (position.x + radius < box.min.x || position.x - radius > box.max.x) continue;
      if (position.z + radius < box.min.z || position.z - radius > box.max.z) continue;
      // Feet at position.y; a surface counts if it is at or slightly above.
      if (box.max.y <= position.y + stepHeight && box.max.y > groundY && box.max.y >= position.y - 0.6) {
        groundY = box.max.y;
      }
    }
    if (groundY > -Infinity && position.y <= groundY + 0.02) {
      position.y = groundY;
      grounded = true;
    }

    // --- horizontal: push out of anything the body still intersects ---
    const feet = position.y + 0.12;
    const head = position.y + height;
    for (let iteration = 0; iteration < 3; iteration++) {
      let moved = false;
      for (const index of this.candidateSet) {
        const box = this.boxes[index];
        if (!box.solid) continue;
        if (box.max.y <= feet || box.min.y >= head) continue;
        // Step-up: low obstacles are climbed, not collided with.
        if (box.max.y - position.y <= stepHeight) continue;

        const overlapX = Math.min(box.max.x - (position.x - radius), position.x + radius - box.min.x);
        const overlapZ = Math.min(box.max.z - (position.z - radius), position.z + radius - box.min.z);
        if (overlapX <= 0 || overlapZ <= 0) continue;

        hitWall = true;
        moved = true;
        // Push along whichever axis needs the least correction.
        if (overlapX < overlapZ) {
          const centerX = (box.min.x + box.max.x) * 0.5;
          position.x += position.x < centerX ? -overlapX : overlapX;
        } else {
          const centerZ = (box.min.z + box.max.z) * 0.5;
          position.z += position.z < centerZ ? -overlapZ : overlapZ;
        }
      }
      if (!moved) break;
    }

    return { grounded, groundY: groundY === -Infinity ? 0 : groundY, hitWall };
  }

  /** True if a point-sized probe would be inside solid geometry. */
  isBlocked(point: THREE.Vector3, padding = 0): boolean {
    this.candidatesAround(point, padding + 0.1, this.candidateSet);
    for (const index of this.candidateSet) {
      const box = this.boxes[index];
      if (!box.solid) continue;
      if (
        point.x > box.min.x - padding &&
        point.x < box.max.x + padding &&
        point.y > box.min.y - padding &&
        point.y < box.max.y + padding &&
        point.z > box.min.z - padding &&
        point.z < box.max.z + padding
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Bullet / line-of-sight query against registered meshes.
   * Mesh-accurate (not box-accurate) so impacts land on the actual surface,
   * and the surface kind comes from `material.userData.surface`.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): RaycastHit | null {
    this.raycaster.set(origin, direction);
    this.raycaster.far = maxDistance;
    this.raycaster.near = 0.01;
    const hits = this.raycaster.intersectObjects(this.raycastTargets, true);
    for (const hit of hits) {
      if (!hit.face) continue;
      const mesh = hit.object as THREE.Mesh;
      if (mesh.visible === false) continue;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const surface = (material?.userData?.surface as SurfaceKind) ?? 'concrete';
      // Face normal is in object space; bring it to world space.
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      if (normal.dot(direction) > 0) normal.negate();
      return {
        point: hit.point.clone(),
        normal,
        distance: hit.distance,
        surface,
        object: hit.object,
      };
    }
    return null;
  }

  /** Cheap box-only ray used for AI line of sight - no mesh traversal. */
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    tmpVec.subVectors(to, from);
    const distance = tmpVec.length();
    if (distance < 0.01) return true;
    tmpVec.multiplyScalar(1 / distance);
    const steps = Math.min(24, Math.ceil(distance / 1.2));
    const probe = new THREE.Vector3();
    for (let i = 1; i < steps; i++) {
      probe.copy(from).addScaledVector(tmpVec, (distance * i) / steps);
      if (this.isBlocked(probe, 0)) return false;
    }
    return true;
  }

  get boxCount(): number {
    return this.boxes.length;
  }

  clear(): void {
    this.boxes.length = 0;
    this.raycastTargets.length = 0;
    this.grid.clear();
  }
}
