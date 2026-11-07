// createUI({ store, actions, providers, root }) → { update(), dispose(), toast(msg), muteToasts(on), announce(text),
//   beat(), setProviders(p), showLoadError(msg), panel, help, settings, about }
// Plain DOM, no framework. Subscribes to the store and re-renders at most 10 Hz; UI never mutates physics — every
// change goes through `actions`. `providers` may be null while the data module loads (all reads are guarded).
// Actions that main.js may not have wired yet (openTours, playTour, share, snapshot, stepYears, clearEvent,
// toggleScientistMode) are called through optional chaining with a working fallback, so nothing here can throw.
import { h, svg, setAttr, setText, bodyName, installTooltips } from './dom.js';
import { createToast } from './toast.js';
import { createHud } from './hud.js';
import { createTimeline } from './timeline.js';
import { createPanel } from './panel.js';
import { createBodiesTab } from './bodiesTab.js';
import { createEventsTab } from './eventsTab.js';
import { createDistancesTab } from './distancesTab.js';
import { createFlybyTab } from './flybyTab.js';
import { createSettings } from './settings.js';
import { createAboutContent } from './about.js';
import { createShortcuts } from './shortcuts.js';
import { modeMessage, LOADING_FACTS, shareCopiedMessage, PROVENANCE_LINE } from './copy.js';
import { buildShareUrl } from '../app/share.js';

/** Minimum interval between two UI renders (10 Hz). */
export const RENDER_INTERVAL_MS = 100;
/** Loading-screen fact rotation period (ms). */
const FACT_MS = 4200;

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
  tours: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6"/>',
  snapshot: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};

/**
 * @param {object} opts
 * @param {ReturnType<import('../app/state.js').createStore>} opts.store
 * @param {object} opts.actions  play, pause, toggle, setRate, setJd, now, step, stepYears?, select, follow, flyTo, skyView,
 *   tour?, playTour?, openTours?, cancel, resetHome, setBeamPartner, goToEvent, viewEvent, clearEvent?, setSettings,
 *   toggleSizeK, toggleScientistMode?, share?, snapshot?, playIntro?
 * @param {object|(() => object|null)|null} [opts.providers]  bodyIds, bodyName, bodyColour, bodyInfo, distances, events,
 *   scannedYears?, periodDays?, cameraInfo?, cameraPose?, format; may be null while loading
 * @param {HTMLElement} [opts.root]  element containing the static shell (#hud, #toolbar, #panel, #timeline, #toast, #help, #loading, #live)
 * @returns {{
 *   update: () => void, dispose: () => void, toast: (msg: string, opts?: object) => void, muteToasts: (on?: boolean) => void,
 *   announce: (text: string) => void, beat: () => void, setProviders: (p: object|null) => void,
 *   showLoadError: (message: string) => void, panel: ReturnType<typeof createPanel>,
 *   help: { open: (tab?: string) => void, close: () => void, toggle: () => void, isOpen: () => boolean },
 *   settings: ReturnType<typeof createSettings>, about: { open: () => void, close: () => void, isOpen: () => boolean },
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
    if (!canvas.hasAttribute('aria-label')) canvas.setAttribute('aria-label', '3D view of the solar system. Drag to look around, pinch or scroll to zoom, tap a planet to select it. Press ? for help.');
  }

  // Render-loop state (declared before any sub-module can call renderNow through a callback).
  let timer = 0;
  let lastRender = 0;
  let disposed = false;
  let ready = false;
  let prevLoading = null;
  let prevMode = null;
  let prevEventsStatus = null;

  // --- polite live region for things the 10 Hz HUD must not announce (arrivals while toasts are muted, scan done).
  const live = shell('live');
  live.classList.add('sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  let liveTimer = 0;
  function announce(text) {
    if (!text) return;
    clearTimeout(liveTimer);
    setText(live, '');
    liveTimer = setTimeout(() => setText(live, text), 50); // clear-then-set re-triggers identical announcements
  }

  const toast = createToast({ el: shell('toast'), onSuppressed: (msg) => announce(msg) });
  const hud = createHud({ el: shell('hud'), getProviders, actions });
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
  const shareAction = () => { if (typeof actions.share === 'function') actions.share(); else shareFallback(); };
  const bodiesTab = createBodiesTab({ el: tabEl('bodies'), actions, getProviders, onShare: shareAction });
  const requestRender = () => schedule();
  const eventsTab = createEventsTab({ el: tabEl('events'), actions, getProviders, getState, requestRender });
  const distancesTab = createDistancesTab({ el: tabEl('distances'), actions, getProviders, requestRender });
  const flybyTab = createFlybyTab({ el: tabEl('flyby'), actions, getProviders, requestRender });
  const tabViews = { bodies: bodiesTab, events: eventsTab, distances: distancesTab, flyby: flybyTab };
  const panel = createPanel({
    el: panelEl,
    tabs: [
      { id: 'bodies', label: 'Bodies', el: tabEl('bodies'), hint: 'Where every planet is, how far, how fast, and what it looks like from Earth' },
      { id: 'events', label: 'Events', el: tabEl('events'), hint: 'Oppositions, conjunctions, line-ups and other things worth watching' },
      { id: 'distances', label: 'Distances', el: tabEl('distances'), hint: 'How far everything is from the selected body — in km and in light-time' },
      { id: 'flyby', label: 'Fly', el: tabEl('flyby'), hint: 'Faster-than-light flights to any planet, and the grand tour' },
    ],
    onChange: () => { if (ready) renderNow(); },
  });

  // --- help (with About) and settings
  const closeOverlays = () => {
    let closed = false;
    if (settings.isOpen()) { settings.close(); closed = true; }
    if (shortcuts.help.isOpen()) { shortcuts.help.close(); closed = true; }
    return closed;
  };
  const clearEvent = () => { if (typeof actions.clearEvent === 'function') actions.clearEvent(); else store.set({ activeEventId: null }); };
  const shortcuts = createShortcuts({
    actions, getProviders, getState, helpEl: shell('help'), closeOverlays, clearEvent,
    toast: (m) => toast.show(m), aboutContent: createAboutContent(),
  });
  const help = shortcuts.help;
  const settings = createSettings({ root, actions, getState, onAbout: () => help.open('about'), onHelp: () => help.open('gestures') });

  // --- toolbar
  const toolbarEl = shell('toolbar');
  toolbarEl.classList.add('glass');
  toolbarEl.setAttribute('role', 'toolbar');
  toolbarEl.setAttribute('aria-label', 'View controls');
  /** Icon button with an optional small key badge (shown on fine pointers by CSS). */
  const tb = (icon, attrs, key = null) => h('button', { class: 'icon-btn', type: 'button', ...attrs }, svg(ICONS[icon]), key ? h('span', { class: 'key', text: key, 'aria-hidden': 'true' }) : null);
  const openTours = () => {
    if (typeof actions.openTours === 'function') actions.openTours();
    else if (typeof actions.playTour === 'function') actions.playTour('welcome');
    else if (typeof actions.playIntro === 'function') actions.playIntro();
    else toast.show('Tours are not available in this build', { kind: 'warn' });
  };
  const snapshot = () => {
    if (typeof actions.snapshot === 'function') actions.snapshot();
    else toast.show('Snapshots are not available in this build', { kind: 'warn' });
  };
  const btnTours = tb('tours', { 'aria-label': 'Tours', 'data-tip': 'Guided tours: Welcome, the planets, alignments, scale & light', onclick: openTours });
  const btnShare = tb('share', { 'aria-label': 'Share this view', 'data-tip': 'Copy a link to this exact view, date and time', onclick: shareAction });
  const btnSnapshot = tb('snapshot', { 'aria-label': 'Save a snapshot', 'data-tip': 'Save a picture of the scene', class: 'icon-btn optional', onclick: snapshot });
  const btnSettings = tb('settings', { 'aria-label': 'Settings', 'data-tip': 'Settings', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-settings-toggle': '', onclick: () => settings.toggle() });
  const btnLabels = tb('labels', { 'aria-label': 'Names on the planets', 'data-tip': 'Names on / off (L)', 'aria-pressed': 'true', 'aria-keyshortcuts': 'L', class: 'icon-btn optional-sm', onclick: () => actions.setSettings?.({ showLabels: !getState().settings.showLabels }) }, 'L');
  const btnOrbits = tb('orbits', { 'aria-label': 'Orbit trails', 'data-tip': 'Orbit trails on / off (O)', 'aria-pressed': 'true', 'aria-keyshortcuts': 'O', class: 'icon-btn optional-sm', onclick: () => actions.setSettings?.({ showOrbits: !getState().settings.showOrbits }) }, 'O');
  const btnGrid = tb('grid', { 'aria-label': '1 AU ring and grid', 'data-tip': '1 AU ring and grid on / off (G)', 'aria-pressed': 'true', 'aria-keyshortcuts': 'G', class: 'icon-btn optional', onclick: () => actions.setSettings?.({ showGrid: !getState().settings.showGrid }) }, 'G');
  const btnSize = tb('size', { 'aria-label': 'Planet size: enlarged or true scale', 'data-tip': 'Enlarged planets ⇄ true scale (P)', 'aria-pressed': 'false', 'aria-keyshortcuts': 'P', onclick: () => actions.toggleSizeK?.() }, 'P');
  const btnPanel = tb('panel', { 'aria-label': 'Show or hide the details panel', 'data-tip': 'Details panel', 'aria-pressed': 'true', class: 'icon-btn optional', onclick: () => setPanelCollapsed(!panelCollapsed) });
  const btnFull = tb('fullscreen', { 'aria-label': 'Fullscreen', 'data-tip': 'Fullscreen', 'aria-pressed': 'false', class: 'icon-btn optional', onclick: () => toggleFullscreen() });
  const btnHelp = tb('help', { 'aria-label': 'Help', 'data-tip': 'Help: gestures, what you see, keys, sources (?)', 'aria-keyshortcuts': '?', onclick: () => help.toggle() }, '?');
  toolbarEl.replaceChildren(btnTours, btnShare, btnSnapshot, btnSettings, btnLabels, btnOrbits, btnGrid, btnSize, btnPanel, btnFull, btnHelp);
  let panelCollapsed = false;
  /** Collapse / restore the details panel (the toolbar button and a running story both use this). @param {boolean} on */
  function setPanelCollapsed(on) {
    panelCollapsed = !!on;
    panel.setCollapsed(panelCollapsed);
    setAttr(btnPanel, 'aria-pressed', panelCollapsed ? 'false' : 'true');
  }

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

  /** Share without main.js: build the link from the store and the camera pose provider, copy it. */
  async function shareFallback() {
    let cam = null;
    try { cam = getProviders()?.cameraPose?.() ?? null; } catch { cam = null; }
    const url = buildShareUrl(getState(), cam);
    try {
      await navigator.clipboard.writeText(url);
      toast.show(shareCopiedMessage(), { kind: 'success', critical: true });
    } catch {
      toast.show('Copying is blocked here — allow clipboard access and try again', { kind: 'warn' });
    }
  }

  // --- tooltips ([data-tip]) for mouse, keyboard and touch
  const disposeTooltips = installTooltips(root);

  // --- loading screen: rotating fact line + error state
  const loadingEl = shell('loading');
  const factEl = loadingEl.querySelector('[data-fact]');
  const provEl = loadingEl.querySelector('.prov');
  if (provEl && !provEl.textContent.trim()) setText(provEl, PROVENANCE_LINE);
  let factIndex = 0;
  let factTimer = 0;
  if (factEl && LOADING_FACTS.length > 1) {
    factTimer = setInterval(() => {
      factIndex = (factIndex + 1) % LOADING_FACTS.length;
      factEl.classList.add('is-fading');
      setTimeout(() => { setText(factEl, LOADING_FACTS[factIndex]); factEl.classList.remove('is-fading'); }, 300);
    }, FACT_MS);
  }
  function stopFacts() { if (factTimer) { clearInterval(factTimer); factTimer = 0; } }
  /** @param {string} message */
  function showLoadError(message) {
    stopFacts();
    loadingEl.classList.remove('is-hidden');
    loadingEl.classList.add('is-error');
    loadingEl.removeAttribute('aria-hidden');
    setAttr(loadingEl, 'aria-busy', null);
    let box = loadingEl.querySelector('#load-error');
    if (!box) {
      box = h('div', { id: 'load-error', role: 'alert' }, h('p', { class: 'msg' }), h('button', { class: 'btn primary', type: 'button', text: 'Try again' }));
      (loadingEl.querySelector('.load-inner') ?? loadingEl).append(box);
    }
    const msg = box.querySelector('.msg') ?? box;
    setText(msg, message || 'Something went wrong while loading the planet data.');
    const btn = box.querySelector('button');
    if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', () => location.reload()); }
    box.hidden = false;
    /** @type {HTMLElement|null} */ (btn)?.focus?.({ preventScroll: true });
  }

  // --- render loop (≤ 10 Hz)
  function applyDocumentFlags(s) {
    const html = document.documentElement;
    const rm = s.settings?.reducedMotion ?? 'auto';
    if (rm === 'auto') { if (html.hasAttribute('data-reduced-motion')) html.removeAttribute('data-reduced-motion'); }
    else setAttr(html, 'data-reduced-motion', rm);
    setAttr(html, 'data-low-dpr', (s.pixelRatio ?? 1) < 1 ? '1' : null);
    setAttr(html, 'data-scientist', s.settings?.scientistMode ? '1' : null);
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
      if (!loadingEl.classList.contains('is-error')) {
        loadingEl.classList.toggle('is-hidden', !s.loading);
        setAttr(loadingEl, 'aria-busy', s.loading ? 'true' : null);
        if (!s.loading) { loadingEl.setAttribute('aria-hidden', 'true'); stopFacts(); }
      }
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
    setAttr(btnSettings, 'aria-expanded', settings.isOpen() ? 'true' : 'false');
    setAttr(btnTours, 'aria-pressed', s.story ? 'true' : 'false');

    // Mode-change toasts (arrival messages are main.js's; this covers follow/free transitions on key input).
    if (prevMode !== null && s.cameraMode !== prevMode && !s.story) {
      if (s.cameraMode === 'follow' && s.followed && prevMode !== 'flyby' && prevMode !== 'tour') toast.show(modeMessage('follow', bodyName(p, s.followed)), { key: 'mode' });
      else if (s.cameraMode === 'free' && (prevMode === 'follow' || prevMode === 'skyView')) toast.show(modeMessage('free'), { key: 'mode' });
    }
    prevMode = s.cameraMode;

    // Event scan: announce completion once, warn once when the worker failed.
    if (prevEventsStatus !== null && s.eventsStatus !== prevEventsStatus) {
      if (s.eventsStatus === 'ready' && prevEventsStatus === 'scanning') {
        let years = null;
        try { years = p?.scannedYears?.() ?? null; } catch { years = null; }
        announce(Array.isArray(years) && years.length ? `Events ready for ${years[0]} to ${years[years.length - 1]}` : 'Events ready');
      } else if (s.eventsStatus === 'error') {
        toast.show('Events are unavailable right now: the event scanner could not start', { kind: 'warn', key: 'events-error', ms: 8000 });
      }
    }
    prevEventsStatus = s.eventsStatus;
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
    /** Show a toast (queue, 4 s, role=status). opts.muted / opts.critical: see toast.js. */
    toast: (msg, opts) => toast.show(msg, opts),
    /** Silence non-critical toasts while a tour runs (its captions are drawn by the story bar). */
    muteToasts: (on = true) => toast.mute(on),
    /** Polite screen-reader announcement with no visual (arrivals during a tour, scan completion). */
    announce,
    /** Light-speed beat: flash the speed in the HUD and the Fly tab. */
    beat() { hud.beat(); flybyTab.beat(); },
    /** Swap the providers object once the data module has loaded. */
    setProviders(p) { prov = p; renderNow(); },
    /** Data-load failure: keep the loading screen, replace the spinner with the message and a reload button. */
    showLoadError,
    /** Details panel visibility (a story clears the stage and restores it afterwards). */
    setPanelCollapsed,
    isPanelCollapsed: () => panelCollapsed,
    panel,
    help,
    settings,
    about: { open: () => help.open('about'), close: () => help.close(), isOpen: () => help.isOpen() },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(liveTimer);
      stopFacts();
      unsubscribe();
      document.removeEventListener('fullscreenchange', onFullscreen);
      disposeTooltips();
      shortcuts.dispose();
      settings.dispose();
      panel.dispose();
      bodiesTab.dispose(); eventsTab.dispose(); distancesTab.dispose(); flybyTab.dispose();
      timeline.dispose();
      hud.dispose();
      toast.dispose();
      toolbarEl.replaceChildren();
    },
  };
}
