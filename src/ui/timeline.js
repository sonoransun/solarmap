// Bottom timeline: ⏮ ⏯ ⏭ · datetime-local input (+ numeric year stepper outside 1…9999) + Now · rate segmented
// control RT·1h·1d·1w·1mo·1y·10y · ± direction · ±1-year scrub <input type=range> with aria-valuetext and event ticks
// (colour + height by score, critique byf0bzyiw §aria) · wheel ±1 d / Shift ±30 d.
import { h, svg, setText, setAttr, getFormat } from './dom.js';
import { jdFromGregorian, YEAR_LIMITS } from '../astro/clock.js';
import { calendarFromJd } from '../astro/format.js';

/** Rate presets in timeline order, sim days per real second (plan §UI; astro/clock.js RATES). */
export const RATE_PRESETS = Object.freeze([
  { key: 'realtime', label: 'RT', title: 'Real time', days: 1 / 86400 },
  { key: 'hour', label: '1h', title: '1 hour per second', days: 1 / 24 },
  { key: 'day', label: '1d', title: '1 day per second', days: 1 },
  { key: 'week', label: '1w', title: '1 week per second', days: 7 },
  { key: 'month', label: '1mo', title: '1 mean month (30.436875 d) per second', days: 30.436875 },
  { key: 'year', label: '1y', title: '1 Julian year per second', days: 365.25 },
  { key: 'decade', label: '10y', title: '10 Julian years per second', days: 3652.5 },
]);

const YEAR_DAYS = 365.25;
const ICON_PLAY = '<path d="M7 4.5v15l12-7.5z"/>';
const ICON_PAUSE = '<path d="M7 5v14M17 5v14"/>';
const ICON_PREV = '<path d="M17 5v14L7 12z"/><path d="M5 5v14"/>';
const ICON_NEXT = '<path d="M7 5v14l10-7z"/><path d="M19 5v14"/>';

/**
 * Index of the preset nearest to |rate| (log scale).
 * @param {number} rate signed days per second
 * @returns {number}
 */
export function nearestRateIndex(rate) {
  const r = Math.abs(rate) || 1;
  let best = 0; let bestD = Infinity;
  for (let i = 0; i < RATE_PRESETS.length; i++) {
    const d = Math.abs(Math.log(r / RATE_PRESETS[i].days));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * True when |rate| equals a preset within 0.5 % (for aria-pressed).
 * @param {number} rate
 * @param {number} i preset index
 */
function isPreset(rate, i) {
  const r = Math.abs(rate);
  return r > 0 && Math.abs(Math.log(r / RATE_PRESETS[i].days)) < 0.005;
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 'YYYY-MM-DDThh:mm:ss' for a datetime-local input; null when the year is outside 1…9999 (input cannot hold it).
 * @param {number} jd
 * @returns {string|null}
 */
export function datetimeLocalValue(jd) {
  const c = calendarFromJd(jd, true);
  if (c[0] < 1 || c[0] > 9999) return null;
  return `${String(c[0]).padStart(4, '0')}-${pad2(c[1])}-${pad2(c[2])}T${pad2(c[3])}:${pad2(c[4])}:${pad2(c[5])}`;
}

/**
 * Parse a datetime-local value ('YYYY-MM-DDThh:mm[:ss]') into a JD(UTC); NaN when malformed.
 * @param {string} v
 * @returns {number}
 */
export function jdFromDatetimeLocal(v) {
  const m = /^(-?\d{1,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v || '');
  if (!m) return NaN;
  return jdFromGregorian(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el  #timeline
 * @param {object} opts.actions  { play, pause, toggle, setRate, setJd, now, step }
 * @param {() => object|null} opts.getProviders
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createTimeline({ el, actions, getProviders, getState }) {
  el.classList.add('glass');
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Timeline');

  // --- transport
  const btnPrev = h('button', { class: 'icon-btn optional', type: 'button', 'aria-label': 'Step back one day (Shift: one week)', title: 'Step back 1 day (Shift 7 d)',
    onclick: (e) => actions.step?.(e.shiftKey ? -7 : -1) }, svg(ICON_PREV));
  const btnPlay = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pause', 'aria-keyshortcuts': 'Space', title: 'Play / pause (Space)',
    onclick: () => actions.toggle?.() }, svg(ICON_PAUSE));
  const btnNext = h('button', { class: 'icon-btn optional', type: 'button', 'aria-label': 'Step forward one day (Shift: one week)', title: 'Step forward 1 day (Shift 7 d)',
    onclick: (e) => actions.step?.(e.shiftKey ? 7 : 1) }, svg(ICON_NEXT));
  const transport = h('div', { class: 'tl-transport' }, btnPrev, btnPlay, btnNext);

  // --- date
  const dateInput = h('input', { class: 'input', type: 'datetime-local', step: '1', 'aria-label': 'Date and time (UTC)', title: 'Date and time (UTC)', min: '0001-01-01T00:00:00', max: '9999-12-31T23:59:59' });
  const yearInput = h('input', { class: 'input', type: 'number', step: '1', min: String(YEAR_LIMITS.min), max: String(YEAR_LIMITS.max), 'aria-label': 'Year (astronomical numbering; the date input covers years 1 to 9999 only)', title: 'Year (astronomical numbering)' });
  const yearDown = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous year', title: '−1 year', onclick: () => actions.step?.(-YEAR_DAYS) }, svg('<path d="M15 6l-6 6 6 6"/>'));
  const yearUp = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next year', title: '+1 year', onclick: () => actions.step?.(YEAR_DAYS) }, svg('<path d="M9 6l6 6-6 6"/>'));
  const yearBox = h('div', { class: 'tl-year' }, yearDown, yearInput, yearUp);
  yearBox.hidden = true;
  const btnNow = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Jump to now', 'aria-keyshortcuts': 'T', title: 'Now (T)', text: 'Now', onclick: () => actions.now?.() });
  const dateBox = h('div', { class: 'tl-date' }, dateInput, yearBox, btnNow);

  let dateFocused = false;
  dateInput.addEventListener('focus', () => { dateFocused = true; });
  dateInput.addEventListener('blur', () => { dateFocused = false; });
  dateInput.addEventListener('change', () => {
    const jd = jdFromDatetimeLocal(dateInput.value);
    if (Number.isFinite(jd)) actions.setJd?.(jd);
  });
  dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dateInput.blur(); } e.stopPropagation(); });

  let yearFocused = false;
  yearInput.addEventListener('focus', () => { yearFocused = true; });
  yearInput.addEventListener('blur', () => { yearFocused = false; });
  yearInput.addEventListener('change', () => {
    const y = Math.round(+yearInput.value);
    if (!Number.isFinite(y)) return;
    const c = calendarFromJd(getState().jdUtc, true);
    const clamped = Math.max(YEAR_LIMITS.min, Math.min(YEAR_LIMITS.max, y));
    // Keep month/day/time; 29 Feb rolls into 1 March in non-leap years (jdFromGregorian is continuous in the day count).
    actions.setJd?.(jdFromGregorian(clamped, c[1], c[2], c[3], c[4], c[5]));
  });
  yearInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); yearInput.blur(); } e.stopPropagation(); });

  // --- rate
  const rateButtons = RATE_PRESETS.map((p, i) => h('button', {
    type: 'button', 'aria-pressed': 'false', 'aria-label': `${p.title} per second`, title: p.title, text: p.label,
    onclick: () => { const s = getState(); actions.setRate?.((s.rate < 0 ? -1 : 1) * RATE_PRESETS[i].days); },
  }));
  const seg = h('div', { class: 'seg compact', role: 'group', 'aria-label': 'Time rate' }, rateButtons);
  const btnDir = h('button', { class: 'btn sm tl-dir', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Reverse time direction', title: 'Time direction (forward / backward)', text: '+',
    onclick: () => { const s = getState(); const r = s.rate === 0 ? 1 : s.rate; actions.setRate?.(-r); } });
  const rateBox = h('div', { class: 'tl-rate' }, seg, btnDir);

  // --- scrub
  const range = h('input', { type: 'range', min: String(-YEAR_DAYS), max: String(YEAR_DAYS), step: '0.01', value: '0', 'aria-label': 'Scrub time (±1 year around the current date)', 'aria-valuetext': '' });
  const ticks = h('div', { class: 'tl-ticks', 'aria-hidden': 'true' });
  const scaleL = h('span', { text: '' });
  const scaleR = h('span', { text: '' });
  const scale = h('div', { class: 'scale', 'aria-hidden': 'true' }, scaleL, scaleR);
  const scrub = h('div', { class: 'tl-scrub' }, ticks, range, scale);

  let center = getState().jdUtc;
  let dragging = false;
  let ticksKey = '';
  let ticksAt = 0;

  range.addEventListener('pointerdown', () => { dragging = true; });
  const endDrag = () => { if (dragging) { dragging = false; } };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  range.addEventListener('input', () => { actions.setJd?.(center + parseFloat(range.value)); });
  range.addEventListener('change', () => { dragging = false; });
  range.addEventListener('keydown', (e) => {
    let d = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = 1;
    else if (e.key === 'PageDown') d = -30;
    else if (e.key === 'PageUp') d = 30;
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); actions.setJd?.(center - YEAR_DAYS); return; }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); actions.setJd?.(center + YEAR_DAYS); return; }
    else if (e.key === ' ' || e.key === 'Escape') { return; } // let the global shortcuts handle these
    else { e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey && Math.abs(d) === 1) d *= 30;
    actions.step?.(d);
  });
  const onWheel = (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 || e.deltaX > 0 ? 1 : -1;
    actions.step?.(dir * (e.shiftKey ? 30 : 1));
  };
  scrub.addEventListener('wheel', onWheel, { passive: false });

  el.replaceChildren(transport, dateBox, rateBox, scrub);

  /**
   * @param {object|null} providers
   * @param {import('../app/state.js').AppState} s
   */
  function renderTicks(providers, s) {
    const minScore = s.settings?.eventMinScore ?? 40;
    const key = `${center.toFixed(2)}|${minScore}|${s.eventsStatus}|${Math.round((s.eventsProgress || 0) * 20)}`;
    const now = Date.now();
    if (key === ticksKey && now - ticksAt < 5000) return;
    ticksKey = key; ticksAt = now;
    let events = [];
    try { events = providers?.events?.({ jd0: center - YEAR_DAYS, jd1: center + YEAR_DAYS, minScore }) || []; } catch { events = []; }
    if (!Array.isArray(events)) events = [];
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const ev of events) {
      const jd = ev?.jdUtc ?? ev?.jdTT;
      if (!Number.isFinite(jd) || (ev.score ?? 0) < minScore) continue;
      const x = (jd - center + YEAR_DAYS) / (2 * YEAR_DAYS);
      if (x < 0 || x > 1) continue;
      const score = ev.score ?? 0;
      const cls = score >= 80 ? 'tick hi' : score >= 60 ? 'tick mid' : 'tick';
      const hPct = 35 + Math.round(65 * Math.max(0, Math.min(1, (score - 30) / 70)));
      frag.append(h('i', { class: cls, style: { left: `${(x * 100).toFixed(2)}%`, height: `${hPct}%` }, title: ev.label || ev.kind }));
      if (++n > 400) break;
    }
    ticks.replaceChildren(frag);
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);

    // Transport.
    btnPlay.replaceChildren(svg(s.playing ? ICON_PAUSE : ICON_PLAY));
    setAttr(btnPlay, 'aria-label', s.playing ? 'Pause' : 'Play');

    // Date input (not while the user edits it).
    const v = datetimeLocalValue(s.jdUtc);
    if (!dateFocused) {
      if (v == null) { dateInput.value = ''; dateInput.disabled = true; dateInput.title = 'Years outside 1…9999: use the year stepper'; }
      else { dateInput.disabled = false; if (dateInput.value !== v) dateInput.value = v; dateInput.title = 'Date and time (UTC)'; }
    }
    const outOfRange = v == null;
    if (yearBox.hidden === outOfRange) yearBox.hidden = !outOfRange;
    if (outOfRange && !yearFocused) {
      const y = calendarFromJd(s.jdUtc, true)[0];
      if (+yearInput.value !== y) yearInput.value = String(y);
    }

    // Rate.
    for (let i = 0; i < rateButtons.length; i++) setAttr(rateButtons[i], 'aria-pressed', isPreset(s.rate, i) ? 'true' : 'false');
    const back = s.rate < 0;
    setAttr(btnDir, 'aria-pressed', back ? 'true' : 'false');
    setText(btnDir, back ? '−' : '+');
    setAttr(btnDir, 'title', back ? 'Time runs backward — click for forward' : 'Time runs forward — click for backward');

    // Scrub: recentre when the time leaves the ±1 y window (not mid-drag).
    if (!dragging && Math.abs(s.jdUtc - center) > YEAR_DAYS) center = s.jdUtc;
    if (!dragging) {
      const val = (s.jdUtc - center).toFixed(2);
      if (range.value !== val) range.value = val;
    }
    setAttr(range, 'aria-valuetext', f.utc(s.jdUtc));
    const dateOnly = (jd) => { const m = /^(-?\d{4})-(\d{2})-(\d{2})/.exec(f.utc(jd)); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
    setText(scaleL, dateOnly(center - YEAR_DAYS));
    setText(scaleR, dateOnly(center + YEAR_DAYS));
    renderTicks(providers, s);
  }

  return {
    update,
    dispose() {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      scrub.removeEventListener('wheel', onWheel);
      el.replaceChildren();
    },
  };
}
