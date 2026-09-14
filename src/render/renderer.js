// WebGLRenderer + EffectComposer (custom HalfFloat MSAA target) + CSS2DRenderer, DPR policy and the camera.
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
// - setResolution(pr) is the single DPR entry point: renderer.setPixelRatio, composer.setPixelRatio, MSAA target
//   recreation via composer.reset(), pixel-ratio listeners (marker/star uPixelRatio) and store.pixelRatio.

import {
  WebGLRenderer, PerspectiveCamera, ACESFilmicToneMapping, WebGLRenderTarget, HalfFloatType, Vector2, Color,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RadialBlurShader } from './materials.js';

export const CAMERA_FOV = 50;
export const CAMERA_NEAR = 1e-6; // AU (≈150 km); with log depth the near plane only clips
export const CAMERA_FAR = 2e4; // AU; the 5,000 AU star sphere stays inside
export const CLEAR_COLOUR = 0x05070d; // --bg
const DPR_CAP_FINE = 2;
const DPR_CAP_COARSE = 1.5;
const DPR_FLOOR = 0.75;
const DPR_STEP = 0.25;
/** Adaptive DPR: EMA frame time > 19 ms for 60 frames → step down; < 12 ms for 300 frames → step up. */
const SLOW_MS = 19;
const SLOW_FRAMES = 60;
const FAST_MS = 12;
const FAST_FRAMES = 300;
const EMA_ALPHA = 0.1;
const BLOOM = { strength: 0.55, radius: 0.35, threshold: 1.0 };
const BLUR_MIN_STRENGTH = 0.01;

/**
 * @param {{ canvas: HTMLCanvasElement, container: HTMLElement, store?: { get: () => any, set: (p: any) => void } }} opts
 */
export function createRenderer({ canvas, container, store }) {
  const coarse = !!globalThis.matchMedia?.('(pointer: coarse)')?.matches;
  let dprCap = coarse ? DPR_CAP_COARSE : DPR_CAP_FINE;
  const deviceDpr = globalThis.devicePixelRatio || 1;

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true, // only matters for the Quality-Low direct path (the composer path uses the MSAA target)
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
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
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(blurPass);
  composer.addPass(bloomPass);
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
    blurPass.enabled = useComposer && warpStrength > BLUR_MIN_STRENGTH;
    setResolution(quality === 'low' ? 1 : Math.min(deviceDpr, dprCap));
    slowFrames = fastFrames = 0;
  }

  /**
   * Render one frame (composer or direct) then the CSS2D layer.
   * @param {import('three').Scene} scene
   * @param {number} dtSeconds
   */
  function render(scene, dtSeconds) {
    renderPass.scene = scene;
    if (useComposer) composer.render(dtSeconds);
    else renderer.render(scene, camera);
    cssRenderer.render(scene, camera);
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

  // --- adaptive DPR ----------------------------------------------------------------------------------------------------
  let ema = 16;
  let slowFrames = 0;
  let fastFrames = 0;

  /**
   * Feed the frame time; steps the DPR down (−0.25 to 0.75) or up (+0.25 to the cap). Returns the current DPR.
   * @param {number} dtSeconds
   * @returns {number}
   */
  function adaptive(dtSeconds) {
    const ms = Math.min(100, dtSeconds * 1000);
    ema += (ms - ema) * EMA_ALPHA;
    if (ema > SLOW_MS) {
      fastFrames = 0;
      if (++slowFrames >= SLOW_FRAMES) {
        slowFrames = 0;
        if (size.dpr > DPR_FLOOR + 1e-6) setResolution(size.dpr - DPR_STEP);
      }
    } else if (ema < FAST_MS) {
      slowFrames = 0;
      if (++fastFrames >= FAST_FRAMES) {
        fastFrames = 0;
        const cap = Math.min(deviceDpr, dprCap);
        if (size.dpr < cap - 1e-6) setResolution(Math.min(cap, size.dpr + DPR_STEP));
      }
    } else {
      slowFrames = 0;
      fastFrames = 0;
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
    composer.dispose();
    bloomPass.dispose();
    blurPass.dispose();
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
    passes: { renderPass, blurPass, bloomPass, outputPass },
    get quality() { return quality; },
    get dprCap() { return Math.min(deviceDpr, dprCap); },
    setQuality,
    setResolution,
    resize,
    render,
    setWarp,
    adaptive,
    onPixelRatio,
    onResize,
    dispose,
  };
}
