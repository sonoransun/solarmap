// seasons.js — equinoxes and solstices from the apparent solar longitude (Meeus ch. 27 definition, Brent root on the
// VSOP87 ephemeris) vs the USNO "Earth's Seasons" table (https://aa.usno.navy.mil/data/Earth_Seasons, UTC, printed to
// the minute) for 2025 and 2026 (task brief), and the events engine's season kinds. Measured 2026-11-06 (ours − USNO,
// minutes): 2025 +0.46 / +0.24 / +0.32 / +0.06; 2026 −0.06 / +0.48 / +0.19 / +0.22 — all within the half-minute the
// table's rounding allows; tolerance ±2 min (brief). The 1962 June solstice comes out at 21:24:41 TT, where Meeus's
// series (Example 27.a) gives 21:25:08 TD and the exact value he quotes is 21:24:42.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import {
  SEASON_KINDS, SEASON_LONGITUDE_DEG, SEASON_BRACKET_HALF_WIDTH_D, meanSeasonJd, seasonRootValue, seasonInstant, seasonsOfYear,
} from '../src/astro/seasons.js';
import { apparentPlace, apparentSunLongitudeDeg } from '../src/astro/apparent.js';
import { nutation } from '../src/astro/nutation.js';
import { findEvents } from '../src/astro/events.js';
import { jdFromCalendar, ttFromUtc, calendarFromJd, utcFromTt } from '../src/astro/time.js';
import { RAD } from '../src/astro/constants.js';

const eph = createEphemeris(SERIES, { meta: META });

/** USNO Earth's Seasons, UTC (year, [month, day, hour, minute] × 4 in SEASON_KINDS order). */
const USNO = {
  2025: [[3, 20, 9, 1], [6, 21, 2, 42], [9, 22, 18, 19], [12, 21, 15, 3]],
  2026: [[3, 20, 14, 46], [6, 21, 8, 24], [9, 23, 0, 5], [12, 21, 20, 50]],
};
const TOL_MIN = 2;

function fmt(jd) {
  const c = calendarFromJd(jd);
  const p = (n) => String(n).padStart(2, '0');
  return `${c.year}-${p(c.month)}-${p(c.day)} ${p(c.hour)}:${p(c.minute)}:${p(c.second)}`;
}

test('2025 and 2026 equinoxes/solstices within ±2 min of the USNO table (measured ≤ 0.5 min)', (t) => {
  let worst = 0;
  for (const [year, rows] of Object.entries(USNO)) {
    const seasons = seasonsOfYear(eph, Number(year));
    assert.deepEqual(seasons.map((s) => s.kind), [...SEASON_KINDS]);
    seasons.forEach((s, i) => {
      const [mo, d, h, mi] = rows[i];
      const ref = jdFromCalendar(Number(year), mo, d, h, mi);
      const dMin = (s.jdUtc - ref) * 1440;
      assert.ok(Math.abs(dMin) <= TOL_MIN, `${year} ${s.kind}: ${fmt(s.jdUtc)} UTC vs USNO ${year}-${mo}-${d} ${h}:${String(mi).padStart(2, '0')} (Δ = ${dMin.toFixed(2)} min > ±${TOL_MIN} min)`);
      assert.ok(Math.abs(s.jdUtc - utcFromTt(s.jdTT)) < 1e-9);
      assert.equal(s.year, Number(year));
      assert.equal(s.sunLongitudeDeg, SEASON_LONGITUDE_DEG[s.kind]);
      assert.ok(Math.abs(s.jdTT - s.meanJdTT) < SEASON_BRACKET_HALF_WIDTH_D - 1, 'the Meeus mean instant is within the bracket with margin');
      worst = Math.max(worst, Math.abs(dMin));
    });
  }
  t.diagnostic(`max |ours − USNO| = ${worst.toFixed(2)} min over 8 instants`);
});

test('at each instant the apparent solar longitude is exactly the multiple of 90° (1e-6°), and the apparent declination is 0 / ±ε', () => {
  for (const s of seasonsOfYear(eph, 2025)) {
    const lon = apparentSunLongitudeDeg(eph, s.jdTT);
    const d = ((lon - s.sunLongitudeDeg + 540) % 360) - 180;
    assert.ok(Math.abs(d) < 1e-6, `${s.kind}: λ☉ = ${lon}° vs ${s.sunLongitudeDeg}° (Δ ${d.toExponential(2)}°; root tolerance 1e-6 d = 0.0036″)`);
    assert.ok(Math.abs(seasonRootValue(eph, s.kind, s.jdTT)) < 1e-7);
    const p = apparentPlace(eph, 'sun', s.jdTT);
    const eps = nutation(s.jdTT).trueObliquityRad * RAD;
    const wantDec = s.kind === 'solstice-june' ? eps : s.kind === 'solstice-december' ? -eps : 0;
    // The Sun's apparent latitude in the ecliptic of date is not exactly 0: VSOP87's Earth sits up to ≈ 1″ off the
    // mean ecliptic (lunar and planetary perturbations), so Dec = β at an equinox is a fraction of an arcsecond.
    assert.ok(Math.abs(p.decAppDeg - wantDec) < 1e-3, `${s.kind}: apparent Dec ${p.decAppDeg.toFixed(6)}° vs ${wantDec.toFixed(6)}° (Sun within 3.6″ of the ecliptic; measured 0.65″)`);
  }
});

test('Meeus mean instants (Table 27.A/B) are within 0.3 d of the exact ones from 1000 to 2500, and Example 27.a (1962 June solstice)', () => {
  for (const year of [1000, 1500, 1962, 2000, 2026, 2100, 2500]) {
    for (const kind of SEASON_KINDS) {
      const s = seasonInstant(eph, year, kind);
      assert.ok(Math.abs(s.jdTT - meanSeasonJd(year, kind)) < 0.3, `${year} ${kind}: exact − mean = ${((s.jdTT - s.meanJdTT) * 24).toFixed(2)} h (Meeus 27.1 correction S/24 ≤ ≈ 0.3 d)`);
    }
  }
  // Example 27.a: June solstice 1962, Meeus series JDE 2437837.39245 (21:25:08 TD); exact 21:24:42 TD (Meeus p. 180)
  const s62 = seasonInstant(eph, 1962, 'solstice-june');
  const c = calendarFromJd(s62.jdTT);
  assert.equal(`${c.year}-${c.month}-${c.day}`, '1962-6-21');
  const secOfDay = c.hour * 3600 + c.minute * 60 + c.second;
  assert.ok(Math.abs(secOfDay - (21 * 3600 + 24 * 60 + 42)) < 60, `1962-06-21 ${c.hour}:${c.minute}:${c.second} TT vs Meeus's exact 21:24:42 (±60 s; measured 1 s)`);
  assert.ok(Math.abs(s62.jdTT - 2437837.39245) < 0.001, 'within 1.4 min of the Meeus series value');
  assert.throws(() => meanSeasonJd(2025, 'spring'), RangeError);
  assert.throws(() => seasonRootValue(eph, 'spring', 2460000.5), RangeError);
  const out = { kind: '', year: 0, jdTT: 0, jdUtc: 0, sunLongitudeDeg: 0, meanJdTT: 0 };
  assert.equal(seasonInstant(eph, 2025, 'equinox-march', out), out, 'writes into out');
});

test('events engine: the four season kinds of 2025 agree with seasons.js to 1 s, score 45, bodies [earth], observable', () => {
  const jd0 = ttFromUtc(jdFromCalendar(2025, 1, 1)), jd1 = ttFromUtc(jdFromCalendar(2026, 1, 1));
  const ev = findEvents(eph, jd0, jd1, { kinds: SEASON_KINDS });
  assert.equal(ev.length, 4, `four season events in 2025 (got ${ev.map((e) => e.kind).join(', ')})`);
  assert.deepEqual(ev.map((e) => e.kind), [...SEASON_KINDS]);
  const ref = seasonsOfYear(eph, 2025);
  ev.forEach((e, i) => {
    assert.ok(Math.abs(e.jdTT - ref[i].jdTT) * 86400 < 1, `${e.kind}: ${fmt(e.jdUtc)} vs seasons.js ${fmt(ref[i].jdUtc)}`);
    assert.equal(e.score, 45);
    assert.deepEqual(e.bodies, ['earth']);
    assert.equal(e.observable, true);
    assert.equal(e.value.sunLongitudeDeg, SEASON_LONGITUDE_DEG[e.kind]);
    assert.ok(e.value.earthDistAu > 0.98 && e.value.earthDistAu < 1.02);
    assert.match(e.label, /equinox|solstice/);
  });
  assert.ok(Math.abs(ev[1].value.sunDeclinationDeg - 23.436) < 0.01, `June solstice declination ${ev[1].value.sunDeclinationDeg.toFixed(4)}° = +ε`);
  assert.ok(Math.abs(ev[3].value.sunDeclinationDeg + 23.436) < 0.01, 'December solstice declination −ε');
  assert.ok(Math.abs(ev[0].value.sunDeclinationDeg) < 1e-3 && Math.abs(ev[2].value.sunDeclinationDeg) < 1e-3, 'equinox declinations 0');
});
