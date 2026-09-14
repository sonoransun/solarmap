// createUI({ store, actions, providers, root }) → { update(), dispose(), toast(msg), beat(), setProviders(p), panel, help }
// Plain DOM, no framework. Subscribes to the store and re-renders at most 10 Hz; UI never mutates physics — every
// change goes through `actions`. `providers` may be null while the data module loads (all reads are guarded).
import { h, svg, setAttr, bodyName, getFormat } from './dom.js';
import { createToast } from './toast.js';
import { createHud } from './hud.js';
import { createTimeline } from './timeline.js';
import { createPanel } from './panel.js';
import { createBodiesTab } from './bodiesTab.js';
import { createEventsTab } from './eventsTab.js';
import { createDistancesTab } from './distancesTab.js';
import { createFlybyTab } from './flybyTab.js';
import { createSettings } from './settings.js';
import { createAbout } from './about.js';
import { createShortcuts } from './shortcuts.js';

/** Minimum interval between two UI renders (10 Hz). */
export const RENDER_INTERVAL_MS = 100;

const ICONS = {
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  labels: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8" cy="8" r="1.5"/>',
  orbits: '<ellipse cx="12" cy="12" rx="9" ry="4"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="10" r="1.5"/>',
  grid: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M3 12h18M12 3v18"/>',
  size: '<circle cx="9" cy="14" r="5"/><circle cx="17" cy="8" r="2.5"/><path d="M17 3v2M17 11v2M12 8h2M20 8h2"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  exitFullscreen: '<path d="M9 4v5H4M15 9V4h5M20 15h-5v5M4 15h5v5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4"/><path d="M12 17v.01"/>',
};

/**
 * @param {object} opts
 * @param {ReturnType<import('../app/state.js').createStore>} opts.store
 * @param {object} opts.actions  play, pause, toggle, setRate, setJd, now, step, select, follow, flyTo, skyView, tour,
 *   cancel, resetHome, setBeamPartner, goToEvent, viewEvent, setSettings, toggleSizeK
 * @param {object|(() => object|null)|null} [opts.providers]  bodyIds, bodyName, bodyColour, bodyInfo, distances, events,
 *   format, cameraInfo (optional: () → { distAu, speedC }); may be null while loading
 * @param {HTMLElement} [opts.root]  element containing the static shell (#hud, #toolbar, #panel, #timeline, #toast, #help, #loading)
 * @returns {{
 *   update: () => void, dispose: () => void, toast: (msg: string, opts?: object) => void, beat: () => void,
 *   setProviders: (p: object|null) => void, panel: ReturnType<typeof createPanel>, help: { open: () => void, close: () => void, toggle: () => void },
 *   settings: ReturnType<typeof createSettings>, about: ReturnType<typeof createAbout>,
 * }}
 */
export function createUI({ store, actions, providers = null, root = document.body }) {
  let prov = typeof providers === 'function' ? null : providers;
  const getProviders = () => (typeof providers === 'function' ? providers() : prov);
  const getState = () => store.get();

  /** Find a shell element by id or create it. @param {string} id @param {string} [tag] */
  const shell = (id, tag = 'div') => {
    let el = root.querySelector(`#${id}`);
    if (!el) { el = document.createElement(tag); el.id = id; root.append(el); }
    return /** @type {HTMLElement} */ (el);
  };
  const canvas = root.querySelector('#gl');
  if (canvas) {
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    if (!canvas.hasAttribute('aria-label')) canvas.setAttribute('aria-label', '3D view of the solar system. Drag to orbit, wheel to zoom, keys 0–8 select bodies, ? lists shortcuts.');
  }

  // Render-loop state (declared before any sub-module can call renderNow through a callback).
  let timer = 0;
  let lastRender = 0;
  let disposed = false;
  let ready = false;
  let prevLoading = null;
  let prevMode = null;
  let prevFollowed = null;

  const toast = createToast({ el: shell('toast') });
  const hud = createHud({ el: shell('hud'), getProviders });
  const timeline = createTimeline({ el: shell('timeline'), actions, getProviders, getState });

  // Tabs: reuse the static tabpanel elements when the shell has them.
  const panelEl = shell('panel', 'aside');
  const tabEls = new Map();
  const tabEl = (id) => {
    if (tabEls.has(id)) return tabEls.get(id);
    let el = panelEl.querySelector(`#tabpanel-${id}`);
    if (!el) { el = document.createElement('div'); el.id = `tabpanel-${id}`; }
    tabEls.set(id, el);
    return /** @type {HTMLElement} */ (el);
  };
  const bodiesTab = createBodiesTab({ el: tabEl('bodies'), actions, getProviders });
  const requestRender = () => schedule();
  const eventsTab = createEventsTab({ el: tabEl('events'), actions, getProviders, getState, requestRender });
  const distancesTab = createDistancesTab({ el: tabEl('distances'), actions, getProviders, requestRender });
  const flybyTab = createFlybyTab({ el: tabEl('flyby'), actions, getProviders, requestRender });
  const tabViews = { bodies: bodiesTab, events: eventsTab, distances: distancesTab, flyby: flybyTab };
  const panel = createPanel({
    el: panelEl,
    tabs: [
      { id: 'bodies', label: 'Bodies', el: tabEl('bodies'), hint: 'Positions, distances and orientation of every body' },
      { id: 'events', label: 'Events', el: tabEl('events'), hint: 'Oppositions, conjunctions, elongations, parades…' },
      { id: 'distances', label: 'Distances', el: tabEl('distances'), hint: 'Distance table from the selected body' },
      { id: 'flyby', label: 'Fly-by', el: tabEl('flyby'), hint: 'Faster-than-light camera fly-bys and the grand tour' },
    ],
    onChange: () => { if (ready) renderNow(); },
  });

  const about = createAbout({ root });
  const settings = createSettings({ root, actions, getState, onAbout: () => about.open() });

  // --- toolbar
  const toolbarEl = shell('toolbar');
  toolbarEl.classList.add('glass');
  toolbarEl.setAttribute('role', 'toolbar');
  toolbarEl.setAttribute('aria-label', 'View controls');
  const tb = (icon, attrs) => h('button', { class: 'icon-btn', type: 'button', ...attrs }, svg(ICONS[icon]));
  const btnSettings = tb('settings', { 'aria-label': 'Settings', title: 'Settings', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-settings-toggle': '', onclick: () => settings.toggle() });
  const btnLabels = tb('labels', { 'aria-label': 'Toggle labels', title: 'Labels (L)', 'aria-pressed': 'true', 'aria-keyshortcuts': 'L', onclick: () => actions.setSettings?.({ showLabels: !getState().settings.showLabels }) });
  const btnOrbits = tb('orbits', { 'aria-label': 'Toggle orbits', title: 'Orbits (O)', 'aria-pressed': 'true', 'aria-keyshortcuts': 'O', onclick: () => actions.setSettings?.({ showOrbits: !getState().settings.showOrbits }) });
  const btnGrid = tb('grid', { 'aria-label': 'Toggle grid', title: 'Grid (G)', 'aria-pressed': 'true', 'aria-keyshortcuts': 'G', class: 'icon-btn optional', onclick: () => actions.setSettings?.({ showGrid: !getState().settings.showGrid }) });
  const btnSize = tb('size', { 'aria-label': 'Toggle planet size exaggeration', title: 'Planet size (P)', 'aria-pressed': 'false', 'aria-keyshortcuts': 'P', onclick: () => actions.toggleSizeK?.() });
  const btnPanel = tb('panel', { 'aria-label': 'Toggle the details panel', title: 'Panel', 'aria-pressed': 'true', class: 'icon-btn optional', onclick: () => { panelCollapsed = !panelCollapsed; panel.setCollapsed(panelCollapsed); setAttr(btnPanel, 'aria-pressed', panelCollapsed ? 'false' : 'true'); } });
  const btnFull = tb('fullscreen', { 'aria-label': 'Toggle fullscreen', title: 'Fullscreen', 'aria-pressed': 'false', class: 'icon-btn optional', onclick: () => toggleFullscreen() });
  const btnHelp = tb('help', { 'aria-label': 'Keyboard shortcuts and help', title: 'Help (?)', 'aria-keyshortcuts': '?', onclick: () => shortcuts.help.toggle() });
  toolbarEl.replaceChildren(btnSettings, btnLabels, btnOrbits, btnGrid, btnSize, btnPanel, btnFull, btnHelp);
  let panelCollapsed = false;

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    } catch { toast.show('Fullscreen is not available here', { kind: 'warn' }); }
  }
  const onFullscreen = () => {
    const on = !!document.fullscreenElement;
    setAttr(btnFull, 'aria-pressed', on ? 'true' : 'false');
    btnFull.replaceChildren(svg(ICONS[on ? 'exitFullscreen' : 'fullscreen']));
  };
  document.addEventListener('fullscreenchange', onFullscreen);

  // --- shortcuts + help
  const closeOverlays = () => {
    let closed = false;
    if (settings.isOpen()) { settings.close(); closed = true; }
    if (about.isOpen()) { about.close(); closed = true; }
    if (shortcuts.help.isOpen()) { shortcuts.help.close(); closed = true; }
    return closed;
  };
  const shortcuts = createShortcuts({ actions, getProviders, getState, helpEl: shell('help'), closeOverlays, toast: (m) => toast.show(m) });

  // --- loading ring
  const loadingEl = shell('loading');

  // --- event-crossing toasts (score ≥ filter), checked every 500 ms while playing at ≤ 1 month/s.
  let crossFrom = NaN;
  let crossAt = 0;
  function checkCrossings(s) {
    const p = getProviders();
    if (!p?.events || !s.playing || Math.abs(s.rate) > 30.436875 + 1e-9) { crossFrom = s.jdUtc; return; }
    if (!Number.isFinite(crossFrom)) { crossFrom = s.jdUtc; return; }
    const now = Date.now();
    if (now - crossAt < 500) return;
    crossAt = now;
    const a = Math.min(crossFrom, s.jdUtc); const b = Math.max(crossFrom, s.jdUtc);
    crossFrom = s.jdUtc;
    if (b - a <= 0 || b - a > 400) return;
    const minScore = s.settings?.eventMinScore ?? 40;
    let evs = [];
    try { evs = p.events({ jd0: a, jd1: b, minScore }) || []; } catch { evs = []; }
    if (!Array.isArray(evs)) return;
    for (const ev of evs) {
      const jd = ev?.jdUtc ?? ev?.jdTT;
      if (!Number.isFinite(jd) || jd < a || jd > b || (ev.score ?? 0) < minScore) continue;
      toast.show(`${ev.label || ev.kind} · ${getFormat(p).utc(jd)}`, { key: `ev:${ev.id ?? jd}` });
      break;
    }
  }

  // --- render loop (≤ 10 Hz)
  function applyDocumentFlags(s) {
    const html = document.documentElement;
    const rm = s.settings?.reducedMotion ?? 'auto';
    if (rm === 'auto') { if (html.hasAttribute('data-reduced-motion')) html.removeAttribute('data-reduced-motion'); }
    else setAttr(html, 'data-reduced-motion', rm);
    setAttr(html, 'data-low-dpr', (s.pixelRatio ?? 1) < 1 ? '1' : null);
  }

  function renderNow() {
    if (disposed) return;
    clearTimeout(timer); timer = 0;
    lastRender = performance.now();
    const s = store.get();
    const p = getProviders();
    applyDocumentFlags(s);

    if (s.loading !== prevLoading) {
      prevLoading = s.loading;
      loadingEl.classList.toggle('is-hidden', !s.loading);
      setAttr(loadingEl, 'aria-busy', s.loading ? 'true' : null);
      if (!s.loading) loadingEl.setAttribute('aria-hidden', 'true');
    }
    hud.update(s);
    timeline.update(s);
    tabViews[panel.current()]?.update(s);
    settings.update(s);

    const st = s.settings;
    setAttr(btnLabels, 'aria-pressed', st.showLabels ? 'true' : 'false');
    setAttr(btnOrbits, 'aria-pressed', st.showOrbits ? 'true' : 'false');
    setAttr(btnGrid, 'aria-pressed', st.showGrid ? 'true' : 'false');
    setAttr(btnSize, 'aria-pressed', Math.abs((st.sizeK ?? 1) - 1) > 1e-9 ? 'true' : 'false');
    setAttr(btnSize, 'title', `Planet size (P) — currently ×${Math.round(st.sizeK ?? 1)}`);
    setAttr(btnSettings, 'aria-expanded', settings.isOpen() ? 'true' : 'false');

    // Mode-change toasts (arrival message is the camera rig's; this covers follow/free transitions on key input).
    if (prevMode !== null && s.cameraMode !== prevMode) {
      if (s.cameraMode === 'follow' && s.followed && prevMode !== 'flyby' && prevMode !== 'tour') toast.show(`Following ${bodyName(p, s.followed)}`, { key: 'mode' });
      else if (s.cameraMode === 'free' && (prevMode === 'follow' || prevMode === 'skyView')) toast.show('Free view', { key: 'mode' });
    }
    prevMode = s.cameraMode; prevFollowed = s.followed;

    checkCrossings(s);
  }

  function schedule() {
    if (disposed || timer) return;
    const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - lastRender));
    timer = setTimeout(renderNow, wait);
  }

  const unsubscribe = store.subscribe(() => schedule());
  ready = true;
  renderNow();

  return {
    /** Request a re-render (coalesced to ≤ 10 Hz). */
    update: schedule,
    /** Show a toast (queue, 4 s, role=status). */
    toast: (msg, opts) => toast.show(msg, opts),
    /** Light-speed beat: flash the "c" glyph in the HUD and the Fly-by tab. */
    beat() { hud.beat(); flybyTab.beat(); },
    /** Swap the providers object once the data module has loaded. */
    setProviders(p) { prov = p; renderNow(); },
    panel,
    help: shortcuts.help,
    settings,
    about,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('fullscreenchange', onFullscreen);
      shortcuts.dispose();
      settings.dispose();
      about.dispose();
      panel.dispose();
      bodiesTab.dispose(); eventsTab.dispose(); distancesTab.dispose(); flybyTab.dispose();
      timeline.dispose();
      hud.dispose();
      toast.dispose();
      toolbarEl.replaceChildren();
      void prevFollowed;
    },
  };
}
