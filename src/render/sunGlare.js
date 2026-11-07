// The Sun's glare: one HDR billboard quad (shaders/sunFlare.js) replacing the two clamped sprites. Added as a child
// of the Sun's anchor by bodyView.js; the vertex shader makes it face the camera, so the parent's rotation is
// irrelevant. Per frame, update() sets the quad's world half-size from the screen-space size law and the time.
//
// Size law (screen space): half-size px = clamp(GLARE_K · R☉px, GLARE_MIN_PX / 2, GLARE_MAX_FRAC · H / 2), i.e. the
// glare spans 14 solar radii but never less than 40 px across (presence from the home view, where the disc is
// 0.1 px) and never more than 35 % of the viewport height. World half-size = px · 2 d tan(fov/2) / H.
//
// Suppression: close up, the photosphere is the subject; the glare eases out automatically between 60 and 320 px of
// disc radius (to 15 % residual), and setSuppression(x) adds an explicit 0…1 factor (the Venus-transit chapter sets
// 1 so the silhouette reads against a clean disc). Both multiply: uSuppress = 1 − (1 − 0.85·auto)·(1 − manual).
// depthTest ON against the disc (the quad is at the Sun's centre, so the near hemisphere hides the glare's middle and
// it is seen around the limb); depthWrite off; additive; renderOrder 3 like the sprites it replaces.

import { Mesh, PlaneGeometry, Vector3, MathUtils } from 'three';
import { createSunFlareMaterial } from './skyMaterials.js';

/** Glare half-size in solar (display) radii. */
export const GLARE_K = 7;
/** Minimum on-screen diameter (CSS px). */
export const GLARE_MIN_PX = 40;
/** Maximum diameter as a fraction of the viewport height. */
export const GLARE_MAX_FRAC = 0.35;
/** Automatic suppression ramp (disc radius, CSS px) and its depth. */
export const SUPPRESS_PX = Object.freeze({ start: 60, end: 320, depth: 0.85 });
const TIME_WRAP_S = 1e4;

const _sun = new Vector3();

/**
 * Half-size of the glare quad on screen (pure law).
 * @param {number} sunPxRadius projected radius of the displayed photosphere, CSS px
 * @param {number} viewportH CSS px
 * @returns {number} CSS px
 */
export function glareHalfSizePx(sunPxRadius, viewportH) {
  const h = Math.max(1, viewportH || 1);
  return MathUtils.clamp(GLARE_K * Math.max(0, sunPxRadius || 0), GLARE_MIN_PX / 2, GLARE_MAX_FRAC * h / 2);
}

/**
 * Automatic glare suppression from the disc's on-screen size (pure law, 0…depth).
 * @param {number} sunPxRadius CSS px
 * @returns {number}
 */
export function autoSuppression(sunPxRadius) {
  return SUPPRESS_PX.depth * MathUtils.smoothstep(sunPxRadius || 0, SUPPRESS_PX.start, SUPPRESS_PX.end);
}

/**
 * @param {{ materials?: object }} [opts] `materials` accepted for signature compatibility (setMaterialTime is not needed:
 *   update() takes tSeconds directly).
 * @returns {{
 *   object: Mesh, material: import('three').ShaderMaterial,
 *   update: (args: { camera: import('three').PerspectiveCamera, viewportH: number, sunPxRadius: number, dispRadiusAu?: number, tSeconds?: number }) => void,
 *   setSuppression: (x: number) => void, getSuppression: () => number, setIntensity: (k: number) => void, dispose: () => void,
 * }}
 */
export function createSunGlare() {
  const geometry = new PlaneGeometry(2, 2);
  const material = createSunFlareMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sun-glare';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  const u = material.uniforms;
  let manual = 0;

  /**
   * @param {object} args
   * @param {import('three').PerspectiveCamera} args.camera
   * @param {number} args.viewportH  CSS px
   * @param {number} [args.sunPxRadius] projected radius of the displayed photosphere, CSS px
   * @param {number} [args.pxRadius] alias of sunPxRadius (bodyView.js passes its own name)
   * @param {number} [args.dispRadiusAu] displayed solar radius (AU); informational, the law works in px
   * @param {number} [args.suppression] per-frame explicit suppression 0…1 (combined with setSuppression by max)
   * @param {number} [args.tSeconds] animation time (streamers drift); omit to freeze (reduced motion)
   */
  function update({ camera, viewportH, sunPxRadius, pxRadius, suppression, tSeconds }) {
    if (!camera) return;
    const H = Math.max(1, viewportH || 1);
    if (!Number.isFinite(sunPxRadius)) sunPxRadius = Number.isFinite(pxRadius) ? pxRadius : 0;
    const explicit = Number.isFinite(suppression) ? Math.max(manual, MathUtils.clamp(suppression, 0, 1)) : manual;
    const halfPx = glareHalfSizePx(sunPxRadius, H);
    // distance from the camera to the Sun's centre (the parent anchor's world position; the Sun sits at the origin)
    if (mesh.parent) mesh.parent.getWorldPosition(_sun); else _sun.set(0, 0, 0);
    const d = Math.max(1e-9, camera.position.distanceTo(_sun));
    const tanHalf = Math.tan(MathUtils.DEG2RAD * camera.fov * 0.5);
    u.uHalfSize.value = halfPx * 2 * d * tanHalf / H;
    u.uDiscR.value = Math.max(0, sunPxRadius || 0) / halfPx;
    const auto = autoSuppression(sunPxRadius);
    u.uSuppress.value = 1 - (1 - auto) * (1 - explicit);
    if (tSeconds !== undefined) {
      let t = tSeconds % TIME_WRAP_S;
      if (t < 0) t += TIME_WRAP_S;
      u.uTime.value = t;
    }
    mesh.visible = u.uSuppress.value < 0.999;
  }

  /** Explicit suppression 0 (none) … 1 (glare off), e.g. the Venus-transit chapter. @param {number} x */
  function setSuppression(x) {
    manual = MathUtils.clamp(Number.isFinite(x) ? x : 0, 0, 1);
  }

  /** Overall HDR level (default 1). @param {number} k */
  function setIntensity(k) {
    u.uIntensity.value = Math.max(0, k || 0);
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    mesh.removeFromParent();
  }

  return { object: mesh, material, update, setSuppression, getSuppression: () => manual, setIntensity, dispose };
}
