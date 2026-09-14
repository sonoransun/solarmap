// Events tab: notability slider (default 40) · kind chips · list around "now" (past rows dimmed with --muted, still
// ≥ 4.5:1) · Go to / View · Earlier / Later · footnote (verbatim from the plan).
import { h, setText, setAttr, getFormat } from './dom.js';

const YEAR_DAYS = 365.25;

/** Chip groups: a chip matches an event when its kind (or label) matches the regex. */
export const KIND_CHIPS = Object.freeze([
  { id: 'opposition', label: 'Oppositions', re: /opposition/i },
  { id: 'conjunction', label: 'Conjunctions', re: /conjunction/i },
  { id: 'elongation', label: 'Elongations', re: /elongation/i },
  { id: 'pair', label: 'Planet pairs', re: /pair|planet-planet|planetPair|separation/i },
  { id: 'approach', label: 'Closest approaches', re: /closest|approach/i },
  { id: 'apsis', label: 'Apsides', re: /perihelion|aphelion|apsis|apside/i },
  { id: 'parade', label: 'Parades', re: /parade|alignment/i },
  { id: 'transit', label: 'Transits', re: /transit/i },
  { id: 'stationary', label: 'Stationary', re: /stationary|retrograde/i },
]);

/** Footnote, verbatim from the plan (§UI specification). */
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
  const sliderVal = h('span', { class: 'num', text: '40' });
  const slider = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '40', 'aria-label': 'Minimum notability score', 'aria-valuetext': '40' });
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
    class: 'chip', type: 'button', 'aria-pressed': 'true', text: c.label, title: `Show ${c.label.toLowerCase()}`,
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

  let page = 0; // window = now + page·2 y ± 1 y
  const btnEarlier = h('button', { class: 'btn sm', type: 'button', text: '← Earlier', 'aria-label': 'Earlier events (previous two years)', onclick: () => { page -= 1; listKey = ''; requestRender?.(); } });
  const btnLater = h('button', { class: 'btn sm', type: 'button', text: 'Later →', 'aria-label': 'Later events (next two years)', onclick: () => { page += 1; listKey = ''; requestRender?.(); } });
  const btnBack = h('button', { class: 'btn sm', type: 'button', text: 'Around now', 'aria-label': 'Back to events around the current date', onclick: () => { page = 0; listKey = ''; requestRender?.(); } });
  const windowLabel = h('span', { class: 'num muted', text: '' });
  const progress = h('i');
  const progressBar = h('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Event scan progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progress);
  const statusText = h('span', { text: '' });
  const status = h('div', { class: 'status-line' }, statusText, progressBar);
  const list = h('ul', { class: 'list', 'aria-label': 'Events' });
  const empty = h('p', { class: 'empty', text: 'No events in this window at the current notability filter.' });
  const nowMarker = h('li', { class: 'now-marker', 'aria-label': 'Now', text: 'NOW' });

  el.replaceChildren(
    h('div', { class: 'field-col' },
      h('div', { class: 'field', style: { minHeight: '0' } }, h('span', { class: 'lab', text: 'Notability ≥ ' }, sliderVal), h('span', { class: 'faint', text: 'score 0–100' })),
      slider),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Event kinds' }, chips),
    h('div', { class: 'sorters' }, windowLabel, btnBack),
    status,
    list,
    empty,
    h('div', { class: 'pager' }, btnEarlier, btnLater),
    h('p', { class: 'footnote', text: EVENTS_FOOTNOTE }),
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
    const badge = h('span', { class: `score${score >= 80 ? ' hi' : score >= 60 ? ' mid' : ''}`, text: String(score), title: `Notability ${score} of 100`, 'aria-label': `notability ${score}` });
    const jd = ev.jdUtc ?? ev.jdTT;
    const lab = ev.label || String(ev.kind || 'event');
    const btnGo = h('button', { class: 'btn sm', type: 'button', text: 'Go to', 'aria-label': `Go to ${lab} (set the time)`, onclick: () => actions.goToEvent?.(ev) });
    const btnView = h('button', { class: 'btn sm primary', type: 'button', text: 'View', 'aria-label': `View ${lab} (frame the camera and set the time)`, onclick: () => actions.viewEvent?.(ev) });
    const li = h('li', { class: 'row row-event', dataset: { id: String(ev.id ?? '') } },
      h('div', null,
        h('div', { class: 'when', text: f.utc(jd) }),
        h('div', { class: 'lab' }, lab, badge, ev.observable === false ? h('span', { class: 'faint', text: ' · near the Sun' }) : null)),
      h('div', { class: 'actions' }, btnGo, btnView));
    return li;
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    const minScore = s.settings?.eventMinScore ?? 40;
    if (!sliderFocused && +slider.value !== minScore) { slider.value = String(minScore); setText(sliderVal, String(minScore)); setAttr(slider, 'aria-valuetext', `${minScore} of 100`); }

    // Scan status.
    const scanning = s.eventsStatus === 'scanning';
    progressBar.hidden = !scanning;
    if (scanning) { progress.style.width = `${Math.round((s.eventsProgress || 0) * 100)}%`; setAttr(progressBar, 'aria-valuenow', String(Math.round((s.eventsProgress || 0) * 100))); }
    setText(statusText, scanning ? 'Scanning…' : s.eventsStatus === 'idle' ? (providers ? 'Idle' : 'Loading ephemeris…') : '');
    status.hidden = !scanning && s.eventsStatus !== 'idle';

    // Window.
    const center = s.jdUtc + page * 2 * YEAR_DAYS;
    const jd0 = center - YEAR_DAYS; const jd1 = center + YEAR_DAYS;
    const dateOnly = (jd) => { const m = /^(-?\d{4})-(\d{2})-(\d{2})/.exec(f.utc(jd)); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
    setText(windowLabel, `${dateOnly(jd0)} → ${dateOnly(jd1)}`);
    btnBack.hidden = page === 0;

    // The list is rebuilt when its content changes (or every 2 s while scanning); "now" only moves the marker.
    const now = Date.now();
    const key = `${page}|${Math.floor(center / 30)}|${minScore}|${[...enabled].join(',')}|${s.eventsStatus}|${Math.round((s.eventsProgress || 0) * 10)}`;
    if (key !== listKey || (scanning && now - lastRender > 2000)) {
      listKey = key; lastRender = now;
      let events = [];
      try { events = providers?.events?.({ jd0, jd1, minScore }) || []; } catch { events = []; }
      if (!Array.isArray(events)) events = [];
      events = events
        .filter((ev) => Number.isFinite(ev?.jdUtc ?? ev?.jdTT) && (ev.score ?? 0) >= minScore)
        .filter((ev) => { const c = chipOf(ev); return c === 'other' || enabled.has(c); })
        .filter((ev) => { const jd = ev.jdUtc ?? ev.jdTT; return jd >= jd0 && jd <= jd1; })
        .sort((a, b) => (a.jdUtc ?? a.jdTT) - (b.jdUtc ?? b.jdTT));
      const sig = events.map((ev) => `${ev.id ?? ''}@${(ev.jdUtc ?? ev.jdTT).toFixed(4)}`).join(';');
      if (sig !== list.dataset.sig) {
        list.dataset.sig = sig;
        rendered = events.map((ev) => ({ ev, li: buildRow(ev, providers, f), jd: ev.jdUtc ?? ev.jdTT }));
        list.replaceChildren(...rendered.map((r) => r.li));
      }
      empty.hidden = rendered.length > 0;
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
