// Bodies tab: one row per body (dot, name, heliocentric longitude, r☉, Earth distance, elongation E/W, orbital speed);
// the selected body gets a detail block (sub-solar point, pole, W, sidereal rotation, obliquity, phase angle) with
// Follow / Fly / Sky view. Row click = select; shift-click = beam partner. Text is updated in place at ≤ 10 Hz.
import { h, setText, setAttr, getFormat, bodyIds, bodyName, bodyColour } from './dom.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el
 * @param {object} opts.actions  { select, follow, flyTo, skyView, setBeamPartner }
 * @param {() => object|null} opts.getProviders
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createBodiesTab({ el, actions, getProviders }) {
  const list = h('ul', { class: 'list', 'aria-label': 'Bodies' });
  const hint = h('p', { class: 'footnote', text: 'Click a row to select a body; Shift-click (or a Distances row) to set the second end of the distance beam. Keys 0–8 select Sun…Neptune.' });
  el.replaceChildren(list, hint);

  /** @type {Map<string, { li: HTMLElement, btn: HTMLElement, name: HTMLElement, vals: HTMLElement[] }>} */
  const rows = new Map();
  let idsKey = '';

  // Detail block (moved under the selected row).
  const dValues = {
    subsolar: h('dd'), pole: h('dd'), w: h('dd'), rot: h('dd'), obliq: h('dd'), phase: h('dd'),
  };
  const detailTitle = h('h3', { text: 'Orientation' });
  const btnFollow = h('button', { class: 'btn sm', type: 'button', text: 'Follow', 'aria-label': 'Follow the selected body with the camera' });
  const btnFly = h('button', { class: 'btn sm primary', type: 'button', text: 'Fly', 'aria-label': 'Fly to the selected body', 'aria-keyshortcuts': 'F' });
  const btnSky = h('button', { class: 'btn sm', type: 'button', text: 'Sky view', 'aria-label': 'Sky view from Earth toward the selected body', 'aria-keyshortcuts': 'V' });
  const detail = h('div', { class: 'detail' },
    detailTitle,
    h('dl', { class: 'kv' },
      h('dt', { text: 'Sub-solar point' }), dValues.subsolar,
      h('dt', { text: 'Pole (ecliptic lon / lat)' }), dValues.pole,
      h('dt', { text: 'Prime meridian W' }), dValues.w,
      h('dt', { text: 'Sidereal rotation' }), dValues.rot,
      h('dt', { text: 'Obliquity to orbit' }), dValues.obliq,
      h('dt', { text: 'Phase angle' }), dValues.phase),
    h('div', { class: 'btn-row' }, btnFollow, btnFly, btnSky));
  let selectedId = null;
  btnFollow.addEventListener('click', () => { if (selectedId) actions.follow?.(selectedId); });
  btnFly.addEventListener('click', () => { if (selectedId) actions.flyTo?.(selectedId); });
  btnSky.addEventListener('click', () => { if (selectedId) actions.skyView?.(selectedId); });

  const COLS = [
    { k: 'λ☉', title: 'Heliocentric ecliptic longitude' },
    { k: 'r☉', title: 'Distance from the Sun' },
    { k: 'Δ⊕', title: 'Distance from Earth' },
    { k: 'elong', title: 'Elongation from the Sun as seen from Earth (E = evening, W = morning)' },
    { k: 'v', title: 'Heliocentric orbital speed' },
  ];

  function build(ids, providers) {
    rows.clear();
    list.replaceChildren();
    ids.forEach((id, idx) => {
      const vals = COLS.map((c) => h('span', { class: 'val', title: c.title }, h('span', { class: 'k', text: c.k }), h('span', { class: 'n', text: '—' })));
      const name = h('span', { class: 'name', text: bodyName(providers, id) });
      const btn = h('button', {
        class: 'row row-body', type: 'button', 'aria-pressed': 'false',
        'aria-label': `${bodyName(providers, id)}: select (Shift-click sets the distance-beam partner)`,
        style: { '--c': bodyColour(providers, id) },
        onclick: (e) => { if (e.shiftKey) actions.setBeamPartner?.(id); else actions.select?.(id); },
      }, h('span', { class: 'dot', 'aria-hidden': 'true' }), name, h('span', { class: 'val', text: idx <= 8 ? String(idx) : '', title: 'Keyboard shortcut', 'aria-hidden': 'true' }), h('span', { class: 'cols' }, vals));
      const li = h('li', null, btn);
      list.append(li);
      rows.set(id, { li, btn, name, vals: vals.map((v) => /** @type {HTMLElement} */ (v.lastChild)) });
    });
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    const ids = bodyIds(providers);
    const key = ids.join(',');
    if (key !== idsKey) { idsKey = key; build(ids, providers); }

    for (const [id, r] of rows) {
      let info = null;
      try { info = providers?.bodyInfo?.(id) ?? null; } catch { info = null; }
      setText(r.name, bodyName(providers, id));
      setText(r.vals[0], id === 'sun' ? '—' : f.deg(info?.helioLonDeg, 1));
      setText(r.vals[1], id === 'sun' ? '—' : f.au(info?.rSunAu));
      setText(r.vals[2], id === 'earth' ? '—' : f.au(info?.earthDistAu));
      setText(r.vals[3], id === 'earth' ? '—' : `${f.deg(info?.elongationDeg, 1)}${info?.elongSide ? ` ${info.elongSide}` : ''}`);
      setText(r.vals[4], id === 'sun' ? '—' : f.kmPerS(info?.orbitalSpeedKmS));
      const on = s.selected === id;
      setAttr(r.btn, 'aria-pressed', on ? 'true' : 'false');
      r.btn.classList.toggle('is-partner', s.beamPartner === id);
      if (on && detail.parentNode !== r.li) r.li.append(detail);
    }
    if (!s.selected && detail.parentNode) detail.remove();
    selectedId = s.selected;
    if (s.selected) {
      let info = null;
      try { info = providers?.bodyInfo?.(s.selected) ?? null; } catch { info = null; }
      setText(detailTitle, `${bodyName(providers, s.selected)} · orientation`);
      const na = (dd, on) => dd.classList.toggle('na', on);
      setText(dValues.subsolar, `${f.lonLat(info?.subSolarLonDeg, 'EW', 2)}, ${f.lonLat(info?.subSolarLatDeg, 'NS', 2)}`);
      setText(dValues.pole, `${f.deg(info?.poleLonDeg, 2)} / ${f.deg(info?.poleLatDeg, 2)}`);
      setText(dValues.w, f.deg(info?.wDeg, 2));
      setText(dValues.rot, Number.isFinite(info?.siderealRotationHours) ? f.period(info.siderealRotationHours / 24) : '—');
      setText(dValues.obliq, f.deg(info?.obliquityDeg, 2));
      const isSun = s.selected === 'sun';
      setText(dValues.phase, isSun ? '—' : f.deg(info?.phaseAngleDeg, 1));
      na(dValues.phase, isSun);
      na(dValues.obliq, isSun);
      btnFollow.disabled = s.cameraMode === 'follow' && s.followed === s.selected;
      btnSky.disabled = s.selected === 'earth';
      btnFly.disabled = s.cameraMode === 'flyby' || s.cameraMode === 'tour';
    }
  }

  return { update, dispose() { rows.clear(); el.replaceChildren(); } };
}
