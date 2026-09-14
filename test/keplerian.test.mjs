// Tests for src/astro/keplerian.js — the JPL Standish & Williams Keplerian approximation used as an independent,
// test-only cross-check of the VSOP87 ephemeris. Sources: https://ssd.jpl.nasa.gov/planets/approx_pos.html
// (recipe, Tables 1/2a/2b, nominal-error table) transcribed in the ephemeris research b4iv6z9la.txt §7.1–7.5;
// Horizons Mars (499) J2000 vector and the 8,193 km figure from §7.2; T1-vs-T2 J2000 differences from the final
// critique byf0bzyiw.txt (Verification › keplerian).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveKepler, elements, position, selectTable, BODY_KEYS, TABLE_1, TABLE_2A, TABLE_2B, TABLE_1_JD_MIN, TABLE_1_JD_MAX,
} from '../src/astro/keplerian.js';
import { SERIES } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import { jdFromCalendar } from '../src/astro/time.js';
import { AU_KM, DEG, RAD, J2000 } from '../src/astro/constants.js';
import { norm, sub, angleBetween } from '../src/astro/vec.js';

const eph = createEphemeris(SERIES);

/** Heliocentric ecliptic longitude/latitude (degrees) and range (AU) of a scene/J2000-ecliptic vector. */
function spherical(p) {
  const r = norm(p);
  return { lon: Math.atan2(p[1], p[0]) * RAD, lat: Math.asin(p[2] / r) * RAD, r };
}

/** Signed difference of two longitudes in degrees, wrapped to (−180, 180]. */
function dLon(a, b) {
  let d = (a - b) % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
}

/**
 * Max |Δλ|″, |Δφ|″, |Δρ| km between Keplerian (table) and VSOP87 (ephemeris.js, scene frame) over a year list.
 * 'earth' compares JPL's EM barycentre with VSOP87A's Earth geocentre (Moon offset ≤ 4,670 km ≈ 6.4″ at 1 AU).
 */
function maxResiduals(body, table, years) {
  const out = { lon: 0, lonYear: 0, lat: 0, latYear: 0, r: 0, rYear: 0 };
  for (const y of years) {
    const jd = jdFromCalendar(y, 1, 1, 12); // Jan 1 12h TT, proleptic Gregorian (both sides use the same JD)
    const k = spherical(position(body, jd, table));
    const v = spherical(eph.position(body, jd));
    const dl = Math.abs(dLon(k.lon, v.lon)) * 3600;
    const df = Math.abs(k.lat - v.lat) * 3600;
    const dr = Math.abs(k.r - v.r) * AU_KM;
    if (dl > out.lon) { out.lon = dl; out.lonYear = y; }
    if (df > out.lat) { out.lat = df; out.latYear = y; }
    if (dr > out.r) { out.r = dr; out.rYear = y; }
  }
  return out;
}

function fmtRow(body, m) {
  return `${body.padEnd(8)} λ ${m.lon.toFixed(2).padStart(8)}″ @${String(m.lonYear).padStart(5)}  φ ${m.lat.toFixed(2).padStart(7)}″ @${String(m.latYear).padStart(5)}  ρ ${m.r.toFixed(0).padStart(9)} km @${String(m.rYear).padStart(5)}`;
}

test('tables are complete, verbatim-shaped and frozen', () => {
  for (const tbl of [TABLE_1, TABLE_2A]) {
    assert.deepEqual(Object.keys(tbl), BODY_KEYS, 'eight planets, table order');
    for (const b of BODY_KEYS) {
      assert.equal(tbl[b].x0.length, 6); assert.equal(tbl[b].rate.length, 6);
      assert.ok(Object.isFrozen(tbl[b].x0) && Object.isFrozen(tbl[b].rate));
    }
  }
  assert.deepEqual(Object.keys(TABLE_2B), ['jupiter', 'saturn', 'uranus', 'neptune'], 'Table 2b: Jupiter–Neptune only');
  // Spot values quoted in the VSOP87 proof-of-concept report (bsiou1mfc.txt §9) and research §7.3–7.5.
  assert.deepEqual(TABLE_1.mercury.x0, [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593]);
  assert.deepEqual(TABLE_1.mercury.rate, [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]);
  assert.deepEqual(TABLE_2A.mercury.x0, [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819]);
  assert.deepEqual(TABLE_2B.jupiter, { b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000 });
  assert.equal(TABLE_1.earth.x0[5], 0.0, 'Table 1 EM Bary Ω = 0.0 (verbatim)');
});

test('solveKepler(30°, 0.2) = 36.876559° (research §7.1 recipe; critique-verified value)', () => {
  const E = solveKepler(30, 0.2);
  assert.ok(Math.abs(E - 36.876559) < 1e-6, `E = ${E}° within 1e-6° of 36.876559°`);
  // Residual M − (E − e* sin E) ≤ 1e-9° over an (M, e) grid, e ≤ 0.25 (Mercury's 0.2056 is the largest planet value).
  let worst = 0;
  for (let e = 0; e <= 0.25 + 1e-12; e += 0.01) {
    const eStar = e * RAD;
    for (let M = -180; M <= 180; M += 2.5) {
      const Ed = solveKepler(M, e);
      const res = Math.abs(dLon(M, Ed - eStar * Math.sin(Ed * DEG))); // wrapped: M = −180 solves as +180
      if (res > worst) worst = res;
    }
  }
  assert.ok(worst < 1e-9, `max Kepler residual ${worst.toExponential(2)}° < 1e-9° (task spec) over M ∈ [−180, 180] step 2.5°, e ∈ [0, 0.25] step 0.01`);
  // Wrapping: M outside (−180, 180] is equivalent modulo 360°.
  assert.ok(Math.abs(solveKepler(390, 0.2) - solveKepler(30, 0.2)) < 1e-9, 'M is wrapped to (−180, 180] before solving');
  assert.equal(solveKepler(0, 0.1), 0, 'E(0) = 0');
});

test('R_z(Ω)·R_x(I)·R_z(ω) matches the three explicit JPL formulas (approx_pos.html step 5)', () => {
  // Reproduce step 5 verbatim for one instant and compare to position() (which uses vec.js rotations).
  for (const body of BODY_KEYS) {
    const jd = J2000 + 1234.5;
    const el = elements(body, jd, 1);
    const E = solveKepler(el.M, el.e) * DEG;
    const xp = el.a * (Math.cos(E) - el.e), yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    const w = el.omega * DEG, O = el.Omega * DEG, I = el.I * DEG;
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
    const ref = [
      (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      (sw * sI) * xp + (cw * sI) * yp,
    ];
    const p = position(body, jd, 1);
    assert.ok(norm(sub(p, ref)) < 1e-14 * norm(ref), `${body}: vec.js rotation product equals the JPL formulas to 1e-14 relative`);
  }
});

test('selectTable: Table 1 inside 1800–2050, Table 2a+2b outside; explicit override; errors', () => {
  assert.equal(TABLE_1_JD_MIN, jdFromCalendar(1800, 1, 1), '1800-01-01 0h');
  assert.equal(TABLE_1_JD_MAX, jdFromCalendar(2051, 1, 1), '2051-01-01 0h');
  assert.equal(selectTable(J2000), 1);
  assert.equal(selectTable(jdFromCalendar(1799, 12, 31, 23)), 2);
  assert.equal(selectTable(jdFromCalendar(2051, 1, 1)), 2);
  assert.equal(elements('mars', J2000).table, 1);
  assert.equal(elements('mars', J2000, 2).table, 2);
  assert.equal(elements('mars', jdFromCalendar(-3000, 1, 1)).table, 2);
  assert.throws(() => elements('pluto', J2000), RangeError, 'Pluto is not transcribed (out of scope)');
  assert.throws(() => elements('mars', J2000, 3), RangeError);
  // Table 2b terms are applied only with Table 2 and only for Jupiter–Neptune.
  const T = 0.5, jd = J2000 + T * 36525;
  const j2 = elements('jupiter', jd, 2), j1 = elements('jupiter', jd, 1);
  const b = TABLE_2B.jupiter;
  const extra = b.b * T * T + b.c * Math.cos(b.f * T * DEG) + b.s * Math.sin(b.f * T * DEG);
  const m2NoExtra = dLon(j2.L - j2.varpi, 0);
  assert.ok(Math.abs(dLon(j2.M, m2NoExtra + extra)) < 1e-9, 'Jupiter Table 2: M = L − ϖ + bT² + c cos fT + s sin fT');
  assert.ok(Math.abs(dLon(j1.M, j1.L - j1.varpi)) < 1e-9, 'Jupiter Table 1: M = L − ϖ (no 2b terms)');
  const m2 = elements('mars', jd, 2);
  assert.ok(Math.abs(dLon(m2.M, m2.L - m2.varpi)) < 1e-9, 'Mars Table 2: no 2b terms');
});

test('Mars Table 1 at J2000 vs Horizons 499 = 8,193 km (research §7.2 in-session check, ±30 km)', () => {
  // Horizons 499 (Mars geocentre), CENTER 500@10, Ecliptic of J2000.0, JD 2451545.0 TT, from the research report.
  const horizons = [1.390715921745786, -0.01341631816379798, -0.03446766277607193];
  const p = position('mars', J2000, 1);
  const dKm = norm(sub(p, horizons)) * AU_KM;
  assert.ok(Math.abs(dKm - 8193) < 30, `|Δ| = ${dKm.toFixed(1)} km, expected 8,193 ± 30 km (research §7.2 measured value)`);
  assert.equal(elements('mars', J2000).table, 1, "'auto' picks Table 1 at J2000");
  const auto = position('mars', J2000);
  assert.deepEqual(auto, p, "position(body, jd) 'auto' equals the explicit Table 1 result");
});

test('Table 1 vs Table 2a+2b at J2000 reproduce the final critique\'s cross-table differences (transcription check)', () => {
  // byf0bzyiw.txt: "Mercury 3.9″, Venus 12.4″, EMB 9.5″, Mars 88.5″ (89,300 km), Jupiter 178″ (644,000 km),
  // Saturn 636″ (4.28e6 km), Uranus 249″ (4.79e6 km), Neptune 30″" — computed from the same verbatim tables; a
  // single mistyped digit in either table breaks at least one of these.
  const expected = { mercury: 3.9, venus: 12.4, earth: 9.5, mars: 88.5, jupiter: 178, saturn: 636, uranus: 249, neptune: 30 };
  // The critique quotes one decimal for Mercury–Mars and whole arcseconds for Jupiter–Neptune: allow half a unit of
  // the quoted precision plus 0.5 % (its Kepler solution was iterated to 1e-15).
  const quotedHalfUnit = { mercury: 0.05, venus: 0.05, earth: 0.05, mars: 0.05, jupiter: 0.5, saturn: 0.5, uranus: 0.5, neptune: 0.5 };
  const expectedKm = { mars: 89300, jupiter: 644000, saturn: 4.28e6, uranus: 4.79e6 };
  for (const body of BODY_KEYS) {
    const p1 = position(body, J2000, 1), p2 = position(body, J2000, 2);
    const sep = angleBetween(p1, p2) * RAD * 3600;
    assert.ok(Math.abs(sep - expected[body]) <= quotedHalfUnit[body] + 0.005 * expected[body],
      `${body}: T1–T2 separation ${sep.toFixed(2)}″ vs critique ${expected[body]}″ (±${quotedHalfUnit[body]}″ + 0.5 %)`);
    if (expectedKm[body] !== undefined) {
      const km = norm(sub(p1, p2)) * AU_KM;
      assert.ok(Math.abs(km - expectedKm[body]) <= 0.005 * expectedKm[body], `${body}: ${km.toFixed(0)} km vs critique ${expectedKm[body]} (±0.5 %)`);
    }
  }
});

// Tolerances: 2× JPL's nominal 1800–2050 column (λ″ / φ″ / ρ km), plan §Verification keplerian row; Earth adds the
// Moon's 7″ / 4,670 km offset since VSOP87A gives the geocentre while JPL's row is the EM barycentre.
// Where the measured maximum exceeds the plan value, the tolerance is 1.5× the measured maximum (task rule): the JPL
// nominal errors are quoted against the ephemeris the tables were fitted to (DE200/DE405 era), and the recipe and
// transcription are proven by the Mars 8,193 km and T1-vs-T2 tests above, so the excess is a property of the tables
// (DE441 Neptune/Uranus differ from the old fit by tens of arcseconds), not of this implementation.
const TABLE1_TOL = {
  //           λ″       φ″      ρ km
  mercury: { lon: 30, lat: 4.67, r: 2000, note: { lat: 'measured 3.11″ (2016) > plan 2″ → 1.5× measured' } },
  venus: { lon: 40, lat: 2, r: 8000 },
  earth: { lon: 47, lat: 16, r: 12000 }, // EMB vs geocentre
  mars: { lon: 128, lat: 4, r: 50000, note: { lon: 'measured 85.33″ (1861) > plan 80″ → 1.5× measured' } },
  jupiter: { lon: 800, lat: 20, r: 1.2e6 },
  saturn: { lon: 1200, lat: 50, r: 3e6 },
  uranus: { lon: 182, lat: 4, r: 3.43e6, note: { lon: 'measured 121.03″ (1883) > plan 100″ → 1.5× measured', r: 'measured 2,288,606 km (1804) > plan 2e6 → 1.5× measured' } },
  neptune: { lon: 91, lat: 2, r: 2.37e6, note: { lon: 'measured 60.54″ (1840) > plan 20″ → 1.5× measured (Table 1 Neptune is 45″ from Horizons DE441 even at J2000)', r: 'measured 1,576,561 km (1984) > plan 4e5 → 1.5× measured' } },
};

test('Table 1 vs VSOP87 yearly 1800–2050 within 2× JPL nominal errors (or 1.5× measured where the nominal column is optimistic)', (t) => {
  const years = []; for (let y = 1800; y <= 2050; y++) years.push(y);
  const lines = [];
  for (const body of BODY_KEYS) {
    const m = maxResiduals(body, 1, years);
    lines.push(fmtRow(body, m));
    const tol = TABLE1_TOL[body], note = tol.note ?? {};
    assert.ok(m.lon <= tol.lon, `${body} λ: max ${m.lon.toFixed(2)}″ (${m.lonYear}) ≤ ${tol.lon}″ — ${note.lon ?? '2× JPL 1800–2050 nominal'}`);
    assert.ok(m.lat <= tol.lat, `${body} φ: max ${m.lat.toFixed(2)}″ (${m.latYear}) ≤ ${tol.lat}″ — ${note.lat ?? '2× JPL 1800–2050 nominal'}`);
    assert.ok(m.r <= tol.r, `${body} ρ: max ${m.r.toFixed(0)} km (${m.rYear}) ≤ ${tol.r} km — ${note.r ?? '2× JPL 1800–2050 nominal'}`);
  }
  t.diagnostic('Table 1 vs VSOP87, yearly 1800–2050 (max |Δλ|, |Δφ|, |Δρ|):\n' + lines.join('\n'));
});

// 2× JPL's nominal 3000 BC – 3000 AD column (λ″ / φ″ / ρ 1000 km ×2): Mercury 40/30/2,000; Venus 80/60/16,000;
// EM Bary 80+7/30/30,000; Mars 200/80/60,000; Jupiter 1,200/200/2e6; Saturn 2,000/200/8e6; Uranus 4,000/60/1.6e7;
// Neptune 800/30/8e6 (research §7.2). The comparison is clamped to −3000…+3000 (VSOP87 is only guaranteed to ±4000 y).
const TABLE2_TOL = {
  mercury: { lon: 40, lat: 30, r: 2000 },
  venus: { lon: 80, lat: 105, r: 16000, note: { lat: 'measured 69.97″ (3000) > plan 60″ → 1.5× measured' } },
  earth: { lon: 87, lat: 30, r: 30000 }, // EMB vs geocentre (+7″ in λ)
  mars: { lon: 200, lat: 80, r: 60000 },
  jupiter: { lon: 1200, lat: 200, r: 2e6 },
  saturn: { lon: 2000, lat: 200, r: 8e6 },
  uranus: { lon: 4000, lat: 60, r: 1.6e7 },
  neptune: { lon: 800, lat: 30, r: 8e6 },
};

test('Tables 2a+2b vs VSOP87 every 50 years −3000…+3000 within 2× JPL long-range nominal errors (or 1.5× measured)', (t) => {
  const years = []; for (let y = -3000; y <= 3000; y += 50) years.push(y);
  const lines = [];
  for (const body of BODY_KEYS) {
    const m = maxResiduals(body, 2, years);
    lines.push(fmtRow(body, m));
    const tol = TABLE2_TOL[body], note = tol.note ?? {};
    assert.ok(m.lon <= tol.lon, `${body} λ: max ${m.lon.toFixed(2)}″ (${m.lonYear}) ≤ ${tol.lon}″ — ${note.lon ?? '2× JPL 3000 BC–3000 AD nominal'}`);
    assert.ok(m.lat <= tol.lat, `${body} φ: max ${m.lat.toFixed(2)}″ (${m.latYear}) ≤ ${tol.lat}″ — ${note.lat ?? '2× JPL 3000 BC–3000 AD nominal'}`);
    assert.ok(m.r <= tol.r, `${body} ρ: max ${m.r.toFixed(0)} km (${m.rYear}) ≤ ${tol.r} km — ${note.r ?? '2× JPL 3000 BC–3000 AD nominal'}`);
  }
  t.diagnostic('Tables 2a+2b vs VSOP87, every 50 y −3000…+3000 (max |Δλ|, |Δφ|, |Δρ|):\n' + lines.join('\n'));
});

test('position() honours the out parameter and allocates nothing for the caller', () => {
  const out = [0, 0, 0];
  const r = position('venus', J2000, 'auto', out);
  assert.equal(r, out);
  assert.ok(Math.abs(norm(out) - 0.72) < 0.01, 'Venus at ≈ 0.72 AU');
});
