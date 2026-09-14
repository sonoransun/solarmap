// Pure string formatting for the HUD, panels and toasts (plan §Formatting). No DOM, no locale: strings are
// deterministic so tests can compare them exactly. Calendar: proleptic Gregorian, UTC everywhere (CLAUDE.md).
// Thousands are grouped with U+2009 THIN SPACE (plan: "1 340 c", "grouped integer km").
import { AU_KM, C_KM_S, LIGHT_TIME_AU_S } from './constants.js';

/** U+2009 THIN SPACE, the thousands separator used by every grouped number. */
export const THIN_SPACE = ' ';
/** U+00B7 MIDDLE DOT surrounded by spaces, the separator of composite strings ("0.3727 AU · 55.76 M km · 3 min 06 s"). */
export const SEP = ' · ';

const DAY_S = 86400;

/**
 * Proleptic Gregorian calendar date of a Julian Day Number — inverse Fliegel & Van Flandern (1968),
 * CACM 11(10):657, https://doi.org/10.1145/364096.364097, verbatim algorithm (integer division = floor here, which
 * equals FORTRAN truncation because every intermediate is non-negative for JDN ≥ 0, i.e. years ≥ −4712):
 *   L = JD + 68569; N = 4L/146097; L = L − (146097N + 3)/4; I = 4000(L + 1)/1461001; L = L − 1461I/4 + 31;
 *   J = 80L/2447; K = L − 2447J/80; L = J/11; J = J + 2 − 12L; I = 100(N − 49) + I + L   → year I, month J, day K
 * @param {number} jdn integer Julian Day Number
 * @param {number[]} [out] optional [year, month, day]
 * @returns {number[]} [year, month, day] (astronomical year numbering)
 */
export function gregorianFromJdn(jdn, out = [0, 0, 0]) {
  let l = jdn + 68569;
  const n = Math.floor((4 * l) / 146097);
  l -= Math.floor((146097 * n + 3) / 4);
  let i = Math.floor((4000 * (l + 1)) / 1461001);
  l = l - Math.floor((1461 * i) / 4) + 31;
  let j = Math.floor((80 * l) / 2447);
  const k = l - Math.floor((2447 * j) / 80);
  l = Math.floor(j / 11);
  j = j + 2 - 12 * l;
  i = 100 * (n - 49) + i + l;
  out[0] = i; out[1] = j; out[2] = k;
  return out;
}

/**
 * Split a JD(UTC) into a proleptic Gregorian date and time, rounded to the nearest whole second (or minute) so that a
 * displayed "…:59.6" never shows as ":59" with a stale minute: the rounding is done on the total second count and then
 * carried through the day.
 * @param {number} jd Julian Date (UTC)
 * @param {boolean} [seconds=true] round to seconds; when false, round to minutes
 * @param {number[]} [out] optional [year, month, day, hour, minute, second]
 * @returns {number[]} [year, month, day, hour, minute, second]
 */
export function calendarFromJd(jd, seconds = true, out = [0, 0, 0, 0, 0, 0]) {
  // Whole seconds since JD 0.0 minus half a day, i.e. since the civil day boundary of JDN 0 (−4712-01-01 00:00 Julian).
  const unit = seconds ? 1 : 60;
  const total = Math.round(((jd + 0.5) * DAY_S) / unit) * unit;
  const days = Math.floor(total / DAY_S);
  const sod = total - days * DAY_S; // seconds of day, 0…86399
  gregorianFromJdn(days, out);
  out[3] = Math.floor(sod / 3600);
  out[4] = Math.floor((sod - out[3] * 3600) / 60);
  out[5] = sod - out[3] * 3600 - out[4] * 60;
  return out;
}

const cal = [0, 0, 0, 0, 0, 0];

/**
 * Format a JD(UTC) as 'YYYY-MM-DD hh:mm:ss UTC' (proleptic Gregorian; negative years as '-0500-03-01', year 0 as '0000').
 * @param {number} jdUtc Julian Date (UTC)
 * @param {object} [opts]
 * @param {boolean} [opts.seconds=true] include seconds (rounded); false → 'YYYY-MM-DD hh:mm UTC' rounded to the minute
 * @returns {string}
 */
export function formatUtc(jdUtc, { seconds = true } = {}) {
  if (!Number.isFinite(jdUtc)) return '—';
  calendarFromJd(jdUtc, seconds, cal);
  const y = cal[0];
  const ys = (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0');
  const hm = `${ys}-${pad2(cal[1])}-${pad2(cal[2])} ${pad2(cal[3])}:${pad2(cal[4])}`;
  return seconds ? `${hm}:${pad2(cal[5])} UTC` : `${hm} UTC`;
}

/**
 * 'YYYY-MM-DD' only (for the date input value; same rounding as formatUtc with seconds).
 * @param {number} jdUtc
 * @returns {string}
 */
export function formatDate(jdUtc) {
  if (!Number.isFinite(jdUtc)) return '—';
  calendarFromJd(jdUtc, true, cal);
  const y = cal[0];
  return `${(y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0')}-${pad2(cal[1])}-${pad2(cal[2])}`;
}

/**
 * 'JD 2461297.00000' (5 decimals ≈ 0.9 s).
 * @param {number} jd
 * @returns {string}
 */
export function formatJd(jd) {
  if (!Number.isFinite(jd)) return 'JD —';
  return `JD ${jd.toFixed(5)}`;
}

/**
 * ΔT = TT − UTC: '69.184 s' (3 decimals: the leap-second table is exact) or '69.3 s (assumed)' (1 decimal: polynomial).
 * @param {number} seconds ΔT in seconds
 * @param {boolean} [assumed=false] true outside the leap-second table (polynomial extrapolation)
 * @returns {string}
 */
export function formatDeltaT(seconds, assumed = false) {
  if (!Number.isFinite(seconds)) return '—';
  return assumed ? `${seconds.toFixed(1)} s (assumed)` : `${seconds.toFixed(3)} s`;
}

/**
 * Group an integer's thousands with THIN SPACE: 59958 → '59 958'. Handles the sign; input is rounded first.
 * @param {number} n
 * @returns {string}
 */
export function groupThousands(n) {
  const v = Math.round(n);
  const s = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += THIN_SPACE;
    out += s[i];
  }
  return (v < 0 ? '-' : '') + out;
}

/**
 * Distance in AU: 4 decimals, 6 below 0.01 AU (plan §Formatting). '0.3727 AU', '0.002571 AU'.
 * @param {number} au
 * @returns {string}
 */
export function formatAu(au) {
  if (!Number.isFinite(au)) return '— AU';
  return `${au.toFixed(Math.abs(au) < 0.01 ? 6 : 4)} AU`;
}

/**
 * Distance in km: 'xx.xx M km' at or above 1e6 km, else the grouped integer '384 400 km' (plan §Formatting).
 * @param {number} km
 * @returns {string}
 */
export function formatKm(km) {
  if (!Number.isFinite(km)) return '— km';
  if (Math.abs(km) >= 1e6) return `${(km / 1e6).toFixed(2)} M km`;
  return `${groupThousands(km)} km`;
}

/**
 * Light-time: 'ss s' below 60 s, 'm min ss s' below 90 min, else 'h h mm min' (plan §Formatting).
 * Rounded to whole seconds (whole minutes in the hour form) before splitting so carries are honoured.
 * @param {number} seconds
 * @returns {string}
 */
export function formatLightTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.round(Math.abs(seconds));
  if (s < 60) return `${s} s`;
  if (s < 90 * 60) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
  const m = Math.round(Math.abs(seconds) / 60);
  return `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
}

/**
 * Composite distance 'AU · M km · light-time', e.g. 0.37272 → '0.3727 AU · 55.76 M km · 3 min 06 s'.
 * km = AU × 149 597 870.700; light-time = AU × 499.004783836 s (constants.js).
 * @param {number} au
 * @returns {string}
 */
export function formatDistance(au) {
  return formatAu(au) + SEP + formatKm(au * AU_KM) + SEP + formatLightTime(au * LIGHT_TIME_AU_S);
}

/**
 * Speed given in units of c: below 0.5 c as a grouped integer km/s ('59 958 km/s'); 0.5 c…10 c with 2 decimals
 * ('0.87 c', '1.00 c'); 10 c and above as a grouped integer ('346 c', '1 340 c', '15 804 c') (plan §Formatting).
 * @param {number} speedC speed / c
 * @returns {string}
 */
export function formatSpeed(speedC) {
  if (!Number.isFinite(speedC)) return '—';
  const v = Math.abs(speedC);
  if (v < 0.5) return `${groupThousands(v * C_KM_S)} km/s`;
  if (v < 10) return `${v.toFixed(2)} c`;
  return `${groupThousands(v)} c`;
}

/**
 * Speed given in km/s, for the Bodies tab orbital-speed column: '29.78 km/s' (2 decimals below 100, else 1).
 * @param {number} kmPerS
 * @returns {string}
 */
export function formatKmPerS(kmPerS) {
  if (!Number.isFinite(kmPerS)) return '— km/s';
  return `${kmPerS.toFixed(Math.abs(kmPerS) < 100 ? 2 : 1)} km/s`;
}

/**
 * Angle in degrees with the degree sign: formatDeg(23.4393, 2) → '23.44°'.
 * @param {number} deg
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function formatDeg(deg, decimals = 2) {
  if (!Number.isFinite(deg)) return '—°';
  return `${deg.toFixed(decimals)}°`;
}

/**
 * Angle in arcminutes with the prime: formatArcmin(12.34) → '12.3′'.
 * @param {number} arcmin
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatArcmin(arcmin, decimals = 1) {
  if (!Number.isFinite(arcmin)) return '—′';
  return `${arcmin.toFixed(decimals)}′`;
}

/**
 * Angle in degrees, shown as degrees when |angle| ≥ 1° and as arcminutes below ("°/′ as appropriate").
 * @param {number} deg
 * @returns {string}
 */
export function formatAngle(deg) {
  if (!Number.isFinite(deg)) return '—';
  return Math.abs(deg) >= 1 ? formatDeg(deg, 2) : formatArcmin(deg * 60, 1);
}

/**
 * Signed longitude/latitude in degrees with a hemisphere letter: formatLonLat(-1.018, 'EW') → '1.02° W'.
 * @param {number} deg
 * @param {'EW'|'NS'} axis
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function formatLonLat(deg, axis, decimals = 2) {
  if (!Number.isFinite(deg)) return '—';
  const letter = deg < 0 ? axis[1] : axis[0];
  return `${Math.abs(deg).toFixed(decimals)}° ${letter}`;
}

/**
 * A duration in days for the Bodies tab (rotation periods): < 2 d as 'hh.hhh h', else 'dd.ddd d'.
 * @param {number} days
 * @returns {string}
 */
export function formatPeriod(days) {
  if (!Number.isFinite(days)) return '—';
  const d = Math.abs(days);
  return d < 2 ? `${(d * 24).toFixed(3)} h` : `${d.toFixed(3)} d`;
}

/**
 * Human label of a signed sim rate in days per second: '1 d/s', '−1 y/s', 'real time', '10 y/s'.
 * @param {number} daysPerSecond
 * @returns {string}
 */
export function formatRate(daysPerSecond) {
  if (!Number.isFinite(daysPerSecond)) return '—';
  const sign = daysPerSecond < 0 ? '−' : '';
  const r = Math.abs(daysPerSecond);
  if (r === 0) return 'paused';
  if (Math.abs(r - 1 / 86400) < 1e-12) return `${sign}real time`;
  if (r < 1) return `${sign}${trim((r * 24).toFixed(2))} h/s`;
  if (r < 30) return `${sign}${trim(r.toFixed(2))} d/s`;
  if (r < 365.25) return `${sign}${trim((r / 30.436875).toFixed(2))} mo/s`;
  return `${sign}${trim((r / 365.25).toFixed(2))} y/s`;
}

function trim(s) {
  return s.replace(/\.?0+$/, '');
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
