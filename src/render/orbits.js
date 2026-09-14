// Orbit lines (Line2/LineGeometry/LineMaterial) and the ecliptic grid.
//
// Per planet: ONE Line2 with 513 samples (512 segments) over one sidereal period centred on jdSampled, sampled from the
// injected display-tier sampler. Shape and phase are separated (critique: resampling ∝ time rate is unbounded):
// - positions are resampled only when |jdTT − jdSampled| > P/4 or > 20 y, at most one planet per frame;
// - brightness (past half brightening toward "now", future half faint) is a pure function of (jd − jdSampled)/P and is
//   rewritten IN PLACE at 10 Hz into geometry.attributes.instanceColorStart.data.array (+ needsUpdate) — LineMaterial
//   vertexColors are RGB only (no per-vertex alpha), so the fade is encoded as darkened RGB under additive blending;
// - the vertex nearest "now" is overwritten each frame with the full-tier position (the planet's own state), so the
//   line never visibly detaches from the disc at close range (display tier ≤ ~450 km).
// r186 LineGeometry.setPositions/setColors allocate a new InstancedInterleavedBuffer on every call, so they are called
// exactly once at construction; afterwards only the interleaved arrays are written. Layout of the interleaved buffer:
// segment i = 6 floats [start xyz | end xyz]; sample i is the start of segment i (i < N) and the end of segment i − 1.
// LineSegments2.onBeforeRender copies the renderer viewport (CSS px) into material.resolution every frame in r186;
// setResolution() is still provided and called on resize for completeness.

import {
  Group, Color, AdditiveBlending, BufferGeometry, Float32BufferAttribute, LineLoop, LineSegments, LineBasicMaterial,
  Mesh, PlaneGeometry, MeshBasicMaterial, DoubleSide, DynamicDrawUsage,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/** Segments per orbit line (513 samples). */
export const ORBIT_SEGMENTS = 512;
/** Resample when the sampled window has drifted by more than P/4 or 20 Julian years (days). */
const RESAMPLE_MAX_DAYS = 20 * 365.25;
const RESAMPLE_FRACTION = 0.25;
/** Brightness rewrite cadence (s). */
const BRIGHTNESS_PERIOD_S = 0.1;
const LINEWIDTH = 1.5;
const LINEWIDTH_SELECTED = 2.5;

/**
 * Trail weight for a sample at (t_sample − t_now)/P (plan §Rendering › Orbits; research §5.1).
 * Past half: 0.15 → 1 brightening toward now; future half: 0.15 → 0; beyond ±½ P: 0.15 (old) / 0 (far future).
 * @param {number} rel
 * @returns {number}
 */
export function trailWeight(rel) {
  if (rel <= 0) {
    const u = Math.min(1, Math.max(0, 1 + rel / 0.5));
    return 0.15 + 0.85 * Math.pow(u, 2.2);
  }
  return 0.15 * Math.min(1, Math.max(0, 1 - rel / 0.5));
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
  let brightAcc = BRIGHTNESS_PERIOD_S;
  let lastJd = NaN;

  const records = [];
  const byId = new Map();
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
    const colour = new Color(def.colour);
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
  }

  /**
   * Per-frame update.
   * @param {{ jdTT: number, states?: Record<string, {x:number,y:number,z:number}>, dtSeconds?: number, selected?: string|null }} args
   */
  function update({ jdTT, states, dtSeconds = 0, selected = selectedId }) {
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

    // 2. brightness at 10 Hz (or when time jumps)
    brightAcc += dtSeconds;
    const jumped = !(Math.abs(jdTT - lastJd) < 30);
    lastJd = jdTT;
    const doBright = brightAcc >= BRIGHTNESS_PERIOD_S || jumped;
    if (doBright) brightAcc = 0;

    // 3. head vertex snapped to the full-tier position
    for (const rec of records) {
      if (!rec.sampled) continue;
      if (doBright && rec !== worst) writeBrightness(rec, jdTT);
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

/** Grid ring radii (AU) and appearance (plan §Rendering › Orbits: rings 0.12, spokes 0.06, plane hint 0.05). */
export const GRID_RINGS_AU = [1, 5, 10, 30];
const GRID_COLOUR = 0x8b93a7;
const GRID_SPOKES = 12;
const GRID_SPOKE_R0 = 0.3;
const GRID_SPOKE_R1 = 32;

/**
 * Ecliptic grid: LineLoop rings at 1/5/10/30 AU, 12 spokes, CSS2D "1 AU" labels and a faint plane hint.
 */
export function createGrid() {
  const group = new Group();
  group.name = 'grid';
  const geometries = [];
  const materials = [];
  const labels = [];

  const ringMaterial = new LineBasicMaterial({ color: GRID_COLOUR, transparent: true, opacity: 0.12, depthWrite: false });
  materials.push(ringMaterial);
  const RING_POINTS = 256;
  for (const r of GRID_RINGS_AU) {
    const arr = new Float32Array(RING_POINTS * 3);
    for (let i = 0; i < RING_POINTS; i++) {
      const t = (i / RING_POINTS) * Math.PI * 2;
      arr[i * 3] = r * Math.cos(t);
      arr[i * 3 + 1] = r * Math.sin(t);
      arr[i * 3 + 2] = 0;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(arr, 3));
    geometries.push(g);
    const ring = new LineLoop(g, ringMaterial);
    ring.name = 'grid-ring:' + r;
    ring.renderOrder = 5;
    ring.frustumCulled = false;
    group.add(ring);

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

  const spokeMaterial = new LineBasicMaterial({ color: GRID_COLOUR, transparent: true, opacity: 0.06, depthWrite: false });
  materials.push(spokeMaterial);
  const spokes = new Float32Array(GRID_SPOKES * 6);
  for (let i = 0; i < GRID_SPOKES; i++) {
    const t = (i / GRID_SPOKES) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    spokes[i * 6] = GRID_SPOKE_R0 * c; spokes[i * 6 + 1] = GRID_SPOKE_R0 * s; spokes[i * 6 + 2] = 0;
    spokes[i * 6 + 3] = GRID_SPOKE_R1 * c; spokes[i * 6 + 4] = GRID_SPOKE_R1 * s; spokes[i * 6 + 5] = 0;
  }
  const spokeGeom = new BufferGeometry();
  spokeGeom.setAttribute('position', new Float32BufferAttribute(spokes, 3));
  geometries.push(spokeGeom);
  const spokeLines = new LineSegments(spokeGeom, spokeMaterial);
  spokeLines.name = 'grid-spokes';
  spokeLines.renderOrder = 5;
  spokeLines.frustumCulled = false;
  group.add(spokeLines);

  const planeGeom = new PlaneGeometry(200, 200); // XY plane = ecliptic (z = north)
  const planeMaterial = new MeshBasicMaterial({
    color: 0x1a2236, transparent: true, opacity: 0.05, side: DoubleSide, depthWrite: false,
  });
  geometries.push(planeGeom);
  materials.push(planeMaterial);
  const plane = new Mesh(planeGeom, planeMaterial);
  plane.name = 'ecliptic-plane';
  plane.renderOrder = -1;
  plane.frustumCulled = false;
  group.add(plane);

  /** @param {boolean} on */
  function setVisible(on) {
    group.visible = on;
  }

  function dispose() {
    for (const l of labels) { l.removeFromParent(); l.element.remove(); }
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    group.removeFromParent();
  }

  return { group, plane, labels, setVisible, dispose };
}
