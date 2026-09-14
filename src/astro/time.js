// Time scales: calendar ↔ Julian Date, leap seconds (TAI−UTC), ΔT (TT−UTC), TT/TDB, GMST.
// Conventions (CLAUDE.md): the sim clock and every UI value are JD(UTC); the ephemeris argument is
// JD(TT) = JD(UTC) + ΔT/86400 with ONE ΔT function used for both display and conversion; calendar is proleptic Gregorian.
// Sources:
//  - Fliegel, H. F. & Van Flandern, T. C. (1968), "A Machine Algorithm for Processing Calendar Dates", Comm. ACM 11(10) 657;
//    floor-division form (valid for negative years) per Richards, Explanatory Supplement to the Astronomical Almanac 3rd ed. §15.11.
//  - IERS Leap_Second.dat (https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat), "Updated through IERS Bulletin 72 issued
//    in July 2026", "File expires on 28 June 2027"; Bulletin C 72 (Paris, 6 July 2026): no leap second at end of December 2026.
//    (research b4iv6z9la.txt §5.1)
//  - Espenak & Meeus ΔT polynomials, https://eclipse.gsfc.nasa.gov/SEcat5/deltatpoly.html (2007 Oct 03), verbatim
//    (research b4iv6z9la.txt §5.3); observed values for tests from USNO deltat.data / historic_deltat.data (§5.4).
//  - TDB − TT: Astronomical Almanac approximation as given at https://lweb.cfa.harvard.edu/~jzhao/times.html (§5.2).
//  - GMST: IAU 1982 (Aoki et al. 1982), Meeus, Astronomical Algorithms 2nd ed. eq. 12.4.
import { J2000, DAYS_PER_CENTURY, TT_MINUS_TAI_S, DAY_S, DEG } from './constants.js';

/** Milliseconds per day. */
export const DAY_MS = 86400000;
/** JD of the Unix epoch 1970-01-01T00:00:00Z (Date.getTime() = 0). */
export const JD_UNIX_EPOCH = 2440587.5;
/** JD of MJD 0 (1858-11-17 0h): MJD = JD − 2400000.5. */
export const JD_MJD_EPOCH = 2400000.5;
/** JD of 1972-01-01 0h UTC (MJD 41317): first row of the IERS leap-second table; UTC as we know it starts here. */
export const JD_LEAP_TABLE_START = 2441317.5;
/**
 * IERS Leap_Second.dat "File expires on 28 June 2027" → 2027-06-28 0h UTC (Bulletin C 72, 6 July 2026).
 * Beyond this JD, TAI−UTC = 37 s is an assumption (`deltaT().assumed`).
 */
export const LEAP_TABLE_EXPIRES_JD = 2461584.5;

// ---------------------------------------------------------------------------------------------------------------------
// Calendar ↔ Julian Date (proleptic Gregorian, valid for all integer years incl. negative)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Julian Day Number of a proleptic Gregorian date (the JD at 12h UT of that date).
 * Fliegel & Van Flandern (1968) with every division taken as floor division, so the formula is exact for negative
 * years too (the original Fortran form relies on truncation toward zero and is only valid after −4713).
 *   a = ⌊(14 − m)/12⌋, y = Y + 4800 − a, m' = m + 12a − 3
 *   JDN = d + ⌊(153 m' + 2)/5⌋ + 365 y + ⌊y/4⌋ − ⌊y/100⌋ + ⌊y/400⌋ − 32045
 * @param {number} year astronomical year (1 BC = 0, 2 BC = −1, …)
 * @param {number} month 1–12
 * @param {number} day 1–31 (a fractional day is added linearly)
 * @returns {number} JDN (integer for an integer day)
 */
export function julianDayNumber(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

/**
 * JD of a proleptic Gregorian calendar date/time (UTC or any other scale — the function is scale-agnostic).
 * Anchors: 2000-01-01T12:00 → 2451545.0, 1970-01-01 → 2440587.5, 2023-02-25 → 2460000.5, 2026-09-13T12 → 2461297.0.
 * @param {number} year astronomical year (may be negative)
 * @param {number} month 1–12
 * @param {number} day 1–31
 * @param {number} [hour=0]
 * @param {number} [minute=0]
 * @param {number} [second=0] may be fractional (milliseconds)
 * @returns {number} Julian Date
 */
export function jdFromCalendar(year, month, day, hour = 0, minute = 0, second = 0) {
  // JD starts at noon: JDN − 0.5 is 0h of the civil day.
  return julianDayNumber(year, month, day) - 0.5 + (hour * 3600 + minute * 60 + second) / DAY_S;
}

/**
 * @typedef {{year:number, month:number, day:number, hour:number, minute:number, second:number, ms:number}} CalendarDate
 */

/**
 * Proleptic Gregorian calendar date/time of a JD, resolved to the nearest millisecond (JD doubles near 2.4e6 have a
 * resolution of ≈40 µs, so ms is the honest display granularity; a fraction rounding up to 24h carries into the next day).
 * Inverse of Fliegel & Van Flandern (1968), floor-division form (Richards 2013 §15.11.4), valid for negative JDN:
 *   L = JDN + 68569; N = ⌊4L/146097⌋; L −= ⌊(146097 N + 3)/4⌋; I = ⌊4000 (L + 1)/1461001⌋; L = L − ⌊1461 I/4⌋ + 31;
 *   J = ⌊80 L/2447⌋; D = L − ⌊2447 J/80⌋; L = ⌊J/11⌋; M = J + 2 − 12 L; Y = 100 (N − 49) + I + L
 * (after the century subtraction L ∈ [0, 36525) so only the first two floors ever see a negative operand).
 * @param {number} jd Julian Date
 * @param {CalendarDate} [out] optional result object (no allocation in hot paths)
 * @returns {CalendarDate}
 */
export function calendarFromJd(jd, out) {
  const o = out || { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, ms: 0 };
  let jdn = Math.floor(jd + 0.5);
  let ms = Math.round((jd + 0.5 - jdn) * DAY_MS);
  if (ms >= DAY_MS) { ms -= DAY_MS; jdn += 1; }
  let L = jdn + 68569;
  const N = Math.floor((4 * L) / 146097);
  L -= Math.floor((146097 * N + 3) / 4);
  const I = Math.floor((4000 * (L + 1)) / 1461001);
  L = L - Math.floor((1461 * I) / 4) + 31;
  const J = Math.floor((80 * L) / 2447);
  o.day = L - Math.floor((2447 * J) / 80);
  L = Math.floor(J / 11);
  o.month = J + 2 - 12 * L;
  o.year = 100 * (N - 49) + I + L;
  o.hour = Math.floor(ms / 3600000);
  ms -= o.hour * 3600000;
  o.minute = Math.floor(ms / 60000);
  ms -= o.minute * 60000;
  o.second = Math.floor(ms / 1000);
  o.ms = ms - o.second * 1000;
  return o;
}

/** @param {Date} date @returns {number} JD(UTC): Date.getTime() is ms since 1970-01-01T00:00:00Z = JD 2440587.5 */
export function jdFromDate(date) {
  return date.getTime() / DAY_MS + JD_UNIX_EPOCH;
}

/** @param {number} jd JD(UTC) @returns {Date} rounded to the nearest millisecond */
export function dateFromJd(jd) {
  return new Date(Math.round((jd - JD_UNIX_EPOCH) * DAY_MS));
}

/** @param {number} jd @returns {number} Modified Julian Date = JD − 2400000.5 */
export function mjdFromJd(jd) {
  return jd - JD_MJD_EPOCH;
}

/** Module-level scratch so decimalYear() allocates nothing (single-threaded; workers get their own module instance). */
const scratchCal = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, ms: 0 };

/**
 * Decimal year in the Espenak–Meeus convention used by their ΔT polynomials: y = year + (month − 0.5)/12
 * (https://eclipse.gsfc.nasa.gov/SEcat5/deltatpoly.html), i.e. piecewise constant within a calendar month.
 * @param {number} jdUtc
 * @returns {number} decimal year
 */
export function decimalYear(jdUtc) {
  const c = calendarFromJd(jdUtc, scratchCal);
  return c.year + (c.month - 0.5) / 12;
}

// ---------------------------------------------------------------------------------------------------------------------
// Leap seconds
// ---------------------------------------------------------------------------------------------------------------------

/**
 * IERS leap-second table, verbatim from https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat
 * ("Updated through IERS Bulletin 72 issued in July 2026", "File expires on 28 June 2027"): [[MJD, TAI−UTC seconds]].
 * Each row applies from 0h UTC of that MJD until the next row. USNO tai-utc.dat agrees (last line
 * "2017 JAN 1 =JD 2457754.5 TAI-UTC= 37.0 S").
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const LEAP_SECONDS = Object.freeze([
  [41317, 10], // 1972-01-01
  [41499, 11], // 1972-07-01
  [41683, 12], // 1973-01-01
  [42048, 13], // 1974-01-01
  [42413, 14], // 1975-01-01
  [42778, 15], // 1976-01-01
  [43144, 16], // 1977-01-01
  [43509, 17], // 1978-01-01
  [43874, 18], // 1979-01-01
  [44239, 19], // 1980-01-01
  [44786, 20], // 1981-07-01
  [45151, 21], // 1982-07-01
  [45516, 22], // 1983-07-01
  [46247, 23], // 1985-07-01
  [47161, 24], // 1988-01-01
  [47892, 25], // 1990-01-01
  [48257, 26], // 1991-01-01
  [48804, 27], // 1992-07-01
  [49169, 28], // 1993-07-01
  [49534, 29], // 1994-07-01
  [50083, 30], // 1996-01-01
  [50630, 31], // 1997-07-01
  [51179, 32], // 1999-01-01
  [53736, 33], // 2006-01-01
  [54832, 34], // 2009-01-01
  [56109, 35], // 2012-07-01
  [57204, 36], // 2015-07-01
  [57754, 37], // 2017-01-01
]);

/** TAI−UTC of the last table row (37 s), held as an assumption after LEAP_TABLE_EXPIRES_JD. */
export const TAI_MINUS_UTC_LAST_S = LEAP_SECONDS[LEAP_SECONDS.length - 1][1];

/**
 * TAI − UTC in whole seconds from the IERS table; null before 1972-01-01 (the 1961–1971 "rubber-second" era is not
 * modelled — pre-1972 dates use the ΔT polynomials directly). After the last row the value is held (37 s).
 * @param {number} jdUtc
 * @returns {number|null} seconds
 */
export function taiMinusUtc(jdUtc) {
  const mjd = jdUtc - JD_MJD_EPOCH;
  if (mjd < LEAP_SECONDS[0][0]) return null;
  // Scan from the end: the present is the common case; 28 rows, no allocation.
  for (let i = LEAP_SECONDS.length - 1; i >= 0; i--) {
    if (mjd >= LEAP_SECONDS[i][0]) return LEAP_SECONDS[i][1];
  }
  return null; // unreachable (guarded above)
}

/** @param {number} jdUtc @returns {boolean} true when jdUtc is past the IERS table's stated expiry */
export function isLeapTableExpired(jdUtc) {
  return jdUtc > LEAP_TABLE_EXPIRES_JD;
}

// ---------------------------------------------------------------------------------------------------------------------
// ΔT
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Espenak & Meeus (2006) ΔT polynomials, verbatim from https://eclipse.gsfc.nasa.gov/SEcat5/deltatpoly.html
 * (page dated 2007 Oct 03), 15 segments on half-open intervals [a, b) so that y = 1600 evaluates on the 1600–1700
 * segment (120.00 s), y = 1900 on the 1900–1920 segment (−2.79 s), etc. Argument y = year + (month − 0.5)/12.
 * The −500 value was changed by the authors from 17190 to 17203.7 "to avoid discontinuity". The largest remaining
 * segment jump is 0.25 s at 1600 (p500(1600) = 120.251 vs 120.000); all others ≤ 0.16 s. The "Canon" lunar
 * correction c = −0.000012932 (y − 1955)² is NOT applied (planets only).
 * @param {number} y decimal year (Espenak–Meeus convention)
 * @returns {number} ΔT = TT − UT in seconds
 */
export function deltaTPoly(y) {
  let u, t;
  if (y < -500) {
    // Before the year −500: ΔT = −20 + 32 u², u = (y − 1820)/100
    u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }
  if (y < 500) {
    // Between −500 and +500: u = y/100
    u = y / 100;
    return 10583.6 - 1014.41 * u + 33.78311 * u ** 2 - 5.952053 * u ** 3
      - 0.1798452 * u ** 4 + 0.022174192 * u ** 5 + 0.0090316521 * u ** 6;
  }
  if (y < 1600) {
    // Between +500 and +1600: u = (y − 1000)/100
    u = (y - 1000) / 100;
    return 1574.2 - 556.01 * u + 71.23472 * u ** 2 + 0.319781 * u ** 3
      - 0.8503463 * u ** 4 - 0.005050998 * u ** 5 + 0.0083572073 * u ** 6;
  }
  if (y < 1700) {
    // Between +1600 and +1700: t = y − 1600
    t = y - 1600;
    return 120 - 0.9808 * t - 0.01532 * t ** 2 + t ** 3 / 7129;
  }
  if (y < 1800) {
    // Between +1700 and +1800: t = y − 1700
    t = y - 1700;
    return 8.83 + 0.1603 * t - 0.0059285 * t ** 2 + 0.00013336 * t ** 3 - t ** 4 / 1174000;
  }
  if (y < 1860) {
    // Between +1800 and +1860: t = y − 1800
    t = y - 1800;
    return 13.72 - 0.332447 * t + 0.0068612 * t ** 2 + 0.0041116 * t ** 3 - 0.00037436 * t ** 4
      + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7;
  }
  if (y < 1900) {
    // Between 1860 and 1900: t = y − 1860
    t = y - 1860;
    return 7.62 + 0.5737 * t - 0.251754 * t ** 2 + 0.01680668 * t ** 3
      - 0.0004473624 * t ** 4 + t ** 5 / 233174;
  }
  if (y < 1920) {
    // Between 1900 and 1920: t = y − 1900
    t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4;
  }
  if (y < 1941) {
    // Between 1920 and 1941: t = y − 1920
    t = y - 1920;
    return 21.20 + 0.84493 * t - 0.076100 * t ** 2 + 0.0020936 * t ** 3;
  }
  if (y < 1961) {
    // Between 1941 and 1961: t = y − 1950
    t = y - 1950;
    return 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547;
  }
  if (y < 1986) {
    // Between 1961 and 1986: t = y − 1975
    t = y - 1975;
    return 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718;
  }
  if (y < 2005) {
    // Between 1986 and 2005: t = y − 2000
    t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4
      + 0.00002373599 * t ** 5;
  }
  if (y < 2050) {
    // Between 2005 and 2050: t = y − 2000 [derived from estimated ΔT 2010 = 66.9 s and 2050 = 93 s]
    t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t ** 2;
  }
  if (y < 2150) {
    // Between 2050 and 2150: ΔT = −20 + 32 ((y − 1820)/100)² − 0.5628 (2150 − y)
    u = (y - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - y);
  }
  // After 2150: ΔT = −20 + 32 u², u = (y − 1820)/100
  u = (y - 1820) / 100;
  return -20 + 32 * u * u;
}

/** Decimal year of the leap-table expiry (2027-06-28 → 2027 + 5.5/12) — the continuity point of the extrapolation. */
const Y_EXPIRY = decimalYear(LEAP_TABLE_EXPIRES_JD);
/** Espenak–Meeus polynomial at the expiry (75.980 s; the observed value there is ≈ 69.1 s, hence the shift). */
const POLY_AT_EXPIRY = deltaTPoly(Y_EXPIRY);
/** ΔT held through the table's validity: 32.184 + 37 = 69.184 s (USNO observed 2026-01-01: 69.11 s). */
const DELTA_T_AT_EXPIRY_S = TT_MINUS_TAI_S + TAI_MINUS_UTC_LAST_S;

/**
 * @typedef {{seconds:number, assumed:boolean}} DeltaT
 */

/**
 * ΔT = TT − UTC in seconds — the ONE function used for both HUD display and the UTC→TT conversion:
 *  - jdUtc < 1972-01-01: Espenak–Meeus polynomial of y = year + (month − 0.5)/12 (UT1 ≈ UTC is meaningless pre-1972).
 *  - 1972-01-01 ≤ jdUtc ≤ LEAP_TABLE_EXPIRES_JD: 32.184 + (TAI − UTC) (UT1−UTC, |DUT1| < 0.9 s, is ignored;
 *    checks: 64.184 s at 2000-01-01 vs USNO 63.83; 69.184 s at 2024-01-01 vs USNO 69.18).
 *  - jdUtc > expiry: 69.184 + (poly(y) − poly(y_expiry)) — the polynomial's slope continued from the last measured
 *    value (continuous at the expiry by construction; the raw polynomial over-predicts by ≈6.8 s), `assumed = true`.
 * @param {number} jdUtc
 * @param {DeltaT} [out] optional result object (no allocation in hot paths)
 * @returns {DeltaT}
 */
export function deltaT(jdUtc, out) {
  const o = out || { seconds: 0, assumed: false };
  if (jdUtc < JD_LEAP_TABLE_START) {
    o.seconds = deltaTPoly(decimalYear(jdUtc));
    o.assumed = false;
  } else if (jdUtc <= LEAP_TABLE_EXPIRES_JD) {
    o.seconds = TT_MINUS_TAI_S + /** @type {number} */ (taiMinusUtc(jdUtc));
    o.assumed = false;
  } else {
    o.seconds = DELTA_T_AT_EXPIRY_S + (deltaTPoly(decimalYear(jdUtc)) - POLY_AT_EXPIRY);
    o.assumed = true;
  }
  return o;
}

/** Scratch for deltaTSeconds (no allocation per frame). */
const scratchDeltaT = { seconds: 0, assumed: false };

/** @param {number} jdUtc @returns {number} ΔT = TT − UTC in seconds (see deltaT) */
export function deltaTSeconds(jdUtc) {
  return deltaT(jdUtc, scratchDeltaT).seconds;
}

// ---------------------------------------------------------------------------------------------------------------------
// TT, TDB
// ---------------------------------------------------------------------------------------------------------------------

/** @param {number} jdUtc @returns {number} JD(TT) = JD(UTC) + ΔT/86400 */
export function ttFromUtc(jdUtc) {
  return jdUtc + deltaTSeconds(jdUtc) / DAY_S;
}

/**
 * Inverse of ttFromUtc by fixed-point iteration (two steps suffice: ΔT varies by < 1 s per day, so the first estimate is
 * already within microseconds unless a leap-second/monthly step lies between UTC and TT, which the second step resolves).
 * @param {number} jdTT
 * @returns {number} JD(UTC)
 */
export function utcFromTt(jdTT) {
  let utc = jdTT - deltaTSeconds(jdTT) / DAY_S;
  utc = jdTT - deltaTSeconds(utc) / DAY_S;
  return utc;
}

/**
 * TDB − TT in seconds, Astronomical Almanac approximation (https://lweb.cfa.harvard.edu/~jzhao/times.html; research
 * b4iv6z9la.txt §5.2): 0.001658 sin g + 0.000014 sin 2g, g = 357.53° + 0.9856003° (JD − 2451545.0). |TDB−TT| ≤ 1.66 ms.
 * @param {number} jdTT
 * @returns {number} seconds
 */
export function tdbMinusTt(jdTT) {
  const g = (357.53 + 0.9856003 * (jdTT - J2000)) * DEG;
  return 0.001658 * Math.sin(g) + 0.000014 * Math.sin(2 * g);
}

/** @param {number} jdTT @returns {number} JD(TDB) = JD(TT) + (TDB − TT)/86400 (the VSOP87 argument) */
export function tdbFromTt(jdTT) {
  return jdTT + tdbMinusTt(jdTT) / DAY_S;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sidereal time
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Greenwich mean sidereal time, IAU 1982 (Aoki et al.; Meeus AA 2nd ed. eq. 12.4):
 *   θ0 = 280.46061837 + 360.98564736629 D + 0.000387933 T² − T³/38710000 (degrees), D = JD_UT1 − 2451545, T = D/36525.
 * The linear term is split into integer and fractional days (360.98564736629 D ≡ 0.98564736629 ⌊D⌋ + 360.98564736629 (D − ⌊D⌋)
 * mod 360) so the reduction mod 360 does not lose precision far from J2000. Check: Meeus ex. 12.a, 1987-04-10 0h UT
 * (JD 2446895.5) → 197.693195°.
 * @param {number} jdUT1 JD(UT1) (UT1 ≈ UTC for this app)
 * @returns {number} GMST in degrees, [0, 360)
 */
export function gmstDeg(jdUT1) {
  const D = jdUT1 - J2000;
  const Di = Math.floor(D);
  const Df = D - Di;
  const T = D / DAYS_PER_CENTURY;
  let g = 280.46061837 + 0.98564736629 * Di + 360.98564736629 * Df + 0.000387933 * T * T - T * T * T / 38710000;
  g %= 360;
  if (g < 0) g += 360;
  return g;
}

/** @param {number} jdUT1 @returns {number} GMST in radians, [0, 2π) */
export function gmstRad(jdUT1) {
  return gmstDeg(jdUT1) * DEG;
}
