// bodies.js + orientation.js — plan §Verification "orientation" row. Reference values: IAU WGCCRE 2015 (Archinal et
// al. 2018) evaluated at J2000 with periodic terms, NSSDC fact sheets, the constants research bhqes187e.txt §2/§8/§9
// (Horizons-derived Earth sub-solar fixtures) and the final critique byf0bzyiw.txt (measured residuals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import { ttFromUtc, utcFromTt, gmstDeg, jdFromCalendar } from '../src/astro/time.js';
import { EQ_TO_ECL, ECL_TO_EQ, precessionMatrix } from '../src/astro/frames.js';
import { mat3Mul, mat3T, mat3Apply, rotX, rotZ, wrap180, norm } from '../src/astro/vec.js';
import { AU_KM, J2000, RAD, DEG } from '../src/astro/constants.js';
import {
  BODIES, BODY_IDS, PLANET_IDS, SATURN_RINGS, body, radiusAu, radiusPolarAu, flattening, isPlanet,
} from '../src/astro/bodies.js';
import {
  rotationElements, poleRaDec, bodyToEcliptic, poleEcliptic, primeMeridianEcliptic, subSolarPoint,
  spinRateDegPerDay, isRetrograde, siderealRotationDays, siderealRotationHours, obliquityToOrbit,
} from '../src/astro/orientation.js';

const eph = createEphemeris(SERIES, { meta: META });
const JD_2026_09_13 = 2461297.0; // 2026-09-13 12:00 (TT or UTC label, per test)
const EPOCHS = [J2000, JD_2026_09_13, 2305448.0 /* 1600 */, 2634167.0 /* 2500 */, 260089.5 /* −4000 */, 3182395.5 /* +4000 */];

function maxAbsDiff(A, B) { let m = 0; for (let k = 0; k < A.length; k++) m = Math.max(m, Math.abs(A[k] - B[k])); return m; }
function det3(M) {
  return M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
}
function assertClose(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected} (|Δ| = ${Math.abs(actual - expected)} > ${tol})`);
}

// ---------------------------------------------------------------------------------------------------------------------
// bodies.js
// ---------------------------------------------------------------------------------------------------------------------

test('bodies: table shape, ids, Horizons ids, priorities', () => {
  assert.deepEqual([...BODY_IDS], ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
  assert.deepEqual([...PLANET_IDS], BODY_IDS.slice(1));
  assert.deepEqual(Object.keys(BODIES), [...BODY_IDS], 'BODIES keys in display order');
  const horizons = { sun: 10, mercury: 199, venus: 299, earth: 399, mars: 4, jupiter: 5, saturn: 6, uranus: 7, neptune: 8 };
  const priority = { sun: 10, earth: 9, jupiter: 8, saturn: 7, mars: 6, venus: 5, mercury: 4, uranus: 3, neptune: 2 };
  for (const id of BODY_IDS) {
    const b = body(id);
    assert.equal(b.id, id);
    assert.equal(typeof b.name, 'string');
    assert.equal(b.horizonsId, horizons[id], `${id} Horizons id (fixtures README)`);
    assert.equal(b.priority, priority[id], `${id} label priority (plan §Labels)`);
    assert.match(b.colour, /^#[0-9A-F]{6}$/, `${id} colour is a hex triplet`);
    assert.match(b.accent, /^#[0-9A-F]{6}$/);
    assert.ok(b.radiusEqKm >= b.radiusPolarKm, `${id} a ≥ c`);
    assert.ok(b.gmKm3S2 > 0);
    assert.ok(Object.isFrozen(b) && Object.isFrozen(b.rotation), `${id} entries are frozen`);
  }
  assert.equal(isPlanet('sun'), false);
  assert.equal(isPlanet('mars'), true);
  assert.equal(isPlanet('pluto'), false);
  assert.throws(() => body('pluto'), RangeError, 'unknown body throws RangeError');
});

test('bodies: IAU 2015 / pck00011 radii, DE440 GMs and NSSDC orbit periods verbatim', () => {
  const radii = { // pck00011 BODYnnn_RADII (a, c), km — bhqes187e.txt §1c
    sun: [695700, 695700], mercury: [2440.53, 2438.26], venus: [6051.8, 6051.8], earth: [6378.1366, 6356.7519],
    mars: [3396.19, 3376.20], jupiter: [71492, 66854], saturn: [60268, 54364], uranus: [25559, 24973], neptune: [24764, 24341],
  };
  const gm = { // JPL astro_par DE440, km³/s² — bhqes187e.txt §1a
    sun: 132712440041.279419, mercury: 22031.868551, venus: 324858.592000, earth: 398600.435507, mars: 42828.375816,
    jupiter: 126712764.100000, saturn: 37940584.841800, uranus: 5794556.400000, neptune: 6836527.100580,
  };
  const period = { // NSSDC sidereal orbit period, days
    sun: null, mercury: 87.969, venus: 224.701, earth: 365.256, mars: 686.980, jupiter: 4332.589, saturn: 10755.699,
    uranus: 30685.4, neptune: 60189.018,
  };
  for (const id of BODY_IDS) {
    const b = body(id);
    assert.equal(b.radiusEqKm, radii[id][0], `${id} equatorial radius (pck00011)`);
    assert.equal(b.radiusPolarKm, radii[id][1], `${id} polar radius (pck00011)`);
    assert.equal(b.gmKm3S2, gm[id], `${id} GM (DE440 astro_par)`);
    assert.equal(b.siderealOrbitDays, period[id], `${id} sidereal orbit period (NSSDC)`);
  }
  assert.equal(radiusAu('earth'), 6378.1366 / AU_KM, 'radiusAu = a / AU_KM');
  assert.equal(radiusPolarAu('saturn'), 54364 / AU_KM);
  assertClose(flattening('earth'), 1 / 298.257223563, 2e-6, 'Earth flattening ≈ WGS84 1/298.257 (IAU radii, Horizons Earth block)');
  assertClose(flattening('saturn'), 0.09796, 1e-5, 'Saturn flattening (60268 − 54364)/60268 = 0.09796 (NSSDC)');
  assert.equal(flattening('venus'), 0);
});

test('bodies: Saturn rings from the NSSDC ring fact sheet', () => {
  assert.equal(body('saturn').rings, SATURN_RINGS);
  assert.equal(SATURN_RINGS.innerKm, 74658, 'C ring inner edge');
  assert.equal(SATURN_RINGS.outerKm, 139826, 'F ring');
  const expected = [['C', 74658, 91975, 'ring'], ['B', 91975, 117507, 'ring'], ['Cassini division', 117507, 122340, 'gap'], ['A', 122340, 136780, 'ring']];
  assert.equal(SATURN_RINGS.bands.length, 4);
  for (let i = 0; i < 4; i++) {
    const b = SATURN_RINGS.bands[i];
    assert.equal(b.name, expected[i][0]);
    assert.equal(b.innerKm, expected[i][1], `${b.name} inner edge (NSSDC satringfact)`);
    assert.equal(b.outerKm, expected[i][2], `${b.name} outer edge (NSSDC satringfact)`);
    assert.equal(b.kind, expected[i][3]);
    if (i > 0) assert.equal(b.innerKm, SATURN_RINGS.bands[i - 1].outerKm, 'bands are contiguous');
    assert.ok(b.opticalDepth[0] <= b.opticalDepth[1]);
  }
  assert.deepEqual(SATURN_RINGS.gaps.map((g) => [g.name, g.radiusKm]), [['Encke gap', 133410], ['Keeler gap', 136487]]);
  assert.equal(SATURN_RINGS.fRing.radiusKm, 139826);
  assert.ok(SATURN_RINGS.innerKm > body('saturn').radiusEqKm, 'rings start outside the 1-bar equator (60,268 km)');
  for (const id of BODY_IDS) if (id !== 'saturn') assert.equal(body(id).rings, undefined, `${id} has no ring spec`);
});

// ---------------------------------------------------------------------------------------------------------------------
// rotationElements
// ---------------------------------------------------------------------------------------------------------------------

test('rotationElements at J2000 with periodic terms (Mars, Jupiter, Neptune, Mercury) to 1e-5°', () => {
  // bhqes187e.txt §2 "Evaluated full poles at J2000 … INCLUDING periodic terms" and critique byf0bzyiw.txt (+): the
  // Mars 0.5042615 °/century terms contribute +0.411652° in α0 and −1.546077° in δ0 at J2000.
  const cases = {
    mars: [317.680854, 52.886439, 176.632060],
    jupiter: [268.057204, 64.495810, 284.95],
    neptune: [299.333739, 42.950359, 249.996008],
    mercury: [281.0103, 61.4155, 329.599949],
    sun: [286.13, 63.87, 84.176],
    venus: [272.76, 67.16, 160.20],
    saturn: [40.589, 83.537, 38.90],
    uranus: [257.311, -15.175, 203.81],
  };
  for (const [id, [a, d, w]] of Object.entries(cases)) {
    const e = rotationElements(id, J2000);
    assertClose(e.alpha0 * RAD, a, 1e-5, `${id} α0(J2000) (IAU 2015 with periodic terms, plan tol 1e-5°)`);
    assertClose(e.delta0 * RAD, d, 1e-5, `${id} δ0(J2000)`);
    assertClose(e.W * RAD, w, 1e-5, `${id} W(J2000)`);
  }
  // Secular-only Mars pole would be 317.269202 / 54.432516: the periodic terms are being applied.
  const m = rotationElements('mars', J2000);
  assertClose(m.alpha0 * RAD - 317.269202, 0.411652, 1e-5, 'Mars α0 periodic contribution at J2000 (+0.4117°)');
  assertClose(m.delta0 * RAD - 54.432516, -1.546077, 1e-5, 'Mars δ0 periodic contribution at J2000 (−1.5461°)');
  // out param is honoured
  const out = { alpha0: 0, delta0: 0, W: 0 };
  assert.equal(rotationElements('jupiter', J2000, out), out);
  assert.throws(() => rotationElements('pluto', J2000), RangeError);
});

test('rotationElements: W advances by Ẇ per day (d in days, T in centuries), wrapped to [0, 2π)', () => {
  for (const id of ['sun', 'venus', 'saturn', 'uranus']) {
    const w0 = rotationElements(id, JD_2026_09_13).W, w1 = rotationElements(id, JD_2026_09_13 + 1).W;
    assert.ok(w0 >= 0 && w0 < 2 * Math.PI && w1 >= 0 && w1 < 2 * Math.PI, `${id} W in [0, 2π)`);
    assertClose(wrap180((w1 - w0) * RAD), wrap180(spinRateDegPerDay(id)), 1e-9, `${id} W(d+1) − W(d) ≡ Ẇ (mod 360)`);
  }
  // Mercury's librations: W − (329.5988 + 6.1385108 d) is the M1…M5 sum, |·| ≤ 0.0119°
  for (const jd of [J2000, JD_2026_09_13, 2305448.0]) {
    const w = rotationElements('mercury', jd).W * RAD;
    const lin = 329.5988 + 6.1385108 * (jd - J2000);
    assert.ok(Math.abs(wrap180(w - lin)) <= 0.01067257 + 0.00112309 + 0.00011040 + 0.00002539 + 0.00000571 + 1e-12,
      `Mercury W libration bounded by Σ|amp| = 0.0119° (jd ${jd})`);
  }
  // Neptune: α0 = 299.36 + 0.70 sin N oscillates by ±0.70° over the 688-year N cycle (52.316 °/century)
  const jdN90 = J2000 + ((90 - 357.85 + 360) / 52.316) * 36525; // N = 90°
  assertClose(rotationElements('neptune', jdN90).alpha0 * RAD, 300.06, 1e-6, 'Neptune α0 at N = 90° = 299.36 + 0.70');
  assertClose(rotationElements('neptune', jdN90).delta0 * RAD, 43.46, 1e-6, 'Neptune δ0 at N = 90° = 43.46 − 0.51 cos 90°');
});

test('rotationElements / poleRaDec for Earth: IAU-form equivalent of GMST + precession', () => {
  // At J2000 with UT1 = 12:00: P(0) = I, so α0 = 0, δ0 = 90°, W = GMST − 90° = 190.46061837° (Meeus 12.4 at J2000:
  // 280.46061837°); the IAU 2009 expression's W0 = 190.147 is the known 0.31° bias (bhqes187e.txt §8).
  const e = rotationElements('earth', J2000, undefined, J2000);
  assertClose(e.alpha0 * RAD, 0, 1e-12, 'Earth α0(J2000) = 0');
  assertClose(e.delta0 * RAD, 90, 1e-12, 'Earth δ0(J2000) = 90°');
  assertClose(e.W * RAD, 280.46061837 - 90, 1e-9, 'Earth W(J2000, UT1 = 12:00) = GMST − 90°');
  // jdUT1 omitted → derived with utcFromTt (ΔT = 63.184 s at J2000 → GMST 0.263° smaller)
  const e2 = rotationElements('earth', J2000);
  assertClose(e2.W * RAD, gmstDeg(utcFromTt(J2000)) - 90, 1e-9, 'Earth W defaults jdUT1 to utcFromTt(jdTT)');
  // 2026: pole RA = −ζ_A = 359.828952°, Dec = 90° − θ_A = 89.851358° (frames.test: ζ 0.171048°, θ 0.148642°)
  const p = poleRaDec('earth', JD_2026_09_13);
  assertClose(p.raDeg, 360 - 0.171048, 2e-6, 'Earth pole RA 2026 = −ζ_A');
  assertClose(p.decDeg, 90 - 0.148642, 2e-6, 'Earth pole Dec 2026 = 90° − θ_A');
  assertClose(poleRaDec('mars', J2000).raDeg, 317.680854, 1e-5, 'poleRaDec Mars');
});

// ---------------------------------------------------------------------------------------------------------------------
// bodyToEcliptic / poles
// ---------------------------------------------------------------------------------------------------------------------

test('Mars body→ecliptic matrix at J2000 (bhqes187e.txt §8 worked matrix) to 2e-6', () => {
  const expected = [
    -0.706736446, 0.549061991, 0.446155271,
    -0.634181589, -0.771188454, -0.055516490,
    0.313587799, -0.322178985, 0.893231993,
  ];
  const M = bodyToEcliptic('mars', J2000, J2000);
  assert.ok(maxAbsDiff(M, expected) < 2e-6, `Mars M_body→ecl max |Δ| = ${maxAbsDiff(M, expected)} (plan tol 2e-6)`);
  // Same via the generic vec.js composition EQ_TO_ECL · R_z(α0+90°) · R_x(90°−δ0) · R_z(W) — checks the expanded ZXZ product
  const e = rotationElements('mars', J2000);
  const M2 = mat3Mul(EQ_TO_ECL, mat3Mul(rotZ(e.alpha0 + Math.PI / 2), mat3Mul(rotX(Math.PI / 2 - e.delta0), rotZ(e.W))));
  assert.ok(maxAbsDiff(M, M2) < 1e-15, 'analytic ZXZ product equals the vec.js composition');
  // out param, Float64Array accepted
  const out = new Float64Array(9);
  assert.equal(bodyToEcliptic('mars', J2000, J2000, out), out);
  assert.ok(maxAbsDiff(out, expected) < 2e-6);
  assert.throws(() => bodyToEcliptic('pluto', J2000, J2000), RangeError);
});

test('body→ecliptic matrices are proper rotations for every body across −4000…+4000', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const id of BODY_IDS) {
    for (const jd of EPOCHS) {
      const M = bodyToEcliptic(id, jd, jd);
      assert.ok(maxAbsDiff(mat3Mul(M, mat3T(M)), I) < 1e-13, `${id} @ ${jd}: M·Mᵀ = I to 1e-13`);
      assertClose(det3(M), 1, 1e-13, `${id} @ ${jd}: det = +1`);
      const pole = poleEcliptic(id, jd);
      assert.ok(Math.abs(pole[0] - M[2]) < 1e-15 && Math.abs(pole[1] - M[5]) < 1e-15 && Math.abs(pole[2] - M[8]) < 1e-15, 'pole = column 3');
      const pm = primeMeridianEcliptic(id, jd, jd);
      assert.ok(Math.abs(pm[0] - M[0]) < 1e-15 && Math.abs(pm[1] - M[3]) < 1e-15 && Math.abs(pm[2] - M[6]) < 1e-15, 'prime meridian = column 1');
      assertClose(pole[0] * pm[0] + pole[1] * pm[1] + pole[2] * pm[2], 0, 1e-15, 'prime meridian ⟂ pole');
    }
  }
});

test('north poles in the ecliptic frame at J2000 to 2e-6 (bhqes187e.txt §8 table)', () => {
  const expected = {
    sun: [0.122353, -0.031038, 0.992001],
    mercury: [0.091378, -0.081600, 0.992467],
    venus: [0.018691, 0.010873, 0.999766],
    earth: [0, 0.397777, 0.917482],
    mars: [0.446155, -0.055516, 0.893232],
    jupiter: [-0.014597, -0.035804, 0.999252],
    saturn: [0.085479, 0.462442, 0.882520],
    uranus: [-0.212000, -0.967989, 0.134363],
    neptune: [0.358577, -0.314410, 0.878959],
  };
  for (const id of BODY_IDS) {
    const p = poleEcliptic(id, J2000);
    assert.ok(maxAbsDiff(p, expected[id]) < 2e-6, `${id} pole ${p.map((x) => x.toFixed(6))} vs ${expected[id]} (plan tol 2e-6)`);
    assertClose(norm(p), 1, 1e-14, `${id} pole is a unit vector`);
  }
  // Earth at J2000 is exactly the J2000 north celestial pole in the ecliptic frame: EQ_TO_ECL · ẑ = (0, sin ε, cos ε)
  const ncp = mat3Apply(EQ_TO_ECL, [0, 0, 1]);
  assert.ok(maxAbsDiff(poleEcliptic('earth', J2000), ncp) < 1e-15, 'Earth pole(J2000) = EQ_TO_ECL·ẑ (P(0) = I)');
  // Uranus's pole lies 82.28° from ecliptic north (the IAU north pole is the invariable-plane-north one; not flipped)
  assertClose(Math.acos(poleEcliptic('uranus', J2000)[2]) * RAD, 82.278, 1e-3, 'Uranus pole 82.278° from ecliptic north');
});

test('Earth: matrix form EQ_TO_ECL·P(T)ᵀ·R_z(GMST) equals the IAU-form elements and puts Greenwich at RA = GMST of date', () => {
  for (const jdTT of [J2000, JD_2026_09_13, 2305448.0, 2634167.0]) {
    const jdUT1 = utcFromTt(jdTT);
    const M = bodyToEcliptic('earth', jdTT, jdUT1);
    const e = rotationElements('earth', jdTT, undefined, jdUT1);
    const M2 = mat3Mul(EQ_TO_ECL, mat3Mul(rotZ(e.alpha0 + Math.PI / 2), mat3Mul(rotX(Math.PI / 2 - e.delta0), rotZ(e.W))));
    assert.ok(maxAbsDiff(M, M2) < 1e-12, `Earth IAU-form elements reproduce the GMST+precession matrix @ ${jdTT} (max |Δ| ${maxAbsDiff(M, M2)})`);
    // Greenwich (column 1) carried to the mean equator/equinox of date with P(T) must sit at RA = GMST(UT1) exactly
    const T = (jdTT - J2000) / 36525;
    const pmDate = mat3Apply(precessionMatrix(T), mat3Apply(ECL_TO_EQ, primeMeridianEcliptic('earth', jdTT, jdUT1)));
    const raDate = Math.atan2(pmDate[1], pmDate[0]) * RAD;
    assertClose(wrap180(raDate - gmstDeg(jdUT1)), 0, 1e-9, `Greenwich RA of date = GMST @ ${jdTT} (Pᵀ undone by P)`);
    // and the mean pole of date is column 3
    const poleDate = mat3Apply(precessionMatrix(T), mat3Apply(ECL_TO_EQ, poleEcliptic('earth', jdTT)));
    assert.ok(maxAbsDiff(poleDate, [0, 0, 1]) < 1e-12, `Earth pole = mean pole of date @ ${jdTT}`);
  }
  // J2000, UT1 = 12:00 exactly: Greenwich at RA = GMST(J2000) = 280.46061837° in the J2000 frame (P = I)
  const pm = mat3Apply(ECL_TO_EQ, primeMeridianEcliptic('earth', J2000, J2000));
  assertClose(wrap180(Math.atan2(pm[1], pm[0]) * RAD - 280.46061837), 0, 1e-9, 'Greenwich RA at J2000 = GMST = 280.46061837°');
  // jdUT1 omitted → utcFromTt(jdTT)
  assert.ok(maxAbsDiff(bodyToEcliptic('earth', JD_2026_09_13), bodyToEcliptic('earth', JD_2026_09_13, utcFromTt(JD_2026_09_13))) < 1e-15,
    'bodyToEcliptic(earth) defaults jdUT1 to utcFromTt(jdTT)');
});

// ---------------------------------------------------------------------------------------------------------------------
// Spin rates, periods, obliquities
// ---------------------------------------------------------------------------------------------------------------------

test('Ẇ signs and sidereal rotation periods (360/|Ẇ|) to 1e-5 relative', () => {
  assertClose(spinRateDegPerDay('venus'), -1.4813688, 0, 'Venus Ẇ = −1.4813688 °/d (IAU 2015, retrograde)');
  assertClose(spinRateDegPerDay('uranus'), -501.1600928, 0, 'Uranus Ẇ = −501.1600928 °/d (IAU 2015, retrograde)');
  assertClose(spinRateDegPerDay('earth'), 360.98564736629, 0, 'Earth Ẇ = GMST rate 360.98564736629 °/d');
  for (const id of BODY_IDS) {
    assert.equal(isRetrograde(id), id === 'venus' || id === 'uranus', `${id} retrograde flag`);
    assert.equal(spinRateDegPerDay(id) < 0, isRetrograde(id));
  }
  const days = { mercury: 58.64615, venus: 243.0185, sun: 25.3800 };
  const hours = { mars: 24.622962, jupiter: 9.92492, saturn: 10.65622, uranus: 17.24000, neptune: 15.96630, earth: 23.934470 };
  for (const [id, d] of Object.entries(days)) {
    assert.ok(Math.abs(siderealRotationDays(id) / d - 1) < 1e-5, `${id} sidereal period ${siderealRotationDays(id)} d vs ${d} d (rel 1e-5; bhqes187e.txt §2 derived periods)`);
  }
  for (const [id, h] of Object.entries(hours)) {
    assert.ok(Math.abs(siderealRotationHours(id) / h - 1) < 1e-5, `${id} sidereal period ${siderealRotationHours(id)} h vs ${h} h (rel 1e-5)`);
  }
  assertClose(siderealRotationHours('mercury'), 24 * siderealRotationDays('mercury'), 1e-12);
});

test('obliquity to orbit (pole vs P×V from the ephemeris at J2000) vs NSSDC to 0.05°', () => {
  // NSSDC "obliquity to orbit"; Venus 177.36 and Uranus 97.77 are quoted for the retrograde sense, so with the IAU
  // north pole they become 180 − x (bhqes187e.txt §8 table: 2.638 / 82.230). Sun: pole to ecliptic north 7.25.
  const nssdc = { sun: 7.25, mercury: 0.034, venus: 2.64, earth: 23.44, mars: 25.19, jupiter: 3.13, saturn: 26.73, uranus: 82.23, neptune: 28.32 };
  for (const id of BODY_IDS) {
    const st = eph.state(id, J2000);
    const obl = obliquityToOrbit(id, st, J2000);
    assertClose(obl, nssdc[id], 0.05, `${id} obliquity to orbit (plan tol 0.05°, NSSDC fact sheet)`);
  }
  // jdTT defaults to J2000; array-free (state object) API
  assert.equal(obliquityToOrbit('mars', eph.state('mars', J2000)), obliquityToOrbit('mars', eph.state('mars', J2000), J2000));
  // Mars without its periodic terms would be 23.92° (research §8) — the 25.19° result proves they are included
  assert.ok(Math.abs(obliquityToOrbit('mars', eph.state('mars', J2000)) - 23.92) > 1.0, 'Mars obliquity is not the secular-only 23.92°');
});

// ---------------------------------------------------------------------------------------------------------------------
// Sub-solar point
// ---------------------------------------------------------------------------------------------------------------------

test('Earth sub-solar point vs Horizons-derived fixtures (0.02° lon / 0.01° lat) with the real ephemeris', () => {
  // bhqes187e.txt §9: Horizons apparent RA/Dec of the Sun at Greenwich minus GAST, confirmed by Sun elevation
  // 89.9987–89.9999° at the computed points. Critique byf0bzyiw.txt measured 0.0084/0.0049/0.0050° lon residuals
  // (nutation, DUT1, frame bias neglected); this run: 0.0084/0.0053/0.0054° lon, 0.0002/0.0046/0.0020° lat.
  const fixtures = [
    { jdUtc: 2451545.0, label: '2000-01-01 12:00 UTC', lon: 0.820, lat: -23.033 },
    { jdUtc: 2460000.0, label: '2023-02-24 12:00 UTC', lon: 3.300, lat: -9.457 },
    { jdUtc: JD_2026_09_13, label: '2026-09-13 12:00 UTC', lon: -1.018, lat: 3.676 },
  ];
  for (const f of fixtures) {
    assert.equal(f.jdUtc, jdFromCalendar(...f.label.split(/[- :]/).slice(0, 5).map(Number)), `${f.label} JD label check`);
    const jdTT = ttFromUtc(f.jdUtc);
    const s = subSolarPoint('earth', eph.state('earth', jdTT), jdTT, f.jdUtc);
    assertClose(s.lonDeg, f.lon, 0.02, `${f.label} sub-solar longitude (plan tol 0.02°; Horizons fixture)`);
    assertClose(s.latDeg, f.lat, 0.01, `${f.label} sub-solar latitude (plan tol 0.01°; Horizons fixture)`);
    // Array positions and the out object work the same
    const st = eph.state('earth', jdTT);
    const out = { latDeg: 0, lonDeg: 0 };
    assert.equal(subSolarPoint('earth', [st.x, st.y, st.z], jdTT, f.jdUtc, out), out);
    assertClose(out.lonDeg, s.lonDeg, 1e-12, 'array position ≡ state object');
    // Precession is what makes the 2023/2026 fixtures reachable: without Pᵀ the longitude is 0.30°/0.34° off (critique)
    if (f.jdUtc !== J2000) {
      const Mnp = mat3Mul(EQ_TO_ECL, rotZ(gmstDeg(f.jdUtc) * DEG));
      const u = [-st.x, -st.y, -st.z].map((v) => v / norm([st.x, st.y, st.z]));
      const sNp = mat3Apply(mat3T(Mnp), u);
      const lonNp = Math.atan2(sNp[1], sNp[0]) * RAD;
      assert.ok(Math.abs(wrap180(lonNp - f.lon)) > 0.25, `${f.label}: without the precession term the longitude would be ${Math.abs(wrap180(lonNp - f.lon)).toFixed(3)}° off (> 0.25°)`);
    }
  }
  const sun = subSolarPoint('sun', eph.state('sun', J2000), J2000, J2000);
  assert.ok(Number.isNaN(sun.latDeg) && Number.isNaN(sun.lonDeg), 'the Sun has no sub-solar point (NaN)');
});

test('spin sense: Earth −15.0°/h; Venus & Uranus sub-solar longitude increases, Mars & Jupiter decrease', () => {
  const jdUtc = JD_2026_09_13;
  const jdTT = ttFromUtc(jdUtc);
  const lonAt = (id, dtDays) => subSolarPoint(id, eph.state(id, jdTT + dtDays), jdTT + dtDays, jdUtc + dtDays).lonDeg;
  const dEarth = wrap180(lonAt('earth', 1 / 24) - lonAt('earth', 0));
  assertClose(dEarth, -15.0, 0.05, 'Earth lon(+1 h) − lon = −15.0° (plan tol 0.05°; GMST 15.041°/h minus the Sun\'s 0.04°/h RA motion)');
  // Prograde rotators: the Sun drifts west in body longitude; retrograde Venus/Uranus: it drifts east
  // (Venus solar day 116.75 d: (−Ẇ + n) = 1.4814 + 1.6021 = 3.08 °/d)
  const dVenus = wrap180(lonAt('venus', 1) - lonAt('venus', 0));
  assert.ok(dVenus > 0, `Venus sub-solar longitude increases (+${dVenus.toFixed(3)}°/d)`);
  assertClose(dVenus, 360 / 116.75, 0.03, 'Venus sub-solar longitude rate ≈ 360°/116.75 d (NSSDC length of day)');
  const dUranus = wrap180(lonAt('uranus', 0.01) - lonAt('uranus', 0));
  assert.ok(dUranus > 0, `Uranus sub-solar longitude increases (+${dUranus.toFixed(3)}° per 0.01 d)`);
  assertClose(dUranus, 5.0116, 0.005, 'Uranus 0.01 d: (501.160 + 360/30685.4) × 0.01 = 5.0116°');
  for (const id of ['mercury', 'mars', 'jupiter', 'saturn', 'neptune']) {
    const dt = id === 'mercury' ? 1 : 0.01;
    const d = wrap180(lonAt(id, dt) - lonAt(id, 0));
    assert.ok(d < 0, `${id} sub-solar longitude decreases (${d.toFixed(3)}° per ${dt} d)`);
  }
  assertClose(wrap180(lonAt('mars', 0.01) - lonAt('mars', 0)), -(350.891982 - 360 / 686.98) * 0.01, 0.02, 'Mars ≈ −(Ẇ − n) × 0.01 d');
});

test('Saturn ring-plane crossing seen from Earth within ±1.5 d of 2025-03-23 (independent pole check)', { skip: 'gated by the plan: enable once the published date is confirmed in test/fixtures/README.md (measured here: 2025-03-23 17:25 UTC, +0.73 d)' }, () => {
  // Earth crosses Saturn's equatorial plane when (E − S) · pole_saturn changes sign.
  const f = (jdUtc) => {
    const jdTT = ttFromUtc(jdUtc);
    const E = eph.state('earth', jdTT), S = eph.state('saturn', jdTT), p = poleEcliptic('saturn', jdTT);
    return (E.x - S.x) * p[0] + (E.y - S.y) * p[1] + (E.z - S.z) * p[2];
  };
  let a = jdFromCalendar(2025, 3, 1), b = jdFromCalendar(2025, 4, 15);
  assert.ok(f(a) * f(b) < 0, 'sign change in the window');
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (f(a) * f(m) <= 0) b = m; else a = m; }
  assertClose((a + b) / 2, jdFromCalendar(2025, 3, 23, 12), 1.5, 'ring-plane crossing vs 2025-03-23 (plan tol ±1.5 d)');
});
