/**
 * Analytic dusk sky.
 *
 * Not a physical Rayleigh model - a physically correct sky at 3 degrees of sun
 * elevation is a narrow orange band on near-black, which reads as "broken
 * renderer" rather than "cinematic dusk". This is an art-directed gradient with
 * a physically *plausible* structure:
 *
 *   - three-stop vertical gradient (zenith / mid / horizon)
 *   - a sun disc with an inverse-power glow that bleeds into the horizon band
 *   - two layers of scrolling fbm cloud, lit from the sun side and
 *     self-shadowed away from it
 *   - stars that fade in as `uNight` rises, masked by cloud
 *   - a dark, hazy ground half so the dome can be seen below the horizon at
 *     the far end of the harbour without showing a hard seam
 */
export const SKY_VERT = /* glsl */ `
varying vec3 vWorldDirection;
void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldDirection = worldPosition.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Force the dome to the far plane so it never occludes geometry.
  gl_Position.z = gl_Position.w;
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vWorldDirection;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform float uSunGlowPower;
uniform float uNight;
uniform float uStarIntensity;
uniform float uCloudCoverage;
uniform float uCloudSpeed;
uniform float uTime;
/** Distant battle flashes tint the far sky; driven by the ambience system. */
uniform vec3 uFlashColor;
uniform float uFlashStrength;
uniform vec3 uFlashDirection;

float hash21( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}

float noise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = hash21( i );
  float b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) );
  float d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float fbm( vec2 p ) {
  float sum = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 5; i++ ) {
    sum += noise2( p ) * amp;
    p *= 2.07;
    p += vec2( 1.7, 9.2 );
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec3 dir = normalize( vWorldDirection );
  float h = dir.y;

  // --- base gradient ---
  float horizonBlend = pow( clamp( 1.0 - abs( h ), 0.0, 1.0 ), 3.2 );
  float upBlend = clamp( h, 0.0, 1.0 );
  vec3 sky = mix( uHorizon, uZenith, pow( upBlend, 0.55 ) );
  sky = mix( sky, uHorizon, horizonBlend * 0.65 );

  // --- sun disc + glow ---
  float sunDot = max( dot( dir, normalize( uSunDirection ) ), 0.0 );
  float glow = pow( sunDot, uSunGlowPower * 0.02 ) * 0.55;
  float wideGlow = pow( sunDot, 2.2 ) * 0.35;
  float disc = smoothstep( 0.9986, 0.9993, sunDot );
  sky += uSunColor * ( glow + wideGlow );
  sky += uSunColor * disc * 14.0;

  // --- clouds ---
  // Project onto a plane above the viewer so clouds converge at the horizon.
  float cloudPlane = 1.0 / max( abs( h ) + 0.12, 0.12 );
  vec2 cloudUv = dir.xz * cloudPlane;
  vec2 drift = vec2( uTime * uCloudSpeed, uTime * uCloudSpeed * 0.42 );

  float low = fbm( cloudUv * 0.55 + drift );
  float high = fbm( cloudUv * 1.6 - drift * 1.7 );
  float density = clamp( ( low * 0.68 + high * 0.32 - ( 1.0 - uCloudCoverage ) ) * 2.4, 0.0, 1.0 );
  // Clouds thin out at the horizon so the band does not turn into a wall.
  density *= smoothstep( -0.02, 0.22, h );

  // Cheap directional shading: sample the field again offset toward the sun.
  vec2 sunOffset = normalize( uSunDirection.xz + vec2( 0.001 ) ) * 0.35;
  float lit = fbm( cloudUv * 0.55 + drift + sunOffset );
  float shading = clamp( ( lit - low ) * 3.0 + 0.5, 0.0, 1.0 );

  vec3 cloudDark = mix( uZenith * 0.55, uHorizon * 0.35, horizonBlend );
  vec3 cloudLit = mix( uSunColor * 0.9, vec3( 1.0 ), 0.15 ) * ( 0.35 + sunDot * 0.9 );
  vec3 cloudColor = mix( cloudDark, cloudLit, shading * ( 0.35 + sunDot * 0.65 ) );
  sky = mix( sky, cloudColor, density * 0.88 );

  // --- stars, only in the gaps and only once it is dark enough ---
  if ( uNight > 0.01 && h > 0.0 ) {
    vec2 starUv = dir.xz / max( h + 0.35, 0.35 ) * 60.0;
    vec2 cell = floor( starUv );
    float rnd = hash21( cell );
    float star = step( 0.9955, rnd );
    if ( star > 0.0 ) {
      vec2 local = fract( starUv ) - 0.5 - ( vec2( hash21( cell + 3.1 ), hash21( cell + 7.7 ) ) - 0.5 ) * 0.7;
      float d = length( local );
      float twinkle = 0.65 + 0.35 * sin( uTime * 2.3 + rnd * 62.8 );
      float point = smoothstep( 0.09, 0.0, d ) * twinkle;
      sky += vec3( 0.85, 0.9, 1.0 ) * point * uStarIntensity * uNight * ( 1.0 - density ) * smoothstep( 0.02, 0.35, h );
    }
  }

  // --- distant ordnance lighting the cloud base ---
  float flashDot = max( dot( dir, normalize( uFlashDirection ) ), 0.0 );
  sky += uFlashColor * uFlashStrength * pow( flashDot, 8.0 ) * ( 0.4 + density * 1.2 );

  // --- below the horizon: haze, not a hard edge ---
  float below = smoothstep( 0.0, -0.14, h );
  sky = mix( sky, uGround, below );

  gl_FragColor = vec4( sky, 1.0 );
}
`;
