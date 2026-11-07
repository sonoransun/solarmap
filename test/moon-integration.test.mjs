// Moon integration: the bodies.js 'moon' entry (IAU 2015 Table 2 rotational elements), orientation.js through the generic
// IAU path (libration vs Horizons MOON_ME, test/fixtures/horizons/moon-libration.json), the ephemeris `{moon: true}`
// option (states.moon = heliocentric Earth + geocentric moon.js Moon) and geometry/photometry helpers on the Moon.
// Measured 2026-11-06: sub-Earth point vs Horizons (49 monthly epochs 2024–2027) max |Δlon| 0.0077°, |Δlat| 0.0034°
// (the analytical IAU expressions vs the DE421 mean-Earth/polar-axis frame; Archinal et al. 2018 quote ≈ 150 m, i.e.
// 0.005°, for the lunar expressions). Tolerances 0.012° / 0.005° (≥ 1.3 × measured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris, BODIES, BODIES_WITH_MOON } from '../src/astro/ephemeris.js';
import { MOON, moonState, moonPosition } from '../src/astro/moon.js';
import { BODIES as TABLE, ALL_BODY_IDS, BODY_IDS, MOON_ID, body, radiusAu, isPlanet } from '../src/astro/bodies.js';
import {
  rotationElements, bodyToEcliptic, poleEcliptic, subEarthPoint, subSolarPoint, spinRateDegPerDay, siderealRotationDays, isRetrograde,
} from '../src/astro/orientation.js';
import { geocentric, geocentricDistanceKm, angularDiameterDeg, phaseAngleDeg, illuminatedFraction, elongationDeg, distanceAu } from '../src/astro/geometry.js';
import { angleBetween, mat3Mul, mat3T, wrap180, norm } from '../src/astro/vec.js';
import { AU_KM, J2000, RAD, C_AU_DAY, DAYS_PER_CENTURY } from '../src/astro/constants.js';

const LIB = JSON.parse(readFileSync(new URL('./fixtures/horizons/moon-libration.json', import.meta.url), 'utf8'));
const eph = createEphemeris(SERIES, { meta: META, moon: true });
const ephPlain = createEphemeris(SERIES, { meta: META });
const LON_TOL_DEG = 0.012, LAT_TOL_DEG = 0.005;

test('bodies.js: the Moon entry (301, 1737.4 km sphere, DE440 GM, IAU 2015 Table 2 elements, parent earth) and the id lists', () => {
  const m = body('moon');
  assert.equal(m.id, 'moon');
  assert.equal(m.name, 'Moon');
  assert.equal(m.horizonsId, 301);
  assert.equal(m.radiusEqKm, 1737.4);
  assert.equal(m.radiusPolarKm, 1737.4);
  assert.equal(m.radiusEqKm, MOON.radiusKm, 'same radius as moon.js');
  assert.equal(m.gmKm3S2, 4902.800118, 'DE440 GM_Moon');
  assert.equal(m.siderealOrbitDays, MOON.siderealMonthDays);
  assert.equal(m.parent, 'earth');
  assert.equal(m.priority, 8, 'contract: label priority 8');
  assert.equal(m.rotation.model, 'iau');
  assert.deepEqual(m.rotation.alpha0, [269.9949, 0.0031]);
  assert.deepEqual(m.rotation.delta0, [66.5392, 0.0130]);
  assert.deepEqual(m.rotation.w, [38.3213, 13.17635815]);
  assert.equal(m.rotation.wQuad, -1.4e-12);
  assert.equal(m.rotation.periodic.alpha0.length, 7);
  assert.equal(m.rotation.periodic.delta0.length, 8);
  assert.equal(m.rotation.periodic.w.length, 13, 'E1…E13 in W');
  assert.ok(m.rotation.periodic.w.every((t) => t[3] === 'd'), 'lunar arguments are in days');
  assert.deepEqual(m.rotation.periodic.w[4], [+0.0252, 357.529, 0.9856003, 'd'], 'E5 is the Sun\'s mean anomaly rate');
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.rotation));
  assert.equal(MOON_ID, 'moon');
  assert.deepEqual([...ALL_BODY_IDS], [...BODY_IDS, 'moon']);
  assert.ok(!BODY_IDS.includes('moon'), 'BODY_IDS stays Sun + planets');
  assert.deepEqual(Object.keys(TABLE), [...ALL_BODY_IDS]);
  assert.equal(isPlanet('moon'), false);
  assert.equal(radiusAu('moon'), 1737.4 / AU_KM);
  // Spin: 360/13.17635815 = 27.321662 d = the sidereal month (synchronous rotation; moon.js 27.321661 d from Meeus 47.1)
  assert.ok(Math.abs(siderealRotationDays('moon') - 27.321662) < 1e-6, `sidereal rotation ${siderealRotationDays('moon')} d`);
  assert.ok(Math.abs(siderealRotationDays('moon') - MOON.siderealMonthDays) < 1e-5, 'synchronous with the sidereal month to 1 s');
  assert.equal(isRetrograde('moon'), false);
  assert.ok(spinRateDegPerDay('moon') > 0);
});

test('orientation: Moon elements at J2000 (α0 266.86°, δ0 65.64°, W 41.20° with the E-terms), W quadratic term applied, proper rotation', () => {
  const e = rotationElements('moon', J2000);
  // Hand evaluation of Table 2 at d = 0: α0 = 269.9949 − 3.8787 sin 125.045° − 0.1204 sin 250.089° + 0.0700 sin 260.008°
  // − 0.0172 sin 176.625° + 0.0072 sin 311.589° − 0.0052 sin 15.134° + 0.0043 sin 25.053°
  const s = (d) => Math.sin(d / RAD), c = (d) => Math.cos(d / RAD);
  const a0 = 269.9949 - 3.8787 * s(125.045) - 0.1204 * s(250.089) + 0.0700 * s(260.008) - 0.0172 * s(176.625) + 0.0072 * s(311.589) - 0.0052 * s(15.134) + 0.0043 * s(25.053);
  const d0 = 66.5392 + 1.5419 * c(125.045) + 0.0239 * c(250.089) - 0.0278 * c(260.008) + 0.0068 * c(176.625) - 0.0029 * c(311.589) + 0.0009 * c(134.963) + 0.0008 * c(15.134) - 0.0009 * c(25.053);
  const w0 = 38.3213 + 3.5610 * s(125.045) + 0.1208 * s(250.089) - 0.0642 * s(260.008) + 0.0158 * s(176.625) + 0.0252 * s(357.529) - 0.0066 * s(311.589)
    - 0.0047 * s(134.963) - 0.0046 * s(276.617) + 0.0028 * s(34.226) + 0.0052 * s(15.134) + 0.0040 * s(119.743) + 0.0019 * s(239.961) - 0.0044 * s(25.053);
  assert.ok(Math.abs(e.alpha0 * RAD - a0) < 1e-9, `α0(J2000) = ${(e.alpha0 * RAD).toFixed(6)}° vs hand ${a0.toFixed(6)}°`);
  assert.ok(Math.abs(e.delta0 * RAD - d0) < 1e-9, `δ0(J2000) = ${(e.delta0 * RAD).toFixed(6)}° vs hand ${d0.toFixed(6)}°`);
  assert.ok(Math.abs(e.W * RAD - w0) < 1e-9, `W(J2000) = ${(e.W * RAD).toFixed(6)}° vs hand ${w0.toFixed(6)}°`);
  assert.ok(Math.abs(a0 - 266.858) < 0.002 && Math.abs(d0 - 65.641) < 0.002 && Math.abs(w0 - 41.195) < 0.002, `J2000 values α0 ${a0.toFixed(4)}, δ0 ${d0.toFixed(4)}, W ${w0.toFixed(4)} (hand sums 266.8577 / 65.6412 / 41.1953)`);
  // Quadratic term: after 10 000 days W differs from the linear + periodic sum by −1.4e-12 × 1e8 = −1.4e-4°
  const d = 10000, jd = J2000 + d;
  const eD = rotationElements('moon', jd);
  const periodicW = TABLE.moon.rotation.periodic.w.reduce((acc, t) => acc + t[0] * s(t[1] + t[2] * d), 0);
  const linear = 38.3213 + 13.17635815 * d + periodicW;
  assert.ok(Math.abs(wrap180(eD.W * RAD - linear) - -1.4e-12 * d * d) < 1e-9, `W quadratic term −1.4e-12 d² = ${(-1.4e-12 * d * d).toExponential(2)}° applied`);
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const j of [J2000, 2460310.5, 2305448.0, 2670691.0]) {
    const M = bodyToEcliptic('moon', j, j);
    let md = 0;
    const MMt = mat3Mul(M, mat3T(M));
    for (let k = 0; k < 9; k++) md = Math.max(md, Math.abs(MMt[k] - I[k]));
    assert.ok(md < 1e-13, `JD ${j}: M·Mᵀ = I`);
  }
});

test('orientation: the Moon\'s pole stays 1.54° ± 0.05° from the ecliptic pole over an 18.6-year node cycle (Cassini state), precessing with the node', () => {
  let min = 90, max = 0;
  const first = poleEcliptic('moon', J2000);
  let maxSwing = 0;
  for (let jd = J2000; jd < J2000 + 18.6 * 365.25; jd += 30) {
    const p = poleEcliptic('moon', jd);
    const tilt = angleBetween(p, [0, 0, 1]) * RAD;
    min = Math.min(min, tilt); max = Math.max(max, tilt);
    maxSwing = Math.max(maxSwing, angleBetween(p, first) * RAD);
  }
  assert.ok(min > 1.49 && max < 1.60, `pole tilt to the ecliptic ${min.toFixed(4)}°–${max.toFixed(4)}° (mean inclination of the lunar equator to the ecliptic 1.5424°; IAU periodic terms ±0.04°)`);
  assert.ok(maxSwing > 2.9 && maxSwing < 3.2, `the pole circles the ecliptic pole: max angular swing ${maxSwing.toFixed(3)}° ≈ 2 × 1.54° over the node period`);
});

test('libration: sub-Earth point vs Horizons MOON_ME (49 epochs 2024–2027, light-time retarded): |Δlon| ≤ 0.012°, |Δlat| ≤ 0.005°, within the optical libration limits', (t) => {
  assert.match(LIB.poleLine, /MOON_ME/, 'Horizons used the mean Earth/polar axis frame');
  assert.match(LIB.poleLine, /East-longitude positive/);
  assert.ok(LIB.rows.length >= 45);
  let maxLon = 0, maxLat = 0, maxAbsLon = 0, maxAbsLat = 0;
  for (const r of LIB.rows) {
    const S = eph.states(r.jdTT, {});
    const tau = Math.hypot(S.moon.x - S.earth.x, S.moon.y - S.earth.y, S.moon.z - S.earth.z) / C_AU_DAY;
    const p = subEarthPoint('moon', S.moon, S.earth, r.jdTT - tau);
    const dLon = wrap180(p.lonDeg - r.subLonDeg), dLat = p.latDeg - r.subLatDeg;
    assert.ok(Math.abs(dLon) <= LON_TOL_DEG, `JD ${r.jdTT}: libration longitude ${p.lonDeg.toFixed(4)}° vs Horizons ${r.subLonDeg}° (|Δ| = ${Math.abs(dLon).toFixed(4)}° > ${LON_TOL_DEG}°)`);
    assert.ok(Math.abs(dLat) <= LAT_TOL_DEG, `JD ${r.jdTT}: libration latitude ${p.latDeg.toFixed(4)}° vs Horizons ${r.subLatDeg}° (|Δ| = ${Math.abs(dLat).toFixed(4)}° > ${LAT_TOL_DEG}°)`);
    maxLon = Math.max(maxLon, Math.abs(dLon)); maxLat = Math.max(maxLat, Math.abs(dLat));
    maxAbsLon = Math.max(maxAbsLon, Math.abs(p.lonDeg)); maxAbsLat = Math.max(maxAbsLat, Math.abs(p.latDeg));
  }
  assert.ok(LON_TOL_DEG >= 1.3 * maxLon && LAT_TOL_DEG >= 1.3 * maxLat, `margin rule: measured ${maxLon.toFixed(4)}° / ${maxLat.toFixed(4)}°`);
  assert.ok(maxAbsLon < 8.5 && maxAbsLat < 7.2, `libration amplitudes ${maxAbsLon.toFixed(2)}° / ${maxAbsLat.toFixed(2)}° within the optical limits (≈ 7.9° / 6.9° plus physical libration)`);
  assert.ok(maxAbsLon > 4 && maxAbsLat > 4, 'the sampled librations do reach several degrees');
  t.diagnostic(`libration vs Horizons MOON_ME: max |Δlon| ${maxLon.toFixed(4)}°, max |Δlat| ${maxLat.toFixed(4)}°`);
});

test('ephemeris {moon: true}: states().moon = Earth + moon.js geocentric Moon, state("moon"), position, moonGeocentric; a plain instance keeps the 9-body memo', () => {
  assert.equal(eph.moon, true);
  assert.equal(ephPlain.moon, false);
  assert.deepEqual([...eph.bodies], [...BODIES_WITH_MOON]);
  assert.deepEqual([...ephPlain.bodies], [...BODIES]);
  assert.deepEqual([...BODIES_WITH_MOON], [...BODIES, 'moon']);
  const jd = 2460748.790775463;
  const S = eph.states(jd);
  const m = moonState(jd);
  assert.ok(Math.abs(S.moon.x - (S.earth.x + m.x)) < 1e-18 && Math.abs(S.moon.vz - (S.earth.vz + m.vz)) < 1e-18, 'states.moon = earth + geocentric');
  const st = eph.state('moon', jd);
  assert.ok(Math.abs(st.x - S.moon.x) < 1e-18 && Math.abs(st.vy - S.moon.vy) < 1e-18, 'state("moon") agrees with states().moon');
  const pos = eph.position('moon', jd);
  assert.ok(Math.abs(pos[0] - S.moon.x) < 1e-18 && Math.abs(pos[2] - S.moon.z) < 1e-18);
  const g = eph.moonGeocentric(jd);
  assert.ok(Math.abs(g.x - m.x) < 1e-18 && Math.abs(norm([g.x, g.y, g.z]) - norm(moonPosition(jd))) < 1e-18);
  assert.ok(Math.abs(geocentricDistanceKm(S, 'moon') - norm(moonPosition(jd)) * AU_KM) < 1e-6, 'geometry.geocentric works on the Moon');
  // memo semantics: same object for the same instant, moon key present only with the option
  assert.equal(eph.states(jd), S);
  assert.equal(ephPlain.states(jd).moon, undefined);
  assert.deepEqual(Object.keys(ephPlain.states(jd)), [...BODIES]);
  assert.deepEqual(Object.keys(S), [...BODIES_WITH_MOON]);
  // The plain instance still gives the Moon on request (state/position) without touching its memo
  const st2 = ephPlain.state('moon', jd);
  assert.ok(Math.abs(st2.x - st.x) < 1e-18);
  assert.equal(ephPlain.states(jd).moon, undefined);
  // `out` objects: states into a user object creates the moon slot on demand
  const out = {};
  eph.states(jd, out);
  assert.ok(out.moon && Math.abs(out.moon.y - S.moon.y) < 1e-18);
});

test('geometry/photometry on the Moon at the 2025-03-14 eclipse: distance, angular diameter, phase angle, elongation ≈ 180°', () => {
  const jd = 2460748.790775463;
  const S = eph.states(jd);
  const d = geocentricDistanceKm(S, 'moon');
  assert.ok(d > 356000 && d < 407000, `Moon distance ${d.toFixed(0)} km`);
  assert.ok(Math.abs(angularDiameterDeg(S, 'moon') * 60 - 2 * Math.asin(1737.4 / d) * RAD * 60) < 1e-12, 'angular diameter from the table radius');
  assert.ok(phaseAngleDeg(S, 'moon') < 1.5 && illuminatedFraction(S, 'moon') > 0.995, 'full Moon');
  assert.ok(180 - elongationDeg(S, 'moon') < 1.5, 'opposite the Sun');
  assert.ok(Math.abs(distanceAu(S, 'earth', 'moon') * AU_KM - d) < 1e-6);
  const gv = geocentric(S, 'moon');
  assert.ok(Math.abs(norm(gv) * AU_KM - d) < 1e-6);
  // Sub-solar point on the Moon: latitude within ±1.6° (the Moon's small obliquity to the ecliptic)
  const ss = subSolarPoint('moon', S.moon, jd);
  assert.ok(Math.abs(ss.latDeg) < 1.6, `sub-solar latitude ${ss.latDeg.toFixed(3)}°`);
  // T-dependence sanity: elements evolve smoothly over a century
  const w1 = rotationElements('moon', J2000 + DAYS_PER_CENTURY).W;
  assert.ok(Number.isFinite(w1) && w1 >= 0 && w1 < 2 * Math.PI);
});
