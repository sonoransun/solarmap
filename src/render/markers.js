// Body markers: ONE Points object for the Sun, the planets (and the Moon when present) drawn as brightness-driven
// glows. Per vertex: aSize (CSS px), aAlpha (disc cross-fade), aIntensity (HDR level) and aColor (body colour).
//
// Brightness law (plan contract: ∝ 10^(−0.4 m)): the apparent magnitude m comes from main.js via setMagnitude(id, m)
// (E's photometry, as seen from Earth); without one, the per-body means of Mallama & Hilton 2018 apply (DEFAULT_MAG).
// As for stars (src/astro/sky.js), a display cannot show the 145 000:1 flux range between Venus (−4.9) and Neptune
// (+8), so size and intensity are power laws of the Pogson flux ratio f = 10^(−0.4 (m − 8)):
//   size      =  9 px · f^0.0893   (9 → 26 px over the range)   — the glow's extent grows slowly with brightness
//   intensity = 0.7 · f^0.1105     (0.7 → 2.6)                  — HDR above ~1.2 so Venus, Jupiter, Earth bloom
// A visibility floor (9 px at 0.7, mostly a white-ish core) keeps every planet visible from the home view whatever
// its magnitude; the Sun is handled by sunGlare.js and its marker clamps to the bright end.
// Disc cross-fade (unchanged):  pxRadius = R_disp / max(d, 1.0001 R_disp) / tan(fov/2) · H/2 (scene.js);
//   alpha = 1 − smoothstep(pxRadius, 2, 7)  — marker fully on below 2 px, gone above 7 px; the marker never shrinks
//   below 2·pxRadius + 4 so it covers the disc while fading.
// Selection: a subtle pulse (+1.5 px, alpha floor 0.3–0.55 at 1.2 Hz).
// renderOrder 10 draws the glows after the meshes with depthTest on, so a marker behind a large nearby planet is hidden.

import { BufferGeometry, BufferAttribute, Float32BufferAttribute, Points, Color, DynamicDrawUsage, MathUtils } from 'three';
import { createGlowMarkerMaterial } from './skyMaterials.js';

const SELECT_PULSE_HZ = 1.2;

/**
 * Mean apparent V magnitudes from Earth, Mallama & Hilton 2018 ("Computing apparent planetary magnitudes for The
 * Astronomical Almanac", Astronomy and Computing 25, 10–24; means as tabulated by the IAU/NASA fact sheets).
 * The Sun is −26.74 (Allen's Astrophysical Quantities). Earth has no magnitude as seen from Earth: −3.0 keeps the
 * home planet as prominent as Jupiter for a first-time viewer. The Moon's mean full-moon −12.74 is clamped anyway.
 */
export const DEFAULT_MAG = Object.freeze({
  sun: -26.74, mercury: 0.23, venus: -4.14, earth: -3.0, moon: -12.74, mars: 0.71,
  jupiter: -2.20, saturn: 0.46, uranus: 5.68, neptune: 7.78,
});

/** Magnitude span of the marker law (Venus at its brightest … beyond Neptune). */
export const MARKER_MAG_BRIGHT = -4.9;
export const MARKER_MAG_FAINT = 8.0;
export const MARKER_PX_MIN = 9;
export const MARKER_PX_MAX = 26;
export const MARKER_INTENSITY_MIN = 0.7;
export const MARKER_INTENSITY_MAX = 2.6;
const MARKER_FLUX_RANGE = Math.pow(10, 0.4 * (MARKER_MAG_FAINT - MARKER_MAG_BRIGHT));
const MARKER_SIZE_EXP = Math.log(MARKER_PX_MAX / MARKER_PX_MIN) / Math.log(MARKER_FLUX_RANGE);
const MARKER_INTENSITY_EXP = Math.log(MARKER_INTENSITY_MAX / MARKER_INTENSITY_MIN) / Math.log(MARKER_FLUX_RANGE);

/**
 * Marker appearance for an apparent magnitude (pure; exported for QA and the console).
 * @param {number} m apparent magnitude (clamped to [−4.9, 8])
 * @param {{ sizePx: number, intensity: number }} [out]
 * @returns {{ sizePx: number, intensity: number }}
 */
export function markerAppearance(m, out = { sizePx: 0, intensity: 0 }) {
  const mc = Math.min(MARKER_MAG_FAINT, Math.max(MARKER_MAG_BRIGHT, Number.isFinite(m) ? m : MARKER_MAG_FAINT));
  const f = Math.pow(10, -0.4 * (mc - MARKER_MAG_FAINT));
  out.sizePx = MARKER_PX_MIN * Math.pow(f, MARKER_SIZE_EXP);
  out.intensity = MARKER_INTENSITY_MIN * Math.pow(f, MARKER_INTENSITY_EXP);
  return out;
}

const _app = { sizePx: 0, intensity: 0 };

/**
 * @param {{ bodies: Array<{ id: string, colour: number }>, materials?: object }} opts `materials` is accepted for
 *   signature compatibility; the glow material comes from skyMaterials.js.
 */
export function createMarkers({ bodies }) {
  const n = bodies.length;
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const alphas = new Float32Array(n);
  const intensities = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const pxRadii = new Float32Array(n);
  const lawSize = new Float32Array(n);   // size from the magnitude law (before the disc-cover minimum)
  const mags = new Float32Array(n);
  const enabled = new Uint8Array(n).fill(1);
  /** @type {Map<string, number>} */
  const index = new Map();
  const c = new Color();
  for (let i = 0; i < n; i++) {
    index.set(bodies[i].id, i);
    c.setHex(bodies[i].colour); // sRGB hex → linear working space; the shader ends with <colorspace_fragment>
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    alphas[i] = 1;
    mags[i] = DEFAULT_MAG[bodies[i].id] ?? MARKER_MAG_FAINT;
    markerAppearance(mags[i], _app);
    lawSize[i] = _app.sizePx;
    sizes[i] = _app.sizePx;
    intensities[i] = _app.intensity;
  }

  // BufferAttribute (not Float32BufferAttribute, which copies its input) so the per-frame writes above reach the GPU
  const geometry = new BufferGeometry();
  const posAttr = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  const sizeAttr = new BufferAttribute(sizes, 1).setUsage(DynamicDrawUsage);
  const alphaAttr = new BufferAttribute(alphas, 1).setUsage(DynamicDrawUsage);
  const intensityAttr = new BufferAttribute(intensities, 1).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setAttribute('aIntensity', intensityAttr);
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3));

  const material = createGlowMarkerMaterial();
  const points = new Points(geometry, material);
  points.name = 'markers';
  points.frustumCulled = false;
  points.renderOrder = 10;

  let selectedIdx = -1;
  let visible = true;
  let intensityDirty = true;

  /**
   * Write one body for this frame (call for every body, then commit()).
   * @param {string} id
   * @param {number} x AU
   * @param {number} y AU
   * @param {number} z AU
   * @param {number} pxRadius projected display radius, CSS px
   */
  function set(id, x, y, z, pxRadius) {
    const i = index.get(id);
    if (i === undefined) return;
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    pxRadii[i] = pxRadius;
    const alpha = enabled[i] ? 1 - MathUtils.smoothstep(pxRadius, 2, 7) : 0;
    alphas[i] = alpha;
    // While fading, grow to cover the disc (≤ 18 px: alpha is 0 beyond 7 px); once faded, a 1 px point costs nothing.
    sizes[i] = alpha > 0 ? Math.max(lawSize[i], Math.min(2 * pxRadius + 4, 18)) : 1;
  }

  /**
   * Apparent magnitude for one body (from main.js' photometry provider); null/undefined/NaN restores the default.
   * @param {string} id
   * @param {number|null|undefined} m
   */
  function setMagnitude(id, m) {
    const i = index.get(id);
    if (i === undefined) return;
    const value = Number.isFinite(m) ? m : (DEFAULT_MAG[id] ?? MARKER_MAG_FAINT);
    if (value === mags[i]) return;
    mags[i] = value;
    markerAppearance(value, _app);
    lawSize[i] = _app.sizePx;
    intensities[i] = _app.intensity;
    intensityDirty = true;
  }

  /**
   * Switch one body's marker off/on (e.g. the Sun once the glare quad carries its presence).
   * @param {string} id
   * @param {boolean} on
   */
  function setEnabled(id, on) {
    const i = index.get(id);
    if (i !== undefined) enabled[i] = on ? 1 : 0;
  }

  /** @param {string} id @returns {number} magnitude currently driving the marker */
  function getMagnitude(id) {
    const i = index.get(id);
    return i === undefined ? NaN : mags[i];
  }

  /**
   * Upload this frame's attributes; the selected marker pulses (subtly).
   * @param {number} tSeconds
   */
  function commit(tSeconds) {
    if (selectedIdx >= 0) {
      const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * SELECT_PULSE_HZ * tSeconds);
      sizes[selectedIdx] += 1.5 * pulse;
      if (alphas[selectedIdx] > 0) alphas[selectedIdx] = Math.max(alphas[selectedIdx], 0.3 + 0.25 * pulse);
    }
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    if (intensityDirty) { intensityAttr.needsUpdate = true; intensityDirty = false; }
  }

  /** @param {string|null} id */
  function setSelected(id) {
    selectedIdx = id === null || id === undefined ? -1 : (index.get(id) ?? -1);
  }

  /** @param {number} pr */
  function setPixelRatio(pr) {
    material.uniforms.uPixelRatio.value = pr;
  }

  /** @param {boolean} on */
  function setVisible(on) {
    visible = on;
    points.visible = on;
  }

  /** @param {string} id @returns {number} last written projected radius (px) */
  function getPxRadius(id) {
    const i = index.get(id);
    return i === undefined ? 0 : pxRadii[i];
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    points.removeFromParent();
  }

  return {
    points, material, set, commit, setSelected, setMagnitude, getMagnitude, setEnabled, setPixelRatio, setVisible,
    getPxRadius, get visible() { return visible; }, dispose,
  };
}
