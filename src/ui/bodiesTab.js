// Bodies tab: one row per body in plain words (From the Sun · From Earth · In Earth's sky · Speed; the heliocentric
// longitude λ☉ joins them in scientist mode). The selected body gets a detail block: lay rows first (day length,
// year length, light times, gravity when provided, phase, brightness, apparent size), then — scientist mode only —
// the orientation table (sub-solar point, pole, W, obliquity, phase angle), RA/Dec (astrometric J2000 and apparent
// of date) and the osculating elements. Every number is read defensively from providers.bodyInfo(id); a row whose
// datum is missing is simply not shown. Row click = select; Shift-click = distance-beam partner. Text updates in
// place at ≤ 10 Hz.
import { h, setText, setAttr, setRow, getFormat, bodyIds, bodyName, bodyColour, bodyInfo } from './dom.js';
import {
  auWords, skyText, dayLengthText, yearLengthText, lightTimeWords, phaseText, magnitudeText, angularSizeText,
  gravityText, SEP,
} from './copy.js';
import { LIGHT_TIME_AU_S } from '../astro/constants.js';

/** Standard gravity, m/s² (CODATA / ISO 80000-3), to turn a provided surface gravity into "× Earth". */
const G0_M_S2 = 9.80665;

/** Bodies whose rotation is retrograde in the IAU 2015 model (Ẇ < 0: Venus, Uranus; Archinal et al. 2018 Table 1);
 * used only when providers.bodyInfo does not say. */
const RETROGRADE_FALLBACK = new Set(['venus', 'uranus']);

/** Legend shown under the selected body ("What am I looking at?"). */
export const LEGEND_TEXT = 'The thin coloured lines are orbit trails: the path each body follows around the Sun. The faint ring is 1 AU, the Earth–Sun distance. A soft glow marks a planet too small to see at this distance — the brighter the glow, the brighter it is in our sky. Labels carry each body’s colour.';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el
 * @param {object} opts.actions  { select, follow, flyTo, skyView, setBeamPartner }
 * @param {() => object|null} opts.getProviders
 * @param {() => void} [opts.onShare]  "Share view" button (ui/index.js: actions.share or the clipboard fallback)
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createBodiesTab({ el, actions, getProviders, onShare = null }) {
  const list = h('ul', { class: 'list', 'aria-label': 'Bodies' });
  const hint = h('p', { class: 'footnote', text: 'Tap a row to select a body. With a keyboard: 0–8 select Sun…Neptune, Shift-click a second body to measure the distance between them.' });
  el.replaceChildren(list, hint);

  /** @type {Map<string, { li: HTMLElement, btn: HTMLElement, name: HTMLElement, vals: HTMLElement[] }>} */
  const rows = new Map();
  let idsKey = '';

  // --- detail block (moved under the selected row)
  const dd = (cls) => h('dd', cls ? { class: cls } : null);
  const dt = (text, cls) => h('dt', { text, class: cls });
  const lay = {
    day: [dt('Day length'), dd()],
    year: [dt('Year length'), dd()],
    sunlight: [dt('Sunlight takes'), dd()],
    light: [dt('Light to Earth takes'), dd()],
    gravity: [dt('Gravity'), dd()],
    phase: [dt('Lit as seen from Earth'), dd()],
    mag: [dt('Brightness'), dd()],
    size: [dt('Apparent size'), dd()],
  };
  const sci = {
    subsolar: [dt('Sub-solar point'), dd('num')],
    pole: [dt('Pole (ecliptic lon / lat)'), dd('num')],
    w: [dt('Prime meridian W'), dd('num')],
    rot: [dt('Sidereal rotation'), dd('num')],
    obliq: [dt('Obliquity to orbit'), dd('num')],
    phaseAngle: [dt('Phase angle'), dd('num')],
    helioLon: [dt('Heliocentric longitude λ☉'), dd('num')],
    raJ2000: [dt('RA / Dec (J2000, astrometric)'), dd('num')],
    raApparent: [dt('RA / Dec (apparent, of date)'), dd('num')],
    elA: [dt('a · e'), dd('num')],
    elI: [dt('i · Ω'), dd('num')],
    elW: [dt('ω · M'), dd('num')],
    elP: [dt('Period'), dd('num')],
  };
  const detailTitle = h('h3', { text: '' });
  const btnFollow = h('button', { class: 'btn sm', type: 'button', text: 'Follow', 'data-tip': 'Keep the camera on this body as time runs' });
  const btnFly = h('button', { class: 'btn sm primary', type: 'button', text: 'Fly there', 'aria-keyshortcuts': 'F', 'data-tip': 'Fly to this body (key F)' });
  const btnSky = h('button', { class: 'btn sm', type: 'button', text: 'Earth’s sky', 'aria-keyshortcuts': 'V', 'data-tip': 'Look at this body from Earth, as it appears in our sky (key V)' });
  const btnShare = h('button', { class: 'btn sm', type: 'button', text: 'Share view', 'data-tip': 'Copy a link that opens this exact view, date and time', onclick: () => onShare?.() });
  const legend = h('details', { class: 'legend-line' },
    h('summary', { text: 'What am I looking at?' }),
    h('p', { text: LEGEND_TEXT }));
  const detail = h('div', { class: 'detail' },
    detailTitle,
    h('dl', { class: 'kv' }, Object.values(lay).flat()),
    h('h4', { class: 'sci-only', text: 'Orientation, sky coordinates and orbit' }),
    h('dl', { class: 'kv sci-only' }, Object.values(sci).flat()),
    h('div', { class: 'btn-row' }, btnFollow, btnFly, btnSky, btnShare),
    legend);
  let selectedId = null;
  btnFollow.addEventListener('click', () => { if (selectedId) actions.follow?.(selectedId); });
  btnFly.addEventListener('click', () => { if (selectedId) actions.flyTo?.(selectedId); });
  btnSky.addEventListener('click', () => { if (selectedId) actions.skyView?.(selectedId); });

  const COLS = [
    { k: 'From the Sun', cls: '' },
    { k: 'From Earth', cls: '' },
    { k: 'In Earth’s sky', cls: 'wide' },
    { k: 'Speed', cls: '' },
    { k: 'λ☉', cls: 'sci-only', tip: 'Heliocentric ecliptic longitude, J2000' },
  ];

  function build(ids, providers) {
    rows.clear();
    list.replaceChildren();
    ids.forEach((id, idx) => {
      const vals = COLS.map((c) => h('span', { class: `val ${c.cls}`.trim(), 'data-tip': c.tip }, h('span', { class: 'k', text: c.k }), h('span', { class: 'n', text: '—' })));
      const name = h('span', { class: 'name', text: bodyName(providers, id) });
      const btn = h('button', {
        class: 'row row-body', type: 'button', 'aria-pressed': 'false',
        'aria-label': `${bodyName(providers, id)}: select`,
        style: { '--c': bodyColour(providers, id) },
        onclick: (e) => { if (e.shiftKey) actions.setBeamPartner?.(id); else actions.select?.(id); },
      }, h('span', { class: 'dot', 'aria-hidden': 'true' }), name,
      idx <= 8 ? h('kbd', { class: 'key-hint', text: String(idx), 'aria-hidden': 'true' }) : h('span'),
      h('span', { class: 'cols' }, vals));
      const li = h('li', null, btn);
      list.append(li);
      rows.set(id, { li, btn, name, vals: vals.map((v) => /** @type {HTMLElement} */ (v.lastChild)) });
    });
  }

  /** @param {HTMLElement} n @param {string|null} text */
  const cell = (n, text) => { const na = text == null; setText(n, na ? '—' : text); n.classList.toggle('na', na); };

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    const ids = bodyIds(providers);
    const key = ids.join(',');
    if (key !== idsKey) { idsKey = key; build(ids, providers); }
    const scientist = !!s.settings?.scientistMode;

    for (const [id, r] of rows) {
      const info = bodyInfo(providers, id);
      setText(r.name, bodyName(providers, id));
      cell(r.vals[0], id === 'sun' ? null : Number.isFinite(info?.rSunAu) ? auWords(info.rSunAu) : null);
      cell(r.vals[1], id === 'earth' ? null : Number.isFinite(info?.earthDistAu) ? auWords(info.earthDistAu) : null);
      cell(r.vals[2], id === 'earth' ? null : id === 'sun' ? 'the daytime sky' : Number.isFinite(info?.elongationDeg) ? skyText(info.elongationDeg, info.elongSide) : null);
      cell(r.vals[3], id === 'sun' ? null : Number.isFinite(info?.orbitalSpeedKmS) ? f.kmPerS(info.orbitalSpeedKmS) : null);
      if (scientist) cell(r.vals[4], id === 'sun' ? null : Number.isFinite(info?.helioLonDeg) ? f.deg(info.helioLonDeg, 2) : null);
      const on = s.selected === id;
      setAttr(r.btn, 'aria-pressed', on ? 'true' : 'false');
      r.btn.classList.toggle('is-partner', s.beamPartner === id);
      if (on && detail.parentNode !== r.li) r.li.append(detail);
    }
    if (!s.selected && detail.parentNode) detail.remove();
    selectedId = s.selected;
    if (!s.selected) return;

    const id = s.selected;
    const info = bodyInfo(providers, id);
    const isSun = id === 'sun'; const isEarth = id === 'earth';
    setText(detailTitle, bodyName(providers, id));

    // Lay rows (hidden when the datum is missing).
    const retro = info?.retrograde === true || (Number.isFinite(info?.spinRateDegPerDay) ? info.spinRateDegPerDay < 0 : RETROGRADE_FALLBACK.has(id));
    setRow(...lay.day, Number.isFinite(info?.siderealRotationHours) ? `${dayLengthText(info.siderealRotationHours, retro)}${isSun ? ' (at the equator)' : ''}` : null);
    let periodDays = info?.periodDays ?? info?.elements?.periodDays ?? info?.siderealOrbitDays ?? null;
    if (!Number.isFinite(periodDays)) { try { periodDays = providers?.periodDays?.(id) ?? null; } catch { periodDays = null; } }
    setRow(...lay.year, isSun ? null : Number.isFinite(periodDays) ? yearLengthText(periodDays) : null);
    setRow(...lay.sunlight, isSun ? null : Number.isFinite(info?.rSunAu) ? `${lightTimeWords(info.rSunAu)} to get here` : null);
    const lightS = Number.isFinite(info?.lightTimeS) ? info.lightTimeS : Number.isFinite(info?.earthDistAu) ? info.earthDistAu * LIGHT_TIME_AU_S : NaN;
    setRow(...lay.light, isEarth ? null : Number.isFinite(lightS) ? f.lightTime(lightS) : null);
    const g = Number.isFinite(info?.gravityG) ? info.gravityG : Number.isFinite(info?.surfaceGravityMs2) ? info.surfaceGravityMs2 / G0_M_S2 : NaN;
    setRow(...lay.gravity, Number.isFinite(g) ? gravityText(g) : null);
    setRow(...lay.phase, isSun || isEarth ? null : Number.isFinite(info?.illuminatedFraction) ? phaseText(info.illuminatedFraction) : null);
    setRow(...lay.mag, isEarth ? null : Number.isFinite(info?.magnitude) ? magnitudeText(info.magnitude) : null);
    setRow(...lay.size, isEarth ? null : Number.isFinite(info?.angularDiameterArcsec) ? angularSizeText(info.angularDiameterArcsec) : null);

    // Scientist rows.
    if (scientist) {
      setRow(...sci.subsolar, isSun ? null : Number.isFinite(info?.subSolarLonDeg) ? `${f.lonLat(info.subSolarLonDeg, 'EW', 2)}, ${f.lonLat(info.subSolarLatDeg, 'NS', 2)}` : null);
      setRow(...sci.pole, Number.isFinite(info?.poleLonDeg) ? `${f.deg(info.poleLonDeg, 2)} / ${f.deg(info.poleLatDeg, 2)}` : null);
      setRow(...sci.w, Number.isFinite(info?.wDeg) ? f.deg(info.wDeg, 2) : null);
      setRow(...sci.rot, Number.isFinite(info?.siderealRotationHours) ? `${f.period(info.siderealRotationHours / 24)}${retro ? ' (retrograde)' : ''}` : null);
      setRow(...sci.obliq, isSun ? null : Number.isFinite(info?.obliquityDeg) ? f.deg(info.obliquityDeg, 2) : null);
      setRow(...sci.phaseAngle, isSun ? null : Number.isFinite(info?.phaseAngleDeg) ? f.deg(info.phaseAngleDeg, 1) : null);
      setRow(...sci.helioLon, isSun ? null : Number.isFinite(info?.helioLonDeg) ? f.deg(info.helioLonDeg, 3) : null);
      setRow(...sci.raJ2000, Number.isFinite(info?.raDeg) && Number.isFinite(info?.decDeg) ? `${f.ra(info.raDeg)}${SEP}${f.dec(info.decDeg)}` : null);
      setRow(...sci.raApparent, Number.isFinite(info?.raApparentDeg) && Number.isFinite(info?.decApparentDeg) ? `${f.ra(info.raApparentDeg)}${SEP}${f.dec(info.decApparentDeg)}` : null);
      const e = info?.elements;
      const has = e && Number.isFinite(e.a);
      setRow(...sci.elA, has ? `${e.a.toFixed(5)} AU${SEP}${Number.isFinite(e.e) ? e.e.toFixed(5) : '—'}` : null);
      setRow(...sci.elI, has && Number.isFinite(e.iDeg) ? `${f.deg(e.iDeg, 3)}${SEP}${f.deg(e.OmegaDeg, 2)}` : null);
      setRow(...sci.elW, has && Number.isFinite(e.omegaDeg) ? `${f.deg(e.omegaDeg, 2)}${SEP}${f.deg(e.MDeg, 2)}` : null);
      setRow(...sci.elP, has && Number.isFinite(e.periodDays) ? `${e.periodDays.toFixed(1)} d (${(e.periodDays / 365.25).toFixed(3)} y)` : null);
    }

    btnFollow.disabled = s.cameraMode === 'follow' && s.followed === id;
    btnSky.disabled = isEarth;
    btnFly.disabled = s.cameraMode === 'flyby' || s.cameraMode === 'tour';
  }

  return { update, dispose() { rows.clear(); el.replaceChildren(); } };
}
