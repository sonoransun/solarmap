// Scene graph: Sun light + ambient, one BodyView per body (the Moon included when main.js lists it), the shared
// markers Points, orbit lines, grid, sky (stars, Milky Way, star names) and overlays. update() is allocation-free
// (module scratch objects, typed arrays, no closures created per frame). Everything physical comes in through the
// contract: positions/orientations per frame from the physics layer, body descriptors as data; nothing here imports
// src/astro — the star catalogue arrives as the `sky` bundle built by src/astro/sky.js and handed over by main.js.
//
// Lighting (plan §Rendering): PointLight(0xfff4e0, 1.0, distance 0, decay 0) at the origin — decay 0 gives a distance
// attenuation of exactly 1 in r186's getDistanceAttenuation(), so Neptune is lit like Mercury (reads as auto-exposure) —
// plus AmbientLight(0x223044, 0.08) so night sides are not pure black (the planet materials add a small night floor too).
//
// Two clocks: `dtSeconds` is the material/animation time (0 under reduced motion: Sun granulation, cloud drift and
// the selection pulse freeze) and `dtReal` the real frame time that drives the schedulers (label layout, orbit
// brightness rewrites, star twinkle), so reduced motion never freezes the label layout.

import { Scene, PointLight, AmbientLight, MathUtils, Vector3 } from 'three';
import { createBodyView, getSharedGeometries, AU_KM } from './bodyView.js';
import { createMarkers } from './markers.js';
import { createLabelLayout } from './labels.js';
import { createOrbits, createGrid } from './orbits.js';
import { createStars } from './stars.js';
import { createOverlays } from './overlays.js';
import { nearParent } from './labelLayout.js';

/** The Sun's size exaggeration is capped so it never swallows Mercury (plan §Decisions 6). */
export const SUN_SIZE_K_CAP = 30;
/** Keep uTime small to avoid float drift inside the noise (research §8). */
const TIME_WRAP_S = 1e4;
/**
 * Marker "hidden" fallback when markers.setHidden() is not available: a projected radius just past the marker
 * cross-fade's upper edge (alpha = 1 − smoothstep(px, 2, 7) → 0) hides the glow without touching the disc.
 */
const MARKER_HIDDEN_PX = 8;

const _pA = new Vector3();
const _pB = new Vector3();

/**
 * Projected radius of a sphere in CSS px (plan §Rendering › Markers; geometry test: R=1, d=100, 50°, H=1000 → 10.72 px).
 * @param {number} R display radius (AU)
 * @param {number} d camera distance (AU)
 * @param {number} fovRad vertical field of view (rad)
 * @param {number} H viewport height (CSS px)
 * @returns {number}
 */
export function pxRadius(R, d, fovRad, H) {
  return R / Math.max(d, 1.0001 * R) / Math.tan(fovRad / 2) * H / 2;
}

/**
 * Displayed equatorial radius in AU for a size exaggeration k (Sun uses min(k, 30)).
 * @param {{ id: string, radiusEqKm: number }} def
 * @param {number} sizeK
 * @returns {number}
 */
export function displayRadiusAu(def, sizeK) {
  const k = def.id === 'sun' ? Math.min(sizeK, SUN_SIZE_K_CAP) : sizeK;
  return (def.radiusEqKm / AU_KM) * k;
}

/**
 * @param {{
 *   bodies: import('./bodyView.js').BodyDef[],
 *   materials: object,                       the materials.js module, optionally extended with createSunGlare
 *   store?: { get: () => any, subscribe: (fn: (s: any, changed: Set<string>) => void) => () => void },
 *   cssRenderer?: any,
 *   sky?: object|null,                       createSkyData() bundle from src/astro/sky.js (stars.js documents the fields)
 *   onSelect?: ((id: string) => void)|null,  label click
 *   onFly?: ((id: string) => void)|null,     label double-click
 * }} opts
 */
export function createScene({ bodies, materials, store, cssRenderer = null, sky = null, onSelect = null, onFly = null }) {
  const scene = new Scene();
  scene.name = 'solarmap';

  const sunLight = new PointLight(0xfff4e0, 1.0, 0, 0);
  sunLight.name = 'sun-light';
  sunLight.position.set(0, 0, 0);
  scene.add(sunLight);
  const ambient = new AmbientLight(0x223044, 0.08);
  ambient.name = 'ambient';
  scene.add(ambient);

  const n = bodies.length;
  /** @type {Map<string, ReturnType<typeof createBodyView>>} */
  const bodyViews = new Map();
  const views = new Array(n);
  const indexOf = new Map();
  const px = new Float64Array(n); // this frame's projected radii (CSS px)
  for (let i = 0; i < n; i++) {
    const def = bodies[i];
    const view = createBodyView(def, materials);
    views[i] = view;
    bodyViews.set(def.id, view);
    indexOf.set(def.id, i);
    scene.add(view.anchor);
  }
  const sunView = bodyViews.get('sun') ?? null;
  const moonIdx = indexOf.has('moon') ? indexOf.get('moon') : -1;
  const sunIdx = indexOf.has('sun') ? indexOf.get('sun') : -1;
  /** Per body: its marker is currently disabled because it crosses the Sun's disc (transit / solar eclipse). */
  const transitHidden = new Uint8Array(n);
  const earthIdx = indexOf.has('earth') ? indexOf.get('earth') : -1;

  const markers = createMarkers({ bodies, materials });
  scene.add(markers.points);
  const orbits = createOrbits({ bodies });
  scene.add(orbits.group);
  const grid = createGrid();
  scene.add(grid.group);
  const stars = createStars({ materials, sky });
  scene.add(stars.group);
  const overlays = createOverlays({ bodies });
  scene.add(overlays.group);

  const labels = createLabelLayout({
    entries: bodies.map((def, i) => ({
      id: def.id,
      label: views[i].labelHandle,
      anchor: views[i].anchor,
      getPxRadius: () => px[i],
      parent: def.parent ?? null,
    })),
    onSelect,
    onFly,
    getDensity: () => store?.get()?.settings?.labelDensity ?? 'auto',
  });

  const viewport = { w: 1, h: 1 };
  let pixelRatio = 1;
  let selected = null;
  let debugOn = false;
  let frozen = false;
  let time = 0;
  let skyViewMode = false;
  let moonVisible = true;
  let moonMarkerHidden = false;

  // --- settings pass-throughs ------------------------------------------------------------------------------------------
  /** settings.showStars. @param {boolean} on */
  function setStarsVisible(on) {
    if (typeof stars.setVisible === 'function') stars.setVisible(!!on);
    else stars.group.visible = !!on;
  }
  /** settings.showMilkyWay. @param {boolean} on */
  function setMilkyWayVisible(on) {
    if (typeof stars.setMilkyWayVisible === 'function') stars.setMilkyWayVisible(!!on);
  }
  /** settings.showStarNames (sky view only; stars.js gates on the fov). @param {boolean} on */
  function setStarNamesVisible(on) {
    if (typeof stars.setNamesVisible === 'function') stars.setNamesVisible(!!on);
  }
  /** settings.showMoon: disc, marker and label together. @param {boolean} on */
  function setMoonVisible(on) {
    moonVisible = !!on;
    if (moonIdx < 0) return;
    views[moonIdx].anchor.visible = moonVisible;
    labels.setEntryVisible('moon', moonVisible);
    if (!moonVisible) setMarkerHidden('moon', true);
  }
  /**
   * Hide/show one marker through the markers API when it offers it (markers.setHidden); otherwise the per-frame
   * set() call passes MARKER_HIDDEN_PX (see update()).
   * @param {string} id @param {boolean} hidden
   */
  function setMarkerHidden(id, hidden) {
    if (typeof markers.setHidden === 'function') markers.setHidden(id, hidden);
  }
  /** Glare suppression 0…1 on the Sun's view (transit chapters, close-ups). @param {number} x */
  function setGlareSuppression(x) {
    if (sunView) sunView.setGlareSuppression(x);
  }
  /**
   * Apparent magnitude for a marker (main.js from E's photometry; markers.js applies its brightness law). No-op when
   * the markers module has no setMagnitude.
   * @param {string} id @param {number|null} m
   */
  function setMagnitude(id, m) {
    if (typeof markers.setMagnitude === 'function') markers.setMagnitude(id, m);
  }

  // --- store-driven state (settings toggles, selection, DPR, camera mode) --------------------------------------------
  /**
   * @param {any} s
   * @param {Set<string>} [changed]
   */
  function applyState(s, changed) {
    if (!s) return;
    const modeChanged = !changed || changed.has('cameraMode');
    if (modeChanged) skyViewMode = s.cameraMode === 'skyView';
    if (!changed || changed.has('settings') || modeChanged) {
      const st = s.settings || {};
      // In the from-Earth sky view the heliocentric orbit lines and the AU grid would cut across the sky: they stay
      // hidden there whatever the toggles say, and come back when the view returns (also after any settings change).
      orbits.setVisible(!skyViewMode && st.showOrbits !== false);
      grid.setVisible(!skyViewMode && st.showGrid !== false);
      labels.setVisible(st.showLabels !== false);
      setStarsVisible(st.showStars !== false);
      setMilkyWayVisible(st.showMilkyWay !== false);
      setStarNamesVisible(!!(st.showStarNames ?? st.showConstellationNames));
      setMoonVisible(st.showMoon !== false);
      const dbg = !!st.showOrientationDebug;
      if (dbg !== debugOn) {
        debugOn = dbg;
        for (let i = 0; i < n; i++) views[i].setDebug(debugOn);
      }
    }
    if (!changed || changed.has('selected')) {
      selected = s.selected ?? null;
      markers.setSelected(selected);
      orbits.setSelected(selected);
      labels.setSelected(selected);
    }
    if ((!changed || changed.has('pixelRatio')) && s.pixelRatio > 0) setPixelRatio(s.pixelRatio);
  }
  let unsubscribe = null;
  if (store) {
    applyState(store.get());
    unsubscribe = store.subscribe(applyState);
  }

  /**
   * The Moon's marker and label would sit on Earth's from any distance: hide them while the Moon's projected
   * separation from Earth's centre is below Earth's projected radius + 6 px (labelLayout.nearParent), unless the
   * Moon is selected. Allocation-free (module scratch vectors).
   * @param {Record<string, {x:number,y:number,z:number}>} states
   * @param {import('three').PerspectiveCamera} camera
   * @param {number} earthPx
   * @returns {boolean}
   */
  function moonNearEarth(states, camera, earthPx) {
    const e = states.earth, m = states.moon;
    if (!e || !m) return false;
    _pA.set(e.x, e.y, e.z).project(camera);
    _pB.set(m.x, m.y, m.z).project(camera);
    if (!(_pA.z < 1) || !(_pB.z < 1)) return false;
    const w = viewport.w, h = viewport.h;
    return nearParent(
      (_pB.x * 0.5 + 0.5) * w, (-_pB.y * 0.5 + 0.5) * h,
      (_pA.x * 0.5 + 0.5) * w, (-_pA.y * 0.5 + 0.5) * h,
      earthPx,
    );
  }

  /**
   * Per-frame update (allocation-free).
   * @param {{
   *   jdTT: number,
   *   states: Record<string, {x:number,y:number,z:number}>,
   *   orientations?: Map<string, number[]>|Record<string, number[]>,
   *   dtSeconds?: number,   animation time step (0 under reduced motion)
   *   dtReal?: number,      real frame time for the schedulers (defaults to dtSeconds)
   *   camera: import('three').PerspectiveCamera,
   *   viewportH?: number,
   *   viewportW?: number,
   *   sizeK?: number,
   *   sunDirFor?: (id: string) => number[],
   *   tSeconds?: number,
   * }} args
   */
  function update({ jdTT, states, orientations, dtSeconds = 0, dtReal, camera, viewportH, viewportW, sizeK = 1, sunDirFor, tSeconds }) {
    if (!camera) return;
    const dtSched = dtReal !== undefined ? dtReal : dtSeconds;
    if (!frozen) {
      time += dtSeconds;
      if (time > TIME_WRAP_S) time -= TIME_WRAP_S;
    }
    const t = tSeconds !== undefined ? tSeconds : time;

    // the camera rig moved the camera this frame: refresh its world/inverse matrices before we derive view-space data
    camera.updateWorldMatrix(true, false);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    if (viewportW > 0) viewport.w = viewportW;
    if (viewportH > 0) viewport.h = viewportH;
    const H = viewport.h;
    const tanHalf = Math.tan(camera.fov * MathUtils.DEG2RAD * 0.5);
    const cp = camera.position;
    const hasOrientations = !!orientations;
    const orientIsMap = hasOrientations && typeof orientations.get === 'function';

    // Earth's projected radius first (the Moon's proximity rule needs it before the Moon's marker is written).
    let earthPx = 0;
    if (earthIdx >= 0 && states && states.earth) {
      const e = states.earth;
      const d = Math.sqrt((e.x - cp.x) ** 2 + (e.y - cp.y) ** 2 + (e.z - cp.z) ** 2);
      const R = displayRadiusAu(bodies[earthIdx], sizeK);
      earthPx = R / Math.max(d, 1.0001 * R) / tanHalf * H * 0.5;
    }
    const hideMoon = moonIdx >= 0 && (!moonVisible || (selected !== 'moon' && states && moonNearEarth(states, camera, earthPx)));
    if (hideMoon !== moonMarkerHidden) {
      moonMarkerHidden = hideMoon;
      setMarkerHidden('moon', hideMoon);
    }

    // Transit rule: a body crossing the Sun's disc (a Mercury or Venus transit, the Moon in a solar eclipse) is a dark
    // dot against the photosphere, never a glow — its marker is disabled while its direction from the camera lies
    // inside the Sun's angular disc and it is the nearer of the two.
    let sdx = 0, sdy = 0, sdz = 0, sd = Infinity, cosSunR = 2;
    if (sunIdx >= 0 && states && states.sun) {
      const su = states.sun;
      sdx = su.x - cp.x; sdy = su.y - cp.y; sdz = su.z - cp.z;
      sd = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
      const Rs = displayRadiusAu(bodies[sunIdx], sizeK);
      cosSunR = sd > Rs ? Math.sqrt(1 - (Rs / sd) * (Rs / sd)) : -1; // cos of the Sun's angular radius
    }

    for (let i = 0; i < n; i++) {
      const def = bodies[i];
      const st = states ? states[def.id] : null;
      if (!st) { px[i] = 0; continue; }
      const R = displayRadiusAu(def, sizeK);
      const dx = st.x - cp.x, dy = st.y - cp.y, dz = st.z - cp.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const p = R / Math.max(d, 1.0001 * R) / tanHalf * H * 0.5;
      px[i] = p;
      if (i !== sunIdx && typeof markers.setEnabled === 'function') {
        const inFront = d < sd && d > 0 && (dx * sdx + dy * sdy + dz * sdz) / (d * sd) > cosSunR;
        const flag = inFront ? 1 : 0;
        if (flag !== transitHidden[i]) { transitHidden[i] = flag; markers.setEnabled(def.id, !inFront); }
      }
      const mat3 = hasOrientations ? (orientIsMap ? orientations.get(def.id) : orientations[def.id]) : null;
      views[i].update({
        pos: st,
        mat3,
        dispRadiusAu: R,
        pxRadius: p,
        tSeconds: t,
        camera,
        viewportH: H,
        sunDir: sunDirFor ? sunDirFor(def.id) : undefined,
      });
      const hiddenMarker = i === moonIdx && hideMoon && typeof markers.setHidden !== 'function';
      markers.set(def.id, st.x, st.y, st.z, hiddenMarker ? MARKER_HIDDEN_PX : p);
    }
    markers.commit(t);
    orbits.update({ jdTT, states, dtSeconds: dtSched, selected });
    stars.update(camera, dtSched);
    labels.layout(dtSched, camera, viewport.w, H);
    overlays.update(states);
  }

  /** @param {number} w CSS px @param {number} h CSS px */
  function resize(w, h) {
    viewport.w = w;
    viewport.h = h;
    orbits.setResolution(w, h);
  }

  /** @param {number} pr */
  function setPixelRatio(pr) {
    if (pr === pixelRatio) return;
    pixelRatio = pr;
    markers.setPixelRatio(pr);
    stars.setPixelRatio(pr);
  }

  /** @param {(id: string, jdTT: number) => number[]|{x:number,y:number,z:number}} fn display-tier sampler */
  function setOrbitSampler(fn) {
    orbits.setSampler(fn);
  }

  /** @param {(id: string, jdTT: number) => number[]|{x:number,y:number,z:number}} fn full-tier sampler */
  function setFullSampler(fn) {
    orbits.setFullSampler(fn);
  }

  /** Freeze material animation time (reduced motion: "Sun animation frozen"). @param {boolean} on */
  function setFrozen(on) {
    frozen = !!on;
  }

  /** @param {string} id @returns {number} projected display radius this frame (CSS px) */
  function getPxRadius(id) {
    const i = indexOf.get(id);
    return i === undefined ? 0 : px[i];
  }

  /**
   * @param {string} id
   * @param {import('three').Vector3|number[]} out
   * @returns {import('three').Vector3|number[]|null}
   */
  function getWorldPosition(id, out) {
    const view = bodyViews.get(id);
    if (!view) return null;
    const p = view.anchor.position;
    if (out.isVector3) out.copy(p);
    else { out[0] = p.x; out[1] = p.y; out[2] = p.z; }
    return out;
  }

  /** @param {string} id @returns {number} displayed equatorial radius (AU) at the current sizeK of the store */
  function getDispRadiusAu(id, sizeK = store?.get()?.settings?.sizeK ?? 1) {
    const view = bodyViews.get(id);
    return view ? displayRadiusAu(view.def, sizeK) : 0;
  }

  /**
   * Whether a body is currently shown at all (settings.showMoon off hides the Moon's disc, marker and label).
   * @param {string} id
   * @returns {boolean}
   */
  function isBodyVisible(id) {
    if (id === 'moon') return moonVisible;
    return bodyViews.has(id);
  }

  /**
   * Whether a click/tap near a body's centre should pick it: false while the body is hidden or while its marker is
   * suppressed because it sits on its parent (the Moon inside Earth's disc + 6 px from the home view — otherwise a
   * click on Earth could land on the Moon). Wire it into the picker (picking.js `isPickable`, or filter ids).
   * @param {string} id
   * @returns {boolean}
   */
  function isPickable(id) {
    if (!bodyViews.has(id)) return false;
    if (id === 'moon') return moonVisible && (!moonMarkerHidden || selected === 'moon');
    return true;
  }

  function dispose() {
    if (unsubscribe) unsubscribe();
    labels.dispose();
    for (let i = 0; i < n; i++) views[i].dispose();
    markers.dispose();
    orbits.dispose();
    grid.dispose();
    stars.dispose();
    overlays.dispose();
    const g = getSharedGeometries();
    g.lo.dispose();
    g.hi.dispose();
    sunLight.dispose();
    ambient.dispose();
  }

  return {
    scene,
    bodyViews,
    sunLight,
    ambient,
    markers,
    orbits,
    grid,
    stars,
    overlays,
    labels,
    cssRenderer,
    viewport,
    update,
    resize,
    setPixelRatio,
    setOrbitSampler,
    setFullSampler,
    setFrozen,
    setGlareSuppression,
    setMagnitude,
    setStarsVisible,
    setMilkyWayVisible,
    setStarNamesVisible,
    setMoonVisible,
    isBodyVisible,
    isPickable,
    getPxRadius,
    getWorldPosition,
    getDispRadiusAu,
    dispose,
  };
}
