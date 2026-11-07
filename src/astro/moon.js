// Geocentric Moon in the scene frame — Jean Meeus, Astronomical Algorithms, 2nd ed. (1998), chapter 47 "Position of
// the Moon": the abridged ELP-2000/82 (Chapront-Touzé & Chapront 1983) with Table 47.A (60 terms in longitude Σl and
// distance Σr), Table 47.B (60 terms in latitude Σb), the Venus/Jupiter/flattening additive arguments A1, A2, A3 and
// the eccentricity factor E; chapter 48 for the illuminated fraction.
//
// Meeus gives λ, β referred to the MEAN ecliptic and equinox of DATE (nutation is NOT added — the scene frame is a
// mean frame) and Δ in km. The scene position (Horizons "Ecliptic of J2000.0", CLAUDE.md) is
//   r = EQ_TO_ECL · P(T)ᵀ · R_x(ε₀(T)) · Δ (cos β cos λ, cos β sin λ, sin β)
// i.e. ecliptic of date → mean equator of date with the IAU 1976 mean obliquity ε₀ (Meeus 22.2; R_x(+ε) maps the
// north ecliptic pole (0,0,1) to (0, −sin ε, cos ε) = RA 270°, Dec 90° − ε), → J2000 equator with the transpose of
// the IAU 1976 precession matrix P (frames.js, which maps J2000 → date), → J2000 ecliptic with EQ_TO_ECL. At T = 0,
// P = I and ε₀ = ε76, so the chain is the identity. Geometric (no light-time, no aberration), like the fixtures of
// scripts/fetch-moon.mjs (VEC_CORR='NONE').
//
// Time: Meeus's T is Julian centuries of Dynamical Time (TT) from J2000.0; TDB − TT (≤ 1.7 ms ≈ 2 m of lunar motion)
// is ignored. Accuracy stated by Meeus (p. 342): about 10″ in longitude, 4″ in latitude; the measured residuals
// against JPL DE441 (1600–2600, 2024–2027 grid, eclipse instants) are in test/moon.test.mjs.
//
// Allocation-free per call (module scratch arrays, not re-entrant — fine for single-threaded callers; workers get
// their own module instance). The one exception is the small {zeta, z, theta} object returned by
// frames.precessionAngles, needed only when the frame matrix is rebuilt, i.e. when jdTT changes (orientation.js makes
// the same trade-off for Earth).
import { J2000, DAYS_PER_CENTURY, DEG, RAD, AU_KM, EPS76_ARCSEC, ARCSEC_PER_RAD } from './constants.js';
import { wrap360, angleBetween } from './vec.js';
import { EQ_TO_ECL, precessionAngles } from './frames.js';

/**
 * Lunar constants.
 *  - radiusKm: mean radius 1737.4 km — IAU WGCCRE 2015 report (Archinal et al. 2018, Table 5) and the NSSDC Moon fact
 *    sheet (https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html, "Volumetric mean radius").
 *  - meanDistanceKm: the constant term of Meeus's distance, Δ = 385000.56 km + Σr (ch. 47, p. 342; the ELP-2000/82
 *    mean distance).
 *  - siderealMonthDays: 360° over the Moon's mean motion relative to the fixed J2000 equinox = 36525 · 360 /
 *    (481267.88123421 − 5029.0966″/3600) days, with dL′/dT from Meeus 47.1 and the IAU 1976 general precession in
 *    longitude p = 5029.0966″ T (Meeus ch. 21, Lieske et al. 1977) = 27.321661 d (NSSDC: 27.3217 d).
 *  - synodicMonthDays: 360° over the mean elongation rate dD/dT = 445267.1114034 °/cy (Meeus 47.2) = 29.530589 d
 *    (Meeus eq. 49.1 uses the mean synodic month 29.530588861 d).
 */
export const MOON = Object.freeze({
  radiusKm: 1737.4,
  meanDistanceKm: 385000.56,
  siderealMonthDays: 27.321661,
  synodicMonthDays: 29.530589,
});

/** Earth's equatorial radius used by Meeus 47 for the horizontal parallax, sin π = 6378.14 km / Δ (p. 337). */
const EARTH_EQUATORIAL_RADIUS_KM = 6378.14;

// ---------------------------------------------------------------------------------------------------------------------
// Meeus Table 47.A — periodic terms for the longitude (Σl, sine, unit 1e-6 degree) and distance (Σr, cosine, unit
// 1e-3 km) of the Moon. Columns: multiples of D, M, M′, F, then Σl and Σr coefficients. Terms whose argument contains
// M or −M are multiplied by E, those with ±2M by E² (p. 338).
// ---------------------------------------------------------------------------------------------------------------------
/** @type {ReadonlyArray<ReadonlyArray<number>>} */
const TABLE_47A = Object.freeze([
  // D   M   M′  F        Σl         Σr
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0],
  [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0],
  [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0],
  [2, 0, 3, 0, 294, 0],
  [2, 0, -1, -2, 0, 8752],
]);

// ---------------------------------------------------------------------------------------------------------------------
// Meeus Table 47.B — periodic terms for the latitude (Σb, sine, unit 1e-6 degree). Columns: D, M, M′, F, Σb. Same E
// rule as Table 47.A.
// ---------------------------------------------------------------------------------------------------------------------
/** @type {ReadonlyArray<ReadonlyArray<number>>} */
const TABLE_47B = Object.freeze([
  // D   M   M′  F        Σb
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777],
  [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596],
  [2, -1, 1, -1, 491],
  [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439],
  [2, 0, 2, 1, 422],
  [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351],
  [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315],
  [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229],
  [1, 1, 0, -1, 223],
  [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220],
  [2, 1, -1, -1, -220],
  [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177],
  [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166],
  [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119],
  [4, -1, 0, -1, 115],
  [2, -2, 0, 1, 107],
]);

/**
 * @typedef {object} MeeusMoon  Meeus ch. 47 intermediates (Example 47.a is the test vector). Angles in degrees reduced
 *   to [0, 360); sums in Meeus's units.
 * @property {number} T   Julian centuries (TT) from J2000.0
 * @property {number} Lp  L′, mean longitude of the Moon (mean equinox of date, incl. the −0.70″ light-time constant)
 * @property {number} D   mean elongation of the Moon
 * @property {number} M   mean anomaly of the Sun
 * @property {number} Mp  M′, mean anomaly of the Moon
 * @property {number} F   argument of latitude (mean distance from the ascending node)
 * @property {number} A1  Venus perturbation argument
 * @property {number} A2  Jupiter perturbation argument
 * @property {number} A3  flattening-of-the-Earth argument
 * @property {number} E   eccentricity factor of the Earth's orbit (47.6)
 * @property {number} sumL  Σl in 1e-6 degrees
 * @property {number} sumB  Σb in 1e-6 degrees
 * @property {number} sumR  Σr in 1e-3 km
 * @property {number} lonDeg  λ = L′ + Σl/1e6, mean ecliptic and equinox of date, [0, 360)
 * @property {number} latDeg  β = Σb/1e6
 * @property {number} distKm  Δ = 385000.56 + Σr/1000
 */

/** @returns {MeeusMoon} */
function newMeeusMoon() {
  return { T: 0, Lp: 0, D: 0, M: 0, Mp: 0, F: 0, A1: 0, A2: 0, A3: 0, E: 0, sumL: 0, sumB: 0, sumR: 0, lonDeg: 0, latDeg: 0, distKm: 0 };
}

/** E-factor for a term with multiple m of M: 1, E or E² (Meeus p. 338). */
function eFactor(m, E, E2) {
  return m === 0 ? 1 : (m === 1 || m === -1) ? E : E2;
}

/**
 * Meeus chapter 47 evaluation at jdTT: fundamental arguments (47.1–47.5, degrees), additive arguments, E (47.6), the
 * three sums over Tables 47.A/B with their additive terms (p. 338), and the of-date λ, β, Δ. The polynomials are
 * reduced to [0, 360) in degrees before the radian conversion (their T coefficients reach 4.8e5 °/cy, cf.
 * orientation.js periodicSum).
 * @param {number} jdTT Julian date, Terrestrial Time
 * @param {MeeusMoon} [out] reused result object
 * @returns {MeeusMoon}
 */
export function moonMeeus(jdTT, out = newMeeusMoon()) {
  const T = (jdTT - J2000) / DAYS_PER_CENTURY;
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  // 47.1 L′, 47.2 D, 47.3 M, 47.4 M′, 47.5 F (degrees)
  const Lp = wrap360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D = wrap360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M = wrap360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = wrap360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F = wrap360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  // Additive arguments (p. 338): A1 Venus, A2 Jupiter, A3 flattening of the Earth
  const A1 = wrap360(119.75 + 131.849 * T);
  const A2 = wrap360(53.09 + 479264.290 * T);
  const A3 = wrap360(313.45 + 481266.484 * T);
  // 47.6 eccentricity of the Earth's orbit around the Sun, decreasing with time
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const E2 = E * E;

  let sumL = 0, sumR = 0, sumB = 0;
  for (let i = 0; i < TABLE_47A.length; i++) {
    const t = TABLE_47A[i];
    const arg = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * DEG;
    const e = eFactor(t[1], E, E2);
    sumL += e * t[4] * Math.sin(arg);
    sumR += e * t[5] * Math.cos(arg);
  }
  for (let i = 0; i < TABLE_47B.length; i++) {
    const t = TABLE_47B[i];
    const arg = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * DEG;
    sumB += eFactor(t[1], E, E2) * t[4] * Math.sin(arg);
  }
  // Additive terms (p. 338): Venus (A1), Jupiter (A2), flattening (A3) and the L′ ± M′ / L′ − F terms
  sumL += 3958 * Math.sin(A1 * DEG) + 1962 * Math.sin((Lp - F) * DEG) + 318 * Math.sin(A2 * DEG);
  sumB += -2235 * Math.sin(Lp * DEG) + 382 * Math.sin(A3 * DEG) + 175 * Math.sin((A1 - F) * DEG)
    + 175 * Math.sin((A1 + F) * DEG) + 127 * Math.sin((Lp - Mp) * DEG) - 115 * Math.sin((Lp + Mp) * DEG);

  out.T = T; out.Lp = Lp; out.D = D; out.M = M; out.Mp = Mp; out.F = F;
  out.A1 = A1; out.A2 = A2; out.A3 = A3; out.E = E;
  out.sumL = sumL; out.sumB = sumB; out.sumR = sumR;
  // p. 342: λ = L′ + Σl/1e6 (degrees, mean equinox of date), β = Σb/1e6, Δ = 385000.56 + Σr/1000 km
  out.lonDeg = wrap360(Lp + sumL / 1e6);
  out.latDeg = sumB / 1e6;
  out.distKm = MOON.meanDistanceKm + sumR / 1e3;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Equatorial horizontal parallax in degrees, sin π = 6378.14 km / Δ (Meeus ch. 47 p. 337; Example 47.a: 0.991990°).
 * @param {number} distKm geocentric distance in km @returns {number}
 */
export function horizontalParallaxDeg(distKm) {
  return Math.asin(EARTH_EQUATORIAL_RADIUS_KM / distKm) * RAD;
}

/**
 * Geocentric apparent angular diameter 2·asin(R/Δ) of the lunar sphere (R = MOON.radiusKm) in degrees: 31.03′ at the
 * mean distance (Meeus ch. 55 with k = 0.272481 gives 2 × 358473400″/Δ = 31.04′ — the 0.03 % difference is the
 * 1737.9 km radius implied by k).
 * @param {number} distKm geocentric distance in km @returns {number} degrees
 */
export function moonAngularDiameterDeg(distKm) {
  return 2 * Math.asin(MOON.radiusKm / distKm) * RAD;
}

// ---------------------------------------------------------------------------------------------------------------------
// Of-date → scene frame
// ---------------------------------------------------------------------------------------------------------------------

/**
 * IAU 1976 mean obliquity of the ecliptic of date (Meeus eq. 22.2): ε₀ = 23°26′21.448″ − 46.8150″T − 0.00059″T² +
 * 0.001813″T³, with 23°26′21.448″ = 84381.448″ = ε76 (constants.js).
 * @param {number} T Julian centuries (TT) from J2000 @returns {number} radians
 */
export function meanObliquityRad(T) {
  return (EPS76_ARCSEC - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) / ARCSEC_PER_RAD;
}

/**
 * out = A · B for 3×3 row-major matrices, via locals so `out` may alias A or B (allocation-free, as orientation.js).
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
 * out = R_z(a) · R_y(b) · R_z(c) (active ZYZ product, expanded from the vec.js matrices):
 *   [ ca·cb·cc − sa·sc,  −ca·cb·sc − sa·cc,  ca·sb ]
 *   [ sa·cb·cc + ca·sc,  −sa·cb·sc + ca·cc,  sa·sb ]
 *   [ −sb·cc,             sb·sc,             cb    ]
 * With (a, b, c) = (z, −θ, ζ) this is frames.precessionMatrix(T) without its allocations (checked to 1e-15 in the test).
 * @param {number} a @param {number} b @param {number} c radians @param {number[]|Float64Array} out
 * @returns {number[]|Float64Array}
 */
function zyz(a, b, c, out) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  out[0] = ca * cb * cc - sa * sc; out[1] = -ca * cb * sc - sa * cc; out[2] = ca * sb;
  out[3] = sa * cb * cc + ca * sc; out[4] = -sa * cb * sc + ca * cc; out[5] = sa * sb;
  out[6] = -sb * cc; out[7] = sb * sc; out[8] = cb;
  return out;
}

// Scratch: P(T), Q = P(T)ᵀ·R_x(ε₀), and the cached chain matrix M = EQ_TO_ECL·Q keyed on jdTT.
const SCR_P = new Float64Array(9);
const SCR_Q = new Float64Array(9);
const CHAIN = new Float64Array(9);
let chainJd = NaN;

/**
 * Rotation mean ecliptic & equinox of date → scene frame (ecliptic J2000): EQ_TO_ECL · P(T)ᵀ · R_x(ε₀(T)), 3×3
 * row-major. Identity at J2000.0.
 * @param {number} jdTT Julian date (TT) @param {number[]|Float64Array} [out] reused length-9 array
 * @returns {number[]|Float64Array}
 */
export function ofDateToSceneMatrix(jdTT, out = new Array(9)) {
  if (jdTT !== chainJd) {
    const T = (jdTT - J2000) / DAYS_PER_CENTURY;
    const { zeta, z, theta } = precessionAngles(T);
    const P = zyz(z, -theta, zeta, SCR_P);
    // Q = Pᵀ · R_x(ε): Q[i][j] = Σ_k P[k][i] R_x[k][j] with R_x(ε) = [[1,0,0],[0,c,−s],[0,s,c]]
    const eps = meanObliquityRad(T);
    const c = Math.cos(eps), s = Math.sin(eps);
    for (let i = 0; i < 3; i++) {
      const p1 = P[3 + i], p2 = P[6 + i];
      SCR_Q[3 * i] = P[i];
      SCR_Q[3 * i + 1] = p1 * c + p2 * s;
      SCR_Q[3 * i + 2] = -p1 * s + p2 * c;
    }
    mul3(EQ_TO_ECL, SCR_Q, CHAIN);
    chainJd = jdTT;
  }
  for (let k = 0; k < 9; k++) out[k] = CHAIN[k];
  return out;
}

/**
 * Spherical coordinates in the mean ecliptic and equinox of date → Cartesian scene-frame vector (same unit as `dist`).
 * @param {number} lonDeg ecliptic longitude of date @param {number} latDeg ecliptic latitude of date
 * @param {number} dist distance (any unit) @param {number} jdTT Julian date (TT) of the frame
 * @param {number[]} [out] reused length-3 array
 * @returns {number[]}
 */
export function eclipticOfDateToScene(lonDeg, latDeg, dist, jdTT, out = [0, 0, 0]) {
  const lam = lonDeg * DEG, bet = latDeg * DEG;
  const cb = Math.cos(bet);
  const x = dist * cb * Math.cos(lam), y = dist * cb * Math.sin(lam), z = dist * Math.sin(bet);
  const Mx = ofDateToSceneMatrix(jdTT, CHAIN);
  out[0] = Mx[0] * x + Mx[1] * y + Mx[2] * z;
  out[1] = Mx[3] * x + Mx[4] * y + Mx[5] * z;
  out[2] = Mx[6] * x + Mx[7] * y + Mx[8] * z;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Public position API
// ---------------------------------------------------------------------------------------------------------------------

const SCR_MEEUS = newMeeusMoon();
const SCR_R0 = [0, 0, 0];
const SCR_R1 = [0, 0, 0];

/**
 * Geocentric Moon in the mean ecliptic and equinox of date (Meeus 47 output) plus the horizontal parallax.
 * @param {number} jdTT Julian date (TT)
 * @param {{lonDeg: number, latDeg: number, distKm: number, parallaxDeg: number}} [out]
 * @returns {{lonDeg: number, latDeg: number, distKm: number, parallaxDeg: number}} degrees, degrees, km, degrees
 */
export function moonGeocentricOfDate(jdTT, out = { lonDeg: 0, latDeg: 0, distKm: 0, parallaxDeg: 0 }) {
  const m = moonMeeus(jdTT, SCR_MEEUS);
  out.lonDeg = m.lonDeg;
  out.latDeg = m.latDeg;
  out.distKm = m.distKm;
  out.parallaxDeg = horizontalParallaxDeg(m.distKm);
  return out;
}

/**
 * Geocentric Moon position in the scene frame, km.
 * @param {number} jdTT Julian date (TT) @param {number[]} [out] reused length-3 array @returns {number[]}
 */
export function moonPositionKm(jdTT, out = [0, 0, 0]) {
  const m = moonMeeus(jdTT, SCR_MEEUS);
  return eclipticOfDateToScene(m.lonDeg, m.latDeg, m.distKm, jdTT, out);
}

/**
 * Geocentric Moon position in the scene frame, AU (add the Earth's heliocentric position for the heliocentric one).
 * @param {number} jdTT Julian date (TT) @param {number[]} [out] reused length-3 array @returns {number[]}
 */
export function moonPosition(jdTT, out = [0, 0, 0]) {
  moonPositionKm(jdTT, out);
  out[0] /= AU_KM; out[1] /= AU_KM; out[2] /= AU_KM;
  return out;
}

/**
 * Central-difference step for the velocity, days. Truncation error (h²/6)·|r⃛| with |r⃛| ≈ n³Δ (n = 2π/27.32 d⁻¹,
 * Δ = 0.00257 AU) ≈ 1.3e-10 AU/d, and the rounding error of the differenced positions (≈ 1e-14 AU / 2h) ≈ 1e-12 AU/d:
 * both far below the series' own velocity error (≈ 1e-8 AU/d, test/moon.test.mjs).
 */
const VELOCITY_STEP_D = 0.005;

/**
 * Geocentric state of the Moon in the scene frame: position in AU, velocity in AU/day by the central difference
 * (r(t+h) − r(t−h)) / 2h, h = VELOCITY_STEP_D, each position rotated with its own epoch's frame matrix.
 * @param {number} jdTT Julian date (TT)
 * @param {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} [out] reused state object
 * @returns {{x:number, y:number, z:number, vx:number, vy:number, vz:number}}
 */
export function moonState(jdTT, out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }) {
  const h = VELOCITY_STEP_D;
  const r0 = moonPosition(jdTT - h, SCR_R0);
  const r1 = moonPosition(jdTT + h, SCR_R1);
  out.vx = (r1[0] - r0[0]) / (2 * h);
  out.vy = (r1[1] - r0[1]) / (2 * h);
  out.vz = (r1[2] - r0[2]) / (2 * h);
  const r = moonPosition(jdTT, SCR_R0);
  out.x = r[0]; out.y = r[1]; out.z = r[2];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Illumination (Meeus chapter 48)
// ---------------------------------------------------------------------------------------------------------------------

const SCR_MS = [0, 0, 0]; // Moon → Sun
const SCR_ME = [0, 0, 0]; // Moon → Earth
const SCR_M = [0, 0, 0];
const SCR_S = [0, 0, 0];

/**
 * Illuminated fraction, phase angle and elongation of the Moon from geocentric vectors (Meeus ch. 48 in vector form):
 * the elongation ψ is the angle Sun–Earth–Moon (eq. 48.2 computes the same angle from α, δ), the phase angle i is the
 * angle Sun–Moon–Earth (eq. 48.3 solves the same triangle: tan i = R sin ψ / (Δ − R cos ψ)), and k = (1 + cos i)/2
 * (eq. 48.1). Both vectors in the same frame and unit (AU); the magnitude of the Sun vector matters for i (a unit
 * vector instead of the ≈ 1 AU geocentric Sun shifts i by < 0.003°), so pass −(Earth's heliocentric position).
 * @param {ArrayLike<number>|{x:number, y:number, z:number}} moonGeoAu geocentric Moon (moonPosition / moonState)
 * @param {ArrayLike<number>|{x:number, y:number, z:number}} sunGeoAu geocentric Sun = −(Earth heliocentric), AU
 * @param {{phaseAngleDeg: number, illuminatedFraction: number, elongationDeg: number}} [out]
 * @returns {{phaseAngleDeg: number, illuminatedFraction: number, elongationDeg: number}}
 */
export function moonIllumination(moonGeoAu, sunGeoAu, out = { phaseAngleDeg: 0, illuminatedFraction: 0, elongationDeg: 0 }) {
  const m = SCR_M, s = SCR_S;
  if (typeof moonGeoAu.x === 'number') { m[0] = moonGeoAu.x; m[1] = moonGeoAu.y; m[2] = moonGeoAu.z; } else { m[0] = moonGeoAu[0]; m[1] = moonGeoAu[1]; m[2] = moonGeoAu[2]; }
  if (typeof sunGeoAu.x === 'number') { s[0] = sunGeoAu.x; s[1] = sunGeoAu.y; s[2] = sunGeoAu.z; } else { s[0] = sunGeoAu[0]; s[1] = sunGeoAu[1]; s[2] = sunGeoAu[2]; }
  const ms = SCR_MS, me = SCR_ME;
  ms[0] = s[0] - m[0]; ms[1] = s[1] - m[1]; ms[2] = s[2] - m[2];
  me[0] = -m[0]; me[1] = -m[1]; me[2] = -m[2];
  const i = angleBetween(ms, me);
  out.phaseAngleDeg = i * RAD;
  out.illuminatedFraction = (1 + Math.cos(i)) / 2;
  out.elongationDeg = angleBetween(m, s) * RAD;
  return out;
}
