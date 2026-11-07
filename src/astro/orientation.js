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
//   M_earth→ecl = EQ_TO_ECL · P(T)ᵀ · N(T)ᵀ · R_z(GAST(UT1, TT))
// with P = IAU 1976 precession (frames.js), N = IAU 1980 nutation (nutation.js) and GAST = GMST (IAU 1982, time.js)
// + Δψ cos ε (equation of the equinoxes, Meeus p. 88). Greenwich lies at RA = GAST measured from the TRUE equinox of
// DATE along the true equator; Nᵀ Pᵀ carry that direction back to J2000 (without P the 2023/2026 fixtures are
// 0.30°/0.34° off; nutation moves the pole by ≤ 17″ and Greenwich by ≤ 1.1 s of time). DUT1 and the frame bias are
// neglected. The Moon uses the IAU 2015 Table 2 elements (bodies.js) through the same generic path as the planets
// (with the −1.4e-12 d² term of W).
//
// Times: jdTT drives the IAU elements (their epoch is TDB; |TDB − TT| ≤ 1.7 ms ≈ 2e-5° of Jupiter's W, ignored),
// the precession and the nutation; jdUT1 (≈ UTC, |UT1 − UTC| < 0.9 s ≈ 0.004°) drives Earth's spin only.
//
// All matrices are 3×3 row-major arrays acting on column vectors (vec.js conventions); angles in radians.
import { J2000, DAYS_PER_CENTURY, DEG, RAD } from './constants.js';
import { wrap360, wrap180, angleBetween } from './vec.js';
import { EQ_TO_ECL, ECL_TO_EQ, precessionMatrix } from './frames.js';
import { utcFromTt } from './time.js';
import { nutationMatrix, gastRad } from './nutation.js';
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
const SCRATCH_Q = new Float64Array(9);
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
 * IAU-form elements {α0, δ0, W} of an ICRF-equatorial body→inertial rotation Q = R_z(α0 + 90°)·R_x(90° − δ0)·R_z(W):
 * the pole is column 3 (α0 = atan2(Q₁₂, Q₀₂), δ0 = asin(Q₂₂)), the node Q = α0 + 90° is q = (−sin α0, cos α0, 0) and
 * W is the right-handed angle about the pole from q to the prime meridian p = column 1: W = atan2((q × p)·pole, q·p).
 * Exact inverse of the ZXZ product for any proper rotation (used for the Earth, whose matrix is built from precession,
 * nutation and GAST rather than from tabulated elements).
 * @param {ArrayLike<number>} Q @param {RotationElements} out @returns {RotationElements}
 */
function elementsFromMatrix(Q, out) {
  const px = Q[2], py = Q[5], pz = Q[8];
  const alpha0 = Math.atan2(py, px);
  const qx = -Math.sin(alpha0), qy = Math.cos(alpha0);
  const mx = Q[0], my = Q[3], mz = Q[6];
  // (q × m)·pole with q_z = 0: q × m = (qy mz, −qx mz, qx my − qy mx)
  const sinW = (qy * mz) * px + (-qx * mz) * py + (qx * my - qy * mx) * pz;
  const cosW = qx * mx + qy * my;
  out.alpha0 = wrap360(alpha0 * RAD) * DEG;
  out.delta0 = Math.asin(pz > 1 ? 1 : pz < -1 ? -1 : pz);
  out.W = wrap360(Math.atan2(sinW, cosW) * RAD) * DEG;
  return out;
}

/**
 * Rotational elements {α0, δ0, W} in radians at jdTT. IAU bodies: bodies.js expressions with d = jdTT − 2451545 and
 * T = d/36525, periodic terms (and the Moon's d² term of W) included; α0 and W are reduced to [0, 2π), δ0 is left
 * signed. Earth: the exact IAU-form decomposition (elementsFromMatrix) of Pᵀ·Nᵀ·R_z(GAST) — the TRUE pole of date in
 * ICRF coordinates (α0 ≈ −ζ_A, δ0 ≈ 90° − θ_A, both displaced by the nutation ≤ 17″) and W = angle from the node to
 * Greenwich; without nutation this reduces to the critique's W_E = GMST − 90° − z_A (b1p4znxk4.txt), which at J2000
 * is the usual W_E = GMST − 90° = 190.46°.
 * @param {string} id body id
 * @param {number} jdTT Julian date (TT)
 * @param {RotationElements} [out] reused result object
 * @param {number} [jdUT1] Earth only: JD(UT1 ≈ UTC) for GAST; defaults to utcFromTt(jdTT)
 * @returns {RotationElements}
 */
export function rotationElements(id, jdTT, out = { alpha0: 0, delta0: 0, W: 0 }, jdUT1) {
  const rot = body(id).rotation;
  const d = jdTT - J2000;
  const T = d / DAYS_PER_CENTURY;
  if (rot.model === 'gmst') {
    earthToEcliptic(jdTT, jdUT1 === undefined ? utcFromTt(jdTT) : jdUT1, SCRATCH_M);
    mul3(ECL_TO_EQ, SCRATCH_M, SCRATCH_Q); // Q = ECL_TO_EQ · M = Pᵀ·Nᵀ·R_z(GAST)
    return elementsFromMatrix(SCRATCH_Q, out);
  }
  let a = rot.alpha0[0] + rot.alpha0[1] * T;
  let dec = rot.delta0[0] + rot.delta0[1] * T;
  let w = rot.w[0] + rot.w[1] * d + (rot.wQuad === undefined ? 0 : rot.wQuad * d * d);
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
 * ICRF right ascension / declination of the north pole in degrees (Bodies-tab readout). Earth: TRUE pole of date
 * (precession + nutation) expressed in ICRF.
 * @param {string} id @param {number} jdTT
 * @param {{raDeg: number, decDeg: number}} [out]
 * @returns {{raDeg: number, decDeg: number}}
 */
export function poleRaDec(id, jdTT, out = { raDeg: 0, decDeg: 0 }) {
  // For Earth the GAST argument does not affect the pole; jdTT is passed as the UT1 stand-in to skip utcFromTt.
  const e = rotationElements(id, jdTT, SCRATCH_ELEM, jdTT);
  out.raDeg = e.alpha0 * RAD;
  out.decDeg = e.delta0 * RAD;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Body → ecliptic rotation matrices
// ---------------------------------------------------------------------------------------------------------------------

// Earth: EQ_TO_ECL · P(T)ᵀ · N(T)ᵀ cached on jdTT (precession changes 0.05″/day, nutation < 0.01″/day; the cache
// avoids frames.precessionMatrix's small allocations while the clock is paused — while playing it is rebuilt once per
// frame for Earth only).
const EARTH_EP = new Float64Array(9);
const EARTH_N = new Float64Array(9);
const EARTH_NP = new Float64Array(9);
let earthEpJd = NaN;

/**
 * @param {number} jdTT @param {number} jdUT1 @param {number[]|Float64Array} out
 * @returns {number[]|Float64Array} EQ_TO_ECL · P(T)ᵀ · N(T)ᵀ · R_z(GAST(jdUT1, jdTT))
 */
function earthToEcliptic(jdTT, jdUT1, out) {
  if (jdTT !== earthEpJd) {
    const P = precessionMatrix((jdTT - J2000) / DAYS_PER_CENTURY);
    const NP = mul3(nutationMatrix(jdTT, EARTH_N), P, EARTH_NP); // N·P: J2000 → true equator/equinox of date
    // (E · (NP)ᵀ)[i][j] = Σ_k E[i][k] · NP[j][k]
    const E = EQ_TO_ECL;
    for (let i = 0; i < 3; i++) {
      const e0 = E[3 * i], e1 = E[3 * i + 1], e2 = E[3 * i + 2];
      EARTH_EP[3 * i] = e0 * NP[0] + e1 * NP[1] + e2 * NP[2];
      EARTH_EP[3 * i + 1] = e0 * NP[3] + e1 * NP[4] + e2 * NP[5];
      EARTH_EP[3 * i + 2] = e0 * NP[6] + e1 * NP[7] + e2 * NP[8];
    }
    earthEpJd = jdTT;
  }
  // out = EP · R_z(θ) with R_z(θ) = [[c, −s, 0], [s, c, 0], [0, 0, 1]], θ = GAST
  const th = gastRad(jdUT1, jdTT);
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
 * Non-Earth (planets, Sun, Moon): EQ_TO_ECL · R_z(α0 + 90°) · R_x(90° − δ0) · R_z(W).
 * Earth: EQ_TO_ECL · P(T)ᵀ · N(T)ᵀ · R_z(GAST(jdUT1, jdTT)). Allocation-free when `out` is supplied.
 * @param {string} id body id
 * @param {number} jdTT Julian date (TT) — elements, precession and nutation
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
  return subPoint(id, -x / r, -y / r, -z / r, jdTT, jdUT1, out);
}

/**
 * Body-fixed latitude/longitude of the point under a unit direction u (scene frame): s = Mᵀ·u, lat = asin(s_z),
 * lon = atan2(s_y, s_x) EAST of the prime meridian in (−180°, 180°] (planetocentric; Horizons prints the same
 * quantity planetodetic and, for the prograde planets, WEST-positive — see test/orientation.test.mjs).
 * @param {string} id @param {number} ux @param {number} uy @param {number} uz @param {number} jdTT @param {number} [jdUT1]
 * @param {{latDeg: number, lonDeg: number}} out @returns {{latDeg: number, lonDeg: number}}
 */
function subPoint(id, ux, uy, uz, jdTT, jdUT1, out) {
  const M = bodyToEcliptic(id, jdTT, jdUT1, SCRATCH_M);
  // s = Mᵀ · u  →  s_i = Σ_j M[j][i] u_j
  const sx = M[0] * ux + M[3] * uy + M[6] * uz;
  const sy = M[1] * ux + M[4] * uy + M[7] * uz;
  const sz = M[2] * ux + M[5] * uy + M[8] * uz;
  out.latDeg = Math.asin(sz > 1 ? 1 : sz < -1 ? -1 : sz) * RAD;
  out.lonDeg = wrap180(Math.atan2(sy, sx) * RAD);
  return out;
}

/**
 * Sub-Earth point (the disc centre seen from the Earth; for the Moon the optical + physical libration): body-fixed
 * latitude/longitude of the direction body → Earth, geometric (Horizons' ObsSub-LON/LAT rotate the body at the
 * retarded time t − τ: pass jdTT − lightTimeDays to reproduce them, test/orientation.test.mjs).
 * @param {string} id body id
 * @param {PosLike|ArrayLike<number>} pos heliocentric position of the body (AU, scene frame)
 * @param {PosLike|ArrayLike<number>} earthPos heliocentric position of the Earth (AU)
 * @param {number} jdTT Julian date (TT) of the body's rotation state
 * @param {number} [jdUT1] Earth only (meaningless here; kept for signature symmetry)
 * @param {{latDeg: number, lonDeg: number}} [out]
 * @returns {{latDeg: number, lonDeg: number}} degrees, longitude east-positive in (−180°, 180°]
 */
export function subEarthPoint(id, pos, earthPos, jdTT, jdUT1, out = { latDeg: 0, lonDeg: 0 }) {
  let x, y, z, ex, ey, ez;
  if (typeof pos.x === 'number') { x = pos.x; y = pos.y; z = pos.z; } else { x = pos[0]; y = pos[1]; z = pos[2]; }
  if (typeof earthPos.x === 'number') { ex = earthPos.x; ey = earthPos.y; ez = earthPos.z; } else { ex = earthPos[0]; ey = earthPos[1]; ez = earthPos[2]; }
  const dx = ex - x, dy = ey - y, dz = ez - z;
  const r = Math.hypot(dx, dy, dz);
  if (!(r > 0)) { out.latDeg = NaN; out.lonDeg = NaN; return out; }
  return subPoint(id, dx / r, dy / r, dz / r, jdTT, jdUT1, out);
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
