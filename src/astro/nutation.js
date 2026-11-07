// Nutation (IAU 1980 theory, Seidelmann 1982) and the obliquity of the ecliptic — Jean Meeus, Astronomical Algorithms,
// 2nd ed. (1998), chapter 22 "Nutation and the Obliquity of the Ecliptic": the five fundamental arguments (p. 144),
// Table 22.A (the 63 largest periodic terms of the IAU 1980 series; coefficients in units of 0.0001″, linear in T),
// the IAU 1976 mean obliquity (eq. 22.2) and the true obliquity ε = ε₀ + Δε. Test vector: Example 22.a (1987 April 10,
// 0h TD): Δψ = −3.788″, Δε = +9.443″, ε₀ = 23°26′27.407″, ε = 23°26′36.850″.
//
// Meeus states the accuracy of the truncated series as 0.5″ in Δψ and 0.1″ in Δε (p. 144); the full 106-term IAU 1980
// series is itself good to ≈ 1 mas against modern (IAU 2000A) nutation, which is irrelevant at the arcsecond level this
// app reports. The same IAU 1976/1980 models are what JPL Horizons uses for its "of-date" apparent coordinates
// (Horizons output footnote: "equinox of-date … EOP-corrected IAU76/80"), so apparent places computed here are directly
// comparable with the OBSERVER fixtures of scripts/fetch-observer.mjs.
//
// Also here: the equation of the equinoxes Δψ cos ε and Greenwich APPARENT sidereal time GAST = GMST + Δψ cos ε
// (Meeus ch. 12 p. 88: "the correction to be added to the mean sidereal time is Δψ cos ε"), and the nutation matrix
// N = R_x(ε₀ + Δε) · R_z(Δψ) · R_x(−ε₀) carrying a vector from the MEAN equator and equinox of date to the TRUE equator
// and equinox of date (Meeus 23.1 in matrix form: the longitude measured in the mean ecliptic of date increases by Δψ,
// then the frame is tilted back with the true obliquity; vec.js active-rotation conventions, CLAUDE.md).
//
// Allocation-free after module load: results are written into caller-supplied objects, and the last evaluation is
// memoised on jdTT because orientation.js (Earth's spin), apparent.js (every body, same instant) and the events scan
// all ask for the same instant repeatedly.
import { J2000, DAYS_PER_CENTURY, DEG, RAD, EPS76_ARCSEC, ARCSEC_PER_RAD } from './constants.js';
import { gmstDeg } from './time.js';

/**
 * Meeus Table 22.A — periodic terms of the IAU 1980 nutation. Columns: multiples of D, M, M′, F, Ω; then the sine
 * coefficient of Δψ as [A, B] (A + B·T, unit 0.0001″) and the cosine coefficient of Δε as [C, D] (C + D·T, same unit).
 * Transcribed verbatim (63 rows); terms with no T-dependence carry 0.
 * @type {ReadonlyArray<ReadonlyArray<number>>}  [D, M, M′, F, Ω, A, B, C, D]
 */
export const TABLE_22A = Object.freeze([
  [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
  [-2, 0, 0, 2, 2, -13187, -1.6, 5736, -3.1],
  [0, 0, 0, 2, 2, -2274, -0.2, 977, -0.5],
  [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
  [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
  [0, 0, 1, 0, 0, 712, 0.1, -7, 0],
  [-2, 1, 0, 2, 2, -517, 1.2, 224, -0.6],
  [0, 0, 0, 2, 1, -386, -0.4, 200, 0],
  [0, 0, 1, 2, 2, -301, 0, 129, -0.1],
  [-2, -1, 0, 2, 2, 217, -0.5, -95, 0.3],
  [-2, 0, 1, 0, 0, -158, 0, 0, 0],
  [-2, 0, 0, 2, 1, 129, 0.1, -70, 0],
  [0, 0, -1, 2, 2, 123, 0, -53, 0],
  [2, 0, 0, 0, 0, 63, 0, 0, 0],
  [0, 0, 1, 0, 1, 63, 0.1, -33, 0],
  [2, 0, -1, 2, 2, -59, 0, 26, 0],
  [0, 0, -1, 0, 1, -58, -0.1, 32, 0],
  [0, 0, 1, 2, 1, -51, 0, 27, 0],
  [-2, 0, 2, 0, 0, 48, 0, 0, 0],
  [0, 0, -2, 2, 1, 46, 0, -24, 0],
  [2, 0, 0, 2, 2, -38, 0, 16, 0],
  [0, 0, 2, 2, 2, -31, 0, 13, 0],
  [0, 0, 2, 0, 0, 29, 0, 0, 0],
  [-2, 0, 1, 2, 2, 29, 0, -12, 0],
  [0, 0, 0, 2, 0, 26, 0, 0, 0],
  [-2, 0, 0, 2, 0, -22, 0, 0, 0],
  [0, 0, -1, 2, 1, 21, 0, -10, 0],
  [0, 2, 0, 0, 0, 17, -0.1, 0, 0],
  [2, 0, -1, 0, 1, 16, 0, -8, 0],
  [-2, 2, 0, 2, 2, -16, 0.1, 7, 0],
  [0, 1, 0, 0, 1, -15, 0, 9, 0],
  [-2, 0, 1, 0, 1, -13, 0, 7, 0],
  [0, -1, 0, 0, 1, -12, 0, 6, 0],
  [0, 0, 2, -2, 0, 11, 0, 0, 0],
  [2, 0, -1, 2, 1, -10, 0, 5, 0],
  [2, 0, 1, 2, 2, -8, 0, 3, 0],
  [0, 1, 0, 2, 2, 7, 0, -3, 0],
  [-2, 1, 1, 0, 0, -7, 0, 0, 0],
  [0, -1, 0, 2, 2, -7, 0, 3, 0],
  [2, 0, 0, 2, 1, -7, 0, 3, 0],
  [2, 0, 1, 0, 0, 6, 0, 0, 0],
  [-2, 0, 2, 2, 2, 6, 0, -3, 0],
  [-2, 0, 1, 2, 1, 6, 0, -3, 0],
  [2, 0, -2, 0, 1, -6, 0, 3, 0],
  [2, 0, 0, 0, 1, -6, 0, 3, 0],
  [0, -1, 1, 0, 0, 5, 0, 0, 0],
  [-2, -1, 0, 2, 1, -5, 0, 3, 0],
  [-2, 0, 0, 0, 1, -5, 0, 3, 0],
  [0, 0, 2, 2, 1, -5, 0, 3, 0],
  [-2, 0, 2, 0, 1, 4, 0, 0, 0],
  [-2, 1, 0, 2, 1, 4, 0, 0, 0],
  [0, 0, 1, -2, 0, 4, 0, 0, 0],
  [-1, 0, 1, 0, 0, -4, 0, 0, 0],
  [-2, 1, 0, 0, 0, -4, 0, 0, 0],
  [1, 0, 0, 0, 0, -4, 0, 0, 0],
  [0, 0, 1, 2, 0, 3, 0, 0, 0],
  [0, 0, -2, 2, 2, -3, 0, 0, 0],
  [-1, -1, 1, 0, 0, -3, 0, 0, 0],
  [0, 1, 1, 0, 0, -3, 0, 0, 0],
  [0, -1, 1, 2, 2, -3, 0, 0, 0],
  [2, -1, -1, 2, 2, -3, 0, 0, 0],
  [0, 0, 3, 2, 2, -3, 0, 0, 0],
  [2, -1, 0, 2, 2, -3, 0, 0, 0],
]);

/** Unit of the Table 22.A coefficients: 0.0001″. */
const UNIT_ARCSEC = 1e-4;

/**
 * @typedef {object} NutationArguments  Meeus p. 144, degrees in [0, 360)
 * @property {number} D mean elongation of the Moon from the Sun
 * @property {number} M mean anomaly of the Sun (Earth)
 * @property {number} Mp mean anomaly of the Moon
 * @property {number} F Moon's argument of latitude
 * @property {number} Omega longitude of the ascending node of the Moon's mean orbit on the ecliptic, measured from the
 *   mean equinox of date
 */

/** @param {number} d degrees @returns {number} degrees in [0, 360) */
function wrap360(d) {
  const t = d % 360;
  return t < 0 ? t + 360 : t;
}

/**
 * The five fundamental arguments of the IAU 1980 nutation (Meeus p. 144; T in Julian centuries TT from J2000):
 *   D  = 297.85036 + 445267.111480 T − 0.0019142 T² + T³/189474
 *   M  = 357.52772 + 35999.050340 T − 0.0001603 T² − T³/300000
 *   M′ = 134.96298 + 477198.867398 T + 0.0086972 T² + T³/56250
 *   F  = 93.27191 + 483202.017538 T − 0.0036825 T² + T³/327270
 *   Ω  = 125.04452 − 1934.136261 T + 0.0020708 T² + T³/450000
 * Example 22.a (T = −0.127296372348): D 136.9623°, M 94.9792°, M′ 229.2784°, F 143.4079°, Ω 11.2531°.
 * @param {number} T Julian centuries (TT) from J2000.0
 * @param {NutationArguments} [out]
 * @returns {NutationArguments} degrees
 */
export function nutationArguments(T, out = { D: 0, M: 0, Mp: 0, F: 0, Omega: 0 }) {
  const T2 = T * T, T3 = T2 * T;
  out.D = wrap360(297.85036 + 445267.111480 * T - 0.0019142 * T2 + T3 / 189474);
  out.M = wrap360(357.52772 + 35999.050340 * T - 0.0001603 * T2 - T3 / 300000);
  out.Mp = wrap360(134.96298 + 477198.867398 * T + 0.0086972 * T2 + T3 / 56250);
  out.F = wrap360(93.27191 + 483202.017538 * T - 0.0036825 * T2 + T3 / 327270);
  out.Omega = wrap360(125.04452 - 1934.136261 * T + 0.0020708 * T2 + T3 / 450000);
  return out;
}

/**
 * IAU 1976 mean obliquity of the ecliptic of date (Meeus eq. 22.2; Lieske et al. 1977):
 *   ε₀ = 23°26′21.448″ − 46.8150″ T − 0.00059″ T² + 0.001813″ T³, with 23°26′21.448″ = 84381.448″ = ε76 (constants.js).
 * Valid to ≈ 1″ over ±2000 years (Meeus p. 147; eq. 22.3 is the long-range form). moon.js carries the same expression
 * for its of-date frame chain; the two are asserted equal in test/nutation.test.mjs.
 * @param {number} T Julian centuries (TT) from J2000.0
 * @returns {number} radians
 */
export function meanObliquityRad(T) {
  return (EPS76_ARCSEC - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) / ARCSEC_PER_RAD;
}

/**
 * @typedef {object} Nutation
 * @property {number} jdTT epoch of the evaluation
 * @property {number} T Julian centuries (TT) from J2000.0
 * @property {number} dpsiArcsec Δψ, nutation in longitude, arcseconds
 * @property {number} depsArcsec Δε, nutation in obliquity, arcseconds
 * @property {number} dpsiRad Δψ in radians
 * @property {number} depsRad Δε in radians
 * @property {number} meanObliquityRad ε₀ (Meeus 22.2)
 * @property {number} trueObliquityRad ε = ε₀ + Δε
 * @property {number} eqEquinoxRad equation of the equinoxes Δψ cos ε (Meeus p. 88), radians
 */

/** @returns {Nutation} */
function newNutation() {
  return { jdTT: NaN, T: 0, dpsiArcsec: 0, depsArcsec: 0, dpsiRad: 0, depsRad: 0, meanObliquityRad: 0, trueObliquityRad: 0, eqEquinoxRad: 0 };
}

/** Last evaluation (memo keyed on jdTT) and a scratch for the arguments. */
const MEMO = newNutation();
const ARGS = { D: 0, M: 0, Mp: 0, F: 0, Omega: 0 };

/** @param {Nutation} src @param {Nutation} dst @returns {Nutation} */
function copyNutation(src, dst) {
  dst.jdTT = src.jdTT; dst.T = src.T;
  dst.dpsiArcsec = src.dpsiArcsec; dst.depsArcsec = src.depsArcsec;
  dst.dpsiRad = src.dpsiRad; dst.depsRad = src.depsRad;
  dst.meanObliquityRad = src.meanObliquityRad; dst.trueObliquityRad = src.trueObliquityRad;
  dst.eqEquinoxRad = src.eqEquinoxRad;
  return dst;
}

/**
 * Nutation in longitude and obliquity at jdTT (Meeus ch. 22, Table 22.A: Δψ = Σ (A + B T) sin(arg), Δε = Σ (C + D T)
 * cos(arg), arg = d·D + m·M + m′·M′ + f·F + ω·Ω), plus the mean and true obliquity and the equation of the equinoxes.
 * Memoised on jdTT; allocation-free when `out` is supplied.
 * @param {number} jdTT Julian date, Terrestrial Time (Meeus: Dynamical Time)
 * @param {Nutation} [out] reused result object
 * @returns {Nutation}
 */
export function nutation(jdTT, out = newNutation()) {
  if (jdTT === MEMO.jdTT) return out === MEMO ? out : copyNutation(MEMO, out);
  const T = (jdTT - J2000) / DAYS_PER_CENTURY;
  const a = nutationArguments(T, ARGS);
  // The arguments are reduced mod 360 in degrees first (orientation.js periodicSum does the same), then multiplied.
  const D = a.D * DEG, M = a.M * DEG, Mp = a.Mp * DEG, F = a.F * DEG, Om = a.Omega * DEG;
  let dpsi = 0, deps = 0;
  for (let i = 0; i < TABLE_22A.length; i++) {
    const t = TABLE_22A[i];
    const arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F + t[4] * Om;
    dpsi += (t[5] + t[6] * T) * Math.sin(arg);
    deps += (t[7] + t[8] * T) * Math.cos(arg);
  }
  MEMO.jdTT = jdTT;
  MEMO.T = T;
  MEMO.dpsiArcsec = dpsi * UNIT_ARCSEC;
  MEMO.depsArcsec = deps * UNIT_ARCSEC;
  MEMO.dpsiRad = MEMO.dpsiArcsec / ARCSEC_PER_RAD;
  MEMO.depsRad = MEMO.depsArcsec / ARCSEC_PER_RAD;
  MEMO.meanObliquityRad = meanObliquityRad(T);
  MEMO.trueObliquityRad = MEMO.meanObliquityRad + MEMO.depsRad;
  MEMO.eqEquinoxRad = MEMO.dpsiRad * Math.cos(MEMO.trueObliquityRad);
  return out === MEMO ? out : copyNutation(MEMO, out);
}

/** Scratch for the scalar accessors. */
const SCR = newNutation();

/** @param {number} jdTT @returns {number} true obliquity ε = ε₀ + Δε, radians */
export function trueObliquityRad(jdTT) {
  return nutation(jdTT, SCR).trueObliquityRad;
}

/** @param {number} jdTT @returns {number} equation of the equinoxes Δψ cos ε, radians (Meeus p. 88) */
export function equationOfEquinoxesRad(jdTT) {
  return nutation(jdTT, SCR).eqEquinoxRad;
}

/**
 * Greenwich apparent sidereal time GAST = GMST(UT1) + Δψ cos ε (Meeus ch. 12 p. 88: "to obtain the apparent sidereal
 * time … add the correction Δψ cos ε"; GMST from time.js, IAU 1982). Example 12.a: 1987-04-10 0h UT → GMST 13h10m46.3668s,
 * Δψ cos ε = −3.788″ × cos 23.4436° = −3.475″ = −0.2317 s → GAST 13h10m46.1351s.
 * @param {number} jdUT1 JD(UT1 ≈ UTC) for the Earth-rotation angle
 * @param {number} jdTT JD(TT) for the nutation (defaults to jdUT1: the 69 s offset moves Δψ by < 1e-5″)
 * @returns {number} degrees in [0, 360)
 */
export function gastDeg(jdUT1, jdTT = jdUT1) {
  return wrap360(gmstDeg(jdUT1) + equationOfEquinoxesRad(jdTT) * RAD);
}

/** @param {number} jdUT1 @param {number} [jdTT] @returns {number} GAST in radians, [0, 2π) */
export function gastRad(jdUT1, jdTT) {
  return gastDeg(jdUT1, jdTT) * DEG;
}

/**
 * Nutation matrix N = R_x(ε₀ + Δε) · R_z(Δψ) · R_x(−ε₀): mean equator & equinox of date → true equator & equinox of
 * date, 3×3 row-major on column vectors. First-order check against Meeus 23.1: for the vernal-equinox direction
 * (1, 0, 0) it yields Δα ≈ Δψ cos ε, Δδ ≈ Δψ sin ε; for (0, 1, 0) (α = 90°, δ = 0) Δδ = Δε.
 * Expanded product (c₀ = cos ε₀, s₀ = sin ε₀, c = cos ε, s = sin ε, cψ = cos Δψ, sψ = sin Δψ):
 *   [ cψ,        −sψ c₀,               −sψ s₀              ]
 *   [ sψ c,       cψ c c₀ + s s₀,       cψ c s₀ − s c₀     ]
 *   [ sψ s,       cψ s c₀ − c s₀,       cψ s s₀ + c c₀     ]
 * Allocation-free when `out` is supplied.
 * @param {number} jdTT Julian date (TT)
 * @param {number[]|Float64Array} [out] reused length-9 array
 * @returns {number[]|Float64Array}
 */
export function nutationMatrix(jdTT, out = new Array(9)) {
  const n = nutation(jdTT, SCR);
  const c0 = Math.cos(n.meanObliquityRad), s0 = Math.sin(n.meanObliquityRad);
  const c = Math.cos(n.trueObliquityRad), s = Math.sin(n.trueObliquityRad);
  const cp = Math.cos(n.dpsiRad), sp = Math.sin(n.dpsiRad);
  out[0] = cp; out[1] = -sp * c0; out[2] = -sp * s0;
  out[3] = sp * c; out[4] = cp * c * c0 + s * s0; out[5] = cp * c * s0 - s * c0;
  out[6] = sp * s; out[7] = cp * s * c0 - c * s0; out[8] = cp * s * s0 + c * c0;
  return out;
}
