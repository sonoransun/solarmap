// Story engine: runs a tour (an ordered list of chapters) from the frame loop. Pure: no DOM, no three.js, no timers and
// no Date.now — every duration is advanced by the `dt` main.js passes to update(), so a hidden tab, a paused loop or a
// test harness all see the same sequencing. Tours themselves are data (src/app/tours.js).
//
// Two-phase chapter start (spec-contracts §"Story engine"): a chapter may jump the clock AND move the camera. The clock
// part (jdUtc / rate / play-pause / settings) runs inside update(dt), BEFORE main.js recomputes the body states for the
// frame; update() then returns a closure (`pendingCamera`) that main.js invokes AFTER `states = eph.states(jdTT)`, so
// every camera action (fly, frame, sky view) is planned against the positions of the new instant, never stale ones.
//
// Holds: a chapter with `hold: 'arrived' | 'poseDone' | 'skyReady'` does not start its dwell timer until main.js
// forwards the matching rig signal through notify(); the wait is capped (HOLD_CAP_S) so a missing signal can never
// stall a tour. Under reduced motion the rig cuts instead of flying, so holds are capped at HOLD_CAP_REDUCED_S and
// every caption stays REDUCED_MOTION_EXTRA_S longer.
//
// Snapshot / restore: play() records the rate, play state, selection, distance beam and (lazily) every setting a
// chapter overrides; stop() puts back only what the tour changed and the user has not changed since (the comparison
// is against the last value the tour itself set). The clock's INSTANT is never restored: a finished tour ends at
// "now" by design (its finale sets it), and a tour the user leaves early stays at the moment being shown so they can
// explore it — only a paused clock the user had before is given back.
import * as fallbackFormat from '../astro/format.js';
import { angleBetween } from '../astro/vec.js';
import { TOURS } from './tours.js';

/** Longest wait for a rig signal before a chapter proceeds anyway, per hold type (seconds). A warp fly-by across the
 * system lasts up to ≈ 10 s (flyby.js duration law); pose and sky-view eases are ≤ 1.5 s by the rig contract. */
export const HOLD_CAP_S = Object.freeze({ arrived: 12, poseDone: 2.5, skyReady: 2.5 });
/** Hold cap under reduced motion: the rig fades 0.25 s, cuts, fades 0.25 s (camera.js FADE_S), so 1.5 s is generous. */
export const HOLD_CAP_REDUCED_S = 1.5;
/** Extra reading time per caption under reduced motion (spec-story-engine §Reduced motion: "captions + 1.5 s"). */
export const REDUCED_MOTION_EXTRA_S = 1.5;
/** How long the centred title card of a tour's first chapter stays up (spec-story-engine: "fades after ~2.5 s"). */
export const TITLE_CARD_S = 2.5;
/** Refresh period of a chapter's live detail line (story seconds). 2 Hz keeps numbers alive without flicker. */
export const LIVE_INTERVAL_S = 0.5;
/** Nominal hold durations used only for the duration estimate shown in the Tours menu (seconds). */
export const HOLD_NOMINAL_S = Object.freeze({ arrived: 4, poseDone: 1.2, skyReady: 1 });
/** prev(): restart the current chapter when it has run at least this long, else go to the previous one (media rule). */
export const PREV_RESTART_S = 3;
/** Largest real-time step accepted per frame (a resumed tab must not skip chapters). Same cap as main.js / camera.js. */
const MAX_DT = 0.25;

/**
 * @typedef {object} StoryCtx  what chapters receive (see createStory for the construction)
 * @typedef {object} Chapter
 * @property {string} id                     unique within the tour
 * @property {string} [title]                short chapter title (title row, aria announcement)
 * @property {string|((ctx: StoryCtx) => string)} caption   one plain sentence, ≤ 110 characters
 * @property {string} [detail]               second line (muted), ≤ 140 characters; used when `live` is absent or empty
 * @property {(ctx: StoryCtx) => string} [live]  computed detail line, refreshed every LIVE_INTERVAL_S
 * @property {number} seconds                dwell after the hold resolves (real seconds)
 * @property {number|((ctx: StoryCtx) => number|undefined)} [jdUtc]  jump the clock here first (clock phase)
 * @property {number} [rate]                 sim rate request (days per real second; eased by main.js)
 * @property {boolean} [paused]              pause (true) or play (false) the clock; undefined leaves it alone
 * @property {'arrived'|'poseDone'|'skyReady'} [hold]  wait for this rig signal before the dwell starts
 * @property {number} [holdCapS]             override of HOLD_CAP_S for this chapter
 * @property {Record<string, any>} [settings]  temporary settings overrides (restored when no longer requested)
 * @property {(ctx: StoryCtx) => (void|boolean)} [run]  camera / scene actions (camera phase); `false` cancels the hold
 * @property {(ctx: StoryCtx) => void} [arrived]  called once when the hold resolves (e.g. start an orbit dwell)
 * @property {(ctx: StoryCtx) => void} [end]   called when the chapter is left (next chapter, stop)
 * @property {{ t: number, run: (ctx: StoryCtx) => void }[]} [cues]  timed actions during the dwell (t in seconds)
 * @property {boolean} [keep]                keep the previous chapter's overlay, beam and dwell
 * @property {boolean} [card]                show the centred title card (set on chapter 0 of every tour)
 *
 * @typedef {object} Tour
 * @property {string} id
 * @property {string} title
 * @property {string} tagline
 * @property {Chapter[]} chapters
 *
 * @typedef {object} StoryState  store patch `{ story }` (spec-contracts §Store)
 * @property {string} tourId
 * @property {string} tourTitle
 * @property {string} tagline
 * @property {string} chapterId
 * @property {string} title            chapter title
 * @property {number} index
 * @property {number} count
 * @property {'playing'|'paused'} status
 * @property {number} progress         0…1 over the whole tour
 * @property {number} chapterProgress  0…1 within the chapter's dwell
 * @property {string} caption
 * @property {string} detail
 * @property {boolean} holding         waiting for a rig signal
 * @property {boolean} card            the title card is up
 * @property {string|null} pausedBy    'user' | 'interaction' | 'hidden' | … while paused
 * @property {number} seq              increments on every chapter start (one aria announcement per chapter)
 */

/**
 * Estimated running time of a tour: dwell seconds plus a nominal wait per hold (the real hold depends on the flight).
 * @param {Tour} tour
 * @returns {number} seconds
 */
export function estimateDurationS(tour) {
  let s = 0;
  for (const ch of tour.chapters) s += (ch.seconds || 0) + (ch.hold ? (HOLD_NOMINAL_S[ch.hold] ?? 2) : 0);
  return s;
}

/**
 * Lay-friendly duration for the Tours menu: '≈ 1 min', '≈ 1½ min', '≈ 2½ min' (rounded to the nearest half minute).
 * @param {number} seconds
 * @returns {string}
 */
export function formatTourDuration(seconds) {
  const halves = Math.max(2, Math.round(seconds / 30)); // in half-minutes, never below "1 min"
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 0) return '≈ ½ min';
  return `≈ ${whole}${half ? '½' : ''} min`;
}

const FORMAT_KEYS = Object.freeze({
  utc: 'formatUtc', jd: 'formatJd', deltaT: 'formatDeltaT', distance: 'formatDistance', au: 'formatAu', km: 'formatKm',
  lightTime: 'formatLightTime', speed: 'formatSpeed', kmPerS: 'formatKmPerS', deg: 'formatDeg', angle: 'formatAngle',
  lonLat: 'formatLonLat', period: 'formatPeriod', rate: 'formatRate',
});

/**
 * Formatting functions for chapter text: providers.format when present, astro/format.js otherwise (per key, same
 * shape as ui/dom.js getFormat so chapters can be written against one API).
 * @param {object|null|undefined} providers
 * @returns {Record<string, (...a: any[]) => string>}
 */
export function formatFor(providers) {
  const out = {};
  for (const k of Object.keys(FORMAT_KEYS)) out[k] = fallbackFormat[FORMAT_KEYS[k]];
  const f = providers?.format;
  if (f) for (const k of Object.keys(f)) if (typeof f[k] === 'function') out[k] = f[k];
  return out;
}

/**
 * Create the story engine.
 * @param {object} deps
 * @param {{ get: () => any, set: (patch: any) => void }} deps.store
 * @param {{ setJd: (jd: number) => any, setRate: (r: number) => void, play: () => void, pause: () => void,
 *           jd: () => number, rate: () => number, playing: () => boolean, target?: () => number }} deps.clock
 *        setRate is EASED by main.js (rate ramp); `target` returns the ramp target so a rate still easing toward the
 *        story's request is not mistaken for a user change (falls back to rate()).
 * @param {() => any} deps.rig            camera rig getter (null until the scene exists)
 * @param {() => void} deps.sync          push the clock state into the store after clock mutations
 * @param {() => boolean} deps.isReducedMotion
 * @param {() => number} deps.nowJd       JD(UTC) of the wall clock
 * @param {{ showAlignment: (ev: { kind: string, bodies: string[], label?: string }) => void, hide: () => void }} [deps.overlays]
 * @param {(id: string|null) => void} [deps.select]
 * @param {(a: string|null, b?: string|null) => void} [deps.beam]  distance beam a→b (selected = a); beam(null) clears it
 * @param {{ get: () => Record<string, any>, set: (patch: Record<string, any>) => void }} [deps.settings]
 *        temporary overrides: `set` should NOT persist to localStorage (main.js: store.set({ settings }))
 * @param {object|(() => object|null)|null} [deps.providers]  main.js providers (bodyInfo, distances, format, cameraInfo,
 *        separationDeg?, bodyState?) — read lazily, may be null while loading
 * @param {Tour[]} [deps.tours]           defaults to the curated TOURS
 * @param {(reason: string) => void} [deps.onStop]
 * @returns {{
 *   play: (tourId: string, opts?: { index?: number }) => boolean,
 *   pause: (reason?: string) => boolean, resume: () => boolean, toggle: () => boolean,
 *   next: () => boolean, prev: () => boolean, stop: (reason?: string) => boolean,
 *   update: (dt: number) => (() => void)|null,
 *   notify: (evt: string|{ type: string, id?: string }, payload?: any) => boolean,
 *   state: () => (object|null), list: () => { id: string, title: string, tagline: string, durationS: number, chapters: number }[],
 *   active: () => boolean, status: () => 'idle'|'playing'|'paused', tourId: () => string|null, lastReason: () => string|null,
 * }}
 */
export function createStory({
  store, clock, rig, sync, isReducedMotion, nowJd, overlays = null, select = null, beam = null, settings = null,
  providers = null, tours = TOURS, onStop = null,
}) {
  const getProviders = () => (typeof providers === 'function' ? providers() : providers);
  const getRig = () => (typeof rig === 'function' ? rig() : rig) ?? null;

  // ---- engine state --------------------------------------------------------------------------------------------------
  /** @type {Tour|null} */
  let tour = null;
  let index = -1;
  /** @type {'idle'|'playing'|'paused'} */
  let status = 'idle';
  let queued = -1;            // chapter to start on the next update (two-phase start, also used by play/next/prev)
  let cameraPending = false;  // clock phase done, camera phase not yet run
  let elapsed = 0;            // dwell seconds (after the hold)
  let chapterT = 0;           // seconds since the chapter started (incl. hold), for the title card
  let chapterSeconds = 0;     // effective dwell (reduced motion adds REDUCED_MOTION_EXTRA_S)
  let reducedNow = false;
  /** @type {{ type: string, t: number, cap: number }|null} */
  let holding = null;
  let liveT = 0;
  let cueIdx = 0;
  let caption = '';
  let detail = '';
  let title = '';
  let pausedBy = null;
  let clockPausedByStory = false; // pause() stopped a running clock; resume()/stop() give it back
  let seq = 0;
  let lastReason = null;
  const memo = {};

  // Snapshot of what the tour may change (taken in play(), consumed in stop()).
  const snap = { rate: 1, playing: true, selected: null, beamPartner: null, settings: /** @type {Record<string, any>} */ ({}) };
  /** @type {Record<string, any>} current settings overrides (key → the value the tour set) */
  const overrides = {};
  let rateSet = false;        // the tour requested at least one rate
  let lastRateSet = NaN;
  let selectionSet = false;
  let lastSelected = null;
  let beamSet = false;
  let lastBeam = null;

  // Last published store patch (publish only on visible change; one small object per publish).
  const pub = { index: -2, status: '', holding: false, caption: '', detail: '', q: -1, qc: -1, card: false, pausedBy: null, seq: -1 };

  // ---- helpers ---------------------------------------------------------------------------------------------------------
  const current = () => (tour && index >= 0 ? tour.chapters[index] : null);
  const count = () => (tour ? tour.chapters.length : 0);

  function text(v) {
    if (typeof v === 'function') { try { const s = v(ctx); return typeof s === 'string' ? s : ''; } catch { return ''; } }
    return typeof v === 'string' ? v : '';
  }
  function liveDetail(ch) {
    if (ch.live) { const s = text(ch.live); if (s) return s; }
    return ch.detail ?? '';
  }
  function rateTarget() {
    try { if (typeof clock.target === 'function') { const t = clock.target(); if (Number.isFinite(t)) return t; } } catch { /* optional */ }
    return clock.rate();
  }

  // ---- chapter context -------------------------------------------------------------------------------------------------
  /** @type {StoryCtx} */
  const ctx = {
    memo,
    nowJd: () => nowJd(),
    reduced: () => reducedNow,
    chapterSeconds: () => chapterSeconds,
    state: () => store.get(),
    rig: getRig,
    get format() { return formatFor(getProviders()); },
    /** @param {string} id */
    bodyInfo(id) { try { return getProviders()?.bodyInfo?.(id) ?? null; } catch { return null; } },
    /** @param {string} a @param {string} b @returns {number} AU or NaN */
    distanceAu(a, b) {
      try {
        const rows = getProviders()?.distances?.(a);
        if (Array.isArray(rows)) { const r = rows.find((x) => x.id === b); if (r) return r.au; }
      } catch { /* not ready */ }
      return NaN;
    },
    /** Angle between two bodies as seen from a third (degrees; NaN when unavailable). */
    separationDeg(from, a, b) {
      try {
        const p = getProviders();
        if (typeof p?.separationDeg === 'function') { const d = p.separationDeg(from, a, b); if (Number.isFinite(d)) return d; }
        if (typeof p?.bodyState === 'function') {
          const o = p.bodyState(from), u = p.bodyState(a), v = p.bodyState(b);
          if (o && u && v) {
            return angleBetween([u.x - o.x, u.y - o.y, u.z - o.z], [v.x - o.x, v.y - o.y, v.z - o.z]) * 180 / Math.PI;
          }
        }
      } catch { /* not ready */ }
      return NaN;
    },
    flyby: () => store.get()?.flyby ?? null,
    cameraInfo() { try { return getProviders()?.cameraInfo?.() ?? null; } catch { return null; } },
    // Camera choreography (rig additions per spec-contracts §Camera rig; every call tolerates an older rig).
    flyTo(id, opts) { const r = getRig(); return r?.flyTo ? r.flyTo(id, opts) !== false : false; },
    follow(id, opts) { const r = getRig(); if (r?.follow) { r.follow(id, opts); return true; } return false; },
    skyView(from, to, opts) { const r = getRig(); if (r?.skyView) { r.skyView(from, to, opts); return true; } return false; },
    setSkyFov(fovDeg, seconds) { const r = getRig(); if (r?.setSkyFov) { r.setSkyFov(fovDeg, seconds); return true; } return false; },
    exitSkyView(seconds) { const r = getRig(); if (r?.exitSkyView) { r.exitSkyView(seconds); return true; } if (r?.free) { r.free(); return true; } return false; },
    frameBodies(ids, opts = {}) {
      const r = getRig();
      if (!r) return false;
      if (r.frameBodies) { r.frameBodies(ids, opts); return true; }
      if (r.frameTopDown) {
        // Older rig: bounding sphere about the Sun from the heliocentric distances (includeSun implied).
        let radius = 1.5;
        for (const id of ids) { const au = ctx.bodyInfo(id)?.rSunAu; if (Number.isFinite(au)) radius = Math.max(radius, au * (opts.margin ?? 1.25)); }
        r.frameTopDown({ center: [0, 0, 0], radius, seconds: opts.seconds ?? 1.5, polarDeg: opts.polarDeg ?? 20 });
        return true;
      }
      return false;
    },
    dollyTo(distanceAu, seconds) { const r = getRig(); if (r?.dollyTo) { r.dollyTo(distanceAu, seconds); return true; } return false; },
    orbitDwell(opts) { const r = getRig(); if (reducedNow || !r?.orbitDwell) return false; r.orbitDwell(opts); return true; },
    stopDwell() { const r = getRig(); if (r?.stopDwell) r.stopDwell(); },
    resetHome() { const r = getRig(); if (r?.resetHome) { r.resetHome(); return true; } return false; },
    cancel() { const r = getRig(); if (r?.cancel) r.cancel(); },
    /** @param {string|null} id */
    select(id) { if (!select) return; selectionSet = true; lastSelected = id; select(id); },
    /** @param {string|null} a @param {string|null} [b] */
    beam(a, b = null) { if (!beam) return; beamSet = true; lastBeam = a == null ? null : b; if (a != null) { selectionSet = true; lastSelected = a; } beam(a, b); },
    /** @param {{ kind: string, bodies: string[], label?: string }|null} ev */
    overlay(ev) { if (!overlays) return; if (ev) overlays.showAlignment(ev); else overlays.hide(); },
    /** Eased sim-rate request outside the chapter header (e.g. from a cue). @param {number} r days per real second */
    setRate(r) { rateSet = true; lastRateSet = r; clock.setRate(r); sync(); },
  };

  // ---- settings overrides ----------------------------------------------------------------------------------------------
  /**
   * Apply a chapter's temporary settings: keys no longer requested go back to their pre-tour value (unless the user
   * changed them meanwhile), new keys are recorded once with their original value.
   * @param {Record<string, any>|undefined} next
   */
  function applySettings(next) {
    if (!settings) return;
    const cur = settings.get() ?? {};
    const patch = {};
    let any = false;
    for (const key of Object.keys(overrides)) {
      if (next && Object.prototype.hasOwnProperty.call(next, key)) continue;
      if (cur[key] === overrides[key]) { patch[key] = snap.settings[key]; any = true; }
      delete overrides[key];
      delete snap.settings[key];
    }
    if (next) {
      for (const key of Object.keys(next)) {
        const value = next[key];
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          if (overrides[key] === value) continue;          // same override as before: nothing to do
          if (cur[key] !== overrides[key]) { delete overrides[key]; delete snap.settings[key]; } // user changed it meanwhile
        }
        const base = Object.prototype.hasOwnProperty.call(overrides, key) ? snap.settings[key] : cur[key];
        if (base === value) { delete overrides[key]; delete snap.settings[key]; continue; } // already what we want
        if (!Object.prototype.hasOwnProperty.call(overrides, key)) snap.settings[key] = cur[key];
        overrides[key] = value;
        patch[key] = value;
        any = true;
      }
    }
    if (any) settings.set(patch);
  }

  /** Put back every override the tour still owns (stop). */
  function restoreSettings() {
    if (!settings) return;
    const cur = settings.get() ?? {};
    const patch = {};
    let any = false;
    for (const key of Object.keys(overrides)) {
      if (cur[key] === overrides[key]) { patch[key] = snap.settings[key]; any = true; }
      delete overrides[key];
      delete snap.settings[key];
    }
    if (any) settings.set(patch);
  }

  // ---- chapter phases --------------------------------------------------------------------------------------------------
  /** Phase 1 (inside update, before the states are recomputed): leave the old chapter, clock + settings of the new. */
  function startChapterClock(i) {
    const prev = current();
    if (prev && i !== index) { try { prev.end?.(ctx); } catch (err) { console.error('[story] chapter end failed', err); } }
    const ch = tour.chapters[i];
    index = i;
    elapsed = 0; chapterT = 0; liveT = 0; cueIdx = 0; holding = null;
    reducedNow = !!isReducedMotion();
    chapterSeconds = (ch.seconds || 0) + (reducedNow ? REDUCED_MOTION_EXTRA_S : 0);
    seq += 1;
    applySettings(ch.settings);
    let jd = ch.jdUtc;
    if (typeof jd === 'function') { try { jd = jd(ctx); } catch { jd = undefined; } }
    if (Number.isFinite(jd)) clock.setJd(jd);
    if (ch.rate !== undefined) { rateSet = true; lastRateSet = ch.rate; clock.setRate(ch.rate); }
    if (ch.paused === true) { clock.pause(); clockPausedByStory = false; }
    else if (ch.paused === false) {
      // A chapter wants the clock running; while the STORY is paused we only remember the wish.
      if (status === 'paused') clockPausedByStory = true; else { clock.play(); clockPausedByStory = false; }
    }
    sync();
    cameraPending = true;
    title = ch.title ?? '';
    publish();
  }

  /** Phase 2 (after the states are recomputed): overlays, text, camera actions, hold. Same function object every frame. */
  function cameraPhase() {
    if (!cameraPending || status === 'idle') return;
    cameraPending = false;
    const ch = current();
    if (!ch) return;
    if (!ch.keep) {
      ctx.overlay(null);
      if (beamSet && store.get()?.beamPartner != null) ctx.beam(null);
      ctx.stopDwell();
    }
    caption = text(ch.caption);
    detail = liveDetail(ch);
    let ran = true;
    try { if (ch.run?.(ctx) === false) ran = false; } catch (err) { console.error('[story] chapter run failed', err); ran = false; }
    if (ch.hold && ran && getRig()) {
      const cap = ch.holdCapS ?? HOLD_CAP_S[ch.hold] ?? HOLD_CAP_S.arrived;
      holding = { type: ch.hold, t: 0, cap: reducedNow ? Math.min(cap, HOLD_CAP_REDUCED_S) : cap };
    } else if (ch.arrived) {
      try { ch.arrived(ctx); } catch (err) { console.error('[story] chapter arrived failed', err); }
    }
    publish();
  }

  function resolveHold() {
    if (!holding) return;
    holding = null;
    const ch = current();
    if (ch?.arrived) { try { ch.arrived(ctx); } catch (err) { console.error('[story] chapter arrived failed', err); } }
    publish();
  }

  // ---- store patch -----------------------------------------------------------------------------------------------------
  function publish(force = false) {
    if (status === 'idle' || !tour) return;
    const n = count();
    const ch = current();
    const cp = chapterSeconds > 0 ? Math.min(1, elapsed / chapterSeconds) : 0;
    const q = Math.round(((Math.max(index, 0) + cp) / Math.max(n, 1)) * 400) / 400;
    const qc = Math.round(cp * 100) / 100;
    const card = !!(ch?.card && chapterT < TITLE_CARD_S);
    const isHolding = !!holding;
    if (!force && pub.index === index && pub.status === status && pub.holding === isHolding && pub.caption === caption
      && pub.detail === detail && pub.q === q && pub.qc === qc && pub.card === card && pub.pausedBy === pausedBy && pub.seq === seq) return;
    pub.index = index; pub.status = status; pub.holding = isHolding; pub.caption = caption; pub.detail = detail;
    pub.q = q; pub.qc = qc; pub.card = card; pub.pausedBy = pausedBy; pub.seq = seq;
    store.set({
      story: {
        tourId: tour.id, tourTitle: tour.title, tagline: tour.tagline ?? '', chapterId: ch?.id ?? '', title,
        index: Math.max(index, 0), count: n, status: /** @type {'playing'|'paused'} */ (status), progress: q, chapterProgress: qc,
        caption, detail, holding: isHolding, card, pausedBy, seq,
      },
    });
  }

  // ---- snapshot / restore ----------------------------------------------------------------------------------------------
  function takeSnapshot() {
    const s = store.get() ?? {};
    snap.rate = clock.rate();
    snap.playing = clock.playing();
    snap.selected = s.selected ?? null;
    snap.beamPartner = s.beamPartner ?? null;
    for (const k of Object.keys(snap.settings)) delete snap.settings[k];
    for (const k of Object.keys(overrides)) delete overrides[k];
    for (const k of Object.keys(memo)) delete memo[k];
    rateSet = false; lastRateSet = NaN;
    selectionSet = false; lastSelected = null;
    beamSet = false; lastBeam = null;
    clockPausedByStory = false;
  }

  function restore() {
    const s = store.get() ?? {};
    restoreSettings();
    ctx.overlay(null);
    if (beamSet && (s.beamPartner ?? null) === lastBeam && beam) {
      if (snap.beamPartner) beam(snap.selected, snap.beamPartner); else if (s.beamPartner != null) beam(null);
    }
    if (selectionSet && (store.get()?.selected ?? null) === lastSelected && select && (store.get()?.selected ?? null) !== snap.selected) {
      select(snap.selected);
    }
    // Rate: the tour's rates are theatrical; give the user's back unless they changed it since the tour set it.
    if (rateSet && Math.abs(rateTarget() - lastRateSet) <= 1e-12 * Math.max(1, Math.abs(lastRateSet)) && snap.rate !== lastRateSet) {
      clock.setRate(snap.rate);
    }
    // Play state: a clock we paused for a story pause is given back; a clock the tour started is paused again if the
    // user had it paused; a chapter that paused the clock (a tableau) leaves it paused so the moment can be explored.
    if (clockPausedByStory) { clockPausedByStory = false; if (snap.playing && !clock.playing()) clock.play(); }
    else if (clock.playing() && !snap.playing) clock.pause();
    sync();
  }

  // ---- public API --------------------------------------------------------------------------------------------------------
  function play(tourId, { index: startIndex = 0 } = {}) {
    const t = tours.find((x) => x.id === tourId);
    if (!t || !t.chapters.length) return false;
    if (status !== 'idle') stop('replaced');
    tour = t;
    takeSnapshot();
    status = 'playing';
    pausedBy = null;
    index = -1;
    elapsed = 0; chapterT = 0; chapterSeconds = 0; holding = null; cameraPending = false;
    caption = ''; detail = ''; title = '';
    queued = Math.max(0, Math.min(t.chapters.length - 1, Math.trunc(startIndex) || 0));
    lastReason = null;
    publish(true);
    return true;
  }

  function pause(reason = 'user') {
    if (status !== 'playing') return false;
    status = 'paused';
    pausedBy = reason;
    if (clock.playing()) { clock.pause(); clockPausedByStory = true; sync(); }
    publish();
    return true;
  }

  function resume() {
    if (status !== 'paused') return false;
    status = 'playing';
    pausedBy = null;
    if (clockPausedByStory) { clockPausedByStory = false; if (!clock.playing()) { clock.play(); sync(); } }
    publish();
    return true;
  }

  function toggle() {
    if (status === 'playing') return pause('user');
    if (status === 'paused') return resume();
    return false;
  }

  function next() {
    if (status === 'idle' || !tour) return false;
    const i = (queued >= 0 ? queued : index) + 1;
    if (i >= count()) { stop('finished'); return true; }
    queued = i;
    return true;
  }

  function prev() {
    if (status === 'idle' || !tour) return false;
    const base = queued >= 0 ? queued : index;
    queued = chapterT >= PREV_RESTART_S || base <= 0 ? Math.max(0, base) : base - 1;
    return true;
  }

  function stop(reason = 'user') {
    if (status === 'idle') return false;
    const ch = current();
    if (ch) { try { ch.end?.(ctx); } catch (err) { console.error('[story] chapter end failed', err); } }
    ctx.stopDwell();
    restore();
    status = 'idle';
    tour = null; index = -1; queued = -1; cameraPending = false; holding = null;
    pausedBy = null; caption = ''; detail = ''; title = '';
    pub.index = -2; pub.seq = -1;
    lastReason = reason;
    store.set({ story: null });
    try { onStop?.(reason); } catch (err) { console.error('[story] onStop failed', err); }
    return true;
  }

  /**
   * Advance the story by one frame.
   * @param {number} dt real seconds since the last frame
   * @returns {(() => void)|null} camera phase to run after the body states are recomputed (null when nothing to do)
   */
  function update(dt) {
    if (status === 'idle' || !tour) return null;
    const step = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), MAX_DT);
    // The previous frame's camera phase was not invoked (host skipped it): run it now so the tour cannot stall.
    if (cameraPending) cameraPhase();
    if (queued >= 0) {
      const i = queued;
      queued = -1;
      startChapterClock(i);
      return cameraPhase;
    }
    if (status === 'paused') return null;
    chapterT += step;
    if (holding) {
      holding.t += step;
      if (holding.t >= holding.cap) resolveHold();
      else { publish(); return null; }
    }
    const ch = current();
    elapsed += step;
    liveT += step;
    if (ch.cues) {
      while (cueIdx < ch.cues.length && elapsed >= ch.cues[cueIdx].t) {
        try { ch.cues[cueIdx].run(ctx); } catch (err) { console.error('[story] cue failed', err); }
        cueIdx += 1;
      }
    }
    if (liveT >= LIVE_INTERVAL_S) { liveT = 0; detail = liveDetail(ch); }
    if (elapsed >= chapterSeconds) {
      if (index + 1 < count()) { startChapterClock(index + 1); return cameraPhase; }
      stop('finished');
      return null;
    }
    publish();
    return null;
  }

  /**
   * Rig signal from main.js (handleRigEvents): resolves a matching hold.
   * @param {string|{ type: string, id?: string }} evt
   * @returns {boolean} true when a hold was resolved
   */
  function notify(evt) {
    const type = typeof evt === 'string' ? evt : evt?.type;
    if (!holding || !type) return false;
    if (type === holding.type || type === 'cancelled') { resolveHold(); return true; }
    return false;
  }

  function state() {
    if (status === 'idle' || !tour) return null;
    const ch = current();
    return {
      tourId: tour.id, tourTitle: tour.title, index: Math.max(index, 0), count: count(), status, elapsed, seconds: chapterSeconds,
      holding: holding ? holding.type : null, chapter: ch, caption, detail, title, pausedBy,
      progress: count() ? (Math.max(index, 0) + (chapterSeconds > 0 ? Math.min(1, elapsed / chapterSeconds) : 0)) / count() : 0,
      card: !!(ch?.card && chapterT < TITLE_CARD_S),
    };
  }

  function list() {
    return tours.map((t) => ({ id: t.id, title: t.title, tagline: t.tagline ?? '', durationS: estimateDurationS(t), chapters: t.chapters.length }));
  }

  return {
    play, pause, resume, toggle, next, prev, stop, update, notify, state, list,
    active: () => status !== 'idle',
    status: () => status,
    tourId: () => (tour ? tour.id : null),
    lastReason: () => lastReason,
  };
}
