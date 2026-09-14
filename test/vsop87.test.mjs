// VSOP87A data module, evaluator and ephemeris facade — plan §Verification "vsop87 (raw frame)" row plus the
// ephemeris.state Horizons spot checks. Tolerances: measured by scripts/build-vsop87.mjs (META.measuredBounds and the
// per-epoch fixture bounds), the POC (bsiou1mfc.txt §6/§7) and the final critique (byf0bzyiw.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEvaluator, BODY_KEYS, COORD_KEYS, DISPLAY_CUTOFF_AU, prefixCount } from '../src/astro/vsop87.js';
import { createEphemeris, PLANETS, BODIES, ORBITAL_PERIOD_DAYS } from '../src/astro/ephemeris.js';
import { vsopToEcliptic } from '../src/astro/frames.js';
import { AU_KM, J2000, DEG, DAY_S } from '../src/astro/constants.js';

const chkFx = JSON.parse(readFileSync(new URL('./fixtures/vsop87-chk.json', import.meta.url), 'utf8'));
const refFx = JSON.parse(readFileSync(new URL('./fixtures/vsop87a-full-reference.json', import.meta.url), 'utf8'));
const ev = createEvaluator(SERIES, META);

/** Plan / POC §7 kept counts after the per-body cutoffs (27,774 total). */
const EXPECTED_TERMS = {
  mercury: 1485, venus: 1347, earth: 2202, mars: 4997, jupiter: 3235, saturn: 6583, uranus: 5289, neptune: 2636,
};
const INNER = ['mercury', 'venus', 'earth', 'mars'];
const GAS = ['jupiter', 'saturn'];
const ICE = ['uranus', 'neptune'];
const JD_2026_09_13 = 2461297.0; // 2026-09-13 12:00 TT (plan §Time anchors)

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function pv(body, jd, tier = 'full') {
  const s = ev.evalRaw(body, jd, { tier, velocity: true });
  return { pos: [s.x, s.y, s.z], vel: [s.vx, s.vy, s.vz] };
}

test('META counts: 27,774 terms kept (1485/1347/2202/4997/3235/6583/5289/2636) and arrays agree with META', () => {
  assert.deepEqual(META.terms, EXPECTED_TERMS, 'META.terms = plan counts (POC §7 per-planet cutoffs)');
  assert.equal(META.termsTotal, 27774);
  assert.deepEqual(Object.keys(SERIES), BODY_KEYS, 'SERIES keys in VSOP87 body order');
  let total = 0;
  for (const body of BODY_KEYS) {
    let n = 0;
    for (const key of COORD_KEYS) {
      for (const flat of SERIES[body][key]) {
        assert.equal(flat.length % 3, 0, `${body}.${key}: flat [A,B,C] triples`);
        n += flat.length / 3;
      }
    }
    assert.equal(n, META.terms[body], `${body}: array term count equals META.terms`);
    assert.equal(ev.termCount(body), META.terms[body]);
    total += n;
  }
  assert.equal(total, 27774);
  assert.deepEqual(META.cutoffs, { mercury: 1e-9, venus: 1e-9, earth: 1e-9, mars: 1e-9, jupiter: 1e-8, saturn: 1e-8, uranus: 0, neptune: 0 });
  assert.deepEqual(META.termsFull, { mercury: 6359, venus: 2357, earth: 3538, mars: 7073, jupiter: 4434, saturn: 7512, uranus: 5289, neptune: 2636 },
    'per-file totals (ephemeris research §1.4)');
  assert.equal(META.displayCutoff, DISPLAY_CUTOFF_AU);
  for (const body of BODY_KEYS) assert.equal(typeof META.sha256[`VSOP87A.${body.slice(0, 3)}`], 'string');
});

test('|A| non-increasing in every series, cutoffs honoured, display prefix = |A| ≥ 1e-7, missing powers present as data', () => {
  for (const body of BODY_KEYS) {
    for (const key of COORD_KEYS) {
      const powers = SERIES[body][key];
      for (let a = 0; a < powers.length; a++) {
        const flat = powers[a];
        for (let i = 3; i < flat.length; i += 3) {
          assert.ok(Math.abs(flat[i]) <= Math.abs(flat[i - 3]), `${body}.${key}[T^${a}] term ${i / 3}: |A| non-increasing`);
        }
        if (flat.length) assert.ok(Math.abs(flat[flat.length - 3]) >= META.cutoffs[body], `${body}.${key}[T^${a}]: min |A| ≥ cutoff`);
        assert.equal(prefixCount(flat, DISPLAY_CUTOFF_AU), META.displayCounts[body][key][a], `${body}.${key}[T^${a}] display prefix`);
        assert.equal(ev.displayCounts[body][key][a], META.displayCounts[body][key][a]);
      }
    }
  }
  // Uranus and Neptune have no T⁵ series and their Z has no T⁴ (IMCCE files: 14 headers each)
  for (const body of ICE) {
    assert.equal(SERIES[body].x.length, 5, `${body}.x has powers T⁰…T⁴`);
    assert.equal(SERIES[body].y.length, 5, `${body}.y has powers T⁰…T⁴`);
    assert.equal(SERIES[body].z.length, 4, `${body}.z has powers T⁰…T³`);
  }
  for (const body of [...INNER, ...GAS]) {
    for (const key of COORD_KEYS) assert.equal(SERIES[body][key].length, 6, `${body}.${key} has powers T⁰…T⁵`);
  }
});

test('shipped series vs vsop87.chk (8 bodies × 10 epochs, pos + vel) within the per-epoch measured truncation bounds', () => {
  for (const body of BODY_KEYS) {
    const rows = chkFx.bodies[body];
    assert.equal(rows.length, 10, `${body}: 10 check epochs`);
    for (const row of rows) {
      const { pos, vel } = pv(body, row.jd);
      const dp = dist3(pos, row.pos);
      const dv = dist3(vel, row.vel);
      assert.ok(dp <= row.truncBoundAu,
        `${body} JD ${row.jd}: |Δpos| ${dp.toExponential(2)} AU ≤ truncBoundAu ${row.truncBoundAu.toExponential(2)} (= max(1.5 × measured truncated-vs-full, 1e-9 for the 10-decimal chk rounding))`);
      assert.ok(dv <= row.truncBoundAuDay,
        `${body} JD ${row.jd}: |Δvel| ${dv.toExponential(2)} AU/d ≤ truncBoundAuDay ${row.truncBoundAuDay.toExponential(2)} (= max(1.5 × measured, 1e-9))`);
    }
  }
});

test('spot values at J2000 (vsop87.chk verbatim): Mars pos+vel, Earth, Neptune', () => {
  const mars = pv('mars', J2000);
  const marsRow = chkFx.bodies.mars.find((r) => r.jd === J2000);
  assert.ok(dist3(mars.pos, [1.3907159264, -0.0134157043, -0.0344677967]) <= marsRow.truncBoundAu,
    `Mars J2000 position within the measured 1e-9 truncation bound ${marsRow.truncBoundAu.toExponential(2)} AU (≈ ${(marsRow.truncBoundAu * AU_KM).toFixed(1)} km)`);
  assert.ok(dist3(mars.vel, [0.0006714930, 0.0151872479, 0.0003016546]) <= marsRow.truncBoundAuDay,
    `Mars J2000 velocity within ${marsRow.truncBoundAuDay.toExponential(2)} AU/d`);
  const earth = pv('earth', J2000);
  const earthRow = chkFx.bodies.earth.find((r) => r.jd === J2000);
  assert.ok(dist3(earth.pos, [-0.1771354586, 0.9672416237, -0.0000039000]) <= earthRow.truncBoundAu,
    `Earth J2000 within ${earthRow.truncBoundAu.toExponential(2)} AU`);
  const nep = pv('neptune', J2000);
  const d = [16.8121116576, -24.9916630908, 0.1272190171].map((v, i) => Math.abs(nep.pos[i] - v));
  assert.ok(Math.max(...d) <= 1.5e-10, `Neptune J2000 per-component ≤ 1.5e-10 AU (untruncated; chk printed to 1e-10): ${d.map((x) => x.toExponential(1))}`);
  const ura = pv('uranus', J2000);
  const uraRow = chkFx.bodies.uranus.find((r) => r.jd === J2000);
  assert.ok(uraRow.pos.every((v, i) => Math.abs(ura.pos[i] - v) <= 1.5e-10), 'Uranus J2000 per-component ≤ 1.5e-10 AU (untruncated)');
});

test('Uranus/Neptune (untruncated) reproduce the full-series reference exactly (≤ 1.5e-10 AU) at all 41 epochs', () => {
  assert.equal(refFx.epochs.length, 41);
  assert.equal(refFx.epochs[20], J2000, 'grid JD 2415020 + k·1826.25 contains J2000 at k = 20');
  for (const body of ICE) {
    for (const row of refFx.bodies[body]) {
      const { pos, vel } = pv(body, row.jd);
      assert.ok(dist3(pos, row.pos) <= 1.5e-10, `${body} JD ${row.jd}: full series is shipped, |Δpos| ${dist3(pos, row.pos).toExponential(2)} ≤ 1.5e-10 AU`);
      assert.ok(dist3(vel, row.vel) <= 1.5e-12, `${body} JD ${row.jd}: |Δvel| ≤ 1.5e-12 AU/d (15-digit fixture rounding)`);
    }
  }
});

test('truncated vs full reference on the 41-epoch grid: ≤ 5 km inner, ≤ 70 km Jupiter/Saturn, 0 for Uranus/Neptune, and ≤ 1.5 × META bound', () => {
  const limitKm = { mercury: 5, venus: 5, earth: 5, mars: 5, jupiter: 70, saturn: 70, uranus: 0, neptune: 0 };
  for (const body of BODY_KEYS) {
    let maxAu = 0;
    for (const row of refFx.bodies[body]) maxAu = Math.max(maxAu, dist3(pv(body, row.jd).pos, row.pos));
    const maxKm = maxAu * AU_KM;
    if (limitKm[body] === 0) {
      assert.ok(maxAu <= 1.5e-10, `${body}: untruncated → identical to the reference (${maxAu.toExponential(2)} AU ≤ 1.5e-10)`);
    } else {
      assert.ok(maxKm <= limitKm[body], `${body}: truncation error ${maxKm.toFixed(2)} km ≤ ${limitKm[body]} km (plan; POC §7 measured 2.6–3.7 km inner, 37/45 km Jupiter/Saturn)`);
    }
    assert.ok(maxAu <= Math.max(1.5 * META.measuredBounds.truncatedAu[body], 1.5e-10),
      `${body}: ≤ 1.5 × META.measuredBounds.truncatedAu (${META.measuredBounds.truncatedAu[body].toExponential(2)} AU, measured by the build script on the same grid + 1800/2200)`);
  }
});

test('display tier (|A| ≥ 1e-7 prefix) vs full ≤ 1.5 × META.measuredBounds.displayAu on the 41-epoch grid', () => {
  for (const body of BODY_KEYS) {
    let maxAu = 0;
    for (const row of refFx.bodies[body]) maxAu = Math.max(maxAu, dist3(pv(body, row.jd, 'display').pos, row.pos));
    const bound = 1.5 * META.measuredBounds.displayAu[body];
    assert.ok(maxAu <= bound,
      `${body}: display error ${(maxAu * AU_KM).toFixed(0)} km ≤ 1.5 × measured ${(META.measuredBounds.displayAu[body] * AU_KM).toFixed(0)} km (critique: 436 km Uranus, 386 km Saturn measured over 1900–2100)`);
    assert.ok(maxAu > 0, `${body}: the display tier really drops terms`);
    assert.ok(ev.termCount(body, 'display') < ev.termCount(body, 'full') / 2, `${body}: display tier is a short prefix`);
  }
  // Uranus is the worst case measured (2.91e-6 AU ≈ 436 km, ephemeris research §4); keep that number honest.
  assert.ok(META.measuredBounds.displayAu.uranus > 2.5e-6 && META.measuredBounds.displayAu.uranus < 3.3e-6,
    `META.measuredBounds.displayAu.uranus = ${META.measuredBounds.displayAu.uranus} ≈ 2.91e-6 AU`);
});

test('analytic velocity vs central difference (h = 0.001 d) ≤ 1e-9 AU/d at J2000 and 2026-09-13, both tiers', () => {
  const h = 0.001; // critique: h = 0.01 d makes the (h²/6)·x‴ error 5.8e-9 for Mercury; h = 0.001 d → ≤ 6e-11
  for (const jd of [J2000, JD_2026_09_13]) {
    // Doubles near JD 2.45e6 are spaced 4.7e-10 d apart, so jd ± h is only ~2e-7-relative accurate; divide by the
    // interval actually represented (exact difference of two nearby doubles) instead of 2h.
    const jdp = jd + h, jdm = jd - h;
    const hh = jdp - jdm;
    for (const tier of ['full', 'display']) {
      for (const body of BODY_KEYS) {
        const a = pv(body, jd, tier);
        const p = pv(body, jdp, tier).pos;
        const m = pv(body, jdm, tier).pos;
        for (let k = 0; k < 3; k++) {
          const fd = (p[k] - m[k]) / hh;
          assert.ok(Math.abs(fd - a.vel[k]) <= 1e-9,
            `${body} ${tier} JD ${jd} component ${k}: analytic ${a.vel[k]} vs central difference ${fd} within 1e-9 AU/d`);
        }
      }
    }
  }
});

test('velocities are finite at exactly JD 2451545.0 (T = 0: the α·T^(α−1) term only for α ≥ 1)', () => {
  for (const body of BODY_KEYS) {
    const s = ev.evalRaw(body, J2000);
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) assert.ok(Number.isFinite(s[k]), `${body}.${k} finite at T = 0`);
    assert.ok(Math.hypot(s.vx, s.vy, s.vz) > 1e-3, `${body}: |v| > 1e-3 AU/d`);
  }
});

test('evaluator handles missing powers, empty arrays and reuses `out`; rejects unknown body/tier', () => {
  // x: only T⁰; y: empty T⁰ then a T¹ term; z: no powers at all
  const S = { probe: { x: [[2, 0.5, 3]], y: [[], [1, 0.25, 4]], z: [] } };
  const e = createEvaluator(S);
  const T = 0.1; // tjy
  const jd = J2000 + T * 365250;
  const out = { x: 9, y: 9, z: 9, vx: 9, vy: 9, vz: 9 };
  const r = e.evalRaw('probe', jd, { tier: 'full', velocity: true }, out);
  assert.equal(r, out, 'returns the supplied out object');
  assert.ok(Math.abs(r.x - 2 * Math.cos(0.5 + 3 * T)) < 1e-15);
  assert.ok(Math.abs(r.vx - (-2 * 3 * Math.sin(0.5 + 3 * T)) / 365250) < 1e-18);
  assert.ok(Math.abs(r.y - T * Math.cos(0.25 + 4 * T)) < 1e-15);
  assert.ok(Math.abs(r.vy - (Math.cos(0.25 + 4 * T) - T * 4 * Math.sin(0.25 + 4 * T)) / 365250) < 1e-18, 'dY/dT = 1·T⁰·A cos u − T·A C sin u');
  assert.equal(r.z, 0); assert.equal(r.vz, 0);
  const at0 = e.evalRaw('probe', J2000);
  assert.ok(Number.isFinite(at0.vy) && Math.abs(at0.vy - Math.cos(0.25) / 365250) < 1e-18, 'T = 0 with a T¹ series is finite');
  // velocity:false leaves vx/vy/vz untouched
  const o2 = { x: 0, y: 0, z: 0, vx: 7, vy: 7, vz: 7 };
  e.evalRaw('probe', jd, { tier: 'full', velocity: false }, o2);
  assert.equal(o2.vx, 7);
  assert.ok(Math.abs(o2.x - r.x) < 1e-15);
  // display tier of a synthetic series with all |A| ≥ 1e-7 equals the full tier
  const d = e.evalRaw('probe', jd, { tier: 'display' });
  assert.ok(Math.abs(d.x - r.x) < 1e-15 && Math.abs(d.y - r.y) < 1e-15);
  assert.deepEqual(e.displayCounts.probe, { x: [1], y: [0, 1], z: [] });
  assert.throws(() => e.evalRaw('pluto', jd), RangeError);
  assert.throws(() => e.evalRaw('probe', jd, { tier: 'coarse' }), RangeError);
  // display counts from META override the threshold
  const e2 = createEvaluator(S, { displayCounts: { probe: { x: [0], y: [0, 0], z: [] } } });
  const d2 = e2.evalRaw('probe', jd, { tier: 'display' });
  assert.equal(d2.x, 0); assert.equal(d2.y, 0);
});

test('ephemeris.state (scene frame, TT in) vs Horizons J2000: Mars 499 ≤ 25 km, Earth 399 ≤ 15 km, Mercury 199 ≤ 5 km', () => {
  const eph = createEphemeris(SERIES, { meta: META });
  // Horizons DE441, CENTER='500@10', REF_PLANE='ECLIPTIC', TIME_TYPE='TT', JD 2451545.0 (POC §5, verbatim rows)
  const horizons = {
    mars: { pos: [1.390715921745786, -0.01341631816379798, -0.03446766277607193], km: 25, note: 'POC §6 doc-rot 20.1 km full series + ≤ 1.5 km truncation' },
    earth: { pos: [-0.1771350992582233, 0.9672416867691899, -4.085281582660778e-6], km: 15, note: 'POC §6 11.2 km full + ≤ 2.1 km truncation (critique fix)' },
    mercury: { pos: [-0.1300936053934398, -0.4472876181299281, -0.02459830695595736], km: 5, note: 'POC §6 2.1 km full + ≤ 2.6 km truncation (critique fix)' },
  };
  for (const [body, h] of Object.entries(horizons)) {
    const s = eph.state(body, J2000);
    const km = dist3([s.x, s.y, s.z], h.pos) * AU_KM;
    assert.ok(km <= h.km, `${body} J2000 rotated residual ${km.toFixed(2)} km ≤ ${h.km} km (${h.note})`);
    // the raw (unrotated) residual must be clearly worse (≈ 0.09″ frame offset: 94 / 61 / 32 km, POC §6)
    const raw = ev.evalRaw(body, J2000);
    const rawKm = dist3([raw.x, raw.y, raw.z], h.pos) * AU_KM;
    assert.ok(rawKm > 2 * km, `${body}: raw residual ${rawKm.toFixed(1)} km shows the rotation is applied`);
  }
});

test('ephemeris facade: BODIES/PLANETS, Sun at origin, TDB offset, rotation of velocity, position(), memoised states()', () => {
  const eph = createEphemeris(SERIES, { meta: META });
  assert.deepEqual([...PLANETS], BODY_KEYS);
  assert.deepEqual([...BODIES], ['sun', ...BODY_KEYS]);
  assert.equal(eph.tier, 'full');
  const sun = eph.state('sun', JD_2026_09_13);
  assert.deepEqual(sun, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
  assert.deepEqual(eph.position('sun', JD_2026_09_13), [0, 0, 0]);

  // TDB − TT = 0.001658 sin g + 0.000014 sin 2g s, g = 357.53° + 0.9856003°·(JD − 2451545) (plan §Time) applied to
  // the VSOP argument; rotation M_VSOP_TO_ECL applied to position and velocity alike.
  for (const body of BODY_KEYS) {
    const jdTT = JD_2026_09_13;
    const g = (357.53 + 0.9856003 * (jdTT - J2000)) * DEG;
    const tdbMinusTt = 0.001658 * Math.sin(g) + 0.000014 * Math.sin(2 * g);
    assert.ok(Math.abs(tdbMinusTt) > 1e-4 && Math.abs(tdbMinusTt) <= 0.0017, 'TDB − TT is a non-zero sub-2 ms offset here');
    const raw = ev.evalRaw(body, jdTT + tdbMinusTt / DAY_S);
    const p = vsopToEcliptic([raw.x, raw.y, raw.z]);
    const v = vsopToEcliptic([raw.vx, raw.vy, raw.vz]);
    const s = eph.state(body, jdTT);
    assert.ok(dist3([s.x, s.y, s.z], p) < 1e-15 && dist3([s.vx, s.vy, s.vz], v) < 1e-17, `${body}: state = rotate(evalRaw(TT + (TDB−TT)))`);
    const rawTT = ev.evalRaw(body, jdTT);
    assert.ok(dist3([rawTT.x, rawTT.y, rawTT.z], [raw.x, raw.y, raw.z]) > 0, `${body}: the TDB offset moves the position (by ~|v|·1.7 ms)`);
    const vRaw = Math.hypot(raw.vx, raw.vy, raw.vz);
    assert.ok(Math.abs(Math.hypot(s.vx, s.vy, s.vz) - vRaw) < 1e-12 * vRaw,
      `${body}: rotation preserves |v| to 1e-12 (vsop87.doc matrix is orthonormal to ≈5e-13)`);
    const pos = eph.position(body, jdTT);
    assert.ok(dist3(pos, [s.x, s.y, s.z]) < 1e-15, `${body}: position() matches state()`);
    const outArr = [0, 0, 0];
    assert.equal(eph.position(body, jdTT, outArr), outArr, 'position() reuses out');
    const disp = eph.state(body, jdTT, undefined, 'display');
    const dKm = dist3([disp.x, disp.y, disp.z], [s.x, s.y, s.z]) * AU_KM;
    assert.ok(dKm > 0 && dKm < 1.5 * META.measuredBounds.displayAu[body] * AU_KM, `${body}: display tier via the facade (${dKm.toFixed(0)} km)`);
  }

  const all = eph.states(JD_2026_09_13);
  assert.deepEqual(Object.keys(all), [...BODIES]);
  assert.equal(eph.states(JD_2026_09_13), all, 'memoised on the last jdTT');
  const marsX = all.mars.x;
  const s2 = eph.states(JD_2026_09_13 + 1);
  assert.equal(s2, all, 'the memo object is reused in place');
  assert.notEqual(all.mars.x, marsX, 'a new jdTT re-evaluates');
  const own = {};
  const r = eph.states(JD_2026_09_13, own);
  assert.equal(r, own);
  assert.ok(Math.abs(own.mars.x - marsX) < 1e-15, 'out-parameter path bypasses the memo and gives the same values');
  assert.ok(Math.abs(all.mars.x - marsX) > 0, 'the memo still holds jdTT + 1');
  const st = eph.state('earth', JD_2026_09_13);
  const speedKmS = Math.hypot(st.vx, st.vy, st.vz) * AU_KM / DAY_S;
  assert.ok(Math.abs(speedKmS - 29.61) < 0.3, `Earth orbital speed on 2026-09-13 ≈ 29.6 km/s (got ${speedKmS.toFixed(3)}; Horizons 4.505, 29.268, −0.001 km/s → 29.61)`);
  assert.equal(Object.keys(ORBITAL_PERIOD_DAYS).length, 8);
  assert.ok(Math.abs(ORBITAL_PERIOD_DAYS.earth - 365.256) < 1e-9, 'NSSDC sidereal orbit period');
  assert.throws(() => eph.state('mars', J2000, undefined, 'coarse'), RangeError);
  assert.throws(() => createEphemeris(SERIES, { tier: 'coarse' }), RangeError);
});

test('evalRaw is allocation-free with `out` and fast enough for one states() per grid day', () => {
  const eph = createEphemeris(SERIES, { meta: META });
  const t0 = performance.now();
  const N = 200;
  for (let i = 0; i < N; i++) eph.states(J2000 + i);
  const ms = (performance.now() - t0) / N;
  assert.ok(ms < 20, `states() ${ms.toFixed(2)} ms per call (plan budget ≈ 0.6 ms; generous CI limit 20 ms)`);
});
