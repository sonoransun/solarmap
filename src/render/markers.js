// Screen-space body markers: ONE Points object for the Sun + 8 planets with per-vertex aSize (CSS px), aAlpha and
// aColor. The marker cross-fades with the projected disc (plan §Rendering › Markers):
//   pxRadius = R_disp / max(d, 1.0001 R_disp) / tan(fov/2) · H/2  (computed by scene.js)
//   alpha    = 1 − smoothstep(pxRadius, 2, 7)        marker fully on below 2 px, gone above 7 px
//   size     = clamp(2·pxRadius + 4, 6, 12) px       slightly larger than the disc it replaces
// The material (materials.createMarkerMaterial) multiplies aSize by uPixelRatio and includes the r186 log-depth and
// tone-mapping chunks; renderOrder 10 draws the dots after the meshes with depthTest on, so a marker behind a large
// nearby planet is hidden correctly.

import { BufferGeometry, BufferAttribute, Float32BufferAttribute, Points, Color, DynamicDrawUsage, MathUtils } from 'three';

const SELECT_PULSE_HZ = 1.2;

/**
 * @param {{ bodies: Array<{ id: string, colour: number }>, materials: { createMarkerMaterial: () => import('three').Material } }} opts
 */
export function createMarkers({ bodies, materials }) {
  const n = bodies.length;
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const alphas = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const pxRadii = new Float32Array(n);
  /** @type {Map<string, number>} */
  const index = new Map();
  const c = new Color();
  for (let i = 0; i < n; i++) {
    index.set(bodies[i].id, i);
    c.setHex(bodies[i].colour); // sRGB hex → linear working space; the shader ends with <colorspace_fragment>
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    sizes[i] = 6;
    alphas[i] = 1;
  }

  // BufferAttribute (not Float32BufferAttribute, which copies its input) so the per-frame writes above reach the GPU
  const geometry = new BufferGeometry();
  const posAttr = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  const sizeAttr = new BufferAttribute(sizes, 1).setUsage(DynamicDrawUsage);
  const alphaAttr = new BufferAttribute(alphas, 1).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3));

  const material = materials.createMarkerMaterial();
  const points = new Points(geometry, material);
  points.name = 'markers';
  points.frustumCulled = false;
  points.renderOrder = 10;

  let selectedIdx = -1;
  let visible = true;

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
    alphas[i] = 1 - MathUtils.smoothstep(pxRadius, 2, 7);
    sizes[i] = MathUtils.clamp(2 * pxRadius + 4, 6, 12);
  }

  /**
   * Upload this frame's attributes; the selected marker pulses.
   * @param {number} tSeconds
   */
  function commit(tSeconds) {
    if (selectedIdx >= 0) {
      const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * SELECT_PULSE_HZ * tSeconds);
      sizes[selectedIdx] += 3 * pulse;
      if (alphas[selectedIdx] > 0) alphas[selectedIdx] = Math.max(alphas[selectedIdx], 0.35 + 0.35 * pulse);
    }
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  /** @param {string|null} id */
  function setSelected(id) {
    selectedIdx = id === null || id === undefined ? -1 : (index.get(id) ?? -1);
  }

  /** @param {number} pr */
  function setPixelRatio(pr) {
    const u = material.userData?.uniforms?.uPixelRatio ?? material.uniforms?.uPixelRatio;
    if (u) u.value = pr;
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

  return { points, material, set, commit, setSelected, setPixelRatio, setVisible, getPxRadius, get visible() { return visible; }, dispose };
}
