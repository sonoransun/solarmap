// Orbit lines (Line2/LineGeometry/LineMaterial) and the ecliptic grid.
//
// Per planet: ONE Line2 with 513 samples (512 segments) over one sidereal period centred on jdSampled, sampled from the
// injected display-tier sampler. Shape and phase are separated (critique: resampling ∝ time rate is unbounded):
// - positions are resampled only when |jdTT − jdSampled| > P/4 or > 20 y, at most one planet per frame;
// - brightness (past half brightening toward "now", future half faint) is a pure function of (jd − jdSampled)/P and is
//   rewritten IN PLACE into geometry.attributes.instanceColorStart.data.array (+ needsUpdate) whenever the phase has
//   moved by half a sample (0.5/512 of the period) since the last write — every frame at high time rates, never while
//   paused — so the gradient slides continuously instead of in 10 Hz steps. LineMaterial vertexColors are RGB only
//   (no per-vertex alpha), so the fade is encoded as darkened RGB under additive blending;
// - the vertex nearest "now" is overwritten each frame with the full-tier position (the planet's own state), so the
//   line never visibly detaches from the disc at close range (display tier ≤ ~450 km).
// r186 LineGeometry.setPositions/setColors allocate a new InstancedInterleavedBuffer on every call, so they are called
// exactly once at construction; afterwards only the interleaved arrays are written. Layout of the interleaved buffer:
// segment i = 6 floats [start xyz | end xyz]; sample i is the start of segment i (i < N) and the end of segment i − 1.
// LineSegments2.onBeforeRender copies the renderer viewport (CSS px) into material.resolution every frame in r186;
// setResolution() is still provided and called on resize for completeness.
// Allocation discipline: update() writes typed arrays in place; the only per-frame objects are the ones three creates.

import { Group, Color, AdditiveBlending, CircleGeometry, Mesh, DynamicDrawUsage } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createGridDiscMaterial, GRID_DISC } from './skyMaterials.js';

/** Segments per orbit line (513 samples). */
export const ORBIT_SEGMENTS = 512;
/** Resample when the sampled window has drifted by more than P/4 or 20 Julian years (days). */
const RESAMPLE_MAX_DAYS = 20 * 365.25;
const RESAMPLE_FRACTION = 0.25;
/** Rewrite the brightness when the phase has moved this far (fraction of the period): half a sample. */
const BRIGHTNESS_PHASE_STEP = 0.5 / ORBIT_SEGMENTS;
const LINEWIDTH = 1.25;
const LINEWIDTH_SELECTED = 2.0;
/** Body colours are pulled slightly toward white so additive overlaps do not saturate to pure hue. */
const DESATURATE = 0.1;

/** Trail law constants (plan §Rendering › Orbits, revised after the six-lens review). */
export const TRAIL = Object.freeze({ pastMin: 0.25, pastGamma: 1.6, future: 0.12, futureJoin: 0.1 });

/**
 * Trail weight for a sample at rel = (t_sample − t_now)/P.
 * Past half (rel ∈ [−½, 0]): 0.25 → 1.0 brightening toward now with gamma 1.6, so the recent path reads as a comet
 * tail. Future half (rel ∈ (0, ½]): a constant 0.12 — faint but present, so the whole ellipse stays readable — whose
 * last 10 % (rel 0.45 → 0.5) rises to the past tail's 0.25 so the closed loop has no seam at the far side.
 * Beyond ±½ P (only reachable between resamples): the nearest end value.
 * @param {number} rel
 * @returns {number} 0.12 … 1
 */
export function trailWeight(rel) {
  if (rel <= 0) {
    const u = Math.min(1, Math.max(0, 1 + rel / 0.5));
    return TRAIL.pastMin + (1 - TRAIL.pastMin) * Math.pow(u, TRAIL.pastGamma);
  }
  const r = Math.min(0.5, rel);
  const joinStart = 0.5 - TRAIL.futureJoin * 0.5;
  if (r <= joinStart) return TRAIL.future;
  const t = (r - joinStart) / (0.5 - joinStart);
  const s = t * t * (3 - 2 * t);
  return TRAIL.future + (TRAIL.pastMin - TRAIL.future) * s;
}

/**
 * Write sample i (0…N) into an interleaved [start xyz | end xyz] segment array.
 * @param {Float32Array} arr
 * @param {number} i
 * @param {number} x @param {number} y @param {number} z
 */
function writeSample(arr, i, x, y, z) {
  if (i < ORBIT_SEGMENTS) { const o = 6 * i; arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; }
  if (i > 0) { const o = 6 * (i - 1) + 3; arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; }
}

/**
 * @param {{ bodies: Array<{ id: string, colour: number, siderealOrbitDays?: number }> }} opts
 */
export function createOrbits({ bodies }) {
  const N = ORBIT_SEGMENTS;
  const group = new Group();
  group.name = 'orbits';

  /** @type {(id: string, jdTT: number) => (number[]|{x:number,y:number,z:number})|null} */
  let sampler = null;
  /** @type {(id: string, jdTT: number) => (number[]|{x:number,y:number,z:number})|null} */
  let fullSampler = null;
  let selectedId = null;
  let lastJd = NaN;

  const records = [];
  const byId = new Map();
  const white = new Color(0xffffff);
  for (const def of bodies) {
    if (def.id === 'sun' || !(def.siderealOrbitDays > 0)) continue;
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array((N + 1) * 3));
    geometry.setColors(new Float32Array((N + 1) * 3));
    const posBuf = geometry.attributes.instanceStart.data; // InstancedInterleavedBuffer (6 floats / segment)
    const colBuf = geometry.attributes.instanceColorStart.data;
    posBuf.setUsage(DynamicDrawUsage);
    colBuf.setUsage(DynamicDrawUsage);
    const material = new LineMaterial({
      linewidth: LINEWIDTH,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      worldUnits: false,
    });
    const line = new Line2(geometry, material);
    line.name = 'orbit:' + def.id;
    line.frustumCulled = false; // bounds are never recomputed after in-place writes
    line.renderOrder = 5;
    line.visible = false; // until sampled
    group.add(line);
    const colour = new Color(def.colour).lerp(white, DESATURATE);
    const rec = {
      id: def.id,
      P: def.siderealOrbitDays,
      colour,
      line,
      geometry,
      material,
      posArr: /** @type {Float32Array} */ (posBuf.array),
      colArr: /** @type {Float32Array} */ (colBuf.array),
      posBuf,
      colBuf,
      samples: new Float32Array((N + 1) * 3), // display-tier samples (restored when the head moves on)
      jdSampled: NaN,
      headIdx: -1,
      sampled: false,
      lastShift: NaN, // phase (jdSampled − jd)/P at the last brightness write
    };
    records.push(rec);
    byId.set(def.id, rec);
  }

  /**
   * @param {typeof records[0]} rec
   * @param {number} jdTT
   */
  function resample(rec, jdTT) {
    const { P, samples, posArr } = rec;
    for (let i = 0; i <= N; i++) {
      const t = jdTT + (i / N - 0.5) * P;
      const p = sampler(rec.id, t);
      if (!p) return;
      const x = p.x !== undefined ? p.x : p[0];
      const y = p.y !== undefined ? p.y : p[1];
      const z = p.z !== undefined ? p.z : p[2];
      samples[i * 3] = x; samples[i * 3 + 1] = y; samples[i * 3 + 2] = z;
      writeSample(posArr, i, x, y, z);
    }
    rec.posBuf.needsUpdate = true;
    rec.jdSampled = jdTT;
    rec.headIdx = -1;
    rec.sampled = true;
    rec.line.visible = true;
    writeBrightness(rec, jdTT);
  }

  /**
   * @param {typeof records[0]} rec
   * @param {number} jdTT
   */
  function writeBrightness(rec, jdTT) {
    const { P, colArr, colour } = rec;
    const shift = (rec.jdSampled - jdTT) / P;
    for (let i = 0; i <= N; i++) {
      const w = trailWeight((i / N - 0.5) + shift);
      const r = colour.r * w, g = colour.g * w, b = colour.b * w;
      if (i < N) { const o = 6 * i; colArr[o] = r; colArr[o + 1] = g; colArr[o + 2] = b; }
      if (i > 0) { const o = 6 * (i - 1) + 3; colArr[o] = r; colArr[o + 1] = g; colArr[o + 2] = b; }
    }
    rec.colBuf.needsUpdate = true;
    rec.lastShift = shift;
  }

  /**
   * Per-frame update.
   * @param {{ jdTT: number, states?: Record<string, {x:number,y:number,z:number}>, dtSeconds?: number, selected?: string|null }} args
   */
  function update({ jdTT, states, selected = selectedId }) {
    if (!sampler) return;
    if (selected !== selectedId) setSelected(selected);

    // 1. at most one resample per frame: the planet with the largest drift ratio
    let worst = null;
    let worstRatio = 1;
    for (const rec of records) {
      const ratio = rec.sampled
        ? Math.abs(jdTT - rec.jdSampled) / Math.min(rec.P * RESAMPLE_FRACTION, RESAMPLE_MAX_DAYS)
        : Infinity;
      if (ratio > worstRatio) { worstRatio = ratio; worst = rec; }
    }
    if (worst) resample(worst, jdTT);

    // 2. a time jump (scrub, event jump) rewrites every gradient at once
    const jumped = !(Math.abs(jdTT - lastJd) < 30);
    lastJd = jdTT;

    // 3. brightness when the phase moved by half a sample; head vertex snapped to the full-tier position
    for (const rec of records) {
      if (!rec.sampled) continue;
      if (rec !== worst) {
        const shift = (rec.jdSampled - jdTT) / rec.P;
        if (jumped || !(Math.abs(shift - rec.lastShift) < BRIGHTNESS_PHASE_STEP)) writeBrightness(rec, jdTT);
      }
      const idx = Math.max(0, Math.min(N, Math.round(N * (0.5 + (jdTT - rec.jdSampled) / rec.P))));
      const st = states ? states[rec.id] : null;
      let hx, hy, hz;
      if (st) { hx = st.x; hy = st.y; hz = st.z; }
      else if (fullSampler) {
        const p = fullSampler(rec.id, jdTT);
        if (!p) continue;
        hx = p.x !== undefined ? p.x : p[0]; hy = p.y !== undefined ? p.y : p[1]; hz = p.z !== undefined ? p.z : p[2];
      } else continue;
      if (rec.headIdx !== idx) {
        if (rec.headIdx >= 0) {
          const s = rec.samples, o = rec.headIdx * 3;
          writeSample(rec.posArr, rec.headIdx, s[o], s[o + 1], s[o + 2]);
        }
        rec.headIdx = idx;
      }
      writeSample(rec.posArr, idx, hx, hy, hz);
      rec.posBuf.needsUpdate = true;
    }
  }

  /**
   * Sample every planet synchronously (e.g. once after loading, before the first frame).
   * @param {number} jdTT
   */
  function prime(jdTT) {
    if (!sampler) return;
    for (const rec of records) resample(rec, jdTT);
  }

  /** @param {(id: string, jdTT: number) => number[]|{x:number,y:number,z:number}} fn display-tier position sampler */
  function setSampler(fn) {
    sampler = fn;
    for (const rec of records) rec.sampled = false;
  }

  /** @param {(id: string, jdTT: number) => number[]|{x:number,y:number,z:number}} fn full-tier position sampler */
  function setFullSampler(fn) {
    fullSampler = fn;
  }

  /** @param {string|null} id */
  function setSelected(id) {
    selectedId = id ?? null;
    for (const rec of records) rec.material.linewidth = rec.id === selectedId ? LINEWIDTH_SELECTED : LINEWIDTH;
  }

  /** @param {number} w CSS px @param {number} h CSS px */
  function setResolution(w, h) {
    for (const rec of records) rec.material.resolution.set(w, h);
  }

  /** @param {boolean} on */
  function setVisible(on) {
    group.visible = on;
  }

  function dispose() {
    for (const rec of records) {
      rec.geometry.dispose();
      rec.material.dispose();
    }
    group.removeFromParent();
  }

  return {
    group,
    lines: byId,
    update,
    prime,
    setSampler,
    setFullSampler,
    setSelected,
    setResolution,
    setVisible,
    dispose,
  };
}

/** Grid ring radii (AU) — also the uRings of the disc shader. */
export const GRID_RINGS_AU = GRID_DISC.rings;
/** Disc radius (AU): the plane hint, rings and spokes have all faded out here. */
export const GRID_FADE_AU = GRID_DISC.fadeAu;

/**
 * Ecliptic grid: ONE analytic disc mesh (shaders/grid.js) — radial-gradient plane hint fading out by 45 AU, rings at
 * 1/5/10/30 AU (opacity 0.10) and 12 spokes every 30° of ecliptic longitude (0.05), anti-aliased with screen-space
 * derivatives — plus CSS2D "1 AU" labels (class 'grid-lbl', styled in scene.css).
 */
export function createGrid() {
  const group = new Group();
  group.name = 'grid';
  const labels = [];

  const discGeom = new CircleGeometry(GRID_FADE_AU, 128); // XY plane = ecliptic (z = north)
  const discMaterial = createGridDiscMaterial();
  const disc = new Mesh(discGeom, discMaterial);
  disc.name = 'ecliptic-grid';
  disc.renderOrder = -1;
  disc.frustumCulled = false;
  group.add(disc);

  for (const r of GRID_RINGS_AU) {
    const el = document.createElement('div');
    el.className = 'grid-lbl';
    el.textContent = r + ' AU';
    el.style.pointerEvents = 'none';
    el.setAttribute('aria-hidden', 'true');
    const label = new CSS2DObject(el);
    label.name = 'grid-label:' + r;
    label.center.set(0, 1);
    label.position.set(r, 0, 0);
    group.add(label);
    labels.push(label);
  }

  /** @param {boolean} on */
  function setVisible(on) {
    group.visible = on;
  }

  function dispose() {
    for (const l of labels) { l.removeFromParent(); l.element.remove(); }
    discGeom.dispose();
    discMaterial.dispose();
    group.removeFromParent();
  }

  return { group, plane: disc, disc, material: discMaterial, labels, setVisible, dispose };
}
