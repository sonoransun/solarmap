// Equinoxes and solstices — Meeus, Astronomical Algorithms 2nd ed., chapter 27 "Equinoxes and Solstices": the instant
// when the Sun's APPARENT geocentric longitude λ☉ (ecliptic and true equinox of date: geometric longitude + nutation
// Δψ + aberration −20.4898″/R, apparent.js) is a multiple of 90° — 0° March equinox, 90° June solstice, 180° September
// equinox, 270° December solstice (Meeus p. 177: "the instants … when the apparent geocentric longitude of the Sun is a
// multiple of 90 degrees"). Meeus's method: a mean instant JDE₀ from the polynomials of Table 27.A (years −1000 … +1000)
// / 27.B (+1000 … +3000) and a correction from a periodic series (27.1); here the mean instant only seeds a bracket and
// the exact instant is the Brent root of sin(λ☉ − λ_k) on the VSOP87 ephemeris (numeric.brentRoot to 1e-6 d ≈ 0.09 s),
// which removes the ≈ 1-minute truncation error of the series (Meeus p. 180: "51 seconds" for 1962). Verified against
// the USNO instants of 2025–2026 to ≤ 2 min in test/seasons.test.mjs (measured residuals in the test header).
//
// Vocabulary (lay audience): "March equinox" / "September equinox" rather than "spring"/"autumn", since the seasons are
// opposite in the two hemispheres; the UI copy adds the hemisphere meaning.
import { DEG } from './constants.js';
import { brentRoot } from './numeric.js';
import { apparentSunLongitudeDeg } from './apparent.js';
import { utcFromTt } from './time.js';

/** The four events in calendar order. */
export const SEASON_KINDS = Object.freeze(['equinox-march', 'solstice-june', 'equinox-september', 'solstice-december']);

/** Apparent solar longitude of each event, degrees (Meeus p. 177). */
export const SEASON_LONGITUDE_DEG = Object.freeze({
  'equinox-march': 0,
  'solstice-june': 90,
  'equinox-september': 180,
  'solstice-december': 270,
});

/** Half-width of the root bracket around the Meeus mean instant, days (the series correction is < 0.3 d; the Sun moves ≈ 1°/d). */
export const SEASON_BRACKET_HALF_WIDTH_D = 3;
/** brentRoot tolerance in days (0.09 s; the Sun's longitude changes 0.0036″ in that time). */
export const SEASON_ROOT_TOL_D = 1e-6;

/**
 * Meeus Table 27.A (years −1000 to +1000, Y = year/1000) and Table 27.B (years +1000 to +3000, Y = (year − 2000)/1000)
 * polynomials for the MEAN instant JDE₀ (dynamical time) of each event, verbatim (coefficients of 1, Y, Y², Y³, Y⁴).
 * Meeus: "for years outside −1000 … +3000 the results are of lower accuracy" — the polynomials are still evaluated.
 */
const TABLE_27A = Object.freeze({
  'equinox-march': [1721139.29189, 365242.13740, 0.06134, 0.00111, -0.00071],
  'solstice-june': [1721233.25401, 365241.72562, -0.05323, 0.00907, 0.00025],
  'equinox-september': [1721325.70455, 365242.49558, -0.11677, -0.00297, 0.00074],
  'solstice-december': [1721414.39987, 365242.88257, -0.00769, -0.00933, -0.00006],
});
const TABLE_27B = Object.freeze({
  'equinox-march': [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057],
  'solstice-june': [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.00030],
  'equinox-september': [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],
  'solstice-december': [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032],
});

/**
 * Meeus mean instant JDE₀ of a season (Table 27.A/B; ch. 27 step 1), dynamical time ≈ TT. Within ≈ 0.3 d of the true
 * instant (the periodic correction of eq. 27.1 is not applied — the root finder replaces it).
 * @param {number} year proleptic Gregorian calendar year (integer)
 * @param {string} kind one of SEASON_KINDS
 * @returns {number} JD(TT)
 */
export function meanSeasonJd(year, kind) {
  const useA = year < 1000;
  const c = (useA ? TABLE_27A : TABLE_27B)[kind];
  if (c === undefined) throw new RangeError(`seasons: unknown kind '${kind}'`);
  const Y = useA ? year / 1000 : (year - 2000) / 1000;
  return c[0] + c[1] * Y + c[2] * Y * Y + c[3] * Y * Y * Y + c[4] * Y * Y * Y * Y;
}

/**
 * Root function of a season: sin(λ☉(t) − λ_k), smooth through the crossing (its cosine is +1 at the wanted root and
 * −1 at the opposite season, which the events scan uses as the alias guard).
 * @param {import('./apparent.js').EphemerisLike|import('./apparent.js').States} src ephemeris or states at t
 * @param {string} kind one of SEASON_KINDS
 * @param {number} jdTT
 * @returns {number}
 */
export function seasonRootValue(src, kind, jdTT) {
  const lam = SEASON_LONGITUDE_DEG[kind];
  if (lam === undefined) throw new RangeError(`seasons: unknown kind '${kind}'`);
  return Math.sin((apparentSunLongitudeDeg(src, jdTT) - lam) * DEG);
}

/**
 * @typedef {{kind:string, year:number, jdTT:number, jdUtc:number, sunLongitudeDeg:number, meanJdTT:number}} SeasonInstant
 */

/**
 * Exact instant of one season of a calendar year: Brent root of sin(λ☉ − λ_k) on [JDE₀ − 3 d, JDE₀ + 3 d] around the
 * Meeus mean instant (the bracket always holds exactly one crossing of λ_k since λ☉ advances ≈ 6° over it).
 * @param {import('./apparent.js').EphemerisLike} eph ephemeris instance
 * @param {number} year proleptic Gregorian year
 * @param {string} kind one of SEASON_KINDS
 * @param {SeasonInstant} [out] reused result object
 * @returns {SeasonInstant}
 */
export function seasonInstant(eph, year, kind, out = { kind: '', year: 0, jdTT: 0, jdUtc: 0, sunLongitudeDeg: 0, meanJdTT: 0 }) {
  const jd0 = meanSeasonJd(year, kind);
  const f = (t) => seasonRootValue(eph, kind, t);
  const a = jd0 - SEASON_BRACKET_HALF_WIDTH_D, b = jd0 + SEASON_BRACKET_HALF_WIDTH_D;
  const jdTT = brentRoot(f, a, b, { tol: SEASON_ROOT_TOL_D });
  out.kind = kind;
  out.year = year;
  out.jdTT = jdTT;
  out.jdUtc = utcFromTt(jdTT);
  out.sunLongitudeDeg = SEASON_LONGITUDE_DEG[kind];
  out.meanJdTT = jd0;
  return out;
}

/**
 * The four seasons of a calendar year in order.
 * @param {import('./apparent.js').EphemerisLike} eph
 * @param {number} year
 * @returns {SeasonInstant[]}
 */
export function seasonsOfYear(eph, year) {
  return SEASON_KINDS.map((kind) => seasonInstant(eph, year, kind));
}
