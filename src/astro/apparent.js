// Apparent places: from the GEOMETRIC heliocentric scene-frame states (ephemeris.js, moon.js) to what an observer at
// the Earth's centre measures — Meeus, Astronomical Algorithms 2nd ed. ch. 33 "Apparent Place of a Planet" and ch. 23
// "Apparent Place of a Star"; Urban & Seidelmann (eds.), Explanatory Supplement to the Astronomical Almanac, 3rd ed.
// (2013) §7.2 (the reduction steps and the relativistic aberration formula, eq. 7.40).
//
// Reduction chain for a body at TT instant t (all vectors in the scene frame = ecliptic J2000, AU):
//   1. Light-time (Meeus 33.3): τ = 0.0057755183 Δ days per AU (= 1/c with c = 173.1446 AU/day, constants.js). The
//      ASTROMETRIC geocentric position is g = P(t − τ) − E(t), iterated τ ← |g|/c (2–3 passes converge to < 1e-10 d).
//      With an ephemeris instance the planet is re-evaluated at t − τ; with a plain states snapshot the retarded
//      position is the Taylor form P − τV + ½τ²A with the two-body acceleration A = −μP/r³ (error (1/6)τ³|jerk|
//      < 1e-13 AU even for Neptune, τ = 0.17 d). The Sun is the origin, so its astrometric vector is −E(t); the Moon's
//      geocentric vector is retarded by its own 1.3 s AND shifted by −τ V_E (the Earth moves 39 km ≈ 21″ in 1.3 s).
//   2. Annual aberration: the Earth's heliocentric velocity V (barycentric would be more exact: the Sun's ≤ 16 m/s
//      about the barycentre is ≤ 0.01″) in the relativistic formula of the Explanatory Supplement eq. 7.40
//      (Kaplan et al. 1989 eq. 16): p′ = [β⁻¹ p + (1 + p·V/c/(1 + β⁻¹)) V/c] / (1 + p·V/c), β⁻¹ = √(1 − V²/c²).
//      First order this is Meeus 23.2/23.3 with the aberration constant κ = 20.49552″ (v/c at 1 AU).
//      Gravitational light deflection by the Sun (Meeus p. 150: 0.004″ cot(ψ/2) ≈ 0.05″ at ψ = 10°, 0.23″ at 2°)
//      is NOT applied; Horizons' apparent coordinates include it, which is why the apparent tolerance in
//      test/apparent.test.mjs is 1.5″ rather than 1″.
//   3. Frame: ECL_TO_EQ (scene → ICRF/J2000 equator), then the IAU 1976 precession P(T) (frames.js) to the mean
//      equator and equinox of date, then the IAU 1980 nutation N(T) (nutation.js) to the TRUE equator and equinox of
//      date. The ICRF–J2000 frame bias (≈ 23 mas) is ignored; Horizons' "EOP-corrected IAU76/80" of-date frame is the
//      same model family, offset −53 mas from IAU 2006/2000A (its own footnote).
// Astrometric RA/Dec (ICRF) = step 1 only — Horizons OBSERVER quantity 1; apparent RA/Dec of date = steps 1–3 —
// quantity 2 ("airless"); apparent ecliptic λ/β of date are the same vector seen from the ecliptic of date with the
// TRUE obliquity (longitude from the true equinox — the λ☉ whose crossings of 0°/90°/180°/270° define the seasons).
//
// Allocation-free after warm-up: module-level scratch (not re-entrant; workers get their own instance) and the
// of-date matrix cached on jdTT.
import { C_AU_DAY, AU_KM, DAY_S, LIGHT_TIME_AU_S, J2000, DAYS_PER_CENTURY, RAD } from './constants.js';
import { ECL_TO_EQ, precessionAngles } from './frames.js';
import { nutation, nutationMatrix } from './nutation.js';
import { moonState } from './moon.js';
import { GM_SUN_AU3_D2 } from './elements.js';

/** Light-time per AU in days = 1/c = 0.0057755183 (Meeus eq. 33.3; c = 173.1446326742403 AU/day). */
export const LIGHT_TIME_DAYS_PER_AU = 1 / C_AU_DAY;
/** Convergence threshold of the light-time iteration, days (1e-10 d ≈ 9 µs ≈ 3 m of planetary motion). */
export const LIGHT_TIME_TOL_D = 1e-10;
/** Maximum light-time passes (geometric convergence with ratio v/c ≈ 1e-4: three passes reach the threshold). */
const LIGHT_TIME_MAX_ITER = 8;

/** @typedef {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} State */
/** @typedef {Record<string, State>} States */
/** @typedef {{state: (body: string, jdTT: number, out?: State) => State}} EphemerisLike */

/**
 * @typedef {object} Astrometric  light-time-corrected geocentric vector, scene frame (ecliptic J2000)
 * @property {number} x @property {number} y @property {number} z AU: P(t − τ) − E(t)
 * @property {number} vx @property {number} vy @property {number} vz AU/day: V_P(t − τ) − V_E(t)
 * @property {number} distAu |g| (Horizons "delta")
 * @property {number} lightTimeDays τ
 * @property {number} iterations light-time passes used
 */

/** @returns {Astrometric} */
export function newAstrometric() {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, distAu: 0, lightTimeDays: 0, iterations: 0 };
}

const S_EARTH = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const S_BODY = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

/** @param {EphemerisLike|States} src @returns {boolean} true for an ephemeris instance */
function isEphemeris(src) {
  return typeof (/** @type {EphemerisLike} */ (src)).state === 'function';
}

/**
 * Heliocentric state of a body at t − τ for the light-time iteration.
 *  - ephemeris source: re-evaluates the series at t − τ ('moon' → Earth(t − τ) + geocentric Moon(t − τ));
 *  - states source: Taylor form P − τV + ½τ²A around the snapshot (A = −μP/r³).
 * @param {EphemerisLike|States} src @param {string} id @param {number} jdTT @param {number} tau @param {State} out
 * @returns {State}
 */
function retardedState(src, id, jdTT, tau, out) {
  if (isEphemeris(src)) {
    const eph = /** @type {EphemerisLike} */ (src);
    if (id === 'moon') {
      eph.state('earth', jdTT - tau, out);
      const m = moonState(jdTT - tau, S_MOON);
      out.x += m.x; out.y += m.y; out.z += m.z;
      out.vx += m.vx; out.vy += m.vy; out.vz += m.vz;
      return out;
    }
    return eph.state(id, jdTT - tau, out);
  }
  const s = /** @type {States} */ (src)[id];
  if (s === undefined) throw new RangeError(`apparent: states have no body '${id}' (createEphemeris(SERIES, {moon: true}) adds the Moon)`);
  const r = Math.hypot(s.x, s.y, s.z);
  const k = r > 0 ? -GM_SUN_AU3_D2 / (r * r * r) : 0; // two-body acceleration factor: A = k·P
  const h = 0.5 * tau * tau;
  // P(t − τ) = P − τV + ½τ²A,  V(t − τ) = V − τA
  out.x = s.x - tau * s.vx + h * k * s.x;
  out.y = s.y - tau * s.vy + h * k * s.y;
  out.z = s.z - tau * s.vz + h * k * s.z;
  out.vx = s.vx - tau * k * s.x;
  out.vy = s.vy - tau * k * s.y;
  out.vz = s.vz - tau * k * s.z;
  return out;
}
const S_MOON = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

/**
 * Astrometric geocentric vector (light-time only, J2000 ecliptic / scene frame) of 'sun', a planet or 'moon'.
 * @param {EphemerisLike|States} src ephemeris instance (exact re-evaluation at t − τ) or a states snapshot at jdTT
 * @param {string} id 'sun', planet id or 'moon' ('earth' has no geocentric place → RangeError)
 * @param {number} jdTT Julian date (TT) of observation
 * @param {Astrometric} [out] reused result object
 * @returns {Astrometric}
 */
export function astrometricGeocentric(src, id, jdTT, out = newAstrometric()) {
  if (id === 'earth') throw new RangeError('apparent: the Earth has no geocentric place');
  const E = isEphemeris(src) ? /** @type {EphemerisLike} */ (src).state('earth', jdTT, S_EARTH) : /** @type {States} */ (src).earth;
  if (E === undefined) throw new RangeError("apparent: states have no 'earth'");
  if (id === 'sun') {
    // The Sun is the origin of the heliocentric frame: its retarded position is the origin too.
    out.x = -E.x; out.y = -E.y; out.z = -E.z;
    out.vx = -E.vx; out.vy = -E.vy; out.vz = -E.vz;
    out.distAu = Math.hypot(E.x, E.y, E.z);
    out.lightTimeDays = out.distAu * LIGHT_TIME_DAYS_PER_AU;
    out.iterations = 1;
    return out;
  }
  let tau = 0, dist = 0, n = 0;
  for (; n < LIGHT_TIME_MAX_ITER; n++) {
    const P = retardedState(src, id, jdTT, tau, S_BODY);
    out.x = P.x - E.x; out.y = P.y - E.y; out.z = P.z - E.z;
    dist = Math.hypot(out.x, out.y, out.z);
    const next = dist * LIGHT_TIME_DAYS_PER_AU;
    const done = Math.abs(next - tau) < LIGHT_TIME_TOL_D;
    tau = next;
    if (done) { n++; break; }
  }
  // Velocity of the retarded body relative to the Earth now (used for the range rate and the stationary detector).
  out.vx = S_BODY.vx - E.vx; out.vy = S_BODY.vy - E.vy; out.vz = S_BODY.vz - E.vz;
  out.distAu = dist;
  out.lightTimeDays = tau;
  out.iterations = n;
  return out;
}

/**
 * Relativistic annual aberration (Explanatory Supplement 3rd ed. eq. 7.40; Kaplan et al. 1989, AJ 97, 1197, eq. 16):
 *   p′ = [β⁻¹ p + (1 + (p·V)/(1 + β⁻¹)) V] / (1 + p·V),   V = v/c,   β⁻¹ = √(1 − |V|²)
 * for a unit direction p. To first order p′ ≈ p + V − (p·V) p, i.e. a shift of (v/c) sin θ ≈ 20.5″ sin θ toward the
 * apex of the Earth's motion (Meeus 23.2 in vector form).
 * @param {ArrayLike<number>|State} dir direction (any length > 0; normalised internally) — [x, y, z] or {x, y, z}
 * @param {State|ArrayLike<number>} vel observer velocity, AU/day — {vx, vy, vz} state or [vx, vy, vz]
 * @param {number[]} [out] reused length-3 array
 * @returns {number[]} unit vector of the aberrated direction (same frame as the inputs)
 */
export function aberrate(dir, vel, out = [0, 0, 0]) {
  let px, py, pz, vx, vy, vz;
  if (typeof (/** @type {State} */ (dir)).x === 'number') { px = dir.x; py = dir.y; pz = dir.z; } else { px = dir[0]; py = dir[1]; pz = dir[2]; }
  if (typeof (/** @type {State} */ (vel)).vx === 'number') { vx = vel.vx; vy = vel.vy; vz = vel.vz; } else { vx = vel[0]; vy = vel[1]; vz = vel[2]; }
  const n = Math.hypot(px, py, pz);
  px /= n; py /= n; pz /= n;
  const Vx = vx / C_AU_DAY, Vy = vy / C_AU_DAY, Vz = vz / C_AU_DAY;
  const pV = px * Vx + py * Vy + pz * Vz;
  const betaInv = Math.sqrt(1 - (Vx * Vx + Vy * Vy + Vz * Vz));
  const f = 1 + pV / (1 + betaInv);
  const d = 1 + pV;
  out[0] = (betaInv * px + f * Vx) / d;
  out[1] = (betaInv * py + f * Vy) / d;
  out[2] = (betaInv * pz + f * Vz) / d;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scene (ecliptic J2000) → true equator and equinox of date: M = N(T) · P(T) · ECL_TO_EQ, cached on jdTT
// ---------------------------------------------------------------------------------------------------------------------

const M_P = new Float64Array(9);
const M_N = new Float64Array(9);
const M_TMP = new Float64Array(9);
const M_DATE = new Float64Array(9);
let dateJd = NaN;

/** out = A·B (3×3 row-major) via locals so `out` may alias A or B (orientation.js / moon.js style). */
function mul3(A, B, out) {
  const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4], a5 = A[5], a6 = A[6], a7 = A[7], a8 = A[8];
  const b0 = B[0], b1 = B[1], b2 = B[2], b3 = B[3], b4 = B[4], b5 = B[5], b6 = B[6], b7 = B[7], b8 = B[8];
  out[0] = a0 * b0 + a1 * b3 + a2 * b6; out[1] = a0 * b1 + a1 * b4 + a2 * b7; out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6; out[4] = a3 * b1 + a4 * b4 + a5 * b7; out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6; out[7] = a6 * b1 + a7 * b4 + a8 * b7; out[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return out;
}

/**
 * P(T) = R_z(z)·R_y(−θ)·R_z(ζ) expanded (ZYZ product, as moon.js zyz with (a, b, c) = (z, −θ, ζ); equals
 * frames.precessionMatrix to 1e-15 — asserted in test/apparent.test.mjs).
 */
function precessionInto(T, out) {
  const { zeta, z, theta } = precessionAngles(T);
  const ca = Math.cos(z), sa = Math.sin(z);
  const cb = Math.cos(-theta), sb = Math.sin(-theta);
  const cc = Math.cos(zeta), sc = Math.sin(zeta);
  out[0] = ca * cb * cc - sa * sc; out[1] = -ca * cb * sc - sa * cc; out[2] = ca * sb;
  out[3] = sa * cb * cc + ca * sc; out[4] = -sa * cb * sc + ca * cc; out[5] = sa * sb;
  out[6] = -sb * cc; out[7] = sb * sc; out[8] = cb;
  return out;
}

/**
 * Rotation scene frame (ecliptic J2000) → TRUE equator and equinox of date: N(T)·P(T)·ECL_TO_EQ, 3×3 row-major,
 * cached on jdTT. At J2000.0 it reduces to N(0)·ECL_TO_EQ (nutation never vanishes).
 * @param {number} jdTT Julian date (TT)
 * @param {number[]|Float64Array} [out] reused length-9 array
 * @returns {number[]|Float64Array}
 */
export function trueOfDateMatrix(jdTT, out = new Array(9)) {
  if (jdTT !== dateJd) {
    const T = (jdTT - J2000) / DAYS_PER_CENTURY;
    precessionInto(T, M_P);
    nutationMatrix(jdTT, M_N);
    mul3(M_P, ECL_TO_EQ, M_TMP);
    mul3(M_N, M_TMP, M_DATE);
    dateJd = jdTT;
  }
  for (let k = 0; k < 9; k++) out[k] = M_DATE[k];
  return out;
}

/**
 * Right ascension and declination of a vector in an equatorial frame.
 * @param {ArrayLike<number>} v equatorial [x, y, z]
 * @param {{raDeg:number, decDeg:number}} [out]
 * @returns {{raDeg:number, decDeg:number}} RA in [0, 360), Dec in [−90, 90]
 */
export function raDecDeg(v, out = { raDeg: 0, decDeg: 0 }) {
  let ra = Math.atan2(v[1], v[0]) * RAD;
  if (ra < 0) ra += 360;
  out.raDeg = ra;
  out.decDeg = Math.atan2(v[2], Math.hypot(v[0], v[1])) * RAD;
  return out;
}

/**
 * Ecliptic longitude and latitude of a vector in an ecliptic frame.
 * @param {ArrayLike<number>} v ecliptic [x, y, z]
 * @param {{lonDeg:number, latDeg:number}} [out]
 * @returns {{lonDeg:number, latDeg:number}} longitude in [0, 360)
 */
export function lonLatDeg(v, out = { lonDeg: 0, latDeg: 0 }) {
  let lon = Math.atan2(v[1], v[0]) * RAD;
  if (lon < 0) lon += 360;
  out.lonDeg = lon;
  out.latDeg = Math.atan2(v[2], Math.hypot(v[0], v[1])) * RAD;
  return out;
}

/**
 * @typedef {object} ApparentPlace  degrees, AU, seconds, km/s
 * @property {number} jdTT epoch of observation
 * @property {number} distAu light-time-corrected geocentric distance |P(t − τ) − E(t)| (Horizons "delta")
 * @property {number} lightTimeS τ in seconds
 * @property {number} rangeRateKmS d(distance)/dt (Horizons "deldot"; positive = receding)
 * @property {number} raDeg astrometric right ascension, ICRF/J2000 (light-time only)
 * @property {number} decDeg astrometric declination, ICRF/J2000
 * @property {number} lonDeg astrometric ecliptic longitude, J2000 ecliptic (scene frame)
 * @property {number} latDeg astrometric ecliptic latitude, J2000
 * @property {number} raAppDeg apparent right ascension, true equator and equinox of date
 * @property {number} decAppDeg apparent declination of date
 * @property {number} lonAppDeg apparent ecliptic longitude of date (true equinox, true obliquity)
 * @property {number} latAppDeg apparent ecliptic latitude of date
 */

/** @returns {ApparentPlace} */
export function newApparentPlace() {
  return { jdTT: 0, distAu: 0, lightTimeS: 0, rangeRateKmS: 0, raDeg: 0, decDeg: 0, lonDeg: 0, latDeg: 0, raAppDeg: 0, decAppDeg: 0, lonAppDeg: 0, latAppDeg: 0 };
}

const A_SCR = newAstrometric();
const V_UNIT = [0, 0, 0];
const V_AB = [0, 0, 0];
const V_EQ = [0, 0, 0];
const V_DATE = [0, 0, 0];
const V_ECL = [0, 0, 0];
const RD = { raDeg: 0, decDeg: 0 };
const LL = { lonDeg: 0, latDeg: 0 };
const NUT = nutation(J2000, undefined);

/**
 * Full apparent-place record of 'sun', a planet or 'moon' as seen from the Earth's centre (module header steps 1–3).
 * @param {EphemerisLike|States} src ephemeris instance or states snapshot at jdTT
 * @param {string} id body id ('earth' → RangeError)
 * @param {number} jdTT Julian date (TT)
 * @param {ApparentPlace} [out] reused result object
 * @returns {ApparentPlace}
 */
export function apparentPlace(src, id, jdTT, out = newApparentPlace()) {
  const g = astrometricGeocentric(src, id, jdTT, A_SCR);
  const E = isEphemeris(src) ? S_EARTH : /** @type {States} */ (src).earth; // astrometricGeocentric filled S_EARTH
  out.jdTT = jdTT;
  out.distAu = g.distAu;
  out.lightTimeS = g.distAu * LIGHT_TIME_AU_S;
  // Range rate: δ̇ = ĝ·(V_P − V_E) / (1 + ĝ·V_P/c) (the retarded time advances at 1 − δ̇/c), AU/day → km/s.
  const ux = g.x / g.distAu, uy = g.y / g.distAu, uz = g.z / g.distAu;
  const vPx = g.vx + E.vx, vPy = g.vy + E.vy, vPz = g.vz + E.vz; // retarded body velocity
  const dRel = ux * g.vx + uy * g.vy + uz * g.vz;
  out.rangeRateKmS = dRel / (1 + (ux * vPx + uy * vPy + uz * vPz) / C_AU_DAY) * AU_KM / DAY_S;
  // Astrometric (J2000) angles
  V_UNIT[0] = ux; V_UNIT[1] = uy; V_UNIT[2] = uz;
  lonLatDeg(V_UNIT, LL);
  out.lonDeg = LL.lonDeg; out.latDeg = LL.latDeg;
  V_EQ[0] = ECL_TO_EQ[0] * ux + ECL_TO_EQ[1] * uy + ECL_TO_EQ[2] * uz;
  V_EQ[1] = ECL_TO_EQ[3] * ux + ECL_TO_EQ[4] * uy + ECL_TO_EQ[5] * uz;
  V_EQ[2] = ECL_TO_EQ[6] * ux + ECL_TO_EQ[7] * uy + ECL_TO_EQ[8] * uz;
  raDecDeg(V_EQ, RD);
  out.raDeg = RD.raDeg; out.decDeg = RD.decDeg;
  // Apparent: aberration, then precession + nutation to the true equator/equinox of date
  aberrate(V_UNIT, E, V_AB);
  const M = trueOfDateMatrix(jdTT, M_TMP);
  V_DATE[0] = M[0] * V_AB[0] + M[1] * V_AB[1] + M[2] * V_AB[2];
  V_DATE[1] = M[3] * V_AB[0] + M[4] * V_AB[1] + M[5] * V_AB[2];
  V_DATE[2] = M[6] * V_AB[0] + M[7] * V_AB[1] + M[8] * V_AB[2];
  raDecDeg(V_DATE, RD);
  out.raAppDeg = RD.raDeg; out.decAppDeg = RD.decDeg;
  // Ecliptic of date with the TRUE obliquity: R_x(−ε) = [[1,0,0],[0,c,s],[0,−s,c]]
  const eps = nutation(jdTT, NUT).trueObliquityRad;
  const c = Math.cos(eps), s = Math.sin(eps);
  V_ECL[0] = V_DATE[0];
  V_ECL[1] = c * V_DATE[1] + s * V_DATE[2];
  V_ECL[2] = -s * V_DATE[1] + c * V_DATE[2];
  lonLatDeg(V_ECL, LL);
  out.lonAppDeg = LL.lonDeg; out.latAppDeg = LL.latDeg;
  return out;
}

const PLACE = newApparentPlace();

/**
 * Astrometric RA/Dec (ICRF/J2000, light-time only) and distance.
 * @param {EphemerisLike|States} src @param {string} id @param {number} jdTT
 * @param {{raDeg:number, decDeg:number, distAu:number}} [out]
 * @returns {{raDeg:number, decDeg:number, distAu:number}}
 */
export function astrometricRaDec(src, id, jdTT, out = { raDeg: 0, decDeg: 0, distAu: 0 }) {
  const p = apparentPlace(src, id, jdTT, PLACE);
  out.raDeg = p.raDeg; out.decDeg = p.decDeg; out.distAu = p.distAu;
  return out;
}

/**
 * Apparent RA/Dec (true equator and equinox of date; light-time, aberration, precession, nutation) and distance.
 * @param {EphemerisLike|States} src @param {string} id @param {number} jdTT
 * @param {{raDeg:number, decDeg:number, distAu:number}} [out]
 * @returns {{raDeg:number, decDeg:number, distAu:number}}
 */
export function apparentRaDec(src, id, jdTT, out = { raDeg: 0, decDeg: 0, distAu: 0 }) {
  const p = apparentPlace(src, id, jdTT, PLACE);
  out.raDeg = p.raAppDeg; out.decDeg = p.decAppDeg; out.distAu = p.distAu;
  return out;
}

/**
 * Apparent geocentric ecliptic longitude and latitude of date (true equinox).
 * @param {EphemerisLike|States} src @param {string} id @param {number} jdTT
 * @param {{lonDeg:number, latDeg:number}} [out]
 * @returns {{lonDeg:number, latDeg:number}}
 */
export function apparentEcliptic(src, id, jdTT, out = { lonDeg: 0, latDeg: 0 }) {
  const p = apparentPlace(src, id, jdTT, PLACE);
  out.lonDeg = p.lonAppDeg; out.latDeg = p.latAppDeg;
  return out;
}

/**
 * Apparent geocentric longitude of the Sun λ☉ (Meeus ch. 25 "apparent longitude": geometric + nutation + aberration,
 * ecliptic and true equinox of date) — the quantity whose passages through 0°, 90°, 180°, 270° are the equinoxes and
 * solstices (seasons.js).
 * @param {EphemerisLike|States} src @param {number} jdTT @returns {number} degrees in [0, 360)
 */
export function apparentSunLongitudeDeg(src, jdTT) {
  return apparentPlace(src, 'sun', jdTT, PLACE).lonAppDeg;
}
