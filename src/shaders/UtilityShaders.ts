/** Small helper passes: copy, luminance reduction and exposure adaptation. */

export const COPY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }
`;

/**
 * Scene -> 64x64 log-luminance.
 *
 * Log space is important: averaging linear luminance lets one bright lamp
 * dominate the whole frame and pump the exposure. A 4-tap box at this ratio is
 * a heavy under-sample, but auto-exposure only needs the rough key of the
 * frame, and the temporal filter removes the noise.
 */
export const LUMINANCE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;

float lum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

void main() {
  vec3 a = texture2D( tDiffuse, vUv + uTexel * vec2( -2.0, -2.0 ) ).rgb;
  vec3 b = texture2D( tDiffuse, vUv + uTexel * vec2(  2.0, -2.0 ) ).rgb;
  vec3 c = texture2D( tDiffuse, vUv + uTexel * vec2( -2.0,  2.0 ) ).rgb;
  vec3 d = texture2D( tDiffuse, vUv + uTexel * vec2(  2.0,  2.0 ) ).rgb;
  float l = ( lum( a ) + lum( b ) + lum( c ) + lum( d ) ) * 0.25;
  // Centre-weighting: the middle of the screen is what the player is looking at.
  float weight = 1.0 - length( vUv - 0.5 ) * 0.9;
  gl_FragColor = vec4( log( max( l, 0.0002 ) ) * weight, weight, 0.0, 1.0 );
}
`;

/** Successive 4-tap averaging down to 1x1. Keeps the weight in .g. */
export const LUMINANCE_REDUCE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
void main() {
  vec2 a = texture2D( tDiffuse, vUv + uTexel * vec2( -1.0, -1.0 ) ).rg;
  vec2 b = texture2D( tDiffuse, vUv + uTexel * vec2(  1.0, -1.0 ) ).rg;
  vec2 c = texture2D( tDiffuse, vUv + uTexel * vec2( -1.0,  1.0 ) ).rg;
  vec2 d = texture2D( tDiffuse, vUv + uTexel * vec2(  1.0,  1.0 ) ).rg;
  gl_FragColor = vec4( ( a + b + c + d ) * 0.25, 0.0, 1.0 );
}
`;

/**
 * 1x1 temporal adaptation. Ping-ponged so the previous frame's adapted value
 * is available without a GPU->CPU readback (which would stall the pipeline).
 */
export const EXPOSURE_ADAPT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tPrevious;
uniform float uSpeed;
uniform float uDelta;
void main() {
  vec2 cur = texture2D( tCurrent, vec2( 0.5 ) ).rg;
  float target = exp( cur.r / max( cur.g, 0.0001 ) );
  float previous = texture2D( tPrevious, vec2( 0.5 ) ).r;
  if ( previous <= 0.0 ) previous = target;
  // Frame-rate independent exponential approach.
  float adapted = target + ( previous - target ) * exp( -uSpeed * uDelta );
  gl_FragColor = vec4( adapted, 0.0, 0.0, 1.0 );
}
`;
