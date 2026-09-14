import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AU_KM, C_KM_S, LIGHT_TIME_AU_S } from '../src/astro/constants.js';
import { jdnFromGregorian, jdFromGregorian } from '../src/astro/clock.js';
import {
  THIN_SPACE, SEP, gregorianFromJdn, calendarFromJd, formatUtc, formatDate, formatJd, formatDeltaT, groupThousands,
  formatAu, formatKm, formatLightTime, formatDistance, formatSpeed, formatKmPerS, formatDeg, formatArcmin, formatAngle,
  formatLonLat, formatPeriod, formatRate,
} from '../src/astro/format.js';

const TS = THIN_SPACE;
assert.equal(TS, ' ', 'thousands separator is U+2009 THIN SPACE');

test('formatUtc: plan fixtures, exact', () => {
  assert.equal(formatUtc(2451545.0), '2000-01-01 12:00:00 UTC', 'J2000.0');
  assert.equal(formatUtc(2452878.910556), '2003-08-27 09:51:12 UTC', 'plan §Verification "format" (Mars closest approach 2003)');
  assert.equal(formatUtc(2440587.5), '1970-01-01 00:00:00 UTC', 'Unix epoch');
  assert.equal(formatUtc(2461297.0), '2026-09-13 12:00:00 UTC');
  assert.equal(formatUtc(2451545.0, { seconds: false }), '2000-01-01 12:00 UTC');
  assert.equal(formatUtc(NaN), '—');
  assert.equal(formatDate(2452878.910556), '2003-08-27');
});

test('formatUtc: negative and small years are zero-padded proleptic Gregorian', () => {
  assert.equal(formatUtc(jdFromGregorian(-500, 3, 1, 6, 7, 8)), '-0500-03-01 06:07:08 UTC');
  assert.equal(formatUtc(jdFromGregorian(0, 1, 1)), '0000-01-01 00:00:00 UTC', 'year 0 = 1 BC');
  assert.equal(formatUtc(jdFromGregorian(-1, 12, 31, 23, 59, 59)), '-0001-12-31 23:59:59 UTC');
  assert.equal(formatUtc(jdFromGregorian(-4000, 1, 1)), '-4000-01-01 00:00:00 UTC', 'clamp lower limit');
  assert.equal(formatUtc(jdFromGregorian(4000, 12, 31, 23, 59, 59)), '4000-12-31 23:59:59 UTC', 'clamp upper limit');
  assert.equal(formatUtc(jdFromGregorian(1582, 10, 15)), '1582-10-15 00:00:00 UTC', 'JDN 2299161');
  assert.equal(formatUtc(jdFromGregorian(1582, 10, 4)), '1582-10-04 00:00:00 UTC', 'proleptic: no Julian gap');
});

test('formatUtc rounds to the nearest second and carries through minute/hour/day/month/year', () => {
  assert.equal(formatUtc(jdFromGregorian(2000, 12, 31, 23, 59, 59.6)), '2001-01-01 00:00:00 UTC', 'carry into the next year');
  assert.equal(formatUtc(jdFromGregorian(2000, 12, 31, 23, 59, 59.4)), '2000-12-31 23:59:59 UTC');
  assert.equal(formatUtc(jdFromGregorian(2024, 2, 28, 23, 59, 59.7)), '2024-02-29 00:00:00 UTC', 'leap day');
  assert.equal(formatUtc(jdFromGregorian(2100, 2, 28, 23, 59, 59.7)), '2100-03-01 00:00:00 UTC', '2100 is not a leap year');
  assert.equal(formatUtc(jdFromGregorian(2024, 2, 29, 23, 59, 59.5), { seconds: false }), '2024-03-01 00:00 UTC', 'minute rounding carries');
  assert.equal(formatUtc(jdFromGregorian(2024, 2, 29, 23, 59, 29.9), { seconds: false }), '2024-02-29 23:59 UTC');
});

test('gregorianFromJdn is the exact inverse of jdnFromGregorian over −4000…+4000 (Fliegel–Van Flandern)', () => {
  const out = [0, 0, 0];
  for (let y = -4000; y <= 4000; y++) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    for (const [m, d] of [[1, 1], [2, 28], [2, leap ? 29 : 28], [3, 1], [6, 30], [12, 31]]) {
      const jdn = jdnFromGregorian(y, m, d);
      gregorianFromJdn(jdn, out);
      assert.ok(out[0] === y && out[1] === m && out[2] === d, `${y}-${m}-${d} → JDN ${jdn} → ${out.join('-')}`);
    }
    // consecutive years are 365/366 days apart
    assert.equal(jdnFromGregorian(y + 1, 1, 1) - jdnFromGregorian(y, 1, 1), leap ? 366 : 365, `year length ${y}`);
  }
  assert.deepEqual(gregorianFromJdn(0), [-4713, 11, 24], 'JD 0 (Gregorian)');
  assert.deepEqual(gregorianFromJdn(2451545), [2000, 1, 1]);
  assert.deepEqual(calendarFromJd(2451545.0), [2000, 1, 1, 12, 0, 0]);
  assert.deepEqual(calendarFromJd(2452878.910556), [2003, 8, 27, 9, 51, 12]);
});

test('gregorianFromJdn matches JS Date (proleptic Gregorian) on a random sample', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 5000; i++) {
    const jdn = Math.floor(260089 + rnd() * (3182395 - 260089));
    const dt = new Date((jdn - 2440587.5 - 0.5) * 86400000 + 43200000); // noon of that JDN
    const [y, m, d] = gregorianFromJdn(jdn);
    assert.ok(y === dt.getUTCFullYear() && m === dt.getUTCMonth() + 1 && d === dt.getUTCDate(), `JDN ${jdn}`);
  }
});

test('formatJd and formatDeltaT, exact', () => {
  assert.equal(formatJd(2461297), 'JD 2461297.00000');
  assert.equal(formatJd(2451545.123456789), 'JD 2451545.12346');
  assert.equal(formatDeltaT(69.184), '69.184 s', 'plan fixture (2020s ΔT = 32.184 + 37)');
  assert.equal(formatDeltaT(69.3, true), '69.3 s (assumed)');
  assert.equal(formatDeltaT(69.184, false), '69.184 s');
  assert.equal(formatDeltaT(-2.5, true), '-2.5 s (assumed)');
  assert.equal(formatDeltaT(NaN), '—');
});

test('groupThousands uses thin spaces', () => {
  assert.equal(groupThousands(0), '0');
  assert.equal(groupThousands(999), '999');
  assert.equal(groupThousands(1000), `1${TS}000`);
  assert.equal(groupThousands(59958), `59${TS}958`);
  assert.equal(groupThousands(1234567.6), `1${TS}234${TS}568`);
  assert.equal(groupThousands(-384400), `-384${TS}400`);
});

test('formatAu: 4 decimals, 6 below 0.01 AU', () => {
  assert.equal(formatAu(0.37272), '0.3727 AU');
  assert.equal(formatAu(9.54), '9.5400 AU');
  assert.equal(formatAu(0.002569555), '0.002570 AU', 'Moon distance 384 400 km');
  assert.equal(formatAu(0.01), '0.0100 AU', 'boundary is inclusive for 4 decimals');
  assert.equal(formatAu(0.0099999), '0.010000 AU');
});

test('formatKm: M km above 1e6 km, grouped integer below', () => {
  assert.equal(formatKm(55758318.5), '55.76 M km');
  assert.equal(formatKm(1e6), '1.00 M km');
  assert.equal(formatKm(999999.4), `999${TS}999 km`);
  assert.equal(formatKm(384400), `384${TS}400 km`);
  assert.equal(formatKm(42), '42 km');
  assert.equal(formatKm(9.54 * AU_KM), '1427.16 M km', 'Saturn: 9.54 AU');
});

test('formatLightTime: ss s / m min ss s / h h mm min', () => {
  assert.equal(formatLightTime(0), '0 s');
  assert.equal(formatLightTime(1.3), '1 s');
  assert.equal(formatLightTime(59.4), '59 s');
  assert.equal(formatLightTime(59.5), '1 min 00 s', 'rounding carries into the minute form');
  assert.equal(formatLightTime(186), '3 min 06 s');
  assert.equal(formatLightTime(499.004783836), '8 min 19 s', '1 AU = 8.316746 min');
  assert.equal(formatLightTime(89 * 60 + 59.4), '89 min 59 s');
  assert.equal(formatLightTime(90 * 60), '1 h 30 min');
  assert.equal(formatLightTime(4 * 3600 + 9.5 * 60), '4 h 10 min', 'rounded to the minute');
  assert.equal(formatLightTime(9.54 * LIGHT_TIME_AU_S), '79 min 21 s', 'Saturn 9.54 AU → 79.3 light-min (critique byf0bzyiw)');
  assert.equal(formatLightTime(30.1 * LIGHT_TIME_AU_S), '4 h 10 min', 'Neptune');
});

test('formatDistance composite, exact', () => {
  assert.equal(formatDistance(0.37272), `0.3727 AU${SEP}55.76 M km${SEP}3 min 06 s`, 'plan §Formatting example');
  assert.equal(SEP, ' · ');
  assert.equal(formatDistance(1), `1.0000 AU${SEP}149.60 M km${SEP}8 min 19 s`);
  assert.equal(formatDistance(384400 / AU_KM), `0.002570 AU${SEP}384${TS}400 km${SEP}1 s`, 'Moon mean distance');
});

test('formatSpeed: km/s below 0.5 c, 2 decimals to 10 c, grouped integer above', () => {
  assert.equal(formatSpeed(1), '1.00 c', 'plan fixture');
  assert.equal(formatSpeed(346), '346 c', 'plan fixture (Earth → Mars peak)');
  assert.equal(formatSpeed(0.2), `59${TS}958 km/s`, `0.2 × ${C_KM_S} = 59958.49 → rounded`);
  assert.equal(formatSpeed(15804), `15${TS}804 c`, 'Earth → Neptune peak');
  assert.equal(formatSpeed(1340), `1${TS}340 c`, 'plan §Formatting example');
  assert.equal(formatSpeed(0.87), '0.87 c');
  assert.equal(formatSpeed(0.5), '0.50 c', 'boundary: 0.5 c shows in c');
  assert.equal(formatSpeed(0.4999), `149${TS}866 km/s`);
  assert.equal(formatSpeed(10), '10 c', 'boundary: 10 c is an integer');
  assert.equal(formatSpeed(9.994), '9.99 c');
  assert.equal(formatSpeed(0), '0 km/s');
  assert.equal(formatSpeed(-2), '2.00 c', 'magnitude only');
  assert.equal(formatSpeed(1e-4), '30 km/s');
  assert.equal(formatKmPerS(29.7827), '29.78 km/s', 'Earth orbital speed');
  assert.equal(formatKmPerS(123.456), '123.5 km/s');
});

test('angles', () => {
  assert.equal(formatDeg(23.4393), '23.44°');
  assert.equal(formatDeg(23.4393, 1), '23.4°');
  assert.equal(formatDeg(-1.018, 3), '-1.018°');
  assert.equal(formatArcmin(12.34), '12.3′');
  assert.equal(formatArcmin(0.5, 2), '0.50′');
  assert.equal(formatAngle(26.73), '26.73°');
  assert.equal(formatAngle(0.25), '15.0′', 'below 1° → arcminutes');
  assert.equal(formatLonLat(-1.018, 'EW'), '1.02° W');
  assert.equal(formatLonLat(3.676, 'NS'), '3.68° N');
  assert.equal(formatLonLat(0, 'EW'), '0.00° E');
});

test('periods and rates (Bodies tab / timeline labels)', () => {
  assert.equal(formatPeriod(0.41354), '9.925 h', 'Jupiter 9.92492 h');
  assert.equal(formatPeriod(58.64615), '58.646 d', 'Mercury');
  assert.equal(formatRate(1), '1 d/s');
  assert.equal(formatRate(-365.25), '−1 y/s');
  assert.equal(formatRate(1 / 86400), 'real time');
  assert.equal(formatRate(1 / 24), '1 h/s');
  assert.equal(formatRate(7), '7 d/s');
  assert.equal(formatRate(30.436875), '1 mo/s');
  assert.equal(formatRate(3652.5), '10 y/s');
  assert.equal(formatRate(0), 'paused');
});
