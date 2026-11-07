// eclipses.js + the lunar kinds of events.js — solar and lunar eclipses from the shadow-axis geometry, lunar phases,
// perigee/apogee. References:
//  - the 7 greatest-eclipse instants of test/fixtures/horizons/moon.json (NASA GSFC Five Millennium Canon, TD) with the
//    Canon's γ and magnitudes (https://eclipse.gsfc.nasa.gov/SEcat5/SE2001-2100.html, …/LEcat5/LE2001-2100.html;
//    hand-entered below) — brief: found within 6 min, classified, γ within 0.02;
//  - Meeus, Astronomical Algorithms ch. 49 Examples 49.a (New Moon 1977 Feb 18 03:37:42 TD, JDE 2443192.65118) and 49.b
//    (Last Quarter 2044 Jan 21 23:48:17 TD, JDE 2467636.49186) and the USNO phase table (aa.usno.navy.mil/data/MoonPhases);
//  - test/fixtures/horizons/moon-apsides-2025.json (perigees/apogees from hourly Horizons ranges).
// Measured 2026-11-06: eclipse instants ≤ 1.31 min from the Canon, |Δγ| ≤ 0.0003, solar magnitude ≤ 0.001, lunar
// umbral magnitude ≤ 0.004 (Danjon rule), penumbral ≤ 0.005; phases: Meeus 49.a +5 s, 49.b +4 s, USNO ≤ 0.42 min;
// apsides ≤ 10.5 min and ≤ 41 km from Horizons (the Meeus ch. 47 radial-velocity error on a flat extremum);
// one-year scan all kinds vs the legacy kinds: +10.4 % (brief: < 30 %).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import { moonState } from '../src/astro/moon.js';
import {
  EARTH_RADIUS_KM, MOON_RADIUS_ER, DANJON_ENLARGEMENT, CENTRAL_LIMIT, solarEclipseGeometry, lunarEclipseGeometry,
  classifySolar, classifyLunar, solarMagnitude, isCentral, newSolarGeometry, newLunarGeometry,
} from '../src/astro/eclipses.js';
import { findEvents, KINDS, LUNAR_KINDS, MERGE_WINDOWS_D, notabilityScore, labelFor, SUPERMOON_MAX_DIST_KM } from '../src/astro/events.js';
import { SEASON_KINDS } from '../src/astro/seasons.js';
import { jdFromCalendar, ttFromUtc, calendarFromJd } from '../src/astro/time.js';
import { AU_KM, SUN_RADIUS_KM } from '../src/astro/constants.js';

const eph = createEphemeris(SERIES, { meta: META });
const MOON_FX = JSON.parse(readFileSync(new URL('./fixtures/horizons/moon.json', import.meta.url), 'utf8'));
const APSIDES_FX = JSON.parse(readFileSync(new URL('./fixtures/horizons/moon-apsides-2025.json', import.meta.url), 'utf8'));

/**
 * NASA Five Millennium Canon values at greatest eclipse (SE2001-2100 / LE2001-2100 pages): γ (Earth radii, + north),
 * eclipse magnitude (solar) or umbral & penumbral magnitudes (lunar), type.
 */
const CANON = {
  'solar-2017-08-21': { type: 'total', gamma: 0.4367, magnitude: 1.0306, td: [2017, 8, 21, 18, 26, 40] },
  'solar-2019-07-02': { type: 'total', gamma: -0.6466, magnitude: 1.0459, td: [2019, 7, 2, 19, 24, 7] },
  'solar-2024-04-08': { type: 'total', gamma: 0.3431, magnitude: 1.0566, td: [2024, 4, 8, 18, 18, 29] },
  'solar-2026-08-12': { type: 'total', gamma: 0.8977, magnitude: 1.0386, td: [2026, 8, 12, 17, 47, 6] },
  'lunar-2022-11-08': { type: 'total', gamma: 0.2570, umbral: 1.3589, penumbral: 2.4143, td: [2022, 11, 8, 11, 0, 22] },
  'lunar-2025-03-14': { type: 'total', gamma: 0.3484, umbral: 1.1784, penumbral: 2.2595, td: [2025, 3, 14, 6, 59, 56] },
  'lunar-2025-09-07': { type: 'total', gamma: -0.2752, umbral: 1.3619, penumbral: 2.3440, td: [2025, 9, 7, 18, 12, 58] },
};
/**
 * The Canon's "TD of greatest eclipse" instants above (hand-entered from the two catalogue pages) are ≈ 69 s LATER
 * than the `jdTT` of the corresponding moon.json rows for six of the seven eclipses (2017-08-21 agrees): the fixture
 * generator took the eclipse pages' UT instants as TD. The Horizons vectors in moon.json are self-consistent for the JDs
 * actually requested, so moon.js' verification stands; the eclipse detector is compared with both — the brief's 6 min
 * against moon.json, and the Canon's TD against which our greatest-eclipse instants agree to ≤ 10 s.
 */
const INSTANT_TOL_MIN = 6, CANON_TD_TOL_S = 30, GAMMA_TOL = 0.02, SOLAR_MAG_TOL = 0.02, LUNAR_MAG_TOL = 0.03;

function fmt(jd) {
  const c = calendarFromJd(jd);
  const p = (n) => String(n).padStart(2, '0');
  return `${c.year}-${p(c.month)}-${p(c.day)} ${p(c.hour)}:${p(c.minute)}:${p(c.second)}`;
}

/** Scan cache keyed by window. */
const cache = new Map();
function scan(jd0, jd1, kinds) {
  const key = `${jd0}:${jd1}:${kinds ? kinds.join(',') : 'all'}`;
  if (!cache.has(key)) cache.set(key, findEvents(eph, jd0, jd1, kinds ? { kinds } : {}));
  return cache.get(key);
}
function nearest(events, kind, jdTT) {
  let best = null, bd = Infinity;
  for (const e of events) {
    if (e.kind !== kind) continue;
    const d = Math.abs(e.jdTT - jdTT);
    if (d < bd) { bd = d; best = e; }
  }
  return { best, dMin: bd * 1440 };
}

// ---------------------------------------------------------------------------------------------------------------------
// The seven Canon eclipses
// ---------------------------------------------------------------------------------------------------------------------
test('the 7 Canon eclipses are found within 6 min of the moon.json instants (30 s of the Canon TD), classified, γ within 0.02 and magnitudes within 0.02/0.03 (measured 1.3 min / 10 s, 0.0003, 0.001/0.004)', (t) => {
  let worstT = 0, worstG = 0, worstTd = 0;
  for (const row of MOON_FX.eclipses) {
    const ref = CANON[row.label];
    assert.ok(ref, `${row.label} has Canon values`);
    const kind = row.label.startsWith('solar') ? 'solar-eclipse' : 'lunar-eclipse';
    const { best, dMin } = nearest(scan(row.jdTT - 20, row.jdTT + 20, [kind]), kind, row.jdTT);
    assert.ok(best, `${row.label}: a ${kind} event exists within ±20 d`);
    assert.ok(dMin <= INSTANT_TOL_MIN, `${row.label}: greatest eclipse ${fmt(best.jdTT)} TT vs moon.json ${row.calendar} (Δ = ${dMin.toFixed(2)} min > ${INSTANT_TOL_MIN} min, brief)`);
    const dTd = (best.jdTT - jdFromCalendar(...ref.td)) * 86400;
    assert.ok(Math.abs(dTd) <= CANON_TD_TOL_S, `${row.label}: greatest eclipse ${fmt(best.jdTT)} TT vs Canon TD ${ref.td.slice(3).join(':')} (Δ = ${dTd.toFixed(1)} s > ${CANON_TD_TOL_S} s)`);
    worstTd = Math.max(worstTd, Math.abs(dTd));
    assert.equal(best.value.type, ref.type, `${row.label}: type`);
    assert.ok(Math.abs(best.value.gamma - ref.gamma) <= GAMMA_TOL, `${row.label}: γ ${best.value.gamma.toFixed(4)} vs Canon ${ref.gamma} (|Δ| > ${GAMMA_TOL})`);
    if (kind === 'solar-eclipse') {
      assert.ok(Math.abs(best.value.magnitude - ref.magnitude) <= SOLAR_MAG_TOL, `${row.label}: magnitude ${best.value.magnitude.toFixed(4)} vs Canon ${ref.magnitude}`);
      assert.equal(best.value.central, true, 'all four are central eclipses');
      assert.ok(best.value.u < 0, 'total: the real umbra reaches the fundamental plane (u < 0)');
      assert.equal(best.score, 98);
      assert.match(best.label, /^Total solar eclipse/);
    } else {
      assert.ok(Math.abs(best.value.umbralMagnitude - ref.umbral) <= LUNAR_MAG_TOL, `${row.label}: umbral magnitude ${best.value.umbralMagnitude.toFixed(4)} vs Canon ${ref.umbral} (Danjon enlargement)`);
      assert.ok(Math.abs(best.value.penumbralMagnitude - ref.penumbral) <= LUNAR_MAG_TOL, `${row.label}: penumbral magnitude ${best.value.penumbralMagnitude.toFixed(4)} vs Canon ${ref.penumbral}`);
      assert.equal(best.score, 75);
      assert.match(best.label, /^Total lunar eclipse/);
    }
    assert.deepEqual(best.bodies, ['earth', 'moon']);
    assert.equal(best.observable, true);
    assert.ok(Math.abs(best.value[kind === 'solar-eclipse' ? 'jdTTNewMoon' : 'jdTTFullMoon'] - best.jdTT) < 0.1, 'the syzygy lies within 2.4 h of greatest eclipse');
    worstT = Math.max(worstT, dMin); worstG = Math.max(worstG, Math.abs(best.value.gamma - ref.gamma));
  }
  t.diagnostic(`worst instant Δ ${worstT.toFixed(2)} min vs moon.json, ${worstTd.toFixed(1)} s vs the Canon TD; worst |Δγ| ${worstG.toFixed(4)}`);
});

test('eclipse catalogue 2024–2027: every Canon eclipse of the period with its type, nothing else', () => {
  // NASA SE2001-2100 / LE2001-2100 for 2024-01-01 … 2027-12-31 (type at greatest eclipse).
  const expected = [
    ['2024-03-25', 'lunar-eclipse', 'penumbral'], ['2024-04-08', 'solar-eclipse', 'total'], ['2024-09-18', 'lunar-eclipse', 'partial'],
    ['2024-10-02', 'solar-eclipse', 'annular'], ['2025-03-14', 'lunar-eclipse', 'total'], ['2025-03-29', 'solar-eclipse', 'partial'],
    ['2025-09-07', 'lunar-eclipse', 'total'], ['2025-09-21', 'solar-eclipse', 'partial'], ['2026-02-17', 'solar-eclipse', 'annular'],
    ['2026-03-03', 'lunar-eclipse', 'total'], ['2026-08-12', 'solar-eclipse', 'total'], ['2026-08-28', 'lunar-eclipse', 'partial'],
    ['2027-02-06', 'solar-eclipse', 'annular'], ['2027-02-20', 'lunar-eclipse', 'penumbral'], ['2027-07-18', 'lunar-eclipse', 'penumbral'],
    ['2027-08-02', 'solar-eclipse', 'total'], ['2027-08-17', 'lunar-eclipse', 'penumbral'],
  ];
  const ev = scan(ttFromUtc(jdFromCalendar(2024, 1, 1)), ttFromUtc(jdFromCalendar(2028, 1, 1)), ['solar-eclipse', 'lunar-eclipse']);
  const got = ev.map((e) => [fmt(e.jdUtc).slice(0, 10), e.kind, e.value.type]);
  assert.deepEqual(got, expected, 'date (UTC), kind and type of every eclipse 2024–2027');
  // Canon γ / magnitude spot values for the period (SE2001-2100, LE2001-2100): the grazing 2024-09-18 partial lunar
  // eclipse (umbral magnitude 0.0848) is the case a careless classifier drops.
  const spot = {
    '2024-09-18': { gamma: -0.9792, mag: 0.0848 }, '2024-10-02': { gamma: -0.3509, mag: 0.9326 }, '2025-03-29': { gamma: 1.0405, mag: 0.9376 },
    '2026-02-17': { gamma: -0.9743, mag: 0.9630 }, '2026-03-03': { gamma: -0.3765, mag: 1.1507 }, '2026-08-28': { gamma: 0.4964, mag: 0.9299 },
    '2027-02-06': { gamma: -0.2952, mag: 0.9281 }, '2027-08-02': { gamma: 0.1421, mag: 1.0790 },
  };
  for (const [date, ref] of Object.entries(spot)) {
    const e = ev.find((x) => fmt(x.jdUtc).startsWith(date));
    const mag = e.kind === 'solar-eclipse' ? e.value.magnitude : e.value.umbralMagnitude;
    assert.ok(Math.abs(e.value.gamma - ref.gamma) < GAMMA_TOL, `${date}: γ ${e.value.gamma.toFixed(4)} vs Canon ${ref.gamma}`);
    assert.ok(Math.abs(mag - ref.mag) < LUNAR_MAG_TOL, `${date}: magnitude ${mag.toFixed(4)} vs Canon ${ref.mag}`);
  }
  // Annular eclipses have u > ω and a magnitude < 1; the 2025 partial solar eclipses have |γ| > 0.9972 + |u|
  for (const e of ev) {
    if (e.kind !== 'solar-eclipse') continue;
    if (e.value.type === 'annular') assert.ok(e.value.u > 0 && e.value.magnitude < 1 && e.value.magnitude > 0.9, `${fmt(e.jdUtc)} annular: u ${e.value.u.toFixed(4)}, magnitude ${e.value.magnitude.toFixed(3)}`);
    if (e.value.type === 'partial') assert.ok(!e.value.central && Math.abs(e.value.gamma) > CENTRAL_LIMIT && e.value.magnitude < 1 && e.score >= 50 && e.score <= 80, `${fmt(e.jdUtc)} partial: γ ${e.value.gamma.toFixed(4)}, magnitude ${e.value.magnitude.toFixed(3)}, score ${e.score}`);
    if (e.value.type === 'total') assert.ok(e.value.magnitude > 1 && e.value.u < 0);
    assert.ok(e.value.moonDiameterArcmin > 29 && e.value.moonDiameterArcmin < 34 && e.value.sunDiameterArcmin > 31 && e.value.sunDiameterArcmin < 33);
  }
  for (const e of ev) {
    if (e.kind !== 'lunar-eclipse') continue;
    const m = e.value;
    if (m.type === 'penumbral') assert.ok(m.umbralMagnitude <= 0 && m.penumbralMagnitude > 0 && e.score === 25);
    if (m.type === 'partial') assert.ok(m.umbralMagnitude > 0 && m.umbralMagnitude < 1 && e.score === 55);
    if (m.type === 'total') assert.ok(m.umbralMagnitude >= 1);
    assert.ok(m.penumbraRadiusEr > 1.2 && m.penumbraRadiusEr < 1.35 && m.umbraRadiusEr > 0.68 && m.umbraRadiusEr < 0.8, 'shadow radii at the Moon (Meeus: ρ ≈ 1.28, σ ≈ 0.74)');
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Geometry unit checks
// ---------------------------------------------------------------------------------------------------------------------
test('geometry: constants, γ sign (north positive) on synthetic configurations, u sign (total vs annular), magnitude formulas', () => {
  assert.equal(EARTH_RADIUS_KM, 6378.1366);
  assert.ok(Math.abs(MOON_RADIUS_ER - 1737.4 / 6378.1366) < 1e-15 && Math.abs(MOON_RADIUS_ER - 0.2724) < 1e-4, 'k = 0.2724 (NASA 0.2725)');
  assert.equal(DANJON_ENLARGEMENT, 1 / 85);
  assert.equal(CENTRAL_LIMIT, 0.9972);
  const R = 6378.1366 / AU_KM;
  // Earth at 1 AU on +x, at rest; Moon exactly on the Sun–Earth line, 60 Earth radii sunward: γ = 0, central total/annular
  const E = { x: 1, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const onAxis = { x: -60 * R, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const g0 = solarEclipseGeometry(E, onAxis, newSolarGeometry());
  assert.ok(Math.abs(g0.gamma) < 1e-9, 'γ = 0 on the axis');
  assert.ok(Math.abs(g0.zEr - 60) < 1e-9, 'z = 60 Earth radii');
  assert.ok(g0.l1 > 0.5 && g0.l1 < 0.6, `penumbral radius l₁ = ${g0.l1.toFixed(4)} ≈ 0.55 (Meeus: 0.5461 + u)`);
  // 60 R⊕ = 382 700 km is just inside the umbral cone length R☾/tan f₁ ≈ 374 000 km? No: beyond it → annular (u > 0)
  const coneKm = 1737.4 / ((SUN_RADIUS_KM - 1737.4) / AU_KM);
  assert.ok(coneKm > 370000 && coneKm < 380000, `umbral cone length ${coneKm.toFixed(0)} km`);
  assert.ok(g0.u > 0 && classifySolar(g0) === 'annular' && solarMagnitude(g0) < 1, `at 382 700 km the eclipse is annular (u = ${g0.u.toFixed(4)})`);
  const near = { x: -56 * R, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }; // 357 000 km: inside the cone → total
  const g1 = solarEclipseGeometry(E, near, newSolarGeometry());
  assert.ok(g1.u < 0 && classifySolar(g1) === 'total' && solarMagnitude(g1) > 1 && isCentral(g1), `at 357 000 km the eclipse is total (u = ${g1.u.toFixed(4)})`);
  // Moon displaced 0.5 R⊕ toward the equatorial north (scene frame: EQ_TO_ECL·ẑ ∝ (0, sin ε, cos ε)): the axis through
  // the Sun and the Moon reaches the Earth's plane 0.5 R⊕ × |E|/|M| = 0.5012 R⊕ north of the centre → γ = +0.5012
  const eps = 23.439291 * Math.PI / 180;
  const lever = 1 / (1 - 56 * R);
  const north = { x: -56 * R, y: 0.5 * R * Math.sin(eps), z: 0.5 * R * Math.cos(eps), vx: 0, vy: 0, vz: 0 };
  const gN = solarEclipseGeometry(E, north, newSolarGeometry());
  assert.ok(Math.abs(gN.gamma - 0.5 * lever) < 1e-6, `γ = ${gN.gamma.toFixed(6)} for a 0.5 R⊕ northward offset of the Moon (axis lever |E|/|M| = ${lever.toFixed(5)}; the shadow axis passes north of the centre)`);
  const south = { x: -56 * R, y: -0.5 * R * Math.sin(eps), z: -0.5 * R * Math.cos(eps), vx: 0, vy: 0, vz: 0 };
  assert.ok(Math.abs(solarEclipseGeometry(E, south, newSolarGeometry()).gamma + 0.5 * lever) < 1e-6, 'southward offset → γ = −0.5012');
  // Far off the axis: |γ| = 2 → no eclipse, NaN magnitude
  const far = { x: -56 * R, y: 0, z: 2 * R, vx: 0, vy: 0, vz: 0 };
  assert.equal(classifySolar(solarEclipseGeometry(E, far, newSolarGeometry())), null);
  assert.ok(Number.isNaN(solarMagnitude(solarEclipseGeometry(E, far, newSolarGeometry()))));
  // Partial: |γ| = 1.2 → partial with 0 < magnitude < 1
  const part = { x: -56 * R, y: 0, z: 1.2 * R, vx: 0, vy: 0, vz: 0 };
  const gP = solarEclipseGeometry(E, part, newSolarGeometry());
  assert.equal(classifySolar(gP), 'partial');
  assert.ok(solarMagnitude(gP) > 0 && solarMagnitude(gP) < 1);
  // Lunar: Moon exactly anti-solar at 60 R⊕ → γ = 0, total; shadow radii with the Danjon enlargement
  const anti = { x: 60 * R, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const l0 = lunarEclipseGeometry(E, anti, newLunarGeometry());
  assert.ok(Math.abs(l0.gamma) < 1e-9 && classifyLunar(l0) === 'total');
  assert.ok(l0.umbraRadiusEr > 0.7 && l0.umbraRadiusEr < 0.78 && l0.penumbraRadiusEr > 1.25 && l0.penumbraRadiusEr < 1.32, `σ ${l0.umbraRadiusEr.toFixed(4)}, ρ ${l0.penumbraRadiusEr.toFixed(4)}`);
  assert.ok(Math.abs(l0.umbralMagnitude - (l0.umbraRadiusEr + MOON_RADIUS_ER) / (2 * MOON_RADIUS_ER)) < 1e-12, 'umbral magnitude formula at γ = 0');
  const antiN = { x: 60 * R, y: 0.3 * R * Math.sin(eps), z: 0.3 * R * Math.cos(eps), vx: 0, vy: 0, vz: 0 };
  assert.ok(Math.abs(lunarEclipseGeometry(E, antiN, newLunarGeometry()).gamma - 0.3) < 1e-6, 'Moon north of the axis → γ = +0.3');
  const antiFar = { x: 60 * R, y: 0, z: 1.3 * R, vx: 0, vy: 0, vz: 0 };
  assert.equal(classifyLunar(lunarEclipseGeometry(E, antiFar, newLunarGeometry())), 'penumbral');
  const antiOut = { x: 60 * R, y: 0, z: 1.7 * R, vx: 0, vy: 0, vz: 0 };
  assert.equal(classifyLunar(lunarEclipseGeometry(E, antiOut, newLunarGeometry())), null);
  // Real geometry: the 1.3 s retardation moves γ by ≈ 0.001 (the Earth and the Moon both travel ≈ 39 km in that time,
  // so only the Moon's 1.3 km of geocentric motion and the axis lever survive) — the retardation is applied
  const row = MOON_FX.eclipses.find((e) => e.label === 'solar-2024-04-08');
  const Es = eph.state('earth', row.jdTT), ms = moonState(row.jdTT);
  const gReal = solarEclipseGeometry(Es, ms, newSolarGeometry());
  const gStill = solarEclipseGeometry({ ...Es, vx: 0, vy: 0, vz: 0 }, { ...ms, vx: 0, vy: 0, vz: 0 }, newSolarGeometry());
  assert.ok(Math.abs(gReal.gamma - gStill.gamma) > 1e-4 && Math.abs(gReal.gamma - gStill.gamma) < 3e-3, `light-time effect on γ: ${(gReal.gamma - gStill.gamma).toFixed(4)} Earth radii (measured −0.0008)`);
  assert.ok(Math.abs(gReal.gamma - CANON['solar-2024-04-08'].gamma) < Math.abs(gStill.gamma - CANON['solar-2024-04-08'].gamma), 'the retarded geometry is the closer one to the Canon');
});

// ---------------------------------------------------------------------------------------------------------------------
// Phases and apsides
// ---------------------------------------------------------------------------------------------------------------------
test('phases: Meeus 49.a New Moon 1977-02-18 03:37:42 TD and 49.b Last Quarter 2044-01-21 23:48:17 TD within 1 min (measured 5 s, 4 s)', () => {
  for (const [label, jde, kind, k] of [['New Moon 1977-02-18', 2443192.65118, 'moon-new', 0], ['Last Quarter 2044-01-21', 2467636.49186, 'moon-last-quarter', 0.5]]) {
    const { best, dMin } = nearest(scan(jde - 10, jde + 10, [kind]), kind, jde);
    assert.ok(best && dMin <= 1, `${label}: ${best ? fmt(best.jdTT) : 'none'} TT vs Meeus JDE ${jde} (Δ = ${dMin.toFixed(2)} min; Meeus's series is itself good to a few seconds)`);
    assert.ok(Math.abs(best.value.illuminatedFraction - k) < 0.01, `${label}: illuminated fraction ${best.value.illuminatedFraction.toFixed(4)} ≈ ${k}`);
    assert.deepEqual(best.bodies, ['moon']);
  }
});

test('phases: USNO instants (2017-08-21 18:30 new, 2024-04-08 18:21 new, 2025-03-14 06:55 full, 2025-09-07 18:09 full UTC) within 1 min; supermoon label; observability', () => {
  const rows = [
    ['moon-new', [2017, 8, 21, 18, 30]], ['moon-new', [2024, 4, 8, 18, 21]], ['moon-full', [2025, 3, 14, 6, 55]], ['moon-full', [2025, 9, 7, 18, 9]],
  ];
  for (const [kind, cal] of rows) {
    const ref = jdFromCalendar(...cal);
    const ev = scan(ttFromUtc(ref) - 10, ttFromUtc(ref) + 10, ['moon-new', 'moon-full', 'moon-first-quarter', 'moon-last-quarter']);
    const { best, dMin } = nearest(ev, kind, ttFromUtc(ref));
    assert.ok(best && dMin <= 1, `${kind} ${cal.join('-')}: ${best ? fmt(best.jdUtc) : 'none'} UTC (Δ = ${dMin.toFixed(2)} min > 1 min; USNO prints minutes)`);
    assert.equal(best.observable, kind !== 'moon-new', 'a new Moon is not observable, a full Moon is');
    assert.equal(best.value.elongationDeg, kind === 'moon-new' ? 0 : 180);
    assert.ok(best.value.distKm > 356000 && best.value.distKm < 407000 && best.value.angularDiameterArcmin > 29 && best.value.angularDiameterArcmin < 34);
    // The four phases alternate new → first quarter → full → last quarter, ≈ 7.4 d apart
    const sorted = ev.filter((e) => e.kind.startsWith('moon-') && !e.kind.includes('perigee') && !e.kind.includes('apogee')).sort((a, b) => a.jdTT - b.jdTT);
    const seq = ['moon-new', 'moon-first-quarter', 'moon-full', 'moon-last-quarter'];
    for (let i = 1; i < sorted.length; i++) {
      assert.equal(sorted[i].kind, seq[(seq.indexOf(sorted[i - 1].kind) + 1) % 4], 'phase order');
      const gap = sorted[i].jdTT - sorted[i - 1].jdTT;
      assert.ok(gap > 6.4 && gap < 8.3, `phases ${gap.toFixed(2)} d apart (6.5–8.2 d)`);
    }
  }
  // 2025-09-07 full Moon (357 000 km two days before perigee? no: 2025-11-05 is the year's closest) — check the rule, not the date
  assert.equal(SUPERMOON_MAX_DIST_KM, 360000);
  const full2025 = scan(ttFromUtc(jdFromCalendar(2025, 1, 1)), ttFromUtc(jdFromCalendar(2026, 1, 1)), ['moon-full']);
  assert.equal(full2025.length, 12, 'twelve full Moons in 2025');
  const supers = full2025.filter((e) => e.value.supermoon);
  assert.ok(supers.length >= 2 && supers.length <= 4, `2025 has ${supers.length} full Moons closer than 360 000 km (the October–December trio)`);
  for (const e of supers) assert.ok(e.score === 35 && /supermoon/.test(e.label) && e.value.distKm < 360000, e.label);
  for (const e of full2025) if (!e.value.supermoon) assert.ok(e.score === 20 && e.label === 'Full Moon');
});

test('perigee/apogee vs the hourly-Horizons fixture: within 15 min and 60 km (measured 10.5 min, 41 km); alternation; labels', (t) => {
  assert.ok(APSIDES_FX.apsides.length >= 5);
  const a0 = APSIDES_FX.apsides[0].jdTT, a1 = APSIDES_FX.apsides[APSIDES_FX.apsides.length - 1].jdTT;
  const ev = scan(a0 - 5, a1 + 5, ['moon-perigee', 'moon-apogee']);
  let worstT = 0, worstD = 0;
  for (const a of APSIDES_FX.apsides) {
    const kind = `moon-${a.kind}`;
    const { best, dMin } = nearest(ev, kind, a.jdTT);
    assert.ok(best && dMin <= 15, `${a.kind} ${fmt(a.jdTT)} TT: ${best ? fmt(best.jdTT) : 'none'} (Δ = ${dMin.toFixed(1)} min > 15 min)`);
    const dKm = Math.abs(best.value.distKm - a.distKm);
    assert.ok(dKm <= 60, `${a.kind} ${fmt(a.jdTT)}: distance ${best.value.distKm.toFixed(0)} vs Horizons ${a.distKm.toFixed(0)} km (|Δ| = ${dKm.toFixed(1)} > 60 km)`);
    worstT = Math.max(worstT, dMin); worstD = Math.max(worstD, dKm);
    assert.match(best.label, a.kind === 'perigee' ? /^Moon at perigee \(closest to Earth\), \d{3} \d{3} km$/ : /^Moon at apogee \(farthest from Earth\), \d{3} \d{3} km$/);
    assert.ok(best.value.distEarthRadii > 55 && best.value.distEarthRadii < 64);
  }
  const sorted = ev.slice().sort((p, q) => p.jdTT - q.jdTT);
  for (let i = 1; i < sorted.length; i++) assert.notEqual(sorted[i].kind, sorted[i - 1].kind, 'perigees and apogees alternate');
  t.diagnostic(`apsides vs Horizons: worst Δt ${worstT.toFixed(1)} min, worst Δdist ${worstD.toFixed(1)} km`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------------------------------------------------
test('KINDS carries the 12 new kinds with merge windows; scores and labels are defined for each; notabilityScore examples', () => {
  const added = [...SEASON_KINDS, ...LUNAR_KINDS];
  assert.equal(added.length, 12);
  for (const k of added) {
    assert.ok(KINDS.includes(k), k);
    assert.ok(MERGE_WINDOWS_D[k] >= 5, `${k} merge window`);
  }
  assert.equal(notabilityScore('solar-eclipse', ['earth', 'moon'], { type: 'total' }), 98);
  assert.equal(notabilityScore('solar-eclipse', ['earth', 'moon'], { type: 'annular' }), 90);
  assert.equal(notabilityScore('solar-eclipse', ['earth', 'moon'], { type: 'hybrid' }), 95);
  assert.equal(notabilityScore('solar-eclipse', ['earth', 'moon'], { type: 'partial', magnitude: 0.5 }), 65);
  assert.equal(notabilityScore('lunar-eclipse', ['earth', 'moon'], { type: 'penumbral' }), 25);
  assert.equal(notabilityScore('equinox-march', ['earth'], {}), 45);
  assert.equal(notabilityScore('moon-full', ['moon'], { supermoon: true }), 35);
  assert.equal(notabilityScore('moon-apogee', ['moon'], {}), 8);
  assert.equal(labelFor('solar-eclipse', ['earth', 'moon'], { type: 'partial', magnitude: 0.936 }), 'Partial solar eclipse — the Moon covers 94% of the Sun’s width at most');
  assert.equal(labelFor('lunar-eclipse', ['earth', 'moon'], { type: 'partial', umbralMagnitude: 0.087 }), 'Partial lunar eclipse — Earth’s shadow covers 9% of the Moon’s width');
  assert.equal(labelFor('moon-perigee', ['moon'], { distKm: 356456.7 }), 'Moon at perigee (closest to Earth), 356 457 km');
  assert.equal(labelFor('solstice-june', ['earth'], {}), 'June solstice — the longest day in the north, the shortest in the south');
});

test('performance: the season + lunar detectors add < 30 % to a one-year scan (brief; measured +10 %)', (t) => {
  const jd0 = ttFromUtc(jdFromCalendar(2026, 1, 1)), jd1 = ttFromUtc(jdFromCalendar(2027, 1, 1));
  const legacy = KINDS.filter((k) => !LUNAR_KINDS.includes(k) && !SEASON_KINDS.includes(k));
  findEvents(eph, jd0, jd1); findEvents(eph, jd0, jd1, { kinds: legacy }); // warm-up
  const median = (f) => { const ts = []; for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); ts.push(performance.now() - t0); } return ts.sort((a, b) => a - b)[1]; };
  const tAll = median(() => findEvents(eph, jd0, jd1));
  const tLegacy = median(() => findEvents(eph, jd0, jd1, { kinds: legacy }));
  const ratio = tAll / tLegacy;
  t.diagnostic(`2026 all kinds ${tAll.toFixed(0)} ms vs legacy kinds ${tLegacy.toFixed(0)} ms: +${((ratio - 1) * 100).toFixed(1)} %`);
  assert.ok(ratio < 1.3, `new scans add ${((ratio - 1) * 100).toFixed(1)} % (brief < 30 %)`);
  const all = findEvents(eph, jd0, jd1);
  const counts = {};
  for (const e of all) counts[e.kind] = (counts[e.kind] || 0) + 1;
  assert.equal(counts['moon-new'] + counts['moon-full'], 25, '2026 has 13 new and 12 full Moons (or 12 + 13)');
  assert.equal(counts['moon-first-quarter'] + counts['moon-last-quarter'], 25);
  // 365.25 / 27.5546 d (anomalistic month) = 13.26 → 13 or 14 of each per calendar year (2026: 14 perigees, 13 apogees)
  assert.ok(counts['moon-perigee'] >= 13 && counts['moon-perigee'] <= 14 && counts['moon-apogee'] >= 13 && counts['moon-apogee'] <= 14, `13–14 perigees and apogees in 2026 (got ${counts['moon-perigee']}/${counts['moon-apogee']})`);
  assert.equal(counts['solar-eclipse'], 2, '2026: Feb 17 annular, Aug 12 total');
  assert.equal(counts['lunar-eclipse'], 2, '2026: Mar 3 total, Aug 28 partial');
  for (const k of SEASON_KINDS) assert.equal(counts[k], 1);
});
