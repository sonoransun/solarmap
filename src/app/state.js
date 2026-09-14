// Tiny observable store shared by the clock, renderer, camera and UI. No dependencies.
// The state is plain data; modules subscribe and react. Settings are persisted to localStorage (guarded).

/**
 * @typedef {'sun'|'mercury'|'venus'|'earth'|'mars'|'jupiter'|'saturn'|'uranus'|'neptune'} BodyId
 * @typedef {'free'|'follow'|'skyView'|'flyby'|'tour'} CameraMode
 * @typedef {'high'|'low'} Quality
 *
 * @typedef {object} Settings
 * @property {number} sizeK            planet size exaggeration (1 = true scale; Sun uses min(sizeK, 30))
 * @property {number} lastSizeK        last non-1 value for the P toggle
 * @property {boolean} showOrbits
 * @property {boolean} showLabels
 * @property {boolean} showGrid
 * @property {Quality} quality
 * @property {'auto'|'on'|'off'} reducedMotion
 * @property {boolean} keepRateDuringFlyby   disable automatic sim-rate easing during fly-bys
 * @property {boolean} spinCap               cap the sim rate while close to a spinning body
 * @property {boolean} showOrientationDebug  draw axis / prime meridian / sub-solar dot
 * @property {boolean} introOnLoad           play the guided tour when the page loads
 * @property {boolean} photoSurfaces         photographic surface maps (off = procedural surfaces)
 * @property {number} eventMinScore          Events tab notability filter (0–100)
 *
 * @typedef {object} FlybyStatus
 * @property {BodyId} target
 * @property {BodyId|null} from
 * @property {number} tau            0…1 progress
 * @property {number} speedC         true speed in multiples of c
 * @property {number} lightMinutesToTarget
 * @property {'warp'|'minjerk'} kind
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
 * @property {'idle'|'scanning'|'ready'} eventsStatus
 * @property {number} eventsProgress       0…1
 * @property {boolean} reducedAccuracy     year outside the verified band 1600–2600
 * @property {boolean} intro               the guided tour is running
 * @property {number} pixelRatio           current render DPR
 * @property {Settings} settings
 */

const SETTINGS_KEY = 'solarmap.settings.v1';

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  sizeK: 1,
  lastSizeK: 50,
  showOrbits: true,
  showLabels: true,
  showGrid: true,
  quality: 'high',
  reducedMotion: 'auto',
  keepRateDuringFlyby: false,
  spinCap: true,
  showOrientationDebug: false,
  introOnLoad: true,
  photoSurfaces: true,
  eventMinScore: 40,
};

/** @returns {Settings} */
export function loadSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
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
      const settings = { ...state.settings, ...patch };
      saveSettings(settings);
      this.set({ settings });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
