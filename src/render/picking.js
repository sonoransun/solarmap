// Screen-space picking of the Sun + 8 planets (plan §Project layout "picking.js: screen-space pick (14 px mouse /
// 24 px touch; click vs drag 5 px)"; research bgcq10pmt §5.4). No raycaster: markers are constant pixel size, so the
// nearest projected body within max(tol, pxRadius) wins. OrbitControls shares the canvas and captures the pointer on
// pointerdown (r186 OrbitControls.js:1559), so pointerup always reaches the canvas; drags are filtered by the 5 px
// threshold instead of by state.

import { Vector3 } from 'three';

/** Click-vs-drag threshold in CSS px. */
const DRAG_PX = 5;
/** Pick tolerance in CSS px (research §5.4). */
const TOL_MOUSE_PX = 14;
const TOL_TOUCH_PX = 24;
/** Double-click detection (own logic so touch double-taps behave like mouse double-clicks). */
const DOUBLE_MS = 350;
const DOUBLE_PX = 12;

/**
 * @typedef {object} Picker
 * @property {() => void} update   refresh the cached canvas rectangle (call after a resize; also done lazily per click)
 * @property {(x: number, y: number, tolPx?: number) => string|null} pickAt  pick at canvas-relative CSS px coordinates
 * @property {() => void} dispose
 */

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {import('three').PerspectiveCamera} o.camera
 * @param {string[]} o.ids                                   body ids to test (Sun + planets)
 * @param {(id: string, out: Vector3) => (Vector3|ArrayLike<number>|void)} o.getWorldPosition  fills `out` (AU) or returns a vector/array
 * @param {(id: string) => number} o.getPxRadius             projected radius in CSS px (0 when hidden)
 * @param {(id: string|null) => void} o.onSelect             click (null on an empty click)
 * @param {(id: string) => void} o.onFly                     double-click / double-tap
 * @param {(id: string) => void} [o.onShiftSelect]           shift-click (distance beam partner)
 * @param {(id: string|null) => void} [o.onHover]            pointer moves over / off a body (mouse only)
 * @param {HTMLElement|null} [o.ignoreFocusWithin]           retained for API compatibility; only text-entry controls
 *        (input/textarea/select/contenteditable) suppress picking, wherever they live
 * @returns {Picker}
 */
export function createPicker({
  canvas, camera, ids, getWorldPosition, getPxRadius, onSelect, onFly, onShiftSelect = null, onHover = null,
  ignoreFocusWithin = null,
}) {
  const v = new Vector3();
  let rect = { left: 0, top: 0, width: 0, height: 0 };
  let rectValid = false;
  /** @type {{ id: number, x: number, y: number, type: string, button: number, shift: boolean, moved: boolean }|null} */
  let press = null;
  let lastClick = { id: null, t: -Infinity, x: 0, y: 0 };
  let hovered = null;
  let pointers = 0;

  function update() {
    rect = canvas.getBoundingClientRect();
    rectValid = true;
  }

  /** Project a body; returns false when it is behind the camera. Writes v.x/v.y as canvas CSS px. */
  function projectBody(id) {
    const r = getWorldPosition(id, v);
    if (r && r !== v) {
      if (r.isVector3) v.copy(r); else v.set(r[0], r[1], r[2]);
    }
    v.project(camera);
    if (!(v.z < 1) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return false;
    v.x = (v.x * 0.5 + 0.5) * rect.width;
    v.y = (-v.y * 0.5 + 0.5) * rect.height;
    return true;
  }

  /**
   * Nearest body whose projected centre lies within max(tol, pxRadius) of (x, y); ties resolved by the distance
   * normalised to each body's own hit radius (so a small marker beside a large disc still wins near its centre).
   * @param {number} x canvas-relative CSS px
   * @param {number} y
   * @param {number} [tolPx]
   * @returns {string|null}
   */
  function pickAt(x, y, tolPx = TOL_MOUSE_PX) {
    if (!rectValid) update();
    let best = null, bestScore = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!projectBody(id)) continue;
      const hit = Math.max(tolPx, getPxRadius(id) || 0);
      const d = Math.hypot(v.x - x, v.y - y);
      if (d > hit) continue;
      const score = d / hit;
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  function uiHasFocus() {
    if (typeof document === 'undefined') return false;
    const el = document.activeElement;
    if (!el || el === document.body || el === canvas) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
    // A *button* inside the panel keeps focus after it is pressed (tab buttons, Go to, Follow …). Blocking canvas
    // picks in that state would silently break clicking on planets after any panel interaction, so only
    // text-entry controls inside the panel suppress picking.
    return false;
  }

  const pt = { x: 0, y: 0 };
  /** Canvas-relative CSS px; `refresh` re-reads the bounding rect (one layout read per click, none per hover move). */
  function toCanvas(e, refresh) {
    if (refresh || !rectValid) update();
    pt.x = e.clientX - rect.left; pt.y = e.clientY - rect.top;
    return pt;
  }

  function onPointerDown(e) {
    pointers += 1;
    if (pointers > 1) { if (press) press.moved = true; return; } // pinch / second finger → not a click
    if (e.pointerType !== 'touch' && e.button !== 0) { press = null; return; }
    press = {
      id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button, shift: !!e.shiftKey,
      moved: false,
    };
  }

  function onPointerMove(e) {
    if (press && e.pointerId === press.id && !press.moved) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) press.moved = true;
    }
    if (onHover && e.pointerType !== 'touch' && !press) {
      const p = toCanvas(e, false);
      const id = pickAt(p.x, p.y, TOL_MOUSE_PX);
      if (id !== hovered) { hovered = id; onHover(id); }
    }
  }

  function onPointerUp(e) {
    pointers = Math.max(0, pointers - 1);
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (p.moved || pointers > 0) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_PX) return;
    if (uiHasFocus()) return;
    const c = toCanvas(e, true);
    const tol = p.type === 'touch' ? TOL_TOUCH_PX : TOL_MOUSE_PX;
    const id = pickAt(c.x, c.y, tol);
    const now = e.timeStamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (id && p.shift) {
      lastClick = { id: null, t: -Infinity, x: 0, y: 0 };
      if (onShiftSelect) onShiftSelect(id); else onSelect(id);
      return;
    }
    const isDouble = id && lastClick.id === id && now - lastClick.t < DOUBLE_MS
      && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < DOUBLE_PX;
    if (isDouble) {
      lastClick = { id: null, t: -Infinity, x: 0, y: 0 };
      onFly(id);
      return;
    }
    lastClick = { id, t: now, x: e.clientX, y: e.clientY };
    onSelect(id);
  }

  function onPointerCancel() {
    pointers = 0;
    press = null;
  }

  function onPointerLeave() {
    if (hovered !== null) { hovered = null; if (onHover) onHover(null); }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  if (typeof window !== 'undefined') window.addEventListener('resize', update);

  function dispose() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    if (typeof window !== 'undefined') window.removeEventListener('resize', update);
  }

  return { update, pickAt, dispose };
}
