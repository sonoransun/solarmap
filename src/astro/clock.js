// Pure anchor-based simulation clock. No DOM, no three.js: the wall clock is injected as `now()` (milliseconds).
//
// JD(UTC) is the single source of truth (plan §Time). The clock stores an anchor pair (jdAnchor, tAnchor) and derives
//   jd = jdAnchor + (now() − tAnchor) / 1000 · rate            (rate in sim days per real second, sign = direction)
// so there is no per-frame accumulation: the only rounding is one multiply-add per read (research bgcq10pmt §6:
// "Anchor-based time (JD = anchor + elapsed·rate) has no per-frame accumulation drift"). JD ≈ 2.46e6 has a double ulp of
// ≈ 4.7e-10 d ≈ 40 µs, adequate for the UI and the ephemeris.
//
// Every mutation (setRate, play, pause, step, setJd) re-anchors from the current (clamped) jd, so the reading never jumps.
// The clock is clamped to the plan's hard limit of −4000…+4000 (proleptic Gregorian years; plan §Time / critique
// byf0bzyiw: "hard clamp of the clock/date input to −4000…+4000 with a toast").

/** Sim days per real second for the timeline rate presets (research bgcq10pmt §6; plan §UI "RT·1h·1d·1w·1mo·1y·10y"). */
export const RATES = Object.freeze({
  /** real time: 1 day per 86400 s */
  realtime: 1 / 86400,
  /** 1 hour per second */
  hour: 1 / 24,
  /** 1 day per second (launch default, plan §Calendar) */
  day: 1,
  /** 1 week per second */
  week: 7,
  /** 1 mean Gregorian month per second = 365.2425 / 12 d */
  month: 30.436875,
  /** 1 Julian year per second (consistent with JD) */
  year: 365.25,
  /** 10 Julian years per second */
  decade: 3652.5,
});

/** Preset names in timeline order. */
export const RATE_ORDER = Object.freeze(['realtime', 'hour', 'day', 'week', 'month', 'year', 'decade']);

/** Hard clamp of the simulation clock, proleptic Gregorian years (plan §Time). */
export const YEAR_LIMITS = Object.freeze({ min: -4000, max: 4000 });

/** Seconds per day. */
const DAY_S = 86400;

/**
 * Julian Day Number of a proleptic Gregorian calendar date (the JDN is the JD at 12:00 UTC of that day).
 * Fliegel & Van Flandern (1968), "A Machine Algorithm for Processing Calendar Dates", CACM 11(10):657,
 * https://doi.org/10.1145/364096.364097 — with truncating integer division as in the original FORTRAN:
 *   JD = K − 32075 + 1461·(I + 4800 + (J − 14)/12)/4 + 367·(J − 2 − (J − 14)/12·12)/12 − 3·((I + 4900 + (J − 14)/12)/100)/4
 * Valid for every year ≥ −4800 (all intermediate operands stay non-negative, so truncation = floor).
 * @param {number} year proleptic Gregorian year (astronomical numbering: 0 = 1 BC, −1 = 2 BC)
 * @param {number} month 1…12
 * @param {number} day 1…31
 * @returns {number} Julian Day Number (integer)
 */
export function jdnFromGregorian(year, month, day) {
  const a = Math.trunc((month - 14) / 12); // −1 for Jan/Feb, 0 otherwise
  return day - 32075
    + Math.trunc(1461 * (year + 4800 + a) / 4)
    + Math.trunc(367 * (month - 2 - a * 12) / 12)
    - Math.trunc(3 * Math.trunc((year + 4900 + a) / 100) / 4);
}

/**
 * JD(UTC) of a proleptic Gregorian date and time (JD = JDN − 0.5 at 00:00 UTC).
 * @param {number} year astronomical year
 * @param {number} month 1…12
 * @param {number} day 1…31
 * @param {number} [hour=0]
 * @param {number} [minute=0]
 * @param {number} [second=0] may be fractional
 * @returns {number} Julian Date
 */
export function jdFromGregorian(year, month, day, hour = 0, minute = 0, second = 0) {
  return jdnFromGregorian(year, month, day) - 0.5 + (hour * 3600 + minute * 60 + second) / DAY_S;
}

/**
 * JD(UTC) of 00:00 on 1 January of the given proleptic Gregorian year.
 * @param {number} year astronomical year
 * @returns {number} Julian Date (…xxx.5)
 */
export function jdOfYearStart(year) {
  return jdnFromGregorian(year, 1, 1) - 0.5;
}

/** Default clamp: −4000-01-01 00:00 UTC (JD 260423.5) … 4000-12-31 23:59:59 UTC (JD 3182395.5 − 1 s). */
export const DEFAULT_MIN_JD = jdOfYearStart(YEAR_LIMITS.min);
export const DEFAULT_MAX_JD = jdOfYearStart(YEAR_LIMITS.max + 1) - 1 / DAY_S;

/**
 * @typedef {object} ClockState
 * @property {number} jd current JD(UTC), clamped
 * @property {number} rate signed sim days per real second
 * @property {boolean} playing
 * @property {number} minJd
 * @property {number} maxJd
 * @property {boolean} atLimit true when the unclamped time has reached or passed a limit
 */

/**
 * @typedef {object} Clock
 * @property {() => number} jd current JD(UTC), clamped to [minJd, maxJd]
 * @property {(jd: number) => boolean} setJd jump to jd (clamped); returns true when the value had to be clamped
 * @property {(daysPerSecond: number) => void} setRate re-anchor and set the signed rate
 * @property {() => number} rate signed rate, sim days per real second
 * @property {() => number} direction +1 or −1 (sign of the rate; +1 for rate 0)
 * @property {() => void} play resume from the current jd
 * @property {() => void} pause freeze at the current jd
 * @property {() => boolean} toggle play ⇄ pause; returns the new playing flag
 * @property {() => boolean} playing
 * @property {(days: number) => boolean} step jump by ±days keeping the play state; returns true when clamped
 * @property {() => boolean} atLimit true while the running time is pinned to minJd or maxJd
 * @property {ClockState} state snapshot (allocates; not for hot paths)
 */

/**
 * Create a simulation clock.
 * @param {object} [opts]
 * @param {() => number} [opts.now] wall clock in milliseconds (default performance.now / Date.now)
 * @param {number} [opts.jdUtc] initial JD(UTC) (default: the wall clock, JD = Date.now()/86400000 + 2440587.5)
 * @param {number} [opts.rate=1] initial signed rate, sim days per real second (RATES.day)
 * @param {boolean} [opts.playing=true]
 * @param {number} [opts.minJd=DEFAULT_MIN_JD] lower clamp
 * @param {number} [opts.maxJd=DEFAULT_MAX_JD] upper clamp
 * @returns {Clock}
 */
export function createClock({
  now = defaultNow,
  jdUtc = jdNowUtc(),
  rate = RATES.day,
  playing = true,
  minJd = DEFAULT_MIN_JD,
  maxJd = DEFAULT_MAX_JD,
} = {}) {
  if (!(maxJd > minJd)) throw new RangeError('createClock: maxJd must exceed minJd');
  if (!Number.isFinite(rate)) throw new RangeError('createClock: rate must be finite');
  let jdAnchor = clamp(jdUtc, minJd, maxJd);
  let tAnchor = now();
  let r = rate;
  let on = playing;

  /** Unclamped running time (the anchor formula). */
  function raw() {
    return on ? jdAnchor + ((now() - tAnchor) / 1000) * r : jdAnchor;
  }
  function jd() {
    return clamp(raw(), minJd, maxJd);
  }
  /** Re-anchor at the current clamped time so a later change does not jump. */
  function reanchor() {
    jdAnchor = jd();
    tAnchor = now();
  }
  function setJd(v) {
    const c = clamp(v, minJd, maxJd);
    jdAnchor = c;
    tAnchor = now();
    return c !== v;
  }
  function setRate(daysPerSecond) {
    if (!Number.isFinite(daysPerSecond)) throw new RangeError('setRate: rate must be finite');
    reanchor();
    r = daysPerSecond;
  }
  function play() {
    if (on) return;
    tAnchor = now();
    on = true;
  }
  function pause() {
    if (!on) return;
    reanchor();
    on = false;
  }
  function toggle() {
    if (on) pause(); else play();
    return on;
  }
  function step(days) {
    return setJd(jd() + days);
  }
  function atLimit() {
    const v = raw();
    return v <= minJd || v >= maxJd;
  }

  return {
    jd,
    setJd,
    setRate,
    rate: () => r,
    direction: () => (r < 0 ? -1 : 1),
    play,
    pause,
    toggle,
    playing: () => on,
    step,
    atLimit,
    get state() {
      return { jd: jd(), rate: r, playing: on, minJd, maxJd, atLimit: atLimit() };
    },
  };
}

/**
 * JD(UTC) of the wall clock: Unix epoch 1970-01-01 00:00 UTC = JD 2440587.5 (research b1e3a48tr: jd = ms/86400000 + 2440587.5).
 * Leap seconds are invisible to Date, so this is UTC to within the ~1 s a leap second smears.
 * @param {number} [unixMs=Date.now()] milliseconds since the Unix epoch
 * @returns {number} Julian Date (UTC)
 */
export function jdNowUtc(unixMs = Date.now()) {
  return unixMs / 86400000 + 2440587.5;
}

function defaultNow() {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
