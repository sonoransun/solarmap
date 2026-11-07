import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClock, RATES, RATE_ORDER, YEAR_LIMITS, jdOfYearStart, jdnFromGregorian, jdFromGregorian, jdNowUtc,
  DEFAULT_MIN_JD, DEFAULT_MAX_JD, createRateRamp, symlog, symlogInverse, RATE_RAMP_KNEE,
} from '../src/astro/clock.js';

/** Fake wall clock: `t` is advanced by the test, never by real time. */
function fakeNow() {
  const f = { t: 0, now: () => f.t };
  return f;
}

test('RATES presets are sim days per real second (plan §UI timeline; research bgcq10pmt §6)', () => {
  assert.equal(RATES.realtime, 1 / 86400);
  assert.equal(RATES.hour, 1 / 24);
  assert.equal(RATES.day, 1);
  assert.equal(RATES.week, 7);
  assert.equal(RATES.month, 30.436875, '365.2425 / 12');
  assert.equal(RATES.year, 365.25, 'Julian year');
  assert.equal(RATES.decade, 3652.5);
  assert.deepEqual(RATE_ORDER, ['realtime', 'hour', 'day', 'week', 'month', 'year', 'decade']);
  for (let i = 1; i < RATE_ORDER.length; i++) assert.ok(RATES[RATE_ORDER[i]] > RATES[RATE_ORDER[i - 1]], 'monotonic');
});

test('Fliegel–Van Flandern JDN: known dates (Meeus ch. 7; USNO)', () => {
  assert.equal(jdnFromGregorian(2000, 1, 1), 2451545, 'J2000.0 = 2000-01-01 12:00 → JDN 2451545');
  assert.equal(jdnFromGregorian(1970, 1, 1), 2440588, 'Unix epoch (JD 2440587.5 at 00:00)');
  assert.equal(jdnFromGregorian(1582, 10, 15), 2299161, 'first day of the Gregorian calendar');
  assert.equal(jdnFromGregorian(-4713, 11, 24), 0, 'JD 0 = −4713-11-24 12:00 proleptic Gregorian');
  assert.equal(jdnFromGregorian(2003, 8, 27), 2452879, '2003-08-27 (Mars closest approach day)');
  assert.equal(jdFromGregorian(2000, 1, 1, 12), 2451545.0);
  assert.equal(jdFromGregorian(1970, 1, 1), 2440587.5);
  assert.equal(jdFromGregorian(2026, 9, 13, 12), 2461297.0, 'plan fixture epoch 2461297.0 = 2026-09-13 12:00');
});

test('jdnFromGregorian agrees with the proleptic Gregorian JS Date over −4000…+4000', () => {
  for (let y = -4000; y <= 4000; y += 1) {
    for (const [m, d] of [[1, 1], [2, 28], [3, 1], [12, 31]]) {
      const dt = new Date(0);
      dt.setUTCFullYear(y, m - 1, d);
      dt.setUTCHours(12, 0, 0, 0);
      const jdn = dt.getTime() / 86400000 + 2440587.5;
      assert.equal(jdnFromGregorian(y, m, d), jdn, `${y}-${m}-${d}`);
    }
  }
});

test('YEAR_LIMITS and jdOfYearStart give the −4000…+4000 clamp', () => {
  assert.deepEqual(YEAR_LIMITS, { min: -4000, max: 4000 });
  assert.equal(jdOfYearStart(2000), 2451544.5, '2000-01-01 00:00 UTC');
  assert.equal(jdOfYearStart(-4000), 260089.5, '−4000-01-01 00:00 UTC (checked against JS Date.setUTCFullYear(−4000))');
  assert.equal(jdOfYearStart(4001), 3182395.5, '4001-01-01 00:00 UTC');
  assert.equal(DEFAULT_MIN_JD, 260089.5);
  assert.ok(Math.abs(DEFAULT_MAX_JD - (3182395.5 - 1 / 86400)) < 1e-9, 'max = 4000-12-31 23:59:59 UTC');
  assert.equal(jdNowUtc(0), 2440587.5, 'Unix epoch → JD 2440587.5');
  assert.equal(jdNowUtc(946728000000), 2451545.0, '2000-01-01 12:00 UTC → J2000.0');
});

test('1e6 frames at 16.67 ms and 365.25 d/s: |error| < 1e-9 d vs closed form (anchor formula has no accumulation)', () => {
  const f = fakeNow();
  const jd0 = 2451545.0;
  // 1e6 × 16.67 ms × 365.25 d/s ≈ 6.09e6 d ≈ 16 700 years, beyond the ±4000-year clamp: widen the limits so the
  // test measures the anchor arithmetic, not the clamp (which has its own test below).
  const clock = createClock({ now: f.now, jdUtc: jd0, rate: RATES.year, playing: true, minJd: -1e9, maxJd: 1e9 });
  const dtMs = 16.67;
  let maxErr = 0;
  for (let i = 1; i <= 1e6; i++) {
    f.t = i * dtMs;
    const expected = jd0 + (f.t / 1000) * 365.25;
    const err = Math.abs(clock.jd() - expected);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr < 1e-9, `max |jd − closed form| = ${maxErr} d < 1e-9 d (plan §Verification "clock")`);
  // 1e6 × 16.67 ms = 16670 s → 16670 × 365.25 d ≈ 6.09e6 d
  assert.ok(Math.abs(clock.jd() - (jd0 + 16.67 * 1000 * 365.25)) < 1e-9, 'end value');
});

test('setRate / pause / play preserve jd() to 1e-12 d (re-anchoring)', () => {
  const f = fakeNow();
  const jd0 = 2460000.5;
  const clock = createClock({ now: f.now, jdUtc: jd0, rate: RATES.day });
  f.t = 12345.678;
  const before = clock.jd();
  clock.setRate(RATES.decade);
  assert.ok(Math.abs(clock.jd() - before) < 1e-12, 'setRate keeps jd (1e-12 d, plan)');
  assert.equal(clock.rate(), RATES.decade);
  f.t += 1000;
  const b2 = clock.jd();
  assert.ok(Math.abs(b2 - (before + 3652.5)) < 1e-9, 'runs at the new rate from the re-anchored point');
  clock.pause();
  assert.equal(clock.playing(), false);
  assert.ok(Math.abs(clock.jd() - b2) < 1e-12, 'pause keeps jd');
  f.t += 5000;
  assert.ok(Math.abs(clock.jd() - b2) < 1e-12, 'paused clock does not advance');
  clock.play();
  assert.equal(clock.playing(), true);
  assert.ok(Math.abs(clock.jd() - b2) < 1e-12, 'play keeps jd');
  f.t += 100;
  assert.ok(Math.abs(clock.jd() - (b2 + 0.1 * 3652.5)) < 1e-9, 'advances after play');
  assert.equal(clock.toggle(), false, 'toggle → paused');
  assert.equal(clock.toggle(), true, 'toggle → playing');
  clock.play(); clock.play(); // idempotent
  assert.equal(clock.playing(), true);
  // setRate while paused also preserves jd and keeps paused
  clock.pause();
  const p = clock.jd();
  clock.setRate(RATES.hour);
  assert.ok(Math.abs(clock.jd() - p) < 1e-12);
  assert.equal(clock.playing(), false);
});

test('step(±1) is exact and keeps the play state', () => {
  const f = fakeNow();
  const clock = createClock({ now: f.now, jdUtc: 2451545.0, rate: RATES.day, playing: false });
  assert.equal(clock.step(1), false, 'not clamped');
  assert.equal(clock.jd(), 2451546.0, 'step +1 exact');
  assert.equal(clock.step(-1), false);
  assert.equal(clock.jd(), 2451545.0, 'step −1 exact');
  clock.step(-1); clock.step(-1);
  assert.equal(clock.jd(), 2451543.0);
  assert.equal(clock.playing(), false, 'stays paused');
  clock.play();
  f.t = 500;
  clock.step(7);
  assert.equal(clock.playing(), true, 'stays playing');
  assert.equal(clock.jd(), 2451543.0 + 0.5 + 7, 'step from the running time');
  clock.step(0.5);
  assert.equal(clock.jd(), 2451551.0);
});

test('clamp at the limits returns true, holds while running, and setJd clamps', () => {
  const f = fakeNow();
  const clock = createClock({ now: f.now, jdUtc: 2451545.0, rate: RATES.decade });
  assert.equal(clock.setJd(DEFAULT_MAX_JD + 100), true, 'clamped above');
  assert.equal(clock.jd(), DEFAULT_MAX_JD);
  assert.equal(clock.setJd(DEFAULT_MIN_JD - 100), true, 'clamped below');
  assert.equal(clock.jd(), DEFAULT_MIN_JD);
  assert.equal(clock.setJd(2451545.0), false, 'inside the range');
  assert.equal(clock.jd(), 2451545.0);
  // running into the upper limit: 3652.5 d/s → (3182395.5 − 2451545) / 3652.5 ≈ 200 s
  f.t = 400 * 1000;
  assert.equal(clock.jd(), DEFAULT_MAX_JD, 'held at max while playing');
  assert.equal(clock.atLimit(), true);
  assert.equal(clock.state.atLimit, true);
  f.t += 10 * 1000;
  assert.equal(clock.jd(), DEFAULT_MAX_JD, 'still held');
  // flipping direction resumes from the limit itself, not from the overshoot
  clock.setRate(-RATES.decade);
  assert.equal(clock.jd(), DEFAULT_MAX_JD);
  f.t += 1000;
  assert.ok(Math.abs(clock.jd() - (DEFAULT_MAX_JD - 3652.5)) < 1e-9, 'runs backwards from max');
  assert.equal(clock.atLimit(), false);
  // step beyond a limit reports the clamp
  assert.equal(clock.step(1e7), true);
  assert.equal(clock.jd(), DEFAULT_MAX_JD);
  // custom limits
  const c2 = createClock({ now: f.now, jdUtc: 100, rate: 1, minJd: 0, maxJd: 10 });
  assert.equal(c2.jd(), 10, 'initial value clamped');
  assert.equal(c2.setJd(-5), true);
  assert.equal(c2.jd(), 0);
  assert.equal(c2.setJd(5), false);
  const t0 = f.t;
  f.t = t0 + 3000;
  assert.equal(c2.jd(), 8);
  f.t = t0 + 30000;
  assert.equal(c2.jd(), 10);
  assert.throws(() => createClock({ now: f.now, minJd: 5, maxJd: 5 }), RangeError);
  assert.throws(() => c2.setRate(NaN), RangeError);
});

test('direction flip: negative rate runs backwards; direction() follows the sign', () => {
  const f = fakeNow();
  const clock = createClock({ now: f.now, jdUtc: 2451545.0, rate: RATES.day });
  assert.equal(clock.direction(), 1);
  f.t = 2000;
  assert.equal(clock.jd(), 2451547.0);
  clock.setRate(-RATES.day);
  assert.equal(clock.direction(), -1);
  assert.equal(clock.rate(), -1);
  assert.equal(clock.jd(), 2451547.0, 'flip preserves jd');
  f.t = 5000;
  assert.equal(clock.jd(), 2451544.0, '3 s backwards at 1 d/s');
  clock.setRate(0);
  assert.equal(clock.direction(), 1, 'rate 0 → +1 by convention');
  f.t = 9000;
  assert.equal(clock.jd(), 2451544.0, 'rate 0 holds');
});

test('state snapshot and defaults', () => {
  const f = fakeNow();
  const clock = createClock({ now: f.now, jdUtc: 2451545.0 });
  assert.deepEqual(clock.state, {
    jd: 2451545.0, rate: 1, playing: true, minJd: DEFAULT_MIN_JD, maxJd: DEFAULT_MAX_JD, atLimit: false,
  });
  // Freeze the injected wall clock: at 1 sim-day per real second a 1 s sim tolerance is only 11 µs of real time.
  const wall = jdNowUtc();
  const real = createClock({ now: f.now });
  assert.ok(Math.abs(real.jd() - wall) < 1 / 86400, 'default anchor = wall clock to within 1 s');
  assert.equal(real.playing(), true);
  assert.equal(real.rate(), RATES.day, 'launch default 1 d/s (plan §Calendar)');
});

// ---------------------------------------------------------------------------------------------------------------
// NaN guards (critique: "clock.setJd(NaN) poisons the clock permanently")
// ---------------------------------------------------------------------------------------------------------------

test('NaN guard: setJd/step/createClock reject NaN with RangeError and leave the clock untouched; ±Infinity clamps', () => {
  const f = fakeNow();
  const clock = createClock({ now: f.now, jdUtc: 2451545.0, rate: RATES.day, playing: false });
  assert.throws(() => clock.setJd(NaN), RangeError, 'setJd(NaN) throws RangeError');
  assert.equal(clock.jd(), 2451545.0, 'jd unchanged after the rejected setJd');
  assert.throws(() => clock.step(NaN), RangeError, 'step(NaN) throws RangeError');
  assert.throws(() => clock.setJd('2451545'), RangeError, 'non-number jd is rejected too');
  assert.equal(clock.jd(), 2451545.0, 'jd unchanged after the rejected step');
  assert.throws(() => createClock({ now: f.now, jdUtc: NaN }), RangeError, 'createClock({ jdUtc: NaN }) throws');
  assert.equal(clock.setJd(Infinity), true, '+Infinity is clamped (returns true)');
  assert.equal(clock.jd(), DEFAULT_MAX_JD, '… to maxJd');
  assert.equal(clock.setJd(-Infinity), true, '−Infinity is clamped');
  assert.equal(clock.jd(), DEFAULT_MIN_JD, '… to minJd');
  clock.play();
  f.t = 5000;
  assert.ok(Number.isFinite(clock.jd()), 'running clock stays finite after the guards fired');
});

// ---------------------------------------------------------------------------------------------------------------
// Rate ramp (contracts §"Clock rate ramp": min-jerk over 0.6 s in log|rate| space with sign handling)
// ---------------------------------------------------------------------------------------------------------------

test('symlog: odd, monotonic, exact round trip over 1e-7…1e4 d/s both signs, zero maps to zero', () => {
  assert.equal(symlog(0), 0, 'f(0) = 0');
  assert.equal(symlogInverse(0), 0, 'f⁻¹(0) = 0');
  assert.equal(RATE_RAMP_KNEE, RATES.realtime, 'knee = one sim second per real second');
  let prev = -Infinity;
  for (let e = -7; e <= 4; e += 0.25) {
    const r = Math.pow(10, e);
    for (const s of [-1, 1]) {
      const f = symlog(s * r);
      assert.equal(Math.sign(f), s, 'sign preserved');
      assert.ok(Math.abs(symlog(-s * r) + f) < 1e-15, 'odd function');
      const back = symlogInverse(f);
      assert.ok(Math.abs(back - s * r) <= 1e-9 * r, `round trip at ${s * r}: ${back} (1e-9 relative; double rounding of 10^f)`);
    }
    const f = symlog(r);
    assert.ok(f > prev, 'strictly increasing');
    prev = f;
  }
  // Asymptotes (Webber 2012): ≈ log10(|r|/knee) far above the knee, ≈ r/(knee·ln 10) far below it.
  assert.ok(Math.abs(symlog(365.25) - Math.log10(365.25 / RATE_RAMP_KNEE)) < 1e-6, 'log asymptote at 1 y/s');
  const tiny = RATE_RAMP_KNEE * 1e-4;
  const lin = tiny / (RATE_RAMP_KNEE * Math.LN10);
  assert.ok(Math.abs(symlog(tiny) - lin) < 1e-4 * lin, 'linear asymptote below the knee (log10(1 + x) = x/ln 10 − x²/(2 ln 10) + …: 5e-5 relative at x = 1e-4)');
});

test('rate ramp 1 d/s → 1 y/s: starts at 1, monotonic, geometric-mean-like midpoint, ends bit-exact after 0.6 s', () => {
  const ramp = createRateRamp();
  assert.equal(ramp.active(), false);
  assert.ok(Number.isNaN(ramp.target()), 'no target before to()');
  ramp.to(RATES.year, 1);
  assert.equal(ramp.active(), true);
  const dt = 1 / 120;
  const out = [];
  for (let i = 0; i < 80; i++) { const v = ramp.update(dt); if (v === null) break; out.push(v); }
  assert.equal(out.length, 72, '0.6 s at 120 Hz = 72 frames, then idle (the 72nd frame is the exact target)');
  assert.ok(out[0] > 1 && out[0] < 1.001, `first frame barely moves (min-jerk zero initial slope): ${out[0]}`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1], 'monotonic increase');
  assert.equal(out[out.length - 1], RATES.year, 'final value is the target exactly');
  assert.equal(ramp.update(dt), null, 'idle afterwards');
  assert.equal(ramp.active(), false);
  // At t = 0.3 s (frame 36) the symlog value is the midpoint, i.e. the symlog-geometric mean of the ends.
  const fm = 0.5 * (symlog(1) + symlog(RATES.year));
  const mid = symlogInverse(fm);
  assert.ok(Math.abs(out[35] - mid) < 1e-9 * mid, `midpoint ${out[35]} = symlog midpoint ${mid} (≈ 19 d/s, not 183 d/s as a linear lerp would give)`);
  assert.ok(mid > 18 && mid < 20, 'log-space midpoint ≈ 19 d/s');
});

test('rate ramp sign flip +1 → −1 d/s: slows to exactly zero at mid-ramp, flips once, never overshoots', () => {
  const ramp = createRateRamp({ seconds: 0.6 });
  ramp.to(-1, 1);
  const dt = 0.6 / 120;
  const out = [];
  for (let i = 0; i < 120; i++) out.push(ramp.update(dt));
  assert.equal(out[119], -1, 'ends at −1 exactly');
  assert.ok(Math.abs(out[59]) < 1e-12, `mid-ramp rate is 0 (${out[59]}): the symlog line through ±1 passes through zero`);
  let flips = 0;
  for (let i = 1; i < out.length; i++) {
    if (Math.sign(out[i]) !== Math.sign(out[i - 1]) && out[i] !== 0 && out[i - 1] !== 0) flips++;
    assert.ok(Math.abs(out[i]) <= 1 + 1e-12, 'never beyond the end magnitudes');
  }
  assert.ok(flips <= 1, `sign changes at most once (${flips})`);
  for (let i = 1; i < 59; i++) assert.ok(Math.abs(out[i]) <= Math.abs(out[i - 1]) + 1e-15, '|rate| decreasing before the flip');
  for (let i = 61; i < 120; i++) assert.ok(Math.abs(out[i]) >= Math.abs(out[i - 1]) - 1e-15, '|rate| increasing after the flip');
  // The slow beat: |rate| < 1e-3 d/s for ≈ 23 % of the ramp (min-jerk spends u ∈ [0.385, 0.615] in the middle 39 % of f).
  const slow = out.filter((v) => Math.abs(v) < 1e-3).length / out.length;
  assert.ok(slow > 0.15 && slow < 0.35, `≈ 23 % of the ramp near standstill (${(100 * slow).toFixed(0)} %)`);
});

test('rate ramp: re-target mid-ramp is continuous, cancel stops emitting, same-target/zero-length emit once, NaN dt is harmless', () => {
  const ramp = createRateRamp();
  ramp.to(RATES.year, 1);
  let v = 0;
  for (let i = 0; i < 20; i++) v = ramp.update(1 / 60);
  const before = v;
  ramp.to(RATES.hour); // defaults `now` to the last output
  assert.equal(ramp.value(), before, 'retarget starts from the last emitted value');
  const next = ramp.update(1 / 60);
  assert.ok(Math.abs(next - before) < 0.002 * before, `no jump on retarget: ${before} → ${next}`);
  assert.equal(ramp.target(), RATES.hour);
  const sameDt = ramp.update(NaN);
  assert.ok(Number.isFinite(sameDt) && Math.abs(sameDt - next) < 1e-12, 'NaN dt: no progress, no NaN out');
  ramp.cancel();
  assert.equal(ramp.update(1 / 60), null, 'nothing after cancel');
  assert.equal(ramp.active(), false);
  ramp.to(7, 7);
  assert.equal(ramp.active(), true, 'same target as now: one emission pending');
  assert.equal(ramp.update(1 / 60), 7, 'emits the target once');
  assert.equal(ramp.update(1 / 60), null);
  const instant = createRateRamp({ seconds: 0 });
  instant.to(-3, 2);
  assert.equal(instant.update(1 / 60), -3, 'zero-length ramp applies immediately');
  assert.equal(instant.update(1 / 60), null);
  ramp.to(2, 1, 0.5);
  let n = 0; while (ramp.update(0.125) !== null) n++;
  assert.equal(n, 4, 'per-call seconds override (0.5 s in exact 0.125 s steps = 4 frames)');
  assert.throws(() => ramp.to(NaN, 1), RangeError, 'to(NaN) throws');
  assert.throws(() => ramp.to(1, NaN), RangeError, 'to(x, NaN) throws');
  assert.throws(() => createRateRamp({ seconds: -1 }), RangeError);
  assert.throws(() => createRateRamp({ knee: 0 }), RangeError);
});

test('rate ramp drives createClock without jumps: jd continuous, final rate exact', () => {
  const f = fakeNow();
  const clock = createClock({ now: f.now, jdUtc: 2451545.0, rate: 1 });
  const ramp = createRateRamp();
  ramp.to(RATES.month, clock.rate());
  let prevJd = clock.jd();
  const dtMs = 1000 / 60;
  for (let i = 1; i <= 60; i++) {
    f.t = i * dtMs;
    const r = ramp.update(dtMs / 1000);
    if (r !== null) clock.setRate(r);
    const j = clock.jd();
    assert.ok(j >= prevJd, 'time never runs backwards while accelerating forwards');
    assert.ok(j - prevJd <= RATES.month * dtMs / 1000 * 1.0001, 'never faster than the target rate');
    prevJd = j;
  }
  assert.equal(clock.rate(), RATES.month, 'clock at the target rate after the ramp');
});
