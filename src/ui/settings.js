// Settings popover: planet size (log slider 1…1000 with presets 1/50/500), orbits / labels / grid switches,
// quality High/Low, reduced motion Auto/On/Off, keep time rate during fly-bys, spin cap, orientation debug overlay.
// Every control writes through actions.setSettings(patch); the store persists to localStorage.
import { h, setText, setAttr } from './dom.js';

const SIZE_PRESETS = [1, 50, 500];

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root   element the popover is appended to
 * @param {object} opts.actions     { setSettings }
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @param {() => void} [opts.onAbout]  open the About dialog
 * @returns {{ el: HTMLElement, open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean, update: (s: import('../app/state.js').AppState) => void, dispose: () => void }}
 */
export function createSettings({ root, actions, getState, onAbout }) {
  const set = (patch) => actions.setSettings?.(patch);

  // --- planet size (log slider)
  const sizeVal = h('span', { class: 'num', text: '×1' });
  const sizeSlider = h('input', { type: 'range', min: '0', max: '3', step: '0.01', value: '0', 'aria-label': 'Planet size exaggeration (logarithmic, 1 to 1000)', 'aria-valuetext': '×1' });
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
    type: 'button', 'aria-pressed': 'false', text: `×${k}`, 'aria-label': `Planet size ×${k}${k === 1 ? ' (true scale)' : ''}`,
    onclick: () => set({ sizeK: k, lastSizeK: k !== 1 ? k : getState().settings.lastSizeK }),
  }));

  const sw = (label, key, small) => {
    const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', id: `sw-${key}`, onclick: () => set({ [key]: !getState().settings[key] }) });
    const row = h('div', { class: 'field' }, h('label', { for: `sw-${key}` }, label, small ? h('small', { text: small }) : null), btn);
    return { row, btn };
  };
  const swPhoto = sw('Photographic surfaces', 'photoSurfaces', 'NASA-derived maps (Solar System Scope, CC BY 4.0); off = procedural surfaces');
  const swOrbits = sw('Orbits', 'showOrbits', 'Key O');
  const swLabels = sw('Labels', 'showLabels', 'Key L');
  const swGrid = sw('Grid', 'showGrid', 'Key G');
  const swKeepRate = sw('Keep time rate during fly-bys', 'keepRateDuringFlyby', 'Otherwise the rate eases down so the target does not smear');
  const swSpinCap = sw('Spin cap when close', 'spinCap', 'Limits the time rate so a followed body spins ≤ 1 turn per second');
  const swDebug = sw('Orientation debug overlay', 'showOrientationDebug', 'Axis, prime meridian and sub-solar dot');
  const swIntro = sw('Guided tour on load', 'introOnLoad', 'Plays the scripted tour of events and timescales when the page opens');

  const seg = (label, key, options, small) => {
    const buttons = options.map((o) => h('button', { type: 'button', 'aria-pressed': 'false', text: o.label, 'aria-label': `${label}: ${o.label}`, onclick: () => set({ [key]: o.value }) }));
    const row = h('div', { class: 'field' }, h('span', { class: 'lab' }, label, small ? h('small', { text: small }) : null), h('div', { class: 'seg', role: 'group', 'aria-label': label }, buttons));
    return { row, buttons, options };
  };
  const segQuality = seg('Quality', 'quality', [{ label: 'High', value: 'high' }, { label: 'Low', value: 'low' }], 'Low: no bloom/post, DPR 1');
  const segMotion = seg('Reduced motion', 'reducedMotion', [{ label: 'Auto', value: 'auto' }, { label: 'On', value: 'on' }, { label: 'Off', value: 'off' }], 'Auto follows the system setting');

  const btnClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close settings', title: 'Close (Esc)', onclick: () => close() }, closeIcon());
  const btnAbout = h('button', { class: 'btn sm', type: 'button', text: 'About & sources', onclick: () => { close(); onAbout?.(); } });

  const btnTour = h('button', {
    class: 'btn', type: 'button', text: 'Replay guided tour',
    'aria-label': 'Replay the guided tour of events and timescales',
    onclick: () => { actions?.playIntro?.(); close(); },
  });
  const el = h('div', { class: 'popover glass', id: 'settings', role: 'dialog', 'aria-label': 'Settings', tabindex: '-1' },
    h('div', { class: 'popover-head' }, h('h2', { text: 'Settings' }), btnClose),
    h('h3', { text: 'Scene' }),
    h('div', { class: 'field-col' },
      h('div', { class: 'field', style: { minHeight: '0' } }, h('label', { for: 'size-slider' }, 'Planet size ', sizeVal, h('small', { text: 'Key P toggles between true scale and the last value' })),
        h('div', { class: 'seg compact presets', role: 'group', 'aria-label': 'Planet size presets' }, presetButtons)),
      sizeSlider),
    swPhoto.row, swOrbits.row, swLabels.row, swGrid.row,
    h('h3', { text: 'Rendering' }),
    segQuality.row, segMotion.row,
    h('h3', { text: 'Motion' }),
    swKeepRate.row, swSpinCap.row, swIntro.row,
    h('div', { class: 'btn-row' }, btnTour),
    h('h3', { text: 'Debug' }),
    swDebug.row,
    h('div', { class: 'btn-row', style: { marginTop: '12px' } }, btnAbout),
  );
  sizeSlider.id = 'size-slider';
  el.hidden = true;
  root.append(el);

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
    setText(sizeVal, `×${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}`);
    setAttr(sizeSlider, 'aria-valuetext', `×${Math.round(k)}`);
    if (!sizeActive) { const v = Math.log10(Math.max(1, k)).toFixed(2); if (sizeSlider.value !== v) sizeSlider.value = v; }
    presetButtons.forEach((b, i) => setAttr(b, 'aria-pressed', Math.abs(k - SIZE_PRESETS[i]) < 1e-9 ? 'true' : 'false'));
    for (const [w, key] of [[swPhoto, 'photoSurfaces'], [swOrbits, 'showOrbits'], [swLabels, 'showLabels'], [swGrid, 'showGrid'], [swKeepRate, 'keepRateDuringFlyby'], [swSpinCap, 'spinCap'], [swDebug, 'showOrientationDebug'], [swIntro, 'introOnLoad']]) {
      setAttr(w.btn, 'aria-checked', st[key] ? 'true' : 'false');
    }
    for (const [g, key] of [[segQuality, 'quality'], [segMotion, 'reducedMotion']]) {
      g.buttons.forEach((b, i) => setAttr(b, 'aria-pressed', st[key] === g.options[i].value ? 'true' : 'false'));
    }
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
