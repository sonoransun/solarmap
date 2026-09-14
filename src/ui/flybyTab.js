// Fly-by tab: destination buttons (Sun + 8 planets), Launch, Tour, Cancel, and the live fly-by status
// (progress, true speed in c with the light-speed beat, light-time to the target, profile kind).
import { h, setText, setAttr, getFormat, bodyIds, bodyName, bodyColour } from './dom.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el
 * @param {object} opts.actions  { flyTo, tour, cancel, select }
 * @param {() => object|null} opts.getProviders
 * @param {() => void} [opts.requestRender]  ask the UI for a re-render after a local (non-store) change
 * @returns {{ update: (state: import('../app/state.js').AppState) => void, beat: () => void, dispose: () => void }}
 */
export function createFlybyTab({ el, actions, getProviders, requestRender }) {
  /** @type {string|null} destination chosen here; null → follows the selected body */
  let dest = null;
  let idsKey = '';
  /** @type {Map<string, { btn: HTMLElement, name: HTMLElement }>} */
  const destButtons = new Map();
  const grid = h('div', { class: 'dest-grid', role: 'group', 'aria-label': 'Destination' });

  const btnLaunch = h('button', { class: 'btn primary', type: 'button', text: 'Launch', 'aria-label': 'Launch fly-by to the destination', 'aria-keyshortcuts': 'F',
    onclick: () => { if (currentDest) actions.flyTo?.(currentDest); } });
  const btnTour = h('button', { class: 'btn solar', type: 'button', text: 'Grand tour', 'aria-label': 'Grand tour: Earth, Mars, Jupiter, Saturn, Uranus, Neptune, Mercury, Venus, Sun, Earth',
    onclick: () => actions.tour?.() });
  const btnCancel = h('button', { class: 'btn danger', type: 'button', text: 'Cancel', 'aria-label': 'Cancel the fly-by or tour', 'aria-keyshortcuts': 'Escape',
    onclick: () => actions.cancel?.() });

  const stTitle = h('div', { class: 'name', text: '' });
  const stSpeed = h('div', { class: 'big', text: '' });
  const stMeta = h('div', { class: 'muted', text: '' });
  const stBar = h('i');
  const stProgress = h('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Fly-by progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, stBar);
  const status = h('div', { class: 'fly-status', 'aria-live': 'off' }, stTitle, stSpeed, stMeta, h('div', { class: 'status-line', style: { marginTop: '8px' } }, stProgress));
  status.hidden = true;

  const help = h('p', { class: 'footnote', text: 'Warp fly-bys follow a log-speed profile: about one second of visible sub-light departure and arrival with a peak of hundreds to thousands of c, arcing between the moving bodies. Short hops re-frame smoothly instead. Esc decelerates in place. Under reduced motion the camera fades and cuts.' });

  el.replaceChildren(
    h('h2', { text: 'Destination' }),
    grid,
    h('div', { class: 'btn-row' }, btnLaunch, btnTour, btnCancel),
    status,
    help,
  );

  let currentDest = null;
  let lastSelected = null;
  let beatTimer = 0;

  function build(ids, providers) {
    destButtons.clear();
    grid.replaceChildren();
    for (const id of ids) {
      const name = h('span', { text: bodyName(providers, id) });
      const btn = h('button', {
        class: 'btn', type: 'button', 'aria-pressed': 'false', 'aria-label': `Destination ${bodyName(providers, id)}`,
        style: { '--c': bodyColour(providers, id) },
        onclick: () => { dest = id; actions.select?.(id); requestRender?.(); },
        ondblclick: () => { dest = id; actions.flyTo?.(id); },
      }, h('span', { class: 'dot', 'aria-hidden': 'true' }), name);
      grid.append(btn);
      destButtons.set(id, { btn, name });
    }
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const providers = getProviders();
    const f = getFormat(providers);
    const ids = bodyIds(providers);
    const key = ids.join(',');
    if (key !== idsKey) { idsKey = key; build(ids, providers); }

    // Selecting a body elsewhere moves the destination with it; a destination chosen here sticks until then.
    if (s.selected && s.selected !== lastSelected) { dest = s.selected; }
    lastSelected = s.selected;
    currentDest = dest ?? s.selected ?? null;
    for (const [id, b] of destButtons) {
      setText(b.name, bodyName(providers, id));
      setAttr(b.btn, 'aria-pressed', currentDest === id ? 'true' : 'false');
    }

    const flying = s.cameraMode === 'flyby' || s.cameraMode === 'tour';
    btnLaunch.disabled = !currentDest || flying || (s.cameraMode === 'follow' && s.followed === currentDest);
    setText(btnLaunch, currentDest ? `Launch → ${bodyName(providers, currentDest)}` : 'Launch');
    btnTour.disabled = flying;
    btnCancel.disabled = !flying;

    const fb = s.flyby;
    status.hidden = !(flying && fb);
    if (flying && fb) {
      setText(stTitle, `${s.cameraMode === 'tour' ? 'Tour leg' : 'Fly-by'} → ${bodyName(providers, fb.target)}${fb.from ? ` (from ${bodyName(providers, fb.from)})` : ''}`);
      setText(stSpeed, f.speed(fb.speedC));
      const lt = Number.isFinite(fb.lightMinutesToTarget) ? `light needs ${f.lightTime(fb.lightMinutesToTarget * 60)}` : '';
      setText(stMeta, `${fb.kind === 'warp' ? 'Warp profile' : 'Re-frame (min-jerk)'}${lt ? ` · ${lt}` : ''}`);
      const pct = Math.round(Math.max(0, Math.min(1, fb.tau)) * 100);
      stBar.style.width = `${pct}%`;
      setAttr(stProgress, 'aria-valuenow', String(pct));
    }
  }

  return {
    update,
    beat() {
      stSpeed.classList.add('is-beat');
      clearTimeout(beatTimer);
      beatTimer = setTimeout(() => stSpeed.classList.remove('is-beat'), 300);
    },
    dispose() { clearTimeout(beatTimer); destButtons.clear(); el.replaceChildren(); },
  };
}
