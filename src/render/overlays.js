// Scene overlays: the alignment overlay for the active event (faint Sun→body lines for oppositions / conjunctions /
// parades / apsides, or Earth→pair rays for planet pairs and geocentric parades) with a CSS2D label whose opacity the
// caller sets ∝ time proximity, and the distance beam (dashed accent line between two bodies + a mid-point CSS2D chip).
// Geometry is preallocated; update(positions) rewrites the vertex arrays in place every frame so the lines follow the
// moving bodies. Line.computeLineDistances() allocates in r186, so the beam's lineDistance attribute is written by hand.

import {
  Group, BufferGeometry, BufferAttribute, LineSegments, Line, LineBasicMaterial, LineDashedMaterial,
  AdditiveBlending, DynamicDrawUsage, Vector3,
} from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const ACCENT = 0x7aa2ff;
const MAX_RAYS = 9;
/** Earth→pair rays are extended this far past the body (fraction of the Earth–body distance). */
const RAY_EXTEND = 1.35;

const _a = new Vector3();
const _b = new Vector3();
const _e = new Vector3();

/**
 * Read a body position from a states object ({id: {x,y,z}}), a Map, or an accessor (id, out) → filled out / [x,y,z].
 * @param {any} positions
 * @param {string} id
 * @param {Vector3} out
 * @returns {boolean} true when a position was found
 */
function readPos(positions, id, out) {
  if (!positions) return false;
  let p;
  if (typeof positions === 'function') {
    p = positions(id, out);
    if (p === out) return true;
  } else if (typeof positions.get === 'function') p = positions.get(id);
  else p = positions[id];
  if (!p) return false;
  if (p.x !== undefined) out.set(p.x, p.y, p.z);
  else out.set(p[0], p[1], p[2]);
  return true;
}

/**
 * Event kinds drawn as Earth→pair rays rather than Sun→body lines.
 * @param {string} kind
 * @param {string[]} bodies
 * @returns {boolean}
 */
export function isEarthRayKind(kind, bodies) {
  const k = String(kind || '').toLowerCase();
  if (k.includes('pair') || k.includes('geo') || k.includes('separation') || k.includes('appulse')) return true;
  if (k.includes('parade') && bodies.includes('earth')) return true;
  return false;
}

/**
 * @param {{ bodies?: Array<{ id: string }> }} [opts]
 */
export function createOverlays({ bodies = [] } = {}) {
  const group = new Group();
  group.name = 'overlays';

  // --- alignment lines ----------------------------------------------------------------------------------------------
  // BufferAttribute wraps the typed arrays without copying (Float32BufferAttribute would), so in-place writes upload
  const alignPos = new Float32Array(MAX_RAYS * 6);
  const alignGeom = new BufferGeometry();
  const alignAttr = new BufferAttribute(alignPos, 3).setUsage(DynamicDrawUsage);
  alignGeom.setAttribute('position', alignAttr);
  alignGeom.setDrawRange(0, 0);
  const alignMaterial = new LineBasicMaterial({
    color: ACCENT, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending,
  });
  const alignLines = new LineSegments(alignGeom, alignMaterial);
  alignLines.name = 'alignment';
  alignLines.renderOrder = 5;
  alignLines.frustumCulled = false;
  alignLines.visible = false;
  group.add(alignLines);

  const alignEl = document.createElement('div');
  alignEl.className = 'ovl-lbl';
  alignEl.style.pointerEvents = 'none';
  alignEl.setAttribute('role', 'note');
  const alignLabel = new CSS2DObject(alignEl);
  alignLabel.name = 'alignment-label';
  alignLabel.center.set(0.5, 1.4);
  alignLabel.visible = false;
  group.add(alignLabel);

  const alignment = {
    active: false,
    kind: '',
    /** @type {string[]} */
    bodies: [],
    mode: 'sun',
    opacity: 1,
  };

  // --- distance beam ------------------------------------------------------------------------------------------------
  const beamPos = new Float32Array(6);
  const beamDist = new Float32Array(2);
  const beamGeom = new BufferGeometry();
  const beamPosAttr = new BufferAttribute(beamPos, 3).setUsage(DynamicDrawUsage);
  const beamDistAttr = new BufferAttribute(beamDist, 1).setUsage(DynamicDrawUsage);
  beamGeom.setAttribute('position', beamPosAttr);
  beamGeom.setAttribute('lineDistance', beamDistAttr);
  const beamMaterial = new LineDashedMaterial({
    color: ACCENT, transparent: true, opacity: 0.85, depthWrite: false, dashSize: 0.02, gapSize: 0.01,
  });
  const beamLine = new Line(beamGeom, beamMaterial);
  beamLine.name = 'beam';
  beamLine.renderOrder = 5;
  beamLine.frustumCulled = false;
  beamLine.visible = false;
  group.add(beamLine);

  const chipEl = document.createElement('div');
  chipEl.className = 'beam-chip';
  chipEl.style.pointerEvents = 'none';
  chipEl.setAttribute('role', 'note');
  const chip = new CSS2DObject(chipEl);
  chip.name = 'beam-chip';
  chip.center.set(0.5, 1.3);
  chip.visible = false;
  group.add(chip);

  const beam = { a: /** @type {string|null} */ (null), b: /** @type {string|null} */ (null) };

  /**
   * Show the alignment overlay for an event.
   * @param {{ kind: string, bodies: string[], positions?: any, opacity?: number, label?: string, mode?: 'sun'|'earth' }} ev
   */
  function showAlignment({ kind, bodies: evBodies, positions, opacity = 1, label = '', mode }) {
    alignment.active = true;
    alignment.kind = kind;
    alignment.bodies = Array.isArray(evBodies) ? evBodies : [];
    alignment.mode = mode ?? (isEarthRayKind(kind, alignment.bodies) ? 'earth' : 'sun');
    setAlignmentOpacity(opacity);
    alignEl.textContent = label || '';
    alignLabel.visible = !!label;
    alignLines.visible = true;
    if (positions) update(positions);
  }

  /** @param {number} opacity 0…1 (∝ time proximity, set by the caller) */
  function setAlignmentOpacity(opacity) {
    alignment.opacity = Math.max(0, Math.min(1, opacity));
    alignMaterial.opacity = 0.35 * alignment.opacity;
    alignEl.style.opacity = alignment.opacity.toFixed(2);
  }

  function hideAlignment() {
    alignment.active = false;
    alignLines.visible = false;
    alignLabel.visible = false;
    alignGeom.setDrawRange(0, 0);
  }

  /**
   * Distance beam between two bodies (null hides it).
   * @param {string|null} idA
   * @param {string|null} idB
   * @param {string|null} [label] chip text, e.g. "0.5234 AU · 78.30 M km · 4 min 21 s"
   */
  function setBeam(idA, idB, label = null) {
    if (!idA || !idB || idA === idB) {
      beam.a = beam.b = null;
      beamLine.visible = false;
      chip.visible = false;
      return;
    }
    beam.a = idA;
    beam.b = idB;
    beamLine.visible = true;
    setBeamLabel(label);
  }

  /** @param {string|null} text */
  function setBeamLabel(text) {
    chipEl.textContent = text || '';
    chip.visible = !!text && beam.a !== null;
  }

  /**
   * Per-frame: follow the bodies. Accepts the ephemeris states object, a Map, or an accessor (id, out: Vector3).
   * @param {any} positions
   */
  function update(positions) {
    if (alignment.active) {
      let n = 0;
      let cx = 0, cy = 0, cz = 0, cn = 0;
      if (alignment.mode === 'earth' && readPos(positions, 'earth', _e)) {
        for (const id of alignment.bodies) {
          if (id === 'earth' || n >= MAX_RAYS) continue;
          if (!readPos(positions, id, _b)) continue;
          _a.copy(_b).sub(_e).multiplyScalar(RAY_EXTEND).add(_e);
          const o = n * 6;
          alignPos[o] = _e.x; alignPos[o + 1] = _e.y; alignPos[o + 2] = _e.z;
          alignPos[o + 3] = _a.x; alignPos[o + 4] = _a.y; alignPos[o + 5] = _a.z;
          cx += _b.x; cy += _b.y; cz += _b.z; cn++;
          n++;
        }
      } else {
        for (const id of alignment.bodies) {
          if (id === 'sun' || n >= MAX_RAYS) continue;
          if (!readPos(positions, id, _b)) continue;
          const o = n * 6;
          alignPos[o] = 0; alignPos[o + 1] = 0; alignPos[o + 2] = 0;
          alignPos[o + 3] = _b.x; alignPos[o + 4] = _b.y; alignPos[o + 5] = _b.z;
          cx += _b.x; cy += _b.y; cz += _b.z; cn++;
          n++;
        }
      }
      alignGeom.setDrawRange(0, n * 2);
      alignAttr.needsUpdate = true;
      alignLines.visible = n > 0;
      if (cn > 0) alignLabel.position.set(cx / cn, cy / cn, cz / cn);
    }

    if (beam.a && beam.b) {
      if (readPos(positions, beam.a, _a) && readPos(positions, beam.b, _b)) {
        beamPos[0] = _a.x; beamPos[1] = _a.y; beamPos[2] = _a.z;
        beamPos[3] = _b.x; beamPos[4] = _b.y; beamPos[5] = _b.z;
        const len = _a.distanceTo(_b);
        beamDist[0] = 0;
        beamDist[1] = len;
        beamMaterial.dashSize = len / 60;
        beamMaterial.gapSize = len / 120;
        beamPosAttr.needsUpdate = true;
        beamDistAttr.needsUpdate = true;
        chip.position.copy(_a).add(_b).multiplyScalar(0.5);
        beamLine.visible = true;
      } else {
        beamLine.visible = false;
        chip.visible = false;
      }
    }
  }

  function dispose() {
    alignGeom.dispose();
    alignMaterial.dispose();
    beamGeom.dispose();
    beamMaterial.dispose();
    alignLabel.removeFromParent(); alignEl.remove();
    chip.removeFromParent(); chipEl.remove();
    group.removeFromParent();
  }

  return {
    group,
    alignLines,
    alignLabel,
    beamLine,
    chip,
    showAlignment,
    setAlignmentOpacity,
    hideAlignment,
    setBeam,
    setBeamLabel,
    update,
    get alignment() { return alignment; },
    get beam() { return beam; },
    dispose,
    bodyIds: bodies.map((b) => b.id),
  };
}
