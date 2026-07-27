/**
 * Progressive down/up-sample bloom (the "COD/Unity HDRP" style chain).
 *
 * Six mip levels, a 13-tap Karis-average downsample and a 9-tap tent upsample.
 * Compared with a two-blur gaussian bloom this is cheaper, does not shimmer on
 * small bright specks, and produces a wide, soft halo that reads as a lens
 * response rather than a glow sticker.
 */

/** Threshold + soft knee + firefly suppression, run once at half resolution. */
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClamp;

vec3 sampleClamped( vec2 uv ) {
  vec3 c = texture2D( tDiffuse, uv ).rgb;
  // Clamp fireflies: a single 500-nit specular pixel would otherwise flicker
  // violently through the mip chain.
  return min( c, vec3( uClamp ) );
}

void main() {
  // 4-tap box downsample first so we bloom the average, not an aliased sample.
  vec3 c = sampleClamped( vUv + uTexel * vec2( -1.0, -1.0 ) );
  c += sampleClamped( vUv + uTexel * vec2( 1.0, -1.0 ) );
  c += sampleClamped( vUv + uTexel * vec2( -1.0, 1.0 ) );
  c += sampleClamped( vUv + uTexel * vec2( 1.0, 1.0 ) );
  c *= 0.25;

  float br = max( c.r, max( c.g, c.b ) );
  float knee = uThreshold * uSoftKnee + 0.0001;
  float soft = clamp( br - uThreshold + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee );
  float contribution = max( soft, br - uThreshold ) / max( br, 0.0001 );

  gl_FragColor = vec4( c * contribution, 1.0 );
}
`;

/** 13-tap downsample with partial Karis averaging (stable, no pulsing). */
export const BLOOM_DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;

void main() {
  vec3 a = texture2D( tDiffuse, vUv + uTexel * vec2( -2.0, 2.0 ) ).rgb;
  vec3 b = texture2D( tDiffuse, vUv + uTexel * vec2( 0.0, 2.0 ) ).rgb;
  vec3 c = texture2D( tDiffuse, vUv + uTexel * vec2( 2.0, 2.0 ) ).rgb;
  vec3 d = texture2D( tDiffuse, vUv + uTexel * vec2( -2.0, 0.0 ) ).rgb;
  vec3 e = texture2D( tDiffuse, vUv ).rgb;
  vec3 f = texture2D( tDiffuse, vUv + uTexel * vec2( 2.0, 0.0 ) ).rgb;
  vec3 g = texture2D( tDiffuse, vUv + uTexel * vec2( -2.0, -2.0 ) ).rgb;
  vec3 h = texture2D( tDiffuse, vUv + uTexel * vec2( 0.0, -2.0 ) ).rgb;
  vec3 i = texture2D( tDiffuse, vUv + uTexel * vec2( 2.0, -2.0 ) ).rgb;
  vec3 j = texture2D( tDiffuse, vUv + uTexel * vec2( -1.0, 1.0 ) ).rgb;
  vec3 k = texture2D( tDiffuse, vUv + uTexel * vec2( 1.0, 1.0 ) ).rgb;
  vec3 l = texture2D( tDiffuse, vUv + uTexel * vec2( -1.0, -1.0 ) ).rgb;
  vec3 m = texture2D( tDiffuse, vUv + uTexel * vec2( 1.0, -1.0 ) ).rgb;

  vec3 result = e * 0.125;
  result += ( a + c + g + i ) * 0.03125;
  result += ( b + d + f + h ) * 0.0625;
  result += ( j + k + l + m ) * 0.125;
  gl_FragColor = vec4( result, 1.0 );
}
`;

/**
 * 9-tap tent upsample, additively blended onto the next larger mip.
 *
 * uWeight attenuates this level's contribution. Because the chain is additive
 * and each step re-reads what the previous step wrote, the weight applied at
 * level i multiplies every level coarser than i as well - so a modest per-step
 * value produces a strong falloff at the widest mips and none at the finest.
 *
 * That is the control that keeps bloom LOCAL. Without it, a large bright area
 * (a fireball filling a quarter of the screen) dumps its energy into the 1/128
 * -resolution mip, which then tints the entire frame - including the sky -
 * uniformly. Small emitters never revealed the problem because they never
 * survive far enough down the chain to reach those mips with any energy.
 */
export const BLOOM_UPSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;

void main() {
  vec2 o = uTexel * uRadius;
  vec3 result = texture2D( tDiffuse, vUv + vec2( -o.x, o.y ) ).rgb;
  result += texture2D( tDiffuse, vUv + vec2( 0.0, o.y ) ).rgb * 2.0;
  result += texture2D( tDiffuse, vUv + vec2( o.x, o.y ) ).rgb;
  result += texture2D( tDiffuse, vUv + vec2( -o.x, 0.0 ) ).rgb * 2.0;
  result += texture2D( tDiffuse, vUv ).rgb * 4.0;
  result += texture2D( tDiffuse, vUv + vec2( o.x, 0.0 ) ).rgb * 2.0;
  result += texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
  result += texture2D( tDiffuse, vUv + vec2( 0.0, -o.y ) ).rgb * 2.0;
  result += texture2D( tDiffuse, vUv + vec2( o.x, -o.y ) ).rgb;
  gl_FragColor = vec4( result * ( uWeight / 16.0 ), 1.0 );
}
`;
