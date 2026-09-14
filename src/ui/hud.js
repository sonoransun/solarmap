// Top-left HUD: UTC date/time · JD · ΔT (+"assumed") · camera mode / speed / distance from the Sun · badges.
// aria-live="off": it re-renders at 10 Hz and must not spam screen readers (critique byf0bzyiw §aria).
import { h, setText, setAttr, getFormat, bodyName, SEP } from './dom.js';

const MODE_LABEL = { free: 'Free view', follow: 'Following', skyView: 'Sky view', flyby: 'Fly-by', tour: 'Grand tour' };
const ARC_R = 5.5;
const ARC_C = 2 * Math.PI * ARC_R;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el  #hud
 * @param {() => object|null} opts.getProviders
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, beat: () => void, dispose: () => void }}
 */
export function createHud({ el, getProviders }) {
  el.setAttribute('aria-live', 'off');
  el.setAttribute('aria-label', 'Simulation status');
  el.classList.add('glass');

  const tUtc = h('span', { class: 'v', text: '—' });
  const tJd = h('span', { class: 'v', text: '—' });
  const tDt = h('span', { class: 'v', text: '—' });
  const tRate = h('span', { class: 'v', text: '—' });
  const line1 = h('div', { class: 'hud-line' },
    tUtc, h('span', { class: 'sep', text: '·' }), tJd, h('span', { class: 'sep', text: '·' }),
    h('span', { class: 'k', text: 'ΔT ' }), tDt, h('span', { class: 'sep', text: '·' }), tRate);

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

  const tMode = h('span', { class: 'v', text: 'Free view' });
  const sepSpeed = h('span', { class: 'sep', text: '·' });
  const tSpeedNum = h('span', { class: 'v', text: '' });
  const tSpeedC = h('span', { class: 'hud-c', text: '' });
  const sepDist = h('span', { class: 'sep', text: '·' });
  const tDist = h('span', { class: 'v', text: '' });
  const sepLight = h('span', { class: 'sep', text: '·' });
  const tLight = h('span', { class: 'v muted', text: '' });
  const line2 = h('div', { class: 'hud-line secondary' }, arc, tMode, sepSpeed, tSpeedNum, tSpeedC, sepDist, tDist, sepLight, tLight);

  const badgeSize = h('span', { class: 'badge solar', text: '' });
  const badgeAcc = h('span', { class: 'badge warn', text: 'reduced accuracy', title: 'Outside the verified band 1600–2600: ephemeris residuals grow beyond the tested tolerances' });
  const badgePaused = h('span', { class: 'badge', text: 'paused' });
  const badgeEvents = h('span', { class: 'badge accent', text: 'scanning events…' });
  const badges = h('div', { class: 'badges' }, badgeSize, badgeAcc, badgePaused, badgeEvents);
  badgeSize.hidden = badgeAcc.hidden = badgePaused.hidden = badgeEvents.hidden = true;

  el.replaceChildren(line1, line2, badges);

  let beatTimer = 0;

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    setText(tUtc, f.utc(s.jdUtc));
    setText(tJd, f.jd(s.jdUtc));
    setText(tDt, f.deltaT(s.deltaT, s.deltaTAssumed));
    setText(tRate, s.playing ? `▶ ${f.rate(s.rate)}` : `⏸ ${f.rate(s.rate)}`);

    // Camera line.
    let cam = null;
    try { cam = providers?.cameraInfo?.() ?? null; } catch { cam = null; }
    const mode = s.cameraMode;
    let modeText = MODE_LABEL[mode] || mode;
    if (mode === 'follow' && s.followed) modeText = `Following ${bodyName(providers, s.followed)}`;
    if (mode === 'skyView') modeText = `Sky view${s.followed ? ` from ${bodyName(providers, s.followed)}` : ''}`;
    const fly = s.flyby;
    if ((mode === 'flyby' || mode === 'tour') && fly) {
      modeText = `${mode === 'tour' ? 'Tour' : 'Fly-by'} → ${bodyName(providers, fly.target)}`;
      arc.style.display = '';
      arcFg.setAttribute('stroke-dashoffset', String(ARC_C * (1 - Math.max(0, Math.min(1, fly.tau)))));
    } else {
      arc.style.display = 'none';
    }
    setText(tMode, modeText);

    const speedC = fly ? fly.speedC : cam?.speedC;
    const showSpeed = Number.isFinite(speedC) && (fly != null || speedC > 1e-6);
    sepSpeed.hidden = tSpeedNum.hidden = tSpeedC.hidden = !showSpeed;
    if (showSpeed) {
      const str = f.speed(speedC);
      // Split the unit so the "c" glyph can flash on the light-speed beat.
      if (str.endsWith(' c')) { setText(tSpeedNum, str.slice(0, -1)); setText(tSpeedC, 'c'); }
      else { setText(tSpeedNum, str); setText(tSpeedC, ''); }
    }

    const distAu = cam?.distAu;
    const showDist = Number.isFinite(distAu);
    sepDist.hidden = tDist.hidden = !showDist;
    if (showDist) setText(tDist, `${f.au(distAu)} from Sun`);

    const showLight = fly != null && Number.isFinite(fly.lightMinutesToTarget);
    sepLight.hidden = tLight.hidden = !showLight;
    if (showLight) setText(tLight, `light needs ${f.lightTime(fly.lightMinutesToTarget * 60)}`);

    // Badges.
    const k = s.settings?.sizeK ?? 1;
    const sizeOn = Math.abs(k - 1) > 1e-9;
    badgeSize.hidden = !sizeOn;
    if (sizeOn) setText(badgeSize, `Planet sizes ×${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')} (not to scale)`);
    badgeAcc.hidden = !s.reducedAccuracy;
    badgePaused.hidden = s.playing;
    badgeEvents.hidden = s.eventsStatus !== 'scanning';
    if (s.eventsStatus === 'scanning') setText(badgeEvents, `scanning events ${Math.round((s.eventsProgress || 0) * 100)}%`);
    setAttr(el, 'data-mode', mode);
  }

  return {
    update,
    /** Light-speed beat: 300 ms accent flash of the "c" glyph (plan §Fly-by). */
    beat() {
      tSpeedC.classList.add('is-beat');
      clearTimeout(beatTimer);
      beatTimer = setTimeout(() => tSpeedC.classList.remove('is-beat'), 300);
    },
    dispose() {
      clearTimeout(beatTimer);
      el.replaceChildren();
    },
  };
}

/** Composite separator re-exported for HUD-like strings in other modules. */
export { SEP };
