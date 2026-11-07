// apparent.js — astrometric (ICRF, light-time) and apparent (true equator & equinox of date; light-time, aberration,
// precession, nutation) geocentric places vs the JPL Horizons OBSERVER fixture test/fixtures/horizons/observer.json
// (scripts/fetch-observer.mjs: CENTER='500@399', planet centres 199…899, 12 TT epochs 2020–2027; quantities 1, 2, 20).
//
// Tolerance rule (as test/horizons.test.mjs): committed = max(task brief, 1.3 × measured), enforced programmatically at
// the end of the file. Brief: astrometric ≤ 1″ and apparent ≤ 1.5″ for the inner planets. Measured 2026-11-06
// (fixture: Horizons API 1.2, DE441; our states: VSOP87A truncated, barycentres 4–8 for Mars–Neptune):
//   body      astrometric″  apparent″   |Δdelta| km   |Δdeldot| km/s
//   mercury   0.027         0.150       14.8          0.0062
//   venus     0.030         0.125       15.7          0.0016
//   mars      0.056         0.219       16.0          0.0007
//   jupiter   0.232         0.406       198.1         0.0016
//   saturn    0.211         0.343       721.0         0.0014
//   uranus    1.344         1.225       6881.9        0.0002
//   neptune   1.409         1.522       10153.0       0.0009
// The outer-planet residuals are the VSOP87-vs-DE441 heliocentric errors of horizons.test.mjs (Uranus 1.41″, Neptune
// 2.28″, Jupiter/Saturn ≈ 1000–1900 km) seen from the Earth; the systematic ≈ +0.1″ in apparent RA of the inner planets
// is Horizons' EOP-corrected celestial pole (IAU76/80 + the observed dψ, dε) and its −53 mas equinox offset, plus the
// gravitational deflection (≤ 0.05″ at ψ ≥ 10°) that apparent.js does not apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import {
  LIGHT_TIME_DAYS_PER_AU, LIGHT_TIME_TOL_D, astrometricGeocentric, aberrate, trueOfDateMatrix, raDecDeg, lonLatDeg,
  apparentPlace, astrometricRaDec, apparentRaDec, apparentEcliptic, apparentSunLongitudeDeg, newApparentPlace, newAstrometric,
} from '../src/astro/apparent.js';
import { nutation, nutationMatrix } from '../src/astro/nutation.js';
import { ECL_TO_EQ, precessionMatrix } from '../src/astro/frames.js';
import { mat3Mul, mat3T, angleBetween, norm } from '../src/astro/vec.js';
import { AU_KM, ARCSEC_PER_RAD, C_AU_DAY, DAY_S, DEG, J2000, DAYS_PER_CENTURY, LIGHT_TIME_AU_S } from '../src/astro/constants.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/horizons/observer.json', import.meta.url), 'utf8'));
const eph = createEphemeris(SERIES, { meta: META, moon: true });
const BODIES = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const COMMANDS = { mercury: '199', venus: '299', mars: '499', jupiter: '599', saturn: '699', uranus: '799', neptune: '899' };
const N_EPOCHS = 12;

// Committed tolerances (brief first; `// widened` = 1.3 × measured rounded up, outer planets only).
const ASTRO_TOL_ARCSEC = { mercury: 1, venus: 1, mars: 1, jupiter: 1, saturn: 1, uranus: 1.75 /* widened: 1.344 */, neptune: 1.85 /* widened: 1.409 */ };
const APP_TOL_ARCSEC = { mercury: 1.5, venus: 1.5, mars: 1.5, jupiter: 1.5, saturn: 1.5, uranus: 1.6 /* widened: 1.225 */, neptune: 2.0 /* widened: 1.522 */ };
/** |Δdelta| in km, 1.3 × measured rounded up (the line-of-sight component of the heliocentric position residual). */
const DELTA_TOL_KM = { mercury: 20, venus: 21, mars: 21, jupiter: 260, saturn: 940, uranus: 9000, neptune: 13200 };
/** |Δdeldot| in km/s, 1.3 × measured rounded up. */
const RATE_TOL_KM_S = { mercury: 0.0081, venus: 0.003, mars: 0.003, jupiter: 0.003, saturn: 0.003, uranus: 0.003, neptune: 0.003 };

/** Great-circle separation of two (RA, Dec) pairs in arcseconds (atan2 form, CLAUDE.md). */
function sepArcsec(ra1, dec1, ra2, dec2) {
  const a = [Math.cos(dec1 * DEG) * Math.cos(ra1 * DEG), Math.cos(dec1 * DEG) * Math.sin(ra1 * DEG), Math.sin(dec1 * DEG)];
  const b = [Math.cos(dec2 * DEG) * Math.cos(ra2 * DEG), Math.cos(dec2 * DEG) * Math.sin(ra2 * DEG), Math.sin(dec2 * DEG)];
  return angleBetween(a, b) * ARCSEC_PER_RAD;
}

/** All residuals, computed once: RES[body] = [{row, astro, app, deltaKm, rate}] */
const RES = {};
const place = newApparentPlace();
for (const body of BODIES) {
  RES[body] = FX.bodies[body].rows.map((row) => {
    const p = apparentPlace(eph, body, row.jdTT, place);
    return {
      row,
      astro: sepArcsec(p.raDeg, p.decDeg, row.raIcrfDeg, row.decIcrfDeg),
      app: sepArcsec(p.raAppDeg, p.decAppDeg, row.raAppDeg, row.decAppDeg),
      deltaKm: Math.abs(p.distAu - row.deltaAu) * AU_KM,
      rate: Math.abs(p.rangeRateKmS - row.deldotKmS),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------------------------------------------------
test('fixture: 7 planets × 12 TT epochs 2020–2027, geocentric, API 1.2, quantities 1,2,9,14,20,29, finite angles', () => {
  assert.equal(FX.apiVersion, '1.2');
  assert.equal(FX.center, '500@399');
  assert.equal(FX.timeType, 'TT');
  assert.equal(FX.quantities, '1,2,9,14,20,29');
  assert.deepEqual(Object.keys(FX.bodies), BODIES);
  assert.equal(FX.epochs.length, N_EPOCHS);
  assert.equal(FX.epochs[0], 2458849.5, '2020-01-01 0h TT');
  assert.equal(FX.epochs[N_EPOCHS - 1], 2461406.5, '2027-01-01 0h TT');
  for (const body of BODIES) {
    const b = FX.bodies[body];
    assert.equal(b.command, COMMANDS[body], `${body}: planet-centre COMMAND id`);
    assert.match(b.targetLine, new RegExp(`\\(${COMMANDS[body]}\\)`));
    assert.equal(b.rows.length, N_EPOCHS);
    b.rows.forEach((r, i) => {
      assert.equal(r.jdTT, FX.epochs[i]);
      for (const k of ['raIcrfDeg', 'decIcrfDeg', 'raAppDeg', 'decAppDeg', 'deltaAu', 'deldotKmS']) assert.ok(Number.isFinite(r[k]), `${body} ${r.jdTT}: finite ${k}`);
      assert.ok(r.raIcrfDeg >= 0 && r.raIcrfDeg < 360 && Math.abs(r.decIcrfDeg) <= 90);
      assert.match(r.constellation, /^[A-Z][A-Za-z]{2}$/, 'IAU constellation code');
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Residuals per body
// ---------------------------------------------------------------------------------------------------------------------
for (const body of BODIES) {
  test(`${body}: astrometric ≤ ${ASTRO_TOL_ARCSEC[body]}″, apparent ≤ ${APP_TOL_ARCSEC[body]}″, |Δdelta| ≤ ${DELTA_TOL_KM[body]} km, |Δdeldot| ≤ ${RATE_TOL_KM_S[body]} km/s at all 12 epochs`, (t) => {
    let mA = 0, mB = 0, mD = 0, mR = 0;
    for (const r of RES[body]) {
      const where = `${body} JD ${r.row.jdTT}`;
      assert.ok(r.astro <= ASTRO_TOL_ARCSEC[body], `${where}: astrometric ${r.astro.toFixed(3)}″ > ${ASTRO_TOL_ARCSEC[body]}″ (brief: ≤ 1″ inner planets; header table)`);
      assert.ok(r.app <= APP_TOL_ARCSEC[body], `${where}: apparent ${r.app.toFixed(3)}″ > ${APP_TOL_ARCSEC[body]}″ (brief: ≤ 1.5″; Horizons airless apparent incl. deflection + EOP)`);
      assert.ok(r.deltaKm <= DELTA_TOL_KM[body], `${where}: |Δdelta| ${r.deltaKm.toFixed(1)} km > ${DELTA_TOL_KM[body]} km (1.3 × measured)`);
      assert.ok(r.rate <= RATE_TOL_KM_S[body], `${where}: |Δdeldot| ${r.rate.toFixed(4)} km/s > ${RATE_TOL_KM_S[body]} km/s (1.3 × measured)`);
      mA = Math.max(mA, r.astro); mB = Math.max(mB, r.app); mD = Math.max(mD, r.deltaKm); mR = Math.max(mR, r.rate);
    }
    t.diagnostic(`${body}: max astrometric ${mA.toFixed(3)}″, apparent ${mB.toFixed(3)}″, |Δdelta| ${mD.toFixed(1)} km, |Δdeldot| ${mR.toFixed(4)} km/s`);
  });
}

test('every committed tolerance is ≥ 1.3 × the measured maximum (margin rule) — widen the tables and the header if this fails', () => {
  for (const body of BODIES) {
    const max = { astro: 0, app: 0, deltaKm: 0, rate: 0 };
    for (const r of RES[body]) for (const k of Object.keys(max)) if (r[k] > max[k]) max[k] = r[k];
    assert.ok(ASTRO_TOL_ARCSEC[body] >= 1.3 * max.astro, `${body}: astrometric tolerance ${ASTRO_TOL_ARCSEC[body]}″ < 1.3 × ${max.astro.toFixed(3)}″`);
    assert.ok(APP_TOL_ARCSEC[body] >= 1.3 * max.app, `${body}: apparent tolerance ${APP_TOL_ARCSEC[body]}″ < 1.3 × ${max.app.toFixed(3)}″`);
    assert.ok(DELTA_TOL_KM[body] >= 1.3 * max.deltaKm, `${body}: delta tolerance ${DELTA_TOL_KM[body]} km < 1.3 × ${max.deltaKm.toFixed(1)} km`);
    assert.ok(RATE_TOL_KM_S[body] >= 1.3 * max.rate, `${body}: deldot tolerance ${RATE_TOL_KM_S[body]} < 1.3 × ${max.rate.toFixed(4)} km/s`);
  }
});

test('the apparent reduction is what makes the agreement possible: astrometric J2000 angles are 15′–25′ from Horizons\' apparent place in 2020–2027 (precession), apparent ones within 1.6″', () => {
  for (const body of ['mars', 'jupiter']) {
    for (const r of RES[body]) {
      const p = apparentPlace(eph, body, r.row.jdTT, place);
      const naive = sepArcsec(p.raDeg, p.decDeg, r.row.raAppDeg, r.row.decAppDeg) / 60;
      assert.ok(naive > 15 && naive < 25, `${body} JD ${r.row.jdTT}: J2000 vs apparent-of-date differ by ${naive.toFixed(1)}′ (20–27 years × 50.3″/yr)`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Light-time
// ---------------------------------------------------------------------------------------------------------------------
test('light-time: τ = 0.0057755183 d/AU (Meeus 33.3) = 499.0048 s/AU; the Sun needs one pass, planets ≤ 4; the retarded position lags by τ·|V|', () => {
  assert.ok(Math.abs(LIGHT_TIME_DAYS_PER_AU - 0.0057755183) < 1e-10, `1/c = ${LIGHT_TIME_DAYS_PER_AU} d/AU vs Meeus 0.0057755183`);
  assert.ok(Math.abs(LIGHT_TIME_DAYS_PER_AU * DAY_S - LIGHT_TIME_AU_S) < 1e-9, 'consistent with constants.LIGHT_TIME_AU_S');
  const g = astrometricGeocentric(eph, 'sun', J2000);
  const E = eph.state('earth', J2000);
  assert.equal(g.iterations, 1);
  assert.ok(Math.abs(g.distAu - norm([E.x, E.y, E.z])) < 1e-15 && g.x === -E.x && g.y === -E.y && g.z === -E.z, 'Sun: −E exactly');
  assert.ok(Math.abs(g.lightTimeDays * DAY_S - 491.1) < 1, `Sun light-time at J2000 ≈ 491 s (0.983 AU), got ${(g.lightTimeDays * DAY_S).toFixed(1)}`);
  for (const id of ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon']) {
    const a = astrometricGeocentric(eph, id, J2000, newAstrometric());
    assert.ok(a.iterations >= 2 && a.iterations <= 4, `${id}: ${a.iterations} light-time passes (v/c ≈ 1e-4 converges in 3)`);
    assert.ok(Math.abs(a.distAu * LIGHT_TIME_DAYS_PER_AU - a.lightTimeDays) < LIGHT_TIME_TOL_D, `${id}: τ consistent with the final distance`);
    // Geometric vector at t vs astrometric: the body moved τ·V_P in the meantime.
    const P = eph.state(id, J2000), E0 = eph.state('earth', J2000);
    const geo = [P.x - E0.x, P.y - E0.y, P.z - E0.z];
    const lag = Math.hypot(geo[0] - a.x, geo[1] - a.y, geo[2] - a.z);
    const expect = a.lightTimeDays * Math.hypot(P.vx, P.vy, P.vz);
    assert.ok(Math.abs(lag / expect - 1) < 0.01, `${id}: |g_geo − g_astro| = ${lag.toExponential(3)} AU vs τ|V| = ${expect.toExponential(3)} (1 %)`);
  }
  assert.throws(() => astrometricGeocentric(eph, 'earth', J2000), RangeError, 'the Earth has no geocentric place');
  const planetsOnly = createEphemeris(SERIES, { meta: META }).states(J2000, {});
  assert.throws(() => apparentPlace(planetsOnly, 'moon', J2000), RangeError, 'a planet-only states object has no Moon');
});

test('states-snapshot path (Taylor light-time with the two-body acceleration) equals the exact ephemeris iteration to 1e-5″, 1e-9 AU (150 m) and 0.1 m/s', () => {
  for (const body of BODIES) {
    for (const row of FX.bodies[body].rows) {
      const S = eph.states(row.jdTT, {});
      const a = apparentPlace(eph, body, row.jdTT, newApparentPlace());
      const b = apparentPlace(S, body, row.jdTT, newApparentPlace());
      assert.ok(sepArcsec(a.raDeg, a.decDeg, b.raDeg, b.decDeg) < 1e-5, `${body} ${row.jdTT}: astrometric paths differ by ${sepArcsec(a.raDeg, a.decDeg, b.raDeg, b.decDeg).toExponential(2)}″ (measured ≤ 3.7e-6″)`);
      assert.ok(sepArcsec(a.raAppDeg, a.decAppDeg, b.raAppDeg, b.decAppDeg) < 1e-5, `${body} ${row.jdTT}: apparent paths`);
      assert.ok(Math.abs(a.distAu - b.distAu) < 1e-9, `${body} ${row.jdTT}: distance ${Math.abs(a.distAu - b.distAu).toExponential(2)} AU (1e-9 AU = 150 m; measured ≤ 1.6e-10 for Neptune, whose 0.17-day light-time lets the planetary perturbations, absent from the two-body Taylor step, grow as τ²)`);
      assert.ok(Math.abs(a.rangeRateKmS - b.rangeRateKmS) < 1e-4, `${body} ${row.jdTT}: range rate differs by ${Math.abs(a.rangeRateKmS - b.rangeRateKmS).toExponential(2)} km/s (Taylor V − τA at t − τ vs the series; 0.1 m/s — a sign error in the τA term shows as 38 m/s)`);
    }
  }
  // The Moon through a {moon: true} states object matches the ephemeris path too (its τ·V_E term is 21″).
  const S = eph.states(2460400.5, {});
  const a = apparentPlace(eph, 'moon', 2460400.5, newApparentPlace()), b = apparentPlace(S, 'moon', 2460400.5, newApparentPlace());
  assert.ok(sepArcsec(a.raAppDeg, a.decAppDeg, b.raAppDeg, b.decAppDeg) < 1e-3, `moon: paths differ by ${sepArcsec(a.raAppDeg, a.decAppDeg, b.raAppDeg, b.decAppDeg).toExponential(2)}″`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Aberration
// ---------------------------------------------------------------------------------------------------------------------
test('aberration: 20.5″ toward the apex for a perpendicular direction (κ = 20.49552″ at 29.785 km/s), none along the velocity, unit output, Meeus 23.2 to first order', () => {
  const E = eph.state('earth', 2460400.5);
  const v = [E.vx, E.vy, E.vz];
  const vKmS = norm(v) * AU_KM / DAY_S;
  const u = [0, 0, 1]; // ecliptic north: perpendicular to the Earth's velocity to within |ż|/|v| ≈ 1e-5
  const p = aberrate(u, E);
  assert.ok(Math.abs(norm(p) - 1) < 1e-15, 'unit vector');
  const shift = angleBetween(u, p) * ARCSEC_PER_RAD;
  const expected = Math.atan2(norm(v) / C_AU_DAY, Math.sqrt(1 - (norm(v) / C_AU_DAY) ** 2)) * ARCSEC_PER_RAD;
  assert.ok(Math.abs(shift - expected) < 1e-6, `shift ${shift.toFixed(6)}″ vs exact ${expected.toFixed(6)}″ for v = ${vKmS.toFixed(3)} km/s`);
  assert.ok(shift > 20.0 && shift < 21.1, `≈ κ·(v/29.785 km/s): ${shift.toFixed(3)}″ (κ = 20.49552″, Meeus 23.2 constant)`);
  // Toward the apex: the direction is unchanged; the output accepts [x, y, z] velocities too
  const along = aberrate(v, [E.vx, E.vy, E.vz]);
  assert.ok(angleBetween(along, v) * ARCSEC_PER_RAD < 1e-9, 'no aberration along the velocity');
  // First-order (Meeus 23.2 in vector form): p′ ≈ p + V − (p·V)p, V = v/c; the relativistic form differs by O(V²) ≈ 0.002″
  const V = v.map((x) => x / C_AU_DAY);
  const p1 = [u[0] + V[0], u[1] + V[1], u[2] + V[2]];
  assert.ok(angleBetween(p, p1) * ARCSEC_PER_RAD < 0.003, `relativistic vs first-order: ${(angleBetween(p, p1) * ARCSEC_PER_RAD).toExponential(2)}″`);
  const out = [0, 0, 0];
  assert.equal(aberrate({ x: 0, y: 1, z: 0 }, E, out), out, 'writes into out; accepts {x,y,z}');
});

// ---------------------------------------------------------------------------------------------------------------------
// Frame chain and angle helpers
// ---------------------------------------------------------------------------------------------------------------------
test('trueOfDateMatrix = N(T)·P(T)·ECL_TO_EQ built with vec.js (1e-15), proper rotation, cached on jdTT', () => {
  for (const jd of [J2000, 2446895.5, 2460400.5, 2461297.0, 2305448.0, 2670691.0]) {
    const T = (jd - J2000) / DAYS_PER_CENTURY;
    const ref = mat3Mul(nutationMatrix(jd), mat3Mul(precessionMatrix(T), ECL_TO_EQ));
    const M = trueOfDateMatrix(jd);
    let md = 0;
    for (let k = 0; k < 9; k++) md = Math.max(md, Math.abs(M[k] - ref[k]));
    assert.ok(md < 1e-15, `JD ${jd}: max |Δ| ${md.toExponential(2)}`);
    const MMt = mat3Mul(M, mat3T(M));
    for (let k = 0; k < 9; k++) assert.ok(Math.abs(MMt[k] - (k % 4 === 0 ? 1 : 0)) < 1e-14, `JD ${jd}: orthonormal`);
  }
  const out = new Float64Array(9);
  assert.equal(trueOfDateMatrix(J2000, out), out);
  // At J2000 precession is the identity: the matrix is N(J2000)·ECL_TO_EQ (nutation never vanishes, Δψ = −13.9″ then)
  const n0 = mat3Mul(nutationMatrix(J2000), ECL_TO_EQ);
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(out[k] - n0[k]) < 1e-15);
});

test('raDecDeg / lonLatDeg: axes, quadrants and the out parameter', () => {
  assert.deepEqual(raDecDeg([1, 0, 0]), { raDeg: 0, decDeg: 0 });
  assert.deepEqual(raDecDeg([0, 1, 0]), { raDeg: 90, decDeg: 0 });
  assert.deepEqual(raDecDeg([0, 0, 1]), { raDeg: 0, decDeg: 90 });
  assert.deepEqual(raDecDeg([0, -1, 0]), { raDeg: 270, decDeg: 0 }, 'RA wrapped to [0, 360)');
  const o = { lonDeg: 0, latDeg: 0 };
  assert.equal(lonLatDeg([-1, 0, 0], o), o);
  assert.equal(o.lonDeg, 180);
  assert.ok(Math.abs(lonLatDeg([1, 1, Math.SQRT2]).latDeg - 45) < 1e-12);
});

test('apparent Sun: λ☉(apparent, of date) = λ☉(J2000) + p_A·T + Δψ − 20.4898″/R within 1.5″ (Meeus 25: precession, nutation, aberration) at 24 instants', () => {
  for (let k = 0; k < 24; k++) {
    const jd = 2458849.5 + k * 120.5;
    const E = eph.state('earth', jd);
    const R = norm([E.x, E.y, E.z]);
    let lon2000 = Math.atan2(-E.y, -E.x) / DEG;
    if (lon2000 < 0) lon2000 += 360;
    const T = (jd - J2000) / DAYS_PER_CENTURY;
    const pA = 5029.0966 * T + 1.11113 * T * T; // general precession in longitude, Meeus 21.6 (arcsec)
    const n = nutation(jd);
    const predicted = (lon2000 + (pA + n.dpsiArcsec - 20.4898 / R) / 3600 + 360) % 360;
    const got = apparentSunLongitudeDeg(eph, jd);
    const d = ((got - predicted + 540) % 360 - 180) * 3600;
    assert.ok(Math.abs(d) < 1.5, `JD ${jd}: λ☉ apparent ${got.toFixed(6)}° vs Meeus-style prediction ${predicted.toFixed(6)}° (Δ = ${d.toFixed(3)}″; second-order ecliptic-tilt terms < 1″)`);
    const ecl = apparentEcliptic(eph, 'sun', jd);
    assert.equal(ecl.lonDeg, got);
    assert.ok(Math.abs(ecl.latDeg) < 1.5 / 3600, `the Sun's apparent latitude is < 1.5″ (|β| = ${(ecl.latDeg * 3600).toFixed(3)}″)`);
  }
});

test('convenience accessors agree with apparentPlace, reuse `out`, and the Moon\'s apparent place is near the Sun at the 2024-04-08 eclipse', () => {
  const jd = 2460409.26;
  const p = apparentPlace(eph, 'mars', jd);
  const a = astrometricRaDec(eph, 'mars', jd), b = apparentRaDec(eph, 'mars', jd), c = apparentEcliptic(eph, 'mars', jd);
  assert.deepEqual(a, { raDeg: p.raDeg, decDeg: p.decDeg, distAu: p.distAu });
  assert.deepEqual(b, { raDeg: p.raAppDeg, decDeg: p.decAppDeg, distAu: p.distAu });
  assert.deepEqual(c, { lonDeg: p.lonAppDeg, latDeg: p.latAppDeg });
  const out = newApparentPlace();
  assert.equal(apparentPlace(eph, 'venus', jd, out), out);
  assert.equal(out.jdTT, jd);
  assert.ok(out.lightTimeS > 0 && out.lightTimeS === out.distAu * LIGHT_TIME_AU_S);
  // 2024-04-08 greatest eclipse 18:17:16 TD (moon.json): the Moon's apparent place is within 0.5° of the Sun's
  const jdEcl = 2460409.26199;
  const m = apparentPlace(eph, 'moon', jdEcl), s = apparentPlace(eph, 'sun', jdEcl);
  const sep = sepArcsec(m.raAppDeg, m.decAppDeg, s.raAppDeg, s.decAppDeg) / 3600;
  assert.ok(sep < 0.5, `Moon–Sun apparent separation at greatest eclipse ${sep.toFixed(4)}° (geocentric; γ = 0.343 → ≈ 0.33°)`);
  assert.ok(m.distAu * AU_KM > 356000 && m.distAu * AU_KM < 407000, 'lunar distance in range');
});
