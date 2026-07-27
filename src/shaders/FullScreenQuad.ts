import * as THREE from 'three';

/**
 * Minimal fullscreen-triangle helper for the post stack.
 *
 * A single oversized triangle beats a quad: no diagonal seam, one less vertex,
 * and better quad-utilisation on the GPU. Depth test/write are always off, so a
 * post pass can never contaminate the depth texture the next pass reads.
 */
export class FullScreenQuad {
  private static geometry: THREE.BufferGeometry | null = null;
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private mesh: THREE.Mesh;

  constructor(material: THREE.Material) {
    if (!FullScreenQuad.geometry) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
      // The triangle covers the whole clip volume; never frustum-cull it.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
      FullScreenQuad.geometry = geo;
    }
    this.mesh = new THREE.Mesh(FullScreenQuad.geometry, material);
    this.mesh.frustumCulled = false;
    material.depthTest = false;
    material.depthWrite = false;
  }

  get material(): THREE.Material {
    return this.mesh.material as THREE.Material;
  }

  set material(value: THREE.Material) {
    value.depthTest = false;
    value.depthWrite = false;
    this.mesh.material = value;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.mesh, FullScreenQuad.camera);
  }

  dispose(): void {
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Vertex shader shared by every post pass. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Depth helpers shared by SSAO and the composite pass. */
export const DEPTH_UTILS = /* glsl */ `
uniform float uNear;
uniform float uFar;

// three writes a standard non-linear perspective depth buffer.
float linearizeDepth( float rawDepth ) {
  float z = rawDepth * 2.0 - 1.0;
  return ( 2.0 * uNear * uFar ) / ( uFar + uNear - z * ( uFar - uNear ) );
}
`;
