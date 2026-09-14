// geometry.js — plan §Verification "geometry" row. Reference values: Horizons geometric (HZG) heliocentric longitudes,
// elongations, separations and parade arcs from the alignment-events research (bq2vila6z.txt §C3, §C4, §C5, §C6), the
// Horizons Earth state of the constants research (bhqes187e.txt §10), the seds/NASA Mars-2003 anchor (§C5) and the
// marker-projection check of the final critique (byf0bzyiw.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris, PLANETS, BODIES } from '../src/astro/ephemeris.js';
import { jdFromCalendar, ttFromUtc } from '../src/astro/time.js';
import { AU_KM, DAY_S, DEG, RAD, LIGHT_TIME_AU_S } from '../src/astro/constants.js';
import {
  helioLongitudeRad, helioLongitudeDeg, geocentricLongitudeRad, lonDeltaSinCos, helioLonDeltaSinCos, geoLonDeltaSinCos,
  geocentric, distanceAu, lightTimeSeconds, orbitalSpeedKmS, distanceTable, DISTANCE_TABLE_PAIRS,
  elongationRad, elongationDeg, elongationSide, elongation, separationRad, separationDeg, separation,
  phaseAngleRad, phaseAngleDeg, paradeArc, geocentricParade, pxRadius, PARADE_MIN_ELONGATION_DEG,
} from '../src/astro/geometry.js';

const eph = createEphemeris(SERIES, { meta: META });

/** States at a UTC calendar instant: jdTT = ttFromUtc(jdUtc) (CLAUDE.md §Time). */
function statesAtUtc(y, mo, d, h = 0, mi = 0, s = 0) {
  return eph.states(ttFromUtc(jdFromCalendar(y, mo, d, h, mi, s)));
}

/** Smallest absolute difference of two angles in degrees, modulo 360. */
function angDiffDeg(a, b) {
  let t = ((a - b) % 360 + 540) % 360 - 180;
  return Math.abs(t);
}

// ---------------------------------------------------------------------------------------------------------------------
// Heliocentric longitudes — HZG, J2000 ecliptic, 0h UT (research §C6), tolerance 0.02° (plan geometry row).
// ---------------------------------------------------------------------------------------------------------------------
const HELIO_LON = [
  { date: [2025, 1, 16], lon: [247.46, 75.23, 115.75, 115.81, 79.31, 349.93, 55.57, 358.88] },
  { date: [2025, 8, 12], lon: [351.09, 48.38, 319.21, 208.66, 97.11, 356.81, 57.93, 0.14] },
  { date: [2026, 6, 9], lon: [189.13, 171.86, 257.83, 22.67, 121.97, 6.92, 61.35, 1.96] },
];

test('helioLongitudeDeg: 24 Horizons heliocentric longitudes (J2000 ecliptic, 0h UT) within 0.02°', () => {
  for (const { date, lon } of HELIO_LON) {
    const S = statesAtUtc(...date);
    PLANETS.forEach((id, i) => {
      const got = helioLongitudeDeg(S, id);
      assert.ok(got >= 0 && got < 360, `${id} longitude in [0, 360)`);
      assert.ok(angDiffDeg(got, lon[i]) <= 0.02,
        `${date.join('-')} ${id}: ${got.toFixed(3)}° vs HZG ${lon[i]}° (tolerance 0.02°, plan geometry row; HZG values are rounded to 0.01°)`);
      assert.ok(Math.abs(helioLongitudeRad(S, id) * RAD - got) < 1e-12, 'Rad and Deg variants agree');
    });
  }
  assert.ok(Number.isNaN(helioLongitudeDeg(statesAtUtc(2025, 1, 16), 'sun')), 'the Sun (origin) has no longitude → NaN');
  assert.throws(() => helioLongitudeDeg(statesAtUtc(2025, 1, 16), 'pluto'), RangeError, 'unknown id throws RangeError');
});

test('longitude-difference sin/cos helpers match atan2 differences and are NaN for a zero projection', () => {
  const S = statesAtUtc(2025, 1, 16);
  const out = { sin: 0, cos: 0 };
  for (const a of PLANETS) {
    for (const b of PLANETS) {
      helioLonDeltaSinCos(S, a, b, out);
      const d = helioLongitudeRad(S, a) - helioLongitudeRad(S, b);
      assert.ok(Math.abs(out.sin - Math.sin(d)) < 1e-12 && Math.abs(out.cos - Math.cos(d)) < 1e-12,
        `helio Δλ(${a}, ${b}) sin/cos from vectors agree with atan2 (1e-12)`);
      if (a === 'earth' || b === 'earth') continue;
      geoLonDeltaSinCos(S, a, b, out);
      const dg = geocentricLongitudeRad(S, a) - geocentricLongitudeRad(S, b);
      assert.ok(Math.abs(out.sin - Math.sin(dg)) < 1e-12 && Math.abs(out.cos - Math.cos(dg)) < 1e-12,
        `geocentric Δλ(${a}, ${b}) sin/cos agree with atan2 (1e-12)`);
    }
  }
  // Sun-relative geocentric difference: λ_☉ = λ_E + 180°, so sin(λ_P − λ_☉) = −sin(λ_P − λ_E) (heliocentric) only
  // approximately (parallax); check the exact identity for the Sun's own geocentric longitude instead.
  const lamSun = geocentricLongitudeRad(S, 'sun'), lamE = helioLongitudeRad(S, 'earth');
  assert.ok(angDiffDeg(lamSun * RAD, lamE * RAD + 180) < 1e-9, 'geocentric λ_☉ = heliocentric λ_E + 180° exactly');
  const z = lonDeltaSinCos(0, 0, 1, 0);
  assert.ok(Number.isNaN(z.sin) && Number.isNaN(z.cos), 'zero projection → NaN, never a spurious sign');
});

// ---------------------------------------------------------------------------------------------------------------------
// Light-time, distances, speeds
// ---------------------------------------------------------------------------------------------------------------------
test('lightTimeSeconds(1) = 499.004783836 s = 8.3167464 min (1e-6)', () => {
  assert.ok(Math.abs(lightTimeSeconds(1) - 499.004783836) < 1e-6,
    `1 AU light-time ${lightTimeSeconds(1)} s vs 499.004783836 s (AU_KM / c, tolerance 1e-6 s, plan geometry row)`);
  assert.ok(Math.abs(lightTimeSeconds(1) / 60 - 8.3167464) < 1e-6,
    `1 AU light-time ${lightTimeSeconds(1) / 60} min vs 8.3167464 min (tolerance 1e-6 min)`);
  assert.equal(lightTimeSeconds(2.5), 2.5 * LIGHT_TIME_AU_S, 'linear in AU');
});

test('Earth–Mars at 2003-08-27 09:51:12 UT = 55,758,006 km ± 200 km (seds/NASA anchor, HZG 55,758,005.7 km)', () => {
  const S = statesAtUtc(2003, 8, 27, 9, 51, 12);
  const km = distanceAu(S, 'earth', 'mars') * AU_KM;
  assert.ok(Math.abs(km - 55758006) <= 200,
    `Earth–Mars ${km.toFixed(0)} km vs 55,758,006 km (tolerance 200 km, plan geometry row; VSOP87 Mars ≈ 20 km, Earth ≈ 13 km vs DE441)`);
  assert.equal(distanceAu(S, 'mars', 'earth'), km / AU_KM, 'distanceAu is symmetric');
  assert.ok(Math.abs(distanceAu(S, 'sun', 'earth') - Math.hypot(S.earth.x, S.earth.y, S.earth.z)) < 1e-15,
    'Sun–Earth distance = |E| (Sun at the origin)');
});

test('Earth velocity 2026-09-13 12:00 TT vs Horizons (4.505139097683805, 29.26763235137217, −1.024894484149996e-3 km/s) within 1e-4 km/s', () => {
  // bhqes187e.txt §10: Earth state 2026-09-13 12:00 TDB, heliocentric ecliptic of J2000, DE441 (|TT − TDB| < 2 ms → < 1e-9 km/s).
  const REF = [4.505139097683805, 29.26763235137217, -1.024894484149996e-3];
  const st = eph.state('earth', 2461297.0);
  const got = [st.vx, st.vy, st.vz].map((v) => v * AU_KM / DAY_S);
  got.forEach((v, i) => assert.ok(Math.abs(v - REF[i]) <= 1e-4,
    `Earth v[${i}] ${v} km/s vs Horizons ${REF[i]} (tolerance 1e-4 km/s per component, plan geometry row)`));
  const speed = orbitalSpeedKmS(st);
  assert.ok(Math.abs(speed - Math.hypot(...REF)) <= 2e-4,
    `orbitalSpeedKmS ${speed} vs |Horizons v| ${Math.hypot(...REF)} (tolerance 2e-4 km/s = √3 · per-component 1e-4, rounded up)`);
  assert.ok(speed > 29.2 && speed < 30.3, 'Earth orbital speed in the 29.3–30.3 km/s range (NSSDC min/max 29.29/30.29)');
});

test('distanceTable: 36 pairs of {Sun, 8 planets}, symmetric, km and light-time consistent, out reuse allocation-free', () => {
  const S = statesAtUtc(2025, 1, 16);
  const rows = distanceTable(S);
  assert.equal(rows.length, 36, 'C(9,2) = 36 pairs');
  assert.equal(DISTANCE_TABLE_PAIRS, 36);
  const seen = new Set();
  for (const r of rows) {
    assert.ok(BODIES.includes(r.a) && BODIES.includes(r.b) && r.a !== r.b, `row ${r.a}–${r.b} names two distinct bodies`);
    assert.ok(BODIES.indexOf(r.a) < BODIES.indexOf(r.b), 'rows are ordered a-before-b in BODIES order (no duplicate reversed pairs)');
    const key = `${r.a}|${r.b}`, rev = `${r.b}|${r.a}`;
    assert.ok(!seen.has(key) && !seen.has(rev), `pair ${key} listed once`);
    seen.add(key);
    assert.equal(r.au, distanceAu(S, r.b, r.a), `symmetric: distanceAu(${r.b}, ${r.a}) equals the row`);
    assert.ok(Math.abs(r.km - r.au * AU_KM) < 1e-6, 'km = AU × 149,597,870.700');
    assert.ok(Math.abs(r.lightSeconds - r.km / 299792.458) < 1e-9, 'light-time = km / 299,792.458 s');
    assert.ok(r.au > 0, 'all distances positive');
  }
  assert.equal(seen.size, 36);
  const sunRows = rows.filter((r) => r.a === 'sun');
  assert.equal(sunRows.length, 8, 'the Sun appears in 8 rows (one per planet)');
  const again = distanceTable(S, rows);
  assert.equal(again, rows, 'out array is returned');
  assert.equal(again[0], rows[0], 'row objects are reused, not reallocated');
});

// ---------------------------------------------------------------------------------------------------------------------
// Elongation, separation, phase angle
// ---------------------------------------------------------------------------------------------------------------------
test('Venus greatest elongation 2025-01-10 04:46 UT: ψ = 47.167° ± 0.01, side E', () => {
  // HZG 2025-01-10 04:46, 47.167° (research §C3, Venus row).
  const S = statesAtUtc(2025, 1, 10, 4, 46);
  const e = elongation(S, 'venus');
  assert.ok(Math.abs(e.psiDeg - 47.167) <= 0.01,
    `Venus elongation ${e.psiDeg.toFixed(4)}° vs HZG 47.167° (tolerance 0.01°, plan geometry row / research §C7)`);
  assert.equal(e.side, 'E', 'eastern (evening) elongation: sin(λ_P − λ_☉) > 0');
  assert.equal(e.psiRad, elongationRad(S, 'venus'));
  assert.equal(e.psiDeg, elongationDeg(S, 'venus'));
  assert.equal(elongationSide(S, 'venus'), 'E');
  // Same value from the Meeus ch. 33 triangle form cos ψ = (R² + Δ² − r²) / (2RΔ).
  const R = distanceAu(S, 'sun', 'earth'), r = distanceAu(S, 'sun', 'venus'), D = distanceAu(S, 'earth', 'venus');
  const psiTri = Math.acos((R * R + D * D - r * r) / (2 * R * D)) * RAD;
  assert.ok(Math.abs(psiTri - e.psiDeg) < 1e-9, 'vector and triangle forms agree (1e-9°)');
  const out = { psiRad: 0, psiDeg: 0, side: null };
  assert.equal(elongation(S, 'venus', out), out, 'out object returned');
});

test('elongation edge cases: Sun → 0 (side W), Earth → NaN/null; Mercury 2025-08-19 09:38 UT is W with ψ ≈ 18.584°', () => {
  const S = statesAtUtc(2025, 8, 19, 9, 38);
  assert.equal(elongationRad(S, 'sun'), 0, 'the Sun has zero elongation');
  assert.equal(elongationSide(S, 'sun'), 'W', 'zero cross product → W by convention');
  assert.ok(Number.isNaN(elongationRad(S, 'earth')), 'Earth has no elongation → NaN');
  assert.equal(elongationSide(S, 'earth'), null);
  const m = elongation(S, 'mercury');
  // HZG greatest western elongation 2025-08-19 09:38, 18.584° (plan events row); the maximum is flat so ±0.01° holds here.
  assert.ok(Math.abs(m.psiDeg - 18.584) <= 0.01, `Mercury GE ${m.psiDeg.toFixed(4)}° vs 18.584° (tolerance 0.01°)`);
  assert.equal(m.side, 'W', 'western (morning) elongation');
  // Side consistency with geocentric ecliptic longitudes: sin(λ_P − λ_☉) < 0 ⇔ W.
  const d = geocentricLongitudeRad(S, 'mercury') - geocentricLongitudeRad(S, 'sun');
  assert.ok(Math.sin(d) < 0, 'sin(λ_Mercury − λ_☉) < 0 for a western elongation');
});

test('separation(venus, jupiter) at 2025-08-12 06:37 UT = 0.860° ± 0.01 (HZG closest approach 51.6′)', () => {
  const S = statesAtUtc(2025, 8, 12, 6, 37);
  const sep = separation(S, 'venus', 'jupiter');
  assert.ok(Math.abs(sep.deg - 0.860) <= 0.01,
    `Venus–Jupiter separation ${sep.deg.toFixed(4)}° vs 0.860° (51.6′; tolerance 0.01°, plan geometry row / research §C4)`);
  assert.ok(Math.abs(sep.arcmin - 51.6) <= 0.6, `${sep.arcmin.toFixed(2)}′ vs 51.6′ (tolerance 0.6′ = 0.01°)`);
  assert.equal(sep.rad, separationRad(S, 'venus', 'jupiter'));
  assert.equal(sep.deg, separationDeg(S, 'venus', 'jupiter'));
  assert.equal(separationRad(S, 'jupiter', 'venus'), sep.rad, 'symmetric');
  assert.equal(separationRad(S, 'venus', 'venus'), 0, 'self separation is exactly 0 (atan2(0, +) form)');
  assert.ok(Math.abs(separationDeg(S, 'sun', 'venus') - elongationDeg(S, 'venus')) < 1e-12,
    'separation from the Sun equals the elongation');
});

test('angleBetween-based separation is stable at 0.001″ (no acos cancellation)', () => {
  // Synthetic states: two bodies 1 AU from Earth (at the origin here: E = 0 → g = P) separated by 0.001″.
  const tiny = 0.001 / 3600 * DEG; // 0.001 arcsecond in radians ≈ 4.85e-9
  const S = {
    sun: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    earth: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    a: { x: 1, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    b: { x: Math.cos(tiny), y: Math.sin(tiny), z: 0, vx: 0, vy: 0, vz: 0 },
  };
  const got = separationRad(S, 'a', 'b');
  assert.ok(Math.abs(got - tiny) / tiny < 1e-6, `0.001″ separation recovered to 1e-6 relative (got ${got}, want ${tiny})`);
  const acosForm = Math.acos(S.b.x); // the naive form loses ≈ 3 digits here
  assert.ok(Math.abs(got - tiny) <= Math.abs(acosForm - tiny) + 1e-30, 'atan2 form is at least as accurate as acos');
});

test('phaseAngle: Sun–planet–Earth triangle identity; Venus inferior ≈ 168°, superior ≈ 1°; Mars 2003 opposition ≈ 5°; Sun/Earth → NaN', () => {
  // NB: eph.states() memoises ONE object and overwrites it in place for a new instant, so evaluate each instant before
  // requesting the next (or pass an `out`).
  // Sun–planet–Earth triangle: phase angle i + elongation ψ + angle at the Sun (Earth–Sun–planet) = 180° exactly.
  function triangleCheck(S, id, label) {
    const i = phaseAngleDeg(S, id), psi = elongationDeg(S, id);
    const P = [S[id].x, S[id].y, S[id].z], E = [S.earth.x, S.earth.y, S.earth.z];
    const atSun = Math.atan2(Math.hypot(P[1] * E[2] - P[2] * E[1], P[2] * E[0] - P[0] * E[2], P[0] * E[1] - P[1] * E[0]),
      P[0] * E[0] + P[1] * E[1] + P[2] * E[2]) * RAD;
    assert.ok(Math.abs(i + psi + atSun - 180) < 1e-9, `${label}: i ${i.toFixed(3)} + ψ ${psi.toFixed(3)} + Sun angle ${atSun.toFixed(3)} = 180° (1e-9°)`);
    return i;
  }
  // Venus inferior conjunction 2025-03-23 01:01 UT (plan events row): Venus passed ≈ 8.4° north of the Sun, so
  // i ≈ 180° − 8.4° − 3.3° ≈ 168° (not 180°); superior conjunction 2026-01-06 15:56 UT: i ≈ 1°.
  const iInf = triangleCheck(statesAtUtc(2025, 3, 23, 1, 1), 'venus', 'inferior conjunction');
  const iSup = triangleCheck(statesAtUtc(2026, 1, 6, 15, 56), 'venus', 'superior conjunction');
  assert.ok(iInf > 160 && iInf < 180, `phase angle at inferior conjunction ${iInf.toFixed(2)}° in (160°, 180°) — Venus 8.4° from the Sun`);
  assert.ok(iSup < 5, `phase angle at superior conjunction ${iSup.toFixed(2)}° < 5°`);
  const Sopp = statesAtUtc(2003, 8, 28, 17, 51);  // Mars opposition 2003
  // Research §C5: HZG max ψ = 173.38° for the 2003 opposition (Mars ≈ 1.8° south of the ecliptic), so i ≈ 180 − 173.4 − 1.8 ≈ 5°.
  const iOpp = triangleCheck(Sopp, 'mars', 'Mars opposition 2003');
  assert.ok(iOpp > 3 && iOpp < 7, `Mars phase angle at the 2003 opposition ${iOpp.toFixed(2)}° in (3°, 7°) — ψ_max 173.38° (research §C5)`);
  // Triangle identity (Meeus ch. 41): cos i = (r² + Δ² − R²) / (2rΔ).
  const r = distanceAu(Sopp, 'sun', 'mars'), D = distanceAu(Sopp, 'earth', 'mars'), R = distanceAu(Sopp, 'sun', 'earth');
  const iTri = Math.acos((r * r + D * D - R * R) / (2 * r * D));
  assert.ok(Math.abs(iTri - phaseAngleRad(Sopp, 'mars')) < 1e-9, 'vector and triangle forms agree');
  assert.ok(Number.isNaN(phaseAngleRad(Sopp, 'sun')) && Number.isNaN(phaseAngleRad(Sopp, 'earth')), 'undefined for Sun and Earth');
});

test('geocentric: P − E, −E for the Sun, zero for Earth, out reuse', () => {
  const S = statesAtUtc(2025, 1, 16);
  const g = geocentric(S, 'mars');
  assert.deepEqual(g, [S.mars.x - S.earth.x, S.mars.y - S.earth.y, S.mars.z - S.earth.z]);
  assert.deepEqual(geocentric(S, 'sun'), [-S.earth.x, -S.earth.y, -S.earth.z]);
  assert.deepEqual(geocentric(S, 'earth'), [0, 0, 0]);
  const out = [1, 2, 3];
  assert.equal(geocentric(S, 'venus', out), out);
});

// ---------------------------------------------------------------------------------------------------------------------
// Parades
// ---------------------------------------------------------------------------------------------------------------------
test('paradeArc: k=8 2024-11-23 0h UT = 102.1° ± 0.5; k=4 2026-05-06 = 4.0° {mercury, mars, saturn, neptune}; k=3 2025-03-25 = 1.2° {mercury, venus, earth}', () => {
  // HZG daily-grid minima, research §C6 "Heliocentric parade local minima" (tolerance ±0.5° / ±0.3°, plan geometry row).
  const p8 = paradeArc(statesAtUtc(2024, 11, 23), 8);
  assert.ok(Math.abs(p8.arcDeg - 102.1) <= 0.5, `all-8 arc ${p8.arcDeg.toFixed(2)}° vs HZG 102.1° (tolerance 0.5°)`);
  assert.deepEqual([...p8.members].sort(), [...PLANETS].sort(), 'k=8 lists every planet');

  const p4 = paradeArc(statesAtUtc(2026, 5, 6), 4);
  assert.ok(Math.abs(p4.arcDeg - 4.0) <= 0.3, `k=4 arc ${p4.arcDeg.toFixed(2)}° vs HZG 4.0° (tolerance 0.3°)`);
  assert.deepEqual([...p4.members].sort(), ['mars', 'mercury', 'neptune', 'saturn'], 'k=4 members');

  const p3 = paradeArc(statesAtUtc(2025, 3, 25), 3);
  assert.ok(Math.abs(p3.arcDeg - 1.2) <= 0.3, `k=3 arc ${p3.arcDeg.toFixed(2)}° vs HZG 1.2° (tolerance 0.3°)`);
  assert.deepEqual([...p3.members].sort(), ['earth', 'mercury', 'venus'], 'k=3 members');
});

test('paradeArc invariants: monotone in k, k=1 → 0°, k=8 = 360° − largest gap, brute force agreement, out reuse, bad k throws', () => {
  const S = statesAtUtc(2025, 2, 17);
  const lon = PLANETS.map((id) => helioLongitudeDeg(S, id));
  let prev = -1;
  for (let k = 1; k <= 8; k++) {
    const p = paradeArc(S, k);
    assert.equal(p.members.length, k);
    assert.ok(p.arcDeg >= prev, `arc is non-decreasing in k (k=${k}: ${p.arcDeg} ≥ ${prev})`);
    prev = p.arcDeg;
    // Brute force: over all C(8,k) subsets, the smallest circular span.
    let best = Infinity;
    const n = 8;
    for (let mask = 0; mask < 1 << n; mask++) {
      let cnt = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) cnt++;
      if (cnt !== k) continue;
      const sel = lon.filter((_, i) => mask & (1 << i)).sort((a, b) => a - b);
      let maxGap = 0;
      for (let i = 0; i < k; i++) {
        const gap = ((sel[(i + 1) % k] - sel[i]) + 360) % 360;
        if (k === 1) { maxGap = 360; break; }
        if (gap > maxGap) maxGap = gap;
      }
      best = Math.min(best, 360 - maxGap);
    }
    assert.ok(Math.abs(p.arcDeg - best) < 1e-9, `k=${k}: circular window ${p.arcDeg} = brute-force ${best}`);
    // Members actually span the reported arc: their longitudes fit inside [start, start + arc].
    const start = helioLongitudeDeg(S, p.members[0]);
    for (const id of p.members) {
      const off = ((helioLongitudeDeg(S, id) - start) + 360) % 360;
      assert.ok(off <= p.arcDeg + 1e-9, `${id} lies within the arc starting at ${p.members[0]}`);
    }
  }
  assert.equal(paradeArc(S, 1).arcDeg, 0);
  const out = { arcDeg: 0, members: ['x'] };
  assert.equal(paradeArc(S, 5, out), out, 'out returned');
  assert.equal(out.members.length, 5, 'members refilled in place');
  assert.throws(() => paradeArc(S, 0), RangeError);
  assert.throws(() => paradeArc(S, 9), RangeError);
  assert.throws(() => paradeArc(S, 2.5), RangeError);
});

test('geocentricParade 2025-02-28 18:00 UT ("seven-planet parade"): ≥ 4 evening-side planets; consistent with elongation()', () => {
  const S = statesAtUtc(2025, 2, 28, 18);
  const gp = geocentricParade(S);
  assert.ok(gp.evening.length >= 4, `evening side has ${gp.evening.length} planets with ψ > 10° (${gp.evening.join(', ')}); plan asks ≥ 4`);
  assert.equal(PARADE_MIN_ELONGATION_DEG, 10);
  for (const id of PLANETS) {
    if (id === 'earth') continue;
    const e = elongation(S, id);
    const listed = gp.evening.includes(id) || gp.morning.includes(id);
    assert.equal(listed, e.psiDeg > 10, `${id} listed iff ψ ${e.psiDeg.toFixed(2)}° > 10°`);
    if (listed) assert.ok((e.side === 'E' ? gp.evening : gp.morning).includes(id), `${id} on side ${e.side}`);
  }
  assert.ok(!gp.evening.includes('earth') && !gp.morning.includes('earth'), 'Earth excluded');
  // Threshold parameter: at 0° every planet is listed on one side; at 180° none.
  const all = geocentricParade(S, 0);
  assert.equal(all.evening.length + all.morning.length, 7);
  const none = geocentricParade(S, 180);
  assert.equal(none.evening.length + none.morning.length, 0);
  const out = { evening: ['x'], morning: ['y'] };
  assert.equal(geocentricParade(S, 10, out), out, 'out returned, arrays refilled');
  assert.deepEqual(out.evening, gp.evening);
});

// ---------------------------------------------------------------------------------------------------------------------
// Marker projection
// ---------------------------------------------------------------------------------------------------------------------
test('pxRadius(R=1, d=100, fov 50°, H=1000) = 10.72 ± 0.01 px; inside-sphere guard', () => {
  const px = pxRadius(1, 100, 50 * DEG, 1000);
  assert.ok(Math.abs(px - 10.72) <= 0.01, `pxRadius ${px.toFixed(4)} px vs 10.72 (tolerance 0.01 px, plan geometry row / final critique)`);
  assert.equal(pxRadius(1, 0.5, 50 * DEG, 1000), pxRadius(1, 1.0001, 50 * DEG, 1000), 'd < 1.0001 R is clamped to 1.0001 R');
  assert.ok(Number.isFinite(pxRadius(1, 0, 50 * DEG, 1000)), 'finite at d = 0');
});
