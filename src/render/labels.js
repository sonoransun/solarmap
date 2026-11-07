// CSS2D body labels: a <button class="lbl"> per body (body-coloured dot + name) attached to the body anchor, plus a
// layout pass at 10 Hz that decides, in priority order (selected first), which labels show and where:
//  - small bodies: dot + name right of the marker; discs wider than 14 px: name beside the limb (upper-right, at
//    pxRadius + 10 px, dot hidden, kept inside the viewport);
//  - hidden when behind the camera / off-screen, when the body fills > 45 % of the viewport height, when its centre
//    is covered by a nearer and larger disc, when a child body sits on its parent's label (Moon within Earth's disc
//    + 6 px), under the 'few' density setting, or when its rect overlaps a higher-priority label already shown;
//  - the selected label always wins (no overlap / occlusion / proximity rejection, no hysteresis);
//  - every flip waits until the previous state has lasted ≥ 0.4 s (labelLayout.hysteresisStep), so labels never
//    flicker on a threshold; opacity also fades with camera distance (1 → 0.4 between 60 and 400 AU).
// The CSS2D layer itself is pointer-events:none (renderer.js); each label button is pointer-events:auto and selects
// on click, flies on double-click (the callbacks arrive through createLabelLayout). r186 CSS2DRenderer owns the
// element's inline `transform` (translate(-cx%, -cy%) translate(x, y)), so the anchor offset is expressed through
// CSS2DObject.center = (−dx / width, 0.5 − dy / height): no transform of our own, no transform transition.
// Element sizes are measured once on the first layout and once more when the web fonts settle (document.fonts.ready),
// never on a timer: offsetWidth forces a synchronous layout.

import { Vector3 } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  labelAnchor, clampAnchor, distanceFade, rectsOverlap, isOccluded, nearParent, passesDensity, createHysteresis,
  hysteresisStep, placementMode, FILL_FRACTION, HYSTERESIS_S, LIMB_MODE_PX,
} from './labelLayout.js';

/** Layout cadence (s). */
const LAYOUT_PERIOD_S = 0.1;
/** Label box (px) assumed until the element has been measured (12.5 px/500 text + 5/9 px padding, scene.css). */
const DEFAULT_W = 64;
const DEFAULT_H = 28;
/** Retry cadence (s) for label elements that could not be measured yet (display:none while off-screen). */
const MEASURE_RETRY_S = 1;
/** Bodies this far outside the viewport (px) are treated as off-screen. */
const OFFSCREEN_X_PX = 60;
const OFFSCREEN_Y_PX = 30;

const _view = new Vector3();
const _ndc = new Vector3();
const _anchor = [0, 0];

/**
 * @param {number} colour hex number
 * @returns {string} css colour
 */
function hexCss(colour) {
  return '#' + ((colour >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * @typedef {object} LabelHandle
 * @property {string} id
 * @property {CSS2DObject} object
 * @property {HTMLButtonElement} element
 * @property {number} priority
 * @property {number} width    measured px width (0 until measured)
 * @property {number} height   measured px height (0 until measured)
 * @property {boolean} measured
 * @property {number} opacity  last applied opacity
 * @property {'limb'|'marker'} mode
 * @property {(a: number) => void} setOpacity
 * @property {(on: boolean) => void} setSelected
 * @property {(mode: 'limb'|'marker', dx: number, dy: number) => void} setPlacement  anchor offset from the body centre (px, y down)
 * @property {() => boolean} measure
 * @property {() => void} dispose
 */

/**
 * Create the CSS2D label for one body.
 * @param {{ id: string, name: string, colour: number, priority?: number }} bodyDef
 * @returns {LabelHandle}
 */
export function createLabel(bodyDef) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'lbl';
  element.dataset.body = bodyDef.id;
  element.setAttribute('aria-label', bodyDef.name);
  element.style.pointerEvents = 'auto';
  element.style.setProperty('--c', hexCss(bodyDef.colour));
  // Inline so an older stylesheet rule can never add a transform transition (the renderer rewrites transform per frame).
  element.style.transition = 'opacity 180ms cubic-bezier(.2, 0, 0, 1), background-color 130ms cubic-bezier(.2, 0, 0, 1)';

  const dot = document.createElement('span');
  dot.className = 'lbl-dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'lbl-text';
  text.textContent = bodyDef.name;

  element.append(dot, text);

  const object = new CSS2DObject(element);
  object.name = 'label:' + bodyDef.id;
  object.center.set(0, 0.5); // left-middle at the body centre until the first layout places it

  const handle = {
    id: bodyDef.id,
    object,
    element,
    priority: bodyDef.priority ?? 0,
    width: 0,
    height: 0,
    measured: false,
    opacity: NaN, // first setOpacity() always writes
    mode: /** @type {'limb'|'marker'} */ ('marker'),
    dx: NaN,
    dy: NaN,
    setOpacity(a) {
      if (a === handle.opacity) return;
      handle.opacity = a;
      element.style.opacity = a.toFixed(2);
      const hidden = a <= 0.05;
      element.style.pointerEvents = hidden ? 'none' : 'auto';
      element.classList.toggle('is-hidden', hidden);
      element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      element.tabIndex = hidden ? -1 : 0;
    },
    setSelected(on) {
      element.classList.toggle('is-selected', on);
    },
    setPlacement(mode, dx, dy) {
      if (mode !== handle.mode) {
        handle.mode = mode;
        element.classList.toggle('is-limb', mode === 'limb');
      }
      if (dx === handle.dx && dy === handle.dy) return;
      handle.dx = dx;
      handle.dy = dy;
      const w = handle.width || DEFAULT_W;
      const h = handle.height || DEFAULT_H;
      // CSS2DRenderer: transform = translate(−100·cx %, −100·cy %) translate(x, y) → a centre of (−dx/w, 0.5 − dy/h)
      // puts the element's left-middle point dx px right of and dy px below the projected body centre.
      object.center.set(-dx / w, 0.5 - dy / h);
    },
    measure() {
      const w = element.offsetWidth;
      const h = element.offsetHeight;
      if (w > 0 && h > 0) {
        handle.width = w;
        handle.height = h;
        handle.measured = true;
        handle.dx = NaN; // re-derive the centre from the new size on the next placement
      }
      return handle.measured;
    },
    dispose() {
      object.removeFromParent();
      element.remove();
    },
  };
  return handle;
}

/**
 * @typedef {object} LabelEntry
 * @property {string} id
 * @property {LabelHandle} label
 * @property {import('three').Object3D} anchor  root-level object whose .position is the body position (AU)
 * @property {() => number} getPxRadius          projected display radius in CSS px (this frame)
 * @property {string|null} [parent]             parent body id (the Moon's is 'earth'): proximity rule
 */

/**
 * Layout manager for all body labels (10 Hz; call layout() every frame with the REAL frame time so reduced motion,
 * which freezes material time, does not freeze the labels).
 * @param {{
 *   entries: LabelEntry[],
 *   onSelect?: ((id: string) => void)|null,
 *   onFly?: ((id: string) => void)|null,
 *   getDensity?: (() => string)|null,   settings.labelDensity: 'auto' | 'few' | 'all'
 * }} opts
 */
export function createLabelLayout({ entries, onSelect = null, onFly = null, getDensity = null }) {
  /** sorted by priority desc; the selected entry is promoted to the front each layout */
  const order = entries.slice().sort((a, b) => b.label.priority - a.label.priority);
  const n = order.length;
  const byId = new Map();
  for (const e of order) {
    byId.set(e.id, e);
    e.hyst = createHysteresis();
    e.enabled = true;
    e.slot = 0;
  }
  for (const e of order) e.parentEntry = e.parent ? (byId.get(e.parent) ?? null) : null;

  // scratch per entry (allocated once)
  const sx = new Float64Array(n);   // body screen centre (px)
  const sy = new Float64Array(n);
  const depth = new Float64Array(n); // camera distance (AU)
  const pxr = new Float64Array(n);   // projected radius (px)
  const ax = new Float64Array(n);   // label anchor (px)
  const ay = new Float64Array(n);
  const fade = new Float64Array(n);
  const onScreen = new Uint8Array(n);
  const placedIdx = new Int32Array(n);
  let acc = LAYOUT_PERIOD_S; // run on the first call
  let visible = true;
  let selectedId = null;
  let remeasure = true;
  let measureWait = 0; // seconds until the next measurement attempt while some element is still unmeasurable

  // --- pointer wiring: click selects, double-click flies -------------------------------------------------------------
  const listeners = [];
  for (const e of order) {
    const el = e.label.element;
    const click = () => { if (onSelect) onSelect(e.id); };
    const dbl = (ev) => { ev.preventDefault(); if (onFly) onFly(e.id); };
    el.addEventListener('click', click);
    el.addEventListener('dblclick', dbl);
    listeners.push([el, click, dbl]);
  }
  // Web fonts can arrive after the first measurement: measure once more when they settle.
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
    fonts.ready.then(() => { remeasure = true; measureWait = 0; }, () => {});
  }

  /**
   * @param {number} dtSeconds real seconds since the previous call
   * @param {import('three').PerspectiveCamera} camera  matrixWorldInverse must be current
   * @param {number} w viewport width (CSS px)
   * @param {number} h viewport height (CSS px)
   * @param {boolean} [force]
   */
  function layout(dtSeconds, camera, w, h, force = false) {
    acc += dtSeconds;
    if (!visible) return;
    if (!force && acc < LAYOUT_PERIOD_S) return;
    const step = acc;
    acc = 0;

    // promote the selected label to the front (index 0) without allocating
    if (selectedId !== null) {
      for (let i = 1; i < n; i++) {
        if (order[i].id === selectedId) {
          const e = order[i];
          for (let j = i; j > 0; j--) order[j] = order[j - 1];
          order[0] = e;
          break;
        }
      }
    }

    // Measure once (first layout) and again when the fonts settle. An element the renderer has display:none (body
    // off-screen) measures 0 → retry, but no more than once a second: offsetWidth forces a synchronous layout.
    measureWait -= step;
    if (remeasure && measureWait <= 0) {
      remeasure = false;
      for (let i = 0; i < n; i++) if (!order[i].label.measure()) remeasure = true;
      if (remeasure) measureWait = MEASURE_RETRY_S;
    }
    const density = getDensity ? getDensity() : 'auto';

    // pass 1: projection, distance fade, on-screen flags
    for (let i = 0; i < n; i++) {
      const e = order[i];
      e.slot = i;
      onScreen[i] = 0;
      pxr[i] = 0;
      const p = e.anchor.position;
      _view.copy(p).applyMatrix4(camera.matrixWorldInverse);
      if (_view.z >= -camera.near) continue; // behind the camera
      _ndc.copy(p).project(camera);
      const x = (_ndc.x * 0.5 + 0.5) * w;
      const y = (-_ndc.y * 0.5 + 0.5) * h;
      sx[i] = x;
      sy[i] = y;
      depth[i] = _view.length();
      pxr[i] = e.getPxRadius();
      if (x < -OFFSCREEN_X_PX || x > w + OFFSCREEN_X_PX || y < -OFFSCREEN_Y_PX || y > h + OFFSCREEN_Y_PX) continue;
      onScreen[i] = 1;
      fade[i] = distanceFade(depth[i]);
    }

    // pass 2: decisions in priority order; lower priorities test against the labels already shown
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const e = order[i];
      const lbl = e.label;
      const sel = e.id === selectedId;
      let want = e.enabled && onScreen[i] === 1;
      if (want && pxr[i] > FILL_FRACTION * h) want = false; // the body fills the view
      if (want && !sel && !passesDensity(lbl.priority, density)) want = false;
      if (want && !sel && e.parentEntry) {
        const j = e.parentEntry.slot;
        if (onScreen[j] === 1 && nearParent(sx[i], sy[i], sx[j], sy[j], pxr[j])) want = false;
      }
      if (want && !sel) {
        for (let k = 0; k < n; k++) {
          if (k === i || onScreen[k] === 0) continue;
          if (isOccluded(sx[i], sy[i], depth[i], pxr[i], sx[k], sy[k], depth[k], pxr[k])) { want = false; break; }
        }
      }
      const lw = lbl.width || DEFAULT_W;
      const lh = lbl.height || DEFAULT_H;
      if (onScreen[i] === 1) {
        labelAnchor(pxr[i], _anchor);
        let lx = sx[i] + _anchor[0];
        let ly = sy[i] + _anchor[1];
        if (pxr[i] > LIMB_MODE_PX) {
          clampAnchor(lx, ly, lw, lh, w, h, undefined, _anchor);
          lx = _anchor[0];
          ly = _anchor[1];
        }
        ax[i] = lx;
        ay[i] = ly;
        if (want && !sel && density !== 'all') {
          for (let k = 0; k < placed; k++) {
            const j = placedIdx[k];
            const lj = order[j].label;
            if (rectsOverlap(lx, ly, lw, lh, ax[j], ay[j], lj.width || DEFAULT_W, lj.height || DEFAULT_H)) { want = false; break; }
          }
        }
        lbl.setPlacement(placementMode(pxr[i]), lx - sx[i], ly - sy[i]);
      }
      const shown = hysteresisStep(e.hyst, want, step, sel ? 0 : HYSTERESIS_S) && onScreen[i] === 1;
      if (shown) placedIdx[placed++] = i;
      lbl.setOpacity(shown ? fade[i] : 0);
    }
  }

  /** @param {boolean} on */
  function setVisible(on) {
    visible = on;
    for (let i = 0; i < n; i++) order[i].label.object.visible = on && order[i].enabled;
  }

  /**
   * Show or hide one body's label regardless of layout (settings.showMoon).
   * @param {string} id
   * @param {boolean} on
   */
  function setEntryVisible(id, on) {
    const e = byId.get(id);
    if (!e) return;
    e.enabled = !!on;
    e.label.object.visible = visible && e.enabled;
    if (!e.enabled) { e.label.setOpacity(0); e.hyst.shown = false; e.hyst.age = Infinity; }
    acc = LAYOUT_PERIOD_S;
  }

  /** @param {string|null} id */
  function setSelected(id) {
    selectedId = id;
    for (let i = 0; i < n; i++) order[i].label.setSelected(order[i].id === id);
    acc = LAYOUT_PERIOD_S; // re-layout on the next call
  }

  /** Measure the elements again on the next layout (after a stylesheet or font change). */
  function measure() {
    remeasure = true;
    measureWait = 0;
    acc = LAYOUT_PERIOD_S;
  }

  function dispose() {
    for (const [el, click, dbl] of listeners) {
      el.removeEventListener('click', click);
      el.removeEventListener('dblclick', dbl);
    }
    listeners.length = 0;
    for (let i = 0; i < n; i++) order[i].label.dispose();
  }

  return { layout, setVisible, setEntryVisible, setSelected, measure, dispose };
}
