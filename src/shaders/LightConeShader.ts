/**
 * Fake volumetric light shaft.
 *
 * An open-ended cone with additive blending and three falloffs:
 *   1. along its length (light thins out with distance from the lamp),
 *   2. toward the silhouette (a shaft is brightest edge-on, giving it volume
 *      instead of reading as a solid ice-cream cone),
 *   3. near the camera (so walking through a shaft fades it out rather than
 *      filling the screen with a flat wash).
 *
 * A subtle noise scroll implies dust and drizzle moving through the beam.
 */
export const LIGHT_CONE_VERT = /* glsl */ `
varying vec3 vViewDir;
varying vec3 vNormalW;
varying float vAlong;
varying vec3 vWorld;
uniform float uLength;

void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorld = worldPosition.xyz;
  vViewDir = normalize( cameraPosition - worldPosition.xyz );
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  // Cylinder is built from y = 0 (apex) down to y = -uLength.
  vAlong = clamp( -position.y / uLength, 0.0, 1.0 );
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const LIGHT_CONE_FRAG = /* glsl */ `
precision highp float;

varying vec3 vViewDir;
varying vec3 vNormalW;
varying float vAlong;
varying vec3 vWorld;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uIntensity;

float hash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.1, 0.2, 0.3 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float noise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( hash( i ), hash( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( hash( i + vec3( 0, 1, 0 ) ), hash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( hash( i + vec3( 0, 0, 1 ) ), hash( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( hash( i + vec3( 0, 1, 1 ) ), hash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
    f.z );
}

void main() {
  // Edge-on brightening: dot -> 0 at the silhouette.
  float facing = 1.0 - abs( dot( normalize( vNormalW ), normalize( vViewDir ) ) );
  float rim = pow( facing, 1.6 );

  // Length falloff, plus a soft start so the cone does not begin with a disc.
  float lengthFade = pow( 1.0 - vAlong, 1.5 ) * smoothstep( 0.0, 0.12, vAlong );

  // Drifting haze inside the beam.
  float dust = noise3( vWorld * 0.9 + vec3( 0.0, -uTime * 0.35, uTime * 0.12 ) );
  float haze = 0.72 + dust * 0.55;

  // Fade out as the camera gets close so you can walk through the beam.
  float camDist = length( cameraPosition - vWorld );
  float nearFade = smoothstep( 0.4, 2.2, camDist );

  float alpha = uOpacity * uIntensity * rim * lengthFade * haze * nearFade;
  if ( alpha <= 0.001 ) discard;
  gl_FragColor = vec4( uColor * alpha, alpha );
}
`;
