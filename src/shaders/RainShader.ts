/**
 * GPU-resident drizzle.
 *
 * Every streak lives at a fixed offset inside an 32x18x32 box; the vertex
 * shader falls it, wraps it with `mod`, and re-centres the whole box on the
 * camera each frame. Nothing is ever updated from JavaScript, so the rain
 * costs one draw call and zero CPU regardless of density.
 *
 * The quad is billboarded around the vertical axis only, so streaks always
 * stay vertical-ish and read as falling water rather than as facing sprites.
 */
export const RAIN_VERT = /* glsl */ `
attribute vec3 aOffset;
/** x = fall speed multiplier, y = brightness/length variation. */
attribute vec2 aParams;

uniform float uTime;
uniform vec3 uCameraPos;
uniform vec3 uWindDir;
uniform float uAmount;

varying float vFade;
varying vec2 vUv;

const vec3 BOX = vec3( 32.0, 18.0, 32.0 );

void main() {
  vUv = uv;

  float speed = 11.0 * aParams.x;
  vec3 base = aOffset;
  // Fall + wind drift, wrapped inside the box.
  base.y = mod( base.y - uTime * speed, BOX.y );
  base.xz += uWindDir.xz * ( BOX.y - base.y ) * 0.12;
  base = mod( base + BOX * 0.5, BOX ) - BOX * 0.5;

  vec3 worldCenter = uCameraPos + base;
  // Skip streaks that would render inside the player's face.
  float nearFade = smoothstep( 0.6, 2.5, length( worldCenter - uCameraPos ) );

  // Billboard around Y only.
  vec3 toCam = uCameraPos - worldCenter;
  toCam.y = 0.0;
  vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), normalize( toCam ) ) );
  float stretch = 0.6 + aParams.y * 1.4;
  vec3 world = worldCenter + right * position.x + vec3( 0.0, position.y * stretch, 0.0 );

  vFade = nearFade * aParams.y * step( 0.001, uAmount ) * uAmount;

  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

export const RAIN_FRAG = /* glsl */ `
precision mediump float;
varying float vFade;
varying vec2 vUv;
uniform vec3 uColor;

void main() {
  if ( vFade <= 0.001 ) discard;
  // Taper both ends of the streak so it does not read as a hard bar.
  float taper = sin( vUv.y * 3.14159 );
  float across = 1.0 - abs( vUv.x * 2.0 - 1.0 );
  float alpha = taper * across * vFade * 0.34;
  gl_FragColor = vec4( uColor, alpha );
}
`;
