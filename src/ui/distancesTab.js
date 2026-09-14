// Distances tab: from the selected body (Earth when nothing is selected) to every other body — AU · M km · light-time,
// sortable by distance or name; clicking a row sets the distance-beam partner (click again to clear).
import { h, setText, setAttr, getFormat, bodyName, bodyColour, bodyIds } from './dom.js';
import { AU_KM, LIGHT_TIME_AU_S } from '../astro/constants.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el
 * @param {object} opts.actions  { setBeamPartner, select }
 * @param {() => object|null} opts.getProviders
 * @param {() => void} [opts.requestRender]  ask the UI for a re-render after a local (non-store) change
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createDistancesTab({ el, actions, getProviders, requestRender }) {
  let sort = 'au';
  const btnSortAu = h('button', { type: 'button', 'aria-pressed': 'true', text: 'Distance', onclick: () => { sort = 'au'; refreshSort(); } });
  const btnSortName = h('button', { type: 'button', 'aria-pressed': 'false', text: 'Name', onclick: () => { sort = 'name'; refreshSort(); } });
  const title = h('h2', { text: 'From Earth' });
  const hint = h('p', { class: 'footnote', text: 'Select a body (Bodies tab or keys 0–8) to measure from it. Click a row to draw the distance beam to that body.' });
  const list = h('ul', { class: 'list', 'aria-label': 'Distances' });
  el.replaceChildren(
    title,
    h('div', { class: 'sorters' }, h('span', { class: 'muted', text: 'Sort by' }), h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort distances' }, btnSortAu, btnSortName)),
    list,
    hint,
  );
  function refreshSort() {
    setAttr(btnSortAu, 'aria-pressed', sort === 'au' ? 'true' : 'false');
    setAttr(btnSortName, 'aria-pressed', sort === 'name' ? 'true' : 'false');
    order = '';
    requestRender?.();
  }

  /** @type {Map<string, { li: HTMLElement, btn: HTMLElement, name: HTMLElement, au: HTMLElement, rest: HTMLElement, value: number }>} */
  const rows = new Map();
  let fromId = '';
  let order = '';

  function build(ids, from, providers) {
    rows.clear();
    list.replaceChildren();
    for (const id of ids) {
      if (id === from) continue;
      const name = h('span', { class: 'name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: bodyName(providers, id) }));
      const au = h('span', { class: 'val hi', text: '—' });
      const rest = h('span', { class: 'val', text: '' });
      const btn = h('button', {
        class: 'row row-dist', type: 'button', 'aria-pressed': 'false',
        'aria-label': `Distance to ${bodyName(providers, id)}; click to draw the distance beam`,
        style: { '--c': bodyColour(providers, id) },
        onclick: (e) => {
          if (e.shiftKey) { actions.select?.(id); return; }
          actions.setBeamPartner?.(currentPartner === id ? null : id);
        },
      }, h('span', { class: 'dot', 'aria-hidden': 'true' }), name, h('span', { class: 'vals' }, au, rest));
      const li = h('li', null, btn);
      rows.set(id, { li, btn, name: /** @type {HTMLElement} */ (name.lastChild), au, rest, value: NaN });
    }
    order = '';
  }

  let currentPartner = null;

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    const ids = bodyIds(providers);
    const from = s.selected || 'earth';
    if (from !== fromId || rows.size !== ids.length - 1) { fromId = from; build(ids, from, providers); }
    setText(title, `From ${bodyName(providers, from)}`);
    hint.hidden = !!s.selected;
    currentPartner = s.beamPartner;

    let dists = null;
    try { dists = providers?.distances?.(from) ?? null; } catch { dists = null; }
    const byId = new Map();
    if (Array.isArray(dists)) for (const d of dists) if (d && d.id) byId.set(d.id, d);

    for (const [id, r] of rows) {
      const d = byId.get(id);
      const au = d?.au;
      r.value = Number.isFinite(au) ? au : Infinity;
      setText(r.name, bodyName(providers, id));
      setText(r.au, f.au(au));
      const km = Number.isFinite(d?.km) ? d.km : au * AU_KM;
      const ls = Number.isFinite(d?.lightSeconds) ? d.lightSeconds : au * LIGHT_TIME_AU_S;
      setText(r.rest, Number.isFinite(au) ? `${f.km(km)} · ${f.lightTime(ls)}` : '');
      const on = s.beamPartner === id && !!s.selected;
      setAttr(r.btn, 'aria-pressed', on ? 'true' : 'false');
      r.btn.classList.toggle('is-partner', on);
    }

    // Re-order rows only when the order actually changes (keeps focus and avoids churn).
    const sorted = [...rows.entries()];
    if (sort === 'name') sorted.sort((a, b) => bodyName(providers, a[0]).localeCompare(bodyName(providers, b[0])));
    else sorted.sort((a, b) => a[1].value - b[1].value);
    const key = sorted.map((e) => e[0]).join(',');
    if (key !== order) { order = key; list.replaceChildren(...sorted.map((e) => e[1].li)); }
  }

  return { update, dispose() { rows.clear(); el.replaceChildren(); } };
}
