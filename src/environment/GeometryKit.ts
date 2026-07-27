import * as THREE from 'three';

/**
 * Reusable geometry builders.
 *
 * The rule this file exists to enforce: NOTHING in the harbour is a raw
 * BoxGeometry. A perfectly sharp 90-degree edge catches zero specular, which
 * is the single biggest reason untextured 3D looks like untextured 3D. Every
 * hard-surface prop is built from `chamferBox`, which puts a 1-3cm bevel on
 * every edge so grazing light draws a bright line along it.
 *
 * Geometries returned here are NOT cached - the caller is expected to build
 * once and reuse via InstancedMesh or shared references.
 */

/**
 * Box with every edge chamfered.
 * Built as an extruded rounded rectangle: the rounded profile chamfers the
 * four long edges, and the extrude bevel chamfers the eight end edges.
 */
export function chamferBox(
  width: number,
  height: number,
  depth: number,
  chamfer = 0.02,
  cornerSegments = 1,
): THREE.BufferGeometry {
  const c = Math.min(chamfer, width * 0.4, height * 0.4, depth * 0.4);
  const w = width - c * 2;
  const h = height - c * 2;

  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x, y + c);
  shape.lineTo(x, y + h - c);
  shape.quadraticCurveTo(x, y + h, x + c, y + h);
  shape.lineTo(x + w - c, y + h);
  shape.quadraticCurveTo(x + w, y + h, x + w, y + h - c);
  shape.lineTo(x + w, y + c);
  shape.quadraticCurveTo(x + w, y, x + w - c, y);
  shape.lineTo(x + c, y);
  shape.quadraticCurveTo(x, y, x, y + c);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - c * 2,
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelSegments: cornerSegments,
    curveSegments: cornerSegments,
    steps: 1,
  });
  geo.translate(0, 0, -(depth - c * 2) / 2);
  geo.computeVertexNormals();
  applyBoxUv(geo);
  return geo;
}

/**
 * Triplanar-ish box UVs. ExtrudeGeometry's own UVs are useless for tiling
 * textures (they are shape-space), so we re-project per face using the
 * dominant normal axis. World-scale UVs mean one concrete material tiles
 * consistently across props of different sizes.
 */
export function applyBoxUv(geometry: THREE.BufferGeometry, scale = 1): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const nor = geometry.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = pz;
      v = py;
    } else if (ny >= nx && ny >= nz) {
      u = px;
      v = pz;
    } else {
      u = px;
      v = py;
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Corrugated sheet with real geometric ribs.
 * A normal map alone breaks down at grazing angles and on the silhouette,
 * which is exactly where cladding is usually seen.
 */
export function corrugatedPanel(
  width: number,
  height: number,
  ribCount = 14,
  ribDepth = 0.035,
): THREE.BufferGeometry {
  const segX = ribCount * 4;
  const geo = new THREE.PlaneGeometry(width, height, segX, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = (x / width + 0.5) * ribCount * Math.PI * 2;
    pos.setZ(i, Math.cos(t) * ribDepth);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Shipping container: chamfered shell plus the corrugated side relief. */
export function containerBody(
  length: number,
  height: number,
  depth: number,
): { shell: THREE.BufferGeometry; side: THREE.BufferGeometry; end: THREE.BufferGeometry } {
  return {
    shell: chamferBox(length, height, depth, 0.045, 2),
    side: corrugatedPanel(length - 0.16, height - 0.28, Math.round(length * 1.6), 0.028),
    end: corrugatedPanel(depth - 0.16, height - 0.28, Math.round(depth * 1.6), 0.022),
  };
}

/** Catenary curve between two points; `sag` is the droop at midspan. */
export function catenaryPoints(
  from: THREE.Vector3,
  to: THREE.Vector3,
  sag: number,
  segments = 14,
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new THREE.Vector3().lerpVectors(from, to, t);
    // cosh-shaped droop, normalised so the endpoints stay put.
    const s = (t - 0.5) * 2;
    p.y -= sag * (1 - s * s);
    points.push(p);
  }
  return points;
}

/** Tube along an arbitrary polyline - pipes, cables, conduit. */
export function tubeAlong(
  points: THREE.Vector3[],
  radius: number,
  radialSegments = 6,
  tubularSegments?: number,
): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.35);
  return new THREE.TubeGeometry(curve, tubularSegments ?? points.length * 3, radius, radialSegments, false);
}

/**
 * An I-beam profile extruded along Z. Structural steel with a real profile
 * reads instantly as "built" rather than "modelled from cubes".
 */
export function iBeam(length: number, height = 0.26, flangeWidth = 0.16, thickness = 0.022): THREE.BufferGeometry {
  const hw = flangeWidth / 2;
  const hh = height / 2;
  const t = thickness;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, -hh + t);
  shape.lineTo(t / 2, -hh + t);
  shape.lineTo(t / 2, hh - t);
  shape.lineTo(hw, hh - t);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.lineTo(-hw, hh - t);
  shape.lineTo(-t / 2, hh - t);
  shape.lineTo(-t / 2, -hh + t);
  shape.lineTo(-hw, -hh + t);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 1,
    steps: 1,
  });
  geo.translate(0, 0, -length / 2);
  geo.computeVertexNormals();
  applyBoxUv(geo, 0.5);
  return geo;
}

/** Hollow square tube - handrails, frames, fence posts. */
export function squareTube(length: number, size = 0.05): THREE.BufferGeometry {
  const geo = chamferBox(size, size, length, size * 0.22, 1);
  return geo;
}

/**
 * Merge a list of geometries that share a material into one buffer.
 * Cuts draw calls hard on props built from many small parts.
 */
export function mergeGeometries(
  geometries: THREE.BufferGeometry[],
  matrices: THREE.Matrix4[],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  let offset = 0;

  for (let g = 0; g < geometries.length; g++) {
    const geo = geometries[g];
    const matrix = matrices[g] ?? new THREE.Matrix4();
    normalMatrix.getNormalMatrix(matrix);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nor = geo.attributes.normal as THREE.BufferAttribute | undefined;
    const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      positions.push(v.x, v.y, v.z);
      if (nor) {
        v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
        normals.push(v.x, v.y, v.z);
      } else {
        normals.push(0, 1, 0);
      }
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    const index = geo.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(index.getX(i) + offset);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(i + offset);
    }
    offset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(indices);
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** Convenience: build a matrix from position/rotation/scale in one call. */
export function trs(
  px: number,
  py: number,
  pz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}
