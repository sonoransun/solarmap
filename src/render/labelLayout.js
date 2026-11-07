// Pure screen-space helpers for the body labels: placement beside a disc or a marker, overlap and occlusion tests,
// the parent-proximity rule (the Moon beside Earth) and the show/hide hysteresis. No three.js and no DOM, so node
// can test them (test/labels.test.mjs); labels.js applies the results to CSS2DObjects.
//
// Conventions: screen coordinates are CSS px with y down. A label rect is anchored at its LEFT-MIDDLE point (x, y)
// and spans [x, x + w] × [y − h/2, y + h/2] — the box of a CSS2DObject whose `center` is (0, 0.5), shifted by the
// anchor offset that labels.js expresses through `center` (the renderer owns the element's transform).

/** Projected disc radius (CSS px) above which the label leaves the disc for the limb (task brief: > 14 px). */
export const LIMB_MODE_PX = 14;
/** Limb mode: the anchor sits at pxRadius + this gap from the disc centre (task brief: offset = pxRadius + 10 px). */
export const LIMB_GAP_PX = 10;
/** Limb anchor direction: upper-right, 45° above the screen horizontal (task brief). */
export const LIMB_ANGLE_RAD = Math.PI / 4;
/** Marker mode: the label's left edge sits this far right of the marker centre, so its dot overlaps the marker. */
export const MARKER_GAP_PX = 2;
/** A label keeps its shown/hidden state at least this long before it may flip (contracts: 0.4 s; brief: ≥ 0.35 s). */
export const HYSTERESIS_S = 0.4;
/** Camera-distance fade: opacity 1 at ≤ 60 AU → FADE_MIN at ≥ 400 AU (plan §Rendering › Labels). */
export const FADE_NEAR_AU = 60;
export const FADE_FAR_AU = 400;
export const FADE_MIN = 0.4;
/** A body whose disc fills more than this fraction of the viewport height gets no label: the body is the view. */
export const FILL_FRACTION = 0.45;
/** Parent-proximity rule: a child body (Moon) is unlabelled while closer than parent pxRadius + this margin (brief: 6 px). */
export const PARENT_MARGIN_PX = 6;
/** Margin (px) kept between neighbouring label rects. */
export const OVERLAP_MARGIN_PX = 4;
/** Viewport margin (px) that a limb-mode label is kept inside when its disc is large. */
export const VIEWPORT_MARGIN_PX = 8;
/** Label priority (plan §Labels: Sun 10 … Neptune 2) that survives the 'few' density setting. */
export const FEW_MIN_PRIORITY = 7;

/**
 * Hermite smoothstep (GLSL semantics; MathUtils.smoothstep equivalent without three).
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number} 0…1
 */
export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * 'limb' when the disc is big enough to read as a disc (label beside the limb, dot hidden), else 'marker'.
 * @param {number} pxRadius projected display radius (CSS px)
 * @returns {'limb'|'marker'}
 */
export function placementMode(pxRadius) {
  return pxRadius > LIMB_MODE_PX ? 'limb' : 'marker';
}

/**
 * Anchor offset (px, y down) of the label's left-middle point from the body's screen centre.
 * @param {number} pxRadius projected display radius (CSS px)
 * @param {number[]} [out]
 * @returns {number[]} [dx, dy]
 */
export function labelAnchor(pxRadius, out = [0, 0]) {
  if (pxRadius > LIMB_MODE_PX) {
    const r = pxRadius + LIMB_GAP_PX;
    out[0] = r * Math.cos(LIMB_ANGLE_RAD);
    out[1] = -r * Math.sin(LIMB_ANGLE_RAD);
  } else {
    out[0] = MARKER_GAP_PX;
    out[1] = 0;
  }
  return out;
}

/**
 * Keep a left-middle anchored rect inside the viewport (used in limb mode, where a large disc would push the label
 * off-screen while the disc itself is still visible).
 * @param {number} x anchor x
 * @param {number} y anchor y
 * @param {number} w rect width
 * @param {number} h rect height
 * @param {number} viewW
 * @param {number} viewH
 * @param {number} [margin]
 * @param {number[]} [out]
 * @returns {number[]} clamped [x, y]
 */
export function clampAnchor(x, y, w, h, viewW, viewH, margin = VIEWPORT_MARGIN_PX, out = [0, 0]) {
  const maxX = Math.max(margin, viewW - w - margin);
  const minY = margin + h / 2;
  const maxY = Math.max(minY, viewH - h / 2 - margin);
  out[0] = Math.min(Math.max(x, margin), maxX);
  out[1] = Math.min(Math.max(y, minY), maxY);
  return out;
}

/**
 * Label opacity from the camera distance: 1 up to 60 AU, easing to 0.4 at 400 AU and beyond.
 * @param {number} dAu camera → body distance (AU)
 * @returns {number}
 */
export function distanceFade(dAu) {
  return 1 - (1 - FADE_MIN) * smoothstep(FADE_NEAR_AU, FADE_FAR_AU, dAu);
}

/**
 * Overlap test for two left-middle anchored rects with a margin.
 * @param {number} ax @param {number} ay @param {number} aw @param {number} ah
 * @param {number} bx @param {number} by @param {number} bw @param {number} bh
 * @param {number} [margin]
 * @returns {boolean}
 */
export function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh, margin = OVERLAP_MARGIN_PX) {
  if (!(ax < bx + bw + margin && bx < ax + aw + margin)) return false;
  return Math.abs(ay - by) < (ah + bh) / 2 + margin;
}

/**
 * Screen-space occlusion: body i is hidden when its centre falls inside the disc of a body j that is both nearer to
 * the camera and larger on screen (a body in front of a larger disc is never "occluded" by it).
 * @param {number} xi @param {number} yi screen centre of i (px)
 * @param {number} di camera distance of i (AU)
 * @param {number} pxi projected radius of i (px)
 * @param {number} xj @param {number} yj screen centre of j (px)
 * @param {number} dj camera distance of j (AU)
 * @param {number} pxj projected radius of j (px)
 * @returns {boolean}
 */
export function isOccluded(xi, yi, di, pxi, xj, yj, dj, pxj) {
  if (!(dj < di) || !(pxj > pxi) || !(pxj > 1)) return false;
  const dx = xi - xj, dy = yi - yj;
  return dx * dx + dy * dy < pxj * pxj;
}

/**
 * Parent-proximity rule: true while the child's screen centre lies within parentPxRadius + margin of the parent's.
 * @param {number} xi @param {number} yi child centre (px)
 * @param {number} xp @param {number} yp parent centre (px)
 * @param {number} pxp parent projected radius (px)
 * @param {number} [margin]
 * @returns {boolean}
 */
export function nearParent(xi, yi, xp, yp, pxp, margin = PARENT_MARGIN_PX) {
  const r = pxp + margin;
  const dx = xi - xp, dy = yi - yp;
  return dx * dx + dy * dy < r * r;
}

/**
 * Whether a label of this priority is drawn under the given density setting (settings.labelDensity):
 * 'few' keeps the Sun, Earth, the Moon, Jupiter and Saturn (priority ≥ 7); 'auto' and 'all' keep every body.
 * @param {number} priority
 * @param {string} density
 * @returns {boolean}
 */
export function passesDensity(priority, density) {
  return density === 'few' ? priority >= FEW_MIN_PRIORITY : true;
}

/**
 * @typedef {{ shown: boolean, age: number }} Hysteresis  shown = current state; age = seconds in that state
 */

/** @returns {Hysteresis} hidden, with an infinite age so the first decision applies immediately */
export function createHysteresis() {
  return { shown: false, age: Infinity };
}

/**
 * Advance the hysteresis by dt and apply the wanted state only once the current one has lasted ≥ hold seconds. A
 * wish that reverses before the hold elapses never shows (no flicker when a label hovers on a threshold).
 * @param {Hysteresis} state mutated in place
 * @param {boolean} want
 * @param {number} dt seconds since the previous step
 * @param {number} [hold]
 * @returns {boolean} the state after this step
 */
export function hysteresisStep(state, want, dt, hold = HYSTERESIS_S) {
  state.age += dt;
  if (want !== state.shown && state.age >= hold) {
    state.shown = want;
    state.age = 0;
  }
  return state.shown;
}
