// Events tab, lay first: presets (All · Best · Visible from Earth) instead of a raw score slider, a one-sentence
// "why it matters" under every row, an honest status for years the worker has not scanned ("Scanning 2031…",
// "Not scanned yet") instead of a false "No events", a "Next notable event" shortcut, Set time / Show me buttons,
// Earlier / Later paging and two footnotes (plain words; the plan's geometric-times note in scientist mode).
// Scientist mode adds the notability floor slider and the kind chips back.
import { h, setText, setAttr, getFormat } from './dom.js';
import { calendarFromJd } from '../astro/format.js';
import {
  EVENT_PRESETS, presetMatches, BEST_MIN_SCORE, whyItMatters, scanStatusText, emptyEventsText, EVENTS_LAY_FOOTNOTE,
  humanDate, humanDay,
} from './copy.js';

const YEAR_DAYS = 365.25;
/** How far ahead "Next notable event" looks (the worker prefetches ±2 years around the clock). */
const NEXT_LOOKAHEAD_D = 4 * YEAR_DAYS;

/** Chip groups (scientist mode): a chip matches an event when its kind (or label) matches the regex. */
export const KIND_CHIPS = Object.freeze([
  { id: 'opposition', label: 'Oppositions', re: /opposition/i },
  { id: 'conjunction', label: 'Conjunctions', re: /conjunction/i },
  { id: 'elongation', label: 'Elongations', re: /elongation/i },
  { id: 'pair', label: 'Planet pairs', re: /pair|planet-planet|planetPair|separation/i },
  { id: 'approach', label: 'Closest approaches', re: /closest|approach/i },
  { id: 'apsis', label: 'Apsides', re: /perihelion|aphelion|apsis|apside/i },
  { id: 'parade', label: 'Parades', re: /parade|alignment/i },
  { id: 'transit', label: 'Transits & eclipses', re: /transit|eclipse/i },
  { id: 'stationary', label: 'Stationary', re: /stationary|retrograde/i },
  { id: 'moon', label: 'Moon & seasons', re: /moon|equinox|solstice|season/i },
]);

/** Footnote, verbatim from the plan (§UI specification); shown in scientist mode. */
export const EVENTS_FOOTNOTE = 'Times are geometric (no light-time/aberration): oppositions and conjunctions differ from almanac apparent times by 6–40 min, greatest elongations by up to a few hours (the angle agrees to 0.002°)';

/**
 * Chip id of an event (first matching chip; 'other' when none).
 * @param {{ kind?: string, label?: string }} ev
 * @returns {string}
 */
export function chipOf(ev) {
  const k = String(ev?.kind ?? '');
  for (const c of KIND_CHIPS) if (c.re.test(k)) return c.id;
  const l = String(ev?.label ?? '');
  for (const c of KIND_CHIPS) if (c.re.test(l)) return c.id;
  return 'other';
}

/** @param {any} ev @returns {number} */
const jdOf = (ev) => ev?.jdUtc ?? ev?.jdTT;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el
 * @param {object} opts.actions  { goToEvent, viewEvent, setSettings }
 * @param {() => object|null} opts.getProviders
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @param {() => void} [opts.requestRender]  ask the UI for a re-render after a local (non-store) change
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createEventsTab({ el, actions, getProviders, getState, requestRender }) {
  // --- presets
  let preset = 'all';
  const presetButtons = EVENT_PRESETS.map((p) => h('button', {
    type: 'button', 'aria-pressed': p.id === preset ? 'true' : 'false', text: p.label, 'data-tip': p.hint,
    onclick: () => { preset = p.id; presetButtons.forEach((b, i) => setAttr(b, 'aria-pressed', EVENT_PRESETS[i].id === preset ? 'true' : 'false')); listKey = ''; requestRender?.(); },
  }));
  const presetSeg = h('div', { class: 'seg compact presets-seg', role: 'group', 'aria-label': 'Which events to list' }, presetButtons);

  // --- next notable event
  let nextEv = null;
  const btnNext = h('button', { class: 'btn sm', type: 'button', text: 'Next notable event', 'data-tip': 'Jump the clock and the camera to the next event worth seeing', onclick: () => { if (nextEv) actions.viewEvent?.(nextEv); } });
  btnNext.disabled = true;

  // --- scientist controls: notability floor + kind chips
  const sliderVal = h('span', { class: 'num', text: '40' });
  const slider = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '40', 'aria-label': 'Minimum notability score', 'aria-valuetext': '40 of 100' });
  slider.addEventListener('input', () => {
    setText(sliderVal, slider.value);
    setAttr(slider, 'aria-valuetext', `${slider.value} of 100`);
    actions.setSettings?.({ eventMinScore: +slider.value });
  });
  let sliderFocused = false;
  slider.addEventListener('pointerdown', () => { sliderFocused = true; });
  slider.addEventListener('focus', () => { sliderFocused = true; });
  slider.addEventListener('blur', () => { sliderFocused = false; });
  const onPointerUp = () => { if (document.activeElement !== slider) sliderFocused = false; };
  window.addEventListener('pointerup', onPointerUp);

  const enabled = new Set(KIND_CHIPS.map((c) => c.id));
  const chips = KIND_CHIPS.map((c) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': 'true', text: c.label, 'data-tip': `Show ${c.label.toLowerCase()} (Alt-click: only these)`,
    onclick: (e) => {
      // Alt-click isolates one kind; a second Alt-click restores all.
      if (e.altKey) {
        if (enabled.size === 1 && enabled.has(c.id)) KIND_CHIPS.forEach((k) => enabled.add(k.id));
        else { enabled.clear(); enabled.add(c.id); }
      } else if (enabled.has(c.id)) enabled.delete(c.id); else enabled.add(c.id);
      chips.forEach((b, i) => setAttr(b, 'aria-pressed', enabled.has(KIND_CHIPS[i].id) ? 'true' : 'false'));
      listKey = '';
      requestRender?.();
    },
  }));
  const sciControls = h('div', { class: 'sci-only' },
    h('div', { class: 'field-col' },
      h('div', { class: 'field', style: { minHeight: '0' } }, h('span', { class: 'lab', text: 'Notability floor ' }, sliderVal), h('span', { class: 'faint', text: 'score 0–100 (events.js notabilityScore)' })),
      slider),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Event kinds' }, chips));

  // --- window, status, list
  let page = 0; // window = now + page·2 y ± 1 y
  const btnEarlier = h('button', { class: 'btn sm', type: 'button', text: '← Earlier', 'aria-label': 'Earlier events (previous two years)', onclick: () => { page -= 1; listKey = ''; requestRender?.(); } });
  const btnLater = h('button', { class: 'btn sm', type: 'button', text: 'Later →', 'aria-label': 'Later events (next two years)', onclick: () => { page += 1; listKey = ''; requestRender?.(); } });
  const btnBack = h('button', { class: 'btn sm', type: 'button', text: 'Around now', 'aria-label': 'Back to events around the current date', onclick: () => { page = 0; listKey = ''; requestRender?.(); } });
  const windowLabel = h('span', { class: 'muted', text: '' });
  const progress = h('i');
  const progressBar = h('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Event scan progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progress);
  const statusText = h('span', { text: '' });
  const status = h('div', { class: 'status-line scan-state' }, statusText, progressBar);
  const list = h('ul', { class: 'list', 'aria-label': 'Events' });
  const empty = h('p', { class: 'empty', text: '' });
  const nowMarker = h('li', { class: 'now-marker', 'aria-label': 'Now', text: 'NOW' });
  const pager = h('div', { class: 'pager' }, btnEarlier, btnLater);

  el.replaceChildren(
    h('div', { class: 'sorters wrap' }, presetSeg, btnNext),
    sciControls,
    h('div', { class: 'sorters' }, windowLabel, btnBack),
    status,
    list,
    empty,
    pager,
    h('p', { class: 'footnote', text: EVENTS_LAY_FOOTNOTE }),
    h('p', { class: 'footnote sci-only', text: `${EVENTS_FOOTNOTE}. Stationary points and geocentric planet parades are experimental.` }),
  );

  /** @type {{ ev: any, li: HTMLElement, jd: number }[]} */
  let rendered = [];
  let listKey = '';
  let lastRender = 0;

  /**
   * @param {any} ev
   * @param {object|null} providers
   * @param {ReturnType<typeof getFormat>} f
   */
  function buildRow(ev, providers, f) {
    const score = Math.round(ev.score ?? 0);
    const tier = score >= 80 ? 'hi' : score >= BEST_MIN_SCORE ? 'mid' : '';
    const tierWord = tier === 'hi' ? 'Top pick' : tier === 'mid' ? 'Notable' : '';
    const badge = h('span', { class: `score ${tier}`.trim(), 'data-tip': `Notability ${score} of 100` },
      h('span', { class: 'lay-only', text: tierWord }), h('span', { class: 'sci-only', text: String(score) }));
    if (!tierWord) badge.classList.add('lay-hidden');
    const jd = jdOf(ev);
    const lab = ev.label || String(ev.kind || 'event');
    const nameOf = (id) => { try { return providers?.bodyName?.(id) || (id.charAt(0).toUpperCase() + id.slice(1)); } catch { return id; } };
    const why = whyItMatters(ev, nameOf);
    const btnGo = h('button', { class: 'btn sm', type: 'button', text: 'Set time', 'aria-label': `Set the clock to ${lab}`, onclick: () => actions.goToEvent?.(ev) });
    const btnView = h('button', { class: 'btn sm primary', type: 'button', text: 'Show me', 'aria-label': `Show ${lab}: set the clock and frame the camera`, onclick: () => actions.viewEvent?.(ev) });
    const li = h('li', { class: 'row row-event', dataset: { id: String(ev.id ?? '') } },
      h('div', { class: 'ev-main' },
        h('div', { class: 'when' }, h('span', { class: 'lay-only', text: humanDate(jd, { short: true }) }), h('span', { class: 'sci-only', text: f.utc(jd) })),
        h('div', { class: 'lab' }, lab, badge, ev.observable === false ? h('span', { class: 'faint', text: ' · lost in the Sun’s glare' }) : null),
        why ? h('div', { class: 'why', text: why }) : null),
      h('div', { class: 'actions' }, btnGo, btnView));
    return li;
  }

  /** Years touched by [jd0, jd1] that the worker has not cached yet (empty when the provider cannot say). */
  function missingYears(providers, jd0, jd1) {
    let scanned = null;
    try { scanned = providers?.scannedYears?.() ?? null; } catch { scanned = null; }
    if (!Array.isArray(scanned)) return [];
    const have = new Set(scanned);
    const y0 = calendarFromJd(jd0)[0]; const y1 = calendarFromJd(jd1)[0];
    const out = [];
    for (let y = y0; y <= y1; y++) if (!have.has(y)) out.push(y);
    return out;
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    const minScore = s.settings?.eventMinScore ?? 40;
    const scientist = !!s.settings?.scientistMode;
    if (!sliderFocused && +slider.value !== minScore) { slider.value = String(minScore); setText(sliderVal, String(minScore)); setAttr(slider, 'aria-valuetext', `${minScore} of 100`); }
    // In lay mode every preset applies the default floor (40) on top; the slider only exists in scientist mode.
    const floor = scientist ? minScore : Math.max(minScore, 40);

    // Window.
    const center = s.jdUtc + page * 2 * YEAR_DAYS;
    const jd0 = center - YEAR_DAYS; const jd1 = center + YEAR_DAYS;
    setText(windowLabel, `${humanDay(jd0, { short: true })} → ${humanDay(jd1, { short: true })}`);
    btnBack.hidden = page === 0;

    // Scan status (progress bar while scanning; words always honest about what is covered).
    const failed = s.eventsStatus === 'error';
    const scanning = s.eventsStatus === 'scanning';
    const missing = missingYears(providers, jd0, jd1);
    progressBar.hidden = !scanning;
    if (scanning) { const pct = Math.round((s.eventsProgress || 0) * 100); progress.style.width = `${pct}%`; setAttr(progressBar, 'aria-valuenow', String(pct)); }
    const statusWords = scanStatusText(s.eventsStatus, { missingYears: missing, providersReady: !!providers });
    setText(statusText, statusWords);
    status.hidden = !statusWords;
    list.hidden = pager.hidden = failed;
    btnNext.hidden = failed;

    // The list is rebuilt when its content changes (or every 2 s while scanning); "now" only moves the marker.
    const now = Date.now();
    const key = `${page}|${Math.floor(center / 30)}|${floor}|${preset}|${scientist ? [...enabled].join(',') : '*'}|${s.eventsStatus}|${Math.round((s.eventsProgress || 0) * 10)}|${missing.join(',')}`;
    if (key !== listKey || (scanning && now - lastRender > 2000)) {
      listKey = key; lastRender = now;
      let events = [];
      try { events = providers?.events?.({ jd0, jd1, minScore: floor }) || []; } catch { events = []; }
      if (!Array.isArray(events)) events = [];
      events = events
        .filter((ev) => Number.isFinite(jdOf(ev)) && presetMatches(preset, ev, floor))
        .filter((ev) => !scientist || (() => { const c = chipOf(ev); return c === 'other' || enabled.has(c); })())
        .filter((ev) => { const jd = jdOf(ev); return jd >= jd0 && jd <= jd1; })
        .sort((a, b) => jdOf(a) - jdOf(b));
      const sig = events.map((ev) => `${ev.id ?? ''}@${jdOf(ev).toFixed(4)}`).join(';');
      if (sig !== list.dataset.sig) {
        list.dataset.sig = sig;
        rendered = events.map((ev) => ({ ev, li: buildRow(ev, providers, f), jd: jdOf(ev) }));
        list.replaceChildren(...rendered.map((r) => r.li));
      }
      const showEmpty = !failed && rendered.length === 0 && !missing.length && !scanning && s.eventsStatus !== 'idle';
      empty.hidden = !showEmpty;
      if (showEmpty) setText(empty, emptyEventsText(preset));

      // Next notable event: the first Best-tier event after the clock.
      nextEv = null;
      try {
        const ahead = providers?.events?.({ jd0: s.jdUtc, jd1: s.jdUtc + NEXT_LOOKAHEAD_D, minScore: BEST_MIN_SCORE }) || [];
        if (Array.isArray(ahead)) nextEv = ahead.filter((ev) => jdOf(ev) > s.jdUtc && presetMatches('best', ev)).sort((a, b) => jdOf(a) - jdOf(b))[0] ?? null;
      } catch { nextEv = null; }
      btnNext.disabled = !nextEv;
      setAttr(btnNext, 'aria-label', nextEv ? `Next notable event: ${nextEv.label || nextEv.kind}, ${humanDate(jdOf(nextEv), { short: true })}` : 'Next notable event (none found yet)');
    }

    // Past / future and the NOW marker.
    let firstFuture = -1;
    for (let i = 0; i < rendered.length; i++) {
      const r = rendered[i];
      const past = r.jd < s.jdUtc;
      r.li.classList.toggle('past', past);
      r.li.classList.toggle('is-active', s.activeEventId != null && String(r.ev.id) === String(s.activeEventId));
      if (!past && firstFuture < 0) firstFuture = i;
    }
    if (page === 0 && rendered.length) {
      const anchor = firstFuture < 0 ? null : rendered[firstFuture].li;
      if (anchor) { if (nowMarker.nextSibling !== anchor) list.insertBefore(nowMarker, anchor); }
      else if (list.lastChild !== nowMarker) list.append(nowMarker);
    } else if (nowMarker.parentNode) nowMarker.remove();
  }

  return {
    update,
    dispose() { window.removeEventListener('pointerup', onPointerUp); rendered = []; el.replaceChildren(); },
  };
}
