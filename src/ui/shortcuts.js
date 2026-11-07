// Keyboard shortcuts and the Help dialog. Help has four tabs: Gestures & touch · What you are looking at (legend) ·
// Keyboard shortcuts · About & sources. Shortcuts (plan §UI): Space play/pause · [ ] rate · ← → ∓1 d (Shift 7 d,
// Alt 1 calendar year) · T now · 0–8 select Sun…Neptune · F fly · V sky view · Esc (close dialogs → stop a flight →
// clear the beam → clear the event → clear the selection → free camera) · Home reset · L/O/G toggles · P size toggle
// · . step one frame · ? help. Ignored while typing in text inputs (range sliders keep every shortcut). While a tour
// runs, Space / ← / → / Esc belong to the story (main.js) and are left alone here.
import { h, isTypingTarget, bodyIds, trapFocusIn, setAttr } from './dom.js';
import { RATE_PRESETS, nearestRateIndex } from './timeline.js';
import { addCalendarYears } from './copy.js';

/** Rows of the keyboard tab: [keys[], description]. */
export const KEYMAP = Object.freeze([
  [['Space'], 'Play / pause time'],
  [['[', ']'], 'Slower / faster time'],
  [['←', '→'], 'Back / forward one day (Shift: one week, Alt: one calendar year)'],
  [['T'], 'Jump to now'],
  [['0', '…', '8'], 'Select the Sun, Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune'],
  [['F'], 'Fly to the selected body'],
  [['V'], 'Look at the selected body from Earth (sky view)'],
  [['Esc'], 'Close a dialog · stop a flight · clear the measurement, the event or the selection · free the camera'],
  [['Home'], 'Back to the whole-system view'],
  [['L'], 'Names on / off'],
  [['O'], 'Orbit trails on / off'],
  [['G'], '1 AU ring and grid on / off'],
  [['P'], 'Planet size: true scale ⇄ enlarged'],
  [['.'], 'Step one frame of simulated time'],
  [['?'], 'This help'],
  [['Shift', 'click'], 'Measure the distance from the selected body to the one you click'],
  [['Wheel on the time bar'], 'Back / forward one day (Shift: 30 days)'],
]);

/** Rows of the Gestures & touch tab: [gesture, what it does, touch-only?]. */
export const GESTURES = Object.freeze([
  ['Drag', 'Orbit the view around whatever it is looking at'],
  ['Pinch · scroll', 'Zoom in and out (toward the pointer in the free view)'],
  ['Two-finger drag · right-drag', 'Slide the view sideways'],
  ['Tap · click a planet or its name', 'Select it: its details open in the panel'],
  ['Double-tap · double-click', 'Fly there'],
  ['Shift-click (desktop)', 'Measure the distance from the selected body to this one'],
  ['Drag the time bar', 'Scrub through a year; time pauses while you hold it'],
  ['Tap the top-left badge', 'Switch between enlarged planets and true scale'],
  ['Swipe the panel handle', 'Open or close the details sheet (phones)'],
]);

/**
 * Rows of the legend tab: [swatch class, name, explanation].
 * Colours and the brightness law are those of the scene (render/markers.js: glow ∝ 10^(−0.4 m)).
 */
export const LEGEND = Object.freeze([
  ['sw-orbit', 'Orbit trail', 'The path a body follows around the Sun over one of its years; the brighter end is where it is now, the fading tail where it has been.'],
  ['sw-ring', '1 AU ring', 'A ring at one astronomical unit, the Earth–Sun distance (149.6 million km, 8 min 19 s of light). The grid lines are the plane of Earth’s orbit.'],
  ['sw-glow', 'Marker glow', 'Planets are tiny at this scale, so each gets a soft glow; its brightness follows how bright the planet is in our sky right now.'],
  ['sw-dot', 'Label dot', 'Each body keeps one colour everywhere: its label, its orbit trail, its row in the panel. The selected body is highlighted in blue.'],
  ['sw-size', 'Size badge', '“Planets drawn 50× larger” means radii are exaggerated so you can see them; distances and positions stay exact. Tap it for true scale.'],
  ['sw-beam', 'Distance beam', 'A line between the selected body and a second one, with the distance at its midpoint (Shift-click or the Distances tab).'],
  ['sw-align', 'Alignment lines', 'When an event is active, lines show the line-up — Sun, Earth and planet at opposition, or two planets side by side in Earth’s sky.'],
  ['sw-moon', 'Moon and stars', 'The Moon rides beside Earth at its true distance. The stars are the real naked-eye sky, with the Milky Way behind.'],
]);

/**
 * @param {object} opts
 * @param {object} opts.actions
 * @param {() => object|null} opts.getProviders
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @param {HTMLElement} opts.helpEl  #help
 * @param {() => boolean} opts.closeOverlays  close any open popover/dialog; returns true when something was closed
 * @param {() => void} opts.clearEvent  clear the active event (actions.clearEvent or a store write)
 * @param {(msg: string) => void} [opts.toast]
 * @param {HTMLElement|null} [opts.aboutContent]  content of the About tab
 * @returns {{ help: { open: (tab?: string) => void, close: () => void, toggle: () => void, isOpen: () => boolean, show: (tab: string) => void }, dispose: () => void }}
 */
export function createShortcuts({ actions, getProviders, getState, helpEl, closeOverlays, clearEvent, toast, aboutContent = null }) {
  // --- help dialog with tabs
  const btnClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close help', 'data-tip': 'Close (Esc)' });
  btnClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const keyRows = KEYMAP.flatMap(([keys, desc]) => [
    h('div', null, keys.map((k, i) => [i > 0 ? h('span', { class: 'faint', text: k === '…' ? ' … ' : ' ' }) : null, k === '…' ? null : h('kbd', { text: k })])),
    h('div', { text: desc }),
  ]);
  const panels = {
    gestures: h('div', { class: 'help-pane', role: 'tabpanel', id: 'help-pane-gestures', 'aria-labelledby': 'help-tab-gestures' },
      h('p', { class: 'lead', text: 'Everything works with one finger or one mouse button.' }),
      h('div', { class: 'keys gestures' }, GESTURES.flatMap(([g, d]) => [h('div', { class: 'gesture', text: g }), h('div', { text: d })]))),
    legend: h('div', { class: 'help-pane', role: 'tabpanel', id: 'help-pane-legend', 'aria-labelledby': 'help-tab-legend' },
      h('p', { class: 'lead', text: 'The scene is a true map: the Sun at the centre, distances in proportion, time running at the speed you choose.' }),
      h('ul', { class: 'legend' }, LEGEND.map(([cls, name, text]) => h('li', null, h('span', { class: `sw ${cls}`, 'aria-hidden': 'true' }), h('div', null, h('strong', { text: name }), h('p', { text })))))),
    keys: h('div', { class: 'help-pane', role: 'tabpanel', id: 'help-pane-keys', 'aria-labelledby': 'help-tab-keys' },
      h('div', { class: 'keys' }, keyRows),
      h('p', { class: 'footnote', text: 'Shortcuts are paused while you type in a text field. Small key badges on the toolbar buttons show the same letters.' })),
    about: h('div', { class: 'help-pane', role: 'tabpanel', id: 'help-pane-about', 'aria-labelledby': 'help-tab-about' }, aboutContent),
  };
  const TABS = [
    { id: 'gestures', label: 'Gestures & touch' },
    { id: 'legend', label: 'What you are looking at' },
    { id: 'keys', label: 'Keyboard shortcuts' },
    { id: 'about', label: 'About & sources' },
  ];
  let currentTab = 'gestures';
  const tabButtons = TABS.map((t) => h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `help-tab-${t.id}`, 'aria-controls': `help-pane-${t.id}`, 'aria-selected': 'false', tabindex: '-1', text: t.label,
    onclick: () => show(t.id),
  }));
  const tablist = h('div', { class: 'tabs dialog-tabs', role: 'tablist', 'aria-label': 'Help sections' }, tabButtons);
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.id === currentTab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = TABS.length - 1;
    if (j < 0) return;
    e.preventDefault(); e.stopPropagation();
    show(TABS[j].id);
    tabButtons[j].focus();
  });
  const body = h('div', { class: 'dialog-body' }, Object.values(panels));
  const dialog = h('div', { class: 'dialog help-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title', tabindex: '-1' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'help-title', text: 'Help' }), btnClose),
    tablist,
    body);
  helpEl.classList.add('dialog-backdrop');
  helpEl.replaceChildren(dialog);
  helpEl.hidden = true;

  function show(id) {
    if (!panels[id]) return;
    currentTab = id;
    for (const t of TABS) {
      const on = t.id === id;
      panels[t.id].hidden = !on;
      const b = tabButtons[TABS.indexOf(t)];
      setAttr(b, 'aria-selected', on ? 'true' : 'false');
      setAttr(b, 'tabindex', on ? '0' : '-1');
    }
    body.scrollTop = 0;
  }
  show(currentTab);

  let helpOpen = false;
  let lastFocus = null;
  const onHelpKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); help.close(); return; }
    if (e.key === 'Tab') trapFocusIn(dialog, e);
  };
  helpEl.addEventListener('pointerdown', (e) => { if (e.target === helpEl) help.close(); });
  btnClose.addEventListener('click', () => help.close());
  const help = {
    /** @param {string} [tab] */
    open(tab) {
      if (tab) show(tab);
      if (helpOpen) return;
      helpOpen = true; lastFocus = document.activeElement; helpEl.hidden = false;
      dialog.addEventListener('keydown', onHelpKey);
      dialog.focus({ preventScroll: true });
    },
    close() { if (!helpOpen) return; helpOpen = false; helpEl.hidden = true; dialog.removeEventListener('keydown', onHelpKey); if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true }); },
    toggle() { if (helpOpen) help.close(); else help.open(); },
    isOpen: () => helpOpen,
    show,
  };

  /** Calendar-year step (Alt + arrows): main.js's actions.stepYears when wired, else the same arithmetic locally. */
  const stepYears = (n) => {
    if (typeof actions.stepYears === 'function') actions.stepYears(n);
    else actions.setJd?.(addCalendarYears(getState().jdUtc, n));
  };

  // --- key handling
  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey) return;
    const typing = isTypingTarget(e);
    const key = e.key;
    const s = getState();
    const storyRunning = !!s.story;
    if (key === 'Escape') {
      if (typing) { /** @type {HTMLElement} */ (e.target).blur(); return; }
      if (closeOverlays()) { e.preventDefault(); return; }
      if (storyRunning) return; // the story engine (main.js) stops the tour on Escape
      if (s.cameraMode === 'flyby' || s.cameraMode === 'tour') actions.cancel?.();
      else if (s.beamPartner) actions.setBeamPartner?.(null);
      else if (s.activeEventId) clearEvent?.();
      else if (s.selected) actions.select?.(null);
      else actions.cancel?.(); // follow / sky view → free camera
      e.preventDefault();
      return;
    }
    if (typing) return;
    if (key === '?' || (key === '/' && e.shiftKey)) { e.preventDefault(); help.toggle(); return; }
    if (helpOpen) return;
    if (storyRunning && (key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight')) return; // story controls (main.js)
    let handled = true;
    switch (key) {
      case ' ': actions.toggle?.(); break;
      case '[': case ']': {
        const i = nearestRateIndex(s.rate);
        const j = Math.max(0, Math.min(RATE_PRESETS.length - 1, i + (key === ']' ? 1 : -1)));
        actions.setRate?.((s.rate < 0 ? -1 : 1) * RATE_PRESETS[j].days);
        break;
      }
      case 'ArrowLeft': case 'ArrowRight': {
        const dir = key === 'ArrowLeft' ? -1 : 1;
        if (e.altKey) stepYears(dir);
        else actions.step?.(dir * (e.shiftKey ? 7 : 1));
        break;
      }
      case 'Home': actions.resetHome?.(); break;
      case '.': actions.step?.((s.playing ? s.rate : (s.rate || 1)) / 60); break;
      default: {
        const k = key.length === 1 ? key.toLowerCase() : key;
        if (k >= '0' && k <= '8' && key.length === 1) {
          const ids = bodyIds(getProviders());
          const id = ids[+k];
          if (id) actions.select?.(id);
        } else if (k === 't') actions.now?.();
        else if (k === 'f') { if (s.selected) actions.flyTo?.(s.selected); else toast?.('Pick a planet first (tap one, or press 0–8)'); }
        else if (k === 'v') { if (s.selected && s.selected !== 'earth') actions.skyView?.(s.selected); else toast?.('Pick a body other than Earth to see it in Earth’s sky'); }
        else if (k === 'l') actions.setSettings?.({ showLabels: !s.settings.showLabels });
        else if (k === 'o') actions.setSettings?.({ showOrbits: !s.settings.showOrbits });
        else if (k === 'g') actions.setSettings?.({ showGrid: !s.settings.showGrid });
        else if (k === 'p') actions.toggleSizeK?.();
        else handled = false;
      }
    }
    if (handled) e.preventDefault();
  }
  window.addEventListener('keydown', onKeyDown);

  return {
    help,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      help.close();
      helpEl.replaceChildren();
    },
  };
}
