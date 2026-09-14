// Rotational orientation of the Sun and planets in the scene frame (Horizons "Ecliptic of J2000.0", see CLAUDE.md).
//
// Non-Earth bodies: IAU WGCCRE 2015 rotational elements (Archinal et al. 2018; bodies.js) →
//   M_body→ecl = EQ_TO_ECL · R_z(α0 + 90°) · R_x(90° − δ0) · R_z(W)
// i.e. the SPICE/IAU ICRF→body rotation [W]_3 [90°−δ0]_1 [90°+α0]_3 inverted (bhqes187e.txt §8), then ICRF equatorial
// → ecliptic with the same ε76 as the positions. Column 3 of M is the north pole, column 1 the prime meridian
// (the node Q = α0 + 90° rotated about the pole by +W, right-hand rule).
//
// Earth: the 2015 IAU report gives no Earth expressions (footnote 2 — "their accuracy was poor"; the IAU 2009 W puts
// the sub-solar longitude 0.3–0.4° off, judges' critique byf0bzyiw.txt), so
//   M_earth→ecl = EQ_TO_ECL · P(T)ᵀ · R_z(GMST(UT1))
// with P = IAU 1976 precession (frames.js) and GMST = IAU 1982 (time.js). Greenwich lies at RA = GMST measured from the
// mean equinox of DATE; Pᵀ carries that direction back to J2000 (without it the 2023/2026 fixtures are 0.30°/0.34°
// off). Nutation, DUT1 and the frame bias are neglected (measured residual ≤ 0.0084° lon / ≤ 0.005° lat, critique).
//
// Times: jdTT drives the IAU elements (their epoch is TDB; |TDB − TT| ≤ 1.7 ms ≈ 2e-5° of Jupiter's W, ignored) and the
// precession; jdUT1 (≈ UTC, |UT1 − UTC| < 0.9 s ≈ 0.004°) drives Earth's spin only.
//
// All matrices are 3×3 row-major arrays acting on column vectors (vec.js conventions); angles in radians.
import { J2000, DAYS_PER_CENTURY, DEG, RAD } from './constants.js';
import { wrap360, wrap180, angleBetween } from './vec.js';
import { EQ_TO_ECL, precessionMatrix, precessionAngles } from './frames.js';
import { gmstRad, utcFromTt } from './time.js';
import { body } from './bodies.js';

/** @typedef {import('./bodies.js').PeriodicTerm} PeriodicTerm */
/** @typedef {{alpha0: number, delta0: number, W: number}} RotationElements radians: pole RA, pole Dec, prime-meridian angle */
/** @typedef {{x: number, y: number, z: number}} PosLike */

const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------------------------------------------------
// Allocation-free 3×3 helpers (vec.mat3Mul allocates a temporary; these are the per-frame path for 9 bodies)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * out = A · B, computed into locals first so `out` may alias A or B.
 * @param {ArrayLike<number>} A @param {ArrayLike<number>} B @param {number[]|Float64Array} out @returns {number[]|Float64Array}
 */
function mul3(A, B, out) {
  const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4], a5 = A[5], a6 = A[6], a7 = A[7], a8 = A[8];
  const b0 = B[0], b1 = B[1], b2 = B[2], b3 = B[3], b4 = B[4], b5 = B[5], b6 = B[6], b7 = B[7], b8 = B[8];
  out[0] = a0 * b0 + a1 * b3 + a2 * b6; out[1] = a0 * b1 + a1 * b4 + a2 * b7; out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6; out[4] = a3 * b1 + a4 * b4 + a5 * b7; out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6; out[7] = a6 * b1 + a7 * b4 + a8 * b7; out[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return out;
}

/**
 * out = R_z(a) · R_x(b) · R_z(c) (active ZXZ Euler product, expanded from the vec.js matrices):
 *   [ ca·cc − sa·cb·sc,  −ca·sc − sa·cb·cc,   sa·sb ]
 *   [ sa·cc + ca·cb·sc,  −sa·sc + ca·cb·cc,  −ca·sb ]
 *   [ sb·sc,              sb·cc,              cb    ]
 * @param {number} a @param {number} b @param {number} c radians @param {number[]|Float64Array} out
 * @returns {number[]|Float64Array}
 */
function zxz(a, b, c, out) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  out[0] = ca * cc - sa * cb * sc; out[1] = -ca * sc - sa * cb * cc; out[2] = sa * sb;
  out[3] = sa * cc + ca * cb * sc; out[4] = -sa * sc + ca * cb * cc; out[5] = -ca * sb;
  out[6] = sb * sc; out[7] = sb * cc; out[8] = cb;
  return out;
}

// Module-level scratch (allocation-free per-frame path; not re-entrant, which is fine for single-threaded callers —
// workers get their own module instance).
const SCRATCH_M = new Float64Array(9);
const SCRATCH_ELEM = { alpha0: 0, delta0: 0, W: 0 };
const SCRATCH_POLE = [0, 0, 0];
const SCRATCH_NORMAL = [0, 0, 0];

// ---------------------------------------------------------------------------------------------------------------------
// IAU elements
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Σ amp · fn(arg0 + argRate · t) in degrees, t = d (days) or T (centuries) per term (bodies.js PeriodicTerm). The
 * argument is reduced mod 360 in degrees before the radian conversion so the 1e5 °/century Mars terms keep full
 * precision far from J2000.
 * @param {PeriodicTerm[]} terms @param {(x: number) => number} fn Math.sin | Math.cos @param {number} d @param {number} T
 * @returns {number} degrees
 */
function periodicSum(terms, fn, d, T) {
  let s = 0;
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    s += t[0] * fn(wrap360(t[1] + t[2] * (t[3] === 'd' ? d : T)) * DEG);
  }
  return s;
}

/**
 * Rotational elements {α0, δ0, W} in radians at jdTT. IAU bodies: bodies.js expressions with d = jdTT − 2451545 and
 * T = d/36525, periodic terms included; α0 and W are reduced to [0, 2π), δ0 is left signed. Earth: the exact IAU-form
 * equivalent of the GMST + precession matrix, from Pᵀ·R_z(θ) = R_z(−ζ)·R_y(θ_A)·R_z(θ − z) and
 * R_y(β) = R_z(90°)·R_x(β)·R_z(−90°), which gives α0 = −ζ_A, δ0 = 90° − θ_A, W = GMST − 90° − z_A (the "W_E =
 * GMST − 90° − α0 − (ζ_A + z_A)" form of the judges' critique b1p4znxk4.txt, since α0 = −ζ_A). At J2000 this is the
 * usual W_E = GMST − 90° = 190.46°.
 * @param {string} id body id
 * @param {number} jdTT Julian date (TT)
 * @param {RotationElements} [out] reused result object
 * @param {number} [jdUT1] Earth only: JD(UT1 ≈ UTC) for GMST; defaults to utcFromTt(jdTT)
 * @returns {RotationElements}
 */
export function rotationElements(id, jdTT, out = { alpha0: 0, delta0: 0, W: 0 }, jdUT1) {
  const rot = body(id).rotation;
  const d = jdTT - J2000;
  const T = d / DAYS_PER_CENTURY;
  if (rot.model === 'gmst') {
    const { zeta, z, theta } = precessionAngles(T);
    const theta0 = gmstRad(jdUT1 === undefined ? utcFromTt(jdTT) : jdUT1);
    out.alpha0 = wrap360(-zeta * RAD) * DEG;
    out.delta0 = HALF_PI - theta;
    out.W = wrap360((theta0 - z) * RAD - 90) * DEG;
    return out;
  }
  let a = rot.alpha0[0] + rot.alpha0[1] * T;
  let dec = rot.delta0[0] + rot.delta0[1] * T;
  let w = rot.w[0] + rot.w[1] * d;
  const p = rot.periodic;
  if (p !== undefined) {
    a += periodicSum(p.alpha0, Math.sin, d, T);
    dec += periodicSum(p.delta0, Math.cos, d, T);
    w += periodicSum(p.w, Math.sin, d, T);
  }
  out.alpha0 = wrap360(a) * DEG;
  out.delta0 = dec * DEG;
  out.W = wrap360(w) * DEG;
  return out;
}

/**
 * ICRF right ascension / declination of the north pole in degrees (Bodies-tab readout). Earth: mean pole of date
 * expressed in ICRF (precession only).
 * @param {string} id @param {number} jdTT
 * @param {{raDeg: number, decDeg: number}} [out]
 * @returns {{raDeg: number, decDeg: number}}
 */
export function poleRaDec(id, jdTT, out = { raDeg: 0, decDeg: 0 }) {
  // For Earth the GMST argument does not affect the pole; jdTT is passed as the UT1 stand-in to skip utcFromTt.
  const e = rotationElements(id, jdTT, SCRATCH_ELEM, jdTT);
  out.raDeg = e.alpha0 * RAD;
  out.decDeg = e.delta0 * RAD;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Body → ecliptic rotation matrices
// ---------------------------------------------------------------------------------------------------------------------

// Earth: EQ_TO_ECL · P(T)ᵀ cached on jdTT (precession changes 0.05″/day; the cache only avoids frames.precessionMatrix's
// small allocations while the clock is paused — while playing it is rebuilt once per frame for Earth only).
const EARTH_EP = new Float64Array(9);
let earthEpJd = NaN;

/**
 * @param {number} jdTT @param {number} jdUT1 @param {number[]|Float64Array} out
 * @returns {number[]|Float64Array} EQ_TO_ECL · P(T)ᵀ · R_z(GMST(jdUT1))
 */
function earthToEcliptic(jdTT, jdUT1, out) {
  if (jdTT !== earthEpJd) {
    const P = precessionMatrix((jdTT - J2000) / DAYS_PER_CENTURY);
    // (E · Pᵀ)[i][j] = Σ_k E[i][k] · P[j][k]
    const E = EQ_TO_ECL;
    for (let i = 0; i < 3; i++) {
      const e0 = E[3 * i], e1 = E[3 * i + 1], e2 = E[3 * i + 2];
      EARTH_EP[3 * i] = e0 * P[0] + e1 * P[1] + e2 * P[2];
      EARTH_EP[3 * i + 1] = e0 * P[3] + e1 * P[4] + e2 * P[5];
      EARTH_EP[3 * i + 2] = e0 * P[6] + e1 * P[7] + e2 * P[8];
    }
    earthEpJd = jdTT;
  }
  // out = EP · R_z(θ) with R_z(θ) = [[c, −s, 0], [s, c, 0], [0, 0, 1]]
  const th = gmstRad(jdUT1);
  const c = Math.cos(th), s = Math.sin(th);
  for (let i = 0; i < 3; i++) {
    const m0 = EARTH_EP[3 * i], m1 = EARTH_EP[3 * i + 1];
    out[3 * i] = m0 * c + m1 * s;
    out[3 * i + 1] = -m0 * s + m1 * c;
    out[3 * i + 2] = EARTH_EP[3 * i + 2];
  }
  return out;
}

/**
 * Body-fixed → scene (ecliptic J2000) rotation, 3×3 row-major. Column 1 = prime meridian (+X of the body), column 3 =
 * north pole (+Z of the body); the renderer sets the mesh quaternion from it (pole on local +Z, u = 0.5 seam on +X).
 * Non-Earth: EQ_TO_ECL · R_z(α0 + 90°) · R_x(90° − δ0) · R_z(W). Earth: EQ_TO_ECL · P(T)ᵀ · R_z(GMST(jdUT1)).
 * Allocation-free when `out` is supplied.
 * @param {string} id body id
 * @param {number} jdTT Julian date (TT) — elements and precession
 * @param {number} [jdUT1] Julian date (UT1 ≈ UTC) — Earth's spin only; defaults to utcFromTt(jdTT)
 * @param {number[]|Float64Array} [out] reused length-9 array
 * @returns {number[]|Float64Array}
 */
export function bodyToEcliptic(id, jdTT, jdUT1, out = new Array(9)) {
  const rot = body(id).rotation;
  if (rot.model === 'gmst') return earthToEcliptic(jdTT, jdUT1 === undefined ? utcFromTt(jdTT) : jdUT1, out);
  const e = rotationElements(id, jdTT, SCRATCH_ELEM);
  zxz(e.alpha0 + HALF_PI, HALF_PI - e.delta0, e.W, SCRATCH_M);
  return mul3(EQ_TO_ECL, SCRATCH_M, out);
}

/**
 * Unit vector of the north pole in the scene frame (column 3 of bodyToEcliptic; independent of W / GMST).
 * @param {string} id @param {number} jdTT @param {number[]} [out]
 * @returns {number[]}
 */
export function poleEcliptic(id, jdTT, out = [0, 0, 0]) {
  const M = bodyToEcliptic(id, jdTT, jdTT, SCRATCH_M); // jdUT1 stand-in: the pole does not depend on it
  out[0] = M[2]; out[1] = M[5]; out[2] = M[8];
  return out;
}

/**
 * Unit vector of the prime meridian's equator crossing (column 1 of bodyToEcliptic) in the scene frame.
 * @param {string} id @param {number} jdTT @param {number} [jdUT1] Earth's spin (defaults to utcFromTt(jdTT))
 * @param {number[]} [out]
 * @returns {number[]}
 */
export function primeMeridianEcliptic(id, jdTT, jdUT1, out = [0, 0, 0]) {
  const M = bodyToEcliptic(id, jdTT, jdUT1, SCRATCH_M);
  out[0] = M[0]; out[1] = M[3]; out[2] = M[6];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Derived quantities
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sub-solar point in body-fixed planetographic-style coordinates: s = Mᵀ · (−P/|P|) with P the body's heliocentric
 * position (scene frame), lat = asin(s_z), lon = atan2(s_y, s_x) east of the prime meridian, wrapped to (−180°, 180°].
 * The latitude is that of the Sun's direction, i.e. the Sun's declination in the body's equatorial frame = the geodetic
 * latitude of the sub-solar point on the reference ellipsoid (Horizons Earth fixtures, bhqes187e.txt §9). Geometric
 * (no light-time or aberration). The Sun itself (|P| = 0) has no sub-solar point → NaN/NaN.
 * @param {string} id body id
 * @param {PosLike|ArrayLike<number>} pos heliocentric position, {x, y, z} state or [x, y, z] (AU, scene frame)
 * @param {number} jdTT Julian date (TT)
 * @param {number} [jdUT1] Julian date (UT1 ≈ UTC), Earth's spin (defaults to utcFromTt(jdTT))
 * @param {{latDeg: number, lonDeg: number}} [out]
 * @returns {{latDeg: number, lonDeg: number}} degrees
 */
export function subSolarPoint(id, pos, jdTT, jdUT1, out = { latDeg: 0, lonDeg: 0 }) {
  let x, y, z;
  if (typeof pos.x === 'number') { x = pos.x; y = pos.y; z = pos.z; } else { x = pos[0]; y = pos[1]; z = pos[2]; }
  const r = Math.hypot(x, y, z);
  if (!(r > 0)) { out.latDeg = NaN; out.lonDeg = NaN; return out; }
  const M = bodyToEcliptic(id, jdTT, jdUT1, SCRATCH_M);
  const ux = -x / r, uy = -y / r, uz = -z / r;
  // s = Mᵀ · u  →  s_i = Σ_j M[j][i] u_j
  const sx = M[0] * ux + M[3] * uy + M[6] * uz;
  const sy = M[1] * ux + M[4] * uy + M[7] * uz;
  const sz = M[2] * ux + M[5] * uy + M[8] * uz;
  out.latDeg = Math.asin(sz > 1 ? 1 : sz < -1 ? -1 : sz) * RAD;
  out.lonDeg = wrap180(Math.atan2(sy, sx) * RAD);
  return out;
}

/**
 * Ẇ in degrees per day (signed: negative = retrograde, Venus −1.4813688 and Uranus −501.1600928; Earth
 * 360.98564736629 from the GMST rate).
 * @param {string} id @returns {number}
 */
export function spinRateDegPerDay(id) {
  const rot = body(id).rotation;
  return rot.model === 'gmst' ? rot.spinRateDegPerDay : rot.w[1];
}

/** @param {string} id @returns {boolean} Ẇ < 0 (Venus, Uranus) */
export function isRetrograde(id) {
  return spinRateDegPerDay(id) < 0;
}

/** @param {string} id @returns {number} sidereal rotation period 360/|Ẇ| in days (Mercury 58.64615, Venus 243.0185, Sun 25.38) */
export function siderealRotationDays(id) {
  return 360 / Math.abs(spinRateDegPerDay(id));
}

/** @param {string} id @returns {number} sidereal rotation period in hours (Earth 23.934470, Jupiter 9.92492) */
export function siderealRotationHours(id) {
  return 24 * siderealRotationDays(id);
}

/**
 * Obliquity to orbit: angle between the north pole and the orbit normal P × V of the given heliocentric state, in
 * degrees (NSSDC convention, but with the IAU north pole: Venus 2.64 = 180 − 177.36, Uranus 82.23 = 180 − 97.77).
 * For the Sun (zero state, no orbit) the ecliptic north ẑ is used → 7.25° (NSSDC "obliquity to ecliptic").
 * @param {string} id
 * @param {{x: number, y: number, z: number, vx: number, vy: number, vz: number}} state heliocentric, scene frame
 * @param {number} [jdTT] epoch of the pole (default J2000; only Mars/Jupiter/Neptune/Earth poles move)
 * @returns {number} degrees in [0, 180]
 */
export function obliquityToOrbit(id, state, jdTT = J2000) {
  const pole = poleEcliptic(id, jdTT, SCRATCH_POLE);
  const n = SCRATCH_NORMAL;
  n[0] = state.y * state.vz - state.z * state.vy;
  n[1] = state.z * state.vx - state.x * state.vz;
  n[2] = state.x * state.vy - state.y * state.vx;
  if (!(n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > 0)) { n[0] = 0; n[1] = 0; n[2] = 1; }
  return angleBetween(pole, n) * RAD;
}
