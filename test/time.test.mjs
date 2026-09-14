import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J2000, TT_MINUS_TAI_S, DEG } from '../src/astro/constants.js';
import {
  DAY_MS, JD_UNIX_EPOCH, JD_MJD_EPOCH, JD_LEAP_TABLE_START, LEAP_TABLE_EXPIRES_JD, LEAP_SECONDS, TAI_MINUS_UTC_LAST_S,
  julianDayNumber, jdFromCalendar, calendarFromJd, jdFromDate, dateFromJd, mjdFromJd, decimalYear,
  taiMinusUtc, isLeapTableExpired, deltaTPoly, deltaT, deltaTSeconds, ttFromUtc, utcFromTt, tdbMinusTt, tdbFromTt,
  gmstDeg, gmstRad,
} from '../src/astro/time.js';

/** Deterministic PRNG (mulberry32) so the sampled tests are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JD(UTC) of a proleptic Gregorian date via the JS Date object (independent implementation; years 0–99 handled). */
function jdViaDate(y, m, d, h = 0, mi = 0, s = 0, ms = 0) {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime() / DAY_MS + JD_UNIX_EPOCH;
}

// ---------------------------------------------------------------------------------------------------------------------
// Calendar ↔ JD
// ---------------------------------------------------------------------------------------------------------------------

test('JD anchors are exact (plan §Time)', () => {
  assert.equal(jdFromCalendar(2000, 1, 1, 12), 2451545.0, '2000-01-01T12:00 = J2000 = 2451545.0');
  assert.equal(jdFromCalendar(1970, 1, 1), 2440587.5, '1970-01-01 0h = 2440587.5 (Unix epoch)');
  assert.equal(jdFromCalendar(2023, 2, 25), 2460000.5, '2023-02-25 0h = 2460000.5');
  assert.equal(jdFromCalendar(2026, 9, 13, 12), 2461297.0, '2026-09-13T12:00 = 2461297.0');
  assert.equal(jdFromCalendar(1972, 1, 1), 2441317.5, '1972-01-01 0h = 2441317.5 = MJD 41317');
  assert.equal(jdFromCalendar(2017, 1, 1), 2457754.5, '2017-01-01 0h = 2457754.5 (USNO tai-utc.dat last line)');
  assert.equal(jdFromCalendar(2027, 6, 28), LEAP_TABLE_EXPIRES_JD, 'LEAP_TABLE_EXPIRES_JD 2461584.5 = 2027-06-28 0h');
  assert.equal(LEAP_TABLE_EXPIRES_JD, 2461584.5);
  assert.equal(JD_LEAP_TABLE_START, 2441317.5);
  assert.equal(JD_UNIX_EPOCH, 2440587.5);
  assert.equal(jdFromCalendar(1858, 11, 17), JD_MJD_EPOCH, 'MJD 0 = 1858-11-17 0h = JD 2400000.5');
  assert.equal(mjdFromJd(2441317.5), 41317);
  assert.equal(julianDayNumber(2000, 1, 1), 2451545, 'JDN of 2000-01-01 (Fliegel–Van Flandern check value)');
  assert.equal(jdFromCalendar(2000, 1, 1, 0, 0, 0), 2451544.5);
  assert.equal(jdFromCalendar(2000, 1, 1, 0, 0, 43200), 2451545.0, 'seconds may exceed 60 (linear)');
  assert.equal(jdFromCalendar(2000, 1, 1, 18), 2451545.25);
});

test('calendarFromJd reproduces the anchors field by field', () => {
  assert.deepEqual(calendarFromJd(2451545.0), { year: 2000, month: 1, day: 1, hour: 12, minute: 0, second: 0, ms: 0 });
  assert.deepEqual(calendarFromJd(2440587.5), { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 });
  assert.deepEqual(calendarFromJd(2460000.5), { year: 2023, month: 2, day: 25, hour: 0, minute: 0, second: 0, ms: 0 });
  assert.deepEqual(calendarFromJd(2461297.0), { year: 2026, month: 9, day: 13, hour: 12, minute: 0, second: 0, ms: 0 });
  assert.deepEqual(calendarFromJd(2461584.5), { year: 2027, month: 6, day: 28, hour: 0, minute: 0, second: 0, ms: 0 });
  // 2000-02-29 (leap), 1900-02-28 → +1 d = 1900-03-01 (century, not leap), 2000-12-31 → +1 d = 2001-01-01
  assert.deepEqual(calendarFromJd(jdFromCalendar(2000, 2, 28) + 1), { year: 2000, month: 2, day: 29, hour: 0, minute: 0, second: 0, ms: 0 });
  assert.deepEqual(calendarFromJd(jdFromCalendar(1900, 2, 28) + 1), { year: 1900, month: 3, day: 1, hour: 0, minute: 0, second: 0, ms: 0 });
  assert.deepEqual(calendarFromJd(jdFromCalendar(2000, 12, 31) + 1), { year: 2001, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 });
  // time of day and ms: 2026-09-13 14:32:05.250
  const c = calendarFromJd(jdFromCalendar(2026, 9, 13, 14, 32, 5.25));
  assert.deepEqual(c, { year: 2026, month: 9, day: 13, hour: 14, minute: 32, second: 5, ms: 250 });
  // a fraction that rounds up to 24h carries into the next day instead of producing 24:00:00
  assert.deepEqual(calendarFromJd(jdFromCalendar(2026, 9, 13) + 1 - 1e-10), { year: 2026, month: 9, day: 14, hour: 0, minute: 0, second: 0, ms: 0 });
  // optional out object is filled and returned
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, ms: 0 };
  assert.equal(calendarFromJd(2451545.0, out), out);
  assert.equal(out.year, 2000);
});

test('Date ↔ JD', () => {
  assert.equal(jdFromDate(new Date(Date.UTC(2000, 0, 1, 12))), 2451545.0);
  assert.equal(jdFromDate(new Date(0)), JD_UNIX_EPOCH);
  assert.equal(dateFromJd(2451545.0).toISOString(), '2000-01-01T12:00:00.000Z');
  assert.equal(dateFromJd(2461297.0).toISOString(), '2026-09-13T12:00:00.000Z');
  assert.equal(dateFromJd(jdFromDate(new Date(1234567890123))).getTime(), 1234567890123, 'ms round trip exact');
});

test('proleptic Gregorian negative years (floor-division Fliegel–Van Flandern)', () => {
  // JD 0 = −4713-11-24 12:00 proleptic Gregorian (= 4713 BC Jan 1 12h Julian) — Explanatory Supplement §15.11
  assert.equal(jdFromCalendar(-4713, 11, 24, 12), 0, 'JD 0 = −4713-11-24T12 (proleptic Gregorian)');
  assert.deepEqual(calendarFromJd(0), { year: -4713, month: 11, day: 24, hour: 12, minute: 0, second: 0, ms: 0 });
  // years before −4800 exercise the negative-operand floors of both algorithms; cross-check against JS Date
  for (const [y, m, d] of [[-4712, 1, 1], [-4800, 3, 1], [-4801, 2, 28], [-5000, 6, 15], [-7000, 12, 31], [-1000, 1, 1],
    [-1, 12, 31], [0, 1, 1], [0, 2, 29], [1, 1, 1], [99, 7, 4], [100, 2, 28], [400, 2, 29], [-400, 2, 29], [-100, 3, 1], [1582, 10, 15]]) {
    const jd = jdFromCalendar(y, m, d);
    assert.equal(jd, jdViaDate(y, m, d), `jdFromCalendar(${y}-${m}-${d}) matches Date (proleptic Gregorian)`);
    const c = calendarFromJd(jd);
    assert.deepEqual([c.year, c.month, c.day], [y, m, d], `calendarFromJd(${jd}) → ${y}-${m}-${d}`);
  }
  // year 0 is a leap year (divisible by 400), −100 is not, −400 is
  assert.equal(jdFromCalendar(0, 3, 1) - jdFromCalendar(0, 2, 28), 2, 'year 0 has Feb 29');
  assert.equal(jdFromCalendar(-100, 3, 1) - jdFromCalendar(-100, 2, 28), 1, 'year −100 has no Feb 29');
  assert.equal(jdFromCalendar(-400, 3, 1) - jdFromCalendar(-400, 2, 28), 2, 'year −400 has Feb 29');
});

test('calendar round trips: 1000 seeded JDs in [−1e6, 4e6] agree with Date and invert to the ms', () => {
  const rnd = mulberry32(20260913);
  let maxErr = 0;
  for (let i = 0; i < 1000; i++) {
    const jdn = Math.floor(-1e6 + rnd() * 5e6);
    const msOfDay = Math.floor(rnd() * DAY_MS);
    const jd = jdn - 0.5 + msOfDay / DAY_MS; // JD on the ms grid, 0h-based
    const c = calendarFromJd(jd);
    assert.ok(c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31, `sane fields for JD ${jd}`);
    assert.equal(c.hour * 3600000 + c.minute * 60000 + c.second * 1000 + c.ms, msOfDay, `time of day exact for JD ${jd}`);
    // independent cross-check of the date fields (proleptic Gregorian JS Date)
    assert.equal(jdViaDate(c.year, c.month, c.day), jdn - 0.5, `date fields of JD ${jd} agree with Date → ${c.year}-${c.month}-${c.day}`);
    const back = jdFromCalendar(c.year, c.month, c.day, c.hour, c.minute, c.second + c.ms / 1000);
    maxErr = Math.max(maxErr, Math.abs(back - jd));
  }
  assert.ok(maxErr < 2e-9, `round-trip error ${maxErr} d < 2e-9 d (a few ulp of a JD ≈ 4e6: ulp = 4.7e-10 d; ms grid is 1.16e-8 d)`);
  // integer JDN round trip is exact
  const rnd2 = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const jdn = Math.floor(-1e6 + rnd2() * 5e6);
    const c = calendarFromJd(jdn - 0.5);
    assert.equal(julianDayNumber(c.year, c.month, c.day), jdn, `JDN ${jdn} exact round trip`);
  }
});

test('decimalYear follows the Espenak–Meeus convention y = year + (month − 0.5)/12', () => {
  assert.ok(Math.abs(decimalYear(jdFromCalendar(2000, 1, 15)) - (2000 + 0.5 / 12)) < 1e-12, 'January 2000 → 2000.041667');
  assert.ok(Math.abs(decimalYear(jdFromCalendar(2000, 1, 1)) - decimalYear(jdFromCalendar(2000, 1, 31, 23, 59))) < 1e-12, 'constant within a month');
  assert.ok(Math.abs(decimalYear(jdFromCalendar(1599, 12, 31)) - (1599 + 11.5 / 12)) < 1e-12, 'December 1599 → 1599.958333');
  assert.ok(Math.abs(decimalYear(LEAP_TABLE_EXPIRES_JD) - (2027 + 5.5 / 12)) < 1e-12, 'expiry (June 2027) → 2027.458333');
  assert.ok(Math.abs(decimalYear(jdFromCalendar(-500, 7, 1)) - (-500 + 6.5 / 12)) < 1e-12, 'negative years');
});

// ---------------------------------------------------------------------------------------------------------------------
// Leap seconds
// ---------------------------------------------------------------------------------------------------------------------

test('LEAP_SECONDS is the 28-row IERS table (Bulletin C 72) and taiMinusUtc honours its boundaries', () => {
  assert.equal(LEAP_SECONDS.length, 28, '28 rows, MJD 41317 → 10 s … 57754 → 37 s');
  assert.deepEqual(LEAP_SECONDS[0], [41317, 10]);
  assert.deepEqual(LEAP_SECONDS[27], [57754, 37]);
  assert.equal(TAI_MINUS_UTC_LAST_S, 37);
  for (let i = 1; i < LEAP_SECONDS.length; i++) {
    assert.ok(LEAP_SECONDS[i][0] > LEAP_SECONDS[i - 1][0], 'MJDs strictly increasing');
    assert.equal(LEAP_SECONDS[i][1], LEAP_SECONDS[i - 1][1] + 1, 'each row adds exactly one second');
    const c = calendarFromJd(LEAP_SECONDS[i][0] + JD_MJD_EPOCH);
    assert.ok(c.day === 1 && (c.month === 1 || c.month === 7), 'every leap second is at a 1 Jan / 1 Jul 0h UTC boundary');
  }
  assert.equal(taiMinusUtc(jdFromCalendar(1971, 12, 31, 23, 59, 59)), null, 'null before 1972-01-01');
  assert.equal(taiMinusUtc(jdFromCalendar(1900, 1, 1)), null);
  assert.equal(taiMinusUtc(jdFromCalendar(1972, 1, 1)), 10, '1972-01-01 → 10');
  assert.equal(taiMinusUtc(jdFromCalendar(1972, 6, 30, 23, 59, 59)), 10);
  assert.equal(taiMinusUtc(jdFromCalendar(1972, 7, 1)), 11, '1972-07-01 → 11');
  assert.equal(taiMinusUtc(jdFromCalendar(2000, 1, 1)), 32, '2000-01-01 → 32');
  assert.equal(taiMinusUtc(jdFromCalendar(2016, 12, 31)), 36, '2016-12-31 → 36');
  assert.equal(taiMinusUtc(jdFromCalendar(2016, 12, 31, 23, 59, 59)), 36);
  assert.equal(taiMinusUtc(jdFromCalendar(2017, 1, 1)), 37, '2017-01-01 → 37');
  assert.equal(taiMinusUtc(2461297.0), 37, '2026-09-13 → 37 (Bulletin C 72: no leap second at end of 2026)');
  assert.equal(taiMinusUtc(LEAP_TABLE_EXPIRES_JD + 1000), 37, 'held after the table (assumption)');
  assert.equal(isLeapTableExpired(LEAP_TABLE_EXPIRES_JD - 1), false);
  assert.equal(isLeapTableExpired(LEAP_TABLE_EXPIRES_JD + 1), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// ΔT
// ---------------------------------------------------------------------------------------------------------------------

test('TT − UTC is exactly 32.184 + (TAI − UTC) inside the leap table', () => {
  assert.equal(deltaTSeconds(jdFromCalendar(2000, 1, 1)), 64.184, '2000-01-01: 32.184 + 32 = 64.184 exactly');
  assert.equal(deltaTSeconds(J2000), 64.184);
  assert.equal(deltaTSeconds(2461297.0), 69.184, '2026-09-13: 32.184 + 37 = 69.184 exactly');
  assert.equal(deltaTSeconds(jdFromCalendar(1972, 1, 1)), TT_MINUS_TAI_S + 10, '1972-01-01: 42.184');
  assert.ok(Math.abs((ttFromUtc(J2000) - J2000) - 64.184 / 86400) < 5e-10, 'ttFromUtc adds ΔT/86400 (5e-10 d = one ulp of a JD ≈ 2.45e6: (J2000 + x) − J2000 rounds at that level)');
  const d = deltaT(2461297.0);
  assert.deepEqual(d, { seconds: 69.184, assumed: false });
  const out = { seconds: 0, assumed: true };
  assert.equal(deltaT(J2000, out), out, 'optional out object is returned');
  assert.deepEqual(out, { seconds: 64.184, assumed: false });
});

test('ΔT vs USNO observed values (1972+) within 1 s', () => {
  // USNO deltat.data / historic_deltat.data (research b4iv6z9la.txt §5.4): TT − UT1 at Jan 1
  const usno = [[1980, 50.54], [1990, 56.86], [2000, 63.83], [2010, 66.07], [2020, 69.36], [2024, 69.18], [2026, 69.11]];
  for (const [year, obs] of usno) {
    const dt = deltaTSeconds(jdFromCalendar(year, 1, 1));
    assert.ok(Math.abs(dt - obs) < 1, `ΔT(${year}) = ${dt} vs USNO ${obs} within 1 s (the neglected UT1−UTC is < 0.9 s)`);
  }
});

test('Espenak–Meeus polynomial identities on the right-hand (half-open) segment ±0.02 s', () => {
  const ids = [[0, 10583.60], [1000, 1574.20], [1600, 120.00], [1700, 8.83], [1800, 13.72], [1900, -2.79], [1950, 29.07],
    [2050, 93.00], [2100, 202.74]];
  for (const [y, expected] of ids) {
    const v = deltaTPoly(y);
    assert.ok(Math.abs(v - expected) < 0.02, `deltaTPoly(${y}) = ${v} vs ${expected} ± 0.02 (segment constant term / research §5.3 evaluated values)`);
  }
  // further research §5.3 evaluated values (not on a boundary)
  for (const [y, expected] of [[-1000, 25427.68], [1860, 7.62], [1920, 21.20], [1941, 24.77], [1961, 33.58], [1980, 50.51],
    [1986, 54.88], [1990, 56.89], [2000, 63.86], [2005, 64.67], [2010, 66.70], [2020, 71.60], [2024, 73.87], [2026, 75.07],
    [2150, 328.48], [3000, 4435.68]]) {
    assert.ok(Math.abs(deltaTPoly(y) - expected) < 0.02, `deltaTPoly(${y}) = ${deltaTPoly(y)} vs research §5.3 ${expected} ± 0.02`);
  }
});

test('ΔT (polynomial era) vs USNO 1900 −2.70 and 1950 29.15 within 2 s', () => {
  const dt1900 = deltaTSeconds(jdFromCalendar(1900, 1, 1));
  const dt1950 = deltaTSeconds(jdFromCalendar(1950, 1, 1));
  assert.ok(Math.abs(dt1900 + 2.70) < 2, `ΔT(1900-01-01) = ${dt1900} vs USNO −2.70 within 2 s (polynomial era; plan tolerance)`);
  assert.ok(Math.abs(dt1950 - 29.15) < 2, `ΔT(1950-01-01) = ${dt1950} vs USNO 29.15 within 2 s`);
  assert.equal(deltaT(jdFromCalendar(1900, 1, 1)).assumed, false, 'pre-1972 polynomial values are fits, not assumptions');
});

test('boundary jumps at every polynomial segment edge, at 1972 and at the expiry are < 0.35 s', () => {
  const TOL = 0.35; // plan: measured max 0.31 s at the 1600 boundary (final critique byf0bzyiw.txt)
  const edges = [-500, 500, 1600, 1700, 1800, 1860, 1900, 1920, 1941, 1961, 1986, 2005, 2050, 2150];
  const measured = {};
  // (a) pure polynomial limits: left-hand value at b−ε vs right-hand value at b
  for (const b of edges) {
    const jump = Math.abs(deltaTPoly(b - 1e-9) - deltaTPoly(b));
    measured[`poly ${b}`] = jump;
    assert.ok(jump < TOL, `polynomial jump at ${b}: ${jump.toFixed(3)} s < ${TOL} s (max expected 0.251 s at 1600)`);
  }
  // (b) the calendar-month step across each pre-1972 edge (December of b−1 → January of b), as ΔT is actually evaluated.
  //     From 1600 on the polynomial slope is < 1 s/yr, so the month step is a fair discontinuity measure (plan: 0.31 s at 1600).
  //     At −500 and 500 the slope alone is 1.4 / 0.9 s per month (−15 / −10 s/yr), so there the step is compared with the
  //     mean of the two segments' own 1-month drift; what remains is the discontinuity (measured 0.012 / 0.044 s).
  for (const b of edges.filter((e) => e < 1972)) {
    const before = deltaTSeconds(jdFromCalendar(b - 1, 12, 15));
    const after = deltaTSeconds(jdFromCalendar(b, 1, 15));
    const step = after - before;
    measured[`month ${b}`] = Math.abs(step);
    if (b >= 1600) {
      assert.ok(Math.abs(step) < TOL, `Dec ${b - 1} → Jan ${b} ΔT step ${step.toFixed(3)} s < ${TOL} s (critique: 0.31 s at 1600, ≤ 0.16 s elsewhere)`);
    } else {
      const drift = ((deltaTPoly(b + 1 / 12) - deltaTPoly(b)) + (deltaTPoly(b) - deltaTPoly(b - 1 / 12 + 1e-9))) / 2;
      assert.ok(Math.abs(step - drift) < TOL, `Dec ${b - 1} → Jan ${b} step ${step.toFixed(3)} s minus the polynomial's own monthly drift ${drift.toFixed(3)} s = ${(step - drift).toFixed(3)} s < ${TOL} s`);
    }
  }
  assert.ok(measured['month 1600'] > 0.25 && measured['month 1600'] < 0.32, `1600 step measures ${measured['month 1600'].toFixed(3)} s (expected ≈ 0.31 s)`);
  assert.ok(measured['poly 1600'] > 0.2 && measured['poly 1600'] < 0.26, `1600 pure jump measures ${measured['poly 1600'].toFixed(3)} s (critique: 0.251 s)`);
  // (c) polynomial → leap table at 1972-01-01 0h
  const j1972 = Math.abs(deltaTSeconds(JD_LEAP_TABLE_START - 1e-6) - deltaTSeconds(JD_LEAP_TABLE_START));
  assert.ok(j1972 < TOL, `1972 join: poly(Dec 1971) ${deltaTSeconds(JD_LEAP_TABLE_START - 1e-6).toFixed(3)} vs 42.184: jump ${j1972.toFixed(3)} s < ${TOL} s (critique: 42.25/42.30 vs 42.184)`);
  // (d) leap table → shifted polynomial at the expiry: continuous by construction (same month), then monthly steps
  const jExp = Math.abs(deltaTSeconds(LEAP_TABLE_EXPIRES_JD + 1e-6) - deltaTSeconds(LEAP_TABLE_EXPIRES_JD - 1e-6));
  assert.ok(jExp < 1e-9, `expiry join is continuous by construction: jump ${jExp} s`);
  assert.ok(jExp < TOL);
  const jJuly = Math.abs(deltaTSeconds(jdFromCalendar(2027, 7, 1)) - deltaTSeconds(jdFromCalendar(2027, 6, 30)));
  assert.ok(jJuly < TOL && jJuly > 0, `first post-expiry monthly step (July 2027) ${jJuly.toFixed(4)} s < ${TOL} s`);
});

test('assumed flag and the continuity-shifted extrapolation after the leap-table expiry', () => {
  assert.equal(deltaT(LEAP_TABLE_EXPIRES_JD - 1).assumed, false, 'expiry − 1 d: table value, not assumed');
  assert.equal(deltaT(LEAP_TABLE_EXPIRES_JD).assumed, false, 'the expiry day itself is still inside the table (closed end)');
  assert.equal(deltaT(LEAP_TABLE_EXPIRES_JD + 1).assumed, true, 'expiry + 1 d: assumed');
  assert.equal(deltaT(LEAP_TABLE_EXPIRES_JD - 1).seconds, 69.184);
  assert.equal(deltaT(LEAP_TABLE_EXPIRES_JD + 1).seconds, 69.184, 'same month as the expiry → identical value (continuous)');
  assert.equal(deltaT(J2000).assumed, false);
  assert.equal(deltaT(jdFromCalendar(1600, 1, 1)).assumed, false);
  // definition: 69.184 + (poly(y) − poly(y_expiry)); critique: poly(2027.458) = 75.98, shift 6.80, ΔT(2100) ≈ 195.9
  const yExp = 2027 + 5.5 / 12;
  assert.ok(Math.abs(deltaTPoly(yExp) - 75.98) < 0.01, `poly(y_expiry) = ${deltaTPoly(yExp)} ≈ 75.98`);
  const jd2100 = jdFromCalendar(2100, 1, 1);
  const expected = 69.184 + deltaTPoly(decimalYear(jd2100)) - deltaTPoly(yExp);
  assert.ok(Math.abs(deltaTSeconds(jd2100) - expected) < 1e-9, 'post-expiry formula');
  assert.ok(Math.abs(deltaTSeconds(jd2100) - 195.9) < 0.5, `ΔT(2100-01-01) = ${deltaTSeconds(jd2100).toFixed(2)} s ≈ 195.9 s (critique; raw polynomial 202.74)`);
  assert.ok(deltaTSeconds(jd2100) < deltaTPoly(2100), 'the shifted curve lies below the raw polynomial (which over-predicts)');
  // monotone growth in the future
  assert.ok(deltaTSeconds(jdFromCalendar(2200, 1, 1)) > deltaTSeconds(jd2100));
  assert.ok(deltaTSeconds(jdFromCalendar(4000, 1, 1)) > deltaTSeconds(jdFromCalendar(3000, 1, 1)));
});

test('soft warning (not a failure) when the current date is past the leap-table expiry', () => {
  const now = jdFromDate(new Date());
  if (now > LEAP_TABLE_EXPIRES_JD) {
    console.warn(`[time] The IERS leap-second table expired on 2027-06-28 (JD ${LEAP_TABLE_EXPIRES_JD}); today is JD ${now.toFixed(2)}. `
      + 'ΔT is now the continuity-shifted Espenak–Meeus polynomial (HUD "assumed"). Update LEAP_SECONDS / LEAP_TABLE_EXPIRES_JD '
      + 'from https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat');
  }
  assert.ok(Number.isFinite(now));
  assert.equal(deltaT(now).assumed, now > LEAP_TABLE_EXPIRES_JD, 'assumed flag tracks the expiry for "now"');
});

// ---------------------------------------------------------------------------------------------------------------------
// TT ↔ UTC, TDB
// ---------------------------------------------------------------------------------------------------------------------

test('TT ↔ UTC round trip < 1e-9 d', () => {
  const rnd = mulberry32(7);
  const jd1600 = jdFromCalendar(1600, 1, 1), jd2600 = jdFromCalendar(2600, 1, 1);
  let maxErr = 0;
  for (let i = 0; i < 1000; i++) {
    const utc = jd1600 + rnd() * (jd2600 - jd1600);
    const tt = ttFromUtc(utc);
    const back = utcFromTt(tt);
    maxErr = Math.max(maxErr, Math.abs(back - utc));
    assert.ok(Math.abs(ttFromUtc(back) - tt) < 1e-9, `ttFromUtc(utcFromTt(tt)) = tt at JD ${utc}`);
  }
  for (const utc of [J2000, 2461297.0, jdFromCalendar(-500, 6, 1), jdFromCalendar(1000, 1, 1), jdFromCalendar(-4000, 1, 1), jdFromCalendar(4000, 12, 31),
    JD_LEAP_TABLE_START, LEAP_TABLE_EXPIRES_JD, jdFromCalendar(2016, 12, 31, 23, 59, 58)]) {
    maxErr = Math.max(maxErr, Math.abs(utcFromTt(ttFromUtc(utc)) - utc));
  }
  assert.ok(maxErr < 1e-9, `max |utcFromTt(ttFromUtc(u)) − u| = ${maxErr} d < 1e-9 d (plan tolerance)`);
  assert.ok(ttFromUtc(J2000) > J2000, 'TT runs ahead of UTC');
});

test('|TDB − TT| ≤ 1.7 ms over a year of daily samples; value at J2000', () => {
  let max = 0;
  for (let d = 0; d <= 366; d++) max = Math.max(max, Math.abs(tdbMinusTt(J2000 + d)));
  assert.ok(max <= 1.7e-3, `max |TDB − TT| = ${(max * 1e3).toFixed(4)} ms ≤ 1.7 ms (amplitude 1.658 + 0.014 ms; critique measured 1.658 ms)`);
  assert.ok(max > 1.6e-3, 'the sinusoid is actually exercised (max > 1.6 ms)');
  // g(J2000) = 357.53°: 0.001658 sin g + 0.000014 sin 2g = −7.27e-5 s (judges b1p4znxk4.txt: "−7.27e-5 s with the 2g term")
  assert.ok(Math.abs(tdbMinusTt(J2000) + 7.27e-5) < 1e-7, `tdbMinusTt(J2000) = ${tdbMinusTt(J2000)} ≈ −7.27e-5 s`);
  assert.equal(tdbFromTt(J2000), J2000 + tdbMinusTt(J2000) / 86400);
});

// ---------------------------------------------------------------------------------------------------------------------
// GMST
// ---------------------------------------------------------------------------------------------------------------------

test('GMST: J2000 value, rate, range, Meeus example 12.a', () => {
  assert.ok(Math.abs(gmstDeg(J2000) - 280.46061837) < 1e-8, `gmstDeg(J2000) = ${gmstDeg(J2000)} vs 280.46061837 ± 1e-8`);
  assert.ok(Math.abs(gmstRad(J2000) - 280.46061837 * DEG) < 1e-10);
  // rate: 360.98564736629°/day ≡ 0.98564736629°/day mod 360 (the T² term contributes 3e-13°/day at J2000)
  const rate = ((gmstDeg(J2000 + 1) - gmstDeg(J2000)) % 360 + 360) % 360;
  assert.ok(Math.abs(rate - 0.98564736629) < 1e-9, `GMST rate ${rate + 360}°/day vs 360.98564736629 ± 1e-9`);
  // sidereal day from the rate: 360/360.98564736629 × 24 h = 23.934470 h (plan orientation row, Earth)
  assert.ok(Math.abs((360 / (360 + rate)) * 24 - 23.934470) < 1e-6, 'sidereal day 23.934470 h');
  // Meeus, Astronomical Algorithms ex. 12.a: 1987-04-10 0h UT (JD 2446895.5) → θ0 = 13h10m46.3668s = 197.693195°
  assert.ok(Math.abs(gmstDeg(2446895.5) - 197.693195) < 1e-6, `gmstDeg(2446895.5) = ${gmstDeg(2446895.5)} vs Meeus 197.693195° ± 1e-6`);
  // Meeus ex. 12.b: 1987-04-10 19:21:00 UT → 128.737873°
  assert.ok(Math.abs(gmstDeg(2446895.5 + (19 * 3600 + 21 * 60) / 86400) - 128.737873) < 1e-6, 'Meeus ex. 12.b 128.737873°');
  // range [0, 360) far from J2000 in both directions
  const rnd = mulberry32(3);
  for (let i = 0; i < 500; i++) {
    const jd = -1e6 + rnd() * 5e6;
    const g = gmstDeg(jd);
    assert.ok(g >= 0 && g < 360, `gmstDeg(${jd}) = ${g} in [0, 360)`);
    // split-day evaluation agrees with the naive formula to float precision
    const D = jd - J2000, T = D / 36525;
    const naive = (((280.46061837 + 360.98564736629 * D + 0.000387933 * T * T - T * T * T / 38710000) % 360) + 360) % 360;
    let diff = Math.abs(g - naive); if (diff > 180) diff = 360 - diff;
    assert.ok(diff < 1e-6, `split vs naive formula at JD ${jd}: ${diff}° (naive loses ≈1e-7° to rounding at 3.6e8°)`);
  }
});
