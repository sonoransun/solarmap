// Solar Map — application bootstrap: wires the pure physics layer (src/astro), the three.js render layer
// (src/render) and the DOM UI (src/ui) together and drives the frame loop.
//
// Order of operations per frame:
//   1. clock → JD(UTC) → ΔT → JD(TT)
//   2. ephemeris.states(jdTT) (doubles, scene frame: ecliptic J2000, 1 unit = 1 AU, Sun at the origin)
//   3. camera rig (may move the camera and ease the sim rate)
//   4. scene.update (positions, orientation, markers, orbits, labels, overlays)
//   5. renderer.render (composer: radial blur → bloom → output) + CSS2D
// Everything the user reads is derived from the double-precision states, never from Object3D positions.

import { Scene, Vector3 } from 'three';

import { createStore } from './app/state.js';
import { createIntro } from './app/intro.js';
import { createUI } from './ui/index.js';
import { createRenderer } from './render/renderer.js';
import * as materials from './render/materials.js';
import { createScene, displayRadiusAu } from './render/scene.js';
import { createCameraRig, HOME } from './render/camera.js';
import { createPicker } from './render/picking.js';
import { createEventsClient } from './app/eventsClient.js';
import { createTextureSet } from './render/textures.js';

import { createClock, RATES, jdNowUtc, jdOfYearStart, YEAR_LIMITS } from './astro/clock.js';
import { deltaT, ttFromUtc, utcFromTt } from './astro/time.js';
import { createEphemeris, ORBITAL_PERIOD_DAYS } from './astro/ephemeris.js';
import { BODY_IDS, BODIES as BODY_TABLE } from './astro/bodies.js';
import {
  bodyToEcliptic, subSolarPoint, poleEcliptic, rotationElements, spinRateDegPerDay,
  siderealRotationHours, obliquityToOrbit,
} from './astro/orientation.js';
import {
  helioLongitudeDeg, distanceAu, distanceTable, elongation, orbitalSpeedKmS, phaseAngleDeg, lightTimeSeconds,
} from './astro/geometry.js';
import * as format from './astro/format.js';
import { AU_KM, RAD } from './astro/constants.js';

/** Verified-accuracy band (plan §Decisions 4): outside this the HUD shows a "reduced accuracy" badge. */
const VERIFIED_YEARS = { min: 1600, max: 2600 };
/** Above this rate the events worker is suspended (the prefetch window would thrash). */
const EVENTS_MAX_RATE = RATES.month;

const root = document.body;
const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#gl'));
const stage = document.querySelector('#stage') ?? root;
const labelHost = document.querySelector('#labels') ?? stage;

const store = createStore({ loading: true, jdUtc: jdNowUtc(), playing: true, rate: RATES.day });

// ---------------------------------------------------------------------------------------------------------------
// Clock (pure) — JD(UTC) is the single source of truth.
// ---------------------------------------------------------------------------------------------------------------
const clock = createClock({ jdUtc: jdNowUtc(), rate: RATES.day, playing: true });

// ---------------------------------------------------------------------------------------------------------------
// Renderer + UI come up immediately so the page paints while the 1.2 MB ephemeris module loads.
// ---------------------------------------------------------------------------------------------------------------
const renderer = createRenderer({ canvas, container: stage, store });
// The renderer appends its own CSS2D layer; the static #labels placeholder from index.html is redundant.
const cssLayer = renderer.cssRenderer?.domElement;
if (cssLayer) {
  cssLayer.classList.add('css2d-layer');
  if (labelHost && labelHost !== cssLayer && labelHost.id === 'labels') {
    labelHost.remove();
    cssLayer.id = 'labels';
  }
}

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
const bodyDefs = BODY_IDS.map((id) => {
  const b = BODY_TABLE[id];
  return {
    id,
    name: b.name,
    radiusEqKm: b.radiusEqKm,
    radiusPolarKm: b.radiusPolarKm,
    colour: Number.parseInt(b.colour.slice(1), 16),
    priority: b.priority,
    siderealOrbitDays: b.siderealOrbitDays ?? ORBITAL_PERIOD_DAYS[id] ?? null,
    rings: id === 'saturn' ? { innerKm: 74658, outerKm: 136780 } : null,
  };
});
const defOf = new Map(bodyDefs.map((d) => [d.id, d]));

// Per-frame scratch (no allocation in the hot path).
const orientations = new Map();
for (const id of BODY_IDS) orientations.set(id, new Array(9));
const subSolarScratch = { latDeg: 0, lonDeg: 0 };
const poleScratch = [0, 0, 0];
const elongScratch = { psiRad: 0, psiDeg: 0, side: null };
const deltaTScratch = { seconds: 0, assumed: false };

let jdUtc = clock.jd();
let jdTT = ttFromUtc(jdUtc);
/** @type {Record<string, {x:number,y:number,z:number,vx:number,vy:number,vz:number}>|null} */
let states = null;

// ---------------------------------------------------------------------------------------------------------------
// UI actions and providers
// ---------------------------------------------------------------------------------------------------------------
function sizeK() { return store.get().settings.sizeK; }

function dispRadiusAu(id) {
  return displayRadiusAu(defOf.get(id), sizeK());
}

function setJdUtc(jd) {
  const clamped = clock.setJd(jd);
  syncClockToStore();
  return clamped;
}

function syncClockToStore() {
  jdUtc = clock.jd();
  deltaT(jdUtc, deltaTScratch);
  jdTT = jdUtc + deltaTScratch.seconds / 86400;
  const year = format.calendarFromJd(jdUtc)[0];
  store.set({
    jdUtc,
    jdTT,
    deltaT: deltaTScratch.seconds,
    deltaTAssumed: deltaTScratch.assumed,
    playing: clock.playing(),
    rate: clock.rate(),
    reducedAccuracy: year < VERIFIED_YEARS.min || year > VERIFIED_YEARS.max,
  });
}

const actions = {
  play() { clock.play(); syncClockToStore(); },
  pause() { clock.pause(); syncClockToStore(); },
  toggle() { clock.toggle(); syncClockToStore(); },
  setRate(r) { clock.setRate(r); syncClockToStore(); },
  setJd(jd) { setJdUtc(jd); },
  now() { setJdUtc(jdNowUtc()); },
  step(days) { clock.step(days); syncClockToStore(); },
  select(id) { store.set({ selected: id }); },
  follow(id) { rig?.follow(id); store.set({ selected: id }); },
  flyTo(id) { rig?.flyTo(id); store.set({ selected: id }); },
  skyView(id) { rig?.skyView('earth', id); store.set({ selected: id }); },
  tour() { rig?.tour(); },
  cancel() { rig?.cancel(); },
  resetHome() { rig?.resetHome(); },
  setBeamPartner(id) { store.set({ beamPartner: id }); },
  goToEvent(ev) { if (ev) { setJdUtc(ev.jdUtc); clock.pause(); syncClockToStore(); store.set({ activeEventId: ev.id }); } },
  viewEvent(ev) { if (ev) { actions.goToEvent(ev); frameEvent(ev); } },
  setSettings(patch) { store.setSettings(patch); },
  playIntro() { intro.setRig(rig); intro.start(); },
  stopIntro() { intro.stop(); },
  toggleSizeK() {
    const s = store.get().settings;
    if (s.sizeK === 1) store.setSettings({ sizeK: s.lastSizeK || 50 });
    else store.setSettings({ sizeK: 1, lastSizeK: s.sizeK });
  },
};

/** Camera framing for the Events "View" button, per event class (plan §Fly-by "Events View"). */
function frameEvent(ev) {
  if (!rig || !states) return;
  const bodies = (ev.bodies || []).filter((b) => b !== 'sun');
  const geocentric = /pair|separation|appulse|geo/i.test(ev.kind) ||
    (ev.kind === 'parade' && bodies.includes('earth'));
  if (geocentric) {
    const targets = bodies.filter((b) => b !== 'earth');
    if (targets.length) { rig.skyView('earth', targets); return; }
  }
  if (/closest|perihelion|aphelion|apsis/i.test(ev.kind) && bodies.length === 1) {
    rig.flyTo(bodies[0]);
    return;
  }
  // Oppositions, conjunctions, parades: frame the Sun and the bodies involved from above the ecliptic.
  let r = 1.5;
  for (const id of bodies) {
    const st = states[id];
    if (st) r = Math.max(r, Math.hypot(st.x, st.y, st.z) * 1.25);
  }
  rig.frameTopDown({ center: [0, 0, 0], radius: r, seconds: 1.2 });
}

const providers = {
  bodyIds: BODY_IDS,
  bodyName: (id) => BODY_TABLE[id]?.name ?? id,
  bodyColour: (id) => BODY_TABLE[id]?.colour ?? '#ffffff',
  bodyInfo(id) {
    if (!states || !eph) return null;
    const st = states[id];
    if (!st) return null;
    const rSun = Math.hypot(st.x, st.y, st.z);
    const info = {
      rSunAu: rSun,
      earthDistAu: distanceAu(states, id, 'earth'),
      orbitalSpeedKmS: orbitalSpeedKmS(st),
      siderealRotationHours: siderealRotationHours(id),
      wDeg: null,
      poleLonDeg: null,
      poleLatDeg: null,
      subSolarLonDeg: null,
      subSolarLatDeg: null,
      obliquityDeg: null,
      helioLonDeg: id === 'sun' ? null : helioLongitudeDeg(states, id),
      elongationDeg: null,
      elongSide: null,
      phaseAngleDeg: null,
    };
    if (id !== 'sun' && id !== 'earth') {
      const e = elongation(states, id, elongScratch);
      info.elongationDeg = e.psiDeg;
      info.elongSide = e.side;
      info.phaseAngleDeg = phaseAngleDeg(states, id);
    }
    try {
      const rot = rotationElements(id, jdTT, undefined, jdUtc);
      info.wDeg = ((rot.W * RAD) % 360 + 360) % 360;
      poleEcliptic(id, jdTT, poleScratch);
      info.poleLonDeg = ((Math.atan2(poleScratch[1], poleScratch[0]) * RAD) % 360 + 360) % 360;
      info.poleLatDeg = Math.asin(Math.max(-1, Math.min(1, poleScratch[2]))) * RAD;
      if (id !== 'sun') {
        subSolarPoint(id, st, jdTT, jdUtc, subSolarScratch);
        info.subSolarLonDeg = subSolarScratch.lonDeg;
        info.subSolarLatDeg = subSolarScratch.latDeg;
        info.obliquityDeg = obliquityToOrbit(id, st, jdTT);
      }
    } catch { /* orientation is optional detail */ }
    return info;
  },
  distances(id) {
    if (!states) return [];
    const out = [];
    for (const other of BODY_IDS) {
      if (other === id) continue;
      const au = distanceAu(states, id, other);
      out.push({ id: other, au, km: au * AU_KM, lightSeconds: lightTimeSeconds(au) });
    }
    return out;
  },
  events(filter = {}) {
    if (!events) return [];
    const { jd0, jd1, minScore = 0 } = filter;
    const a = jd0 ?? jdTT - 365.25;
    const b = jd1 ?? jdTT + 365.25;
    return events.query(ttFromUtc(a), ttFromUtc(b), { minScore }).map(withUtc);
  },
  cameraInfo() {
    if (!rig) return null;
    const p = rig.controls?.object?.position;
    return {
      distAu: p ? Math.hypot(p.x, p.y, p.z) : 0,
      speedC: store.get().flyby?.speedC ?? 0,
    };
  },
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

const ui = createUI({ store, actions, providers, root });
syncClockToStore();

// Intro tour: the default first-load experience (plan §UI "Home view" + user request).
const intro = createIntro({
  store,
  clock: {
    setJd: (j) => setJdUtc(j),
    setRate: (r) => clock.setRate(r),
    play: () => clock.play(),
    pause: () => clock.pause(),
    jd: () => clock.jd(),
    rate: () => clock.rate(),
    playing: () => clock.playing(),
  },
  rig: null,
  ui,
  sync: syncClockToStore,
  isReducedMotion,
  nowJd: jdNowUtc,
  highlight: highlightNearestEvent,
});

/** Mark the most notable event within ±1 day of the clock so its alignment overlay is drawn. */
function highlightNearestEvent() {
  if (!events) return;
  const near = events.query(jdTT - 1, jdTT + 1, {});
  if (!near.length) return;
  let best = near[0];
  for (const ev of near) if ((ev.score ?? 0) > (best.score ?? 0)) best = ev;
  store.set({ activeEventId: best.id });
}
/** Any deliberate interaction ends the tour (the camera and clock stay where they are). */
function stopIntro() { if (intro.running()) intro.stop(); }
for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
  window.addEventListener(ev, stopIntro, { passive: true, capture: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Load the ephemeris data module (largest asset) and build everything that depends on it.
// ---------------------------------------------------------------------------------------------------------------
(async function boot() {
  try {
    const mod = await import('./astro/data/vsop87a.js');
    series = mod.SERIES;
    eph = createEphemeris(series, { meta: mod.META });
  } catch (err) {
    console.error('[solarmap] failed to load the ephemeris data module', err);
    ui.toast('Could not load the ephemeris data', { kind: 'warn', ms: 10000 });
    return;
  }

  states = eph.states(jdTT);

  scene = createScene({ bodies: bodyDefs, materials, store, cssRenderer: renderer.cssRenderer });
  scene.setOrbitSampler((id, jd) => eph.position(id, jd, undefined, 'display'));
  scene.setFullSampler((id, jd) => eph.position(id, jd));
  scene.resize(renderer.size.w, renderer.size.h);
  scene.setPixelRatio(renderer.size.dpr);
  renderer.onResize((w, h) => scene?.resize(w, h));
  renderer.onPixelRatio((pr) => scene?.setPixelRatio(pr));

  rig = createCameraRig({
    camera: renderer.camera,
    canvas,
    store,
    getBodyState: (id) => (states ? states[id] : null),
    getDispRadiusAu: dispRadiusAu,
    getPeriodDays: (id) => defOf.get(id)?.siderealOrbitDays ?? 365.25,
    clock: { rate: () => clock.rate(), setRate: (r) => { clock.setRate(r); syncClockToStore(); } },
    isReducedMotion,
    getSpinRateDegPerDay: (id) => Math.abs(spinRateDegPerDay(id)),
    getViewportHeight: () => renderer.size.h,
  });
  rig.onFade((dim) => { stage.style.setProperty('--fade', String(dim)); });
  // Place the camera at the home pose instantly: the first painted frame is the overview, never the inside of
  // the Sun (the animated resetHome() would spend its first second at the origin).
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
    ids: BODY_IDS,
    getWorldPosition: (id, out) => scene.getWorldPosition(id, out),
    getPxRadius: (id) => scene.getPxRadius(id),
    onSelect: (id) => store.set({ selected: id }),
    onFly: (id) => { if (id) rig.flyTo(id); },
    onShiftSelect: (id) => { if (id && id !== store.get().selected) store.set({ beamPartner: id }); },
    ignoreFocusWithin: document.querySelector('#panel'),
  });

  startEvents();
  if (store.get().settings.photoSurfaces !== false) loadSurfaceTextures();

  scene.orbits.prime(jdTT);
  store.set({ loading: false });
  ui.update();

  // Default view on load: the animated tour through popular events and timescales.
  intro.setRig(rig);
  if (store.get().settings.introOnLoad !== false && !isReducedMotion()) {
    intro.start(() => { store.set({ activeEventId: null }); });
  }
})();

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
    },
  });
  textures.load().then(() => {
    store.set({ texturesLoaded: true });
    applySurfaceMode();
  });
}

/** Switch every loaded body between the photographic map and the procedural surface. */
function applySurfaceMode() {
  if (!scene || !textures) return;
  const on = store.get().settings.photoSurfaces !== false;
  const mix = on ? 1 : 0;
  for (const [id, view] of scene.bodyViews) {
    const m = view.mesh?.material?.userData?.uniforms;
    if (m?.uTexMix && textures.get(id, 'map')) m.uTexMix.value = mix;
    const c = view.clouds?.material?.userData?.uniforms;
    if (c?.uTexMix && textures.get(id, 'clouds')) c.uTexMix.value = mix;
    const r = view.rings?.material?.userData?.uniforms;
    if (r?.uTexMix && textures.get(id, 'ring')) r.uTexMix.value = mix;
  }
}

function isReducedMotion() {
  const s = store.get().settings.reducedMotion;
  if (s === 'on') return true;
  if (s === 'off') return false;
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
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
    return;
  }
  events = createEventsClient({
    worker,
    series,
    jdOfYearStartTT: (year) => ttFromUtc(jdOfYearStart(year)),
    onStatus: ({ status, progress }) => store.set({ eventsStatus: status, eventsProgress: progress }),
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

function tick(ms) {
  const dt = lastMs ? Math.min((ms - lastMs) / 1000, 0.1) : 0;
  lastMs = ms;

  if (clock.playing()) syncClockToStore();
  else { jdUtc = clock.jd(); }

  if (eph) {
    states = eph.states(jdTT);

    // Orientation matrices (row-major 3×3, body → ecliptic) for every body.
    for (const id of BODY_IDS) bodyToEcliptic(id, jdTT, jdUtc, orientations.get(id));

    intro.update(dt);
    const r = rig.update(dt, jdTT);
    scene.update({
      jdTT,
      states,
      orientations,
      dtSeconds: isReducedMotion() ? 0 : dt,
      camera: renderer.camera,
      viewportH: renderer.size.h,
      viewportW: renderer.size.w,
      sizeK: sizeK(),
    });

    // Warp visuals follow the camera's true speed.
    scene.stars.setWarp(r.streak, r.velDir);
    renderer.setWarp({ strength: r.streak, centerNdc: warpCentre(r.velDir) });

    applySkyViewClutter();
    updateOverlays();
    handleRigEvents(r);
    updateEventsWindow();
  }

  renderer.render(scene ? scene.scene : emptyScene(), dt);
  renderer.adaptive(dt);
  // QA handle: the manual checklist in the plan drives the app from the console (no behaviour depends on it).
globalThis.__solarmap = {
  store, clock, actions, intro,
  get ephemeris() { return eph; },
  get scene() { return scene; },
  get rig() { return rig; },
  get events() { return events; },
  get states() { return states; },
  jd: () => ({ jdUtc, jdTT }),
};

requestAnimationFrame(tick);
}

const warpNdc = [0, 0];
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

/** In the from-Earth sky view the heliocentric orbit lines and the AU grid cut across the sky: hide them there. */
let clutterHidden = false;
function applySkyViewClutter() {
  const sky = store.get().cameraMode === 'skyView';
  if (sky === clutterHidden) return;
  clutterHidden = sky;
  const st = store.get().settings;
  scene.orbits.setVisible(sky ? false : st.showOrbits !== false);
  scene.grid.setVisible(sky ? false : st.showGrid !== false);
}

function handleRigEvents(r) {
  if (r.lightspeedBeat) ui.beat();
  if (r.arrived) {
    const id = r.arrived;
    const st = states[id];
    const rSun = Math.hypot(st.x, st.y, st.z);
    const lt = lightTimeSeconds(distanceAu(states, id, 'earth'));
    ui.toast(`Arrived at ${BODY_TABLE[id].name} · ${format.formatAu(rSun)} AU from the Sun · ${format.formatLightTime(lt)} light-time from Earth`, { key: 'arrive' });
  }
  if (r.spinCapChanged === 'on') {
    ui.toast(`Time slowed while close to ${BODY_TABLE[store.get().followed ?? 'earth']?.name ?? 'the body'}`, { key: 'spincap' });
  } else if (r.rateRestored) {
    ui.toast('Time rate restored', { key: 'rate' });
  }
}

function updateOverlays() {
  const s = store.get();
  // Distance beam between the selected body and its partner.
  if (s.selected && s.beamPartner && s.selected !== s.beamPartner) {
    const au = distanceAu(states, s.selected, s.beamPartner);
    scene.overlays.setBeam(s.selected, s.beamPartner, format.formatDistance(au));
  } else {
    scene.overlays.setBeam(null, null, null);
  }
  scene.overlays.update(states);

  // Alignment overlay for the active event while the clock is near it.
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
    positions: states,
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

  // Toast when playback crosses a notable event.
  if (lastEventCheckTT === null) { lastEventCheckTT = jdTT; return; }
  const a = Math.min(lastEventCheckTT, jdTT), b = Math.max(lastEventCheckTT, jdTT);
  // Only while the clock is genuinely running: a jump from the Events list or the scrubber is not a "crossing".
  if (clock.playing() && b - a > 0 && b - a < 60 && Math.abs(clock.rate()) <= EVENTS_MAX_RATE) {
    const crossed = events.query(a, b, { minScore: store.get().settings.eventMinScore });
    if (crossed.length) {
      const ev = crossed[crossed.length - 1];
      const key = `ev:${ev.id}`;
      if (key !== lastToastKey && !intro.running()) {
        lastToastKey = key;
        ui.toast(`Now: ${ev.label}`, { key: 'event' });
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
const _v3 = new Vector3();

// ---------------------------------------------------------------------------------------------------------------
// Global input and lifecycle
// ---------------------------------------------------------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (clock.playing()) { clock.pause(); syncClockToStore(); store.set({ hiddenPaused: true }); }
  } else if (store.get().hiddenPaused) {
    clock.play(); syncClockToStore(); store.set({ hiddenPaused: false });
  }
});

window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
  if (e.key === 'Escape') rig?.cancel();
  else if (e.key === 'Home') rig?.resetHome();
  else if (e.key === 'v' || e.key === 'V') {
    const id = store.get().selected;
    if (id && id !== 'earth') rig?.skyView('earth', id);
  }
});

store.subscribe((s, changed) => {
  if (changed.has('settings')) {
    if (s.settings.photoSurfaces !== false) loadSurfaceTextures();
    applySurfaceMode();
    const rm = isReducedMotion();
    document.documentElement.dataset.reducedMotion = rm ? 'on' : 'off';
    if (scene) scene.setFrozen(rm);
    if (renderer.quality !== s.settings.quality) renderer.setQuality(s.settings.quality);
  }
  if (changed.has('selected')) activeEventCache = null;
});

// QA handle: the manual checklist in the plan drives the app from the console (no behaviour depends on it).
globalThis.__solarmap = {
  store, clock, actions, intro,
  get ephemeris() { return eph; },
  get scene() { return scene; },
  get rig() { return rig; },
  get events() { return events; },
  get states() { return states; },
  jd: () => ({ jdUtc, jdTT }),
};

requestAnimationFrame(tick);
