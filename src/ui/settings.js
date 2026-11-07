// Settings popover, grouped View · Time & motion · Science · Accessibility (spec-contracts.md §UI). Labels say what
// a switch does for the viewer, not which mechanism it flips. Every control writes through actions.setSettings
// (or actions.toggleScientistMode when main.js provides it); the store persists to localStorage.
import { h, setText, setAttr } from './dom.js';

const SIZE_PRESETS = [1, 50, 500];

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root   element the popover is appended to
 * @param {object} opts.actions     { setSettings, toggleScientistMode?, playTour?, playIntro?, openTours? }
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @param {() => void} [opts.onAbout]  open Help › About & sources
 * @param {() => void} [opts.onHelp]   open Help
 * @returns {{ el: HTMLElement, open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean, update: (s: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createSettings({ root, actions, getState, onAbout, onHelp }) {
  const set = (patch) => actions.setSettings?.(patch);

  // --- planet size (log slider)
  const sizeVal = h('span', { class: 'num', text: '×50' });
  const sizeSlider = h('input', { type: 'range', min: '0', max: '3', step: '0.01', value: '1.7', 'aria-label': 'Planet size, 1 (true scale) to 1000 times larger', 'aria-valuetext': '×50' });
  let sizeActive = false;
  sizeSlider.addEventListener('pointerdown', () => { sizeActive = true; });
  sizeSlider.addEventListener('focus', () => { sizeActive = true; });
  sizeSlider.addEventListener('blur', () => { sizeActive = false; });
  sizeSlider.addEventListener('input', () => {
    const k = Math.round(10 ** parseFloat(sizeSlider.value) * 10) / 10;
    const s = getState();
    set({ sizeK: k, lastSizeK: k !== 1 ? k : s.settings.lastSizeK });
  });
  const presetButtons = SIZE_PRESETS.map((k) => h('button', {
    type: 'button', 'aria-pressed': 'false', text: k === 1 ? 'True' : `×${k}`, 'aria-label': k === 1 ? 'True scale' : `Planets ${k} times larger`,
    onclick: () => set({ sizeK: k, lastSizeK: k !== 1 ? k : getState().settings.lastSizeK }),
  }));

  /** A labelled switch. `small` explains the effect in one line. */
  const sw = (label, key, small, onToggle = null) => {
    const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', id: `sw-${key}`, onclick: () => (onToggle ? onToggle() : set({ [key]: !getState().settings[key] })) });
    const row = h('div', { class: 'field' }, h('label', { for: `sw-${key}` }, label, small ? h('small', { text: small }) : null), btn);
    return { row, btn, key };
  };
  // View
  const swPhoto = sw('Photographic surfaces', 'photoSurfaces', 'Real maps from NASA imagery (on by default); off draws painted surfaces instead');
  const swLabels = sw('Names on the planets', 'showLabels', 'Key L');
  const swOrbits = sw('Orbit trails', 'showOrbits', 'The path each body follows around the Sun · key O');
  const swGrid = sw('1 AU ring and grid', 'showGrid', 'The Earth–Sun distance as a ring, for scale · key G');
  const swMoon = sw('The Moon', 'showMoon', 'Shown beside Earth; its true distance is kept');
  const swStars = sw('Stars', 'showStars', 'The 8 400 naked-eye stars of the Yale Bright Star Catalogue');
  const swMilky = sw('Milky Way', 'showMilkyWay', 'The band of our galaxy behind everything');
  const swStarNames = sw('Star names in sky view', 'showStarNames', 'Sirius, Vega, Betelgeuse… when you look up from Earth');
  // Time & motion
  const swKeepRate = sw('Keep time speed during flights', 'keepRateDuringFlyby', 'Otherwise time slows briefly so the destination does not smear past');
  const swSpinCap = sw('Slow time when close to a planet', 'spinCap', 'So a planet you are following never spins into a blur');
  const swIntro = sw('Play the Welcome tour on load', 'introOnLoad', 'A 90-second guided look at the solar system when the page opens');
  // Science
  const swScientist = sw('Scientist mode', 'scientistMode', 'Julian dates and ΔT, RA/Dec, orbital elements, the raw event score filter and symbols', () => {
    if (typeof actions.toggleScientistMode === 'function') actions.toggleScientistMode();
    else set({ scientistMode: !getState().settings.scientistMode });
  });
  const swDebug = sw('Axis and meridian overlay', 'showOrientationDebug', 'Draws each body’s spin axis, prime meridian and the point under the Sun');

  const seg = (label, key, options, small) => {
    const buttons = options.map((o) => h('button', { type: 'button', 'aria-pressed': 'false', text: o.label, 'aria-label': `${label}: ${o.label}`, onclick: () => set({ [key]: o.value }) }));
    const row = h('div', { class: 'field' }, h('span', { class: 'lab' }, label, small ? h('small', { text: small }) : null), h('div', { class: 'seg', role: 'group', 'aria-label': label }, buttons));
    return { row, buttons, options };
  };
  const segQuality = seg('Picture quality', 'quality', [{ label: 'High', value: 'high' }, { label: 'Low', value: 'low' }], 'Low turns off the glow effects and renders at 1× — smoother on older devices');
  const segMotion = seg('Reduce motion', 'reducedMotion', [{ label: 'Auto', value: 'auto' }, { label: 'On', value: 'on' }, { label: 'Off', value: 'off' }], 'On: flights fade and cut instead of flying; Auto follows your system setting');

  const btnClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close settings', 'data-tip': 'Close (Esc)', onclick: () => close() }, closeIcon());
  const btnAbout = h('button', { class: 'btn sm', type: 'button', text: 'About & sources', onclick: () => { close(); onAbout?.(); } });
  const btnHelp = h('button', { class: 'btn sm', type: 'button', text: 'Help', onclick: () => { close(); onHelp?.(); } });
  const btnTour = h('button', {
    class: 'btn', type: 'button', text: 'Replay the Welcome tour',
    onclick: () => { close(); if (typeof actions.playTour === 'function') actions.playTour('welcome'); else actions.playIntro?.(); },
  });
  const btnTours = h('button', {
    class: 'btn', type: 'button', text: 'All tours',
    onclick: () => { close(); if (typeof actions.openTours === 'function') actions.openTours(); else actions.playTour?.('welcome'); },
  });

  const el = h('div', { class: 'popover glass', id: 'settings', role: 'dialog', 'aria-label': 'Settings', tabindex: '-1' },
    h('div', { class: 'popover-head' }, h('h2', { text: 'Settings' }), btnClose),
    h('h3', { text: 'View' }),
    h('div', { class: 'field-col' },
      h('div', { class: 'field', style: { minHeight: '0' } }, h('label', { for: 'size-slider' }, 'Planet size ', sizeVal, h('small', { text: 'How much larger than life the planets are drawn (the Sun is capped at ×30). Key P toggles true scale.' })),
        h('div', { class: 'seg compact presets', role: 'group', 'aria-label': 'Planet size presets' }, presetButtons)),
      sizeSlider),
    swPhoto.row, swLabels.row, swOrbits.row, swGrid.row, swMoon.row, swStars.row, swMilky.row, swStarNames.row,
    h('h3', { text: 'Time & motion' }),
    swKeepRate.row, swSpinCap.row, swIntro.row,
    h('div', { class: 'btn-row' }, btnTour, btnTours),
    h('h3', { text: 'Science' }),
    swScientist.row, swDebug.row,
    h('h3', { text: 'Accessibility' }),
    segQuality.row, segMotion.row,
    h('div', { class: 'btn-row', style: { marginTop: '12px' } }, btnAbout, btnHelp),
  );
  sizeSlider.id = 'size-slider';
  el.hidden = true;
  root.append(el);

  const switches = [swPhoto, swLabels, swOrbits, swGrid, swMoon, swStars, swMilky, swStarNames, swKeepRate, swSpinCap, swIntro, swScientist, swDebug];

  let openState = false;
  let lastFocus = null;
  const onDocPointer = (e) => { if (openState && !el.contains(/** @type {Node} */ (e.target)) && !(e.target instanceof Element && e.target.closest('[data-settings-toggle]'))) close(); };
  const onKey = (e) => { if (openState && e.key === 'Escape') { e.stopPropagation(); close(); } };

  function open() {
    if (openState) return;
    openState = true;
    el.hidden = false;
    lastFocus = document.activeElement;
    update(getState());
    document.addEventListener('pointerdown', onDocPointer, true);
    el.addEventListener('keydown', onKey);
    el.focus({ preventScroll: true });
  }
  function close() {
    if (!openState) return;
    openState = false;
    el.hidden = true;
    document.removeEventListener('pointerdown', onDocPointer, true);
    el.removeEventListener('keydown', onKey);
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    if (el.hidden) return;
    const st = s.settings;
    const k = st.sizeK ?? 1;
    setText(sizeVal, Math.abs(k - 1) < 1e-9 ? 'true scale' : `×${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}`);
    setAttr(sizeSlider, 'aria-valuetext', Math.abs(k - 1) < 1e-9 ? 'true scale' : `${Math.round(k)} times larger`);
    if (!sizeActive) { const v = Math.log10(Math.max(1, k)).toFixed(2); if (sizeSlider.value !== v) sizeSlider.value = v; }
    presetButtons.forEach((b, i) => setAttr(b, 'aria-pressed', Math.abs(k - SIZE_PRESETS[i]) < 1e-9 ? 'true' : 'false'));
    for (const w of switches) setAttr(w.btn, 'aria-checked', st[w.key] ? 'true' : 'false');
    for (const [g, key] of [[segQuality, 'quality'], [segMotion, 'reducedMotion']]) {
      g.buttons.forEach((b, i) => setAttr(b, 'aria-pressed', st[key] === g.options[i].value ? 'true' : 'false'));
    }
    btnTour.disabled = !!s.story;
  }

  return {
    el,
    open,
    close,
    toggle() { if (openState) close(); else open(); },
    isOpen: () => openState,
    update,
    dispose() { close(); el.remove(); },
  };
}

function closeIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M6 6l12 12M18 6L6 18"/>';
  return s;
}
