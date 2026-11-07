// Top-left HUD, human first (spec-contracts.md §UI): line 1 "8 November 2026 · 18:19 UTC · 1 day per second"
// (paused: "… · paused"); line 2 the camera in words ("Following Saturn — 9.4 AU from the Sun"); the scientist line
// (JD · TT = UTC + ΔT · frame · ephemeris) only in scientist mode; badges: the size badge is a button that toggles
// true scale, "Before 1600 / after 2600: accuracy reduced", and the event-scan progress.
// aria-live="off": it re-renders at 10 Hz and must not spam screen readers (critique byf0bzyiw §aria).
import { h, setText, setAttr, bodyName, bodyInfo } from './dom.js';
import {
  humanDate, humanRate, scientistParts, cameraContextParts, sizeBadge, ACCURACY_BADGE, SEP,
} from './copy.js';

const ARC_R = 5.5;
const ARC_C = 2 * Math.PI * ARC_R;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el  #hud
 * @param {() => object|null} opts.getProviders
 * @param {object} [opts.actions]  { toggleSizeK }
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, beat: () => void, dispose: () => void }}
 */
export function createHud({ el, getProviders, actions = {} }) {
  el.setAttribute('aria-live', 'off');
  el.setAttribute('aria-label', 'Date, time speed and camera');
  el.classList.add('glass');

  // Line 1 — human. Long and short forms are both in the DOM; CSS picks one by viewport width.
  const tHumanLong = h('span', { class: 'hud-long', text: '—' });
  const tHumanShort = h('span', { class: 'hud-short', text: '—' });
  const line1 = h('div', { class: 'hud-line hud-human' }, tHumanLong, tHumanShort);

  // Line 2 — camera context (+ fly-by progress arc and the light-speed beat glyph).
  const arcFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arcFg.setAttribute('class', 'fg'); arcFg.setAttribute('cx', '7'); arcFg.setAttribute('cy', '7'); arcFg.setAttribute('r', String(ARC_R));
  arcFg.setAttribute('stroke-dasharray', String(ARC_C)); arcFg.setAttribute('stroke-dashoffset', String(ARC_C));
  arcFg.setAttribute('transform', 'rotate(-90 7 7)');
  const arcBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arcBg.setAttribute('class', 'bg'); arcBg.setAttribute('cx', '7'); arcBg.setAttribute('cy', '7'); arcBg.setAttribute('r', String(ARC_R));
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arc.setAttribute('class', 'hud-arc'); arc.setAttribute('viewBox', '0 0 14 14'); arc.setAttribute('aria-hidden', 'true');
  arc.append(arcBg, arcFg);
  arc.style.display = 'none';
  const tContext = h('span', { class: 'v', text: '' });
  const sepSpeed = h('span', { class: 'sep', text: '·' });
  const tSpeed = h('span', { class: 'hud-c', text: '' });
  const line2 = h('div', { class: 'hud-line hud-context secondary' }, arc, tContext, sepSpeed, tSpeed);

  // Scientist line.
  const sciSpans = [0, 1, 2, 3].map(() => h('span', { class: 'v', text: '' }));
  const line3 = h('div', { class: 'hud-line hud-sci' },
    sciSpans[0], h('span', { class: 'sep', text: '·' }), sciSpans[1], h('span', { class: 'sep', text: '·' }),
    sciSpans[2], h('span', { class: 'sep', text: '·' }), sciSpans[3]);
  line3.hidden = true;

  // Badges.
  const badgeSize = h('button', {
    class: 'badge solar badge-btn', type: 'button', text: '', 'aria-pressed': 'true', 'aria-keyshortcuts': 'P',
    'data-tip': 'Planets are drawn larger than life so you can see them from here. Key P toggles.',
    onclick: () => actions.toggleSizeK?.(),
  });
  const badgeAcc = h('span', { class: 'badge warn', text: ACCURACY_BADGE, 'data-tip': 'Positions are verified against JPL Horizons for 1600–2600; outside that band the planetary theory itself drifts (see Help › About).' });
  const badgeEvents = h('span', { class: 'badge accent', text: '' });
  const badges = h('div', { class: 'badges' }, badgeSize, badgeAcc, badgeEvents);
  badgeAcc.hidden = badgeEvents.hidden = true;

  el.replaceChildren(line1, line2, line3, badges);

  let beatTimer = 0;

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const nameOf = (id) => bodyName(providers, id);

    // Line 1.
    const rateWords = humanRate(s.rate, s.playing);
    setText(tHumanLong, `${humanDate(s.jdUtc)}${SEP}${rateWords}`);
    setText(tHumanShort, `${humanDate(s.jdUtc, { short: true })}${SEP}${humanRate(s.rate, s.playing, { short: true })}`);

    // Line 2.
    let cam = null;
    try { cam = providers?.cameraInfo?.() ?? null; } catch { cam = null; }
    const fly = s.flyby;
    const mode = s.cameraMode;
    const followedInfo = mode === 'follow' && s.followed ? bodyInfo(providers, s.followed) : null;
    const parts = cameraContextParts({
      mode,
      followed: s.followed,
      selected: s.selected,
      distAu: cam?.distAu,
      rSunAu: followedInfo?.rSunAu,
      earthDistAu: followedInfo?.earthDistAu,
      speedC: fly ? fly.speedC : cam?.speedC,
      skyFrom: s.sky?.from,
      skyTo: s.sky?.to,
      flybyTarget: fly?.target ?? null,
    }, nameOf);
    setText(tContext, parts.text);
    const showSpeed = !!parts.speed;
    sepSpeed.hidden = tSpeed.hidden = !showSpeed;
    setText(tSpeed, showSpeed ? parts.speed : '');
    if ((mode === 'flyby' || mode === 'tour') && fly) {
      arc.style.display = '';
      arcFg.setAttribute('stroke-dashoffset', String(ARC_C * (1 - Math.max(0, Math.min(1, fly.tau)))));
    } else {
      arc.style.display = 'none';
    }

    // Scientist line.
    const sci = !!s.settings?.scientistMode;
    if (line3.hidden === sci) line3.hidden = !sci;
    if (sci) {
      const p = scientistParts({ jdUtc: s.jdUtc, deltaT: s.deltaT, deltaTAssumed: s.deltaTAssumed });
      for (let i = 0; i < 4; i++) setText(sciSpans[i], p[i]);
    }

    // Badges.
    const k = s.settings?.sizeK ?? 1;
    const sizeOn = Math.abs(k - 1) > 1e-9;
    setText(badgeSize, sizeBadge(k));
    setAttr(badgeSize, 'aria-pressed', sizeOn ? 'true' : 'false');
    setAttr(badgeSize, 'aria-label', sizeOn ? `Planets drawn ${k >= 10 ? Math.round(k) : k} times larger than true scale. Switch to true scale` : 'True scale. Enlarge the planets');
    badgeAcc.hidden = !s.reducedAccuracy;
    const scanning = s.eventsStatus === 'scanning';
    badgeEvents.hidden = !scanning;
    if (scanning) setText(badgeEvents, `Finding events… ${Math.round((s.eventsProgress || 0) * 100)}%`);
    setAttr(el, 'data-mode', mode);
  }

  return {
    update,
    /** Light-speed beat: 300 ms accent flash of the speed (plan §Fly-by). */
    beat() {
      tSpeed.classList.add('is-beat');
      clearTimeout(beatTimer);
      beatTimer = setTimeout(() => tSpeed.classList.remove('is-beat'), 300);
    },
    dispose() {
      clearTimeout(beatTimer);
      el.replaceChildren();
    },
  };
}

/** Composite separator re-exported for HUD-like strings in other modules. */
export { SEP };
