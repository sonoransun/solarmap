// Geometry over one ephemeris snapshot: heliocentric longitudes, geocentric vectors, elongation, angular separation,
// phase angle, distances / light-time, orbital speed, heliocentric "parade" arcs and the geocentric evening/morning
// parade — plan §"Distances (geometry.js)" and §"Events" (alignment-events research bq2vila6z.txt §A.1–A.6).
//
// Every function takes a states object S = {sun, mercury, …, neptune} as returned by ephemeris.states(jdTT):
// heliocentric {x, y, z, vx, vy, vz} in the SCENE frame (Horizons "Ecliptic of J2000.0", CLAUDE.md), AU and AU/day.
// The Sun is the origin. Angles are radians unless the name ends in Deg; distances AU unless the name says km.
//
// Hot-path rule (CLAUDE.md): the events scan calls these on a daily grid (≈45 scalar functions per day) and the UI every
// frame, so the scalar variants allocate nothing (module-level scratch vectors, like time.js — not re-entrant) and the
// object-returning variants accept an optional `out`.
import { AU_KM, DAY_S, LIGHT_TIME_AU_S, RAD } from './constants.js';
import { angleBetween, wrap2Pi } from './vec.js';
import { PLANETS, BODIES } from './ephemeris.js';

/** Number of bodies in the distance table (Sun + 8 planets) and the resulting number of unordered pairs (C(9,2) = 36). */
export const DISTANCE_TABLE_BODIES = BODIES.length;
export const DISTANCE_TABLE_PAIRS = (DISTANCE_TABLE_BODIES * (DISTANCE_TABLE_BODIES - 1)) / 2;

/** Default elongation threshold (degrees) for the geocentric "planet parade" — research bq2vila6z.txt §A.5. */
export const PARADE_MIN_ELONGATION_DEG = 10;

// Scratch vectors (plain arrays, vec.js style) so the scalar functions allocate nothing.
const G = [0, 0, 0];   // geocentric vector of a body
const G2 = [0, 0, 0];  // geocentric vector of a second body
const SV = [0, 0, 0];  // geocentric Sun vector s = −E
const P1 = [0, 0, 0];  // body → Sun
const P2 = [0, 0, 0];  // body → Earth

/**
 * @typedef {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} State
 * @typedef {Record<string, State>} States  keys: 'sun', 'mercury', …, 'neptune'
 */

/** @param {States} S @param {string} id @returns {State} */
function stateOf(S, id) {
  const st = S[id];
  if (st === undefined) throw new RangeError(`geometry: unknown body '${id}'`);
  return st;
}

// ---------------------------------------------------------------------------------------------------------------------
// Longitudes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Heliocentric ecliptic longitude (J2000 ecliptic): λ = atan2(y, x) — research bq2vila6z.txt §A.5 "L_i = atan2(P_iy, P_ix)".
 * @param {States} S @param {string} id planet id (the Sun's longitude is undefined → NaN)
 * @returns {number} radians in [0, 2π)
 */
export function helioLongitudeRad(S, id) {
  const p = stateOf(S, id);
  if (p.x === 0 && p.y === 0) return NaN;
  return wrap2Pi(Math.atan2(p.y, p.x));
}

/** @param {States} S @param {string} id @returns {number} degrees in [0, 360) */
export function helioLongitudeDeg(S, id) {
  return helioLongitudeRad(S, id) * RAD;
}

/**
 * sin and cos of the longitude difference λ_a − λ_b of two xy-projected vectors, from the projections themselves
 * (no atan2, so the result is a smooth root function for scanBrackets — numeric.js alias guard, research §B.4):
 *   (b × a)_z = |a_xy||b_xy| sin(λ_a − λ_b),   a·b (xy) = |a_xy||b_xy| cos(λ_a − λ_b).
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 * @param {{sin:number, cos:number}} [out]
 * @returns {{sin:number, cos:number}} both NaN when either projection is the zero vector
 */
export function lonDeltaSinCos(ax, ay, bx, by, out = { sin: 0, cos: 0 }) {
  const n = Math.hypot(ax, ay) * Math.hypot(bx, by);
  out.sin = (bx * ay - by * ax) / n;
  out.cos = (ax * bx + ay * by) / n;
  return out;
}

/**
 * sin/cos of the HELIOCENTRIC longitude difference λ_a − λ_b (opposition/conjunction root functions: plan §Events
 * "zero of sin(Δλ)" with the sign of cos Δλ selecting the class).
 * @param {States} S @param {string} a @param {string} b @param {{sin:number, cos:number}} [out]
 * @returns {{sin:number, cos:number}}
 */
export function helioLonDeltaSinCos(S, a, b, out) {
  const A = stateOf(S, a), B = stateOf(S, b);
  return lonDeltaSinCos(A.x, A.y, B.x, B.y, out);
}

/**
 * sin/cos of the GEOCENTRIC ecliptic-longitude difference λgeo_a − λgeo_b (planet–planet λ-conjunction trigger,
 * plan §Events "zero of sin(λgeo_a − λgeo_b) with cos > 0"). 'sun' is allowed (its geocentric vector is −E).
 * @param {States} S @param {string} a @param {string} b @param {{sin:number, cos:number}} [out]
 * @returns {{sin:number, cos:number}}
 */
export function geoLonDeltaSinCos(S, a, b, out) {
  geocentric(S, a, G);
  geocentric(S, b, G2);
  return lonDeltaSinCos(G[0], G[1], G2[0], G2[1], out);
}

/**
 * Geocentric ecliptic longitude of a body (J2000 ecliptic): atan2 of the geocentric vector; for 'sun' this is λ_☉.
 * @param {States} S @param {string} id @returns {number} radians in [0, 2π) (NaN for 'earth')
 */
export function geocentricLongitudeRad(S, id) {
  geocentric(S, id, G);
  if (G[0] === 0 && G[1] === 0) return NaN;
  return wrap2Pi(Math.atan2(G[1], G[0]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Vectors, distances
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Geocentric position vector g = P − E (for 'sun': s = −E) in AU, scene frame.
 * @param {States} S @param {string} id any of BODIES
 * @param {number[]} [out] reused length-3 array
 * @returns {number[]}
 */
export function geocentric(S, id, out = [0, 0, 0]) {
  const p = stateOf(S, id), e = stateOf(S, 'earth');
  out[0] = p.x - e.x; out[1] = p.y - e.y; out[2] = p.z - e.z;
  return out;
}

/**
 * Straight-line distance between two bodies, AU (heliocentric vectors differ, the Sun is the origin).
 * @param {States} S @param {string} a @param {string} b @returns {number} AU
 */
export function distanceAu(S, a, b) {
  const A = stateOf(S, a), B = stateOf(S, b);
  return Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
}

/**
 * Light-time for a distance: t = d_km / c = au · (AU_KM / C_KM_S) = au · 499.004783836 s (1 AU = 8.3167464 min);
 * AU_KM = 149,597,870.700 (IAU 2012), c = 299,792.458 km/s — plan §Distances.
 * @param {number} au @returns {number} seconds
 */
export function lightTimeSeconds(au) {
  return au * LIGHT_TIME_AU_S;
}

/**
 * Orbital (heliocentric) speed |v| converted from AU/day to km/s: |v| · AU_KM / 86400 — plan §Distances.
 * @param {State} state @returns {number} km/s
 */
export function orbitalSpeedKmS(state) {
  return Math.hypot(state.vx, state.vy, state.vz) * AU_KM / DAY_S;
}

/**
 * @typedef {{a:string, b:string, au:number, km:number, lightSeconds:number}} DistanceRow
 */

/**
 * Distance table over the 36 unordered pairs of {Sun, 8 planets} in BODIES order (a before b): AU, km = AU × AU_KM,
 * light-time seconds — plan §"Distances (geometry.js)". Symmetric by construction (one row per pair).
 * @param {States} S
 * @param {DistanceRow[]} [out] reused array of 36 row objects (filled in place; rows are created only when missing)
 * @returns {DistanceRow[]}
 */
export function distanceTable(S, out = []) {
  let r = 0;
  for (let i = 0; i < BODIES.length; i++) {
    for (let j = i + 1; j < BODIES.length; j++, r++) {
      const au = distanceAu(S, BODIES[i], BODIES[j]);
      let row = out[r];
      if (row === undefined) row = out[r] = { a: '', b: '', au: 0, km: 0, lightSeconds: 0 };
      row.a = BODIES[i]; row.b = BODIES[j];
      row.au = au; row.km = au * AU_KM; row.lightSeconds = au * LIGHT_TIME_AU_S;
    }
  }
  out.length = r;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Angles seen from Earth
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Elongation ψ = angle between the geocentric body vector g = P − E and the geocentric Sun vector s = −E
 * (research bq2vila6z.txt §A.3; atan2 form of angleBetween, never acos — CLAUDE.md).
 * @param {States} S @param {string} id any of BODIES ('sun' → 0; 'earth' → NaN)
 * @returns {number} radians in [0, π]
 */
export function elongationRad(S, id) {
  if (id === 'earth') return NaN;
  geocentric(S, id, G);
  geocentric(S, 'sun', SV);
  return angleBetween(G, SV);
}

/** @param {States} S @param {string} id @returns {number} degrees in [0, 180] */
export function elongationDeg(S, id) {
  return elongationRad(S, id) * RAD;
}

/**
 * Side of the Sun: 'E' (eastern = evening sky) if sin(λ_P − λ_☉) > 0, else 'W' (western = morning) — research §A.3.
 * With geocentric ecliptic longitudes λ_P of g and λ_☉ of s, sin(λ_P − λ_☉) has the sign of (s × g)_z = s_x g_y − s_y g_x,
 * so no atan2 is needed. Exactly 0 (body on the Sun–Earth line) → 'W'.
 * @param {States} S @param {string} id any planet ('earth' → null)
 * @returns {'E'|'W'|null}
 */
export function elongationSide(S, id) {
  if (id === 'earth') return null;
  geocentric(S, id, G);
  geocentric(S, 'sun', SV);
  return SV[0] * G[1] - SV[1] * G[0] > 0 ? 'E' : 'W';
}

/**
 * @typedef {{psiRad:number, psiDeg:number, side:'E'|'W'|null}} Elongation
 */

/**
 * Elongation with its side, for the Bodies tab and the greatest-elongation event.
 * @param {States} S @param {string} id
 * @param {Elongation} [out] reused object
 * @returns {Elongation}
 */
export function elongation(S, id, out = { psiRad: 0, psiDeg: 0, side: null }) {
  out.psiRad = elongationRad(S, id);
  out.psiDeg = out.psiRad * RAD;
  out.side = elongationSide(S, id);
  return out;
}

/**
 * Angular separation between two bodies as seen from the Earth's centre: angleBetween(g_a, g_b) — Meeus AA ch. 17
 * "least distance", research §A.4 (b).
 * @param {States} S @param {string} a @param {string} b any of BODIES except 'earth'
 * @returns {number} radians in [0, π]
 */
export function separationRad(S, a, b) {
  geocentric(S, a, G);
  geocentric(S, b, G2);
  return angleBetween(G, G2);
}

/** @param {States} S @param {string} a @param {string} b @returns {number} degrees */
export function separationDeg(S, a, b) {
  return separationRad(S, a, b) * RAD;
}

/**
 * @typedef {{rad:number, deg:number, arcmin:number}} Separation
 */

/**
 * Separation in radians, degrees and arcminutes (the events engine stores separations in arcminutes — research §A.4).
 * @param {States} S @param {string} a @param {string} b @param {Separation} [out]
 * @returns {Separation}
 */
export function separation(S, a, b, out = { rad: 0, deg: 0, arcmin: 0 }) {
  out.rad = separationRad(S, a, b);
  out.deg = out.rad * RAD;
  out.arcmin = out.deg * 60;
  return out;
}

/**
 * Phase angle: angle at the body between the directions to the Sun (−P) and to the Earth (E − P) — Meeus AA ch. 41
 * (i = angle Sun–planet–Earth; 0 = fully lit as seen from Earth). Undefined for the Sun and the Earth → NaN.
 * @param {States} S @param {string} id planet id
 * @returns {number} radians in [0, π]
 */
export function phaseAngleRad(S, id) {
  if (id === 'earth' || id === 'sun') return NaN;
  const p = stateOf(S, id), e = stateOf(S, 'earth');
  P1[0] = -p.x; P1[1] = -p.y; P1[2] = -p.z;
  P2[0] = e.x - p.x; P2[1] = e.y - p.y; P2[2] = e.z - p.z;
  return angleBetween(P1, P2);
}

/** @param {States} S @param {string} id @returns {number} degrees */
export function phaseAngleDeg(S, id) {
  return phaseAngleRad(S, id) * RAD;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parades
// ---------------------------------------------------------------------------------------------------------------------

const N_PLANETS = PLANETS.length;
const LON_DEG = new Float64Array(N_PLANETS);        // heliocentric longitudes, degrees
const ORDER = new Int8Array(N_PLANETS);             // planet indices sorted by longitude

/**
 * @typedef {{arcDeg:number, members:string[]}} ParadeArc
 */

/**
 * Smallest arc of heliocentric longitude containing k of the 8 planets — research bq2vila6z.txt §A.5:
 * "sort L, for each i compute arc_i = (L_{(i+k−1) mod n} − L_i) mod 360, take the minimum". For k = 8 this is
 * 360° − (largest gap). Members are listed in increasing longitude from the arc's leading (lowest-longitude) planet.
 * @param {States} S
 * @param {number} k integer 1…8
 * @param {ParadeArc} [out] reused object (members array refilled in place)
 * @returns {ParadeArc}
 */
export function paradeArc(S, k, out = { arcDeg: 0, members: [] }) {
  if (!Number.isInteger(k) || k < 1 || k > N_PLANETS) throw new RangeError(`paradeArc: k must be an integer 1…${N_PLANETS}`);
  for (let i = 0; i < N_PLANETS; i++) {
    LON_DEG[i] = helioLongitudeDeg(S, PLANETS[i]);
    ORDER[i] = i;
  }
  // Insertion sort of the 8 indices by longitude (allocation-free; n = 8).
  for (let i = 1; i < N_PLANETS; i++) {
    const idx = ORDER[i], key = LON_DEG[idx];
    let j = i - 1;
    while (j >= 0 && LON_DEG[ORDER[j]] > key) { ORDER[j + 1] = ORDER[j]; j--; }
    ORDER[j + 1] = idx;
  }
  let best = Infinity, bestStart = 0;
  for (let i = 0; i < N_PLANETS; i++) {
    const j = (i + k - 1) % N_PLANETS;
    let arc = LON_DEG[ORDER[j]] - LON_DEG[ORDER[i]];
    if (arc < 0) arc += 360;
    if (arc < best) { best = arc; bestStart = i; }
  }
  out.arcDeg = best;
  const members = out.members;
  members.length = 0;
  for (let m = 0; m < k; m++) members.push(PLANETS[ORDER[(bestStart + m) % N_PLANETS]]);
  return out;
}

/**
 * @typedef {{evening:string[], morning:string[]}} GeocentricParade
 */

/**
 * Geocentric "planet parade": the planets (Earth excluded) with elongation > minElongDeg, grouped by side of the Sun —
 * 'E' → evening (eastern) sky, 'W' → morning (western) — research bq2vila6z.txt §A.5 (e.g. the 2025-02-28
 * "seven-planet parade"). Lists are in PLANETS (Sun-outward) order.
 * @param {States} S
 * @param {number} [minElongDeg] threshold, default PARADE_MIN_ELONGATION_DEG (10°)
 * @param {GeocentricParade} [out] reused object (arrays refilled in place)
 * @returns {GeocentricParade}
 */
export function geocentricParade(S, minElongDeg = PARADE_MIN_ELONGATION_DEG, out = { evening: [], morning: [] }) {
  out.evening.length = 0;
  out.morning.length = 0;
  for (let i = 0; i < N_PLANETS; i++) {
    const id = PLANETS[i];
    if (id === 'earth') continue;
    if (elongationDeg(S, id) > minElongDeg) {
      (elongationSide(S, id) === 'E' ? out.evening : out.morning).push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Screen projection (pure helper for the marker system; no three.js here)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Projected radius in CSS pixels of a sphere of radius R at distance d for a perspective camera with vertical field of
 * view fovRad and canvas height H px — plan §Rendering "Markers": pxRadius = R / max(d, 1.0001 R) / tan(fov/2) · H/2
 * (three.js research bgcq10pmt.txt §2.3; small-angle form, the max() guards the inside-the-sphere case).
 * @param {number} R sphere radius (any length unit)
 * @param {number} d camera–centre distance (same unit)
 * @param {number} fovRad vertical field of view, radians
 * @param {number} H canvas CSS height, px
 * @returns {number} px
 */
export function pxRadius(R, d, fovRad, H) {
  return R / Math.max(d, 1.0001 * R) / Math.tan(fovRad / 2) * (H / 2);
}
