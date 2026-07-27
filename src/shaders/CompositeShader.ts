import { DEPTH_UTILS } from './FullScreenQuad';

/**
 * The single "beauty" pass: DoF + motion blur + AO application + bloom
 * combine + exposure + ACES tonemap + grade + vignette + grain + chromatic
 * aberration, all in one fragment shader.
 *
 * Folding them together means ONE full-resolution pass instead of six, which
 * is the difference between 60fps and 40fps at 1080p. The ordering below is
 * deliberate and matches a film pipeline:
 *
 *   scene-referred (linear HDR)
 *     -> optical effects that happen at the lens (DoF, motion, CA, bloom)
 *     -> exposure
 *     -> tonemap (scene-referred -> display-referred)
 *     -> creative grade (contrast/saturation/split-tone)
 *     -> sensor artefacts (vignette, grain)
 *     -> sRGB encode
 *
 * Doing the grade *before* the tonemap - a very common mistake - is what makes
 * a scene look muddy and crushed.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tAo;
uniform sampler2D tDepth;
/** 1x1 temporally adapted average luminance, produced by the exposure pass. */
uniform sampler2D tAdapt;

uniform vec2 uResolution;
uniform float uTime;

/** Luminance-preserving linear RGB gain from the white-balance control. */
uniform vec3 uWhiteBalance;
uniform float uExposure;
/** How far auto-exposure may drift from the authored base exposure. */
uniform float uAdaptRange;
uniform float uBloomStrength;
uniform float uAoIntensity;

// Depth of field
uniform float uDofFocus;
uniform float uDofStrength;
uniform float uDofMaxBlur;
uniform float uDofNearStart;

// Motion blur (camera-rotation driven, in screen space)
uniform vec2 uMotionDir;
uniform float uMotionStrength;

// Grade
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uSplitShadow;
uniform vec3 uSplitHighlight;
uniform float uSplitBalance;
uniform float uVignette;
uniform float uVignetteSoftness;
uniform float uGrain;
uniform float uChroma;

// Damage / hit feedback: a red radial pulse driven by gameplay, kept in the
// composite so it survives tonemapping instead of being a DOM overlay.
uniform float uDamageFlash;
uniform vec3 uDamageColor;
/** Fades the whole frame for the intro / death transitions. */
uniform float uFade;
uniform vec3 uFadeColor;

${DEPTH_UTILS}

// 12-point Poisson disk - even coverage with no visible sampling pattern.
const vec2 POISSON[ 12 ] = vec2[](
  vec2( -0.326, -0.406 ), vec2( -0.840, -0.074 ), vec2( -0.696,  0.457 ),
  vec2( -0.203,  0.621 ), vec2(  0.962, -0.195 ), vec2(  0.473, -0.480 ),
  vec2(  0.519,  0.767 ), vec2(  0.185, -0.893 ), vec2(  0.507,  0.064 ),
  vec2(  0.896,  0.412 ), vec2( -0.322, -0.933 ), vec2( -0.792, -0.598 )
);

float cocFromDepth( float linearDepth ) {
  // Far field: signed distance beyond focus, normalised and eased.
  float far = clamp( ( linearDepth - uDofFocus ) / max( uDofFocus, 1.0 ), 0.0, 1.0 );
  far = pow( far, 0.65 );
  // Near field: only very close geometry, so the weapon barely softens.
  float near = 1.0 - smoothstep( uDofNearStart * 0.45, uDofNearStart, linearDepth );
  return clamp( max( far, near * 0.55 ) * uDofStrength, 0.0, 1.0 );
}

void main() {
  vec2 texel = 1.0 / uResolution;
  float rawDepth = texture2D( tDepth, vUv ).r;
  float linearDepth = rawDepth >= 0.9999 ? uFar : linearizeDepth( rawDepth );

  float coc = cocFromDepth( linearDepth );
  float blurPx = coc * uDofMaxBlur;
  float motionPx = uMotionStrength * 6.0;

  vec3 color;
  if ( blurPx > 0.35 || motionPx > 0.35 ) {
    // Single combined gather: a poisson disk stretched along the motion
    // vector. One loop instead of two separate blurs.
    vec3 sum = texture2D( tDiffuse, vUv ).rgb;
    float weightSum = 1.0;
    for ( int i = 0; i < 12; i++ ) {
      float t = ( float( i ) / 11.0 ) - 0.5;
      vec2 offset = POISSON[ i ] * blurPx * texel + uMotionDir * motionPx * t * texel;
      vec2 uv = vUv + offset;
      // Reject samples that are much closer than the centre: stops sharp
      // foreground objects bleeding onto blurred backgrounds.
      float sampleDepth = linearizeDepth( texture2D( tDepth, uv ).r );
      float w = sampleDepth > linearDepth - 0.6 ? 1.0 : 0.15;
      sum += texture2D( tDiffuse, uv ).rgb * w;
      weightSum += w;
    }
    color = sum / weightSum;
  } else {
    color = texture2D( tDiffuse, vUv ).rgb;
  }

  // Chromatic aberration: lateral colour error grows toward the frame edge.
  if ( uChroma > 0.0 ) {
    vec2 dir = vUv - 0.5;
    float edge = dot( dir, dir );
    vec2 off = dir * uChroma * edge * 4.0;
    color.r = texture2D( tDiffuse, vUv + off ).r;
    color.b = texture2D( tDiffuse, vUv - off ).b;
  }

  // Ambient occlusion. Applied proportionally to how ambient-dominated the
  // pixel is: a directly lit surface should not be darkened by SSAO.
  float ao = texture2D( tAo, vUv ).r;
  float lum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  float ambientWeight = 1.0 - smoothstep( 0.05, 0.85, lum );
  color *= mix( 1.0, ao, uAoIntensity * ambientWeight );

  // Bloom is added in scene-referred space so it tonemaps with the image.
  color += texture2D( tBloom, vUv ).rgb * uBloomStrength;

  // Damage feedback pulses before exposure so it feels like light, not paint.
  //
  // It MUST be a vignette. The previous form had a 0.35 constant term, which
  // added the same red to every pixel in the frame - the sky included. Any
  // hit, however trivial, therefore washed the whole image with a flat colour
  // that no amount of exposure work could recover, and it was indistinguishable
  // from a rendering fault. Zero in the centre, rising toward the corners,
  // leaves the scene readable while still being impossible to miss.
  float dmgR = length( vUv - 0.5 ) * 1.4142;
  color += uDamageColor * uDamageFlash * ( pow( dmgR, 2.6 ) * 1.7 + 0.03 );

  // White balance, in scene-referred linear space and BEFORE the tonemap -
  // the only place it is physically meaningful. Balancing the camera for a
  // warm illuminant cools the world and leaves genuinely warm sources (sodium
  // lamps, muzzle flashes, fire) reading as warm against it.
  color *= uWhiteBalance;

  // Auto-exposure: nudge the authored exposure toward an 18% grey key, but
  // never let it wander far - a shooter must not re-expose every time the
  // player looks at a lamp, or dark corners become unreadable.
  float adapted = max( texture2D( tAdapt, vec2( 0.5 ) ).r, 0.0004 );
  float autoScale = clamp( 0.16 / adapted, 1.0 - uAdaptRange, 1.0 + uAdaptRange );
  color *= uExposure * autoScale;

  // ACES filmic (Narkowicz fit) - the highlight rolloff is what stops bright
  // muzzle flashes from clipping to flat white.
  const mat3 ACES_IN = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 ACES_OUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  vec3 v = ACES_IN * color;
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  color = clamp( ACES_OUT * ( a / b ), 0.0, 1.0 );

  // ---- display-referred grade ----
  color = ( color - 0.5 ) * uContrast + 0.5;
  color = uLift + color * ( uGain - uLift );

  float gradeLum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = mix( vec3( gradeLum ), color, uSaturation );

  // Split toning: cool shadows, warm highlights.
  // The tone is NORMALISED to unit luminance first, so it shifts hue without
  // changing brightness. Multiplying by a raw colour (the naive version) both
  // darkens and tints, which is what turns a dusk scene into a red smear.
  float toneMask = smoothstep( 0.0, 1.0, gradeLum );
  vec3 tone = mix( uSplitShadow, uSplitHighlight, toneMask );
  tone /= max( dot( tone, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0001 );
  // Strongest in the mid-tones; leaves true blacks and true whites neutral.
  float toneWeight = uSplitBalance * ( 1.0 - abs( gradeLum * 2.0 - 1.0 ) );
  color = mix( color, color * tone, clamp( toneWeight, 0.0, 1.0 ) );

  // Vignette - optical, so it must not crush shadow detail to pure black.
  vec2 vd = ( vUv - 0.5 ) * vec2( uResolution.x / uResolution.y, 1.0 );
  float vig = 1.0 - smoothstep( uVignetteSoftness, 1.25, length( vd ) * 1.35 ) * uVignette;
  color *= vig;

  // Animated film grain, scaled down in highlights like real sensor noise.
  float n = fract( sin( dot( vUv * uResolution + uTime * 91.7, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  color += ( n - 0.5 ) * uGrain * ( 1.0 - gradeLum * 0.7 );

  color = mix( color, uFadeColor, uFade );
  color = max( color, vec3( 0.0 ) );

  // Linear -> sRGB. This pass writes directly to an 8-bit target, so the
  // encode has to happen here; there is no OutputPass after us.
  vec3 srgbLo = color * 12.92;
  vec3 srgbHi = 1.055 * pow( color, vec3( 1.0 / 2.4 ) ) - 0.055;
  vec3 srgb = mix( srgbHi, srgbLo, step( color, vec3( 0.0031308 ) ) );

  gl_FragColor = vec4( srgb, 1.0 );
}
`;
