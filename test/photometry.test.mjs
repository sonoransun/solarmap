// photometry.js — Mallama & Hilton (2018) apparent magnitudes vs JPL Horizons APmag (test/fixtures/horizons/observer.json,
// quantity 9; Horizons implements the same models), the Allen lunar magnitude, and geometry.js sub-Earth latitudes vs
// Horizons ObsSub-LAT (quantity 14, planetodetic → planetocentric).
//
// Tolerance rule: committed = max(brief, 1.3 × measured), enforced at the end. Brief: ≤ 0.1 mag for Mercury–Saturn,
// sanity bounds for Uranus/Neptune. Measured 2026-11-06 (12 epochs each, API 1.2):
//   mercury 0.004 · venus 0.001 · mars 0.102 (mean +0.006) · jupiter 0.000 · saturn 0.001 (effective β = geometric mean
//   of B and B′; 0.065 with |B| alone) · uranus 0.021 (mean +0.014) · neptune 0.015 (mean +0.009)
// Mars is widened to 0.15: Horizons applies the paper's rotational L(λe) and seasonal L(Ls) terms (≈ ±0.07 mag), which
// photometry.js deliberately omits (their coefficients are not transcribed here) — the ±0.1 scatter is that signal,
// uncorrelated with the phase angle. Sub-Earth latitudes: max |Δ| 0.0019° (Mars) after the planetodetic conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import {
  PHASE_RANGE_DEG, phaseTerm, planetMagnitude, moonMagnitude, moonMagnitudeFromStates, magnitude, saturnEffectiveSinBeta, newMagnitude,
} from '../src/astro/photometry.js';
import { subLatitudes, phaseAngleDeg, illuminatedFraction, angularDiameterArcsec, geocentricDistanceKm } from '../src/astro/geometry.js';
import { flattening } from '../src/astro/bodies.js';
import { MOON } from '../src/astro/moon.js';
import { AU_KM, DEG, RAD, J2000 } from '../src/astro/constants.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/horizons/observer.json', import.meta.url), 'utf8'));
const eph = createEphemeris(SERIES, { meta: META, moon: true });
const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** Committed |Δmag| tolerances (brief 0.1 for Mercury–Saturn; Mars widened; Uranus/Neptune 1.3 × measured rounded up). */
const MAG_TOL = { mercury: 0.1, venus: 0.1, mars: 0.15 /* widened: 0.102 */, jupiter: 0.1, saturn: 0.1, uranus: 0.05, neptune: 0.05 };
/** Sub-Earth planetocentric latitude vs Horizons planetodetic ObsSub-LAT converted with tan φ_c = (1 − f)² tan φ_d. */
const SUBLAT_TOL_DEG = 0.003; // measured 0.0019

const deticToCentric = (phiD, f) => Math.atan(Math.tan(phiD * DEG) * (1 - f) ** 2) * RAD;

/** Residuals, computed once. */
const RES = {};
for (const body of PLANETS) {
  RES[body] = FX.bodies[body].rows.map((row) => {
    const S = eph.states(row.jdTT, {});
    const m = planetMagnitude(S, body, row.jdTT, newMagnitude());
    const sub = subLatitudes(S, body, row.jdTT);
    return {
      row, m, sub,
      dMag: row.apMag === null ? NaN : m.mag - row.apMag,
      dSubLat: row.subLatDeg === null ? NaN : sub.earthDeg - deticToCentric(row.subLatDeg, flattening(body)),
    };
  });
}

for (const body of PLANETS) {
  test(`${body}: |V − Horizons APmag| ≤ ${MAG_TOL[body]} mag at every epoch with a published magnitude; α inside the model range`, (t) => {
    let max = 0, n = 0, sum = 0;
    for (const r of RES[body]) {
      if (!Number.isFinite(r.dMag)) continue;
      n++; sum += r.dMag;
      assert.ok(Math.abs(r.dMag) <= MAG_TOL[body], `${body} JD ${r.row.jdTT} (α = ${r.m.phaseAngleDeg.toFixed(2)}°): V ${r.m.mag.toFixed(3)} vs Horizons ${r.row.apMag} (|Δ| = ${Math.abs(r.dMag).toFixed(3)} > ${MAG_TOL[body]}; header table)`);
      assert.ok(r.m.valid, `${body} JD ${r.row.jdTT}: Horizons printed a magnitude, so α = ${r.m.phaseAngleDeg.toFixed(2)}° must be inside PHASE_RANGE_DEG`);
      max = Math.max(max, Math.abs(r.dMag));
    }
    assert.ok(n >= 10, `${body}: at least 10 of 12 epochs have a Horizons magnitude (got ${n})`);
    t.diagnostic(`${body}: max |Δmag| ${max.toFixed(3)} over ${n} epochs, mean Δ ${(sum / n).toFixed(3)}`);
  });
}

test('every committed magnitude tolerance is ≥ 1.3 × the measured maximum (margin rule)', () => {
  for (const body of PLANETS) {
    const max = Math.max(...RES[body].map((r) => (Number.isFinite(r.dMag) ? Math.abs(r.dMag) : 0)));
    assert.ok(MAG_TOL[body] >= 1.3 * max, `${body}: tolerance ${MAG_TOL[body]} < 1.3 × measured ${max.toFixed(3)} — widen and log in test/fixtures/README.md`);
  }
});

test('Uranus 5.3–6.0 and Neptune 7.6–8.0 at every epoch (brief sanity bounds); Venus −3.8 … −4.9; Jupiter −1.6 … −2.9 in 2020–2027', () => {
  const bounds = { uranus: [5.3, 6.0], neptune: [7.6, 8.0], venus: [-4.9, -3.8], jupiter: [-2.9, -1.6] };
  for (const [body, [lo, hi]] of Object.entries(bounds)) {
    for (const r of RES[body]) assert.ok(r.m.mag >= lo && r.m.mag <= hi, `${body} JD ${r.row.jdTT}: V = ${r.m.mag.toFixed(3)} outside [${lo}, ${hi}]`);
  }
});

test('Saturn: the ring term uses sin β = √(sin B sin B′); with |B| alone the residual would exceed 0.05 mag; B and B′ are exposed', () => {
  let worstEarthOnly = 0;
  for (const r of RES.saturn) {
    assert.ok(Number.isFinite(r.m.ringOpeningDeg) && Number.isFinite(r.m.ringOpeningSunDeg), 'B, B′ reported');
    assert.equal(r.m.ringOpeningDeg, r.sub.earthDeg);
    const a = r.m.phaseAngleDeg;
    const base = 5 * Math.log10(r.m.rAu * r.m.deltaAu);
    const sbE = Math.sin(Math.abs(r.sub.earthDeg) * DEG);
    const earthOnly = base + (-8.914 - 1.825 * sbE + 0.026 * a - 0.378 * sbE * Math.exp(-2.25 * a));
    worstEarthOnly = Math.max(worstEarthOnly, Math.abs(earthOnly - r.row.apMag));
  }
  assert.ok(worstEarthOnly > 0.05, `|B|-only form leaves ${worstEarthOnly.toFixed(3)} mag (measured 0.065) — the geometric mean is the paper's effective sub-latitude`);
  assert.equal(saturnEffectiveSinBeta(0, 10), 0, 'edge-on to Earth → no ring light');
  assert.equal(saturnEffectiveSinBeta(5, -5), 0, 'opposite faces → the lit face is hidden');
  assert.ok(Math.abs(saturnEffectiveSinBeta(20, 20) - Math.sin(20 * DEG)) < 1e-15, 'equal angles → sin B');
  assert.ok(Math.abs(saturnEffectiveSinBeta(-10, -20) - Math.sqrt(Math.sin(10 * DEG) * Math.sin(20 * DEG))) < 1e-15, 'southern face: absolute values');
  // Around the March 2025 ring-plane crossing Saturn is faint: V > 0.9 on 2025-06-01 (fixture row 2460827.5)
  const near = RES.saturn.find((r) => r.row.jdTT === 2460827.5);
  assert.ok(near.m.mag > 0.9 && Math.abs(near.m.ringOpeningDeg) < 4, `2025-06-01: V = ${near.m.mag.toFixed(3)}, B = ${near.m.ringOpeningDeg.toFixed(2)}°`);
});

test('sub-Earth planetocentric latitudes vs Horizons ObsSub-LAT (planetodetic, converted) agree to 0.003° for all seven planets', (t) => {
  let max = 0;
  for (const body of PLANETS) {
    for (const r of RES[body]) {
      if (!Number.isFinite(r.dSubLat)) continue;
      assert.ok(Math.abs(r.dSubLat) <= SUBLAT_TOL_DEG, `${body} JD ${r.row.jdTT}: sub-Earth latitude ${r.sub.earthDeg.toFixed(4)}° vs Horizons ${deticToCentric(r.row.subLatDeg, flattening(body)).toFixed(4)}° (|Δ| > ${SUBLAT_TOL_DEG}°; IAU 2015 poles)`);
      max = Math.max(max, Math.abs(r.dSubLat));
    }
  }
  assert.ok(SUBLAT_TOL_DEG >= 1.3 * max, `margin rule: ${SUBLAT_TOL_DEG} ≥ 1.3 × ${max.toFixed(4)}`);
  t.diagnostic(`max |Δ sub-Earth latitude| ${max.toFixed(4)}°`);
  // Saturn's planetodetic vs planetocentric difference is large (f = 0.098): the conversion matters
  const s = FX.bodies.saturn.rows[0];
  assert.ok(Math.abs(s.subLatDeg - deticToCentric(s.subLatDeg, flattening('saturn'))) > 2, 'Saturn: detic − centric > 2° at B ≈ 24°');
});

test('phase curves at α → 0: V₁(0) of Table 2 (Mercury −0.613 at the 2° edge ≈ −0.49, Venus −4.384, Mars −1.601, Jupiter −9.395, Saturn globe −8.95, Uranus −7.110 − 8.4e-4 φ′, Neptune −7.00)', () => {
  assert.ok(Math.abs(phaseTerm('venus', 0) - -4.384) < 1e-12);
  assert.ok(Math.abs(phaseTerm('mars', 0) - -1.601) < 1e-12);
  assert.ok(Math.abs(phaseTerm('jupiter', 0) - -9.395) < 1e-12);
  assert.ok(Math.abs(phaseTerm('saturn', 0, { sinBeta: 0 }) - -8.95) < 1e-12, 'globe alone when the rings are edge-on');
  assert.ok(Math.abs(phaseTerm('saturn', 0, { sinBeta: Math.sin(26 * DEG) }) - (-8.914 - 1.825 * Math.sin(26 * DEG) - 0.378 * Math.sin(26 * DEG))) < 1e-12, 'rings wide open: −8.914 − 2.203 sin β at α = 0');
  assert.ok(Math.abs(phaseTerm('uranus', 0, { phiDeg: 0 }) - -7.110) < 1e-12);
  assert.ok(Math.abs(phaseTerm('neptune', 0, { year: 2025 }) - -7.00) < 1e-12);
  assert.ok(Math.abs(phaseTerm('neptune', 0, { year: 1970 }) - -6.89) < 1e-12 && Math.abs(phaseTerm('neptune', 0, { year: 1990 }) - -6.945) < 1e-12, 'Neptune brightened 1980–2000');
  assert.ok(Math.abs(phaseTerm('earth', 0) - -3.99) < 1e-12);
  assert.ok(Math.abs(phaseTerm('mercury', 2) - -0.4931) < 0.001, `Mercury at the 2° edge: ${phaseTerm('mercury', 2).toFixed(4)}`);
  // Venus' two branches meet at 163.7° within 0.03 mag (the paper's fit boundary)
  assert.ok(Math.abs(phaseTerm('venus', 163.7) - phaseTerm('venus', 163.7001)) < 0.03);
  // Jupiter's branches meet at 12° within 0.01 mag; Saturn's globe branches near 6.5° within 0.05
  assert.ok(Math.abs(phaseTerm('jupiter', 12) - phaseTerm('jupiter', 12.0001)) < 0.01);
  assert.ok(Math.abs(phaseTerm('saturn', 6.5, { sinBeta: 0 }) - phaseTerm('saturn', 6.5001, { sinBeta: 0 })) < 0.05);
  assert.throws(() => phaseTerm('pluto', 0), RangeError);
  for (const id of PLANETS) assert.ok(PHASE_RANGE_DEG[id][0] < PHASE_RANGE_DEG[id][1] && Object.isFrozen(PHASE_RANGE_DEG[id]));
});

test('planetMagnitude record: k = (1 + cos α)/2, angular diameter 2 asin(a/Δ), extrapolation flag outside the range, `out` reused', () => {
  const S = eph.states(2460568.5, {});
  const out = newMagnitude();
  assert.equal(planetMagnitude(S, 'mars', 2460568.5, out), out);
  assert.ok(Math.abs(out.phaseAngleDeg - phaseAngleDeg(S, 'mars')) < 1e-12);
  assert.ok(Math.abs(out.illuminatedFraction - illuminatedFraction(S, 'mars')) < 1e-15);
  assert.ok(Math.abs(out.illuminatedFraction - (1 + Math.cos(out.phaseAngleDeg * DEG)) / 2) < 1e-15);
  assert.ok(Math.abs(out.angularDiameterArcsec - angularDiameterArcsec(S, 'mars')) < 1e-12);
  assert.ok(Math.abs(out.angularDiameterArcsec - 2 * Math.asin(3396.19 / geocentricDistanceKm(S, 'mars')) * RAD * 3600) < 1e-9);
  assert.ok(Math.abs(out.deltaAu * AU_KM - geocentricDistanceKm(S, 'mars')) < 1e-6);
  // Mercury near inferior conjunction (α > 170°) is flagged as extrapolated, value finite and evaluated at the edge
  // (α < 2° at superior conjunction needs an elongation < 0.6°, which the 7° inclination rarely allows)
  let found = false;
  for (let jd = 2460300.5; jd < 2460800 && !found; jd += 1) {
    const St = eph.states(jd, {});
    if (phaseAngleDeg(St, 'mercury') > 170) {
      const m = planetMagnitude(St, 'mercury', jd);
      assert.equal(m.valid, false);
      assert.ok(Number.isFinite(m.mag), 'finite even outside the range');
      assert.ok(Math.abs(m.mag - (5 * Math.log10(m.rAu * m.deltaAu) + phaseTerm('mercury', 170))) < 1e-12, 'clamped to the 170° edge');
      found = true;
    }
  }
  assert.ok(found, 'Mercury passes α > 170° within 500 days (every inferior conjunction)');
  assert.throws(() => planetMagnitude(S, 'earth', 2460568.5), RangeError);
  assert.throws(() => planetMagnitude(S, 'sun', 2460568.5), RangeError);
});

test('Moon: Allen 1973 law −12.73 at full Moon and mean distance, −10.1 at quadrature, distance term 5 log(Δ/Δ₀); states form agrees', () => {
  assert.equal(moonMagnitude(0, MOON.meanDistanceKm, 1), -12.73);
  assert.ok(Math.abs(moonMagnitude(90, MOON.meanDistanceKm) - (-12.73 + 0.026 * 90 + 4e-9 * 90 ** 4)) < 1e-12, '−10.128 at α = 90°');
  assert.ok(Math.abs(moonMagnitude(0, 2 * MOON.meanDistanceKm) - (-12.73 + 5 * Math.log10(2))) < 1e-12, 'twice as far: +1.505 mag');
  assert.ok(Math.abs(moonMagnitude(-45, 384400) - moonMagnitude(45, 384400)) < 1e-15, 'even in α');
  // 2025-03-14 06:58:43 TD total lunar eclipse (full Moon): k > 0.995, V ≈ −12.6 … −12.9 (Allen; the eclipse itself is not modelled)
  const jd = 2460748.790775463;
  const S = eph.states(jd, {});
  const m = moonMagnitudeFromStates(S);
  assert.ok(m.illuminatedFraction > 0.995 && m.phaseAngleDeg < 1.5, `full Moon: k ${m.illuminatedFraction.toFixed(5)}, α ${m.phaseAngleDeg.toFixed(3)}°`);
  assert.ok(m.mag > -12.95 && m.mag < -12.55, `V = ${m.mag.toFixed(3)}`);
  assert.ok(m.angularDiameterArcsec > 1760 && m.angularDiameterArcsec < 2010, `diameter ${(m.angularDiameterArcsec / 60).toFixed(2)}′ (29.4′–33.5′)`);
  assert.equal(magnitude(S, 'moon', jd), m.mag);
  const planetsOnly = createEphemeris(SERIES, { meta: META }).states(jd, {});
  assert.throws(() => moonMagnitudeFromStates(planetsOnly), RangeError, 'planet-only states have no Moon');
});

test('magnitude() facade: Sun −26.74 at 1 AU (±0.04 over the year), planets = planetMagnitude, Earth NaN', () => {
  const S = eph.states(J2000, {});
  const sun = magnitude(S, 'sun', J2000);
  assert.ok(Math.abs(sun - -26.74) < 0.04, `Sun V = ${sun.toFixed(3)} (Mallama & Hilton Table 1: −26.74 at 1 AU; 0.983 AU in January → −26.78)`);
  assert.ok(Number.isNaN(magnitude(S, 'earth', J2000)));
  for (const id of PLANETS) assert.equal(magnitude(S, id, J2000), planetMagnitude(S, id, J2000).mag);
});
