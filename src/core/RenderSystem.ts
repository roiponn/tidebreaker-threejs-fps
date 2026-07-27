import * as THREE from 'three';
import { LAYER } from './Layers';
import { Disposer } from './Disposal';
import { clamp01, damp, kelvinToLinearGain } from './MathUtils';
import { FULLSCREEN_VERT, FullScreenQuad } from '@/shaders/FullScreenQuad';
import { SSAO_BLUR_FRAG, SSAO_FRAG, SSAO_KERNEL_SIZE } from '@/shaders/SsaoShader';
import {
  BLOOM_DOWNSAMPLE_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_UPSAMPLE_FRAG,
} from '@/shaders/BloomShader';
import { COMPOSITE_FRAG } from '@/shaders/CompositeShader';
import { FXAA_FRAG } from '@/shaders/FxaaShader';
import { LUMINANCE_FRAG, LUMINANCE_REDUCE_FRAG, EXPOSURE_ADAPT_FRAG, COPY_FRAG } from '@/shaders/UtilityShaders';
import type { MutableVisual } from '@/config/visual';
import type { QualitySettings } from '@/config/quality';

const BLOOM_MIPS = 6;

/**
 * Owns the WebGL renderer and the entire post-processing chain.
 *
 * Frame order (all offscreen until the final blit):
 *   1. world       -> sceneRT (HDR colour + depth texture)
 *   2. view-model  -> sceneRT with depth cleared, second camera, same depth space
 *   3. SSAO        -> half-res AO + separable bilateral blur
 *   4. auto-exposure luminance reduction -> 1x1 ping-pong adaptation
 *   5. bloom       -> 6-level down/up-sample chain
 *   6. composite   -> DoF/motion/AO/bloom/exposure/tonemap/grade -> LDR target
 *   7. FXAA        -> canvas
 *
 * A deliberately hand-rolled pipeline rather than EffectComposer: the depth
 * texture is written by exactly one pass and read by three, and no third-party
 * pass can silently clobber it.
 */
export class RenderSystem {
  readonly renderer: THREE.WebGLRenderer;
  private disposer = new Disposer();

  private sceneRT!: THREE.WebGLRenderTarget;
  private ldrRT!: THREE.WebGLRenderTarget;
  private aoRT!: THREE.WebGLRenderTarget;
  private aoBlurRT!: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private lumRTs: THREE.WebGLRenderTarget[] = [];
  private adaptRTs: THREE.WebGLRenderTarget[] = [];
  private adaptIndex = 0;

  private ssaoMat!: THREE.ShaderMaterial;
  private ssaoBlurMat!: THREE.ShaderMaterial;
  private prefilterMat!: THREE.ShaderMaterial;
  private downsampleMat!: THREE.ShaderMaterial;
  private upsampleMat!: THREE.ShaderMaterial;
  private compositeMat!: THREE.ShaderMaterial;
  private fxaaMat!: THREE.ShaderMaterial;
  private lumMat!: THREE.ShaderMaterial;
  private lumReduceMat!: THREE.ShaderMaterial;
  private adaptMat!: THREE.ShaderMaterial;
  private copyMat!: THREE.ShaderMaterial;
  private quad!: FullScreenQuad;
  private whiteTexture!: THREE.DataTexture;

  /** Backing store size in device pixels (after DPR + render scale). */
  private width = 1;
  private height = 1;
  private cssWidth = 1;
  private cssHeight = 1;

  private quality: QualitySettings;
  private visual: MutableVisual;

  /** Screen-space motion vector, fed by the player camera each frame. */
  private motionDir = new THREE.Vector2(0, 0);
  private motionStrength = 0;
  private focusDistance = 14;
  private damageFlash = 0;
  private fadeAmount = 0;
  private fadeColor = new THREE.Color(0x000000);

  constructor(canvas: HTMLCanvasElement, quality: QualitySettings, visual: MutableVisual) {
    this.quality = quality;
    this.visual = visual;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Post AA is FXAA; MSAA on the HDR target would prevent the depth
      // texture attachment we rely on.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tonemapping happens in the composite pass, not in three's materials.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadows are refreshed once per frame by us, not once per render() call -
    // otherwise the view-model pass would re-render every shadow map.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;

    this.buildMaterials();
    this.quad = new FullScreenQuad(this.copyMat);
    this.whiteTexture = createWhiteTexture();
    this.disposer.track(this.whiteTexture);
    this.buildTargets(1, 1);
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  private buildMaterials(): void {
    const common = { depthTest: false, depthWrite: false, vertexShader: FULLSCREEN_VERT };

    this.ssaoMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: SSAO_FRAG,
      uniforms: {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uProjection: { value: new THREE.Matrix4() },
        uInverseProjection: { value: new THREE.Matrix4() },
        uKernel: { value: buildHemisphereKernel(SSAO_KERNEL_SIZE) },
        uRadius: { value: 0.85 },
        uBias: { value: 0.025 },
        uIntensity: { value: 0.9 },
        uTime: { value: 0 },
        uNearCutoff: { value: 1.0 },
        uNear: { value: 0.05 },
        uFar: { value: 700 },
      },
    });

    this.ssaoBlurMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: SSAO_BLUR_FRAG,
      uniforms: {
        tAo: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uNear: { value: 0.05 },
        uFar: { value: 700 },
      },
    });

    this.prefilterMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: BLOOM_PREFILTER_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: 0.9 },
        uSoftKnee: { value: 0.6 },
        uClamp: { value: 8 },
      },
    });

    this.downsampleMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: BLOOM_DOWNSAMPLE_FRAG,
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.upsampleMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: BLOOM_UPSAMPLE_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1 },
        uWeight: { value: 1 },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        tAo: { value: null },
        tDepth: { value: null },
        tAdapt: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uWhiteBalance: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
        uAdaptRange: { value: 0.22 },
        uBloomStrength: { value: 0.4 },
        uAoIntensity: { value: 0.9 },
        uDofFocus: { value: 14 },
        uDofStrength: { value: 0.55 },
        uDofMaxBlur: { value: 3.4 },
        uDofNearStart: { value: 1.1 },
        uMotionDir: { value: new THREE.Vector2() },
        uMotionStrength: { value: 0 },
        uContrast: { value: 1.09 },
        uSaturation: { value: 1.05 },
        uLift: { value: new THREE.Vector3() },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uSplitShadow: { value: new THREE.Vector3(0.2, 0.3, 0.4) },
        uSplitHighlight: { value: new THREE.Vector3(0.5, 0.4, 0.3) },
        uSplitBalance: { value: 0.28 },
        uVignette: { value: 0.36 },
        uVignetteSoftness: { value: 0.55 },
        uGrain: { value: 0.028 },
        uChroma: { value: 0.0016 },
        uDamageFlash: { value: 0 },
        uDamageColor: { value: new THREE.Vector3(0.9, 0.08, 0.06) },
        uFade: { value: 0 },
        uFadeColor: { value: new THREE.Vector3(0, 0, 0) },
        uNear: { value: 0.05 },
        uFar: { value: 700 },
      },
    });

    this.fxaaMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: FXAA_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uAmount: { value: 1 },
      },
    });

    this.lumMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: LUMINANCE_FRAG,
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.lumReduceMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: LUMINANCE_REDUCE_FRAG,
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.adaptMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: EXPOSURE_ADAPT_FRAG,
      uniforms: {
        tCurrent: { value: null },
        tPrevious: { value: null },
        uSpeed: { value: 0.55 },
        uDelta: { value: 0.016 },
      },
    });

    this.copyMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: COPY_FRAG,
      uniforms: { tDiffuse: { value: null } },
    });

    this.disposer.trackMany(
      this.ssaoMat,
      this.ssaoBlurMat,
      this.prefilterMat,
      this.downsampleMat,
      this.upsampleMat,
      this.compositeMat,
      this.fxaaMat,
      this.lumMat,
      this.lumReduceMat,
      this.adaptMat,
      this.copyMat,
    );
  }

  private buildTargets(width: number, height: number): void {
    this.disposeTargets();
    this.width = Math.max(2, width);
    this.height = Math.max(2, height);

    const depthTexture = new THREE.DepthTexture(this.width, this.height);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture,
      colorSpace: THREE.LinearSRGBColorSpace,
      generateMipmaps: false,
    });

    this.ldrRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      // The composite pass already wrote sRGB-encoded bytes; treat as raw data.
      colorSpace: THREE.NoColorSpace,
      generateMipmaps: false,
    });

    const aoW = Math.max(2, Math.round(this.width * this.quality.ssaoScale));
    const aoH = Math.max(2, Math.round(this.height * this.quality.ssaoScale));
    const aoOptions: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    };
    this.aoRT = new THREE.WebGLRenderTarget(aoW, aoH, aoOptions);
    this.aoBlurRT = new THREE.WebGLRenderTarget(aoW, aoH, aoOptions);

    this.bloomRTs = [];
    for (let i = 0; i < BLOOM_MIPS; i++) {
      const w = Math.max(2, this.width >> (i + 1));
      const h = Math.max(2, this.height >> (i + 1));
      this.bloomRTs.push(
        new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          generateMipmaps: false,
        }),
      );
    }

    // 64 -> 16 -> 4 -> 1 luminance reduction for auto-exposure.
    this.lumRTs = [64, 16, 4, 1].map(
      (size) =>
        new THREE.WebGLRenderTarget(size, size, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          generateMipmaps: false,
        }),
    );

    if (this.adaptRTs.length === 0) {
      this.adaptRTs = [0, 1].map(
        () =>
          new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: false,
            generateMipmaps: false,
          }),
      );
    }
  }

  private disposeTargets(): void {
    this.sceneRT?.depthTexture?.dispose();
    this.sceneRT?.dispose();
    this.ldrRT?.dispose();
    this.aoRT?.dispose();
    this.aoBlurRT?.dispose();
    for (const rt of this.bloomRTs) rt.dispose();
    for (const rt of this.lumRTs) rt.dispose();
    this.bloomRTs = [];
    this.lumRTs = [];
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.resize(this.cssWidth, this.cssHeight);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    const scale = dpr * this.quality.renderScale;
    // setSize(..., false) writes the backing-store size without touching CSS,
    // so the canvas keeps its stylesheet-driven 100%x100% layout box and
    // renderScale is honoured independently of the layout.
    this.renderer.setPixelRatio(1);
    // Round to even dimensions. Odd-sized depth textures and odd bloom mips hit
    // slow driver paths on some GPUs (measured: an odd 680x383 target ran 4x
    // slower than an even 1600x900 one on the same machine, despite a fifth of
    // the pixels).
    const w = Math.max(2, Math.round((cssWidth * scale) / 2) * 2);
    const h = Math.max(2, Math.round((cssHeight * scale) / 2) * 2);
    this.renderer.setSize(w, h, false);
    this.buildTargets(w, h);
  }

  /** Screen-space blur direction from the player camera's angular velocity. */
  setMotion(dirX: number, dirY: number, strength: number): void {
    this.motionDir.set(dirX, dirY);
    const len = this.motionDir.length();
    if (len > 0.0001) this.motionDir.multiplyScalar(1 / len);
    this.motionStrength = strength;
  }

  setFocusDistance(distance: number): void {
    this.focusDistance = distance;
  }

  pulseDamage(amount: number): void {
    this.damageFlash = Math.min(1.4, this.damageFlash + amount);
  }

  setFade(amount: number, color = 0x000000): void {
    this.fadeAmount = clamp01(amount);
    this.fadeColor.setHex(color);
  }

  /** Depth texture written by the world pass; consumed by soft particles. */
  get depthTexture(): THREE.DepthTexture | null {
    return (this.sceneRT?.depthTexture as THREE.DepthTexture) ?? null;
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }

  get textureCount(): number {
    return this.renderer.info.memory.textures;
  }

  // -------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------

  render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    weaponCamera: THREE.PerspectiveCamera,
    dt: number,
    elapsed: number,
  ): void {
    const renderer = this.renderer;
    renderer.info.reset();
    this.damageFlash = damp(this.damageFlash, 0, 6.5, dt);

    // Shadows: one update per frame, shared by both camera passes.
    if (this.quality.shadows) renderer.shadowMap.needsUpdate = true;

    // --- 1. world ---
    renderer.autoClear = true;
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // --- 2. view-model, depth cleared so the gun never intersects the world ---
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, weaponCamera);
    renderer.autoClear = true;

    const sceneTexture = this.sceneRT.texture;
    const depthTexture = this.sceneRT.depthTexture as THREE.DepthTexture;

    // --- 3. SSAO ---
    if (this.quality.ssao && this.visual.ao.enabled) {
      this.renderSsao(camera, elapsed);
    }

    // --- 4. auto exposure ---
    this.renderExposure(sceneTexture, dt);

    // --- 5. bloom ---
    if (this.quality.bloom) this.renderBloom(sceneTexture);

    // --- 6. composite ---
    const c = this.compositeMat.uniforms;
    c.tDiffuse.value = sceneTexture;
    c.tBloom.value = this.quality.bloom ? this.bloomRTs[0].texture : this.whiteTexture;
    c.tAo.value = this.quality.ssao && this.visual.ao.enabled ? this.aoRT.texture : this.whiteTexture;
    c.tDepth.value = depthTexture;
    c.tAdapt.value = this.adaptRTs[this.adaptIndex].texture;
    (c.uResolution.value as THREE.Vector2).set(this.width, this.height);
    c.uTime.value = elapsed;
    c.uNear.value = camera.near;
    c.uFar.value = camera.far;
    kelvinToLinearGain(
      this.visual.grade.whiteBalanceK,
      this.visual.grade.whiteBalanceTint,
      c.uWhiteBalance.value as THREE.Vector3,
    );
    c.uExposure.value = this.visual.exposure.base;
    c.uAdaptRange.value = this.visual.exposure.adaptionRange;
    c.uBloomStrength.value = this.quality.bloom ? this.visual.bloom.strength : 0;
    c.uAoIntensity.value = this.quality.ssao && this.visual.ao.enabled ? 1 : 0;
    c.uDofFocus.value = this.focusDistance;
    c.uDofStrength.value = this.quality.dof && this.visual.dof.enabled ? this.visual.dof.strength : 0;
    c.uDofMaxBlur.value = this.visual.dof.maxBlurPx * (this.height / 1080);
    c.uDofNearStart.value = this.visual.dof.nearStart;
    (c.uMotionDir.value as THREE.Vector2).copy(this.motionDir);
    c.uMotionStrength.value = this.quality.motionBlur ? this.motionStrength * this.visual.motion.blurStrength : 0;
    c.uContrast.value = this.visual.grade.contrast;
    c.uSaturation.value = this.visual.grade.saturation;
    setVec3FromHex(c.uLift.value as THREE.Vector3, this.visual.grade.liftShadows, 0.25);
    setVec3FromHex(c.uGain.value as THREE.Vector3, this.visual.grade.gainHighlights, 1);
    setVec3FromHex(c.uSplitShadow.value as THREE.Vector3, this.visual.grade.splitToneShadow, 1);
    setVec3FromHex(c.uSplitHighlight.value as THREE.Vector3, this.visual.grade.splitToneHighlight, 1);
    c.uSplitBalance.value = this.visual.grade.splitToneBalance;
    c.uVignette.value = this.visual.grade.vignette;
    c.uVignetteSoftness.value = this.visual.grade.vignetteSoftness;
    c.uGrain.value = this.visual.grade.grain;
    c.uChroma.value = this.visual.grade.chromaticAberration;
    c.uDamageFlash.value = this.damageFlash;
    c.uFade.value = this.fadeAmount;
    (c.uFadeColor.value as THREE.Vector3).set(this.fadeColor.r, this.fadeColor.g, this.fadeColor.b);

    // The composite ALWAYS writes to an offscreen LDR target, and a final pass
    // always blits that to the canvas. Keeping one code path for both presets
    // means the expensive composite shader never renders straight to the
    // default framebuffer, which behaves very differently across drivers.
    this.quad.material = this.compositeMat;
    renderer.setRenderTarget(this.ldrRT);
    this.quad.render(renderer);

    // --- 7. antialias (or a plain copy) to the canvas ---
    const finalMat = this.quality.antialias ? this.fxaaMat : this.copyMat;
    finalMat.uniforms.tDiffuse.value = this.ldrRT.texture;
    if (this.quality.antialias) {
      (this.fxaaMat.uniforms.uResolution.value as THREE.Vector2).set(this.width, this.height);
    }
    this.quad.material = finalMat;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
  }

  private renderSsao(camera: THREE.PerspectiveCamera, elapsed: number): void {
    const renderer = this.renderer;
    const u = this.ssaoMat.uniforms;
    u.tDepth.value = this.sceneRT.depthTexture;
    (u.uResolution.value as THREE.Vector2).set(this.aoRT.width, this.aoRT.height);
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    u.uRadius.value = this.visual.ao.radius;
    u.uBias.value = this.visual.ao.bias;
    u.uIntensity.value = this.visual.ao.intensity;
    u.uTime.value = elapsed;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;

    this.quad.material = this.ssaoMat;
    renderer.setRenderTarget(this.aoRT);
    this.quad.render(renderer);

    const b = this.ssaoBlurMat.uniforms;
    b.tDepth.value = this.sceneRT.depthTexture;
    b.uNear.value = camera.near;
    b.uFar.value = camera.far;
    (b.uResolution.value as THREE.Vector2).set(this.aoRT.width, this.aoRT.height);

    b.tAo.value = this.aoRT.texture;
    (b.uDirection.value as THREE.Vector2).set(1, 0);
    this.quad.material = this.ssaoBlurMat;
    renderer.setRenderTarget(this.aoBlurRT);
    this.quad.render(renderer);

    b.tAo.value = this.aoBlurRT.texture;
    (b.uDirection.value as THREE.Vector2).set(0, 1);
    renderer.setRenderTarget(this.aoRT);
    this.quad.render(renderer);
  }

  private renderExposure(sceneTexture: THREE.Texture, dt: number): void {
    const renderer = this.renderer;
    this.lumMat.uniforms.tDiffuse.value = sceneTexture;
    (this.lumMat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    this.quad.material = this.lumMat;
    renderer.setRenderTarget(this.lumRTs[0]);
    this.quad.render(renderer);

    this.quad.material = this.lumReduceMat;
    for (let i = 1; i < this.lumRTs.length; i++) {
      const src = this.lumRTs[i - 1];
      this.lumReduceMat.uniforms.tDiffuse.value = src.texture;
      (this.lumReduceMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.lumRTs[i]);
      this.quad.render(renderer);
    }

    const prev = this.adaptRTs[this.adaptIndex];
    const next = this.adaptRTs[1 - this.adaptIndex];
    this.adaptMat.uniforms.tCurrent.value = this.lumRTs[this.lumRTs.length - 1].texture;
    this.adaptMat.uniforms.tPrevious.value = prev.texture;
    this.adaptMat.uniforms.uSpeed.value = this.visual.exposure.adaptionSpeed;
    this.adaptMat.uniforms.uDelta.value = dt;
    this.quad.material = this.adaptMat;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.adaptIndex = 1 - this.adaptIndex;
  }

  /**
   * Per-step upsample weights, indexed by the level being READ. Compounding
   * down the chain gives effective level weights of roughly
   * 1.00 / 0.92 / 0.75 / 0.53 / 0.29 - full strength close to the source,
   * heavily damped at the frame-wide mip.
   */
  private static readonly LEVEL_WEIGHT = [1, 1, 0.92, 0.82, 0.7, 0.55];

  private renderBloom(sceneTexture: THREE.Texture): void {
    const renderer = this.renderer;
    const p = this.prefilterMat.uniforms;
    p.tDiffuse.value = sceneTexture;
    (p.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    p.uThreshold.value = this.visual.bloom.threshold;
    this.quad.material = this.prefilterMat;
    renderer.setRenderTarget(this.bloomRTs[0]);
    this.quad.render(renderer);

    this.quad.material = this.downsampleMat;
    for (let i = 1; i < this.bloomRTs.length; i++) {
      const src = this.bloomRTs[i - 1];
      this.downsampleMat.uniforms.tDiffuse.value = src.texture;
      (this.downsampleMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.bloomRTs[i]);
      this.quad.render(renderer);
    }

    // Additive tent upsample back down the chain, with the coarse levels
    // attenuated so bloom stays local to its source. See BLOOM_UPSAMPLE_FRAG.
    this.quad.material = this.upsampleMat;
    this.upsampleMat.uniforms.uRadius.value = this.visual.bloom.radius * 2;
    for (let i = this.bloomRTs.length - 1; i > 0; i--) {
      const src = this.bloomRTs[i];
      this.upsampleMat.uniforms.tDiffuse.value = src.texture;
      (this.upsampleMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      this.upsampleMat.uniforms.uWeight.value = RenderSystem.LEVEL_WEIGHT[i] ?? 1;
      renderer.setRenderTarget(this.bloomRTs[i - 1]);
      this.quad.render(renderer);
    }
  }

  /** Configures a camera pair so world and view-model share one depth space. */
  configureCameras(camera: THREE.PerspectiveCamera, weaponCamera: THREE.PerspectiveCamera): void {
    camera.layers.set(LAYER.WORLD);
    weaponCamera.layers.set(LAYER.VIEWMODEL);
    weaponCamera.near = camera.near;
    weaponCamera.far = camera.far;
  }

  dispose(): void {
    this.disposeTargets();
    for (const rt of this.adaptRTs) rt.dispose();
    this.adaptRTs = [];
    this.quad.dispose();
    this.disposer.dispose();
    this.renderer.dispose();
  }
}

/** 1x1 opaque white, used to keep every sampler bound when a pass is off. */
function createWhiteTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/** Cosine-weighted hemisphere kernel, biased toward the origin. */
function buildHemisphereKernel(count: number): THREE.Vector3[] {
  const kernel: THREE.Vector3[] = [];
  // Fixed seed: SSAO must not shimmer differently between launches.
  let seed = 0x2f6a1c3d;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand());
    v.normalize();
    // Cluster samples near the origin for tighter contact darkening.
    const scale = 0.25 + 0.75 * Math.pow(i / count, 2);
    v.multiplyScalar(scale);
    kernel.push(v);
  }
  return kernel;
}

const tmpColor = new THREE.Color();
function setVec3FromHex(target: THREE.Vector3, hex: number, scale: number): void {
  tmpColor.setHex(hex, THREE.SRGBColorSpace);
  target.set(tmpColor.r * scale, tmpColor.g * scale, tmpColor.b * scale);
}
