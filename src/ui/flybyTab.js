// Fly-by tab: what to do, not the profile maths. Destination buttons (Sun, planets, Moon when present), Launch,
// Grand tour (the Planets story), Stop, and a live status card in plain words (where to, how fast against light,
// how long light itself would take) with the scientific line (profile kind, τ, speed in c) in scientist mode.
import { h, setText, setAttr, getFormat, bodyIds, bodyName, bodyColour } from './dom.js';
import { speedWords, articled, SEP } from './copy.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el
 * @param {object} opts.actions  { flyTo, playTour, tour, cancel, select }
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

  const btnLaunch = h('button', { class: 'btn primary', type: 'button', text: 'Launch', 'aria-label': 'Launch the flight to the destination', 'aria-keyshortcuts': 'F',
    onclick: () => { if (currentDest) actions.flyTo?.(currentDest); } });
  const btnTour = h('button', { class: 'btn solar', type: 'button', text: 'Grand tour', 'aria-label': 'Grand tour of the planets: Sun to Neptune with a stop at each one',
    'data-tip': 'Visit every planet in turn, with a fact at each stop',
    onclick: () => { if (typeof actions.playTour === 'function') actions.playTour('planets'); else actions.tour?.(); } });
  const btnCancel = h('button', { class: 'btn danger', type: 'button', text: 'Stop', 'aria-label': 'Stop the flight where it is', 'aria-keyshortcuts': 'Escape',
    onclick: () => actions.cancel?.() });

  const stTitle = h('div', { class: 'name', text: '' });
  const stSpeed = h('div', { class: 'big', text: '' });
  const stMeta = h('div', { class: 'muted', text: '' });
  const stSci = h('div', { class: 'num muted sci-only', text: '' });
  const stBar = h('i');
  const stProgress = h('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Flight progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, stBar);
  const status = h('div', { class: 'fly-status', 'aria-live': 'off' }, stTitle, stSpeed, stMeta, stSci, h('div', { class: 'status-line', style: { marginTop: '8px' } }, stProgress));
  status.hidden = true;

  el.replaceChildren(
    h('h2', { text: 'Fly to a planet' }),
    h('p', { class: 'lead', text: 'Pick a destination and press Launch. The camera eases away, outruns light many times over, and settles beside your planet — a trip that would take light itself minutes to hours.' }),
    grid,
    h('div', { class: 'btn-row' }, btnLaunch, btnTour, btnCancel),
    status,
    h('p', { class: 'footnote', text: 'Double-tap a destination to launch straight away. Esc stops the flight where it is. With reduced motion on, the view fades and cuts instead of flying.' }),
    h('p', { class: 'footnote sci-only', text: 'Warp profile: log-speed with about one second of visible sub-light departure and arrival, arcing between the moving bodies; short hops re-frame with a min-jerk ease. The speed shown is the true camera speed along the path, in multiples of c.' }),
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
    const nameOf = (id) => bodyName(providers, id);

    // Selecting a body elsewhere moves the destination with it; a destination chosen here sticks until then.
    if (s.selected && s.selected !== lastSelected) { dest = s.selected; }
    lastSelected = s.selected;
    currentDest = dest ?? s.selected ?? null;
    for (const [id, b] of destButtons) {
      setText(b.name, nameOf(id));
      setAttr(b.btn, 'aria-pressed', currentDest === id ? 'true' : 'false');
    }

    const flying = s.cameraMode === 'flyby' || s.cameraMode === 'tour';
    btnLaunch.disabled = !currentDest || flying || (s.cameraMode === 'follow' && s.followed === currentDest);
    setText(btnLaunch, currentDest ? `Launch → ${nameOf(currentDest)}` : 'Launch');
    btnTour.disabled = flying || !!s.story;
    btnCancel.disabled = !flying;

    const fb = s.flyby;
    status.hidden = !(flying && fb);
    if (flying && fb) {
      setText(stTitle, `Flying to ${articled(fb.target, nameOf)}${fb.from ? ` from ${articled(fb.from, nameOf)}` : ''}`);
      setText(stSpeed, speedWords(fb.speedC));
      const lt = Number.isFinite(fb.lightMinutesToTarget) ? `light itself would need ${f.lightTime(fb.lightMinutesToTarget * 60)}` : '';
      setText(stMeta, lt);
      if (s.settings?.scientistMode) {
        setText(stSci, `${fb.kind === 'warp' ? 'warp (log-speed)' : 'min-jerk re-frame'}${SEP}τ = ${Math.max(0, Math.min(1, fb.tau)).toFixed(2)}${SEP}${f.speed(fb.speedC)}`);
      }
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
