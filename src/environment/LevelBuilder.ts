import * as THREE from 'three';
import type { SurfaceKind } from '@/core/EventBus';
import { LAYER } from '@/core/Layers';
import { mergeGeometries } from './GeometryKit';
import type { CollisionWorld } from '@/physics/CollisionWorld';

export interface PlaceOptions {
  /** Register a solid AABB for player collision. */
  collide?: boolean;
  /** Shrink the collision box (useful for railings, pipes and clutter). */
  collideShrink?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Overrides the surface tag taken from the material. */
  surface?: SurfaceKind;
  /** Bullets can hit it. Default true. */
  raycastable?: boolean;
}

interface Entry {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * Static-geometry accumulator.
 *
 * The harbour is ~1500 individual pieces. Submitting those as 1500 meshes
 * would be ~1500 draw calls and would not hold 60fps anywhere. Instead each
 * piece is recorded with its world matrix and, at build time, merged into one
 * mesh per (zone, material, shadow-flags) bucket.
 *
 * Merging per ZONE rather than globally is a deliberate compromise: it keeps
 * roughly 40-70 meshes so the frustum can still cull the half of the level
 * behind the player, while keeping draw calls two orders of magnitude down.
 */
export class LevelBuilder {
  private buckets = new Map<string, { material: THREE.Material; entries: Entry[] }>();
  private pendingCollision: Array<{ box: THREE.Box3; surface: SurfaceKind }> = [];
  private tmpBox = new THREE.Box3();

  constructor(private readonly root: THREE.Group) {}

  /**
   * Queues a piece of static geometry.
   * `matrix` is the world transform; the geometry itself is never mutated.
   */
  place(
    zone: string,
    material: THREE.Material,
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    options: PlaceOptions = {},
  ): void {
    const castShadow = options.castShadow ?? true;
    const receiveShadow = options.receiveShadow ?? true;
    const key = `${zone}|${material.name || material.uuid}|${castShadow ? 1 : 0}${receiveShadow ? 1 : 0}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { material, entries: [] };
      this.buckets.set(key, bucket);
    }
    bucket.entries.push({ geometry, matrix, castShadow, receiveShadow });

    if (options.collide) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      this.tmpBox.copy(geometry.boundingBox as THREE.Box3).applyMatrix4(matrix);
      const box = this.tmpBox.clone();
      if (options.collideShrink) box.expandByScalar(-options.collideShrink);
      const surface =
        options.surface ?? ((material.userData?.surface as SurfaceKind | undefined) ?? 'concrete');
      this.pendingCollision.push({ box, surface });
    }
  }

  /** Convenience for a single unmerged mesh (moving parts, unique props). */
  addDynamic(mesh: THREE.Object3D): void {
    mesh.traverse((node) => node.layers.set(LAYER.WORLD));
    this.root.add(mesh);
  }

  /**
   * Merges everything queued so far and attaches it to the level root.
   * Returns statistics used by the debug overlay.
   */
  build(collision: CollisionWorld): { meshes: number; triangles: number; batches: THREE.Mesh[] } {
    let meshes = 0;
    let triangles = 0;
    const batches: THREE.Mesh[] = [];

    for (const [key, bucket] of this.buckets) {
      if (bucket.entries.length === 0) continue;
      const geometries = bucket.entries.map((e) => e.geometry);
      const matrices = bucket.entries.map((e) => e.matrix);
      const merged = mergeGeometries(geometries, matrices);
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.name = key;
      mesh.castShadow = bucket.entries[0].castShadow;
      mesh.receiveShadow = bucket.entries[0].receiveShadow;
      mesh.layers.set(LAYER.WORLD);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      collision.addRaycastTarget(mesh);
      batches.push(mesh);
      meshes++;
      triangles += (merged.index?.count ?? 0) / 3;
    }

    for (const item of this.pendingCollision) {
      collision.addBox(item.box.min, item.box.max, item.surface, true);
    }

    this.buckets.clear();
    this.pendingCollision.length = 0;
    return { meshes, triangles, batches };
  }
}
