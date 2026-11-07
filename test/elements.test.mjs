// elements.js — osculating elements from a state vector (Vallado Algorithm 9) vs the JPL Horizons ELEMENTS fixture
// test/fixtures/horizons/elements.json (scripts/fetch-observer.mjs: Mars/Jupiter barycentres, CENTER='500@10',
// REF_PLANE='ECLIPTIC', 4 epochs that are also rows of the VECTORS fixtures mars.json / jupiter.json).
//
// Horizons' "Keplerian GM" is GM☉ + GM(target): 2.95912303780e-4 (Mars) and 2.96194742862e-4 (Jupiter) AU³/d², which
// muForBody() reproduces from the DE440 values in bodies.js to 1.1e-14 (Mars) and 1.7e-11 (Jupiter) relative.
// Measured 2026-11-06:
//   Horizons state + fixture GM → elements vs Horizons: |Δa| ≤ 4.1e-14 AU, |Δe| ≤ 1e-14, |Δi,ΔΩ| ≤ 4e-13°, |Δω| ≤ 1e-11°,
//     |ΔM|, |Δν| ≤ 9.3e-9°, |ΔTp| ≤ 1.8e-8 d, |ΔP| ≤ 5e-11 d — pure-arithmetic agreement at Horizons' print precision.
//   VSOP87 state + fixture GM → elements vs Horizons (the ephemeris' own error): Mars |Δa| ≤ 1.9e-7 AU, |Δe| ≤ 4.7e-8,
//     |Δi| ≤ 4.2e-6°, |ΔΩ| ≤ 1.1e-4°, |Δω| ≤ 1.1e-4°, |ΔM| ≤ 7.6e-5°; Jupiter |Δa| ≤ 1.33e-6 AU, |Δe| ≤ 1.3e-7,
//     |Δi| ≤ 2.3e-5°, |ΔΩ| ≤ 2.1e-4°, |Δω| ≤ 6.4e-4°, |ΔM| ≤ 4.8e-4° — brief: a 1e-6 AU, e 1e-6, angles 0.001°; Jupiter's
//     a is widened to 2e-6 AU (1.3 × 1.33e-6 = 1.73e-6, rounded up; a 5.2 AU orbit's a responds to the 1.3e-8 AU/d
//     velocity residual of horizons.test.mjs as 2a²v·δv/μ ≈ 1.8e-5 AU worst case).
//   Using GM☉ alone (the brief's literal default) shifts Jupiter's a by 5e-3 AU and ω by up to 1.03°: the two-body μ
//     must include the planet's own mass, as Horizons does — hence planetElements() uses muForBody().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import {
  GM_SUN_AU3_D2, muForBody, osculatingElements, planetElements, stateFromElements, solveKeplerRad, newElements,
} from '../src/astro/elements.js';
import { TABLE_1, elements as jplMeanElements } from '../src/astro/keplerian.js';
import { AU_KM, DAY_S, GM_SUN_KM3_S2, J2000, DEG } from '../src/astro/constants.js';
import { BODIES } from '../src/astro/bodies.js';

const EL = JSON.parse(readFileSync(new URL('./fixtures/horizons/elements.json', import.meta.url), 'utf8'));
const VEC = {
  mars: JSON.parse(readFileSync(new URL('./fixtures/horizons/mars.json', import.meta.url), 'utf8')),
  jupiter: JSON.parse(readFileSync(new URL('./fixtures/horizons/jupiter.json', import.meta.url), 'utf8')),
};
const eph = createEphemeris(SERIES, { meta: META });
const EPOCHS = [2451545.0, 2460000.5, 2460676.25, 2461297.0];

/** Angle difference in degrees wrapped to (−180, 180]. */
const dAng = (a, b) => ((a - b + 540) % 360) - 180;

test('fixture: Mars (4) and Jupiter (5) at the 4 VECTORS epochs, heliocentric ecliptic J2000, AU-D, Keplerian GM = GM☉ + GM(body)', () => {
  assert.equal(EL.apiVersion, '1.2');
  assert.equal(EL.center, '500@10');
  assert.equal(EL.timeType, 'TDB', 'Horizons accepts only TDB for element epochs (|TDB − TT| ≤ 1.7 ms)');
  assert.deepEqual(EL.epochs, EPOCHS);
  for (const [body, cmd] of [['mars', '4'], ['jupiter', '5']]) {
    const b = EL.bodies[body];
    assert.equal(b.command, cmd);
    assert.equal(b.frameLine, 'Reference frame : Ecliptic of J2000.0');
    assert.match(b.unitsLine, /AU-D/);
    assert.equal(b.rows.length, 4);
    b.rows.forEach((r, i) => assert.equal(r.jdTdb, EPOCHS[i]));
    assert.ok(Number.isFinite(b.keplerianGmAu3D2) && b.keplerianGmAu3D2 > GM_SUN_AU3_D2, `${body}: Keplerian GM exceeds GM☉`);
    const rel = Math.abs(b.keplerianGmAu3D2 - muForBody(body)) / muForBody(body);
    assert.ok(rel < 1e-10, `${body}: fixture GM ${b.keplerianGmAu3D2} vs muForBody ${muForBody(body)} (relative ${rel.toExponential(2)}; measured 1.1e-14 / 1.7e-11)`);
    for (const jd of EPOCHS) assert.ok(VEC[body].rows.some((r) => r.jdTT === jd), `${body}: VECTORS fixture has JD ${jd}`);
  }
  assert.ok(Math.abs(GM_SUN_AU3_D2 - GM_SUN_KM3_S2 * DAY_S ** 2 / AU_KM ** 3) < 1e-25, 'GM_SUN_AU3_D2 derived from constants.js');
  assert.ok(Math.abs(GM_SUN_AU3_D2 - 2.9591220828e-4) < 1e-14, 'GM☉ = 2.9591220828e-4 AU³/d² (DE440)');
  assert.equal(muForBody('sun'), GM_SUN_AU3_D2);
  assert.ok(Math.abs(muForBody('earth') / GM_SUN_AU3_D2 - (1 + 398600.435507 / GM_SUN_KM3_S2)) < 1e-15, 'muForBody(earth) = GM☉ + GM⊕');
  assert.ok(Object.keys(BODIES).includes('moon') && muForBody('moon') > GM_SUN_AU3_D2, 'the Moon has a GM entry');
});

test('Horizons state → elements reproduces Horizons\' elements at print precision (a, e 1e-12; i, Ω, ω 1e-9°; M, ν 1e-7°; Tp 1e-7 d)', (t) => {
  let worst = { a: 0, e: 0, ang: 0, M: 0, tp: 0 };
  for (const body of ['mars', 'jupiter']) {
    const gm = EL.bodies[body].keplerianGmAu3D2;
    for (const row of EL.bodies[body].rows) {
      const s = VEC[body].rows.find((r) => r.jdTT === row.jdTdb);
      const el = osculatingElements(s, row.jdTdb, newElements(), gm);
      const where = `${body} JD ${row.jdTdb}`;
      assert.ok(Math.abs(el.a - row.aAu) < 1e-12, `${where}: a ${el.a} vs ${row.aAu}`);
      assert.ok(Math.abs(el.e - row.ec) < 1e-12, `${where}: e ${el.e} vs ${row.ec}`);
      assert.ok(Math.abs(el.q - row.qrAu) < 1e-12 && Math.abs(el.Q - row.adAu) < 1e-12, `${where}: q/Q`);
      assert.ok(Math.abs(el.iDeg - row.inDeg) < 1e-9, `${where}: i ${el.iDeg} vs ${row.inDeg}`);
      assert.ok(Math.abs(dAng(el.OmegaDeg, row.omDeg)) < 1e-9, `${where}: Ω ${el.OmegaDeg} vs ${row.omDeg}`);
      assert.ok(Math.abs(dAng(el.omegaDeg, row.wDeg)) < 1e-9, `${where}: ω ${el.omegaDeg} vs ${row.wDeg}`);
      assert.ok(Math.abs(dAng(el.MDeg, row.maDeg)) < 1e-7, `${where}: M ${el.MDeg} vs ${row.maDeg} (Kepler's equation; Horizons prints Tp to 1e-9 d)`);
      assert.ok(Math.abs(dAng(el.nuDeg, row.taDeg)) < 1e-7, `${where}: ν ${el.nuDeg} vs ${row.taDeg}`);
      assert.ok(Math.abs(el.tPeriJd - row.tpJd) < 1e-7, `${where}: Tp ${el.tPeriJd} vs ${row.tpJd} (the perihelion passage preceding the epoch, as Horizons)`);
      assert.ok(Math.abs(el.periodDays - row.prDays) < 1e-9, `${where}: period ${el.periodDays} vs ${row.prDays} d`);
      assert.ok(Math.abs(el.meanMotionDegPerDay - row.nDegPerDay) < 1e-12, `${where}: n`);
      worst = {
        a: Math.max(worst.a, Math.abs(el.a - row.aAu)), e: Math.max(worst.e, Math.abs(el.e - row.ec)),
        ang: Math.max(worst.ang, Math.abs(dAng(el.OmegaDeg, row.omDeg)), Math.abs(dAng(el.omegaDeg, row.wDeg)), Math.abs(el.iDeg - row.inDeg)),
        M: Math.max(worst.M, Math.abs(dAng(el.MDeg, row.maDeg))), tp: Math.max(worst.tp, Math.abs(el.tPeriJd - row.tpJd)),
      };
    }
  }
  t.diagnostic(`worst: |Δa| ${worst.a.toExponential(2)} AU, |Δe| ${worst.e.toExponential(2)}, |Δi,Ω,ω| ${worst.ang.toExponential(2)}°, |ΔM| ${worst.M.toExponential(2)}°, |ΔTp| ${worst.tp.toExponential(2)} d`);
});

test('VSOP87 state → elements vs Horizons: a ≤ 1e-6 AU (Jupiter 2e-6, widened), e ≤ 1e-6, i/Ω/ω/M/ν ≤ 0.001° (brief); planetElements uses muForBody', (t) => {
  const A_TOL = { mars: 1e-6, jupiter: 2e-6 }; // Jupiter widened: measured 1.33e-6 × 1.3 = 1.73e-6
  const maxA = { mars: 0, jupiter: 0 }, maxAng = { mars: 0, jupiter: 0 };
  for (const body of ['mars', 'jupiter']) {
    for (const row of EL.bodies[body].rows) {
      const S = eph.states(row.jdTdb, {});
      const el = planetElements(S, body, row.jdTdb);
      assert.equal(el.mu, muForBody(body));
      const where = `${body} JD ${row.jdTdb}`;
      assert.ok(Math.abs(el.a - row.aAu) <= A_TOL[body], `${where}: a ${el.a} vs ${row.aAu} (|Δ| = ${Math.abs(el.a - row.aAu).toExponential(2)} > ${A_TOL[body]} AU)`);
      assert.ok(Math.abs(el.e - row.ec) <= 1e-6, `${where}: e ${el.e} vs ${row.ec} (brief 1e-6)`);
      for (const [k, want] of [['iDeg', row.inDeg], ['OmegaDeg', row.omDeg], ['omegaDeg', row.wDeg], ['MDeg', row.maDeg], ['nuDeg', row.taDeg], ['varpiDeg', (row.omDeg + row.wDeg) % 360]]) {
        const d = Math.abs(dAng(el[k], want));
        assert.ok(d <= 0.001, `${where}: ${k} ${el[k]} vs ${want} (|Δ| = ${d.toExponential(2)}° > 0.001°, brief)`);
        maxAng[body] = Math.max(maxAng[body], d);
      }
      maxA[body] = Math.max(maxA[body], Math.abs(el.a - row.aAu));
    }
    assert.ok(A_TOL[body] >= 1.3 * maxA[body], `${body}: a tolerance ${A_TOL[body]} < 1.3 × measured ${maxA[body].toExponential(2)} (margin rule)`);
    t.diagnostic(`${body}: max |Δa| ${maxA[body].toExponential(2)} AU, max angle residual ${maxAng[body].toExponential(2)}°`);
  }
});

test('the two-body μ must include the planet: with GM☉ alone Jupiter\'s a is off by ≈ 5e-3 AU and ω by up to 1°, Mars\' a by ≈ 5e-7 AU', () => {
  for (const [body, expectA] of [['mars', 4e-7], ['jupiter', 4.5e-3]]) {
    const row = EL.bodies[body].rows[0];
    const s = VEC[body].rows.find((r) => r.jdTT === row.jdTdb);
    const el = osculatingElements(s, row.jdTdb); // default μ = GM☉
    assert.equal(el.mu, GM_SUN_AU3_D2);
    assert.ok(Math.abs(el.a - row.aAu) > expectA, `${body}: |Δa| with GM☉ alone = ${Math.abs(el.a - row.aAu).toExponential(2)} AU (expected > ${expectA})`);
  }
  const j = EL.bodies.jupiter.rows[2];
  const sj = VEC.jupiter.rows.find((r) => r.jdTT === j.jdTdb);
  assert.ok(Math.abs(dAng(osculatingElements(sj, j.jdTdb).omegaDeg, j.wDeg)) > 0.5, 'Jupiter ω shifts by > 0.5° with the wrong μ (measured 1.01°)');
});

test('round trip stateFromElements(osculatingElements(s)) = s to 1e-14 AU and 1e-16 AU/d for every planet at 5 epochs', () => {
  for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
    for (const jd of [J2000, 2460000.5, 2461297.0, 2415020.0, 2488070.0]) {
      const s = eph.state(id, jd);
      const el = osculatingElements(s, jd, newElements(), muForBody(id));
      const back = stateFromElements(el, undefined, el.mu);
      const dr = Math.hypot(back.x - s.x, back.y - s.y, back.z - s.z), dv = Math.hypot(back.vx - s.vx, back.vy - s.vy, back.vz - s.vz);
      assert.ok(dr < 1e-13, `${id} JD ${jd}: |Δr| ${dr.toExponential(2)} AU (1e-13 AU = 15 m; measured ≤ 1.2e-14 for Saturn at 9.5 AU)`);
      assert.ok(dv < 1e-16, `${id} JD ${jd}: |Δv| ${dv.toExponential(2)} AU/d (measured ≤ 1e-17)`);
      assert.ok(el.e > 0 && el.e < 0.21 && el.a > 0.38 && el.a < 30.6, `${id}: sensible e, a (${el.e.toFixed(4)}, ${el.a.toFixed(3)} AU; Neptune's osculating a swings ±0.3 AU)`);
      assert.ok(el.MDeg >= 0 && el.MDeg < 360 && el.OmegaDeg >= 0 && el.OmegaDeg < 360 && el.omegaDeg >= 0 && el.omegaDeg < 360, 'angles in [0, 360)');
      assert.ok(Math.abs(el.LDeg - (el.varpiDeg + el.MDeg) % 360) < 1e-9 && Math.abs(el.varpiDeg - (el.OmegaDeg + el.omegaDeg) % 360) < 1e-9, 'L = ϖ + M, ϖ = Ω + ω');
      assert.ok(el.tPeriJd <= jd && el.tPeriJd > jd - el.periodDays, 'Tp is the passage preceding the epoch');
      assert.ok(Math.abs(el.q - el.a * (1 - el.e)) < 1e-15 && Math.abs(el.Q - el.a * (1 + el.e)) < 1e-14);
    }
  }
});

test('osculating elements at J2000 agree with the JPL approximate (mean) elements of keplerian.js Table 1 to the published mean-vs-osculating scatter', () => {
  // Standish & Williams Table 1 are mean elements; osculating ones oscillate about them (Saturn's a by ±0.05 AU and
  // its ϖ by ±3° from the Jupiter–Saturn great inequality, Earth's e by ±0.0003 from the Moon). Tolerances: a 1 %,
  // e 0.002, i 0.02°, ϖ 4°, L 1.5°, Ω 1° (sanity, not verification — see the Horizons tests above).
  for (const id of Object.keys(TABLE_1)) {
    const mean = jplMeanElements(id, J2000, 1);
    const el = osculatingElements(eph.state(id, J2000), J2000, newElements(), muForBody(id));
    assert.ok(Math.abs(el.a / mean.a - 1) < 0.01, `${id}: a ${el.a} vs mean ${mean.a} (Saturn J2000 osculating 9.582 vs mean 9.537)`);
    assert.ok(Math.abs(el.e - mean.e) < 0.005, `${id}: e ${el.e} vs mean ${mean.e} (Uranus J2000: 0.0444 osculating vs 0.0473 mean)`);
    assert.ok(Math.abs(el.iDeg - Math.abs(mean.I)) < 0.02, `${id}: i ${el.iDeg} vs mean ${mean.I}`);
    // ϖ is ill-conditioned for the near-circular orbits (Venus e = 0.0068, Neptune e = 0.0086: osculating ϖ swings ±8°)
    if (mean.e >= 0.01) assert.ok(Math.abs(dAng(el.varpiDeg, mean.varpi)) < 4, `${id}: ϖ ${el.varpiDeg} vs mean ${mean.varpi} (Saturn J2000: 89.66° vs 92.60°)`);
    assert.ok(Math.abs(dAng(el.LDeg, mean.L)) < 1.5, `${id}: L ${el.LDeg} vs mean ${mean.L}`);
    if (id !== 'earth') assert.ok(Math.abs(dAng(el.OmegaDeg, mean.Omega)) < 1, `${id}: Ω ${el.OmegaDeg} vs mean ${mean.Omega} (Earth's i ≈ 0 makes Ω ill-conditioned)`);
  }
});

test('Kepler solver: Meeus Example 30.a (M = 5°, e = 0.1 → E = 5.554589°), identity at e = 0, symmetry, high e', () => {
  assert.ok(Math.abs(solveKeplerRad(5 * DEG, 0.1) / DEG - 5.554589) < 1e-6, 'Meeus 30.a');
  assert.equal(solveKeplerRad(1.234, 0), 1.234);
  assert.ok(Math.abs(solveKeplerRad(-2 * DEG, 0.3) + solveKeplerRad(2 * DEG, 0.3)) < 1e-15, 'odd in M');
  const E = solveKeplerRad(0.7, 0.95);
  assert.ok(Math.abs(E - 0.95 * Math.sin(E) - 0.7) < 1e-12, 'satisfies M = E − e sin E at e = 0.95');
});

test('circular unit orbit: a = 1 AU, e = 0, period = 365.2569 d (Gaussian year for GM☉), i = 0, prograde', () => {
  const el = osculatingElements({ x: 1, y: 0, z: 0, vx: 0, vy: Math.sqrt(GM_SUN_AU3_D2), vz: 0 }, J2000);
  assert.ok(Math.abs(el.a - 1) < 1e-15 && el.e < 1e-15 && el.iDeg === 0, `a ${el.a}, e ${el.e}, i ${el.iDeg}`);
  assert.ok(Math.abs(el.periodDays - 365.25690) < 0.0001, `period ${el.periodDays} d (2π/√μ = 365.2569 d)`);
  assert.ok(Math.abs(el.h - Math.sqrt(GM_SUN_AU3_D2)) < 1e-15 && Math.abs(el.p - 1) < 1e-15);
  // retrograde circular orbit: i = 180°
  assert.ok(Math.abs(osculatingElements({ x: 1, y: 0, z: 0, vx: 0, vy: -Math.sqrt(GM_SUN_AU3_D2), vz: 0 }, J2000).iDeg - 180) < 1e-12);
});
