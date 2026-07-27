import * as THREE from 'three';
import { LAYER } from '@/core/Layers';
import type { SurfaceKind } from '@/core/EventBus';
import { Pool } from '@/core/Pool';
import type { TextureFactory } from '@/materials/TextureFactory';

/**
 * Bullet holes and scorch marks.
 *
 * Implemented as quads pushed off the surface along its normal, with
 * polygonOffset on top. Real projected decals (clipping a box against the
 * receiving geometry) would be correct on arbitrary surfaces, but almost
 * everything a bullet can hit here is planar at the scale of a 13cm decal.
 *
 * The exception is corrugated cladding, whose ribs are +-2.6cm of real
 * geometry: a quad offset by the usual 1.2cm disappears between them. Those
 * surfaces get a 3.8cm offset instead, which is the pragmatic fix. A projected
 * decal system is the correct one - see docs/KNOWN_ISSUES.md V6.
 *
 * The pool is hard-capped by the quality preset: the oldest decal fades out and
 * is recycled, which is what keeps a 30-round magazine from producing 30
 * permanent transparent draw calls.
 */
interface DecalSlot {
  mesh: THREE.Mesh;
  age: number;
  lifetime: number;
  baseScale: number;
}

export class DecalSystem {
  readonly group = new THREE.Group();
  private pool: Pool<DecalSlot>;
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private geometry: THREE.PlaneGeometry;
  private disposables: Array<{ dispose(): void }> = [];

  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpUp = new THREE.Vector3();

  constructor(
    private readonly textures: TextureFactory,
    capacity: number,
  ) {
    this.group.name = 'Decals';
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(this.geometry);

    this.pool = new Pool<DecalSlot>(
      capacity,
      () => {
        const mesh = new THREE.Mesh(this.geometry, this.materialFor('concrete'));
        mesh.visible = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.renderOrder = 2;
        mesh.layers.set(LAYER.WORLD);
        this.group.add(mesh);
        return { mesh, age: 0, lifetime: 1, baseScale: 1 };
      },
      (slot) => {
        slot.mesh.visible = false;
      },
    );
  }

  /**
   * One material per decal kind, shared by every instance.
   * Decals are lit (MeshStandardMaterial, not Basic) so a bullet hole in a
   * floodlit wall is bright and one in shadow is dark - a decal that ignores
   * lighting is instantly readable as a sticker.
   */
  private materialFor(kind: 'concrete' | 'metal' | 'glass' | 'scorch'): THREE.MeshStandardMaterial {
    let mat = this.materials.get(kind);
    if (mat) return mat;
    const map =
      kind === 'scorch' ? this.textures.scorch() : this.textures.bulletHole(kind === 'glass' ? 'glass' : kind);
    mat = new THREE.MeshStandardMaterial({
      map,
      alphaMap: map,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      // Push the decal toward the camera in depth so it never z-fights.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      roughness: kind === 'metal' ? 0.42 : 0.9,
      metalness: kind === 'metal' ? 0.75 : 0.05,
      color: kind === 'scorch' ? 0x2a2622 : 0xffffff,
    });
    mat.name = `decal_${kind}`;
    this.materials.set(kind, mat);
    this.disposables.push(mat);
    return mat;
  }

  private kindForSurface(surface: SurfaceKind): 'concrete' | 'metal' | 'glass' {
    switch (surface) {
      case 'metal':
      case 'thinMetal':
      case 'fence':
        return 'metal';
      case 'glass':
        return 'glass';
      default:
        return 'concrete';
    }
  }

  /** Places a bullet hole. Returns false if the surface should not take one. */
  add(point: THREE.Vector3, normal: THREE.Vector3, surface: SurfaceKind, scale = 1): boolean {
    // Water and flesh do not keep bullet holes.
    if (surface === 'water' || surface === 'flesh') return false;
    const { item, index } = this.pool.acquire();
    void index;
    item.mesh.material = this.materialFor(this.kindForSurface(surface));
    // Container walls and cladding are GEOMETRICALLY corrugated (+-2.6cm ribs).
    // A flat quad offset by the usual 1.2cm sinks between the ribs and is
    // invisible, so ribbed surfaces get a much larger offset.
    const ribbed = surface === 'thinMetal' || surface === 'fence';
    this.orient(item.mesh, point, normal, ribbed ? 0.038 : 0.012);
    const size = (surface === 'thinMetal' ? 0.16 : 0.13) * scale * (0.8 + Math.random() * 0.5);
    item.baseScale = size;
    item.mesh.scale.setScalar(size);
    item.mesh.rotateZ(Math.random() * Math.PI * 2);
    item.age = 0;
    // Long-lived but finite: decals fade so the pool recycles gracefully.
    item.lifetime = 26;
    item.mesh.visible = true;
    return true;
  }

  /** Places a scorch mark (explosions). Larger, softer, shorter-lived. */
  addScorch(point: THREE.Vector3, normal: THREE.Vector3, radius: number): void {
    const { item } = this.pool.acquire();
    item.mesh.material = this.materialFor('scorch');
    this.orient(item.mesh, point, normal, 0.02);
    item.baseScale = radius;
    item.mesh.scale.setScalar(radius);
    item.mesh.rotateZ(Math.random() * Math.PI * 2);
    item.age = 0;
    item.lifetime = 34;
    item.mesh.visible = true;
  }

  private orient(mesh: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3, offset = 0.012): void {
    // Offset along the normal so the quad sits proud of the surface.
    mesh.position.copy(point).addScaledVector(normal, offset);
    this.tmpUp.set(0, 0, 1);
    this.tmpQuat.setFromUnitVectors(this.tmpUp, normal);
    mesh.quaternion.copy(this.tmpQuat);
  }

  update(dt: number): void {
    this.pool.forEachAlive((slot, index) => {
      slot.age += dt;
      const remaining = slot.lifetime - slot.age;
      if (remaining <= 0) {
        this.pool.release(index);
        return;
      }
      // Fade over the last two seconds of life.
      if (remaining < 2) {
        const material = slot.mesh.material as THREE.MeshStandardMaterial;
        // Per-instance opacity would need per-instance materials; scaling the
        // decal down instead reads as it wearing away and costs nothing.
        slot.mesh.scale.setScalar(slot.baseScale * (remaining / 2));
        void material;
      }
    });
  }

  setCapacityHint(capacity: number): void {
    // Pools are fixed-size; when the quality preset shrinks the budget we just
    // release the excess so the visual load drops immediately.
    if (this.pool.live <= capacity) return;
    let toRelease = this.pool.live - capacity;
    this.pool.forEachAlive((_slot, index) => {
      if (toRelease-- > 0) this.pool.release(index);
    });
  }

  clear(): void {
    this.pool.releaseAll();
  }

  get liveCount(): number {
    return this.pool.live;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.materials.clear();
    this.group.removeFromParent();
  }
}
