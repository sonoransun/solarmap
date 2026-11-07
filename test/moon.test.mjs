// moon.js (Meeus ch. 47 abridged ELP-2000/82, rotated of-date → scene frame) vs JPL Horizons DE441 — fixture
// test/fixtures/horizons/moon.json (scripts/fetch-moon.mjs: GEOCENTRIC Moon, "Ecliptic of J2000.0", geometric, km and
// km/s, JD(TT)): 53 epochs 1600–2600, a 3-day grid 2024–2027 (487 rows) and 7 greatest-eclipse instants.
//
// Tolerance rule (as test/horizons.test.mjs): hard ceilings from the task brief (20″, 50 km — a transcription error of
// any table term above ≈ 5 units breaks them; 1e-6 AU/d for the velocity), plus committed per-set tolerances =
// 1.3 × the measured maximum rounded UP to a clean number, enforced programmatically at the end of the file so that a
// regenerated fixture or an edited table that erodes the margin fails loudly. Measured 2026-11-06 (this file's first
// run; fixture: Horizons API 1.2, DE441, fetchedAt 2026-11-07T04:49:56Z):
//   epochs   (53)  max |Δr| 13.08 km (2023-Feb-25)  max angle  5.747″ (1975-Jan-01)  max |Δv| 4.492e-8 AU/d (2500)
//   grid    (487)  max |Δr| 18.55 km (2025-Apr-25)  max angle 10.402″ (2025-Apr-25)  max |Δv| 7.793e-8 AU/d (2025-Nov-09)
//   eclipses  (7)  max |Δr|  9.90 km (2026-Aug-12)  max angle  4.986″ (2026-Aug-12)  max |Δv| 2.517e-8 AU/d (2025-Mar-14)
// Grid means: Δλ −0.85″, Δβ −0.01″, Δr +0.46 km; rms angle 2.83″ (Meeus p. 342 quotes ≈ 10″ in λ, 4″ in β).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MOON, moonMeeus, moonGeocentricOfDate, moonPositionKm, moonPosition, moonState, moonIllumination,
  moonAngularDiameterDeg, horizontalParallaxDeg, meanObliquityRad, ofDateToSceneMatrix, eclipticOfDateToScene,
} from '../src/astro/moon.js';
import { angleBetween, mat3Mul, mat3T, rotX, norm } from '../src/astro/vec.js';
import { EQ_TO_ECL, precessionMatrix } from '../src/astro/frames.js';
import { AU_KM, ARCSEC_PER_RAD, DAY_S, J2000, DAYS_PER_CENTURY, DEG, RAD, EPS76_RAD } from '../src/astro/constants.js';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';

/** @typedef {{jdTT:number, calendar:string, x:number, y:number, z:number, vx:number, vy:number, vz:number, label?:string}} Row */
/** @type {{frame:string, units:string, timeType:string, apiVersion:string, source:string, epochs:Row[], grid:Row[], eclipses:Row[]}} */
const FX = JSON.parse(readFileSync(new URL('./fixtures/horizons/moon.json', import.meta.url), 'utf8'));
const SETS = /** @type {const} */ (['epochs', 'grid', 'eclipses']);
const SET_COUNT = { epochs: 53, grid: 487, eclipses: 7 };
const KMS_TO_AU_D = DAY_S / AU_KM; // km/s → AU/day

// ---------------------------------------------------------------------------------------------------------------------
// Hard ceilings (task brief) and committed per-set tolerances (1.3 × measured, rounded up; see header)
// ---------------------------------------------------------------------------------------------------------------------
const CEIL_ARCSEC = 20;
const CEIL_KM = 50;
const CEIL_VEL_AU_D = 1e-6;
/** Angular residual atan2(|m×h|, m·h) in arcseconds. */
const ANG_TOL_ARCSEC = { epochs: 7.5, grid: 14, eclipses: 6.5 };      // measured 5.747 / 10.402 / 4.986
/** Position |Δr| in km. */
const POS_TOL_KM = { epochs: 18, grid: 25, eclipses: 13 };            // measured 13.08 / 18.55 / 9.90
/** Velocity |Δv| in AU/day (central difference h = 0.005 d vs Horizons km/s). 1e-8 AU/d ≈ 17 mm/s. */
const VEL_TOL_AU_D = { epochs: 6e-8, grid: 1.1e-7, eclipses: 3.5e-8 }; // measured 4.492e-8 / 7.793e-8 / 2.517e-8

/** Residual of the Meeus Moon against one Horizons row (scene frame; km, arcsec, AU/day). */
function residual(row) {
  const p = moonPositionKm(row.jdTT);
  const s = moonState(row.jdTT);
  return {
    km: Math.hypot(p[0] - row.x, p[1] - row.y, p[2] - row.z),
    arcsec: angleBetween(p, [row.x, row.y, row.z]) * ARCSEC_PER_RAD,
    auDay: Math.hypot(s.vx - row.vx * KMS_TO_AU_D, s.vy - row.vy * KMS_TO_AU_D, s.vz - row.vz * KMS_TO_AU_D),
  };
}

/** All residuals, computed once: RES[set] = [{row, km, arcsec, auDay}] */
const RES = {};
for (const set of SETS) RES[set] = FX[set].map((row) => ({ row, ...residual(row) }));

const eph = createEphemeris(SERIES, { meta: META });

// ---------------------------------------------------------------------------------------------------------------------
// Meeus Example 47.a — 1992 April 12 0h TD (JD 2448724.5), pp. 342–343
// ---------------------------------------------------------------------------------------------------------------------
test('Example 47.a: arguments to 1e-6°, sums to ±1 unit, λ/β to 1e-6°, Δ to 0.1 km, π to 1e-6°', () => {
  const m = moonMeeus(2448724.5);
  assert.ok(Math.abs(m.T - -0.077221081451) < 1e-12, `T = ${m.T} (Meeus −0.077221081451)`);
  const args = { Lp: 134.290182, D: 113.842304, M: 97.643514, Mp: 5.150833, F: 219.889721 };
  for (const [k, v] of Object.entries(args)) {
    assert.ok(Math.abs(m[k] - v) < 1e-6, `${k} = ${m[k].toFixed(7)}° vs Meeus ${v}° (printed to 1e-6°)`);
  }
  for (const [k, v] of Object.entries({ A1: 109.57, A2: 123.78, A3: 229.53 })) {
    assert.ok(Math.abs(m[k] - v) < 0.005, `${k} = ${m[k].toFixed(3)}° vs Meeus ${v}° (printed to 0.01°)`);
  }
  assert.ok(Math.abs(m.E - 1.000194) < 1e-6, `E = ${m.E} vs 1.000194`);
  assert.ok(Math.abs(m.sumL - -1127527) <= 1, `Σl = ${m.sumL.toFixed(3)} vs −1127527 (±1 unit of 1e-6°; measured −0.034)`);
  assert.ok(Math.abs(m.sumB - -3229126) <= 1, `Σb = ${m.sumB.toFixed(3)} vs −3229126 (±1 unit; measured −0.419)`);
  assert.ok(Math.abs(m.sumR - -16590875) <= 1, `Σr = ${m.sumR.toFixed(3)} vs −16590875 (±1 unit of 1e-3 km; measured −0.184)`);
  assert.ok(Math.abs(m.lonDeg - 133.162655) < 1e-6, `λ (mean equinox of date) = ${m.lonDeg.toFixed(7)}° vs 133.162655° (apparent 133.167265° = mean + Δψ 16.595″, not added here)`);
  assert.ok(Math.abs(m.latDeg - -3.229126) < 1e-6, `β = ${m.latDeg.toFixed(7)}° vs −3.229126°`);
  assert.ok(Math.abs(m.distKm - 368409.7) < 0.1, `Δ = ${m.distKm.toFixed(3)} km vs 368409.7 km`);
  const g = moonGeocentricOfDate(2448724.5);
  assert.equal(g.lonDeg, m.lonDeg);
  assert.equal(g.distKm, m.distKm);
  assert.ok(Math.abs(g.parallaxDeg - 0.991990) < 1e-6, `π = ${g.parallaxDeg.toFixed(7)}° vs 0.991990° (sin π = 6378.14/Δ)`);
  assert.equal(horizontalParallaxDeg(m.distKm), g.parallaxDeg);
});

test('argument polynomials: L′ − D = mean longitude of the Sun (280.4665°, Meeus 25.2) and L′ − F = mean node Ω (125.0446°, Meeus 22) at J2000', () => {
  const m = moonMeeus(J2000);
  // L′ − D = 218.3164477 − 297.8501921 + 360 = 280.4662556 ≈ Meeus 25.2 L₀ 280.46646° (ELP vs VSOP constants, 0.7″)
  assert.ok(Math.abs(m.Lp - m.D + 360 - 280.46646) < 0.001, `L′ − D = ${(m.Lp - m.D + 360).toFixed(5)}°`);
  // L′ − F = 218.3164477 − 93.2720950 = 125.0443527 ≈ Ω 125.04452° (Meeus ch. 22 nutation arguments)
  assert.ok(Math.abs(m.Lp - m.F - 125.04452) < 0.001, `L′ − F = ${(m.Lp - m.F).toFixed(5)}°`);
  assert.equal(m.E, 1, 'E(0) = 1');
});

// ---------------------------------------------------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------------------------------------------------
test('fixture: geocentric Moon, DE441, Ecliptic of J2000.0, km & km/s, TT; 53 + 487 + 7 rows sorted by jdTT', () => {
  assert.match(FX.frame, /^Ecliptic of J2000\.0/);
  assert.match(FX.frame, /geocentric, geometric \(VEC_CORR=NONE\)/);
  assert.equal(FX.units, 'km, km/s');
  assert.equal(FX.timeType, 'TT');
  assert.equal(FX.apiVersion, '1.2');
  assert.match(FX.source, /DE441/);
  for (const set of SETS) {
    const rows = FX[set];
    assert.equal(rows.length, SET_COUNT[set], `${set}: row count`);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > 0 && set !== 'eclipses') assert.ok(r.jdTT > rows[i - 1].jdTT, `${set}: rows sorted by jdTT`); // eclipses keep the label order of fetch-moon.mjs
      for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) assert.ok(Number.isFinite(r[k]), `${set} ${r.calendar}: finite ${k}`);
      const d = Math.hypot(r.x, r.y, r.z);
      assert.ok(d > 356000 && d < 407000, `${set} ${r.calendar}: geocentric distance ${d.toFixed(0)} km within the perigee–apogee range (NSSDC 363,300–405,500 km ± libration)`);
    }
  }
  assert.equal(FX.epochs[0].jdTT, 2305448.0, 'first epoch 1600-01-01 12:00 TT');
  assert.equal(FX.epochs[52].jdTT, 2670691.0, 'last epoch 2600-01-01 12:00 TT');
  assert.ok(FX.epochs.some((r) => r.jdTT === J2000), 'J2000 epoch present');
  assert.equal(FX.grid[0].jdTT, 2460310.5, 'grid starts 2024-01-01 00:00 TT');
  for (let i = 1; i < FX.grid.length; i++) assert.ok(Math.abs(FX.grid[i].jdTT - FX.grid[i - 1].jdTT - 3) < 1e-9, 'grid step 3 d');
  assert.deepEqual(FX.eclipses.map((e) => e.label),
    ['solar-2017-08-21', 'solar-2019-07-02', 'solar-2024-04-08', 'solar-2026-08-12', 'lunar-2022-11-08', 'lunar-2025-03-14', 'lunar-2025-09-07']);
  // J2000 probe row recorded in scripts/fetch-moon.mjs
  const r0 = FX.epochs.find((r) => r.jdTT === J2000);
  assert.ok(Math.abs(r0.x + 291608.3842345213) < 1e-6 && Math.abs(r0.y + 274979.7416199811) < 1e-6 && Math.abs(r0.z - 36271.19662782984) < 1e-6,
    'J2000 row equals the probe value recorded in scripts/fetch-moon.mjs to 1e-6 km');
});

// ---------------------------------------------------------------------------------------------------------------------
// Residuals per set
// ---------------------------------------------------------------------------------------------------------------------
for (const set of SETS) {
  test(`${set}: angle ≤ ${CEIL_ARCSEC}″ / ${ANG_TOL_ARCSEC[set]}″, |Δr| ≤ ${CEIL_KM} km / ${POS_TOL_KM[set]} km, |Δv| ≤ ${CEIL_VEL_AU_D} / ${VEL_TOL_AU_D[set]} AU/d at all ${SET_COUNT[set]} rows`, (t) => {
    let maxA = 0, maxK = 0, maxV = 0, rowA, rowK, rowV;
    for (const r of RES[set]) {
      const where = `${set} ${r.row.calendar} (JD ${r.row.jdTT})`;
      assert.ok(r.arcsec <= CEIL_ARCSEC, `${where}: angle ${r.arcsec.toFixed(3)}″ > ${CEIL_ARCSEC}″ hard ceiling (task brief; Meeus p. 342 ≈ 10″ — a table term wrong by > 5 units)`);
      assert.ok(r.km <= CEIL_KM, `${where}: |Δr| ${r.km.toFixed(2)} km > ${CEIL_KM} km hard ceiling (task brief)`);
      assert.ok(r.auDay <= CEIL_VEL_AU_D, `${where}: |Δv| ${r.auDay.toExponential(3)} AU/d > ${CEIL_VEL_AU_D} AU/d hard ceiling (task brief)`);
      assert.ok(r.arcsec <= ANG_TOL_ARCSEC[set], `${where}: angle ${r.arcsec.toFixed(3)}″ > ${ANG_TOL_ARCSEC[set]}″ (1.3 × measured maximum, header table)`);
      assert.ok(r.km <= POS_TOL_KM[set], `${where}: |Δr| ${r.km.toFixed(2)} km > ${POS_TOL_KM[set]} km (1.3 × measured maximum, header table)`);
      assert.ok(r.auDay <= VEL_TOL_AU_D[set], `${where}: |Δv| ${r.auDay.toExponential(3)} AU/d > ${VEL_TOL_AU_D[set]} AU/d (1.3 × measured maximum, header table)`);
      if (r.arcsec > maxA) { maxA = r.arcsec; rowA = r.row; }
      if (r.km > maxK) { maxK = r.km; rowK = r.row; }
      if (r.auDay > maxV) { maxV = r.auDay; rowV = r.row; }
    }
    t.diagnostic(`${set} (${RES[set].length}) max angle ${maxA.toFixed(3)}″ (${rowA.calendar}), max |Δr| ${maxK.toFixed(2)} km (${rowK.calendar}), max |Δv| ${maxV.toExponential(3)} AU/d (${rowV.calendar})`);
  });
}

test('every committed tolerance is ≥ 1.3 × the measured maximum of its set (margin rule) and ≤ the hard ceiling', () => {
  for (const set of SETS) {
    let maxA = 0, maxK = 0, maxV = 0;
    for (const r of RES[set]) {
      if (r.arcsec > maxA) maxA = r.arcsec;
      if (r.km > maxK) maxK = r.km;
      if (r.auDay > maxV) maxV = r.auDay;
    }
    assert.ok(ANG_TOL_ARCSEC[set] >= 1.3 * maxA, `${set}: angular tolerance ${ANG_TOL_ARCSEC[set]}″ < 1.3 × measured ${maxA.toFixed(3)}″ — widen the table and the header`);
    assert.ok(POS_TOL_KM[set] >= 1.3 * maxK, `${set}: position tolerance ${POS_TOL_KM[set]} km < 1.3 × measured ${maxK.toFixed(2)} km`);
    assert.ok(VEL_TOL_AU_D[set] >= 1.3 * maxV, `${set}: velocity tolerance ${VEL_TOL_AU_D[set]} AU/d < 1.3 × measured ${maxV.toExponential(3)} AU/d`);
    assert.ok(ANG_TOL_ARCSEC[set] <= CEIL_ARCSEC && POS_TOL_KM[set] <= CEIL_KM && VEL_TOL_AU_D[set] <= CEIL_VEL_AU_D, `${set}: committed tolerances stay under the hard ceilings`);
  }
});

test('the of-date → J2000 rotation is what makes the agreement possible: the unrotated of-date vector is > 100× further from Horizons', () => {
  // Guards against a silently dropped precession/obliquity chain (≈ 0.35° of precession in 2025 ≈ 1300″).
  const row = FX.eclipses.find((e) => e.label === 'lunar-2025-03-14');
  const g = moonGeocentricOfDate(row.jdTT);
  const lam = g.lonDeg * DEG, bet = g.latDeg * DEG;
  const raw = [g.distKm * Math.cos(bet) * Math.cos(lam), g.distKm * Math.cos(bet) * Math.sin(lam), g.distKm * Math.sin(bet)];
  const rawArc = angleBetween(raw, [row.x, row.y, row.z]) * ARCSEC_PER_RAD;
  const rotArc = RES.eclipses.find((r) => r.row === row).arcsec;
  assert.ok(rawArc > 100 * rotArc && rawArc > 1000, `unrotated ${rawArc.toFixed(0)}″ vs rotated ${rotArc.toFixed(2)}″`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Frame chain: ecliptic of date → mean equator of date (ε₀) → J2000 equator (Pᵀ) → ecliptic J2000 (EQ_TO_ECL)
// ---------------------------------------------------------------------------------------------------------------------
test('at J2000.0 (T = 0) the chain is the identity: (λ = 0, β = 0) → scene +x exactly, (β = 90°) → +z', () => {
  const x = eclipticOfDateToScene(0, 0, 1, J2000);
  assert.ok(Math.hypot(x[0] - 1, x[1], x[2]) <= 1e-12, `(0°, 0°) at T = 0 → (${x}) vs (1, 0, 0); P(0) = I and ε₀(0) = ε76 so R_x(−ε76)·R_x(ε76) = I (task brief ≤ 1e-12)`);
  const z = eclipticOfDateToScene(0, 90, 1, J2000);
  assert.ok(Math.hypot(z[0], z[1], z[2] - 1) <= 1e-12, `north ecliptic pole at T = 0 → (${z}) vs (0, 0, 1)`);
  assert.ok(Math.abs(meanObliquityRad(0) - EPS76_RAD) < 1e-18, 'ε₀(0) = ε76 = 84381.448″ (Meeus 22.2 constant term 23°26′21.448″)');
  const M = ofDateToSceneMatrix(J2000);
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(M[k] - (k % 4 === 0 ? 1 : 0)) <= 1e-15, `M(J2000)[${k}] identity to 1e-15`);
});

test('ofDateToSceneMatrix(jdTT) = EQ_TO_ECL · P(T)ᵀ · R_x(ε₀(T)) built from frames.js/vec.js, orthonormal, to 1e-15 over 1600–2600', () => {
  for (const jd of [2305448.0, 2378497.0, 2451545.0, 2460000.5, 2460748.790775463, 2561000.0, 2670691.0]) {
    const T = (jd - J2000) / DAYS_PER_CENTURY;
    const ref = mat3Mul(EQ_TO_ECL, mat3Mul(mat3T(precessionMatrix(T)), rotX(meanObliquityRad(T))));
    const M = ofDateToSceneMatrix(jd);
    let md = 0;
    for (let k = 0; k < 9; k++) md = Math.max(md, Math.abs(ref[k] - M[k]));
    assert.ok(md <= 1e-15, `JD ${jd}: max |M − reference| = ${md.toExponential(2)} (allocation-free ZYZ expansion vs frames.precessionMatrix)`);
    const MMt = mat3Mul(M, mat3T(M));
    for (let k = 0; k < 9; k++) assert.ok(Math.abs(MMt[k] - (k % 4 === 0 ? 1 : 0)) < 1e-14, `JD ${jd}: M·Mᵀ = I to 1e-14`);
  }
});

test('mean obliquity of date: Meeus Example 22.a 1987-04-10 0h TD → ε₀ = 23°26′27.407″', () => {
  const T = (2446895.5 - J2000) / DAYS_PER_CENTURY;
  const eps = meanObliquityRad(T) * ARCSEC_PER_RAD;
  const want = 23 * 3600 + 26 * 60 + 27.407;
  assert.ok(Math.abs(eps - want) < 0.001, `ε₀ = ${eps.toFixed(4)}″ vs ${want}″ (Meeus 22.a, 1e-3″)`);
});

test('north ecliptic pole of date vs J2000 pole: tilt = π_A = 47.0029″T − 0.03302″T² + 0.000060″T³ (Meeus 21.5 with T₀ = 0) to 0.05″', () => {
  // A wrong sign of R_x(ε₀) would give 2ε ≈ 47°; a dropped precession would give ≈ 0 instead of π_A.
  for (const jd of [2305448.0, 2378497.0, 2415020.0, 2460000.5, 2488070.0, 2561000.0, 2670691.0]) {
    const T = (jd - J2000) / DAYS_PER_CENTURY;
    const pole = eclipticOfDateToScene(0, 90, 1, jd);
    const tilt = angleBetween(pole, [0, 0, 1]) * ARCSEC_PER_RAD;
    const piA = Math.abs(47.0029 * T - 0.03302 * T * T + 0.000060 * T * T * T);
    assert.ok(Math.abs(tilt - piA) < 0.05, `JD ${jd} (T = ${T.toFixed(2)}): ecliptic-pole tilt ${tilt.toFixed(4)}″ vs π_A ${piA.toFixed(4)}″ (IAU 1976 ecliptic precession; both from Lieske et al. 1977)`);
  }
});

test('equinox of date in the J2000 ecliptic sits at longitude −p_A (general precession 5029.0966″T + 1.11113″T², Meeus 21.6) to 0.05″ for |T| ≤ 1', () => {
  for (const jd of [2415020.0, 2433282.5, 2460000.5, 2488070.0]) {
    const T = (jd - J2000) / DAYS_PER_CENTURY;
    const e = eclipticOfDateToScene(0, 0, 1, jd);
    const lon = Math.atan2(e[1], e[0]) * ARCSEC_PER_RAD;
    const pA = 5029.0966 * T + 1.11113 * T * T - 0.000006 * T * T * T;
    assert.ok(Math.abs(lon + pA) < 0.05, `JD ${jd}: of-date equinox at J2000 longitude ${lon.toFixed(4)}″ vs −p_A = ${(-pA).toFixed(4)}″ (second-order ecliptic-tilt terms ≤ 0.01″ for |T| ≤ 1)`);
    assert.ok(Math.abs(e[2]) < 1e-3, `JD ${jd}: of-date equinox lies within 0.001 of the J2000 ecliptic plane (z = ${e[2].toExponential(2)})`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// API consistency
// ---------------------------------------------------------------------------------------------------------------------
test('moonPosition = moonPositionKm / AU_KM, moonState position = moonPosition, `out` objects are reused', () => {
  const jd = 2460748.790775463;
  const km = moonPositionKm(jd);
  const au = moonPosition(jd);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(au[k] * AU_KM - km[k]) < 1e-6, `component ${k}: ${au[k] * AU_KM} km vs ${km[k]} km`);
  const s = moonState(jd);
  assert.ok(Math.abs(s.x - au[0]) < 1e-18 && Math.abs(s.y - au[1]) < 1e-18 && Math.abs(s.z - au[2]) < 1e-18, 'state position equals moonPosition');
  const d = norm(au) * AU_KM;
  assert.ok(Math.abs(d - moonGeocentricOfDate(jd).distKm) < 1e-6, 'rotation preserves the distance');
  const outV = [0, 0, 0];
  assert.equal(moonPosition(jd, outV), outV, 'moonPosition writes into out');
  const outS = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  assert.equal(moonState(jd, outS), outS, 'moonState writes into out');
  const outM = new Array(9);
  assert.equal(ofDateToSceneMatrix(jd, outM), outM, 'ofDateToSceneMatrix writes into out');
  const outG = { lonDeg: 0, latDeg: 0, distKm: 0, parallaxDeg: 0 };
  assert.equal(moonGeocentricOfDate(jd, outG), outG, 'moonGeocentricOfDate writes into out');
});

test('velocity: central difference agrees with (r(t+1 d) − r(t)) over the day to the 1 % the curvature allows, and |v| ≈ 1.0 km/s', () => {
  const jd = 2460310.5;
  const s = moonState(jd);
  const v = Math.hypot(s.vx, s.vy, s.vz) * AU_KM / DAY_S;
  assert.ok(v > 0.95 && v < 1.1, `|v| = ${v.toFixed(4)} km/s (mean orbital speed 1.022 km/s, NSSDC)`);
  const a = moonPosition(jd), b = moonPosition(jd + 1);
  const chord = [(b[0] - a[0]), (b[1] - a[1]), (b[2] - a[2])];
  const ang = angleBetween(chord, [s.vx, s.vy, s.vz]) * RAD;
  assert.ok(ang < 7 && ang > 5, `angle between the 1-day chord and the instantaneous velocity = ${ang.toFixed(2)}° (≈ half the daily motion 13.2°/2 = 6.6°)`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Illumination (Meeus ch. 48) at the eclipse instants
// ---------------------------------------------------------------------------------------------------------------------
function sunGeo(jdTT) {
  const e = eph.state('earth', jdTT);
  return [-e.x, -e.y, -e.z];
}

test('full Moon at the 2025-03-14 total lunar eclipse: k > 0.995, Moon within 1.5° of the anti-Sun direction', () => {
  const row = FX.eclipses.find((e) => e.label === 'lunar-2025-03-14');
  const moon = moonPosition(row.jdTT);
  const sun = sunGeo(row.jdTT);
  const il = moonIllumination(moon, sun);
  assert.ok(il.illuminatedFraction > 0.995, `k = ${il.illuminatedFraction.toFixed(6)} (task brief > 0.995; measured 0.999992)`);
  const anti = angleBetween(moon, [-sun[0], -sun[1], -sun[2]]) * RAD;
  assert.ok(anti < 1.5, `Moon ${anti.toFixed(4)}° from the anti-Sun direction (task brief < 1.5°; measured 0.317°)`);
  assert.ok(il.elongationDeg > 178.5 && il.phaseAngleDeg < 1.5, `elongation ${il.elongationDeg.toFixed(3)}°, phase angle ${il.phaseAngleDeg.toFixed(3)}°`);
  // the ephemeris State object form is accepted too
  const il2 = moonIllumination(moonState(row.jdTT), { x: sun[0], y: sun[1], z: sun[2] });
  assert.ok(Math.abs(il2.illuminatedFraction - il.illuminatedFraction) < 1e-15, 'object-form arguments give the same result');
});

test('new Moon at the 2024-04-08 total solar eclipse: k < 0.005, Moon within 1° of the Sun direction', () => {
  const row = FX.eclipses.find((e) => e.label === 'solar-2024-04-08');
  const moon = moonPosition(row.jdTT);
  const sun = sunGeo(row.jdTT);
  const il = moonIllumination(moon, sun);
  assert.ok(il.illuminatedFraction < 0.005, `k = ${il.illuminatedFraction.toExponential(3)} (task brief < 0.005; measured 9.3e-6)`);
  assert.ok(il.elongationDeg < 1, `Moon ${il.elongationDeg.toFixed(4)}° from the Sun (task brief < 1°; measured 0.349°)`);
  assert.ok(il.phaseAngleDeg > 179, `phase angle ${il.phaseAngleDeg.toFixed(3)}°`);
});

test('all 7 greatest-eclipse instants: Moon within 1.5° of the Sun (solar) or anti-Sun (lunar) direction, k < 0.01 / > 0.99', () => {
  for (const row of FX.eclipses) {
    const moon = moonPosition(row.jdTT);
    const sun = sunGeo(row.jdTT);
    const il = moonIllumination(moon, sun);
    if (row.label.startsWith('solar')) {
      assert.ok(il.elongationDeg < 1.5 && il.illuminatedFraction < 0.01, `${row.label}: elongation ${il.elongationDeg.toFixed(3)}°, k ${il.illuminatedFraction.toExponential(2)} (geocentric elongation at greatest eclipse ≤ γ · π_moon ≈ 0.9° for 2026-08-12, γ = 0.898)`);
    } else {
      assert.ok(180 - il.elongationDeg < 1.5 && il.illuminatedFraction > 0.99, `${row.label}: 180° − elongation ${(180 - il.elongationDeg).toFixed(3)}°, k ${il.illuminatedFraction.toFixed(5)}`);
    }
  }
});

test('illumination geometry: quadrature gives k ≈ 0.5 (slightly more, Meeus ch. 48), opposition k = 1, conjunction k = 0', () => {
  const d = MOON.meanDistanceKm / AU_KM;
  const q = moonIllumination([d, 0, 0], [0, 1, 0]);
  assert.ok(Math.abs(q.elongationDeg - 90) < 1e-9, 'elongation 90°');
  assert.ok(q.phaseAngleDeg < 90 && q.phaseAngleDeg > 89.8, `phase angle ${q.phaseAngleDeg.toFixed(4)}° = 90° − atan(Δ/R) ≈ 89.853°`);
  assert.ok(q.illuminatedFraction > 0.5 && q.illuminatedFraction < 0.502, `k = ${q.illuminatedFraction.toFixed(5)} (0.5 + Δ/(2R) ≈ 0.50129)`);
  assert.ok(Math.abs(moonIllumination([-d, 0, 0], [1, 0, 0]).illuminatedFraction - 1) < 1e-15, 'opposition k = 1');
  assert.ok(Math.abs(moonIllumination([d, 0, 0], [1, 0, 0]).illuminatedFraction) < 1e-15, 'conjunction k = 0');
});

// ---------------------------------------------------------------------------------------------------------------------
// Constants and scalar helpers
// ---------------------------------------------------------------------------------------------------------------------
test('MOON constants: sidereal and synodic months follow from the Meeus 47.1/47.2 rates and the IAU 1976 general precession', () => {
  assert.equal(MOON.radiusKm, 1737.4, 'IAU 2015 / NSSDC mean radius');
  assert.equal(MOON.meanDistanceKm, 385000.56, 'Meeus 47 distance constant');
  const sidereal = DAYS_PER_CENTURY * 360 / (481267.88123421 - 5029.0966 / 3600);
  assert.ok(Math.abs(sidereal - MOON.siderealMonthDays) < 1e-6, `sidereal month ${sidereal.toFixed(7)} d vs ${MOON.siderealMonthDays} (1e-6 d)`);
  const synodic = DAYS_PER_CENTURY * 360 / 445267.1114034;
  assert.ok(Math.abs(synodic - MOON.synodicMonthDays) < 1e-6, `synodic month ${synodic.toFixed(7)} d vs ${MOON.synodicMonthDays} (1e-6 d; Meeus 49.1: 29.530588861)`);
  assert.ok(Object.isFrozen(MOON));
});

test('angular diameter 2·asin(R/Δ): 31.03′ at the mean distance, within 1″ of Meeus ch. 55 (k = 0.272481: 2 × 358473400″/Δ)', () => {
  const d = moonAngularDiameterDeg(MOON.meanDistanceKm) * 3600;
  const meeus55 = 2 * 358473400 / MOON.meanDistanceKm;
  assert.ok(Math.abs(d - meeus55) < 1, `${d.toFixed(2)}″ vs ${meeus55.toFixed(2)}″ (the 0.5″ difference is k's implied 1737.9 km radius vs 1737.4 km)`);
  assert.ok(Math.abs(d / 60 - 31.03) < 0.01, `${(d / 60).toFixed(3)}′ ≈ 31.03′`);
  // Example 47.a distance: parallax 0.991990° ↔ diameter 2·asin(1737.4/368409.7)
  assert.ok(Math.abs(moonAngularDiameterDeg(368409.7) - 2 * Math.asin(1737.4 / 368409.7) * RAD) < 1e-15);
  let min = Infinity, max = 0;
  for (const row of FX.grid) {
    const dd = moonAngularDiameterDeg(Math.hypot(row.x, row.y, row.z)) * 60;
    if (dd < min) min = dd;
    if (dd > max) max = dd;
  }
  assert.ok(min > 29.3 && max < 33.6, `2024–2027 grid diameters ${min.toFixed(2)}′ – ${max.toFixed(2)}′ (geocentric; NSSDC apogee 405,500 km → 29.4′, perigee 363,300 km → 32.9′, extreme perigees 356,400 km → 33.5′)`);
});
