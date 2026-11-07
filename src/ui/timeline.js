// Bottom timeline: ⏮ ⏯ ⏭ · date input (+ year stepper outside 1…9999) · Now · Next event · rate buttons with
// readable labels (Real time · 1 hour/s … 10 years/s; short forms on narrow widths) · direction button (⏩ / ⏪) ·
// ±1-year scrub bar with clickable event ticks (jump) and a tooltip · wheel ±1 d / Shift ±30 d. Dragging the scrub
// bar pauses the clock and resumes it on release, so the thumb never fights a running clock. The year stepper steps
// calendar years (same day and time next year), not 365.25 d.
import { h, svg, setText, setAttr, getFormat } from './dom.js';
import { jdFromGregorian, YEAR_LIMITS } from '../astro/clock.js';
import { calendarFromJd } from '../astro/format.js';
import { RATE_WORDS, presetIndex, nearestPresetIndex, addCalendarYears, humanDay, humanDate, BEST_MIN_SCORE } from './copy.js';

/** Rate presets in timeline order (copy.js RATE_WORDS; days = astro/clock.js RATES). Kept under the old name for shortcuts.js. */
export const RATE_PRESETS = RATE_WORDS;
/** Index of the preset nearest to |rate| (log scale). */
export const nearestRateIndex = nearestPresetIndex;

const YEAR_DAYS = 365.25;
const ICON_PLAY = '<path d="M7 4.5v15l12-7.5z"/>';
const ICON_PAUSE = '<path d="M7 5v14M17 5v14"/>';
const ICON_PREV = '<path d="M17 5v14L7 12z"/><path d="M5 5v14"/>';
const ICON_NEXT = '<path d="M7 5v14l10-7z"/><path d="M19 5v14"/>';
/** ⏩ / ⏪ as strokes (double chevrons). */
const ICON_FWD = '<path d="M5 6l6 6-6 6M13 6l6 6-6 6"/>';
const ICON_BACK = '<path d="M19 6l-6 6 6 6M11 6l-6 6 6 6"/>';

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
 * @param {object} opts.actions  { play, pause, toggle, setRate, setJd, now, step, stepYears?, goToEvent, viewEvent }
 * @param {() => object|null} opts.getProviders
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createTimeline({ el, actions, getProviders, getState }) {
  el.classList.add('glass');
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Time controls');

  /** Calendar-year step: main.js's actions.stepYears when wired, else the same arithmetic locally. */
  const stepYears = (n) => {
    if (typeof actions.stepYears === 'function') actions.stepYears(n);
    else actions.setJd?.(addCalendarYears(getState().jdUtc, n));
  };

  // --- transport
  const btnPrev = h('button', { class: 'icon-btn optional', type: 'button', 'aria-label': 'Back one day (Shift: one week)', 'data-tip': 'Back 1 day · Shift: 1 week',
    onclick: (e) => actions.step?.(e.shiftKey ? -7 : -1) }, svg(ICON_PREV));
  const btnPlay = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pause', 'aria-keyshortcuts': 'Space', 'data-tip': 'Play / pause (Space)',
    onclick: () => actions.toggle?.() }, svg(ICON_PAUSE));
  const btnNext = h('button', { class: 'icon-btn optional', type: 'button', 'aria-label': 'Forward one day (Shift: one week)', 'data-tip': 'Forward 1 day · Shift: 1 week',
    onclick: (e) => actions.step?.(e.shiftKey ? 7 : 1) }, svg(ICON_NEXT));
  const transport = h('div', { class: 'tl-transport' }, btnPrev, btnPlay, btnNext);

  // --- date
  const dateInput = h('input', { class: 'input', type: 'datetime-local', step: '1', 'aria-label': 'Date and time (UTC)', min: '0001-01-01T00:00:00', max: '9999-12-31T23:59:59' });
  const yearInput = h('input', { class: 'input', type: 'number', step: '1', min: String(YEAR_LIMITS.min), max: String(YEAR_LIMITS.max), 'aria-label': 'Year (astronomical numbering: 0 is 1 BC; the date box covers years 1 to 9999 only)' });
  const yearDown = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous year (same day and time)', 'data-tip': 'One calendar year earlier', onclick: () => stepYears(-1) }, svg('<path d="M15 6l-6 6 6 6"/>'));
  const yearUp = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next year (same day and time)', 'data-tip': 'One calendar year later', onclick: () => stepYears(1) }, svg('<path d="M9 6l6 6-6 6"/>'));
  const yearBox = h('div', { class: 'tl-year' }, yearDown, yearInput, yearUp);
  yearBox.hidden = true;
  const btnNow = h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Jump to the present moment', 'aria-keyshortcuts': 'T', 'data-tip': 'Back to now (T)', text: 'Now', onclick: () => actions.now?.() });
  let nextEv = null;
  const btnNextEvent = h('button', { class: 'btn sm optional tl-next', type: 'button', text: 'Next event', 'data-tip': 'Jump to the next notable event',
    onclick: () => { if (nextEv) actions.viewEvent?.(nextEv); } });
  btnNextEvent.disabled = true;
  const dateBox = h('div', { class: 'tl-date' }, dateInput, yearBox, btnNow, btnNextEvent);

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
    type: 'button', 'aria-pressed': 'false', 'aria-label': p.aria, 'data-tip': p.aria,
    onclick: () => { const s = getState(); actions.setRate?.((s.rate < 0 ? -1 : 1) * RATE_PRESETS[i].days); },
  }, h('span', { class: 'long', text: p.label }), h('span', { class: 'short', text: p.short })));
  const seg = h('div', { class: 'seg compact tl-rates', role: 'group', 'aria-label': 'Time speed' }, rateButtons);
  const btnDir = h('button', { class: 'icon-btn tl-dir', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Time runs forward. Switch to backward',
    onclick: () => { const s = getState(); const r = s.rate === 0 ? 1 : s.rate; actions.setRate?.(-r); } }, svg(ICON_FWD));
  const rateBox = h('div', { class: 'tl-rate' }, seg, btnDir);

  // --- scrub
  const range = h('input', { type: 'range', min: String(-YEAR_DAYS), max: String(YEAR_DAYS), step: '0.01', value: '0', 'aria-label': 'Scrub through time, one year either side of the current date', 'aria-valuetext': '' });
  const ticks = h('div', { class: 'tl-ticks', role: 'group', 'aria-label': 'Events on the scrub bar' });
  const scaleL = h('span', { text: '' });
  const scaleR = h('span', { text: '' });
  const scale = h('div', { class: 'scale', 'aria-hidden': 'true' }, scaleL, scaleR);
  const scrub = h('div', { class: 'tl-scrub' }, range, ticks, scale);

  let center = getState().jdUtc;
  let dragging = false;
  let resumeAfterDrag = false;
  let ticksKey = '';
  let ticksAt = 0;

  // Pause while dragging, resume on release: the scrubber must not fight the running clock.
  range.addEventListener('pointerdown', () => {
    dragging = true;
    if (getState().playing) { resumeAfterDrag = true; actions.pause?.(); }
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (resumeAfterDrag) { resumeAfterDrag = false; actions.play?.(); }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  range.addEventListener('input', () => { actions.setJd?.(center + parseFloat(range.value)); });
  range.addEventListener('change', endDrag);
  range.addEventListener('keydown', (e) => {
    let d = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = 1;
    else if (e.key === 'PageDown') d = -30;
    else if (e.key === 'PageUp') d = 30;
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); actions.setJd?.(center - YEAR_DAYS); return; }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); actions.setJd?.(center + YEAR_DAYS); return; }
    else { return; } // every other key keeps its global meaning (Space, Esc, letters)
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
   * Event ticks: clickable (jump to the event) with a tooltip; colour and height by notability.
   * @param {object|null} providers
   * @param {import('../app/state.js').AppState} s
   */
  function renderTicks(providers, s) {
    const minScore = Math.max(s.settings?.eventMinScore ?? 40, s.settings?.scientistMode ? 0 : 40);
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
      const cls = score >= 80 ? 'tick hi' : score >= BEST_MIN_SCORE ? 'tick mid' : 'tick';
      const hPct = 35 + Math.round(65 * Math.max(0, Math.min(1, (score - 30) / 70)));
      const label = ev.label || ev.kind;
      frag.append(h('button', {
        class: cls, type: 'button', tabindex: '-1',
        style: { left: `${(x * 100).toFixed(2)}%`, '--h': `${hPct}%` },
        'aria-label': `${label}, ${humanDate(jd, { short: true })}. Jump there`,
        'data-tip': `${label} · ${humanDay(jd, { short: true })}`,
        onclick: () => actions.goToEvent?.(ev),
      }));
      if (++n > 400) break;
    }
    ticks.replaceChildren(frag);
  }

  let nextKey = '';
  /** Next Best-tier event after the clock (refreshed when the day or the scan state changes). */
  function refreshNext(providers, s) {
    const key = `${Math.floor(s.jdUtc)}|${s.eventsStatus}|${Math.round((s.eventsProgress || 0) * 10)}`;
    if (key === nextKey) return;
    nextKey = key;
    nextEv = null;
    try {
      const ahead = providers?.events?.({ jd0: s.jdUtc, jd1: s.jdUtc + 4 * YEAR_DAYS, minScore: BEST_MIN_SCORE }) || [];
      if (Array.isArray(ahead)) nextEv = ahead.filter((ev) => (ev.jdUtc ?? ev.jdTT) > s.jdUtc && (ev.score ?? 0) >= BEST_MIN_SCORE).sort((a, b) => (a.jdUtc ?? a.jdTT) - (b.jdUtc ?? b.jdTT))[0] ?? null;
    } catch { nextEv = null; }
    btnNextEvent.disabled = !nextEv;
    setAttr(btnNextEvent, 'aria-label', nextEv ? `Next notable event: ${nextEv.label || nextEv.kind}, ${humanDate(nextEv.jdUtc ?? nextEv.jdTT, { short: true })}` : 'Next notable event (none found yet)');
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
      if (v == null) { dateInput.value = ''; dateInput.disabled = true; setAttr(dateInput, 'data-tip', 'Years outside 1…9999: use the year stepper'); }
      else { dateInput.disabled = false; if (dateInput.value !== v) dateInput.value = v; setAttr(dateInput, 'data-tip', 'Date and time, UTC'); }
    }
    const outOfRange = v == null;
    if (yearBox.hidden === outOfRange) yearBox.hidden = !outOfRange;
    if (outOfRange && !yearFocused) {
      const y = calendarFromJd(s.jdUtc, true)[0];
      if (+yearInput.value !== y) yearInput.value = String(y);
    }

    // Rate and direction.
    const pi = presetIndex(s.rate);
    for (let i = 0; i < rateButtons.length; i++) setAttr(rateButtons[i], 'aria-pressed', pi === i ? 'true' : 'false');
    const back = s.rate < 0;
    setAttr(btnDir, 'aria-pressed', back ? 'true' : 'false');
    const dirLabel = back ? 'Time runs backward. Switch to forward' : 'Time runs forward. Switch to backward';
    if (btnDir.getAttribute('aria-label') !== dirLabel) {
      setAttr(btnDir, 'aria-label', dirLabel);
      setAttr(btnDir, 'data-tip', dirLabel);
      btnDir.replaceChildren(svg(back ? ICON_BACK : ICON_FWD));
    }

    // Scrub: recentre when the time leaves the ±1 y window (not mid-drag).
    if (!dragging && Math.abs(s.jdUtc - center) > YEAR_DAYS) center = s.jdUtc;
    if (!dragging) {
      const val = (s.jdUtc - center).toFixed(2);
      if (range.value !== val) range.value = val;
    }
    setAttr(range, 'aria-valuetext', f.utc(s.jdUtc));
    setText(scaleL, humanDay(center - YEAR_DAYS, { short: true }));
    setText(scaleR, humanDay(center + YEAR_DAYS, { short: true }));
    renderTicks(providers, s);
    refreshNext(providers, s);
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
