/**
 * Analytic dusk sky with a layered horizon.
 *
 * Not a physical Rayleigh model - a physically correct sky at 3 degrees of sun
 * elevation is a narrow orange band on near-black, which reads as "broken
 * renderer" rather than "cinematic dusk". This is an art-directed model with a
 * physically *plausible* structure.
 *
 * STRUCTURE. The previous version was a single gradient with one cloud deck
 * cut off below 22 degrees of elevation - i.e. cloud was removed from exactly
 * the band a first-person player spends all their time looking at, which is
 * why the sky read as a flat wash. This version is built from:
 *
 *   1. A four-stop vertical gradient: horizon -> mid -> upper -> zenith.
 *   2. A warm band tied to the SUN DIRECTION, not to the whole horizon ring.
 *      A dusk glow that wraps 360 degrees is the classic flat-gradient tell.
 *   3. A HAZE BAND at the horizon, coloured with the scene's own fog colour, so
 *      the dome and the distant scenery dissolve into each other instead of
 *      meeting at a visible line.
 *   4. TWO cloud decks at different virtual altitudes, so they parallax against
 *      each other as the player turns:
 *        - high deck: thinner, faster, higher contrast, lit from the sun side
 *        - low deck:  thicker, slower, stretched into horizontal bands
 *      Both run all the way down to the horizon; their scale is compressed as
 *      they approach it, which is what turns a cloud field into layered strata.
 *   5. A RAIN MASS: a darker, denser, low body in one compass direction - the
 *      storm that has just passed. It gives the sky an event and a direction.
 *   6. Stars in the gaps, and distant ordnance lighting the cloud base.
 *
 * Cloud SHADOW is deliberately cool and cloud LIGHT is warm and sun-facing.
 * Lighting the whole deck with the sun colour is what turned the previous sky
 * into flat maroon.
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
uniform vec3 uUpper;
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

/** Scene fog colour + strength of the horizon haze band that uses it. */
uniform vec3 uHazeColor;
uniform float uHazeStrength;
/** Direction the departing storm sits in, and how heavy it still is. */
uniform vec3 uStormDirection;
uniform float uStormStrength;

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

float fbm( vec2 p, int octaves ) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for ( int i = 0; i < 6; i++ ) {
    if ( i >= octaves ) break;
    sum += noise2( p ) * amp;
    norm += amp;
    p *= 2.07;
    p += vec2( 1.7, 9.2 );
    amp *= 0.5;
  }
  return sum / max( norm, 0.0001 );
}

/**
 * Projects a view direction onto a virtual cloud plane at altitude height.
 * minY stops the projection running to infinity at the horizon - without it
 * the cloud detail aliases into noise exactly where it matters most.
 * squash compresses the deck as it nears the horizon, which is what makes a
 * cloud field read as layered strata rather than as a ceiling.
 */
vec2 cloudUv( vec3 dir, float height, float minY, float squash ) {
  float y = max( dir.y, minY );
  vec2 uv = dir.xz * ( height / y );
  float horizonness = 1.0 - smoothstep( minY, 0.55, dir.y );
  return uv * mix( 1.0, squash, horizonness );
}

void main() {
  vec3 dir = normalize( vWorldDirection );
  float h = dir.y;
  float sunDot = max( dot( dir, normalize( uSunDirection ) ), 0.0 );
  float sunSide = pow( clamp( sunDot, 0.0, 1.0 ), 1.4 );

  // --- 1. four-stop vertical gradient ---
  float up = clamp( h, 0.0, 1.0 );
  vec3 sky = mix( uHorizon, uUpper, pow( up, 0.42 ) );
  sky = mix( sky, uZenith, pow( up, 1.35 ) );

  // --- 2. warm band, anchored to the sun rather than the whole ring ---
  float horizonBand = pow( clamp( 1.0 - abs( h ) * 2.6, 0.0, 1.0 ), 2.0 );
  sky = mix( sky, uHorizon, horizonBand * ( 0.22 + sunSide * 0.62 ) );

  // --- sun disc + glow ---
  float glow = pow( sunDot, max( uSunGlowPower * 0.02, 1.0 ) ) * 0.42;
  float wideGlow = pow( sunDot, 5.5 ) * 0.20;
  float disc = smoothstep( 0.9986, 0.9993, sunDot );
  sky += uSunColor * ( glow + wideGlow );
  sky += uSunColor * disc * 5.0;

  // --- 4. two cloud decks ---
  vec2 driftHi = vec2( uTime * uCloudSpeed, uTime * uCloudSpeed * 0.42 );
  vec2 driftLo = vec2( uTime * uCloudSpeed * 0.55, uTime * uCloudSpeed * 0.25 );

  vec2 uvHi = cloudUv( dir, 1.0, 0.045, 0.34 );
  vec2 uvLo = cloudUv( dir, 0.42, 0.030, 0.20 );

  float hiBase = fbm( uvHi * 0.55 + driftHi, 4 );
  float hiField = hiBase * 0.7 + fbm( uvHi * 1.9 - driftHi * 1.7, 3 ) * 0.3;
  float hiDensity = clamp( ( hiField - ( 1.0 - uCloudCoverage ) ) * 2.6, 0.0, 1.0 );

  // Stretched horizontally: banded strata, not blobs.
  float loBase = fbm( uvLo * vec2( 0.30, 0.9 ) + driftLo, 3 );
  float loField = loBase * 0.8 + fbm( uvLo * 1.4 + driftLo * 1.3, 2 ) * 0.2;
  float loDensity = clamp( ( loField - ( 1.05 - uCloudCoverage ) ) * 2.9, 0.0, 1.0 );

  // --- 5. departing storm mass ---
  float stormFacing = max( dot( normalize( vec3( dir.x, 0.0, dir.z ) + 1e-5 ),
                                normalize( vec3( uStormDirection.x, 0.0, uStormDirection.z ) + 1e-5 ) ), 0.0 );
  float stormMask = pow( stormFacing, 2.2 ) * ( 1.0 - smoothstep( 0.02, 0.42, h ) );
  loDensity = clamp( loDensity + stormMask * uStormStrength * 0.85, 0.0, 1.0 );

  // Fade both decks out in the last couple of degrees so the dome never shows
  // a hard terminator against the ground haze.
  float horizonFade = smoothstep( -0.06, 0.05, h );
  hiDensity *= horizonFade;
  loDensity *= horizonFade;

  // --- cloud lighting ---
  vec2 sunOffset = normalize( uSunDirection.xz + vec2( 0.0001 ) ) * 0.4;
  float hiLit = fbm( uvHi * 0.55 + driftHi + sunOffset, 3 );
  float hiShade = clamp( ( hiLit - hiBase ) * 3.2 + 0.5, 0.0, 1.0 );
  float loLit = fbm( uvLo * vec2( 0.30, 0.9 ) + driftLo + sunOffset, 2 );
  float loShade = clamp( ( loLit - loBase ) * 2.6 + 0.42, 0.0, 1.0 );

  vec3 cloudCool = mix( uUpper * 0.55, uZenith * 0.75, 0.35 ) + vec3( 0.004, 0.009, 0.018 );
  vec3 cloudWarm = uSunColor * ( 0.30 + sunSide * 0.95 );

  vec3 hiColor = mix( cloudCool * 1.15, cloudWarm, hiShade * ( 0.20 + sunSide * 0.75 ) );
  vec3 loColor = mix( cloudCool * 0.62, cloudWarm * 0.75, loShade * ( 0.12 + sunSide * 0.55 ) );
  loColor = mix( loColor, loColor * 0.5, stormMask * uStormStrength );

  sky = mix( sky, hiColor, hiDensity * 0.80 );
  sky = mix( sky, loColor, loDensity * 0.88 );

  // --- 6. stars in the gaps ---
  float gaps = ( 1.0 - hiDensity ) * ( 1.0 - loDensity );
  if ( uNight > 0.01 && h > 0.0 && gaps > 0.05 ) {
    vec2 starUv = dir.xz / max( h + 0.35, 0.35 ) * 60.0;
    vec2 cell = floor( starUv );
    float rnd = hash21( cell );
    if ( rnd > 0.9955 ) {
      vec2 local = fract( starUv ) - 0.5 - ( vec2( hash21( cell + 3.1 ), hash21( cell + 7.7 ) ) - 0.5 ) * 0.7;
      float twinkle = 0.65 + 0.35 * sin( uTime * 2.3 + rnd * 62.8 );
      float point = smoothstep( 0.09, 0.0, length( local ) ) * twinkle;
      sky += vec3( 0.85, 0.9, 1.0 ) * point * uStarIntensity * uNight * gaps * smoothstep( 0.05, 0.4, h );
    }
  }

  // --- distant ordnance lighting the cloud base from below ---
  float flashDot = max( dot( dir, normalize( uFlashDirection ) ), 0.0 );
  sky += uFlashColor * uFlashStrength * pow( flashDot, 8.0 ) * ( 0.35 + loDensity * 1.5 );

  // --- 3. haze band: the join between sky and world ---
  float haze = pow( clamp( 1.0 - abs( h ) * 5.5, 0.0, 1.0 ), 1.6 ) * uHazeStrength;
  vec3 hazeColor = uHazeColor + uSunColor * sunSide * 0.10;
  sky = mix( sky, hazeColor, clamp( haze, 0.0, 1.0 ) );

  // Below the horizon: settle into the ground haze.
  float below = smoothstep( 0.0, -0.10, h );
  sky = mix( sky, uGround, below );

  gl_FragColor = vec4( sky, 1.0 );
}
`;
