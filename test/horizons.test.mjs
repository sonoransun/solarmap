// ephemeris.state (VSOP87A, truncated, scene frame) vs JPL Horizons DE441 fixtures — plan §Verification row
// "horizons (scene frame)" as corrected by the final critique (byf0bzyiw.txt: closed year bands covering every fixture
// epoch, Neptune 60,000/110,000 km, Uranus 1.5″, Neptune 3.0″, Jupiter 0.5″, velocity tolerances provisional until
// measured). Fixtures: test/fixtures/horizons/<body>.json (scripts/fetch-horizons.mjs, heliocentric, geometric,
// "Ecliptic of J2000.0", AU / AU·d⁻¹, 53 TT epochs). Measured residual tables: test/fixtures/horizons/residuals.md
// (`node scripts/ephem.mjs --residuals`, 2026-09-13).
//
// Tolerance rule (plan §Data pipeline 2, task brief): committed tolerance = max(plan table, 1.3 × measured maximum in
// the band). Every widening beyond the plan value is listed in test/fixtures/README.md "Tolerance widening log" and
// marked `// widened` below. The rule is also enforced programmatically at the end of this file so that a regenerated
// data module or fixture set that pushes a residual above tolerance/1.3 fails loudly instead of silently eroding margin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris, PLANETS } from '../src/astro/ephemeris.js';
import { angleBetween } from '../src/astro/vec.js';
import { AU_KM, ARCSEC_PER_RAD, J2000, JULIAN_YEAR_DAYS } from '../src/astro/constants.js';

const eph = createEphemeris(SERIES, { meta: META });

/** @type {Record<string, {body:string, command:string, apiVersion:string, targetLine:string, centerLine:string, frameLine:string, unitsLine:string, rows:Array<{jdTT:number, calendar:string, x:number, y:number, z:number, vx:number, vy:number, vz:number}>}>} */
const FX = {};
for (const body of PLANETS) {
  FX[body] = JSON.parse(readFileSync(new URL(`./fixtures/horizons/${body}.json`, import.meta.url), 'utf8'));
}

/** Horizons COMMAND ids (plan §Data pipeline 2: planet centres for 199/299/399, system barycentres 4–8). */
const COMMANDS = { mercury: '199', venus: '299', earth: '399', mars: '4', jupiter: '5', saturn: '6', uranus: '7', neptune: '8' };
const N_EPOCHS = 53;
const J2000_ROW = 25;

// ---------------------------------------------------------------------------------------------------------------------
// Bands. Julian epoch year y = 2000 + (JD − 2451545)/365.25: the 5-year grid JD 2415020.0 + k·1826.25 is exactly
// 1900 + 5k on this scale (2415020.0 = J1900.0), and the Jan-1 12h TT epochs of 1600 … 2600 land within ±0.01 y of the
// round year, hence the ±0.5 y slack. Closed ranges as the critique demanded ("bands as closed year ranges covering
// every fixture epoch"); an epoch in no band throws so a fixture regeneration with new epochs cannot slip through.
// ---------------------------------------------------------------------------------------------------------------------
const BAND_LABEL = { A: '1900–2050', B: '1850 & 2055–2100', C: '1800 & 2200', D: '1600–1700 & 2300–2600' };
/** Expected epoch counts per band: 31 grid epochs 1900…2050 + 2440000.5 + 2460000.5 + 2461297.0; 1850 + 10 grid epochs 2055…2100; 1800 + 2200; 1600, 1700, 2300, 2400, 2500, 2600. */
const BAND_COUNT = { A: 34, B: 11, C: 2, D: 6 };
const WINDOW_COUNT = 44; // 41 grid epochs 1900…2100 + the three extra epochs

function epochYear(jdTT) {
  return 2000 + (jdTT - J2000) / JULIAN_YEAR_DAYS;
}
function bandOf(jdTT) {
  const y = epochYear(jdTT);
  if (y >= 1899.5 && y <= 2050.5) return 'A';
  if (Math.abs(y - 1850) <= 0.5 || (y >= 2054.5 && y <= 2100.5)) return 'B';
  if (Math.abs(y - 1800) <= 0.5 || Math.abs(y - 2200) <= 0.5) return 'C';
  if ((y >= 1599.5 && y <= 1700.5) || (y >= 2299.5 && y <= 2600.5)) return 'D';
  throw new RangeError(`fixture epoch JD ${jdTT} (J${y.toFixed(3)}) is in no tolerance band — extend the bands`);
}
/** Angular and velocity tolerances apply to 1900–2100 (plan), i.e. bands A and B minus the 1850 epoch. */
function inWindow(jdTT) {
  const y = epochYear(jdTT);
  return y >= 1899.5 && y <= 2100.5;
}

// ---------------------------------------------------------------------------------------------------------------------
// Committed tolerances. Plan values first; `// widened` rows are max(plan, 1.3 × measured) rounded UP to a clean number
// (measured maxima from residuals.md, 2026-09-13; the README log has the full rows).
// ---------------------------------------------------------------------------------------------------------------------
/** Position |Δr| in km per band. */
const POS_TOL_KM = {
  A: { // 1900–2050 (34 epochs)
    mercury: 20,      // measured 8.78
    venus: 20,        // measured 11.41
    earth: 25,        // measured 15.97
    mars: 150,        // measured 44.11
    jupiter: 1500,    // measured 1025.75
    saturn: 2500,     // widened: plan 2,000; measured 1,902.90 × 1.3 = 2,473.8
    uranus: 25500,    // widened: plan 20,000; measured 19,401.67 × 1.3 = 25,222.2
    neptune: 60000,   // measured 43,815.74
  },
  B: { // 1850 & 2055–2100 (11 epochs)
    mercury: 30,      // measured 14.57
    venus: 30,        // measured 17.40
    earth: 40,        // measured 27.63
    mars: 200,        // measured 121.79
    jupiter: 2000,    // measured 1,358.48
    saturn: 3000,     // measured 2,179.29
    uranus: 25000,    // measured 18,359.96
    neptune: 75000,   // measured 49,698.06
  },
  C: { // 1800 & 2200 (2 epochs)
    mercury: 40,      // measured 25.82
    venus: 40,        // measured 23.69
    earth: 60,        // measured 43.72
    mars: 500,        // measured 361.37
    jupiter: 2500,    // measured 1,873.55
    saturn: 3600,     // widened: plan 3,500; measured 2,699.46 × 1.3 = 3,509.3
    uranus: 31000,    // widened: plan 30,000; measured 23,644.04 × 1.3 = 30,737.3
    neptune: 110000,  // measured 82,484.94
  },
  D: { // 1600–1700 & 2300–2600 (6 epochs) — VSOP87's DE200 heritage dominates (POC bsiou1mfc.txt §6, §8)
    mercury: 80,      // measured 49.52
    venus: 80,        // measured 54.57
    earth: 160,       // widened: plan 150; measured 121.87 × 1.3 = 158.4
    mars: 3100,       // widened: plan 3,000; measured 2,323.23 × 1.3 = 3,020.2
    jupiter: 3500,    // measured 2,313.29
    saturn: 11300,    // widened: plan 10,000; measured 8,623.44 × 1.3 = 11,210.5
    uranus: 152000,   // widened: plan 130,000; measured 116,882.76 × 1.3 = 151,947.6
    neptune: 227000,  // widened: plan 200,000; measured 173,930.52 × 1.3 = 226,109.7
  },
};

/** Angular residual atan2(|v×h|, v·h) in arcseconds, 1900–2100 (44 epochs). */
const ANG_TOL_ARCSEC = {
  mercury: 0.08,    // widened: plan 0.05; measured 0.0605 (J2095) × 1.3 = 0.0787
  venus: 0.05,      // measured 0.0329
  earth: 0.05,      // measured 0.0324
  mars: 0.15,       // measured 0.1112
  jupiter: 0.5,     // measured 0.3450
  saturn: 0.5,      // measured 0.3007
  uranus: 1.85,     // widened: plan 1.5; measured 1.4144 (J2035) × 1.3 = 1.839
  neptune: 3.0,     // measured 2.2828
};

/**
 * Velocity |Δv| in AU/day, 1900–2100. The plan's numbers were provisional (critique: no research report measured a
 * velocity residual); the first measurement (residuals.md) gives maxima 3.3e-9 … 5.8e-8 AU/d, all below the plan
 * values, so max(plan, 1.3 × measured) keeps the plan values. 1e-8 AU/d ≈ 17 mm/s.
 */
const VEL_TOL_AU_D = {
  mercury: 1.5e-8,  // measured 7.148e-9
  venus: 1.5e-8,    // measured 3.268e-9
  earth: 1.5e-8,    // measured 5.828e-9
  mars: 1.5e-8,     // measured 8.081e-9
  jupiter: 5e-8,    // measured 1.291e-8
  saturn: 5e-8,     // measured 1.397e-8
  uranus: 2e-7,     // measured 3.661e-8
  neptune: 2e-7,    // measured 5.804e-8
};

/** Residual of the ephemeris state against one Horizons row (same frame and units). */
function residual(body, row) {
  const s = eph.state(body, row.jdTT);
  return {
    km: Math.hypot(s.x - row.x, s.y - row.y, s.z - row.z) * AU_KM,
    arcsec: angleBetween([s.x, s.y, s.z], [row.x, row.y, row.z]) * ARCSEC_PER_RAD,
    auDay: Math.hypot(s.vx - row.vx, s.vy - row.vy, s.vz - row.vz),
  };
}

/** All residuals, computed once: RES[body] = [{row, band, km, arcsec, auDay}] */
const RES = {};
for (const body of PLANETS) {
  RES[body] = FX[body].rows.map((row) => ({ row, band: bandOf(row.jdTT), ...residual(body, row) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixture integrity (plan §Data pipeline 2 assertions, re-checked at test time so a hand edit cannot go unnoticed)
// ---------------------------------------------------------------------------------------------------------------------
test('fixtures: 8 bodies × 53 TT epochs, DE441, Ecliptic of J2000.0, AU-D, identical sorted epoch lists, J2000 at row 25', () => {
  const epochs0 = FX.mercury.rows.map((r) => r.jdTT);
  for (const body of PLANETS) {
    const fx = FX[body];
    assert.equal(fx.body, body);
    assert.equal(fx.command, COMMANDS[body], `${body}: Horizons COMMAND id`);
    assert.equal(fx.apiVersion, '1.2', `${body}: Horizons API version the fixtures were generated with`);
    assert.match(fx.targetLine, /\{source: DE441\}/, `${body}: target ephemeris DE441`);
    assert.match(fx.centerLine, /^Center body name: Sun \(10\)/, `${body}: heliocentric`);
    assert.equal(fx.frameLine, 'Reference frame : Ecliptic of J2000.0');
    assert.equal(fx.unitsLine, 'Output units    : AU-D');
    assert.equal(fx.rows.length, N_EPOCHS, `${body}: 53 epochs (41-epoch grid + 9 century epochs + 3 extras)`);
    const epochs = fx.rows.map((r) => r.jdTT);
    assert.deepEqual(epochs, epochs0, `${body}: same epoch list as mercury`);
    for (let i = 1; i < epochs.length; i++) assert.ok(epochs[i] > epochs[i - 1], `${body}: rows sorted by jdTT`);
    for (const r of fx.rows) {
      for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) assert.ok(Number.isFinite(r[k]), `${body} ${r.calendar}: finite ${k}`);
    }
  }
  assert.equal(epochs0[J2000_ROW], J2000, 'rows[25] is J2000 (2451545.0)');
  assert.equal(epochs0[0], 2305448.0, 'first epoch 1600-01-01 12:00 TT');
  assert.equal(epochs0[N_EPOCHS - 1], 2670691.0, 'last epoch 2600-01-01 12:00 TT');
  for (let k = 0; k <= 40; k++) assert.ok(epochs0.includes(2415020.0 + k * 1826.25), `grid epoch k=${k} present`);
  for (const jd of [2440000.5, 2460000.5, 2461297.0]) assert.ok(epochs0.includes(jd), `extra epoch ${jd} present`);
});

test('fixtures: the three plan reference rows to 1e-12 AU (Mars/4, Earth/399, Neptune/8 at J2000)', () => {
  // Values quoted from the plan §Data pipeline 2 (planning research's live Horizons run).
  const known = {
    mars: [1.390715921745722, -0.01341631816512547, -0.03446766277610819],
    earth: [-0.1771350992582233, 0.9672416867691899, -4.085281582660778e-6],
    neptune: [16.81204696805071, -24.99176288928619, 0.1272228799203305],
  };
  for (const [body, [x, y, z]] of Object.entries(known)) {
    const r = FX[body].rows[J2000_ROW];
    assert.equal(r.jdTT, J2000);
    assert.ok(Math.abs(r.x - x) < 1e-12 && Math.abs(r.y - y) < 1e-12 && Math.abs(r.z - z) < 1e-12,
      `${body} J2000 fixture row equals the plan's Horizons values to 1e-12 AU (got ${r.x}, ${r.y}, ${r.z})`);
  }
});

test('bands: every fixture epoch is in exactly one band, counts 34/11/2/6, 1900–2100 window holds 44 epochs', () => {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  let win = 0;
  for (const r of FX.earth.rows) {
    counts[bandOf(r.jdTT)]++;
    if (inWindow(r.jdTT)) win++;
  }
  assert.deepEqual(counts, BAND_COUNT, 'epochs per band (critique: bands must cover every fixture epoch)');
  assert.equal(win, WINDOW_COUNT, '1900–2100 angular/velocity window');
  assert.equal(epochYear(2415020.0), 1900, 'JD 2415020.0 = J1900.0 exactly');
  assert.equal(epochYear(2488070.0), 2100, 'JD 2488070.0 = J2100.0 exactly');
  assert.equal(bandOf(2396759.0), 'B', '1850 epoch shares the 2055–2100 band');
  assert.ok(!inWindow(2396759.0), '1850 epoch is outside the angular/velocity window');
  assert.throws(() => bandOf(2305448.0 - 36525), RangeError, '1500 is outside every band');
});

// ---------------------------------------------------------------------------------------------------------------------
// Position residuals per body and band (km)
// ---------------------------------------------------------------------------------------------------------------------
for (const body of PLANETS) {
  test(`${body}: |Δr| vs Horizons within the band tolerances at all 53 epochs`, (t) => {
    const max = { A: 0, B: 0, C: 0, D: 0 };
    for (const r of RES[body]) {
      const tol = POS_TOL_KM[r.band][body];
      assert.ok(r.km <= tol,
        `${body} ${r.row.calendar} (JD ${r.row.jdTT}, band ${BAND_LABEL[r.band]}): |Δr| = ${r.km.toFixed(2)} km > ${tol} km (plan horizons row / README widening log)`);
      if (r.km > max[r.band]) max[r.band] = r.km;
    }
    t.diagnostic(`${body} max |Δr| km — A ${max.A.toFixed(1)} / B ${max.B.toFixed(1)} / C ${max.C.toFixed(1)} / D ${max.D.toFixed(1)}`);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Angular and velocity residuals 1900–2100
// ---------------------------------------------------------------------------------------------------------------------
for (const body of PLANETS) {
  test(`${body}: angular residual atan2(|v×h|, v·h) ≤ ${ANG_TOL_ARCSEC[body]}″ and |Δv| ≤ ${VEL_TOL_AU_D[body]} AU/d over 1900–2100`, (t) => {
    let n = 0, maxA = 0, maxV = 0;
    for (const r of RES[body]) {
      if (!inWindow(r.row.jdTT)) continue;
      n++;
      assert.ok(r.arcsec <= ANG_TOL_ARCSEC[body],
        `${body} ${r.row.calendar}: angle ${r.arcsec.toFixed(4)}″ > ${ANG_TOL_ARCSEC[body]}″ (plan angular row, atan2 form per CLAUDE.md)`);
      assert.ok(r.auDay <= VEL_TOL_AU_D[body],
        `${body} ${r.row.calendar}: |Δv| ${r.auDay.toExponential(3)} AU/d > ${VEL_TOL_AU_D[body]} AU/d (plan velocity row, provisional → first measured in residuals.md)`);
      if (r.arcsec > maxA) maxA = r.arcsec;
      if (r.auDay > maxV) maxV = r.auDay;
    }
    assert.equal(n, WINDOW_COUNT);
    t.diagnostic(`${body} 1900–2100 max angle ${maxA.toFixed(4)}″, max |Δv| ${maxV.toExponential(3)} AU/d`);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Spot rows (plan §Verification frames/vsop87 rows and the task brief), on the shipped truncated data
// ---------------------------------------------------------------------------------------------------------------------
test('spot rows: Mars J2000 ≤ 25 km, Earth ≤ 15 km, Mercury ≤ 5 km, Mars 2460000.5 ≤ 40 km, Neptune J2000 ≤ 20,000 km', () => {
  const spot = [
    ['mars', J2000, 25, 'POC §6 doc-rotated Mars J2000 20.1 km + truncation ≤ 2.9 km'],
    ['earth', J2000, 15, 'POC §6 Earth J2000 11.2 km (full series) + truncation ≤ 2.1 km'],
    ['mercury', J2000, 5, 'POC §6 Mercury J2000 2.1 km (full) + truncation ≤ 2.6 km (critique: 0–4.7 km consistent)'],
    ['mars', 2460000.5, 40, 'POC §6 Mars 2023-02-25 ≈ 33 km'],
    ['neptune', J2000, 20000, 'POC §6 Neptune vs barycentre 8 at J2000: 15,998.7 km (DE200 heritage)'],
  ];
  for (const [body, jd, tol, why] of spot) {
    const r = RES[body].find((e) => e.row.jdTT === jd);
    assert.ok(r, `${body} fixture has epoch ${jd}`);
    assert.ok(r.km <= tol, `${body} JD ${jd}: ${r.km.toFixed(2)} km ≤ ${tol} km (${why})`);
  }
});

test('the frame rotation is what makes the km-level agreement possible: raw VSOP frame residual at Earth J2000 is > 2× the rotated one', () => {
  // Guards against a silently dropped M_VSOP_TO_ECL (POC §6: raw ≈ 61 km vs rotated ≈ 11 km for Earth at J2000).
  const row = FX.earth.rows[J2000_ROW];
  const raw = eph.evaluator.evalRaw('earth', J2000, { tier: 'full', velocity: false });
  const rawKm = Math.hypot(raw.x - row.x, raw.y - row.y, raw.z - row.z) * AU_KM;
  const rot = RES.earth[J2000_ROW].km;
  assert.ok(rawKm > 2 * rot && rawKm > 40, `raw ${rawKm.toFixed(1)} km vs rotated ${rot.toFixed(1)} km`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Tolerance-rule enforcement: committed ≥ 1.3 × measured (plan §Data pipeline 2). Fails when a regenerated data module
// or fixture set erodes the margin — widen the table above AND add a README log row.
// ---------------------------------------------------------------------------------------------------------------------
test('every committed tolerance is ≥ 1.3 × the measured maximum of its band/window (margin rule)', () => {
  for (const body of PLANETS) {
    const max = { A: 0, B: 0, C: 0, D: 0 };
    let maxA = 0, maxV = 0;
    for (const r of RES[body]) {
      if (r.km > max[r.band]) max[r.band] = r.km;
      if (inWindow(r.row.jdTT)) {
        if (r.arcsec > maxA) maxA = r.arcsec;
        if (r.auDay > maxV) maxV = r.auDay;
      }
    }
    for (const band of Object.keys(POS_TOL_KM)) {
      assert.ok(POS_TOL_KM[band][body] >= 1.3 * max[band],
        `${body} band ${BAND_LABEL[band]}: tolerance ${POS_TOL_KM[band][body]} km < 1.3 × measured ${max[band].toFixed(2)} km — widen and log in test/fixtures/README.md`);
    }
    assert.ok(ANG_TOL_ARCSEC[body] >= 1.3 * maxA, `${body}: angular tolerance ${ANG_TOL_ARCSEC[body]}″ < 1.3 × measured ${maxA.toFixed(4)}″`);
    assert.ok(VEL_TOL_AU_D[body] >= 1.3 * maxV, `${body}: velocity tolerance ${VEL_TOL_AU_D[body]} < 1.3 × measured ${maxV.toExponential(3)} AU/d`);
  }
});
