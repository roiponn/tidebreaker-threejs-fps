/**
 * FXAA 3.11-style luma antialiasing (own implementation of the well-known
 * algorithm by T. Lottes; no third-party code is bundled).
 *
 * Why FXAA and not SMAA/TAA:
 *  - the harbour is full of alpha-tested chain-link and thin catwalk railings,
 *    which SMAA's pattern matching handles poorly;
 *  - TAA needs motion vectors, and a 90-second slice does not justify the
 *    velocity buffer plus the ghosting risk on muzzle flashes;
 *  - FXAA runs after tonemapping on an LDR buffer, which is where edge
 *    detection is most reliable.
 *
 * The subpixel term is kept low (0.6) so gun detail and decals stay crisp.
 */
export const FXAA_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
/** 0 = off, 1 = full. Blends the AA result so it can be dialled down. */
uniform float uAmount;

#define EDGE_THRESHOLD_MIN 0.0312
#define EDGE_THRESHOLD_MAX 0.125
#define SUBPIXEL_QUALITY 0.60
#define ITERATIONS 10

float luma( vec3 rgb ) { return sqrt( dot( rgb, vec3( 0.299, 0.587, 0.114 ) ) ); }

void main() {
  vec2 texel = 1.0 / uResolution;
  vec3 centerRgb = texture2D( tDiffuse, vUv ).rgb;
  float lumaCenter = luma( centerRgb );

  float lumaDown  = luma( texture2D( tDiffuse, vUv + vec2( 0.0, -1.0 ) * texel ).rgb );
  float lumaUp    = luma( texture2D( tDiffuse, vUv + vec2( 0.0,  1.0 ) * texel ).rgb );
  float lumaLeft  = luma( texture2D( tDiffuse, vUv + vec2( -1.0, 0.0 ) * texel ).rgb );
  float lumaRight = luma( texture2D( tDiffuse, vUv + vec2(  1.0, 0.0 ) * texel ).rgb );

  float lumaMin = min( lumaCenter, min( min( lumaDown, lumaUp ), min( lumaLeft, lumaRight ) ) );
  float lumaMax = max( lumaCenter, max( max( lumaDown, lumaUp ), max( lumaLeft, lumaRight ) ) );
  float lumaRange = lumaMax - lumaMin;

  // Flat area or very dark region: leave it untouched (and save the taps).
  if ( lumaRange < max( EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX ) ) {
    gl_FragColor = vec4( centerRgb, 1.0 );
    return;
  }

  float lumaDownLeft  = luma( texture2D( tDiffuse, vUv + vec2( -1.0, -1.0 ) * texel ).rgb );
  float lumaUpRight   = luma( texture2D( tDiffuse, vUv + vec2(  1.0,  1.0 ) * texel ).rgb );
  float lumaUpLeft    = luma( texture2D( tDiffuse, vUv + vec2( -1.0,  1.0 ) * texel ).rgb );
  float lumaDownRight = luma( texture2D( tDiffuse, vUv + vec2(  1.0, -1.0 ) * texel ).rgb );

  float lumaDownUp = lumaDown + lumaUp;
  float lumaLeftRight = lumaLeft + lumaRight;
  float lumaLeftCorners = lumaDownLeft + lumaUpLeft;
  float lumaDownCorners = lumaDownLeft + lumaDownRight;
  float lumaRightCorners = lumaDownRight + lumaUpRight;
  float lumaUpCorners = lumaUpRight + lumaUpLeft;

  float edgeHorizontal = abs( -2.0 * lumaLeft + lumaLeftCorners )
    + abs( -2.0 * lumaCenter + lumaDownUp ) * 2.0
    + abs( -2.0 * lumaRight + lumaRightCorners );
  float edgeVertical = abs( -2.0 * lumaUp + lumaUpCorners )
    + abs( -2.0 * lumaCenter + lumaLeftRight ) * 2.0
    + abs( -2.0 * lumaDown + lumaDownCorners );

  bool isHorizontal = edgeHorizontal >= edgeVertical;

  float luma1 = isHorizontal ? lumaDown : lumaLeft;
  float luma2 = isHorizontal ? lumaUp : lumaRight;
  float gradient1 = luma1 - lumaCenter;
  float gradient2 = luma2 - lumaCenter;
  bool is1Steepest = abs( gradient1 ) >= abs( gradient2 );
  float gradientScaled = 0.25 * max( abs( gradient1 ), abs( gradient2 ) );

  float stepLength = isHorizontal ? texel.y : texel.x;
  float lumaLocalAverage = 0.0;
  if ( is1Steepest ) {
    stepLength = -stepLength;
    lumaLocalAverage = 0.5 * ( luma1 + lumaCenter );
  } else {
    lumaLocalAverage = 0.5 * ( luma2 + lumaCenter );
  }

  vec2 currentUv = vUv;
  if ( isHorizontal ) currentUv.y += stepLength * 0.5;
  else currentUv.x += stepLength * 0.5;

  vec2 offset = isHorizontal ? vec2( texel.x, 0.0 ) : vec2( 0.0, texel.y );
  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;

  float lumaEnd1 = luma( texture2D( tDiffuse, uv1 ).rgb ) - lumaLocalAverage;
  float lumaEnd2 = luma( texture2D( tDiffuse, uv2 ).rgb ) - lumaLocalAverage;
  bool reached1 = abs( lumaEnd1 ) >= gradientScaled;
  bool reached2 = abs( lumaEnd2 ) >= gradientScaled;
  bool reachedBoth = reached1 && reached2;

  if ( !reached1 ) uv1 -= offset;
  if ( !reached2 ) uv2 += offset;

  // Walk along the edge until both ends are found, with growing strides.
  if ( !reachedBoth ) {
    for ( int i = 2; i < ITERATIONS; i++ ) {
      float quality = i < 5 ? 1.0 : ( i < 7 ? 1.5 : ( i < 9 ? 2.0 : 4.0 ) );
      if ( !reached1 ) {
        lumaEnd1 = luma( texture2D( tDiffuse, uv1 ).rgb ) - lumaLocalAverage;
        reached1 = abs( lumaEnd1 ) >= gradientScaled;
      }
      if ( !reached2 ) {
        lumaEnd2 = luma( texture2D( tDiffuse, uv2 ).rgb ) - lumaLocalAverage;
        reached2 = abs( lumaEnd2 ) >= gradientScaled;
      }
      if ( reached1 && reached2 ) break;
      if ( !reached1 ) uv1 -= offset * quality;
      if ( !reached2 ) uv2 += offset * quality;
    }
  }

  float distance1 = isHorizontal ? ( vUv.x - uv1.x ) : ( vUv.y - uv1.y );
  float distance2 = isHorizontal ? ( uv2.x - vUv.x ) : ( uv2.y - vUv.y );
  bool isDirection1 = distance1 < distance2;
  float distanceFinal = min( distance1, distance2 );
  float edgeThickness = distance1 + distance2;
  float pixelOffset = -distanceFinal / max( edgeThickness, 0.0001 ) + 0.5;

  bool isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
  bool correctVariation = ( ( isDirection1 ? lumaEnd1 : lumaEnd2 ) < 0.0 ) != isLumaCenterSmaller;
  float finalOffset = correctVariation ? pixelOffset : 0.0;

  // Subpixel term recovers detail FXAA would otherwise smear.
  float lumaAverage = ( 1.0 / 12.0 ) * ( 2.0 * ( lumaDownUp + lumaLeftRight ) + lumaLeftCorners + lumaRightCorners );
  float subPixelOffset1 = clamp( abs( lumaAverage - lumaCenter ) / max( lumaRange, 0.0001 ), 0.0, 1.0 );
  float subPixelOffset2 = ( -2.0 * subPixelOffset1 + 3.0 ) * subPixelOffset1 * subPixelOffset1;
  float subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * SUBPIXEL_QUALITY;
  finalOffset = max( finalOffset, subPixelOffsetFinal );

  vec2 finalUv = vUv;
  if ( isHorizontal ) finalUv.y += finalOffset * stepLength;
  else finalUv.x += finalOffset * stepLength;

  vec3 aa = texture2D( tDiffuse, finalUv ).rgb;
  gl_FragColor = vec4( mix( centerRgb, aa, uAmount ), 1.0 );
}
`;
