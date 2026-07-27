import { DEPTH_UTILS } from './FullScreenQuad';

/**
 * Depth-only SSAO.
 *
 * No normal buffer: view-space normals are reconstructed from the depth
 * derivatives using the "min difference" trick, which keeps edges crisp
 * without a G-buffer. Runs at half resolution into an R8 target, then gets a
 * 4-tap bilateral blur. Total cost at 1080p is well under a millisecond.
 *
 * The AO term is consumed by the composite pass, where it is applied more
 * strongly to dark (ambient-dominated) pixels than to directly lit ones.
 */

export const SSAO_KERNEL_SIZE = 12;

export const SSAO_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform mat4 uProjection;
uniform mat4 uInverseProjection;
uniform vec3 uKernel[ ${SSAO_KERNEL_SIZE} ];
uniform float uRadius;
uniform float uBias;
uniform float uIntensity;
uniform float uTime;
/** Fragments nearer than this are the view-model - never occlude them. */
uniform float uNearCutoff;

${DEPTH_UTILS}

vec3 viewPosFromDepth( vec2 uv, float rawDepth ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
  vec4 view = uInverseProjection * clip;
  return view.xyz / view.w;
}

void main() {
  float rawDepth = texture2D( tDepth, vUv ).r;
  // Skybox / cleared depth: nothing to occlude.
  if ( rawDepth >= 0.9999 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec3 origin = viewPosFromDepth( vUv, rawDepth );
  float linear = -origin.z;
  if ( linear < uNearCutoff ) { gl_FragColor = vec4( 1.0 ); return; }

  vec2 texel = 1.0 / uResolution;

  // Reconstruct the normal by picking, on each axis, whichever neighbour is
  // closest in depth. Using the far neighbour would smear normals over
  // silhouettes and halo every object edge.
  vec3 pRight = viewPosFromDepth( vUv + vec2( texel.x, 0.0 ), texture2D( tDepth, vUv + vec2( texel.x, 0.0 ) ).r );
  vec3 pLeft  = viewPosFromDepth( vUv - vec2( texel.x, 0.0 ), texture2D( tDepth, vUv - vec2( texel.x, 0.0 ) ).r );
  vec3 pUp    = viewPosFromDepth( vUv + vec2( 0.0, texel.y ), texture2D( tDepth, vUv + vec2( 0.0, texel.y ) ).r );
  vec3 pDown  = viewPosFromDepth( vUv - vec2( 0.0, texel.y ), texture2D( tDepth, vUv - vec2( 0.0, texel.y ) ).r );

  vec3 dx = abs( pRight.z - origin.z ) < abs( origin.z - pLeft.z ) ? ( pRight - origin ) : ( origin - pLeft );
  vec3 dy = abs( pUp.z - origin.z ) < abs( origin.z - pDown.z ) ? ( pUp - origin ) : ( origin - pDown );
  vec3 normal = normalize( cross( dx, dy ) );

  // Per-pixel rotation of the kernel turns banding into high-frequency noise
  // that the blur pass removes.
  float angle = fract( sin( dot( vUv * uResolution, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
  vec3 randomVec = vec3( cos( angle ), sin( angle ), 0.0 );
  vec3 tangent = normalize( randomVec - normal * dot( randomVec, normal ) );
  vec3 bitangent = cross( normal, tangent );
  mat3 tbn = mat3( tangent, bitangent, normal );

  // Shrink the world-space radius with distance so distant geometry does not
  // sample across the whole screen.
  float radius = uRadius * clamp( 8.0 / linear, 0.35, 2.0 );

  float occlusion = 0.0;
  for ( int i = 0; i < ${SSAO_KERNEL_SIZE}; i++ ) {
    vec3 samplePos = origin + ( tbn * uKernel[ i ] ) * radius;
    vec4 offset = uProjection * vec4( samplePos, 1.0 );
    vec2 sampleUv = ( offset.xy / offset.w ) * 0.5 + 0.5;
    if ( sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0 ) continue;

    float sampleRaw = texture2D( tDepth, sampleUv ).r;
    float sampleDepth = -viewPosFromDepth( sampleUv, sampleRaw ).z;
    float diff = ( -samplePos.z ) - sampleDepth;

    // Range check stops a distant background from occluding a foreground edge.
    float rangeCheck = smoothstep( 0.0, 1.0, radius / max( abs( linear - sampleDepth ), 0.0001 ) );
    occlusion += ( diff > uBias ? 1.0 : 0.0 ) * rangeCheck;
  }

  float ao = 1.0 - ( occlusion / float( ${SSAO_KERNEL_SIZE} ) ) * uIntensity;
  gl_FragColor = vec4( clamp( ao, 0.0, 1.0 ), 0.0, 0.0, 1.0 );
}
`;

/** Separable bilateral blur: keeps AO from bleeding across depth discontinuities. */
export const SSAO_BLUR_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform sampler2D tAo;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform vec2 uDirection;

${DEPTH_UTILS}

void main() {
  vec2 texel = uDirection / uResolution;
  float centerDepth = linearizeDepth( texture2D( tDepth, vUv ).r );

  float sum = 0.0;
  float weightSum = 0.0;
  for ( int i = -3; i <= 3; i++ ) {
    vec2 uv = vUv + texel * float( i );
    float d = linearizeDepth( texture2D( tDepth, uv ).r );
    // Gaussian in screen space, exponential falloff in depth.
    float spatial = exp( -float( i * i ) / 8.0 );
    float depthWeight = exp( -abs( d - centerDepth ) * 2.5 );
    float w = spatial * depthWeight;
    sum += texture2D( tAo, uv ).r * w;
    weightSum += w;
  }
  gl_FragColor = vec4( sum / max( weightSum, 0.0001 ), 0.0, 0.0, 1.0 );
}
`;
