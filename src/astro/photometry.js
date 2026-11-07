// Apparent visual magnitudes of the planets and the Moon — Mallama, A. & Hilton, J. L. (2018), "Computing apparent
// planetary magnitudes for The Astronomical Almanac", Astronomy and Computing 25, 10–24
// (https://doi.org/10.1016/j.ascom.2018.08.002; arXiv:1808.01973): the V-band phase curves adopted by the Astronomical
// Almanac from 2019 and by JPL Horizons ("APmag", test/fixtures/horizons/observer.json). Every planet:
//   V = 5 log₁₀(r Δ) + V₁(0) + f(α),   r = heliocentric and Δ = geocentric distance in AU, α = phase angle in degrees,
// with the per-planet polynomials below (equation numbers from the paper's Section 3–10 / Table 2):
//   Mercury (eq. 2):  −0.613 + 6.3280e-2 α − 1.6336e-3 α² + 3.3644e-5 α³ − 3.4265e-7 α⁴ + 1.6893e-9 α⁵ − 3.0334e-12 α⁶,
//                     2° ≤ α ≤ 170°
//   Venus (eq. 3/4):  −4.384 − 1.044e-3 α + 3.687e-4 α² − 2.814e-6 α³ + 8.938e-9 α⁴ for 0° < α ≤ 163.7°;
//                     236.05828 − 2.81914 α + 8.39034e-3 α² for 163.7° < α < 179°
//   Earth (eq. 5):    −3.99 − 1.060e-3 α + 2.054e-4 α²
//   Mars (eq. 6/7):   −1.601 + 2.267e-2 α − 1.302e-4 α² for α ≤ 50°; −0.367 − 2.573e-2 α + 3.445e-4 α² for 50° < α ≤ 120°
//                     (the paper's rotational L(λe) and seasonal L(Ls) terms, ≈ ±0.07 mag, are not applied — they are
//                     absent from the Almanac tabulation too; the measured spread against Horizons is in the test)
//   Jupiter (eq. 8/9): −9.395 − 3.7e-4 α + 6.16e-4 α² for α ≤ 12°;
//                     −9.428 − 2.5 log₁₀(1 − 1.507 (α/180) − 0.363 (α/180)² − 0.062 (α/180)³ + 2.809 (α/180)⁴
//                     − 1.876 (α/180)⁵) for α > 12°
//   Saturn (eq. 10/11/12): globe + rings −8.914 − 1.825 sin β + 0.026 α − 0.378 sin β e^(−2.25 α) for α ≤ 6.5°, where β
//                     is the EFFECTIVE ring opening angle, sin β = √(sin B · sin B′) — the geometric mean of the
//                     saturnicentric latitudes of the Earth (B) and the Sun (B′), both from geometry.subLatitudes and
//                     the IAU 2015 pole (the paper's "effective sub-latitude"; against Horizons the geometric mean
//                     agrees to 0.001 mag where |B| alone leaves 0.065 — test/photometry.test.mjs); globe alone
//                     −8.95 − 3.7e-4 α + 6.16e-4 α² for α ≤ 6.5° when the rings are edge-on, and
//                     −8.94 + 2.446e-4 α + 2.672e-4 α² − 1.505e-6 α³ + 4.767e-9 α⁴ for 6° < α < 150°
//   Uranus (eq. 13):  −7.110 − 8.4e-4 φ′ + 6.587e-3 α + 1.045e-4 α², φ′ = |sub-Earth planetocentric latitude| in degrees
//                     (the pole is brighter than the equator), α < 3.1°
//   Neptune (eq. 14/15): −7.00 + 7.944e-3 α + 9.617e-5 α² for years ≥ 2000 (−6.89 before 1980, linear in between:
//                     Neptune brightened by 0.11 mag over 1980–2000), α < 133°
// Outside the stated phase-angle range the Almanac prints nothing; here the polynomial is evaluated at the nearest
// range limit and `valid` is false, so the renderer's brightness law always has a finite number (contract: markers
// use 10^(−0.4 m) with a visibility floor).
//
// The Moon: Allen, Astrophysical Quantities, 3rd ed. (1973) §85 p. 144 (reproduced in Meeus's "Astronomical
// Formulae" and the Almanac explanatory notes): V = −12.73 + 0.026 |α| + 4e-9 α⁴ at the mean distances (Sun 1 AU,
// Earth 385 000 km, i.e. MOON.meanDistanceKm), plus 5 log₁₀(r Δ/Δ₀) for other distances; good to ≈ ±0.2 mag (the
// opposition surge below α ≈ 7° and libration are not modelled).
import { AU_KM, RAD, DEG, J2000, JULIAN_YEAR_DAYS } from './constants.js';
import { angleBetween } from './vec.js';
import { phaseAngleRad, distanceAu, geocentricDistanceKm, angularDiameterArcsec, illuminatedFraction, subLatitudes } from './geometry.js';
import { MOON } from './moon.js';

/** @typedef {import('./geometry.js').States} States */

/**
 * Validity ranges of the phase curves in degrees of phase angle (Mallama & Hilton 2018, Table 2 "Phase angle range"),
 * exported so the UI can label an extrapolated value.
 * @type {Readonly<Record<string, readonly [number, number]>>}
 */
export const PHASE_RANGE_DEG = Object.freeze({
  mercury: Object.freeze([2, 170]),
  venus: Object.freeze([0, 179]),
  earth: Object.freeze([0, 170]),
  mars: Object.freeze([0, 120]),
  jupiter: Object.freeze([0, 130]),
  saturn: Object.freeze([0, 150]),
  uranus: Object.freeze([0, 3.1]),
  neptune: Object.freeze([0, 133]),
});

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Phase term f(α) of the Mallama & Hilton curves (everything except 5 log₁₀(r Δ)), degrees in. Saturn needs the
 * sine of the effective ring opening angle (sinBeta = √(sin|B| sin|B′|)), Uranus the sub-Earth latitude φ′ (degrees,
 * |φ|), Neptune the epoch (Julian year).
 * @param {string} id planet id
 * @param {number} alphaDeg phase angle, degrees (clamped into PHASE_RANGE_DEG by the caller)
 * @param {{sinBeta?: number, phiDeg?: number, year?: number}} [aux]
 * @returns {number} magnitudes
 */
export function phaseTerm(id, alphaDeg, aux) {
  const a = alphaDeg;
  switch (id) {
    case 'mercury':
      return -0.613 + 6.3280e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6;
    case 'venus':
      return a <= 163.7
        ? -4.384 - 1.044e-3 * a + 3.687e-4 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4
        : 236.05828 - 2.81914 * a + 8.39034e-3 * a ** 2;
    case 'earth':
      return -3.99 - 1.060e-3 * a + 2.054e-4 * a ** 2;
    case 'mars':
      return a <= 50
        ? -1.601 + 2.267e-2 * a - 1.302e-4 * a ** 2
        : -0.367 - 2.573e-2 * a + 3.445e-4 * a ** 2;
    case 'jupiter': {
      if (a <= 12) return -9.395 - 3.7e-4 * a + 6.16e-4 * a ** 2;
      const x = a / 180;
      return -9.428 - 2.5 * Math.log10(1 - 1.507 * x - 0.363 * x ** 2 - 0.062 * x ** 3 + 2.809 * x ** 4 - 1.876 * x ** 5);
    }
    case 'saturn': {
      if (a > 6.5) return -8.94 + 2.446e-4 * a + 2.672e-4 * a ** 2 - 1.505e-6 * a ** 3 + 4.767e-9 * a ** 4;
      const sb = aux?.sinBeta ?? 0;
      if (sb === 0) return -8.95 - 3.7e-4 * a + 6.16e-4 * a ** 2;
      return -8.914 - 1.825 * sb + 0.026 * a - 0.378 * sb * Math.exp(-2.25 * a);
    }
    case 'uranus':
      return -7.110 - 8.4e-4 * Math.abs(aux?.phiDeg ?? 0) + 6.587e-3 * a + 1.045e-4 * a ** 2;
    case 'neptune': {
      const y = aux?.year ?? 2000;
      const v0 = y >= 2000 ? -7.00 : y <= 1980 ? -6.89 : -6.89 - 0.11 * (y - 1980) / 20;
      return v0 + 7.944e-3 * a + 9.617e-5 * a ** 2;
    }
    default:
      throw new RangeError(`photometry: no phase curve for '${id}'`);
  }
}

/**
 * @typedef {object} Magnitude
 * @property {number} mag apparent visual magnitude V
 * @property {boolean} valid false when the phase angle lies outside the curve's observed range (value extrapolated at
 *   the range edge) — the Almanac prints no magnitude there
 * @property {number} phaseAngleDeg α
 * @property {number} rAu heliocentric distance
 * @property {number} deltaAu geocentric distance
 * @property {number} illuminatedFraction k = (1 + cos α)/2
 * @property {number} angularDiameterArcsec equatorial apparent diameter
 * @property {number} ringOpeningDeg Saturn only: B, the ring opening angle seen from Earth (signed, + = north face;
 *   NaN otherwise)
 * @property {number} ringOpeningSunDeg Saturn only: B′, the ring opening angle lit by the Sun (NaN otherwise)
 * @property {number} subEarthLatDeg planetocentric latitude of the sub-Earth point (NaN for 'sun')
 */

/** @returns {Magnitude} */
export function newMagnitude() {
  return { mag: NaN, valid: false, phaseAngleDeg: NaN, rAu: NaN, deltaAu: NaN, illuminatedFraction: NaN, angularDiameterArcsec: NaN, ringOpeningDeg: NaN, ringOpeningSunDeg: NaN, subEarthLatDeg: NaN };
}

const SUBLAT = { earthDeg: 0, sunDeg: 0 };
const AUX = { sinBeta: 0, phiDeg: 0, year: 2000 };

/**
 * sin of Saturn's effective ring opening angle: √(sin|B| · sin|B′|) (Mallama & Hilton 2018 §7); 0 when either face is
 * edge-on, and 0 when the Earth and the Sun see opposite faces (the lit face is hidden — around a ring-plane crossing).
 * @param {number} earthDeg B @param {number} sunDeg B′ @returns {number}
 */
export function saturnEffectiveSinBeta(earthDeg, sunDeg) {
  if (earthDeg === 0 || sunDeg === 0 || (earthDeg > 0) !== (sunDeg > 0)) return 0;
  return Math.sqrt(Math.sin(Math.abs(earthDeg) * DEG) * Math.sin(Math.abs(sunDeg) * DEG));
}

/**
 * Apparent visual magnitude of a planet from a states snapshot (Mallama & Hilton 2018; module header).
 * @param {States} S heliocentric states (ephemeris.states)
 * @param {string} id planet id other than 'earth' ('moon' → moonMagnitude via moonMagnitudeFromStates)
 * @param {number} jdTT epoch (Saturn/Uranus pole orientation, Neptune secular term)
 * @param {Magnitude} [out] reused result object
 * @returns {Magnitude}
 */
export function planetMagnitude(S, id, jdTT, out = newMagnitude()) {
  const range = PHASE_RANGE_DEG[id];
  if (range === undefined || id === 'earth') throw new RangeError(`photometry: no geocentric magnitude for '${id}'`);
  const alpha = phaseAngleRad(S, id) * RAD;
  const r = distanceAu(S, 'sun', id);
  const delta = distanceAu(S, 'earth', id);
  const sub = subLatitudes(S, id, jdTT, SUBLAT);
  AUX.sinBeta = id === 'saturn' ? saturnEffectiveSinBeta(sub.earthDeg, sub.sunDeg) : 0;
  AUX.phiDeg = sub.earthDeg;
  AUX.year = 2000 + (jdTT - J2000) / JULIAN_YEAR_DAYS;
  const a = clamp(alpha, range[0], range[1]);
  out.mag = 5 * Math.log10(r * delta) + phaseTerm(id, a, AUX);
  out.valid = alpha >= range[0] && alpha <= range[1];
  out.phaseAngleDeg = alpha;
  out.rAu = r;
  out.deltaAu = delta;
  out.illuminatedFraction = illuminatedFraction(S, id);
  out.angularDiameterArcsec = angularDiameterArcsec(S, id);
  out.ringOpeningDeg = id === 'saturn' ? sub.earthDeg : NaN;
  out.ringOpeningSunDeg = id === 'saturn' ? sub.sunDeg : NaN;
  out.subEarthLatDeg = sub.earthDeg;
  return out;
}

/**
 * Magnitude of the Moon (Allen 1973 §85): V = −12.73 + 0.026 |α| + 4e-9 α⁴ + 5 log₁₀(r_☉ · Δ/Δ₀), α in degrees,
 * r_☉ = Moon–Sun distance in AU, Δ₀ = MOON.meanDistanceKm.
 * @param {number} phaseAngleDeg Sun–Moon–Earth angle (moon.moonIllumination)
 * @param {number} distKm geocentric distance, km
 * @param {number} [sunDistAu] Moon–Sun distance, AU (default 1)
 * @returns {number} V
 */
export function moonMagnitude(phaseAngleDeg, distKm, sunDistAu = 1) {
  const a = Math.abs(phaseAngleDeg);
  return -12.73 + 0.026 * a + 4e-9 * a ** 4 + 5 * Math.log10(sunDistAu * distKm / MOON.meanDistanceKm);
}

const MS = [0, 0, 0];
const ME = [0, 0, 0];

/**
 * Moon magnitude and phase from heliocentric states that include the Moon (createEphemeris(SERIES, {moon: true})).
 * @param {States} S states with S.moon (heliocentric) and S.earth
 * @param {Magnitude} [out]
 * @returns {Magnitude}
 */
export function moonMagnitudeFromStates(S, out = newMagnitude()) {
  const m = S.moon, e = S.earth;
  if (m === undefined) throw new RangeError('photometry: states have no moon');
  MS[0] = -m.x; MS[1] = -m.y; MS[2] = -m.z;                 // Moon → Sun
  ME[0] = e.x - m.x; ME[1] = e.y - m.y; ME[2] = e.z - m.z;  // Moon → Earth
  const alpha = angleBetween(MS, ME) * RAD;
  const distKm = geocentricDistanceKm(S, 'moon');
  out.mag = moonMagnitude(alpha, distKm, Math.hypot(m.x, m.y, m.z));
  out.valid = true;
  out.phaseAngleDeg = alpha;
  out.rAu = Math.hypot(m.x, m.y, m.z);
  out.deltaAu = distKm / AU_KM;
  out.illuminatedFraction = (1 + Math.cos(alpha * DEG)) / 2;
  out.angularDiameterArcsec = 2 * Math.asin(MOON.radiusKm / distKm) * RAD * 3600;
  out.ringOpeningDeg = NaN;
  out.ringOpeningSunDeg = NaN;
  out.subEarthLatDeg = NaN;
  return out;
}

const SCR = newMagnitude();

/**
 * Magnitude for the marker brightness law: a finite number for every body with a magnitude ('sun' → −26.74, the
 * Sun's V at 1 AU (Mallama & Hilton Table 1: m☉ = −26.74 ± 0.02), scaled by 5 log₁₀(Δ) for other distances).
 * @param {States} S @param {string} id @param {number} jdTT
 * @returns {number} V (NaN for 'earth')
 */
export function magnitude(S, id, jdTT) {
  if (id === 'earth') return NaN;
  if (id === 'sun') return -26.74 + 5 * Math.log10(distanceAu(S, 'earth', 'sun'));
  if (id === 'moon') return moonMagnitudeFromStates(S, SCR).mag;
  return planetMagnitude(S, id, jdTT, SCR).mag;
}
