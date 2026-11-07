// nutation.js — IAU 1980 nutation (Meeus ch. 22, Table 22.A), obliquity, equation of the equinoxes, GAST, nutation
// matrix. Reference values: Meeus, Astronomical Algorithms 2nd ed., Examples 22.a (1987 April 10, 0h TD) and 12.a
// (1987 April 10, 0h UT), printed to 0.001″ / 0.0001 s; the series' own accuracy is 0.5″ in Δψ and 0.1″ in Δε (p. 144).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLE_22A, nutationArguments, meanObliquityRad, nutation, trueObliquityRad, equationOfEquinoxesRad, gastDeg, gastRad,
  nutationMatrix,
} from '../src/astro/nutation.js';
import { meanObliquityRad as moonMeanObliquityRad } from '../src/astro/moon.js';
import { gmstDeg } from '../src/astro/time.js';
import { mat3Mul, mat3T, mat3Apply, rotX, rotZ } from '../src/astro/vec.js';
import { ARCSEC_PER_RAD, J2000, DAYS_PER_CENTURY, DEG, RAD, EPS76_RAD } from '../src/astro/constants.js';

const JD_22A = 2446895.5; // 1987 April 10, 0h TD
const T_22A = (JD_22A - J2000) / DAYS_PER_CENTURY;

test('Table 22.A has the 63 Meeus terms, the first being the 18.6-year Ω term (−171996 − 174.2T, 92025 + 8.9T)', () => {
  assert.equal(TABLE_22A.length, 63, 'Meeus Table 22.A row count');
  assert.deepEqual([...TABLE_22A[0]], [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9]);
  assert.deepEqual([...TABLE_22A[1]], [-2, 0, 0, 2, 2, -13187, -1.6, 5736, -3.1], 'the semi-annual solar term');
  for (const row of TABLE_22A) {
    assert.equal(row.length, 9);
    for (const v of row) assert.ok(Number.isFinite(v));
    for (let k = 0; k < 5; k++) assert.ok(Number.isInteger(row[k]), 'argument multipliers are integers');
  }
  // Sum of |A| is dominated by the first two terms: 171996 + 13187 = 185183 of ≈ 195 000 total (sanity against a typo of 10×).
  const sumA = TABLE_22A.reduce((s, r) => s + Math.abs(r[5]), 0);
  assert.ok(sumA > 190000 && sumA < 200000, `Σ|A| = ${sumA}`);
  assert.ok(Object.isFrozen(TABLE_22A));
});

test('Example 22.a arguments: T = −0.127296372348, D 136.9623°, M 94.9792°, M′ 229.2784°, F 143.4079°, Ω 11.2531° (to 1e-4°)', () => {
  assert.ok(Math.abs(T_22A - -0.127296372348) < 1e-12, `T = ${T_22A}`);
  const a = nutationArguments(T_22A);
  for (const [k, v] of Object.entries({ D: 136.9623, M: 94.9792, Mp: 229.2784, F: 143.4079, Omega: 11.2531 })) {
    assert.ok(Math.abs(a[k] - v) < 1e-4, `${k} = ${a[k].toFixed(5)}° vs Meeus ${v}° (printed to 1e-4°)`);
    assert.ok(a[k] >= 0 && a[k] < 360, `${k} reduced to [0, 360)`);
  }
  const out = { D: 0, M: 0, Mp: 0, F: 0, Omega: 0 };
  assert.equal(nutationArguments(T_22A, out), out, 'writes into out');
});

test('Example 22.a: Δψ = −3.788″, Δε = +9.443″ (to 0.001″), ε₀ = 23°26′27.407″, ε = 23°26′36.850″ (to 0.001″)', () => {
  const n = nutation(JD_22A);
  assert.ok(Math.abs(n.dpsiArcsec - -3.788) < 0.001, `Δψ = ${n.dpsiArcsec.toFixed(4)}″ vs −3.788″ (Meeus prints 0.001″; measured −3.7879)`);
  assert.ok(Math.abs(n.depsArcsec - 9.443) < 0.001, `Δε = ${n.depsArcsec.toFixed(4)}″ vs +9.443″ (measured 9.4425)`);
  const eps0 = n.meanObliquityRad * ARCSEC_PER_RAD, eps = n.trueObliquityRad * ARCSEC_PER_RAD;
  assert.ok(Math.abs(eps0 - (23 * 3600 + 26 * 60 + 27.407)) < 0.001, `ε₀ = ${eps0.toFixed(4)}″ vs 23°26′27.407″`);
  assert.ok(Math.abs(eps - (23 * 3600 + 26 * 60 + 36.850)) < 0.001, `ε = ${eps.toFixed(4)}″ vs 23°26′36.850″`);
  assert.ok(Math.abs(n.dpsiRad * ARCSEC_PER_RAD - n.dpsiArcsec) < 1e-12 && Math.abs(n.depsRad * ARCSEC_PER_RAD - n.depsArcsec) < 1e-12);
  assert.ok(Math.abs(n.trueObliquityRad - (n.meanObliquityRad + n.depsRad)) < 1e-18, 'ε = ε₀ + Δε');
  assert.ok(Math.abs(n.eqEquinoxRad - n.dpsiRad * Math.cos(n.trueObliquityRad)) < 1e-18, 'equation of the equinoxes = Δψ cos ε');
  assert.equal(trueObliquityRad(JD_22A), n.trueObliquityRad);
  assert.equal(equationOfEquinoxesRad(JD_22A), n.eqEquinoxRad);
  assert.equal(n.jdTT, JD_22A);
});

test('mean obliquity: ε₀(0) = ε76 exactly; agrees with moon.js over 1600–2600 to 1e-18 rad; ≈ 23.44° today', () => {
  assert.equal(meanObliquityRad(0), EPS76_RAD, 'constant term 84381.448″');
  for (const jd of [2305448.0, 2415020.0, 2451545.0, 2460000.5, 2488070.0, 2670691.0]) {
    const T = (jd - J2000) / DAYS_PER_CENTURY;
    assert.ok(Math.abs(meanObliquityRad(T) - moonMeanObliquityRad(T)) < 1e-18, `JD ${jd}: nutation.js and moon.js carry the same Meeus 22.2`);
  }
  const T2026 = (2461297.0 - J2000) / DAYS_PER_CENTURY;
  assert.ok(Math.abs(meanObliquityRad(T2026) * RAD - 23.4361) < 0.0005, `ε₀(2026.7) = ${(meanObliquityRad(T2026) * RAD).toFixed(5)}° (≈ 23.4361°, 46.8″/century below ε76)`);
});

test('nutation is bounded (|Δψ| ≤ 17.3″, |Δε| ≤ 9.3″ over 1900–2100 daily) and memoised on jdTT without changing results', () => {
  let maxPsi = 0, maxEps = 0;
  const out = { jdTT: 0, T: 0, dpsiArcsec: 0, depsArcsec: 0, dpsiRad: 0, depsRad: 0, meanObliquityRad: 0, trueObliquityRad: 0, eqEquinoxRad: 0 };
  for (let jd = 2415020.5; jd < 2488070; jd += 1) {
    const n = nutation(jd, out);
    assert.equal(n, out);
    maxPsi = Math.max(maxPsi, Math.abs(n.dpsiArcsec));
    maxEps = Math.max(maxEps, Math.abs(n.depsArcsec));
  }
  // Amplitudes: Ω term 17.20″ + semi-annual 1.32″ + … ≈ 19″ worst case in Δψ; 9.20″ + 0.57″ + … ≈ 10″ in Δε (Table 22.A).
  assert.ok(maxPsi > 16 && maxPsi < 19.5, `max |Δψ| 1900–2100 = ${maxPsi.toFixed(3)}″ (expected ≈ 17–19″)`);
  assert.ok(maxEps > 8.5 && maxEps < 10.5, `max |Δε| 1900–2100 = ${maxEps.toFixed(3)}″ (expected ≈ 9–10″)`);
  // Memo: evaluate a different instant, then the first again — identical values.
  const a = nutation(JD_22A, {});
  nutation(JD_22A + 100, out);
  const b = nutation(JD_22A, {});
  assert.deepEqual(a, b, 'memoised result equals a fresh evaluation');
});

test('GAST: Example 12.a 1987-04-10 0h UT → GMST 13h10m46.3668s, Δψ cos ε = −0.2317 s, GAST 13h10m46.1351s (to 0.0001 s)', () => {
  const jd = 2446895.5;
  const toSec = (deg) => deg / 15 * 3600;
  assert.ok(Math.abs(toSec(gmstDeg(jd)) - (13 * 3600 + 10 * 60 + 46.3668)) < 0.0001, 'GMST (time.js)');
  const gast = toSec(gastDeg(jd, jd));
  assert.ok(Math.abs(gast - (13 * 3600 + 10 * 60 + 46.1351)) < 0.0001, `GAST = ${gast.toFixed(4)} s of time vs 47446.1351 s (Meeus 12.a)`);
  assert.ok(Math.abs(toSec(gastDeg(jd, jd) - gmstDeg(jd)) - -0.2317) < 0.0001, 'equation of the equinoxes −0.2317 s');
  assert.ok(Math.abs(gastRad(jd, jd) - gastDeg(jd, jd) * DEG) < 1e-15);
  // jdTT defaults to jdUT1: ΔT = 55 s changes Δψ by < 1e-4″ (the 13.66-day term moves 0.1″/day) → GAST by < 1e-7°
  assert.ok(Math.abs(gastDeg(jd) - gastDeg(jd, jd + 55 / 86400)) < 1e-7, 'GAST insensitive to the TT/UT1 choice for the nutation argument');
  const g = gastDeg(2461297.0);
  assert.ok(g >= 0 && g < 360, 'wrapped to [0, 360)');
});

test('nutation matrix = R_x(ε₀+Δε)·R_z(Δψ)·R_x(−ε₀) (vec.js composition, 1e-15), proper rotation, first-order Meeus 23.1 shifts', () => {
  for (const jd of [JD_22A, J2000, 2461297.0, 2305448.0, 2670691.0]) {
    const n = nutation(jd);
    const ref = mat3Mul(rotX(n.trueObliquityRad), mat3Mul(rotZ(n.dpsiRad), rotX(-n.meanObliquityRad)));
    const N = nutationMatrix(jd);
    let md = 0;
    for (let k = 0; k < 9; k++) md = Math.max(md, Math.abs(N[k] - ref[k]));
    assert.ok(md < 1e-15, `JD ${jd}: expanded matrix vs vec.js product, max |Δ| = ${md.toExponential(2)}`);
    const NNt = mat3Mul(N, mat3T(N));
    for (let k = 0; k < 9; k++) assert.ok(Math.abs(NNt[k] - (k % 4 === 0 ? 1 : 0)) < 1e-15, `JD ${jd}: N·Nᵀ = I`);
    // Vernal equinox direction: Δα = Δψ cos ε, Δδ = Δψ sin ε (Meeus 23.1 with α = δ = 0); α = 90°, δ = 0: Δδ = Δε.
    // Meeus 23.1 is first order; the exact rotation differs by second-order terms ≤ Δψ²/2 ≈ 9e-4″ (|Δψ| ≤ 19″).
    const x = mat3Apply(N, [1, 0, 0]);
    const dRa = Math.atan2(x[1], x[0]) * ARCSEC_PER_RAD, dDec = Math.asin(x[2]) * ARCSEC_PER_RAD;
    assert.ok(Math.abs(dRa - n.dpsiArcsec * Math.cos(n.trueObliquityRad)) < 2e-3, `JD ${jd}: Δα(equinox) = ${dRa.toFixed(6)}″ vs Δψ cos ε (first order, 2e-3″)`);
    assert.ok(Math.abs(dDec - n.dpsiArcsec * Math.sin(n.trueObliquityRad)) < 2e-3, `JD ${jd}: Δδ(equinox) = Δψ sin ε (first order, 2e-3″)`);
    const y = mat3Apply(N, [0, 1, 0]);
    assert.ok(Math.abs(Math.asin(y[2]) * ARCSEC_PER_RAD - n.depsArcsec) < 2e-3, `JD ${jd}: Δδ(α = 90°) = Δε (first order, 2e-3″; measured 1.3e-5″)`);
  }
  const out = new Float64Array(9);
  assert.equal(nutationMatrix(JD_22A, out), out, 'writes into out');
});
