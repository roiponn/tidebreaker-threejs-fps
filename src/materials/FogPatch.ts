import * as THREE from 'three';

/**
 * Global fog upgrade.
 *
 * three's built-in FogExp2 is a single distance term, which makes a harbour
 * look like it is sitting inside a grey ball. Real coastal air after rain has:
 *   1. exponential-squared distance extinction (haze),
 *   2. a dense low-lying mist layer that thins with altitude,
 *   3. aerial perspective - distant objects shift toward the sky colour.
 *
 * We override the three fog ShaderChunks once at module init so EVERY lit
 * material in the scene gets the same atmosphere for free, then inject a
 * SHARED uniform block per material so the debug panel can drive all of them
 * from one object.
 *
 * IMPORTANT: this must run before any material is compiled. `installFogPatch()`
 * is called from the renderer bootstrap.
 */

export interface FogUniforms {
  /** Height (world Y) at which the ground mist layer starts to thin out. */
  uMistBase: { value: number };
  uMistHeight: { value: number };
  uMistDensity: { value: number };
  uAerialColor: { value: THREE.Color };
  uAerialStrength: { value: number };
  /** Sun direction + colour, used to brighten fog looking toward the sun. */
  uFogSunDir: { value: THREE.Vector3 };
  uFogSunColor: { value: THREE.Color };
  uFogSunStrength: { value: number };
}

export const sharedFogUniforms: FogUniforms = {
  uMistBase: { value: 0 },
  uMistHeight: { value: 3.2 },
  uMistDensity: { value: 0.55 },
  uAerialColor: { value: new THREE.Color(0x4a5f7d) },
  uAerialStrength: { value: 0.55 },
  uFogSunDir: { value: new THREE.Vector3(1, 0.1, 0) },
  uFogSunColor: { value: new THREE.Color(0xffb070) },
  uFogSunStrength: { value: 0.45 },
};

let installed = false;

export function installFogPatch(): void {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogWorldY;
  varying vec3 vFogViewDir;
#endif
`;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // worldPosition is provided by <worldpos_vertex> whenever shadows, env maps
  // or spot lights are in use (i.e. always, here). Fall back for the rare
  // unlit-but-fogged material so the shader still links.
  #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
    vFogWorldY = worldPosition.y;
    vFogViewDir = worldPosition.xyz - cameraPosition;
  #else
    // Fallback for unlit/sprite/points shaders where `transformed` and
    // `worldPosition` may not exist: unproject the view-space position.
    vec4 fogWorldPos = inverse( viewMatrix ) * vec4( mvPosition.xyz, 1.0 );
    vFogWorldY = fogWorldPos.y;
    vFogViewDir = fogWorldPos.xyz - cameraPosition;
  #endif
#endif
`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogWorldY;
  varying vec3 vFogViewDir;

  uniform float uMistBase;
  uniform float uMistHeight;
  uniform float uMistDensity;
  uniform vec3 uAerialColor;
  uniform float uAerialStrength;
  uniform vec3 uFogSunDir;
  uniform vec3 uFogSunColor;
  uniform float uFogSunStrength;

  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif

  // Ground mist: density decays exponentially with altitude above uMistBase.
  float altitude = max( vFogWorldY - uMistBase, 0.0 );
  float mistProfile = exp( - altitude / max( uMistHeight, 0.001 ) );
  float mistFactor = 1.0 - exp( - vFogDepth * mistProfile * uMistDensity * 0.045 );
  fogFactor = clamp( fogFactor + mistFactor * ( 1.0 - fogFactor ), 0.0, 1.0 );

  // Aerial perspective: the further away, the more the haze takes the cool
  // colour of the sky rather than the neutral fog colour.
  vec3 atmosphere = mix( fogColor, uAerialColor, uAerialStrength * fogFactor );

  // Forward scattering - fog facing the sun picks up its warmth. This is what
  // separates a lit atmosphere from flat grey wash.
  vec3 viewDir = normalize( vFogViewDir );
  float sunAmount = max( dot( viewDir, normalize( uFogSunDir ) ), 0.0 );
  atmosphere += uFogSunColor * pow( sunAmount, 6.0 ) * uFogSunStrength * fogFactor;

  gl_FragColor.rgb = mix( gl_FragColor.rgb, atmosphere, fogFactor );
#endif
`;
}

/**
 * Attaches the shared fog uniforms to a material. Call once per material,
 * before first render. Chains onto any existing onBeforeCompile.
 */
export function applyFogUniforms(material: THREE.Material): void {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, sharedFogUniforms);
    previous?.call(material, shader, renderer);
  };
  // Force a recompile if the material was already used.
  material.needsUpdate = true;
}
