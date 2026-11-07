// WebGLRenderer + EffectComposer (custom HalfFloat MSAA target) + CSS2DRenderer, DPR policy and the camera.
//
// Pass chain: RenderPass → radial blur (warp only) → UnrealBloomPass → final grade (vignette + dither, linear HDR) →
// OutputPass (tone mapping + sRGB, always last).
//
// Tone mapping: NeutralToneMapping (Khronos PBR Neutral, r186) at exposure 1.05 instead of ACES Filmic. ACES applies
// a filmic S-curve with hue skew and desaturation in the mid-tones, which is what made the planet discs look muddy;
// Neutral is the identity below 0.76 (after exposure), only compressing highlights toward white with a mild
// desaturation, so Jupiter's bands, Mars' ochre and Neptune's blue reach the screen as authored. Highlights (Sun,
// glare cores, bright markers) still roll off smoothly. Bloom: threshold 0.75 / strength 0.6 / radius 0.4 — planet
// discs (lit albedo ≤ ~0.9) stay under the threshold, while the HDR sources (photosphere, glare, bright markers and
// stars ≥ 1.2) bloom.
//
// r186 facts honoured (critique engineering section, verified against node_modules/three):
// - The composer's default target is WebGLRenderTarget(w·pr, h·pr, { type: HalfFloatType }) with no MSAA, so canvas
//   `antialias` is inert on the composer path; we pass our own target with `samples: 4` when pr ≤ 1.5. When a target is
//   given, EffectComposer takes _width/_height from the target (device px), so composer.setSize(w, h) in CSS px is
//   called right after construction to fix its notion of the logical size.
// - `camera.up.set(0, 0, 1)` is done here, before the camera is handed to anything (OrbitControls caches the up
//   quaternion in its constructor — camera.js constructs the controls after createRenderer()).
// - CSS2DRenderer's DOM element sets no pointer-events; we make the layer position:absolute; inset:0; pointer-events:none
//   so OrbitControls/picking on the canvas keep working; label buttons opt back in with pointer-events:auto.
// - Tone mapping is applied once by OutputPass on the composer path and by each material's <tonemapping_fragment> on the
//   direct (Quality Low) path; OutputPass reads renderer.toneMapping each render, so it is set before the pass exists.
// - WebGLPrograms picks the tone-mapping / colour-space variant from the CURRENT render target, so prewarm() compiles
//   against the composer's target (the variant the frame loop uses), not the screen.
// - setResolution(pr) is the single DPR entry point: renderer.setPixelRatio, composer.setPixelRatio, MSAA target
//   recreation via composer.reset(), pixel-ratio listeners (marker/star uPixelRatio) and store.pixelRatio.
//
// Device pixel ratio: read on every change, not once — a `matchMedia('(resolution: Xdppx)')` query is armed for the
// current value and re-armed after each change (the MDN pattern,
// https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio#monitoring_screen_resolution_or_zoom_level_changes),
// which covers browser zoom and dragging the window to another display.
//
// Adaptive DPR: steps of 0.25 between 0.75 and the cap, decided from an EMA of the frame interval, but
// - nothing is measured for 2 s after any resolution / size / quality change (the targets are rebuilt, the first
//   frames compile shaders);
// - "slow" is relative to the display: the vsync interval is estimated as a leaky minimum of the observed frame
//   interval, and a frame is slow only above max(1.6 × that, 24 ms) — a 30 Hz or throttled display is not mistaken
//   for GPU load, and nothing steps down while the app runs above ~42 fps;
// - a step down needs 1.5 s of sustained slowness, a step up 6 s of sustained headroom plus a 20 s block after any
//   step down; a step up that relapses within 15 s lowers the session's ceiling so the loop cannot oscillate;
// - frames longer than 250 ms (tab switch, GC pause) are ignored.

import {
  WebGLRenderer, PerspectiveCamera, NeutralToneMapping, WebGLRenderTarget, HalfFloatType, Vector2, Color,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RadialBlurShader } from './materials.js';
import { FinalGradeShader } from './skyMaterials.js';

export const CAMERA_FOV = 50;
export const CAMERA_NEAR = 1e-6; // AU (≈150 km); with log depth the near plane only clips
export const CAMERA_FAR = 2e4; // AU; the 5,000 AU star sphere stays inside
export const CLEAR_COLOUR = 0x05070d; // --bg
export const BLOOM = Object.freeze({ strength: 0.6, radius: 0.4, threshold: 0.75 });
export const TONE_EXPOSURE = 1.05;
export const VIGNETTE = 0.22;
const DPR_CAP_FINE = 2;
const DPR_CAP_COARSE = 1.5;
const DPR_FLOOR = 0.75;
const DPR_STEP = 0.25;
/** Adaptive DPR policy (see the header). */
const HOLDOFF_S = 2;
const SLOW_FACTOR = 1.6;
const SLOW_MIN_MS = 24;
const SLOW_SUSTAIN_S = 1.5;
const FAST_FACTOR = 1.15;
const FAST_MAX_MS = 12;
const FAST_SUSTAIN_S = 6;
const UP_BLOCK_S = 20;
const RELAPSE_S = 15;
const STALL_S = 0.25;
const EMA_ALPHA = 0.1;
const REFRESH_CREEP = 1.002;
const REFRESH_MIN_MS = 4; // 240 Hz
const BLUR_MIN_STRENGTH = 0.01;

/**
 * @param {{ canvas: HTMLCanvasElement, container: HTMLElement, store?: { get: () => any, set: (p: any) => void } }} opts
 */
export function createRenderer({ canvas, container, store }) {
  const coarse = !!globalThis.matchMedia?.('(pointer: coarse)')?.matches;
  let dprCap = coarse ? DPR_CAP_COARSE : DPR_CAP_FINE;
  let deviceDpr = globalThis.devicePixelRatio || 1;

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true, // only matters for the Quality-Low direct path (the composer path uses the MSAA target)
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
  renderer.setClearColor(new Color(CLEAR_COLOUR), 1);
  renderer.autoClear = true;

  /** Cached logical size and current render DPR. */
  const size = { w: 1, h: 1, dpr: Math.min(deviceDpr, dprCap) };
  readContainerSize();

  const camera = new PerspectiveCamera(CAMERA_FOV, size.w / size.h, CAMERA_NEAR, CAMERA_FAR);
  camera.up.set(0, 0, 1); // ecliptic north is up — BEFORE OrbitControls (r186 caches the up quaternion)
  camera.name = 'camera';

  renderer.setPixelRatio(size.dpr);
  renderer.setSize(size.w, size.h, false);

  // --- composer -------------------------------------------------------------------------------------------------------
  /** @param {number} pr */
  function makeTarget(pr) {
    const rt = new WebGLRenderTarget(
      Math.max(1, Math.round(size.w * pr)),
      Math.max(1, Math.round(size.h * pr)),
      { type: HalfFloatType, samples: pr <= 1.5 ? 4 : 0 },
    );
    rt.texture.name = 'solarmap.hdr';
    return rt;
  }
  const composer = new EffectComposer(renderer, makeTarget(size.dpr));
  composer.setSize(size.w, size.h); // the custom target made the composer cache device px as its logical size
  const renderPass = new RenderPass(null, camera);
  const blurPass = new ShaderPass(RadialBlurShader);
  blurPass.enabled = false;
  const bloomPass = new UnrealBloomPass(new Vector2(size.w, size.h), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  const finalPass = new ShaderPass(FinalGradeShader);
  finalPass.uniforms.uVignette.value = VIGNETTE;
  finalPass.uniforms.uResolution.value.set(size.w, size.h);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(blurPass);
  composer.addPass(bloomPass);
  composer.addPass(finalPass);
  composer.addPass(outputPass);

  // --- CSS2D layer ---------------------------------------------------------------------------------------------------
  const cssRenderer = new CSS2DRenderer();
  Object.assign(cssRenderer.domElement.style, {
    position: 'absolute', inset: '0', top: '0', left: '0', pointerEvents: 'none', overflow: 'hidden',
  });
  cssRenderer.domElement.className = 'css2d-layer';
  cssRenderer.setSize(size.w, size.h);
  container.appendChild(cssRenderer.domElement);

  // --- listeners -------------------------------------------------------------------------------------------------------
  /** @type {Set<(pr: number) => void>} */
  const pixelRatioListeners = new Set();
  /** @type {Set<(w: number, h: number) => void>} */
  const resizeListeners = new Set();

  let quality = 'high';
  let useComposer = true;
  let warpStrength = 0;
  let disposed = false;
  let frame = 0;

  function readContainerSize() {
    const w = container.clientWidth || canvas.clientWidth || 1;
    const h = container.clientHeight || canvas.clientHeight || 1;
    size.w = Math.max(1, w);
    size.h = Math.max(1, h);
  }

  /** Re-read the container size (ResizeObserver) and resize every target; cached sizes, no per-frame layout reads. */
  function resize() {
    if (disposed) return;
    readContainerSize();
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
    renderer.setSize(size.w, size.h, false);
    composer.setSize(size.w, size.h);
    cssRenderer.setSize(size.w, size.h);
    finalPass.uniforms.uResolution.value.set(size.w, size.h);
    holdoff = HOLDOFF_S;
    for (const fn of resizeListeners) fn(size.w, size.h);
  }

  /**
   * The single entry point for DPR changes.
   * @param {number} pr
   */
  function setResolution(pr) {
    const clamped = Math.max(DPR_FLOOR, Math.min(dprCap, pr));
    size.dpr = clamped;
    renderer.setPixelRatio(clamped);
    renderer.setSize(size.w, size.h, false);
    composer.reset(makeTarget(clamped)); // MSAA samples depend on the DPR
    composer.setPixelRatio(clamped); // resizes the new targets and every pass
    holdoff = HOLDOFF_S;
    slowS = fastS = 0;
    for (const fn of pixelRatioListeners) fn(clamped);
    if (store && store.get().pixelRatio !== clamped) store.set({ pixelRatio: clamped });
    return clamped;
  }

  /** @param {'high'|'low'} q */
  function setQuality(q) {
    quality = q === 'low' ? 'low' : 'high';
    useComposer = quality === 'high';
    dprCap = quality === 'low' ? 1 : (coarse ? DPR_CAP_COARSE : DPR_CAP_FINE);
    bloomPass.enabled = useComposer;
    finalPass.enabled = useComposer;
    blurPass.enabled = useComposer && warpStrength > BLUR_MIN_STRENGTH;
    adaptiveCeil = Infinity;
    setResolution(quality === 'low' ? 1 : Math.min(deviceDpr, dprCap));
  }

  /**
   * Render one frame (composer or direct) then the CSS2D layer.
   * @param {import('three').Scene} scene
   * @param {number} dtSeconds
   */
  function render(scene, dtSeconds) {
    renderPass.scene = scene;
    frame = (frame + 1) & 63;
    finalPass.uniforms.uSeed.value = frame;
    if (useComposer) composer.render(dtSeconds);
    else renderer.render(scene, camera);
    cssRenderer.render(scene, camera);
  }

  /**
   * Compile every shader the scene can need before the loading screen lifts, so neither the first warp nor the first
   * frame after a texture arrives stalls on compilation. Hidden objects (warp streaks, star labels, debug overlays)
   * are compiled too; the composer passes (bloom, final grade, and the radial blur that is normally off) get one
   * render. Uses WebGLRenderer.compileAsync (KHR_parallel_shader_compile when available).
   * @param {import('three').Scene} scene
   * @returns {Promise<void>}
   */
  async function prewarm(scene) {
    if (disposed || !scene) return;
    renderPass.scene = scene;
    const hidden = [];
    scene.traverse((o) => { if (o.visible === false) { hidden.push(o); o.visible = true; } });
    let pending = null;
    const prevTarget = renderer.getRenderTarget();
    try {
      if (useComposer) renderer.setRenderTarget(composer.renderTarget1); // compile the off-screen (composer) variants
      pending = renderer.compileAsync(scene, camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      for (const o of hidden) o.visible = false;
    }
    const blurWas = blurPass.enabled;
    blurPass.enabled = useComposer;
    try {
      if (useComposer) composer.render(0); else renderer.render(scene, camera);
    } finally {
      blurPass.enabled = blurWas;
    }
    if (pending) await pending;
  }

  /**
   * Radial blur during warp.
   * @param {{ strength: number, centerNdc?: number[] }} args strength = uStreak; centerNdc = projected velocity direction
   */
  function setWarp({ strength, centerNdc }) {
    warpStrength = strength || 0;
    const u = blurPass.uniforms;
    if (u.uStrength) u.uStrength.value = warpStrength;
    if (centerNdc && u.uCenter) {
      const cx = Math.max(-0.5, Math.min(1.5, centerNdc[0] * 0.5 + 0.5));
      const cy = Math.max(-0.5, Math.min(1.5, centerNdc[1] * 0.5 + 0.5));
      const val = u.uCenter.value;
      if (val && typeof val.set === 'function') val.set(cx, cy);
      else if (val && val.length >= 2) { val[0] = cx; val[1] = cy; }
    }
    blurPass.enabled = useComposer && warpStrength > BLUR_MIN_STRENGTH;
  }

  /** Vignette strength 0 (off) … ~0.4. @param {number} amount */
  function setVignette(amount) {
    finalPass.uniforms.uVignette.value = Math.max(0, Math.min(1, amount || 0));
  }

  // --- device pixel ratio changes (zoom, display switch) ----------------------------------------------------------------
  let dprQuery = null;
  let dprHandler = null;
  function armDprWatch() {
    if (disposed || typeof globalThis.matchMedia !== 'function') return;
    const dpr = globalThis.devicePixelRatio || 1;
    const q = globalThis.matchMedia(`(resolution: ${dpr}dppx)`);
    if (!q || typeof q.addEventListener !== 'function') return;
    const onChange = () => {
      q.removeEventListener('change', onChange);
      dprQuery = null;
      dprHandler = null;
      onDeviceDprChange();
      armDprWatch(); // re-arm for the new value
    };
    q.addEventListener('change', onChange);
    dprQuery = q;
    dprHandler = onChange;
  }
  function onDeviceDprChange() {
    deviceDpr = globalThis.devicePixelRatio || 1;
    adaptiveCeil = Infinity; // the display changed: let the adaptive loop re-learn from the cap
    setResolution(quality === 'low' ? 1 : Math.min(deviceDpr, dprCap));
  }
  armDprWatch();

  // --- adaptive DPR ----------------------------------------------------------------------------------------------------
  let ema = 16.7;
  let refreshMs = 16.7;
  let slowS = 0;
  let fastS = 0;
  let holdoff = HOLDOFF_S;
  let clockS = 0;
  let upBlockedUntil = 0;
  let lastUpAt = -Infinity;
  let adaptiveCeil = Infinity;

  function stepDown() {
    if (size.dpr <= DPR_FLOOR + 1e-6) return;
    const next = Math.max(DPR_FLOOR, size.dpr - DPR_STEP);
    if (clockS - lastUpAt < RELAPSE_S) adaptiveCeil = Math.min(adaptiveCeil, next); // the step up did not hold
    upBlockedUntil = clockS + UP_BLOCK_S;
    setResolution(next);
  }

  function stepUp() {
    const cap = Math.min(deviceDpr, dprCap, adaptiveCeil);
    if (size.dpr >= cap - 1e-6 || clockS < upBlockedUntil) return;
    lastUpAt = clockS;
    setResolution(Math.min(cap, size.dpr + DPR_STEP));
  }

  /**
   * Feed the frame interval; may step the DPR down (−0.25 to 0.75) or up (+0.25 to the cap). Returns the current DPR.
   * @param {number} dtSeconds
   * @returns {number}
   */
  function adaptive(dtSeconds) {
    if (!(dtSeconds > 0)) return size.dpr;
    clockS += dtSeconds;
    if (dtSeconds > STALL_S) return size.dpr; // tab switch / GC pause: not a measurement
    const ms = dtSeconds * 1000;
    refreshMs = Math.max(REFRESH_MIN_MS, Math.min(refreshMs * REFRESH_CREEP, ms));
    ema += (ms - ema) * EMA_ALPHA;
    if (holdoff > 0) {
      holdoff -= dtSeconds;
      slowS = fastS = 0;
      return size.dpr;
    }
    const slowMs = Math.max(SLOW_FACTOR * refreshMs, SLOW_MIN_MS);
    const fastMs = Math.max(FAST_FACTOR * refreshMs, FAST_MAX_MS);
    if (ema > slowMs) {
      fastS = 0;
      slowS += dtSeconds;
      if (slowS >= SLOW_SUSTAIN_S) { slowS = 0; stepDown(); }
    } else if (ema < fastMs) {
      slowS = 0;
      fastS += dtSeconds;
      if (fastS >= FAST_SUSTAIN_S) { fastS = 0; stepUp(); }
    } else {
      slowS = 0;
      fastS = 0;
    }
    return size.dpr;
  }

  /** @param {(pr: number) => void} fn @returns {() => void} */
  function onPixelRatio(fn) {
    pixelRatioListeners.add(fn);
    return () => pixelRatioListeners.delete(fn);
  }

  /** @param {(w: number, h: number) => void} fn @returns {() => void} */
  function onResize(fn) {
    resizeListeners.add(fn);
    return () => resizeListeners.delete(fn);
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(container);
  } else {
    globalThis.addEventListener?.('resize', resize);
  }

  function dispose() {
    disposed = true;
    if (ro) ro.disconnect(); else globalThis.removeEventListener?.('resize', resize);
    if (dprQuery && dprHandler) dprQuery.removeEventListener('change', dprHandler);
    composer.dispose();
    bloomPass.dispose();
    blurPass.dispose();
    finalPass.dispose();
    outputPass.dispose();
    renderPass.dispose();
    renderer.dispose();
    cssRenderer.domElement.remove();
    pixelRatioListeners.clear();
    resizeListeners.clear();
  }

  if (store && store.get().pixelRatio !== size.dpr) store.set({ pixelRatio: size.dpr });

  return {
    renderer,
    composer,
    cssRenderer,
    camera,
    size,
    passes: { renderPass, blurPass, bloomPass, finalPass, outputPass },
    get quality() { return quality; },
    get dprCap() { return Math.min(deviceDpr, dprCap); },
    get deviceDpr() { return deviceDpr; },
    get frameStats() { return { emaMs: ema, refreshMs, dpr: size.dpr, ceiling: adaptiveCeil }; },
    setQuality,
    setResolution,
    resize,
    render,
    prewarm,
    setWarp,
    setVignette,
    adaptive,
    onPixelRatio,
    onResize,
    dispose,
  };
}
