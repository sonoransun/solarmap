// Deep links: pure encode/decode of the location hash (spec-contracts.md §Deep links). No DOM, no three.js: main.js
// applies a parsed link on boot and republishes the hash (history.replaceState) while the user interacts.
//
//   #t=2025-01-16T02:31:00Z&sel=mars&view=top|follow:mars|sky:earth>jupiter,saturn|free
//    &cam=x,y,z,tx,ty,tz&fov=1.2&rate=1&paused=1&k=50&tour=welcome:3&ev=opposition:mars:1294637171
//
// Parsing is tolerant: a missing '#', '&' or ';' separators, percent-encoded or literal '>' ('%3E' is what browsers
// serialise), unknown keys, malformed values and out-of-range numbers are all ignored key by key, so a hand-edited
// link still opens with whatever parts of it make sense.
import { calendarFromJd } from '../astro/format.js';
import { jdFromGregorian, DEFAULT_MIN_JD, DEFAULT_MAX_JD, RATES } from '../astro/clock.js';

/** Keys the hash may carry, in the order they are written. */
export const SHARE_KEYS = Object.freeze(['t', 'sel', 'view', 'cam', 'fov', 'rate', 'paused', 'k', 'tour', 'ev']);

/** Sky-view field of view accepted from a link, degrees (camera rig: min 0.25°, max 100°; a little slack on parse). */
export const FOV_LIMITS = Object.freeze({ min: 0.05, max: 120 });
/** Size exaggeration accepted from a link (settings slider 1…1000). */
export const SIZE_K_LIMITS = Object.freeze({ min: 1, max: 1000 });
/** |rate| accepted from a link, sim days per real second (10 y/s is the fastest preset; 1e5 leaves room for tours). */
export const RATE_LIMIT = 1e5;
/** |camera coordinate| accepted from a link, AU (the rig's free range ends at 5 000 AU). */
export const CAM_LIMIT_AU = 1e5;

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** @param {number} n @returns {string} */
function pad2(n) { return n < 10 ? `0${n}` : String(n); }

/**
 * 'YYYY-MM-DDThh:mm:ssZ' (UTC, rounded to the second); negative years as '-0500-…' (astronomical numbering).
 * @param {number} jdUtc
 * @returns {string}
 */
export function isoUtc(jdUtc) {
  const c = calendarFromJd(jdUtc, true);
  const y = c[0];
  const ys = (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0');
  return `${ys}-${pad2(c[1])}-${pad2(c[2])}T${pad2(c[3])}:${pad2(c[4])}:${pad2(c[5])}Z`;
}

/**
 * Parse an ISO-8601 UTC instant ('2025-01-16T02:31:00Z', '2025-01-16T02:31', '2025-01-16', fractional seconds and
 * '+'/'-' years allowed) or a bare Julian Date ('2460691.6'); NaN when malformed or impossible.
 * @param {string} s
 * @returns {number} JD(UTC)
 */
export function parseIsoUtc(s) {
  const str = String(s ?? '').trim();
  const m = /^([+-]?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*Z?$/i.exec(str);
  if (m) {
    const y = +m[1]; const mo = +m[2]; const d = +m[3];
    const hh = m[4] ? +m[4] : 0; const mi = m[5] ? +m[5] : 0; const ss = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss >= 61) return NaN;
    return jdFromGregorian(y, mo, d, hh, mi, ss);
  }
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n >= 1e5 && n <= 5e6) return n; // a Julian Date (the clock range is JD 260 089.5 … 3 182 395.5)
  }
  return NaN;
}

/**
 * Compact decimal with `sig` significant digits: 42 → '42', 9.4321 → '9.4321', 1e-7 → '1e-7'.
 * @param {number} x
 * @param {number} [sig=7]
 * @returns {string}
 */
export function compactNumber(x, sig = 7) {
  return String(Number(x.toPrecision(sig)));
}

/** @param {number} x @param {number} limit @returns {boolean} */
const within = (x, limit) => Number.isFinite(x) && Math.abs(x) <= limit;

/**
 * Accept [x,y,z], {x,y,z} (three.js Vector3) or null.
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null|undefined} v
 * @returns {number[]|null}
 */
function vec3(v) {
  if (!v) return null;
  const a = Array.isArray(v) || ArrayBuffer.isView(v) ? [Number(v[0]), Number(v[1]), Number(v[2])] : [Number(v.x), Number(v.y), Number(v.z)];
  return a.every((n) => within(n, CAM_LIMIT_AU)) ? a : null;
}

/**
 * Encode the share parameters of the current state as ordered [key, value] pairs.
 * @param {object} state  store state: jdUtc, selected, cameraMode, followed, flyby, sky, rate, playing, settings.sizeK, story, activeEventId
 * @param {{ position?: any, target?: any, fovDeg?: number, view?: 'top' }|null} [camera]  camera pose (scene frame, AU)
 * @returns {[string, string][]}
 */
export function buildShareParams(state, camera = null) {
  const s = state || {};
  /** @type {[string, string][]} */
  const out = [];
  if (Number.isFinite(s.jdUtc)) out.push(['t', isoUtc(s.jdUtc)]);
  if (typeof s.selected === 'string' && ID_RE.test(s.selected)) out.push(['sel', s.selected]);

  const mode = s.cameraMode;
  let view = 'free';
  if (camera?.view === 'top') view = 'top';
  else if (mode === 'follow' && s.followed) view = `follow:${s.followed}`;
  else if ((mode === 'flyby' || mode === 'tour') && s.flyby?.target) view = `follow:${s.flyby.target}`;
  else if (mode === 'skyView') {
    const from = s.sky?.from || 'earth';
    const to = Array.isArray(s.sky?.to) && s.sky.to.length ? s.sky.to : s.selected ? [s.selected] : [];
    if (to.length) view = `sky:${from}>${to.join(',')}`;
  }
  out.push(['view', view]);

  const pos = vec3(camera?.position);
  const tgt = vec3(camera?.target) || (pos ? [0, 0, 0] : null);
  if (pos && tgt) out.push(['cam', [...pos, ...tgt].map((n) => compactNumber(n, 8)).join(',')]);
  const fov = Number.isFinite(camera?.fovDeg) ? camera.fovDeg : s.sky?.fovDeg;
  if (view.startsWith('sky:') && Number.isFinite(fov)) out.push(['fov', compactNumber(fov, 5)]);

  if (Number.isFinite(s.rate) && s.rate !== 0) out.push(['rate', compactNumber(s.rate, 6)]);
  if (s.playing === false) out.push(['paused', '1']);
  const k = s.settings?.sizeK;
  if (Number.isFinite(k)) out.push(['k', compactNumber(k, 4)]);
  if (s.story && typeof s.story.tourId === 'string' && ID_RE.test(s.story.tourId)) {
    const i = Number.isInteger(s.story.index) && s.story.index >= 0 ? s.story.index : 0;
    out.push(['tour', `${s.story.tourId}:${i}`]);
  }
  if (typeof s.activeEventId === 'string' && s.activeEventId && s.activeEventId.length <= 120) out.push(['ev', s.activeEventId]);
  return out;
}

/** Percent-encode a value but keep ':', ',' and '>' readable (browsers re-encode '>' as %3E, which the parser accepts). */
function enc(v) {
  return encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2C/gi, ',').replace(/%3E/gi, '>');
}

/**
 * The hash string, with its leading '#'.
 * @param {object} state
 * @param {object|null} [camera]
 * @returns {string}
 */
export function buildShareHash(state, camera = null) {
  return `#${buildShareParams(state, camera).map(([k, v]) => `${k}=${enc(v)}`).join('&')}`;
}

/**
 * Full URL: `baseUrl` (defaults to the page's own location without its hash) + the share hash.
 * @param {object} state
 * @param {object|null} [camera]
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function buildShareUrl(state, camera = null, baseUrl = undefined) {
  let base = baseUrl;
  if (base == null) {
    try { base = globalThis.location?.href ?? ''; } catch { base = ''; }
  }
  const i = base.indexOf('#');
  return `${i >= 0 ? base.slice(0, i) : base}${buildShareHash(state, camera)}`;
}

/**
 * @typedef {object} ShareState
 * @property {number} [jdUtc]
 * @property {string} [selected]
 * @property {{ kind: 'top'|'free'|'follow'|'sky', id?: string, from?: string, to?: string[] }} [view]
 * @property {{ position: number[], target: number[] }} [camera]
 * @property {number} [fovDeg]
 * @property {number} [rate]
 * @property {boolean} [paused]
 * @property {number} [sizeK]
 * @property {{ id: string, index: number }} [tour]
 * @property {string} [eventId]
 */

/** @param {string} v @returns {string} */
function decode(v) {
  try { return decodeURIComponent(v.replace(/\+/g, '%20')); } catch { return v; }
}

/** Parse a named rate ('rt', 'day', '-week') or a number; NaN when neither. @param {string} v */
function parseRate(v) {
  const m = /^(-?)(rt|realtime|hour|day|week|month|year|decade)$/i.exec(v);
  if (m) { const key = m[2].toLowerCase() === 'rt' ? 'realtime' : m[2].toLowerCase(); return (m[1] ? -1 : 1) * RATES[key]; }
  const n = Number(v);
  return within(n, RATE_LIMIT) ? n : NaN;
}

/**
 * Parse a hash (with or without '#') into a ShareState; invalid parts are dropped, never thrown.
 * @param {string} hash
 * @returns {ShareState}
 */
export function parseShareHash(hash) {
  /** @type {ShareState} */
  const out = {};
  let str = String(hash ?? '').trim();
  if (str.startsWith('#')) str = str.slice(1);
  if (str.startsWith('?') || str.startsWith('/')) str = str.slice(1);
  if (!str) return out;
  for (const part of str.split(/[&;]/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = decode(part.slice(eq + 1).trim());
    switch (key) {
      case 't': {
        const jd = parseIsoUtc(raw);
        if (Number.isFinite(jd)) out.jdUtc = Math.min(DEFAULT_MAX_JD, Math.max(DEFAULT_MIN_JD, jd));
        break;
      }
      case 'sel': {
        const id = raw.toLowerCase();
        if (ID_RE.test(id)) out.selected = id;
        break;
      }
      case 'view': {
        const v = raw.toLowerCase();
        if (v === 'top' || v === 'free') out.view = { kind: v };
        else if (v === 'home') out.view = { kind: 'free' };
        else if (v.startsWith('follow:')) { const id = v.slice(7); if (ID_RE.test(id)) out.view = { kind: 'follow', id }; }
        else if (v.startsWith('sky:')) {
          const m = /^([a-z][a-z0-9_-]*)\s*(?:>|→|:)\s*(.+)$/.exec(v.slice(4));
          if (m) {
            const to = m[2].split(/[,+ ]/).map((t) => t.trim()).filter((t) => ID_RE.test(t));
            if (to.length) out.view = { kind: 'sky', from: m[1], to };
          }
        }
        break;
      }
      case 'cam': {
        const nums = raw.split(',').map((t) => Number(t.trim()));
        if ((nums.length === 6 || nums.length === 3) && nums.every((n) => within(n, CAM_LIMIT_AU))) {
          out.camera = { position: nums.slice(0, 3), target: nums.length === 6 ? nums.slice(3, 6) : [0, 0, 0] };
        }
        break;
      }
      case 'fov': {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= FOV_LIMITS.min && n <= FOV_LIMITS.max) out.fovDeg = n;
        break;
      }
      case 'rate': {
        const r = parseRate(raw);
        if (Number.isFinite(r)) out.rate = r;
        break;
      }
      case 'paused': {
        const v = raw.toLowerCase();
        if (v === '1' || v === 'true' || v === 'yes') out.paused = true;
        else if (v === '0' || v === 'false' || v === 'no') out.paused = false;
        break;
      }
      case 'k': {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= SIZE_K_LIMITS.min && n <= SIZE_K_LIMITS.max) out.sizeK = n;
        break;
      }
      case 'tour': {
        const m = /^([a-z][a-z0-9_-]*)(?::(\d{1,3}))?$/i.exec(raw);
        if (m) out.tour = { id: m[1].toLowerCase(), index: m[2] ? +m[2] : 0 };
        break;
      }
      case 'ev': {
        if (raw && raw.length <= 120 && !/[<>"'\s]/.test(raw)) out.eventId = raw;
        break;
      }
      default: break; // unknown keys are ignored
    }
  }
  return out;
}

/**
 * True when a hash carries at least one share key (so main.js can tell a deep link from an empty or foreign hash).
 * @param {string} hash
 * @returns {boolean}
 */
export function isShareHash(hash) {
  return Object.keys(parseShareHash(hash)).length > 0;
}
