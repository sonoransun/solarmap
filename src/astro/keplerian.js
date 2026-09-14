// JPL "Keplerian Elements for Approximate Positions of the Major Planets" (E.M. Standish & J.G. Williams, 1992),
// https://ssd.jpl.nasa.gov/planets/approx_pos.html — TEST-ONLY cross-check of the VSOP87 ephemeris.
// Never imported by the app (arcsecond-to-arcminute accuracy by JPL's own table; see §7.2 of the ephemeris research).
//
// Tables 1, 2a and 2b are transcribed VERBATIM from the archived p_elem_t1.txt / p_elem_t2.txt
// (https://web.archive.org/web/2020id_/https://ssd.jpl.nasa.gov/txt/p_elem_t1.txt and …_t2.txt), which carry the same
// numbers as the live page (ephemeris research b4iv6z9la.txt §7.3–7.5). Pluto is omitted (out of scope, no reference).
//
// Recipe (approx_pos.html, verbatim summary, research §7.1):
//   1. T = (T_eph − 2451545.0)/36525 centuries past J2000.0 (T_eph = JD TDB; TT differs by < 2 ms, irrelevant here);
//      a = a0 + ȧ·T etc. for the six elements a, e, I, L, ϖ (long. perihelion), Ω (long. node).
//   2. ω = ϖ − Ω ; M = L − ϖ + b·T² + c·cos(f·T) + s·sin(f·T)  (b, c, s, f from Table 2b: Jupiter–Neptune, Table 2 only).
//   3. Wrap M to −180° ≤ M ≤ +180°; solve Kepler's equation M = E − e*·sin E with e* = (180/π)·e (degrees).
//   4. r' = (a(cos E − e), a√(1 − e²) sin E, 0) in the orbital plane, x' toward perihelion.
//   5. r_ecl = R_z(Ω)·R_x(I)·R_z(ω)·r' (active rotations of vec.js; expands to the three explicit JPL formulas
//      x_ecl = (cos ω cos Ω − sin ω sin Ω cos I) x' + (−sin ω cos Ω − cos ω sin Ω cos I) y', …). The page writes the same
//      product as R_z(−Ω) R_x(−I) R_z(−ω) in passive-axes notation.
// Frame: mean ecliptic and equinox of J2000 (the ≈0.1″ offset from the ICRF-based scene frame is far below the
// nominal errors, so positions are compared directly with ephemeris.js).

import { DEG, RAD, J2000, DAYS_PER_CENTURY } from './constants.js';
import { rotX, rotZ, mat3Apply, wrap180 } from './vec.js';

/** Element column order in every table row. */
export const ELEMENT_KEYS = Object.freeze(['a', 'e', 'I', 'L', 'varpi', 'Omega']);

/** Bodies in table order; 'earth' is the Earth–Moon barycentre ("EM Bary") in JPL's tables. */
export const BODY_KEYS = Object.freeze(['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

/**
 * Table 1: Keplerian elements and their rates, with respect to the mean ecliptic and equinox of J2000,
 * valid for the time-interval 1800 AD – 2050 AD. Rows: [a0, e0, I0, L0, ϖ0, Ω0] then the rates per Julian century.
 * Units: AU, AU/Cy; e dimensionless (the file header says "rad, rad/Cy" — a quirk); degrees, deg/Cy.
 * Verbatim from p_elem_t1.txt (research b4iv6z9la.txt §7.3).
 */
export const TABLE_1 = Object.freeze({
  mercury: Object.freeze({
    x0: Object.freeze([0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593]),
    rate: Object.freeze([0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]),
  }),
  venus: Object.freeze({
    x0: Object.freeze([0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255]),
    rate: Object.freeze([0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]),
  }),
  earth: Object.freeze({ // "EM Bary"
    x0: Object.freeze([1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0]),
    rate: Object.freeze([0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]),
  }),
  mars: Object.freeze({
    x0: Object.freeze([1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891]),
    rate: Object.freeze([0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]),
  }),
  jupiter: Object.freeze({
    x0: Object.freeze([5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909]),
    rate: Object.freeze([-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]),
  }),
  saturn: Object.freeze({
    x0: Object.freeze([9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448]),
    rate: Object.freeze([-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]),
  }),
  uranus: Object.freeze({
    x0: Object.freeze([19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503]),
    rate: Object.freeze([-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]),
  }),
  neptune: Object.freeze({
    x0: Object.freeze([30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574]),
    rate: Object.freeze([0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]),
  }),
});

/**
 * Table 2a: elements and rates, mean ecliptic and equinox of J2000, valid for 3000 BC – 3000 AD.
 * "NOTE: the computation of M for Jupiter through Pluto *must* be augmented by the additional terms given in Table 2b."
 * Same layout/units as TABLE_1. Verbatim from p_elem_t2.txt (research §7.4).
 */
export const TABLE_2A = Object.freeze({
  mercury: Object.freeze({
    x0: Object.freeze([0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819]),
    rate: Object.freeze([0.00000000, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182]),
  }),
  venus: Object.freeze({
    x0: Object.freeze([0.72332102, 0.00676399, 3.39777545, 181.97970850, 131.76755713, 76.67261496]),
    rate: Object.freeze([-0.00000026, -0.00005107, 0.00043494, 58517.81560260, 0.05679648, -0.27274174]),
  }),
  earth: Object.freeze({ // "EM Bary"
    x0: Object.freeze([1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389]),
    rate: Object.freeze([-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.31795260, -0.24123856]),
  }),
  mars: Object.freeze({
    x0: Object.freeze([1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984]),
    rate: Object.freeze([0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431]),
  }),
  jupiter: Object.freeze({
    x0: Object.freeze([5.20248019, 0.04853590, 1.29861416, 34.33479152, 14.27495244, 100.29282654]),
    rate: Object.freeze([-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619]),
  }),
  saturn: Object.freeze({
    x0: Object.freeze([9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702]),
    rate: Object.freeze([-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002]),
  }),
  uranus: Object.freeze({
    x0: Object.freeze([19.18797948, 0.04685740, 0.77298127, 314.20276625, 172.43404441, 73.96250215]),
    rate: Object.freeze([-0.00020455, -0.00001550, -0.00180155, 428.49512595, 0.09266985, 0.05739699]),
  }),
  neptune: Object.freeze({
    x0: Object.freeze([30.06952752, 0.00895439, 1.77005520, 304.22289287, 46.68158724, 131.78635853]),
    rate: Object.freeze([0.00006447, 0.00000818, 0.00022400, 218.46515314, 0.01009938, -0.00606302]),
  }),
});

/**
 * Table 2b: additional terms which must be added to the computation of M for Jupiter through Neptune,
 * 3000 BC to 3000 AD: M += b·T² + c·cos(f·T) + s·sin(f·T). Units: b deg/Cy², c and s deg, f deg/Cy.
 * Bodies absent here (Mercury–Mars) have b = c = s = f = 0. Verbatim from p_elem_t2.txt (research §7.5).
 */
export const TABLE_2B = Object.freeze({
  jupiter: Object.freeze({ b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000 }),
  saturn: Object.freeze({ b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125000 }),
  uranus: Object.freeze({ b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025000 }),
  neptune: Object.freeze({ b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025000 }),
});

/** Table 1 validity, "1800 AD – 2050 AD": JD(TT) of 1800-01-01 0h and 2051-01-01 0h (proleptic Gregorian). */
export const TABLE_1_JD_MIN = 2378496.5;
export const TABLE_1_JD_MAX = 2470172.5;

/** Kepler-solver tolerance in degrees (task spec; JPL says 1e-6° "is sufficient" for the approximation). */
export const KEPLER_TOL_DEG = 1e-9;

/**
 * Solve Kepler's equation M = E − e*·sin E in DEGREES (approx_pos.html "Solution of Kepler's Equation"):
 *   e* = (180/π)·e; E0 = M + e*·sin M; ΔM = M − (E_n − e*·sin E_n); ΔE = ΔM/(1 − e·cos E_n); E_{n+1} = E_n + ΔE,
 * iterated until |ΔE| ≤ tol. (The denominator uses the dimensionless e, only the sine term carries e*.)
 * @param {number} Mdeg mean anomaly, degrees (any value; wrapped internally to (−180, 180])
 * @param {number} e eccentricity (dimensionless, 0 ≤ e < 1)
 * @param {number} [tolDeg] convergence threshold on |ΔE|, degrees
 * @returns {number} eccentric anomaly E, degrees
 */
export function solveKepler(Mdeg, e, tolDeg = KEPLER_TOL_DEG) {
  const M = wrap180(Mdeg);
  const eStar = e * RAD; // e* = 57.29578·e
  let E = M + eStar * Math.sin(M * DEG);
  // Newton converges quadratically for e ≤ 0.25; 50 iterations is far more than any (M, e) in range needs.
  for (let n = 0; n < 50; n++) {
    const dM = M - (E - eStar * Math.sin(E * DEG));
    const dE = dM / (1 - e * Math.cos(E * DEG));
    E += dE;
    if (Math.abs(dE) <= tolDeg) return E;
  }
  throw new RangeError(`solveKepler: no convergence for M=${Mdeg}°, e=${e}`);
}

/**
 * Pick the element table for an instant. 'auto' = Table 1 inside 1800–2050 (its validity interval), else 2a+2b.
 * @param {number} jdTT
 * @param {'auto'|1|2|'1'|'2'} table
 * @returns {1|2}
 */
export function selectTable(jdTT, table = 'auto') {
  if (table === 'auto') return jdTT >= TABLE_1_JD_MIN && jdTT < TABLE_1_JD_MAX ? 1 : 2;
  if (table === 1 || table === '1') return 1;
  if (table === 2 || table === '2') return 2;
  throw new RangeError(`keplerian: unknown table '${table}' (use 'auto', 1 or 2)`);
}

/**
 * @typedef {{a:number, e:number, I:number, L:number, varpi:number, Omega:number, omega:number, M:number, T:number,
 *   table:1|2}} KeplerianElements  — a in AU, angles in degrees, M wrapped to (−180, 180]
 */

/**
 * Osculating-style mean elements of a planet at an instant (recipe steps 1–3 without the Kepler solution).
 * @param {string} body one of BODY_KEYS ('earth' = Earth–Moon barycentre)
 * @param {number} jdTT Julian date, TT (≈ TDB; the < 2 ms difference is irrelevant at this accuracy)
 * @param {'auto'|1|2} [table] element table (see selectTable)
 * @param {KeplerianElements} [out] reused object
 * @returns {KeplerianElements}
 */
export function elements(body, jdTT, table = 'auto', out = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0, omega: 0, M: 0, T: 0, table: 1 }) {
  const which = selectTable(jdTT, table);
  const row = (which === 1 ? TABLE_1 : TABLE_2A)[body];
  if (row === undefined) throw new RangeError(`keplerian: unknown body '${body}'`);
  const T = (jdTT - J2000) / DAYS_PER_CENTURY; // step 1: centuries past J2000.0
  const x0 = row.x0, rate = row.rate;
  out.a = x0[0] + rate[0] * T;
  out.e = x0[1] + rate[1] * T;
  out.I = x0[2] + rate[2] * T;
  out.L = x0[3] + rate[3] * T;
  out.varpi = x0[4] + rate[4] * T;
  out.Omega = x0[5] + rate[5] * T;
  out.omega = out.varpi - out.Omega; // step 2: ω = ϖ − Ω
  let M = out.L - out.varpi; // step 2: M = L − ϖ (+ Table 2b terms for Jupiter–Neptune, Table 2 only)
  if (which === 2) {
    const extra = TABLE_2B[body];
    if (extra !== undefined) {
      const fT = extra.f * T * DEG;
      M += extra.b * T * T + extra.c * Math.cos(fT) + extra.s * Math.sin(fT);
    }
  }
  out.M = wrap180(M); // step 3: −180° ≤ M ≤ +180°
  out.T = T;
  out.table = which;
  return out;
}

// Module-level scratch so position() allocates nothing per call (test-only module, but keep the house style).
const scratchEl = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0, omega: 0, M: 0, T: 0, table: 1 };
const rPrime = [0, 0, 0];
const rTmp = [0, 0, 0];

/**
 * Heliocentric position in the mean ecliptic/equinox of J2000 (steps 3–5 of the JPL recipe).
 * @param {string} body one of BODY_KEYS ('earth' returns the Earth–Moon barycentre, as in JPL's tables)
 * @param {number} jdTT Julian date, TT
 * @param {'auto'|1|2} [table] element table (see selectTable)
 * @param {number[]} [out] reused length-3 array
 * @returns {number[]} [x, y, z] in AU
 */
export function position(body, jdTT, table = 'auto', out = [0, 0, 0]) {
  const el = elements(body, jdTT, table, scratchEl);
  const E = solveKepler(el.M, el.e) * DEG; // step 3
  // Step 4: orbital-plane coordinates, x' from the focus toward perihelion.
  rPrime[0] = el.a * (Math.cos(E) - el.e);
  rPrime[1] = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
  rPrime[2] = 0;
  // Step 5: r_ecl = R_z(Ω)·R_x(I)·R_z(ω)·r' with vec.js active rotations (same as JPL's explicit formulas).
  mat3Apply(rotZ(el.omega * DEG), rPrime, rTmp);
  mat3Apply(rotX(el.I * DEG), rTmp, rTmp);
  return mat3Apply(rotZ(el.Omega * DEG), rTmp, out);
}
