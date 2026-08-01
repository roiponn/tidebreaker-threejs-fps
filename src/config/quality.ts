/**
 * Quality presets. Every performance-relevant knob is here so a single switch
 * reconfigures the renderer, post stack and VFX budgets consistently.
 *
 * "high" targets 1080p / 60fps on a discrete GPU.
 * "medium" is the safe default for integrated GPUs.
 * "low" strips every optional pass but keeps the art direction intact.
 */

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualitySettings {
  label: string;
  /** Device pixel ratio ceiling. */
  maxPixelRatio: number;
  /** Internal render scale multiplier applied on top of DPR. */
  renderScale: number;
  shadows: boolean;
  shadowMapSize: number;
  /**
   * Number of practical lights allowed to cast shadows.
   * Currently 0 on every preset: each one costs a full extra scene render and
   * measured at ~15% of frame time for a barely visible result. Kept as a knob
   * because a future scene with fewer objects could afford one.
   */
  shadowCastingPracticals: number;
  ssao: boolean;
  /** SSAO render scale relative to the main framebuffer. */
  ssaoScale: number;
  bloom: boolean;
  /** Planar reflection for the wet ground. The single most expensive feature. */
  planarReflection: boolean;
  reflectionScale: number;
  dof: boolean;
  motionBlur: boolean;
  /** Post antialiasing (FXAA). */
  antialias: boolean;
  /** Volumetric light cone meshes. */
  lightShafts: boolean;
  /** Max simultaneous particles across every VFX pool. */
  particleBudget: number;
  /** Max bullet-hole / scorch decals kept alive. */
  decalBudget: number;
  /** Distant-city / skyline detail level. */
  distantDetail: number;
  /** Anisotropic filtering cap. */
  anisotropy: number;
  rainMultiplier: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    label: 'Performance',
    maxPixelRatio: 1,
    renderScale: 0.85,
    shadows: true,
    shadowMapSize: 1024,
    shadowCastingPracticals: 0,
    ssao: false,
    ssaoScale: 0.5,
    bloom: true,
    planarReflection: false,
    reflectionScale: 0.35,
    dof: false,
    motionBlur: false,
    antialias: false,
    lightShafts: false,
    particleBudget: 900,
    decalBudget: 40,
    distantDetail: 0.45,
    anisotropy: 2,
    rainMultiplier: 0.5,
  },
  medium: {
    label: 'Balanced',
    maxPixelRatio: 1.5,
    renderScale: 1,
    shadows: true,
    shadowMapSize: 2048,
    shadowCastingPracticals: 0,
    ssao: true,
    ssaoScale: 0.5,
    bloom: true,
    planarReflection: true,
    reflectionScale: 0.4,
    dof: true,
    motionBlur: true,
    antialias: true,
    lightShafts: true,
    particleBudget: 1800,
    decalBudget: 80,
    distantDetail: 0.75,
    anisotropy: 4,
    rainMultiplier: 1,
  },
  high: {
    label: 'Cinematic',
    maxPixelRatio: 2,
    renderScale: 1,
    shadows: true,
    shadowMapSize: 2048,
    shadowCastingPracticals: 0,
    ssao: true,
    ssaoScale: 0.6,
    bloom: true,
    planarReflection: true,
    reflectionScale: 0.5,
    dof: true,
    motionBlur: true,
    antialias: true,
    lightShafts: true,
    particleBudget: 3200,
    decalBudget: 140,
    distantDetail: 1,
    anisotropy: 8,
    rainMultiplier: 1,
  },
};

export const DEFAULT_QUALITY: QualityLevel = 'high';

/**
 * Rough auto-detect so first launch is not a slideshow on a laptop iGPU.
 * `?quality=low|medium|high` in the URL overrides it, which is how the
 * presets are compared when profiling.
 */
export function detectQuality(): QualityLevel {
  const forced = new URLSearchParams(window.location.search).get('quality');
  if (forced === 'low' || forced === 'medium' || forced === 'high') return forced;
  // Phones and tablets trade thermal headroom for battery life. Starting on
  // the performance preset keeps long firefights stable; players can still
  // force another preset with ?quality=medium or ?quality=high.
  const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
  if (touchDevice) return 'low';
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency ?? 4;
  const gl = document.createElement('canvas').getContext('webgl2');
  let renderer = '';
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
  }
  const lowered = renderer.toLowerCase();
  const isSoftware = lowered.includes('swiftshader') || lowered.includes('llvmpipe');
  if (isSoftware || cores <= 2) return 'low';
  // Integrated Intel / low-core laptops get the balanced preset.
  if (cores <= 6 || (lowered.includes('intel') && !lowered.includes('arc'))) return 'medium';
  if (dpr >= 2 && cores >= 8) return 'high';
  return 'high';
}
