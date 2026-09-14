// Keyboard shortcuts (plan §UI): Space play/pause · [ ] rate · ← → ∓1 d (Shift 7 d, Alt 365.25 d) · T now ·
// 0–8 select Sun…Neptune · F fly · V sky view · Esc cancel/close · Home reset · L/O/G toggles · P size toggle ·
// . step one frame · ? help. Ignored while typing in inputs. Also the "?" help overlay.
import { h, isTypingTarget, bodyIds, trapFocusIn } from './dom.js';
import { RATE_PRESETS, nearestRateIndex } from './timeline.js';

/** Rows of the help overlay: [keys[], description]. */
export const KEYMAP = Object.freeze([
  [['Space'], 'Play / pause'],
  [['[', ']'], 'Slower / faster time rate'],
  [['←', '→'], 'Step −1 / +1 day (Shift: 7 days, Alt: 1 year)'],
  [['T'], 'Jump to now'],
  [['0', '…', '8'], 'Select Sun, Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune'],
  [['F'], 'Fly to the selected body'],
  [['V'], 'Sky view from Earth toward the selected body'],
  [['Esc'], 'Cancel a fly-by / close dialogs / clear the selection'],
  [['Home'], 'Reset the home view'],
  [['L'], 'Toggle labels'],
  [['O'], 'Toggle orbits'],
  [['G'], 'Toggle the grid'],
  [['P'], 'Toggle planet size exaggeration'],
  [['.'], 'Step one frame of simulated time'],
  [['?'], 'This help'],
  [['Shift', 'click'], 'Set the second end of the distance beam'],
  [['Wheel on the scrub bar'], '±1 day (Shift: ±30 days)'],
]);

/**
 * @param {object} opts
 * @param {object} opts.actions
 * @param {() => object|null} opts.getProviders
 * @param {() => import('../app/state.js').AppState} opts.getState
 * @param {HTMLElement} opts.helpEl  #help
 * @param {() => boolean} opts.closeOverlays  close any open popover/dialog; returns true when something was closed
 * @param {(msg: string) => void} [opts.toast]
 * @returns {{ help: { open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean }, dispose: () => void }}
 */
export function createShortcuts({ actions, getProviders, getState, helpEl, closeOverlays, toast }) {
  // --- help overlay
  const btnClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close help', title: 'Close (Esc)' });
  btnClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const rows = KEYMAP.flatMap(([keys, desc]) => [
    h('div', null, keys.map((k, i) => [i > 0 ? h('span', { class: 'faint', text: k === '…' ? ' … ' : ' ' }) : null, k === '…' ? null : h('kbd', { text: k })])),
    h('div', { text: desc }),
  ]);
  const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title', tabindex: '-1' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'help-title', text: 'Keyboard shortcuts' }), btnClose),
    h('div', { class: 'dialog-body' },
      h('div', { class: 'keys' }, rows),
      h('p', { class: 'footnote', text: 'Mouse: drag to orbit, wheel to zoom (toward the cursor in free view), click a body or label to select it, double-click / double-tap to fly there. Shortcuts are ignored while typing in a field.' })));
  helpEl.classList.add('dialog-backdrop');
  helpEl.replaceChildren(dialog);
  helpEl.hidden = true;

  let helpOpen = false;
  let lastFocus = null;
  const onHelpKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); help.close(); return; }
    if (e.key === 'Tab') trapFocusIn(dialog, e);
  };
  helpEl.addEventListener('pointerdown', (e) => { if (e.target === helpEl) help.close(); });
  btnClose.addEventListener('click', () => help.close());
  const help = {
    open() { if (helpOpen) return; helpOpen = true; lastFocus = document.activeElement; helpEl.hidden = false; dialog.addEventListener('keydown', onHelpKey); dialog.focus({ preventScroll: true }); },
    close() { if (!helpOpen) return; helpOpen = false; helpEl.hidden = true; dialog.removeEventListener('keydown', onHelpKey); if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true }); },
    toggle() { if (helpOpen) help.close(); else help.open(); },
    isOpen: () => helpOpen,
  };

  // --- key handling
  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey) return;
    const typing = isTypingTarget(e);
    const key = e.key;
    if (key === 'Escape') {
      if (typing) { /** @type {HTMLElement} */ (e.target).blur(); return; }
      if (closeOverlays()) { e.preventDefault(); return; }
      const s = getState();
      if (s.cameraMode === 'flyby' || s.cameraMode === 'tour') actions.cancel?.();
      else if (s.beamPartner) actions.setBeamPartner?.(null);
      else if (s.activeEventId) actions.cancel?.();
      else if (s.selected) actions.select?.(null);
      else actions.cancel?.();
      e.preventDefault();
      return;
    }
    if (typing) return;
    if (key === '?' || (key === '/' && e.shiftKey)) { e.preventDefault(); help.toggle(); return; }
    if (helpOpen) return;
    const s = getState();
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
        const d = e.altKey ? 365.25 : e.shiftKey ? 7 : 1;
        actions.step?.(key === 'ArrowLeft' ? -d : d);
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
        else if (k === 'f') { if (s.selected) actions.flyTo?.(s.selected); else toast?.('Select a body first (keys 0–8)'); }
        else if (k === 'v') { if (s.selected && s.selected !== 'earth') actions.skyView?.(s.selected); else toast?.('Select a body other than Earth for the sky view'); }
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
