// Scene graph: Sun light + ambient, one BodyView per body, the shared markers Points, orbit lines, grid, starfield and
// overlays. update() is allocation-free (module scratch objects, typed arrays, no closures created per frame).
// Everything physical comes in through the contract: positions/orientations per frame from the physics layer, body
// descriptors as data; nothing here imports src/astro.
//
// Lighting (plan §Rendering): PointLight(0xfff4e0, 1.0, distance 0, decay 0) at the origin — decay 0 gives a distance
// attenuation of exactly 1 in r186's getDistanceAttenuation(), so Neptune is lit like Mercury (reads as auto-exposure) —
// plus AmbientLight(0x223044, 0.08) so night sides are not pure black.

import { Scene, PointLight, AmbientLight, MathUtils } from 'three';
import { createBodyView, getSharedGeometries, AU_KM } from './bodyView.js';
import { createMarkers } from './markers.js';
import { createLabelLayout } from './labels.js';
import { createOrbits, createGrid } from './orbits.js';
import { createStars } from './stars.js';
import { createOverlays } from './overlays.js';

/** The Sun's size exaggeration is capped so it never swallows Mercury (plan §Decisions 6). */
export const SUN_SIZE_K_CAP = 30;
/** Keep uTime small to avoid float drift inside the noise (research §8). */
const TIME_WRAP_S = 1e4;

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
 *   materials: object,
 *   store?: { get: () => any, subscribe: (fn: (s: any, changed: Set<string>) => void) => () => void },
 *   cssRenderer?: any,
 * }} opts
 */
export function createScene({ bodies, materials, store, cssRenderer = null }) {
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

  const markers = createMarkers({ bodies, materials });
  scene.add(markers.points);
  const orbits = createOrbits({ bodies });
  scene.add(orbits.group);
  const grid = createGrid();
  scene.add(grid.group);
  const stars = createStars({ materials });
  scene.add(stars.group);
  const overlays = createOverlays({ bodies });
  scene.add(overlays.group);

  const labels = createLabelLayout({
    entries: bodies.map((def, i) => ({
      id: def.id,
      label: views[i].labelHandle,
      anchor: views[i].anchor,
      getPxRadius: () => px[i],
    })),
  });

  const viewport = { w: 1, h: 1 };
  let pixelRatio = 1;
  let selected = null;
  let debugOn = false;
  let frozen = false;
  let time = 0;

  // --- store-driven state (settings toggles, selection, DPR) ----------------------------------------------------------
  /**
   * @param {any} s
   * @param {Set<string>} [changed]
   */
  function applyState(s, changed) {
    if (!s) return;
    if (!changed || changed.has('settings')) {
      const st = s.settings || {};
      orbits.setVisible(st.showOrbits !== false);
      grid.setVisible(st.showGrid !== false);
      labels.setVisible(st.showLabels !== false);
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
   * Per-frame update (allocation-free).
   * @param {{
   *   jdTT: number,
   *   states: Record<string, {x:number,y:number,z:number}>,
   *   orientations?: Map<string, number[]>|Record<string, number[]>,
   *   dtSeconds?: number,
   *   camera: import('three').PerspectiveCamera,
   *   viewportH?: number,
   *   viewportW?: number,
   *   sizeK?: number,
   *   sunDirFor?: (id: string) => number[],
   *   tSeconds?: number,
   * }} args
   */
  function update({ jdTT, states, orientations, dtSeconds = 0, camera, viewportH, viewportW, sizeK = 1, sunDirFor, tSeconds }) {
    if (!camera) return;
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

    for (let i = 0; i < n; i++) {
      const def = bodies[i];
      const st = states ? states[def.id] : null;
      if (!st) { px[i] = 0; continue; }
      const R = displayRadiusAu(def, sizeK);
      const dx = st.x - cp.x, dy = st.y - cp.y, dz = st.z - cp.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const p = R / Math.max(d, 1.0001 * R) / tanHalf * H * 0.5;
      px[i] = p;
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
      markers.set(def.id, st.x, st.y, st.z, p);
    }
    markers.commit(t);
    orbits.update({ jdTT, states, dtSeconds, selected });
    stars.update(cp);
    labels.layout(dtSeconds, camera, viewport.w, H);
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
    getPxRadius,
    getWorldPosition,
    getDispRadiusAu,
    dispose,
  };
}
