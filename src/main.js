// Solar Map — application bootstrap: wires the pure physics layer (src/astro), the three.js render layer
// (src/render), the story engine (src/app/story.js) and the DOM UI (src/ui) together and drives the frame loop.
//
// Order of operations per frame (the story engine's two-phase chapter start depends on it):
//   1. story.update(dt)            clock phase of a chapter (jump / rate / pause) → returns the camera phase closure
//   2. rate ramp → clock.setRate   the ONE writer of the sim rate (user presets, story, fly-by cap, spin cap all ease)
//   3. clock → JD(UTC) → ΔT → JD(TT)
//   4. ephemeris.states(jdTT)      doubles, scene frame (ecliptic J2000, 1 unit = 1 AU, Sun at the origin), + the Moon
//   5. pendingCamera()             camera phase of the chapter, planned against the fresh states
//   6. camera rig (may report a rate ceiling), scene.update, overlays, markers, warp visuals
//   7. renderer.render (composer: radial blur → bloom → final grade → output) + CSS2D
// Everything the user reads is derived from the double-precision `states`; the scene draws `sceneStates`, which is
// the same object graph except for the Moon, whose geocentric offset is scaled with the planet-size exaggeration so
// the Earth–Moon system keeps its proportions when the planets are drawn larger than life.

import { Scene, Vector3 } from 'three';

import { createStore } from './app/state.js';
import { createStory } from './app/story.js';
import { buildShareUrl, parseShareHash } from './app/share.js';
import { createEventsClient } from './app/eventsClient.js';
import { createUI } from './ui/index.js';
import { createStoryUI } from './ui/story.js';
import { isTypingTarget } from './ui/dom.js';
import {
  arrivalMessage, spinCapMessage, rateRestoredMessage, eventNowMessage, shareCopiedMessage, snapshotMessage,
  shareDescription, clockLimitMessage, addCalendarYears,
} from './ui/copy.js';
import { createRenderer } from './render/renderer.js';
import * as materialsModule from './render/materials.js';
import { createSunGlare } from './render/sunGlare.js';
import { createScene, displayRadiusAu } from './render/scene.js';
import { createCameraRig, HOME } from './render/camera.js';
import { createPicker } from './render/picking.js';
import { createTextureSet } from './render/textures.js';

import { createClock, createRateRamp, RATES, jdNowUtc, jdOfYearStart } from './astro/clock.js';
import { deltaT, ttFromUtc, utcFromTt } from './astro/time.js';
import { createEphemeris } from './astro/ephemeris.js';
import { BODY_IDS, ALL_BODY_IDS, MOON_ID, BODIES as BODY_TABLE } from './astro/bodies.js';
import {
  bodyToEcliptic, subSolarPoint, poleEcliptic, rotationElements, spinRateDegPerDay, siderealRotationHours,
  obliquityToOrbit, isRetrograde,
} from './astro/orientation.js';
import { helioLongitudeDeg, distanceAu, elongation, orbitalSpeedKmS, phaseAngleDeg, lightTimeSeconds } from './astro/geometry.js';
import { astrometricRaDec, apparentRaDec } from './astro/apparent.js';
import { planetMagnitude, moonMagnitudeFromStates, magnitude as magnitudeOf, newMagnitude } from './astro/photometry.js';
import { osculatingElements, newElements } from './astro/elements.js';
import { createSkyData } from './astro/sky.js';
import { angleBetween } from './astro/vec.js';
import * as format from './astro/format.js';
import { AU_KM, RAD, LIGHT_TIME_AU_S } from './astro/constants.js';

/** Verified-accuracy band: outside it the HUD shows the reduced-accuracy badge (README §Precision). */
const JD_VERIFIED_MIN = jdOfYearStart(1600);
const JD_VERIFIED_MAX = jdOfYearStart(2601);
/** Above this rate the events worker is suspended (the prefetch window would thrash). */
const EVENTS_MAX_RATE = RATES.month;
/** The Moon's geocentric offset is drawn scaled with the planet-size exaggeration, capped here (at ×50 the Moon sits
 * 0.128 AU from Earth; the Earth–Moon proportions — 60 Earth radii — are preserved up to this cap). */
const MOON_OFFSET_MAX_SCALE = 50;
/** Apparent-magnitude refresh for the marker glows (s). */
const MAGNITUDE_PERIOD_S = 0.25;
/** Cadence of the caption-bar inset measurement (s). */
const HASH_PERIOD_S = 1.0;

const root = document.body;
const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#gl'));
const stage = document.querySelector('#stage') ?? root;
const labelHost = document.querySelector('#labels') ?? stage;

// ---------------------------------------------------------------------------------------------------------------
// Deep link (parsed before the clock so the first frame already shows the shared instant)
// ---------------------------------------------------------------------------------------------------------------
let link = null;
try { link = parseShareHash(location.hash); } catch { link = null; }
const linkJd = link && Number.isFinite(link.jdUtc) ? link.jdUtc : null;
const linkRate = link && Number.isFinite(link.rate) ? link.rate : null;

const store = createStore({ loading: true, jdUtc: linkJd ?? jdNowUtc(), playing: !(link && link.paused), rate: linkRate ?? RATES.day });

// ---------------------------------------------------------------------------------------------------------------
// Clock (pure) — JD(UTC) is the single source of truth. One rate ramp is the only writer of the rate.
// ---------------------------------------------------------------------------------------------------------------
const clock = createClock({ jdUtc: linkJd ?? jdNowUtc(), rate: linkRate ?? RATES.day, playing: !(link && link.paused) });
/** The rate the user (or a story chapter) asked for; the rig reads this wish, never the eased value. */
let userRate = clock.rate();
/** RigUpdate.rateCap from the previous frame (fly-by cap or spin cap), unsigned days/s. */
let lastRateCap = null;
const rateRamp = createRateRamp();

/** @param {number} wish signed days/s @param {number|null} cap unsigned ceiling */
function limitRate(wish, cap) {
  return cap != null && Math.abs(wish) > cap ? Math.sign(wish || 1) * cap : wish;
}
/** Ease the clock toward `target` (immediate under reduced motion or when asked). */
function requestRate(target, immediate = false) {
  if (!Number.isFinite(target)) return;
  if (immediate || isReducedMotion()) {
    rateRamp.cancel();
    clock.setRate(target);
    syncClockToStore();
    return;
  }
  rateRamp.to(target, clock.rate());
}

// ---------------------------------------------------------------------------------------------------------------
// Renderer + UI come up immediately so the page paints while the 1.2 MB ephemeris module loads.
// ---------------------------------------------------------------------------------------------------------------
const renderer = createRenderer({ canvas, container: stage, store });
const cssLayer = renderer.cssRenderer?.domElement;
if (cssLayer) {
  cssLayer.classList.add('css2d-layer');
  if (labelHost && labelHost !== cssLayer && labelHost.id === 'labels') {
    labelHost.remove();
    cssLayer.id = 'labels';
  }
}
/** The render layer's material factories plus the HDR sun glare (bodyView.js uses it when present). */
const materials = { ...materialsModule, createSunGlare };

/** @type {ReturnType<typeof createEphemeris>|null} */
let eph = null;
/** @type {ReturnType<typeof createScene>|null} */
let scene = null;
/** @type {ReturnType<typeof createCameraRig>|null} */
let rig = null;
/** @type {ReturnType<typeof createPicker>|null} */
let picker = null;
/** @type {ReturnType<typeof createEventsClient>|null} */
let events = null;
let series = null;

/** Body definitions for the render layer (plain data; render never imports bodies.js). */
const bodyDefs = ALL_BODY_IDS.map((id) => {
  const b = BODY_TABLE[id];
  return {
    id,
    name: b.name,
    radiusEqKm: b.radiusEqKm,
    radiusPolarKm: b.radiusPolarKm,
    colour: Number.parseInt(b.colour.slice(1), 16),
    priority: b.priority,
    // The Moon gets no heliocentric orbit line (its path round the Sun is Earth's); orbits.js skips null periods.
    siderealOrbitDays: id === MOON_ID ? null : (b.siderealOrbitDays ?? null),
    rings: id === 'saturn' ? { innerKm: 74658, outerKm: 136780 } : null,
    parent: id === MOON_ID ? 'earth' : null,
  };
});
const defOf = new Map(bodyDefs.map((d) => [d.id, d]));

// Per-frame scratch (no allocation in the hot path).
const orientations = new Map();
for (const id of ALL_BODY_IDS) orientations.set(id, new Array(9));
/** Bodies whose orientation model evaluates (checked once at boot). */
let orientIds = BODY_IDS;
const subSolarScratch = { latDeg: 0, lonDeg: 0 };
const poleScratch = [0, 0, 0];
const elongScratch = { psiRad: 0, psiDeg: 0, side: null };
const deltaTScratch = { seconds: 0, assumed: false };
const raDecScratch = { raDeg: 0, decDeg: 0, distAu: 0 };
const raDecAppScratch = { raDeg: 0, decDeg: 0, distAu: 0 };
const magScratch = newMagnitude();
const elementsScratch = newElements();
const vA = [0, 0, 0], vB = [0, 0, 0];
const warpNdc = [0, 0];
const _v3 = new Vector3();

let jdUtc = clock.jd();
let jdTT = ttFromUtc(jdUtc);
/** @type {Record<string, {x:number,y:number,z:number,vx:number,vy:number,vz:number}>|null} true heliocentric states */
let states = null;
/** @type {Record<string, {x:number,y:number,z:number,vx:number,vy:number,vz:number}>|null} what the scene draws */
let sceneStates = null;
const moonDisplay = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

// ---------------------------------------------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------------------------------------------
function sizeK() { return store.get().settings.sizeK; }

function dispRadiusAu(id) {
  return displayRadiusAu(defOf.get(id), sizeK());
}

/** Reduced motion: Settings override, else the system preference (media query cached: no per-frame allocation). */
const reducedMotionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
function isReducedMotion() {
  const s = store.get().settings.reducedMotion;
  if (s === 'on') return true;
  if (s === 'off') return false;
  return !!reducedMotionQuery?.matches;
}

// ---------------------------------------------------------------------------------------------------------------
// Clock ↔ store
// ---------------------------------------------------------------------------------------------------------------
function setJdUtc(jd) {
  if (!Number.isFinite(jd)) return false;
  const clamped = clock.setJd(jd);
  syncClockToStore();
  refreshStates(); // Events › View, deep links and story chapters frame the NEW instant, never last frame's positions
  if (clamped) ui?.toast(clockLimitMessage(format.calendarFromJd(clock.jd())[0]), { key: 'clamp', kind: 'warn' });
  return clamped;
}

function syncClockToStore() {
  jdUtc = clock.jd();
  deltaT(jdUtc, deltaTScratch);
  jdTT = jdUtc + deltaTScratch.seconds / 86400;
  store.set({
    jdUtc,
    jdTT,
    deltaT: deltaTScratch.seconds,
    deltaTAssumed: deltaTScratch.assumed,
    playing: clock.playing(),
    rate: clock.rate(),
    reducedAccuracy: jdUtc < JD_VERIFIED_MIN || jdUtc > JD_VERIFIED_MAX,
  });
}

/** Recompute the body states (and the Moon's display state) for the current jdTT; a no-op before the data has loaded. */
function refreshStates() {
  if (!eph) return;
  states = eph.states(jdTT);
  updateMoonDisplay();
}

// ---------------------------------------------------------------------------------------------------------------
// UI actions and providers (story / storyUI / ui are created below; the actions reference them lazily)
// ---------------------------------------------------------------------------------------------------------------
/** @type {ReturnType<typeof createStory>} */
let story;
/** @type {ReturnType<typeof createStoryUI>} */
let storyUI;
/** @type {ReturnType<typeof createUI>} */
let ui;
/** Alignment overlay requested by the running story chapter (drawn by updateOverlays). */
let storyOverlay = null;

const actions = {
  play() { clock.play(); syncClockToStore(); },
  pause() { clock.pause(); syncClockToStore(); },
  toggle() { clock.toggle(); syncClockToStore(); },
  /** @param {number} r signed days per real second @param {{immediate?: boolean}} [opts] */
  setRate(r, { immediate = false } = {}) {
    if (!Number.isFinite(r)) return;
    userRate = r;
    requestRate(limitRate(r, lastRateCap), immediate);
  },
  setJd(jd) { setJdUtc(jd); },
  now() { setJdUtc(jdNowUtc()); },
  step(days) { if (Number.isFinite(days)) { clock.step(days); syncClockToStore(); } },
  stepYears(n) { setJdUtc(addCalendarYears(clock.jd(), n)); },
  select(id) { store.set({ selected: id }); },
  follow(id, opts) { rig?.follow(id, opts); store.set({ selected: id }); },
  flyTo(id) { rig?.flyTo(id); store.set({ selected: id }); },
  skyView(id, opts) { rig?.skyView('earth', id, opts); if (!Array.isArray(id)) store.set({ selected: id }); },
  setSkyFov(fov, s) { rig?.setSkyFov(fov, s); },
  exitSkyView(s) { rig?.exitSkyView(s); },
  frameBodies(ids, o) { rig?.frameBodies(ids, o); },
  dollyTo(d, s) { rig?.dollyTo(d, s); },
  orbitDwell(o) { rig?.orbitDwell(o); },
  stopDwell() { rig?.stopDwell(); },
  free() { rig?.free(); },
  cancel() { rig?.cancel(); },
  resetHome() { rig?.resetHome(); },
  setBeamPartner(id) { store.set({ beamPartner: id }); },
  goToEvent(ev) { if (ev) { setJdUtc(ev.jdUtc); clock.pause(); syncClockToStore(); store.set({ activeEventId: ev.id }); } },
  viewEvent(ev) { if (ev) { actions.goToEvent(ev); frameEvent(ev); } },
  clearEvent() { store.set({ activeEventId: null }); },
  setSettings(patch) { store.setSettings(patch); },
  toggleSizeK() {
    const s = store.get().settings;
    if (s.sizeK === 1) store.setSettings({ sizeK: s.lastSizeK || 50 });
    else store.setSettings({ sizeK: 1, lastSizeK: s.sizeK });
  },
  toggleScientistMode() { store.setSettings({ scientistMode: !store.get().settings.scientistMode }); },
  // Stories.
  playTour(id, opts) { if (!eph || !story) return false; return story.play(id, opts); },
  stopTour() { story?.stop('user'); },
  toggleTour() { story?.toggle(); },
  nextChapter() { story?.next(); },
  prevChapter() { story?.prev(); },
  openTours() { storyUI?.toggle(); },
  /** Legacy name of the grand tour: now the Planets story. */
  tour() { return actions.playTour('planets'); },
  // Sharing.
  share() {
    const url = buildShareUrl(store.get(), providers.cameraPose());
    try { history.replaceState(null, '', url.slice(url.indexOf('#'))); } catch { /* file:// or sandboxed */ }
    const done = () => ui.toast(shareCopiedMessage(), { kind: 'success', critical: true });
    const fail = () => ui.toast('Copying is blocked here — the link is in the address bar', { kind: 'warn', critical: true });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fail); else fail();
  },
  /** Save the current frame as a PNG (the GL canvas; the DOM labels are not part of it). */
  snapshot() {
    if (!scene) return;
    renderer.render(scene.scene, 0);
    canvas.toBlob((blob) => {
      if (!blob) { ui.toast('The snapshot could not be saved', { kind: 'warn', critical: true }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `solar-map-${format.formatDate(jdUtc).replace(/[^0-9A-Za-z-]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      ui.toast(snapshotMessage(), { kind: 'success', critical: true });
    }, 'image/png');
  },
};

/** Camera framing for the Events "View" button, per event class. */
function frameEvent(ev) {
  if (!rig || !states) return;
  const kind = String(ev.kind || '');
  const bodies = (ev.bodies || []).filter((b) => b !== 'sun');
  if (/solar-eclipse|transit/i.test(kind)) { rig.skyView('earth', ['sun', ...bodies.filter((b) => b !== 'earth')], { fovDeg: 1.5 }); return; }
  if (/lunar-eclipse|moon/i.test(kind)) { rig.skyView('earth', ['moon'], { fovDeg: 2 }); return; }
  const geocentric = /pair|separation|appulse|geo/i.test(kind) || (kind === 'parade' && bodies.includes('earth'));
  if (geocentric) {
    const targets = bodies.filter((b) => b !== 'earth');
    if (targets.length) { rig.skyView('earth', targets); return; }
  }
  if (/closest|perihelion|aphelion|apsis/i.test(kind) && bodies.length === 1) { rig.flyTo(bodies[0]); return; }
  if (/equinox|solstice/i.test(kind)) { rig.frameBodies(['earth'], { includeSun: true, polarDeg: 35 }); return; }
  // Oppositions, conjunctions, parades: frame the Sun and the bodies involved from above the ecliptic.
  rig.frameBodies(bodies.length ? bodies : ['earth'], { includeSun: true });
}

/** Geocentric speed of a body (km/s). */
function geocentricSpeedKmS(st) {
  const e = states.earth;
  return Math.hypot(st.vx - e.vx, st.vy - e.vy, st.vz - e.vz) * AU_KM / 86400;
}

const providers = {
  bodyIds: ALL_BODY_IDS,
  bodyName: (id) => BODY_TABLE[id]?.name ?? id,
  bodyColour: (id) => BODY_TABLE[id]?.colour ?? '#ffffff',
  bodyInfo(id) {
    if (!states || !eph) return null;
    const st = states[id];
    if (!st) return null;
    const rSun = Math.hypot(st.x, st.y, st.z);
    const isSun = id === 'sun', isEarth = id === 'earth', isMoon = id === MOON_ID;
    const earthDist = isEarth ? null : distanceAu(states, id, 'earth');
    const info = {
      rSunAu: rSun,
      earthDistAu: earthDist,
      lightTimeS: earthDist == null ? null : earthDist * LIGHT_TIME_AU_S,
      orbitalSpeedKmS: isMoon ? geocentricSpeedKmS(st) : orbitalSpeedKmS(st),
      periodDays: BODY_TABLE[id]?.siderealOrbitDays ?? null,
      siderealRotationHours: null,
      retrograde: null,
      wDeg: null,
      poleLonDeg: null,
      poleLatDeg: null,
      subSolarLonDeg: null,
      subSolarLatDeg: null,
      obliquityDeg: null,
      helioLonDeg: isSun ? null : helioLongitudeDeg(states, id),
      elongationDeg: null,
      elongSide: null,
      phaseAngleDeg: null,
      magnitude: null,
      illuminatedFraction: null,
      angularDiameterArcsec: null,
      raDeg: null,
      decDeg: null,
      raApparentDeg: null,
      decApparentDeg: null,
      elements: null,
    };
    if (!isSun && !isEarth) {
      const e = elongation(states, id, elongScratch);
      info.elongationDeg = e.psiDeg;
      info.elongSide = e.side;
      info.phaseAngleDeg = phaseAngleDeg(states, id);
    }
    try {
      info.siderealRotationHours = siderealRotationHours(id);
      info.retrograde = isRetrograde(id);
      const rot = rotationElements(id, jdTT, undefined, jdUtc);
      info.wDeg = ((rot.W * RAD) % 360 + 360) % 360;
      poleEcliptic(id, jdTT, poleScratch);
      info.poleLonDeg = ((Math.atan2(poleScratch[1], poleScratch[0]) * RAD) % 360 + 360) % 360;
      info.poleLatDeg = Math.asin(Math.max(-1, Math.min(1, poleScratch[2]))) * RAD;
      if (!isSun) {
        subSolarPoint(id, st, jdTT, jdUtc, subSolarScratch);
        info.subSolarLonDeg = subSolarScratch.lonDeg;
        info.subSolarLatDeg = subSolarScratch.latDeg;
        info.obliquityDeg = obliquityToOrbit(id, st, jdTT);
      }
    } catch { /* orientation is optional detail */ }
    // Geocentric place: astrometric J2000 and apparent of date (light-time, aberration, precession, nutation).
    if (!isEarth) {
      try {
        astrometricRaDec(eph, id, jdTT, raDecScratch);
        info.raDeg = raDecScratch.raDeg; info.decDeg = raDecScratch.decDeg;
        apparentRaDec(eph, id, jdTT, raDecAppScratch);
        info.raApparentDeg = raDecAppScratch.raDeg; info.decApparentDeg = raDecAppScratch.decDeg;
      } catch { /* geocentric place unavailable */ }
      try {
        if (isSun) {
          info.magnitude = magnitudeOf(states, 'sun', jdTT);
          info.angularDiameterArcsec = 2 * Math.asin(BODY_TABLE.sun.radiusEqKm / (earthDist * AU_KM)) * RAD * 3600;
        } else {
          const m = isMoon ? moonMagnitudeFromStates(states, magScratch) : planetMagnitude(states, id, jdTT, magScratch);
          if (m.valid) {
            info.magnitude = m.mag;
            info.illuminatedFraction = m.illuminatedFraction;
            info.angularDiameterArcsec = m.angularDiameterArcsec;
          }
        }
      } catch { /* photometry unavailable */ }
    }
    if (!isSun && !isMoon) {
      try {
        const el = osculatingElements(st, jdTT, elementsScratch);
        info.elements = { a: el.a, e: el.e, iDeg: el.iDeg, OmegaDeg: el.OmegaDeg, omegaDeg: el.omegaDeg, MDeg: el.MDeg, periodDays: el.periodDays, q: el.q, Q: el.Q };
      } catch { /* elements unavailable */ }
    }
    return info;
  },
  distances(id) {
    if (!states) return [];
    const out = [];
    for (const other of ALL_BODY_IDS) {
      if (other === id) continue;
      const au = distanceAu(states, id, other);
      out.push({ id: other, au, km: au * AU_KM, lightSeconds: lightTimeSeconds(au) });
    }
    return out;
  },
  distanceAu: (a, b) => (states ? distanceAu(states, a, b) : NaN),
  /** Angular separation of a and b as seen from `from`, degrees (true positions). */
  separationDeg(from, a, b) {
    if (!states) return NaN;
    const o = states[from], u = states[a], v = states[b];
    if (!o || !u || !v) return NaN;
    vA[0] = u.x - o.x; vA[1] = u.y - o.y; vA[2] = u.z - o.z;
    vB[0] = v.x - o.x; vB[1] = v.y - o.y; vB[2] = v.z - o.z;
    return angleBetween(vA, vB) * RAD;
  },
  bodyState: (id) => (states ? states[id] ?? null : null),
  getMagnitude(id) {
    if (!states) return null;
    try { const m = magnitudeOf(states, id, jdTT); return Number.isFinite(m) ? m : null; } catch { return null; }
  },
  periodDays: (id) => BODY_TABLE[id]?.siderealOrbitDays ?? null,
  events(filter = {}) {
    if (!events) return [];
    const { jd0, jd1, minScore = 0 } = filter;
    const a = jd0 ?? jdUtc - 365.25;
    const b = jd1 ?? jdUtc + 365.25;
    return events.query(ttFromUtc(a), ttFromUtc(b), { minScore }).map(withUtc);
  },
  scannedYears: () => (events ? events.cachedYears() : []),
  cameraInfo() {
    if (!rig) return null;
    const p = rig.controls?.object?.position;
    return { distAu: p ? Math.hypot(p.x, p.y, p.z) : 0, speedC: store.get().flyby?.speedC ?? 0 };
  },
  cameraPose() {
    if (!rig) return null;
    return { position: rig.controls.object.position, target: rig.controls.target, fovDeg: renderer.camera.fov };
  },
  tours: () => (story ? story.list() : []),
  format: {
    utc: format.formatUtc,
    jd: format.formatJd,
    deltaT: format.formatDeltaT,
    distance: format.formatDistance,
    au: format.formatAu,
    km: format.formatKm,
    lightTime: format.formatLightTime,
    speed: format.formatSpeed,
    kmPerS: format.formatKmPerS,
    deg: format.formatDeg,
    angle: format.formatAngle,
    lonLat: format.formatLonLat,
    period: format.formatPeriod,
    rate: format.formatRate,
  },
};

function withUtc(ev) {
  return ev.jdUtc !== undefined ? ev : { ...ev, jdUtc: utcFromTt(ev.jdTT) };
}

ui = createUI({ store, actions, providers, root });
syncClockToStore();

// ---------------------------------------------------------------------------------------------------------------
// Story engine (the guided tours) and its UI
// ---------------------------------------------------------------------------------------------------------------
story = createStory({
  store,
  clock: {
    setJd: (j) => setJdUtc(j),
    setRate: (r) => actions.setRate(r), // eased through the one ramp
    play: () => { clock.play(); syncClockToStore(); },
    pause: () => { clock.pause(); syncClockToStore(); },
    jd: () => clock.jd(),
    rate: () => clock.rate(),
    playing: () => clock.playing(),
    target: () => (Number.isFinite(rateRamp.target()) ? rateRamp.target() : clock.rate()),
  },
  rig: () => rig,
  sync: syncClockToStore,
  isReducedMotion,
  nowJd: jdNowUtc,
  overlays: { showAlignment: (ev) => { storyOverlay = ev; }, hide: () => { storyOverlay = null; } },
  select: (id) => store.set({ selected: id }),
  beam: (a, b) => { if (a == null) store.set({ beamPartner: null }); else store.set({ selected: a, beamPartner: b }); },
  // Transient overrides (not persisted): a chapter must not write sizeK 50 into localStorage mid-tour.
  settings: { get: () => store.get().settings, set: (patch) => store.set({ settings: { ...store.get().settings, ...patch } }) },
  providers,
  onStop: () => { storyOverlay = null; scene?.setGlareSuppression?.(0); },
});
storyUI = createStoryUI({ root, store, actions, getProviders: () => providers, listTours: () => story.list() });

// Captions never use the toast queue; while a story runs the system toasts are muted (routed to the live region).
// The caption bar also defines a bottom safe inset: sky views and framings keep their subject above it.
let safeInsetBottom = 0;
function measureSafeInset() {
  const el = storyUI?.el;
  if (!el || el.hidden) { safeInsetBottom = 0; return; }
  const bar = el.getBoundingClientRect();
  const view = canvas.getBoundingClientRect();
  safeInsetBottom = bar.height > 0 ? Math.max(0, view.bottom - bar.top + 12) : 0;
}
let storyWasActive = false;
let panelBeforeStory = false;
store.subscribe((s, changed) => {
  if (!changed.has('story')) return;
  const active = !!s.story;
  ui.muteToasts(active);
  if (active !== storyWasActive) {
    // A story clears the stage: the details panel slides away for the tour and comes back as it was.
    if (active) { panelBeforeStory = ui.isPanelCollapsed(); ui.setPanelCollapsed(true); } else ui.setPanelCollapsed(panelBeforeStory);
    storyWasActive = active;
  }
  measureSafeInset();
});
renderer.onResize(() => measureSafeInset());

// Interaction policy: touching the scene pauses a tour (never kills it); the story bar's own buttons never pause.
for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
  canvas.addEventListener(ev, () => { if (story.active()) story.pause('interaction'); }, { passive: true });
}
// Story keys (registered after createUI so the shortcuts handler runs first and yields these while a tour runs).
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !story.active() || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e)) return;
  let handled = true;
  switch (e.key) {
    case ' ': story.toggle(); break;
    case 'ArrowRight': story.next(); break;
    case 'ArrowLeft': story.prev(); break;
    case 'Escape': story.stop('user'); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------------------------------------------------------
// Load the ephemeris data module (largest asset) and build everything that depends on it.
// ---------------------------------------------------------------------------------------------------------------
(async function boot() {
  try {
    const mod = await import('./astro/data/vsop87a.js');
    series = mod.SERIES;
    eph = createEphemeris(series, { meta: mod.META, moon: true });
  } catch (err) {
    console.error('[solarmap] failed to load the ephemeris data module', err);
    ui.showLoadError('Could not load the planet positions — the data file did not arrive. Check your connection and try again.');
    return;
  }

  // Persisted settings that only applied on change before.
  const settings0 = store.get().settings;
  if (settings0.quality && settings0.quality !== renderer.quality) renderer.setQuality(settings0.quality);

  states = eph.states(jdTT);
  sceneStates = {};
  for (const id of ALL_BODY_IDS) sceneStates[id] = id === MOON_ID ? moonDisplay : states[id];
  updateMoonDisplay();
  // The Moon's IAU rotation model is evaluated like any other body's; drop it from the list if it is unavailable.
  orientIds = ALL_BODY_IDS.filter((id) => {
    try { bodyToEcliptic(id, jdTT, jdUtc, orientations.get(id)); return true; } catch { return false; }
  });

  const sky = createSkyData();
  scene = createScene({
    bodies: bodyDefs, materials, store, cssRenderer: renderer.cssRenderer, sky,
    onSelect: (id) => store.set({ selected: id }),
    onFly: (id) => { if (id) rig?.flyTo(id); },
  });
  scene.setOrbitSampler((id, jd) => eph.position(id, jd, undefined, 'display'));
  scene.setFullSampler((id, jd) => eph.position(id, jd));
  scene.resize(renderer.size.w, renderer.size.h);
  scene.setPixelRatio(renderer.size.dpr);
  scene.setFrozen(isReducedMotion());
  scene.markers.setEnabled?.('sun', false); // the HDR glare carries the Sun
  renderer.onResize((w, h) => scene?.resize(w, h));
  renderer.onPixelRatio((pr) => scene?.setPixelRatio(pr));

  rig = createCameraRig({
    camera: renderer.camera,
    canvas,
    store,
    getBodyState: (id) => (sceneStates ? sceneStates[id] ?? null : null),
    getDispRadiusAu: dispRadiusAu,
    getPeriodDays: (id) => (id === 'sun' ? null : (BODY_TABLE[id]?.siderealOrbitDays ?? null)),
    clock: { rate: () => userRate },
    isReducedMotion,
    getSpinRateDegPerDay: (id) => Math.abs(spinRateDegPerDay(id)),
    getViewportHeight: () => renderer.size.h,
    getSafeInsetBottom: () => safeInsetBottom,
  });
  rig.onFade((dim) => { stage.style.setProperty('--fade', String(dim)); });
  rig.onSignal((sig) => story.notify(sig));
  // Place the camera at the home pose instantly: the first painted frame is the overview, never the inside of the Sun.
  {
    const polar = HOME.polarDeg * Math.PI / 180;
    const azim = HOME.azimuthDeg * Math.PI / 180;
    const d = HOME.distanceAu;
    rig.viewPose({
      position: [d * Math.sin(polar) * Math.cos(azim), d * Math.sin(polar) * Math.sin(azim), d * Math.cos(polar)],
      target: [0, 0, 0],
      seconds: 0,
    });
  }

  picker = createPicker({
    canvas,
    camera: renderer.camera,
    ids: ALL_BODY_IDS,
    getWorldPosition: (id, out) => scene.getWorldPosition(id, out),
    getPxRadius: (id) => scene.getPxRadius(id),
    isPickable: (id) => scene.isPickable?.(id) ?? true,
    onSelect: (id) => store.set({ selected: id }),
    onFly: (id) => { if (id) rig.flyTo(id); },
    onShiftSelect: (id) => { if (id && id !== store.get().selected) store.set({ beamPartner: id }); },
    ignoreFocusWithin: document.querySelector('#panel'),
  });

  startEvents();
  if (store.get().settings.photoSurfaces !== false) loadSurfaceTextures();

  scene.orbits.prime(jdTT);
  // Shader pre-warm: compile every program (and bake the Milky Way) before the loading screen lifts, so the first
  // warp and the first texture arrival never hitch mid-tour.
  try { scene.stars.bakeMilkyWay?.(renderer.renderer); } catch (err) { console.warn('[solarmap] Milky Way bake failed', err); }
  try { await renderer.prewarm?.(scene.scene); } catch (err) { console.warn('[solarmap] shader pre-warm failed', err); }

  store.set({ loading: false });
  ui.update();

  const linked = applyDeepLink();
  if (!linked && store.get().settings.introOnLoad !== false) actions.playTour('welcome');
})();

/** Apply a shared link (#t=…&sel=…&view=…); returns true when one was applied. */
function applyDeepLink() {
  if (!link || !rig) return false;
  let any = false;
  try {
    if (Number.isFinite(link.sizeK)) { store.set({ settings: { ...store.get().settings, sizeK: link.sizeK } }); any = true; }
    if (linkJd != null) any = true;
    if (link.selected && BODY_TABLE[link.selected]) { store.set({ selected: link.selected }); any = true; }
    const v = link.view;
    if (v) {
      any = true;
      if (v.kind === 'follow' && v.id) rig.follow(v.id, { seconds: 0 });
      else if (v.kind === 'sky' && v.from && v.to?.length) rig.skyView(v.from, v.to, { fovDeg: link.fovDeg ?? null, animateS: 0 });
      else if (v.kind === 'top') rig.frameTopDown({ center: [0, 0, 0], radius: 32, seconds: 0 });
      else if (link.camera) rig.viewPose({ position: link.camera.position, target: link.camera.target, seconds: 0 });
    } else if (link.camera) { rig.viewPose({ position: link.camera.position, target: link.camera.target, seconds: 0 }); any = true; }
    if (link.eventId) { store.set({ activeEventId: link.eventId }); any = true; }
    if (link.tour?.id) { actions.playTour(link.tour.id, { index: link.tour.index || 0 }); any = true; }
    if (any) ui.toast(shareDescription(link, (id) => BODY_TABLE[id]?.name ?? id), { key: 'link', critical: true });
  } catch (err) { console.warn('[solarmap] could not apply the shared link', err); }
  return any;
}

/** Re-measure the caption bar's inset about once a second while a story runs (its height follows its text). */
let insetAcc = 0;
function tickSafeInset(dt) {
  insetAcc += dt;
  if (insetAcc < HASH_PERIOD_S) return;
  insetAcc = 0;
  if (store.get().story) measureSafeInset();
}

/** Display state of the Moon: Earth + geocentric offset × the (capped) planet-size exaggeration. */
function updateMoonDisplay() {
  const e = states.earth, m = states[MOON_ID];
  if (!e || !m) return;
  const k = Math.max(1, Math.min(sizeK(), MOON_OFFSET_MAX_SCALE));
  moonDisplay.x = e.x + (m.x - e.x) * k; moonDisplay.y = e.y + (m.y - e.y) * k; moonDisplay.z = e.z + (m.z - e.z) * k;
  moonDisplay.vx = e.vx + (m.vx - e.vx) * k; moonDisplay.vy = e.vy + (m.vy - e.vy) * k; moonDisplay.vz = e.vz + (m.vz - e.vz) * k;
}

/**
 * Photographic surface maps (Solar System Scope, CC BY 4.0). They arrive after first paint and replace the
 * procedural surfaces body by body, so the map is usable immediately and becomes photographic a moment later.
 */
let textures = null;
function loadSurfaceTextures() {
  if (!scene || textures) return;
  textures = createTextureSet({
    anisotropy: renderer.renderer.capabilities.getMaxAnisotropy?.() ?? 8,
    onLoad(id, kind, tex) {
      const view = scene.bodyViews.get(id);
      if (!view) return;
      if (kind === 'map') materials.applyTexture(view.mesh?.material, tex, { kind: 'map' });
      else if (kind === 'night') materials.applyTexture(view.mesh?.material, tex, { kind: 'night' });
      else if (kind === 'clouds') materials.applyTexture(view.clouds?.material, tex, { kind: 'map' });
      else if (kind === 'ring') materials.applyTexture(view.rings?.material, tex, { kind: 'ring' });
      applySurfaceModeFor(view); // a toggle made while this map was still loading wins
    },
  });
  textures.load().then(() => {
    store.set({ texturesLoaded: true });
    applySurfaceMode();
  });
}

/** @param {any} view one body view: photographic ⇄ procedural per the current setting */
function applySurfaceModeFor(view) {
  if (!textures) return;
  const mix = store.get().settings.photoSurfaces !== false ? 1 : 0;
  const id = view.id;
  const m = view.mesh?.material?.userData?.uniforms;
  if (m?.uTexMix && textures.get(id, 'map')) m.uTexMix.value = mix;
  const c = view.clouds?.material?.userData?.uniforms;
  if (c?.uTexMix && textures.get(id, 'clouds')) c.uTexMix.value = mix;
  const r = view.rings?.material?.userData?.uniforms;
  if (r?.uTexMix && textures.get(id, 'ring')) r.uTexMix.value = mix;
}

/** Switch every loaded body between the photographic map and the procedural surface. */
function applySurfaceMode() {
  if (!scene || !textures) return;
  for (const view of scene.bodyViews.values()) applySurfaceModeFor(view);
}

// ---------------------------------------------------------------------------------------------------------------
// Events worker
// ---------------------------------------------------------------------------------------------------------------
function startEvents() {
  let worker;
  try {
    worker = new Worker(new URL('./app/eventsWorker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[solarmap] events worker unavailable; alignments are disabled', err);
    store.set({ eventsStatus: 'error' });
    return;
  }
  worker.onerror = (e) => {
    console.warn('[solarmap] events worker failed', e);
    store.set({ eventsStatus: 'error' });
  };
  events = createEventsClient({
    worker,
    series,
    jdOfYearStartTT: (year) => ttFromUtc(jdOfYearStart(year)),
    onStatus: ({ status, progress }) => { if (store.get().eventsStatus !== 'error') store.set({ eventsStatus: status, eventsProgress: progress }); },
    onYear: () => ui.update(),
  });
  events.setCentre(format.calendarFromJd(jdUtc)[0], 2);
}

// ---------------------------------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------------------------------
let lastMs = 0;
let lastEventCheckTT = null;
let lastEventsYear = null;
let lastToastKey = '';
let magAcc = MAGNITUDE_PERIOD_S;

function tick(ms) {
  const dt = lastMs ? Math.min((ms - lastMs) / 1000, 0.1) : 0;
  lastMs = ms;

  // 1. story clock phase, 2. the rate ramp, 3. the clock.
  const pendingCamera = story.update(dt);
  const eased = rateRamp.update(dt);
  if (eased !== null) clock.setRate(eased);
  if (clock.playing() || eased !== null) syncClockToStore();
  else jdUtc = clock.jd();

  if (eph) {
    states = eph.states(jdTT);
    updateMoonDisplay();
    for (let i = 0; i < orientIds.length; i++) {
      const id = orientIds[i];
      bodyToEcliptic(id, jdTT, jdUtc, orientations.get(id));
    }
    if (pendingCamera) pendingCamera();

    const r = rig.update(dt, jdTT);
    if (r.rateCap !== lastRateCap) {
      lastRateCap = r.rateCap;
      requestRate(limitRate(userRate, lastRateCap));
    }
    const reduced = isReducedMotion();
    scene.update({
      jdTT,
      states: sceneStates,
      orientations,
      dtSeconds: reduced ? 0 : dt,
      dtReal: dt,
      camera: renderer.camera,
      viewportH: renderer.size.h,
      viewportW: renderer.size.w,
      sizeK: sizeK(),
    });
    updateMagnitudes(dt);
    scene.setGlareSuppression?.(store.get().sky?.to?.includes('sun') ? 1 : 0);

    // Warp visuals follow the camera's true speed.
    scene.stars.setWarp(r.streak, r.velDir);
    renderer.setWarp({ strength: r.streak, centerNdc: warpCentre(r.velDir) });

    updateOverlays();
    handleRigEvents(r);
    updateEventsWindow();
    tickSafeInset(dt);
  }

  renderer.render(scene ? scene.scene : emptyScene(), dt);
  renderer.adaptive(dt);
  requestAnimationFrame(tick);
}

/** Marker glows follow the apparent magnitude (Mallama & Hilton 2018), refreshed a few times a second. */
function updateMagnitudes(dt) {
  magAcc += dt;
  if (magAcc < MAGNITUDE_PERIOD_S) return;
  magAcc = 0;
  for (let i = 0; i < ALL_BODY_IDS.length; i++) {
    const id = ALL_BODY_IDS[i];
    if (id === 'earth') continue;
    scene.setMagnitude?.(id, providers.getMagnitude(id));
  }
}

function warpCentre(velDir) {
  const cam = renderer.camera;
  const p = cam.position;
  const v = _v3;
  v.set(p.x + velDir[0], p.y + velDir[1], p.z + velDir[2]);
  v.project(cam);
  warpNdc[0] = Math.max(-1.5, Math.min(1.5, v.x));
  warpNdc[1] = Math.max(-1.5, Math.min(1.5, v.y));
  return warpNdc;
}

function handleRigEvents(r) {
  if (r.lightspeedBeat) ui.beat();
  if (r.arrived) {
    const id = r.arrived;
    const st = states[id];
    const rSun = Math.hypot(st.x, st.y, st.z);
    const lt = lightTimeSeconds(distanceAu(states, id, 'earth'));
    ui.toast(arrivalMessage(BODY_TABLE[id].name, rSun, lt, providers.format), { key: 'arrive', muted: story.active() });
  }
  if (r.spinCapChanged === 'on') {
    ui.toast(spinCapMessage(BODY_TABLE[store.get().followed ?? 'earth']?.name ?? 'the body'), { key: 'spincap', muted: story.active() });
  } else if (r.rateRestored) {
    ui.toast(rateRestoredMessage(), { key: 'rate', muted: story.active() });
  }
}

function updateOverlays() {
  const s = store.get();
  // Distance beam between the selected body and its partner (true distance; drawn at the displayed positions).
  if (s.selected && s.beamPartner && s.selected !== s.beamPartner) {
    const au = distanceAu(states, s.selected, s.beamPartner);
    scene.overlays.setBeam(s.selected, s.beamPartner, { main: format.formatDistance(au), sub: `light takes ${format.formatLightTime(au * LIGHT_TIME_AU_S)}` });
  } else {
    scene.overlays.setBeam(null, null, null);
  }

  // The story's own overlay wins; otherwise the alignment overlay for the active event while the clock is near it.
  if (storyOverlay) {
    scene.overlays.showAlignment({ kind: storyOverlay.kind, bodies: storyOverlay.bodies, positions: sceneStates, opacity: 1, label: storyOverlay.label });
    return;
  }
  if (!events || !s.activeEventId) { scene.overlays.hideAlignment(); return; }
  const ev = activeEvent();
  if (!ev) { scene.overlays.hideAlignment(); return; }
  const outer = ev.bodies?.some((b) => ['jupiter', 'saturn', 'uranus', 'neptune'].includes(b));
  const window = outer ? 10 : 3;
  const dtDays = Math.abs(jdTT - ev.jdTT);
  if (dtDays > window) { scene.overlays.hideAlignment(); return; }
  scene.overlays.showAlignment({
    kind: ev.kind,
    bodies: ev.bodies,
    positions: sceneStates,
    opacity: 1 - dtDays / window,
    label: ev.label,
  });
}

let activeEventCache = null;
function activeEvent() {
  const id = store.get().activeEventId;
  if (!id || !events) return null;
  if (activeEventCache && activeEventCache.id === id) return activeEventCache;
  const list = events.query(jdTT - 400, jdTT + 400, {});
  activeEventCache = list.find((e) => e.id === id) ?? null;
  return activeEventCache;
}

function updateEventsWindow() {
  if (!events) return;
  const year = format.calendarFromJd(jdUtc)[0];
  if (year !== lastEventsYear) {
    lastEventsYear = year;
    events.setCentre(year, 2);
  }
  events.setEnabled(Math.abs(clock.rate()) <= EVENTS_MAX_RATE);

  // Toast when playback crosses a notable event (the single crossing detector).
  if (lastEventCheckTT === null) { lastEventCheckTT = jdTT; return; }
  const a = Math.min(lastEventCheckTT, jdTT), b = Math.max(lastEventCheckTT, jdTT);
  // Only while the clock is genuinely running: a jump from the Events list or the scrubber is not a "crossing".
  if (clock.playing() && b - a > 0 && b - a < 60 && Math.abs(clock.rate()) <= EVENTS_MAX_RATE) {
    const crossed = events.query(a, b, { minScore: store.get().settings.eventMinScore });
    if (crossed.length) {
      const ev = crossed[crossed.length - 1];
      const key = `ev:${ev.id}`;
      if (key !== lastToastKey && !story.active()) {
        lastToastKey = key;
        ui.toast(eventNowMessage(ev.label), { key: 'event' });
        store.set({ activeEventId: ev.id });
      }
    }
  }
  lastEventCheckTT = jdTT;
}

/** Placeholder scene for the frames before the data module resolves (keeps the loop uniform). */
let _empty = null;
function emptyScene() {
  if (!_empty) _empty = new Scene();
  return _empty;
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle and store-driven side effects
// ---------------------------------------------------------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (story.active()) story.pause('hidden');
    if (clock.playing()) { clock.pause(); syncClockToStore(); store.set({ hiddenPaused: true }); }
  } else {
    if (story.state()?.pausedBy === 'hidden') story.resume();
    if (store.get().hiddenPaused) { clock.play(); syncClockToStore(); store.set({ hiddenPaused: false }); }
  }
});

store.subscribe((s, changed) => {
  if (changed.has('settings')) {
    if (s.settings.photoSurfaces !== false) loadSurfaceTextures();
    applySurfaceMode();
    if (scene) scene.setFrozen(isReducedMotion());
    if (renderer.quality !== s.settings.quality) renderer.setQuality(s.settings.quality);
  }
  if (changed.has('selected')) activeEventCache = null;
});

// QA handle: the manual checklist drives the app from the console (no behaviour depends on it).
globalThis.__solarmap = {
  store, clock, actions, providers, story, storyUI, ui,
  get ephemeris() { return eph; },
  get scene() { return scene; },
  get rig() { return rig; },
  get events() { return events; },
  get states() { return states; },
  get sceneStates() { return sceneStates; },
  get renderer() { return renderer; },
  jd: () => ({ jdUtc, jdTT }),
};

requestAnimationFrame(tick);
