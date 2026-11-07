// Tiny observable store shared by the clock, renderer, camera and UI. No dependencies, no DOM (localStorage is
// touched only through guarded globalThis reads). The state is plain data; modules subscribe and react. Settings are
// persisted under a versioned key and sanitised on load, so a stale or hand-edited entry can never break the app.

/**
 * @typedef {'sun'|'mercury'|'venus'|'earth'|'mars'|'jupiter'|'saturn'|'uranus'|'neptune'|'moon'} BodyId
 * @typedef {'free'|'follow'|'skyView'|'flyby'|'tour'} CameraMode
 * @typedef {'high'|'low'} Quality
 *
 * @typedef {object} Settings
 * @property {number} sizeK            planet size exaggeration (1 = true scale; Sun uses min(sizeK, 30)). First run: 50,
 *                                     so the home view shows planets instead of invisible dots; the HUD badge toggles true scale.
 * @property {number} lastSizeK        last non-1 value, restored by the P key / badge toggle
 * @property {boolean} showOrbits
 * @property {boolean} showLabels
 * @property {boolean} showGrid        the 1 AU ring and ecliptic grid
 * @property {boolean} showStars       Yale Bright Star Catalogue points
 * @property {boolean} showMilkyWay    Milky Way shell
 * @property {boolean} showMoon        the Moon (Meeus ch. 47 position)
 * @property {boolean} showStarNames   names of the brightest stars in sky view (contract alias: showConstellationNames)
 * @property {boolean} showConstellationNames  read-only mirror of showStarNames for render code written against spec-contracts.md
 * @property {Quality} quality
 * @property {'auto'|'on'|'off'} reducedMotion
 * @property {boolean} keepRateDuringFlyby   disable automatic sim-rate easing during fly-bys
 * @property {boolean} spinCap               cap the sim rate while close to a spinning body
 * @property {boolean} showOrientationDebug  draw axis / prime meridian / sub-solar dot
 * @property {boolean} introOnLoad           play the Welcome tour when the page loads
 * @property {boolean} photoSurfaces         photographic surface maps (default on; off = procedural surfaces)
 * @property {number} eventMinScore          Events tab notability floor (0–100), exposed as a slider in scientist mode
 * @property {boolean} scientistMode         JD/ΔT line, RA/Dec, osculating elements, raw event filter, symbols
 *
 * @typedef {object} FlybyStatus
 * @property {BodyId} target
 * @property {BodyId|null} from
 * @property {number} tau            0…1 progress
 * @property {number} speedC         true speed in multiples of c
 * @property {number} lightMinutesToTarget
 * @property {'warp'|'minjerk'} kind
 *
 * @typedef {object} StoryStatus   written by src/app/story.js (workstream A)
 * @property {string} tourId
 * @property {number} index
 * @property {number} count
 * @property {'playing'|'paused'} status
 * @property {number} progress       0…1
 * @property {string} [title]
 * @property {string} [caption]
 * @property {string} [detail]
 * @property {boolean} [holding]
 *
 * @typedef {object} SkyStatus     written by the camera rig (workstream C)
 * @property {string} from
 * @property {string[]} to
 * @property {number} fovDeg
 * @property {boolean} locked
 *
 * @typedef {object} AppState
 * @property {boolean} loading
 * @property {number} jdUtc
 * @property {number} jdTT
 * @property {number} deltaT           seconds
 * @property {boolean} deltaTAssumed
 * @property {boolean} playing
 * @property {number} rate             days of sim time per real second (sign = direction)
 * @property {BodyId|null} selected
 * @property {BodyId|null} followed
 * @property {CameraMode} cameraMode
 * @property {FlybyStatus|null} flyby
 * @property {BodyId|null} beamPartner     second body of the distance beam (first = selected)
 * @property {string|null} activeEventId   event whose overlay is drawn
 * @property {'idle'|'scanning'|'ready'|'error'} eventsStatus   'error' = the worker failed to start or crashed
 * @property {number} eventsProgress       0…1
 * @property {boolean} reducedAccuracy     year outside the verified band 1600–2600
 * @property {boolean} intro               legacy flag of the old intro tour (replaced by `story`)
 * @property {StoryStatus|null} story      the running tour, or null
 * @property {SkyStatus|null} sky          the sky view in progress, or null
 * @property {boolean} texturesLoaded      photographic maps arrived
 * @property {boolean} hiddenPaused        paused because the tab was hidden
 * @property {number} pixelRatio           current render DPR
 * @property {Settings} settings
 */

/** Current persisted-settings schema; the key carries it so an old entry is migrated, never trusted blindly. */
export const SETTINGS_VERSION = 2;
const SETTINGS_KEY = `solarmap.settings.v${SETTINGS_VERSION}`;
const LEGACY_SETTINGS_KEY = 'solarmap.settings.v1';

/** @type {Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  sizeK: 50,
  lastSizeK: 50,
  showOrbits: true,
  showLabels: true,
  showGrid: true,
  showStars: true,
  showMilkyWay: true,
  showMoon: true,
  showStarNames: false,
  showConstellationNames: false,
  quality: 'high',
  reducedMotion: 'auto',
  keepRateDuringFlyby: false,
  spinCap: true,
  showOrientationDebug: false,
  introOnLoad: true,
  photoSurfaces: true,
  eventMinScore: 40,
  scientistMode: false,
});

/** Allowed ranges / enumerations of the non-boolean settings. */
const NUMBER_RANGES = Object.freeze({ sizeK: [1, 1000], lastSizeK: [1, 1000], eventMinScore: [0, 100] });
const ENUMS = Object.freeze({ quality: ['high', 'low'], reducedMotion: ['auto', 'on', 'off'] });

/**
 * Keep the contract alias in step: render code may read `showConstellationNames` (spec-contracts.md) while the UI
 * writes `showStarNames`. Whichever key a patch sets wins; the other follows.
 * @param {Settings} s
 * @param {Partial<Settings>} [patch]
 * @returns {Settings}
 */
function withAlias(s, patch = {}) {
  const v = 'showStarNames' in patch ? !!patch.showStarNames
    : 'showConstellationNames' in patch ? !!patch.showConstellationNames
      : !!s.showStarNames;
  return { ...s, showStarNames: v, showConstellationNames: v };
}

/**
 * Validate a settings-like object key by key: unknown keys are dropped, wrong types and out-of-range values fall
 * back to the defaults. Pure.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
  /** @type {Settings} */
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return withAlias(out);
  const src = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in src)) continue;
    const v = src[key];
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'boolean') { if (typeof v === 'boolean') out[key] = v; continue; }
    if (typeof def === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      const [lo, hi] = NUMBER_RANGES[key] || [-Infinity, Infinity];
      if (Number.isFinite(n) && n >= lo && n <= hi) out[key] = n;
      continue;
    }
    if (ENUMS[key] && ENUMS[key].includes(v)) out[key] = v;
  }
  if (out.lastSizeK === 1) out.lastSizeK = DEFAULT_SETTINGS.lastSizeK; // the toggle needs a non-1 value to return to
  return withAlias(out, 'showStarNames' in src ? { showStarNames: src.showStarNames } : 'showConstellationNames' in src ? { showConstellationNames: src.showConstellationNames } : {});
}

/**
 * Upgrade a v1 entry: v1 defaulted sizeK to 1 (true scale), which made the home view invisible dots; a stored 1 is
 * treated as "never changed" and takes the new default (true scale stays one tap away on the HUD badge). Explicit
 * other values are kept. `labelDensity` is dropped (unused). Pure.
 * @param {unknown} v1
 * @returns {Settings}
 */
export function migrateSettingsV1(v1) {
  const src = v1 && typeof v1 === 'object' ? { .../** @type {object} */ (v1) } : {};
  if (src.sizeK === 1) delete src.sizeK;
  delete src.labelDensity;
  return sanitizeSettings(src);
}

/** @returns {Settings} */
export function loadSettings() {
  let storage = null;
  try { storage = globalThis.localStorage ?? null; } catch { storage = null; }
  if (!storage) return sanitizeSettings(null);
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch { /* corrupt entry: fall through to the legacy key / defaults */ }
  try {
    const legacy = storage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy) {
      const migrated = migrateSettingsV1(JSON.parse(legacy));
      saveSettings(migrated);
      try { storage.removeItem(LEGACY_SETTINGS_KEY); } catch { /* ignore */ }
      return migrated;
    }
  } catch { /* corrupt legacy entry */ }
  return sanitizeSettings(null);
}

/** @param {Settings} settings */
export function saveSettings(settings) {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: ignore */
  }
}

/**
 * @param {Partial<AppState>} [initial]
 * @returns {{
 *   get: () => AppState,
 *   set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
 *   setSettings: (patch: Partial<Settings>) => void,
 *   subscribe: (fn: (state: AppState, changed: Set<string>) => void) => () => void,
 * }}
 */
export function createStore(initial = {}) {
  /** @type {AppState} */
  let state = {
    loading: true,
    jdUtc: 2451545.0,
    jdTT: 2451545.0,
    deltaT: 64.184,
    deltaTAssumed: false,
    playing: true,
    rate: 1,
    selected: null,
    followed: null,
    cameraMode: 'free',
    flyby: null,
    beamPartner: null,
    activeEventId: null,
    eventsStatus: 'idle',
    eventsProgress: 0,
    reducedAccuracy: false,
    intro: false,
    story: null,
    sky: null,
    texturesLoaded: false,
    hiddenPaused: false,
    pixelRatio: 1,
    settings: loadSettings(),
    ...initial,
  };
  const listeners = new Set();
  let scheduled = false;
  const changed = new Set();

  function flush() {
    scheduled = false;
    const keys = new Set(changed);
    changed.clear();
    for (const fn of listeners) fn(state, keys);
  }

  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      let any = false;
      for (const k of Object.keys(p)) {
        if (state[k] !== p[k]) { any = true; changed.add(k); }
      }
      if (!any) return;
      state = { ...state, ...p };
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
    },
    setSettings(patch) {
      const settings = withAlias({ ...state.settings, ...patch }, patch);
      saveSettings(settings);
      this.set({ settings });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
