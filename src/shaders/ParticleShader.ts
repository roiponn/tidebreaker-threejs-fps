/**
 * Instanced billboard particles.
 *
 * Two variants share this file:
 *  - ADDITIVE: sparks, muzzle flash, fire. Emissive, no lighting.
 *  - LIT (alpha-blended): smoke, dust, steam. These are shaded with a
 *    spherical billboard normal - the quad's UV is treated as the surface of a
 *    sphere, so each puff gets a real lambert term from the sun plus ambient.
 *    Without that, smoke is a flat grey sticker, which is the single most
 *    common "cheap particle" tell.
 *
 * Both variants soft-fade against the depth buffer so particles do not cut a
 * hard line where they intersect the ground or a wall.
 */

export const PARTICLE_VERT = /* glsl */ `
attribute vec3 aPosition;
attribute vec3 aColor;
attribute float aSize;
attribute float aRotation;
attribute float aAlpha;
/** x = brightness multiplier, y = 0..1 age (drives the shader-side curves). */
attribute vec2 aParams;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vBright;
varying float vAge;
varying vec4 vProjected;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vWorldPos = aPosition;
  vColor = aColor;
  vAlpha = aAlpha;
  vBright = aParams.x;
  vAge = aParams.y;

  vec4 viewCenter = viewMatrix * vec4( aPosition, 1.0 );
  float c = cos( aRotation );
  float s = sin( aRotation );
  vec2 rotated = vec2(
    position.x * c - position.y * s,
    position.x * s + position.y * c
  ) * aSize;
  viewCenter.xy += rotated;

  vProjected = projectionMatrix * viewCenter;
  gl_Position = vProjected;
}
`;

/** Shared tail: soft depth fade + circular mask. */
const PARTICLE_COMMON = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vBright;
varying float vAge;
varying vec4 vProjected;

uniform sampler2D uTexture;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uSoftness;

float linearDepth( float raw ) {
  float z = raw * 2.0 - 1.0;
  return ( 2.0 * uNear * uFar ) / ( uFar + uNear - z * ( uFar - uNear ) );
}

/**
 * Fades the particle out as it approaches opaque geometry.
 * uSoftness is in metres; 0 disables the test (used when no depth texture is
 * bound yet, e.g. on the very first frame).
 */
float softFade() {
  if ( uSoftness <= 0.0 ) return 1.0;
  vec2 screenUv = ( vProjected.xy / vProjected.w ) * 0.5 + 0.5;
  float sceneDepth = linearDepth( texture2D( uDepth, screenUv ).r );
  float particleDepth = vProjected.w;
  return clamp( ( sceneDepth - particleDepth ) / uSoftness, 0.0, 1.0 );
}
`;

export const PARTICLE_ADDITIVE_FRAG = /* glsl */ `
precision highp float;
${PARTICLE_COMMON}

void main() {
  vec4 tex = texture2D( uTexture, vUv );
  float alpha = tex.a * vAlpha * softFade();
  if ( alpha <= 0.002 ) discard;
  // Additive: premultiplied by alpha, brightness pushes it into HDR so the
  // bloom pass picks it up.
  gl_FragColor = vec4( vColor * tex.rgb * vBright * alpha, alpha );
}
`;

export const PARTICLE_LIT_FRAG = /* glsl */ `
precision highp float;
${PARTICLE_COMMON}

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
/** Blast light: xyz = world position, w = intensity. Zero when no explosion. */
uniform vec4 uFlashLight;
uniform vec3 uFlashColor;
varying vec3 vWorldPos;

void main() {
  vec4 tex = texture2D( uTexture, vUv );
  float alpha = tex.a * vAlpha * softFade();
  if ( alpha <= 0.002 ) discard;

  // Spherical billboard normal: treat the quad as the front of a sphere.
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot( p, p );
  if ( r2 > 1.0 ) r2 = 1.0;
  vec3 viewNormal = normalize( vec3( p, sqrt( 1.0 - r2 ) ) );
  // Back to world space so the sun direction is meaningful.
  vec3 worldNormal = normalize( ( vec4( viewNormal, 0.0 ) * viewMatrix ).xyz );

  float lambert = max( dot( worldNormal, normalize( uSunDirection ) ), 0.0 );
  // Wrapped lighting: smoke scatters light around to its dark side.
  float wrapped = lambert * 0.62 + 0.38;
  vec3 lit = uAmbientColor * uAmbientIntensity + uSunColor * wrapped;

  // Young smoke is hot and bright, old smoke is cold and thin.
  vec3 color = vColor * lit * ( 1.0 + vBright );

  // SMOKE CATCHES THE FLASH.
  // Without this the blast lights every solid surface but leaves its own smoke
  // column unlit, which reads as a bright room with a grey cut-out in it. The
  // same 1/d^2 falloff as the real light, plus the spherical billboard normal
  // so the side of the puff facing the blast is brighter.
  if ( uFlashLight.w > 0.001 ) {
    vec3 toFlash = uFlashLight.xyz - vWorldPos;
    float distSq = max( dot( toFlash, toFlash ), 0.35 );
    float facing = max( dot( worldNormal, normalize( toFlash ) ), 0.0 ) * 0.6 + 0.4;
    // Weighted by youth. Old smoke has expanded into a thin, wide veil that
    // can cover the whole frame; letting THAT catch the flash tints the entire
    // image - sky included - which reads as a colour filter rather than as a
    // lit smoke column. Only the compact young smoke still at the blast should
    // respond, which is also the physically sensible answer: it is the only
    // smoke dense enough to scatter that much light.
    float youth = 1.0 - smoothstep( 0.15, 0.6, vAge );
    color += uFlashColor * ( uFlashLight.w / distSq ) * facing * youth;
  }

  gl_FragColor = vec4( color * tex.rgb, alpha );
}
`;
