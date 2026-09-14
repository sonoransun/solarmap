// CSS2D body labels: a <button class="lbl"> per body (body-coloured dot + name) attached to the body anchor, plus a
// layout pass at 10 Hz that hides labels behind the camera or when the body fills > 45 % of the viewport height,
// fades them with camera distance (1 → 0.4 between 60 and 400 AU) and rejects overlaps greedily by priority.
// The CSS2D layer itself is pointer-events:none (renderer.js); each label button is pointer-events:auto.
// r186 CSS2DObject: element.style.position = 'absolute' is set by three; the renderer owns element.style.transform,
// so the text offset from the marker is done in CSS (padding-left), never with a transform here.

import { Vector3, MathUtils } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/** Nominal label height (px) used for the overlap test; matches the 12 px/500 label style in styles.css. */
const LABEL_H = 18;
/** Camera-distance fade band (AU): opacity 1 at ≤ 60 AU → 0.4 at ≥ 400 AU (plan §Rendering › Labels). */
const FADE_NEAR_AU = 60;
const FADE_FAR_AU = 400;
/** Layout cadence (s). */
const LAYOUT_PERIOD_S = 0.1;
/** Re-measure element widths this often (s) so late font loading is picked up. */
const MEASURE_PERIOD_S = 2;

const _view = new Vector3();
const _ndc = new Vector3();

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
 * @property {number} width   measured px width (0 until measured)
 * @property {number} opacity last applied opacity
 * @property {(a: number) => void} setOpacity
 * @property {(on: boolean) => void} setSelected
 * @property {() => void} measure
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
  element.style.transition = 'opacity 180ms cubic-bezier(.2, 0, 0, 1)';

  const dot = document.createElement('span');
  dot.className = 'lbl-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.background = hexCss(bodyDef.colour);

  const text = document.createElement('span');
  text.className = 'lbl-text';
  text.textContent = bodyDef.name;

  element.append(dot, text);

  const object = new CSS2DObject(element);
  object.name = 'label:' + bodyDef.id;
  object.center.set(0, 0.5); // left-middle anchored at the body centre; CSS pads the text off the marker

  const handle = {
    id: bodyDef.id,
    object,
    element,
    priority: bodyDef.priority ?? 0,
    width: 0,
    opacity: NaN, // first setOpacity() always writes
    setOpacity(a) {
      if (a === handle.opacity) return;
      handle.opacity = a;
      element.style.opacity = a.toFixed(2);
      element.style.pointerEvents = a > 0.05 ? 'auto' : 'none';
      element.classList.toggle('is-hidden', a <= 0.05);
      element.setAttribute('aria-hidden', a <= 0.05 ? 'true' : 'false');
    },
    setSelected(on) {
      element.classList.toggle('is-selected', on);
    },
    measure() {
      const w = element.offsetWidth;
      if (w > 0) handle.width = w;
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
 */

/**
 * Layout manager for all body labels (10 Hz).
 * @param {{ entries: LabelEntry[] }} opts
 */
export function createLabelLayout({ entries }) {
  /** sorted by priority desc; the selected entry is promoted to the front each layout */
  const order = entries.slice().sort((a, b) => b.label.priority - a.label.priority);
  const n = order.length;
  // scratch per entry (allocated once)
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const alpha = new Float64Array(n);
  const placedIdx = new Int32Array(n);
  let acc = LAYOUT_PERIOD_S; // run on the first call
  let measureAcc = MEASURE_PERIOD_S;
  let visible = true;
  let selectedId = null;

  /**
   * @param {number} dtSeconds
   * @param {import('three').PerspectiveCamera} camera  matrixWorldInverse must be current
   * @param {number} w viewport width (CSS px)
   * @param {number} h viewport height (CSS px)
   * @param {boolean} [force]
   */
  function layout(dtSeconds, camera, w, h, force = false) {
    acc += dtSeconds;
    measureAcc += dtSeconds;
    if (!visible) return;
    if (!force && acc < LAYOUT_PERIOD_S) return;
    acc = 0;
    const measure = measureAcc >= MEASURE_PERIOD_S;
    if (measure) measureAcc = 0;

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

    for (let i = 0; i < n; i++) {
      const e = order[i];
      const lbl = e.label;
      if (measure || lbl.width === 0) lbl.measure();
      const p = e.anchor.position;
      _view.copy(p).applyMatrix4(camera.matrixWorldInverse);
      if (_view.z >= -camera.near) { alpha[i] = 0; continue; } // behind the camera
      _ndc.copy(p).project(camera);
      const x = (_ndc.x * 0.5 + 0.5) * w;
      const y = (-_ndc.y * 0.5 + 0.5) * h;
      sx[i] = x;
      sy[i] = y;
      if (x < -60 || x > w + 60 || y < -30 || y > h + 30) { alpha[i] = 0; continue; }
      if (e.getPxRadius() > 0.45 * h) { alpha[i] = 0; continue; } // the body fills the view
      const d = _view.length();
      alpha[i] = 1 - 0.6 * MathUtils.smoothstep(d, FADE_NEAR_AU, FADE_FAR_AU);
    }

    // greedy overlap rejection in priority order
    let placed = 0;
    for (let i = 0; i < n; i++) {
      if (alpha[i] <= 0) continue;
      const wi = order[i].label.width || 60;
      let rejected = false;
      for (let k = 0; k < placed; k++) {
        const j = placedIdx[k];
        const wj = order[j].label.width || 60;
        // rects anchored at their left-middle: [x, x + w] × [y − H/2, y + H/2], 4 px margin
        const overlapX = sx[i] < sx[j] + wj + 4 && sx[j] < sx[i] + wi + 4;
        const overlapY = Math.abs(sy[i] - sy[j]) < LABEL_H + 2;
        if (overlapX && overlapY) { rejected = true; break; }
      }
      if (rejected) alpha[i] = 0;
      else placedIdx[placed++] = i;
    }

    for (let i = 0; i < n; i++) order[i].label.setOpacity(alpha[i]);
  }

  /** @param {boolean} on */
  function setVisible(on) {
    visible = on;
    for (let i = 0; i < n; i++) order[i].label.object.visible = on;
  }

  /** @param {string|null} id */
  function setSelected(id) {
    selectedId = id;
    for (let i = 0; i < n; i++) order[i].label.setSelected(order[i].id === id);
    acc = LAYOUT_PERIOD_S; // re-layout on the next call
  }

  function dispose() {
    for (let i = 0; i < n; i++) order[i].label.dispose();
  }

  return { layout, setVisible, setSelected, dispose };
}
