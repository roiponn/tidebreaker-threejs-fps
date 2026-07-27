import * as THREE from 'three';

/**
 * Wind animation applied on the GPU.
 *
 * Cables, tarpaulins and hanging cloth must move or the harbour reads as a
 * screenshot. Doing it on the CPU would mean re-uploading vertex buffers every
 * frame; instead each vertex carries an `aWind` weight (0 = pinned, 1 = free
 * end) and the vertex shader displaces it with two out-of-phase sine waves
 * plus a gust term shared by every wind material.
 *
 * The whole system costs one shared uniform object and a handful of ALU.
 */

export const windUniforms = {
  uWindTime: { value: 0 },
  /** Direction the wind blows (world XZ) and its base strength. */
  uWindDir: { value: new THREE.Vector3(-0.82, 0.05, 0.55) },
  uWindStrength: { value: 1 },
  /** Raised briefly by explosions to blow cloth outward. */
  uGust: { value: 0 },
  uGustOrigin: { value: new THREE.Vector3() },
};

/**
 * Patches a material so meshes using it sway.
 * `amplitude` is in metres at aWind = 1.
 */
export function applyWind(material: THREE.Material, amplitude: number, frequency = 1): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, windUniforms, {
      uWindAmplitude: { value: amplitude },
      uWindFrequency: { value: frequency },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aWind;
uniform float uWindTime;
uniform vec3 uWindDir;
uniform float uWindStrength;
uniform float uWindAmplitude;
uniform float uWindFrequency;
uniform float uGust;
uniform vec3 uGustOrigin;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 worldSeed = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  float t = uWindTime * uWindFrequency;
  // Two detuned waves: a slow sway plus a faster flutter.
  float sway = sin( t * 1.3 + worldSeed.x * 0.35 + worldSeed.z * 0.22 );
  float flutter = sin( t * 4.1 + worldSeed.y * 1.7 ) * 0.35;
  float weight = aWind * aWind;
  vec3 offset = normalize( uWindDir ) * ( sway + flutter ) * uWindAmplitude * uWindStrength * weight;
  // Blast wave: a radial shove that decays with distance.
  if ( uGust > 0.001 ) {
    vec3 away = worldSeed - uGustOrigin;
    float d = length( away );
    offset += normalize( away + 1e-4 ) * uGust * weight * ( 1.0 / ( 1.0 + d * d * 0.12 ) );
  }
  transformed += offset;
}`,
      );
    previous?.call(material, shader, renderer);
  };
  material.needsUpdate = true;
}

/**
 * Writes an `aWind` attribute onto a geometry.
 * `weightFn` maps a local vertex position to 0..1 (pinned..free).
 */
export function setWindWeights(
  geometry: THREE.BufferGeometry,
  weightFn: (x: number, y: number, z: number, index: number) => number,
): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const weights = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    weights[i] = weightFn(pos.getX(i), pos.getY(i), pos.getZ(i), i);
  }
  geometry.setAttribute('aWind', new THREE.BufferAttribute(weights, 1));
}

/** Advance the wind clock; call once per frame. */
export function updateWind(elapsed: number, dt: number): void {
  windUniforms.uWindTime.value = elapsed;
  // Gusts decay quickly - a blast should snap cloth, not levitate it.
  windUniforms.uGust.value = Math.max(0, windUniforms.uGust.value - dt * 3.2);
}

export function triggerGust(origin: THREE.Vector3, power: number): void {
  windUniforms.uGustOrigin.value.copy(origin);
  windUniforms.uGust.value = Math.max(windUniforms.uGust.value, power);
}
