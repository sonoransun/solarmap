// Tiny DOM helpers shared by the UI modules (no framework). Also the defensive format shim: providers may be null
// while the data module loads, so every formatter falls back to the pure astro/format.js implementation.
import {
  formatUtc, formatJd, formatDeltaT, formatDistance, formatAu, formatKm, formatLightTime, formatSpeed, formatDeg,
  formatKmPerS, formatLonLat, formatPeriod, formatRate, formatAngle, SEP as FORMAT_SEP,
} from '../astro/format.js';

/** ' · ' separator of composite strings (astro/format.js). */
export const SEP = FORMAT_SEP;

/**
 * Create an element. attrs: class, text, html, dataset, style (object), on<event> handlers, boolean/string attributes.
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...(Node|string|number|null|false|undefined|Array)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/**
 * Append children (nested arrays, strings, numbers; null/false skipped).
 * @param {Node} el
 * @param {any[]} children
 */
export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(typeof c === 'object' && 'nodeType' in c ? c : document.createTextNode(String(c)));
  }
}

/**
 * SVG icon from a path string (24×24 viewBox, stroked with currentColor via .icon-btn CSS).
 * @param {string} paths inner SVG markup (path/circle/line elements)
 * @returns {SVGElement}
 */
export function svg(paths) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.innerHTML = paths;
  return el;
}

/**
 * Set textContent only when it changed (avoids layout churn at 10 Hz).
 * @param {Node} el
 * @param {string} s
 */
export function setText(el, s) {
  if (el.textContent !== s) el.textContent = s;
}

/**
 * Toggle an attribute value only when it changed.
 * @param {Element} el
 * @param {string} name
 * @param {string|boolean|null} value  null/false removes; true → ''
 */
export function setAttr(el, name, value) {
  if (value == null || value === false) { if (el.hasAttribute(name)) el.removeAttribute(name); return; }
  const v = value === true ? '' : String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/**
 * Body colour (hex number or CSS string) → CSS colour string.
 * @param {number|string|undefined} c
 * @returns {string}
 */
export function cssColour(c) {
  if (typeof c === 'number') return `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  return c || '#8B93A7';
}

/** Fallback body colours (plan §Palette), used only when providers.bodyColour is absent. */
export const BODY_COLOURS = Object.freeze({
  sun: 0xFFD27D, mercury: 0xB5B2AD, venus: 0xE8CDA0, earth: 0x6B93D6, mars: 0xC1440E,
  jupiter: 0xD8A96B, saturn: 0xE3D6A8, uranus: 0x9AD6DE, neptune: 0x4C6EF5,
});

/** Body ids in the canonical order (keys 0…8). */
export const BODY_IDS = Object.freeze(['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

/** Fallback display names. */
export const BODY_NAMES = Object.freeze({
  sun: 'Sun', mercury: 'Mercury', venus: 'Venus', earth: 'Earth', mars: 'Mars',
  jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune',
});

const FALLBACK_FORMAT = Object.freeze({
  utc: formatUtc,
  jd: formatJd,
  deltaT: formatDeltaT,
  distance: formatDistance,
  au: formatAu,
  km: formatKm,
  lightTime: formatLightTime,
  speed: formatSpeed,
  deg: formatDeg,
  kmPerS: formatKmPerS,
  lonLat: formatLonLat,
  period: formatPeriod,
  rate: formatRate,
  angle: formatAngle,
});

/**
 * Formatting functions: providers.format when present, astro/format.js otherwise (per key).
 * @param {object|null|undefined} providers
 * @returns {typeof FALLBACK_FORMAT}
 */
export function getFormat(providers) {
  const f = providers?.format;
  if (!f) return FALLBACK_FORMAT;
  return { ...FALLBACK_FORMAT, ...f };
}

/**
 * Display name of a body (providers first).
 * @param {object|null|undefined} providers
 * @param {string} id
 * @returns {string}
 */
export function bodyName(providers, id) {
  try { const n = providers?.bodyName?.(id); if (n) return n; } catch { /* provider not ready */ }
  return BODY_NAMES[id] || id;
}

/**
 * CSS colour of a body (providers first).
 * @param {object|null|undefined} providers
 * @param {string} id
 * @returns {string}
 */
export function bodyColour(providers, id) {
  try { const c = providers?.bodyColour?.(id); if (c != null) return cssColour(c); } catch { /* not ready */ }
  return cssColour(BODY_COLOURS[id]);
}

/**
 * Body ids (providers first).
 * @param {object|null|undefined} providers
 * @returns {string[]}
 */
export function bodyIds(providers) {
  const ids = providers?.bodyIds;
  if (Array.isArray(ids) && ids.length) return ids;
  if (typeof ids === 'function') { try { const r = ids(); if (Array.isArray(r) && r.length) return r; } catch { /* ignore */ } }
  return BODY_IDS;
}

/**
 * True when the keyboard event originates in an editable control (shortcuts must not fire).
 * @param {Event} e
 * @returns {boolean}
 */
export function isTypingTarget(e) {
  const t = /** @type {HTMLElement|null} */ (e.target);
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = /** @type {HTMLInputElement} */ (t).type;
    return type !== 'button' && type !== 'checkbox' && type !== 'radio' && type !== 'submit';
  }
  return t.isContentEditable;
}

/**
 * Reduced-motion decision: Settings override (on/off) else the media query.
 * @param {'auto'|'on'|'off'|undefined} setting
 * @returns {boolean}
 */
export function reducedMotion(setting) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

/**
 * Format a number with a fixed number of decimals, or '—' when not finite.
 * @param {number} x
 * @param {number} n
 * @returns {string}
 */
export function fixed(x, n) {
  return Number.isFinite(x) ? x.toFixed(n) : '—';
}

/**
 * Keep Tab focus inside a dialog element.
 * @param {HTMLElement} dialog
 * @param {KeyboardEvent} e
 */
export function trapFocusIn(dialog, e) {
  const focusables = dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = /** @type {HTMLElement} */ (focusables[0]);
  const last = /** @type {HTMLElement} */ (focusables[focusables.length - 1]);
  if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
