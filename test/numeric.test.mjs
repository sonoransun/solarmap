import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brentRoot, brentMin, parabolicExtremum, scanBrackets, scanExtrema } from '../src/astro/numeric.js';

/** Wrap f to count evaluations. */
function counted(f) { const g = (x) => { g.n++; return f(x); }; g.n = 0; return g; }

const TWO_PI = 2 * Math.PI;

// ───────────────────────────── brentRoot ─────────────────────────────

test('brentRoot(sin, 3, 3.5) = π to 1e-10 (plan numeric row) and within tol at the default tolerance', () => {
  const g = counted(Math.sin);
  const x = brentRoot(g, 3, 3.5, { tol: 1e-12 });
  assert.ok(Math.abs(x - Math.PI) < 1e-10, `|x − π| = ${Math.abs(x - Math.PI)} < 1e-10 (plan tolerance)`);
  assert.ok(g.n <= 12, `evaluations ${g.n} ≤ 12 (Brent: superlinear on a smooth simple root)`);
  const g2 = counted(Math.sin);
  const x2 = brentRoot(g2, 3, 3.5);
  assert.ok(Math.abs(x2 - Math.PI) < 1e-6, `default tol 1e-6: |x − π| = ${Math.abs(x2 - Math.PI)} < 1e-6`);
  assert.ok(g2.n <= 10, `evaluations ${g2.n} ≤ 10 at the default tolerance`);
});

test('brentRoot(x³ − 2x − 5, 2, 3) = 2.0945514815 to 1e-9 (plan numeric row; Brent 1973 / Wallis example)', () => {
  const f = (x) => x * x * x - 2 * x - 5;
  const g = counted(f);
  const x = brentRoot(g, 2, 3, { tol: 1e-12 });
  assert.ok(Math.abs(x - 2.0945514815) < 1e-9, `|x − 2.0945514815| = ${Math.abs(x - 2.0945514815)} < 1e-9 (plan tolerance)`);
  assert.ok(Math.abs(f(x)) < 1e-11, `|f(x)| = ${Math.abs(f(x))} < 1e-11`);
  assert.ok(g.n <= 12, `evaluations ${g.n} ≤ 12`);
  assert.ok(Math.abs(brentRoot(f, 2, 3) - 2.0945514815) < 1e-6, 'default tol 1e-6 gives ≤ 1e-6');
});

test('brentRoot: exact zeros at the ends, reversed bracket, same-sign rejection', () => {
  assert.equal(brentRoot(Math.sin, 0, 1), 0, 'f(a) = 0 returns a immediately');
  assert.equal(brentRoot(Math.sin, -1, 0), 0, 'f(b) = 0 returns b immediately');
  const x = brentRoot(Math.sin, 3.5, 3, { tol: 1e-12 });
  assert.ok(Math.abs(x - Math.PI) < 1e-10, 'bracket given as (b, a) works');
  assert.throws(() => brentRoot(Math.sin, 0.5, 1), RangeError, 'no sign change → RangeError');
});

test('brentRoot at Julian-Date magnitude: absolute tolerance 1e-6 d honoured, evaluations bounded', () => {
  const T0 = 2460000.5, tRoot = T0 + 12.3456789;
  const g = counted((t) => Math.sin((t - tRoot) * TWO_PI / 50));
  const x = brentRoot(g, T0 + 12, T0 + 13);
  assert.ok(Math.abs(x - tRoot) < 1e-6, `|x − root| = ${Math.abs(x - tRoot)} < 1e-6 d (plan: Brent tol 1e-6 d)`);
  assert.ok(g.n <= 10, `evaluations ${g.n} ≤ 10 on a 1-day bracket`);
});

test('brentRoot: evaluation count bounded over many phases / widths, including a hard flat-then-steep root', () => {
  // Family of sinusoids with random phase, 1-day and 10-day brackets, tol 1e-6 (the events configuration).
  let maxN = 0;
  for (let k = 0; k < 200; k++) {
    const T0 = 2451545 + k * 37.1, P = 88 + k * 3.7, phi = (k * 0.618033) % 1 * TWO_PI;
    const f = (t) => Math.sin(TWO_PI * (t - T0) / P + phi);
    for (const width of [1, 10]) {
      // Find a bracket by walking the grid, then refine.
      let a = T0, fa = f(a), found = false;
      for (let i = 1; i < 2000 && !found; i++) {
        const b = T0 + i * width, fb = f(b);
        if ((fa > 0) !== (fb > 0)) {
          const g = counted(f);
          const x = brentRoot(g, a, b);
          assert.ok(Math.abs(f(x)) < 1e-6 * TWO_PI / P * 2, 'residual consistent with tol');
          maxN = Math.max(maxN, g.n);
          found = true;
        }
        a = b; fa = fb;
      }
      assert.ok(found, 'a bracket exists within the walk');
    }
  }
  assert.ok(maxN <= 15, `max evaluations ${maxN} ≤ 15 (log₂(10 d / 1e-6 d) ≈ 23 bisections is the worst case; Brent is superlinear)`);
  // Hard case: f = (x − 0.3)⁹ is extremely flat at the root; Brent must fall back to bisection and still converge.
  const g = counted((x) => Math.pow(x - 0.3, 9));
  const x = brentRoot(g, -1, 1.7, { tol: 1e-9 });
  assert.ok(Math.abs(x - 0.3) < 1e-3, `flat root located to ${Math.abs(x - 0.3)} (f⁹ resolves x only to ≈ (EPS)^(1/9))`);
  assert.ok(g.n <= 100, `evaluations ${g.n} ≤ 100 (bisection-dominated)`);
});

// ───────────────────────────── brentMin ─────────────────────────────

test('brentMin((x − 2)² + 1, 0, 5) → x = 2 ± 1e-7, fx = 1 (plan numeric row)', () => {
  const g = counted((x) => (x - 2) * (x - 2) + 1);
  const r = brentMin(g, 0, 5);
  assert.ok(Math.abs(r.x - 2) < 1e-7, `|x − 2| = ${Math.abs(r.x - 2)} < 1e-7 (plan tolerance)`);
  assert.ok(Math.abs(r.fx - 1) < 1e-14, `fx = ${r.fx} ≈ 1`);
  assert.equal(r.evals, g.n, 'evals field counts f evaluations');
  assert.ok(g.n <= 15, `evaluations ${g.n} ≤ 15 (parabolic step is exact on a parabola)`);
  const out = { x: 0, fx: 0, evals: 0 };
  assert.equal(brentMin(g, 5, 0, undefined, out), out, 'optional out object is filled and returned; reversed interval accepted');
  assert.ok(Math.abs(out.x - 2) < 1e-7);
});

test('brentMin on smooth and non-smooth functions, maxima via negation, absolute tolerance at JD magnitude', () => {
  let r = brentMin((x) => -Math.cos(x - 0.7), -1, 2, { tol: 1e-9 });
  assert.ok(Math.abs(r.x - 0.7) < 1e-8, `−cos: |x − 0.7| = ${Math.abs(r.x - 0.7)} < 1e-8`);
  assert.ok(r.evals <= 20, `evaluations ${r.evals} ≤ 20`);
  r = brentMin((x) => -Math.exp(-(x - 1.25) * (x - 1.25)), 0, 3, { tol: 1e-9 });
  assert.ok(Math.abs(r.x - 1.25) < 1e-7, 'maximum of a Gaussian by minimising its negative');
  r = brentMin((x) => Math.abs(x - 1.3), 0, 5, { tol: 1e-9 });
  assert.ok(Math.abs(r.x - 1.3) < 1e-8, `|x − 1.3| (kink) = ${Math.abs(r.x - 1.3)} < 1e-8 (golden section fallback)`);
  assert.ok(r.evals <= 60, `evaluations ${r.evals} ≤ 60 for a golden-section-dominated search`);
  // Julian Dates: tol is absolute (1e-6 d); Brent's relative √EPS·|x| term would be 0.037 d here.
  const T0 = 2460000.5, tMin = T0 + 12.3456789;
  const g = counted((t) => -Math.cos((t - tMin) * TWO_PI / 50));
  r = brentMin(g, T0, T0 + 30, { tol: 1e-6 });
  assert.ok(Math.abs(r.x - tMin) < 1e-6, `JD-scale minimum |x − t_min| = ${Math.abs(r.x - tMin)} < 1e-6 d`);
  assert.ok(g.n <= 20, `evaluations ${g.n} ≤ 20`);
  assert.throws(() => brentMin((x) => Math.abs(x - 1.3), 0, 5, { tol: 1e-12, maxIter: 3 }), RangeError, 'maxIter exhaustion throws');
});

// ───────────────────────────── parabolicExtremum ─────────────────────────────

test('parabolicExtremum(0, 1, 0, 1, 1) → vertex at the middle sample (plan numeric row); Meeus 3.9–3.10', () => {
  const r = parabolicExtremum(0, 1, 0, 1, 1);
  assert.equal(r.x, 1, 'x at the middle sample');
  assert.equal(r.f, 0, 'f = the middle value');
  // A general quadratic q(x) = 3(x − 2.3)² − 0.7 sampled at 1.5, 2.0, 2.5 is recovered exactly.
  const q = (x) => 3 * (x - 2.3) * (x - 2.3) - 0.7;
  const s = parabolicExtremum(1.5, q(1.5), q(2), q(2.5), 0.5);
  assert.ok(Math.abs(s.x - 2.3) < 1e-12 && Math.abs(s.f + 0.7) < 1e-12, 'exact on a quadratic');
  const m = parabolicExtremum(1.5, -q(1.5), -q(2), -q(2.5), 0.5);
  assert.ok(Math.abs(m.x - 2.3) < 1e-12 && Math.abs(m.f - 0.7) < 1e-12, 'maximum of the negated quadratic');
  const c = parabolicExtremum(0, 1, 2, 3, 1);
  assert.equal(c.x, 1, 'collinear samples: middle sample returned');
  assert.equal(c.f, 2);
  const out = { x: 0, f: 0 };
  assert.equal(parabolicExtremum(0, 1, 0, 1, 1, out), out, 'optional out object');
  // For a grid local minimum the vertex lies within half a step of the middle sample (used by the parade refiner).
  for (let k = 0; k < 500; k++) {
    const f1 = 0, f0 = Math.random(), f2 = Math.random(), h = 0.25 + Math.random();
    const v = parabolicExtremum(0, f0, f1, f2, h);
    assert.ok(Math.abs(v.x - h) <= h / 2 + 1e-12, 'vertex within ±h/2 of the middle sample for a grid minimum');
    assert.ok(v.f <= f1 + 1e-12, 'vertex value ≤ the middle sample');
  }
});

// ───────────────────────────── scanBrackets ─────────────────────────────

/** Count the roots of sin(ω t + φ) strictly inside (a, b) plus those at the ends. */
function rootsInside(omega, phi, a, b) {
  const kLo = Math.ceil((omega * a + phi) / Math.PI - 1e-9), kHi = Math.floor((omega * b + phi) / Math.PI + 1e-9);
  return Math.max(0, kHi - kLo + 1);
}

test('scanBrackets finds every root exactly once when step < half the root spacing', () => {
  const omega = Math.PI / 10, phi = 0.37; // roots every 10 units
  const f = (t) => Math.sin(omega * t + phi);
  const br = scanBrackets(f, 0, 300, 4); // step 4 < 5
  const expected = rootsInside(omega, phi, 0, 300);
  assert.equal(br.length, expected, `${br.length} brackets = ${expected} roots in [0, 300]`);
  for (const [a, b] of br) {
    assert.ok(b - a <= 4 + 1e-12 && b > a, 'bracket width = step');
    assert.ok(f(a) * f(b) < 0, 'sign change on every bracket');
    assert.equal(rootsInside(omega, phi, a, b), 1, 'exactly one root per bracket');
    const x = brentRoot(f, a, b, { tol: 1e-12 });
    const k = Math.round((omega * x + phi) / Math.PI);
    assert.ok(Math.abs(x - (k * Math.PI - phi) / omega) < 1e-10, 'Brent lands on the analytic root');
  }
  // Exact zeros at grid nodes become degenerate brackets that brentRoot returns unchanged.
  const g = (t) => Math.sin(Math.PI * t / 5); // zeros at every multiple of 5, exactly at t = 0 and t = 10 (f(0) = 0)
  const br2 = scanBrackets(g, 0, 10, 2.5);
  assert.equal(br2.length, 2, 'zeros at nodes 0 and 5 (sin(π) ≈ 1e-16 is not exactly 0 so 10 is a sign change)');
  assert.deepEqual(br2[0], [0, 0], 'degenerate bracket for an exact node zero');
  assert.equal(brentRoot(g, 0, 0), 0, 'brentRoot on [t, t] returns t');
  assert.throws(() => scanBrackets(g, 0, 10, 0), RangeError, 'step must be > 0');
  assert.throws(() => scanBrackets(g, 10, 0, 1), RangeError, 't1 must be > t0');
});

test('alias guard subdivides intervals where both sin and cos flip when the step exceeds half the root spacing', () => {
  const omega = Math.PI / 10, phi = 0.37;              // root spacing 10, quadrant spacing 5
  const sin = (t) => Math.sin(omega * t + phi), cos = (t) => Math.cos(omega * t + phi);
  const step = 6;                                       // > 5: the phase advances 108° per step
  const guarded = scanBrackets(sin, 0, 300, step, { aliasGuard: { sin, cos } });
  const plain = scanBrackets(sin, 0, 300, step);
  const expected = rootsInside(omega, phi, 0, 300);
  assert.equal(plain.length, expected, 'without the guard every bracket is a full step');
  assert.ok(plain.every(([a, b]) => Math.abs(b - a - step) < 1e-12), 'unguarded widths = step');
  assert.equal(guarded.length, expected, 'guarded scan still reports every root exactly once');
  const narrowed = guarded.filter(([a, b]) => b - a < step - 1e-12);
  assert.ok(narrowed.length > 0, `${narrowed.length} brackets were subdivided (both sin and cos flipped)`);
  for (const [a, b] of guarded) {
    assert.ok(sin(a) * sin(b) < 0, 'sign change preserved');
    assert.equal(rootsInside(omega, phi, a, b), 1, 'one root per bracket');
    assert.ok(!(sin(a) * sin(b) < 0 && cos(a) * cos(b) < 0), 'no accepted bracket has both sin and cos flipping');
  }
  // `sin` defaults to f when omitted from the guard.
  const guarded2 = scanBrackets(sin, 0, 300, step, { aliasGuard: { cos } });
  assert.deepEqual(guarded2, guarded, 'aliasGuard.sin defaults to f');
  // With step < half the root spacing the guard never triggers and the result is identical to the plain scan.
  assert.deepEqual(scanBrackets(sin, 0, 300, 4, { aliasGuard: { sin, cos } }), scanBrackets(sin, 0, 300, 4), 'guard inert at a safe step');
});

test('alias guard depth limit: a phase that crosses two quadrants within step/64 is accepted at depth 6', () => {
  // Phase rises smoothly from 0.3 rad by 200° inside a 1e-5-wide zone around t = 0.29 (tanh transition): every
  // enclosing interval down to width 1/64 sees both sin and cos flip, so the guard subdivides to the depth limit
  // and then accepts the (genuine) sign change instead of dropping the root.
  const phase = (t) => 0.3 + (200 / 180) * Math.PI * (0.5 + 0.5 * Math.tanh((t - 0.29) / 1e-5));
  const sin = counted((t) => Math.sin(phase(t))), cos = (t) => Math.cos(phase(t));
  const br = scanBrackets(sin, 0, 1, 1, { aliasGuard: { sin, cos } });
  const nScan = sin.n;
  assert.equal(br.length, 1, 'exactly one bracket (one root, where the phase passes π)');
  const [a, b] = br[0];
  assert.ok(Math.abs(b - a - 1 / 64) < 1e-12, `bracket width ${b - a} = step/64 (depth 6)`);
  assert.ok(a < 0.29 && 0.29 < b, 'bracket contains the transition');
  assert.ok(sin(a) * sin(b) < 0 && cos(a) * cos(b) < 0, 'both signs still flip across the accepted bracket');
  assert.equal(nScan, 16, `evaluations ${nScan} = 16: f at 2 nodes + 6 midpoints, and the guard's sin at the same 8 points (both halves examined without further evaluations)`);
  const x = brentRoot(sin, a, b, { tol: 1e-12 });
  assert.ok(Math.abs(phase(x) - Math.PI) < 1e-9, 'Brent finds the root inside the narrow bracket');
  // A uniformly spinning phase (21.3 cycles per step) also terminates and never subdivides below step/64.
  const omega = TWO_PI * 21.3, phi = 0.1;
  const s2 = (t) => Math.sin(omega * t + phi), c2 = (t) => Math.cos(omega * t + phi);
  const br2 = scanBrackets(s2, 0, 4, 1, { aliasGuard: { sin: s2, cos: c2 } });
  assert.ok(br2.length > 0 && br2.every(([u, v]) => v - u >= 1 / 64 - 1e-12 && s2(u) * s2(v) < 0), 'terminates; every bracket ≥ step/64 with a sign change');
});

// ───────────────────────────── scanExtrema ─────────────────────────────

test('scanExtrema windows contain the analytic extrema of cos and refine with brentMin / parabolicExtremum', () => {
  const win = scanExtrema(Math.cos, 0, 20, 0.5);
  const expectedKinds = [];
  for (let k = 1; k * Math.PI < 20; k++) expectedKinds.push(k % 2 ? 'min' : 'max'); // π min, 2π max, …
  assert.equal(win.length, expectedKinds.length, `${win.length} windows = ${expectedKinds.length} interior extrema`);
  win.forEach((w, i) => {
    const tStar = (i + 1) * Math.PI;
    assert.equal(w.kind, expectedKinds[i]);
    assert.ok(w.a < tStar && tStar < w.b, `window [${w.a}, ${w.b}] contains ${tStar}`);
    assert.ok(Math.abs(w.b - w.a - 1) < 1e-12 && Math.abs(w.t - 0.5 * (w.a + w.b)) < 1e-12, 'window = [t_{i−1}, t_{i+1}] around t_i');
    assert.equal(w.f, Math.cos(w.t), 'grid sample reported');
    const r = brentMin(w.kind === 'min' ? Math.cos : (x) => -Math.cos(x), w.a, w.b, { tol: 1e-9 });
    assert.ok(Math.abs(r.x - tStar) < 1e-7, `brentMin in the window → ${tStar} within 1e-7 (plan)`);
    const p = parabolicExtremum(w.a, Math.cos(w.a), w.f, Math.cos(w.b), 0.5);
    assert.ok(Math.abs(p.x - tStar) < 0.01, 'parabola refinement lands within 0.01 of the extremum on a 0.5 grid');
  });
  assert.ok(scanExtrema(Math.cos, 0, 20, 0.5, { kind: 'min' }).every((w) => w.kind === 'min'), 'kind filter');
  assert.equal(scanExtrema(Math.cos, 0, 20, 0.5, { kind: 'max' }).length, 3, 'maxima at 2π, 4π, 6π');
  // Flat pairs are reported once.
  const flat = scanExtrema((t) => (t >= 2 && t <= 3 ? 0 : 1), 0, 6, 1);
  assert.deepEqual(flat.map((w) => [w.kind, w.t]), [['min', 2], ['max', 4]],
    'a two-node plateau minimum is reported once (at its first node); the plateau after it is a maximum at its first node');
  assert.equal(scanExtrema(Math.cos, 0, 0.5, 0.5).length, 0, 'fewer than three nodes → no windows');
});

// ───────────────────────────── synthetic circular orbits ─────────────────────────────

/**
 * Circular coplanar orbit: heliocentric (x, y) at time t (days). Scene-like usage: the event functions are built
 * from position vectors (cross/dot products), never from wrapped longitudes (research §B.1).
 */
function circular(a, period, phi0) {
  return (t, out) => {
    const l = TWO_PI * t / period + phi0;
    out[0] = a * Math.cos(l); out[1] = a * Math.sin(l);
    return out;
  };
}

/** Run the opposition/conjunction scan for a planet against Earth and compare with the analytic instants. */
function checkSynodic({ a, period, phi0, step, years, evalCap, guard }) {
  const earth = circular(1, 365.25, 0.3), planet = circular(a, period, phi0);
  const e = [0, 0], p = [0, 0];
  const sinD = (t) => { earth(t, e); planet(t, p); return (e[0] * p[1] - e[1] * p[0]) / a; }; // sin(λP − λE)
  const cosD = (t) => { earth(t, e); planet(t, p); return (e[0] * p[0] + e[1] * p[1]) / a; }; // cos(λP − λE)
  const T1 = years * 365.25;
  const rate = TWO_PI * (1 / period - 1 / 365.25);        // dΔλ/dt (negative for outer planets)
  const S = Math.abs(TWO_PI / rate);                       // synodic period
  const dphi = phi0 - 0.3;
  // Analytic: Δλ(t) = dphi + rate·t = kπ; even k → longitudes equal (opposition for an outer planet, inferior
  // conjunction for an inner one); odd k → conjunction / superior conjunction.
  const analytic = [];
  const kMax = Math.ceil(Math.abs(rate) * T1 / Math.PI) + 2;
  for (let k = -kMax; k <= kMax; k++) {
    const t = (k * Math.PI - dphi) / rate;
    if (t > 0 && t < T1) analytic.push({ t, equal: ((k % 2) + 2) % 2 === 0 });
  }
  analytic.sort((u, v) => u.t - v.t);
  const br = scanBrackets(sinD, 0, T1, step, guard ? { aliasGuard: { sin: sinD, cos: cosD } } : undefined);
  assert.equal(br.length, analytic.length, `${br.length} brackets = ${analytic.length} analytic crossings over ${years} y (synodic ${S.toFixed(2)} d)`);
  let maxErr = 0, maxN = 0;
  br.forEach(([lo, hi], i) => {
    const g = counted(sinD);
    const t = brentRoot(g, lo, hi);             // default tol 1e-6 d (plan: Brent tol 1e-6 d)
    maxN = Math.max(maxN, g.n);
    const err = Math.abs(t - analytic[i].t);
    maxErr = Math.max(maxErr, err);
    assert.ok(err < 1e-6, `crossing ${i}: |t − analytic| = ${err} < 1e-6 d (plan tolerance)`);
    assert.equal(cosD(t) > 0, analytic[i].equal, 'cos Δλ classifies equal-longitude vs opposite-longitude crossings');
  });
  assert.ok(maxN <= evalCap, `max Brent evaluations ${maxN} ≤ ${evalCap}`);
  return { maxErr, maxN, brackets: br, S };
}

test('synthetic circular orbits Earth (1 AU, 365.25 d) / Mars (1.524 AU, 687 d): oppositions at the analytic instants over 20 years', () => {
  const r = checkSynodic({ a: 1.524, period: 687, phi0: 2.1, step: 10, years: 20, evalCap: 12, guard: true });
  assert.ok(Math.abs(r.S - 779.88) < 0.01, `synodic period ${r.S.toFixed(2)} d ≈ 779.9 d (1/(1/365.25 − 1/687))`);
  assert.ok(r.maxErr < 1e-6, `max error ${r.maxErr} d < 1e-6 d`);
  // Same result on the events' 1-day grid (evaluation count stays small on a 1-day bracket).
  const r1 = checkSynodic({ a: 1.524, period: 687, phi0: 2.1, step: 1, years: 20, evalCap: 10, guard: true });
  assert.ok(r1.maxErr < 1e-6, `1-day grid: max error ${r1.maxErr} d < 1e-6 d`);
});

test('synthetic Mercury (0.387 AU, 88 d): a 40-day step (> synodic/4 ≈ 29 d) triggers the alias guard yet every crossing is found', () => {
  const r = checkSynodic({ a: 0.387, period: 88, phi0: 5.0, step: 40, years: 20, evalCap: 12, guard: true });
  assert.ok(Math.abs(r.S - 115.93) < 0.01, `synodic period ${r.S.toFixed(2)} d ≈ 115.93 d (88·365.25/(365.25 − 88))`);
  assert.ok(r.brackets.some(([a, b]) => b - a < 40 - 1e-9), 'some brackets were subdivided by the guard');
  // And the safe step from research §B.2 (Mercury: 1 d) needs no subdivision at all.
  const r1 = checkSynodic({ a: 0.387, period: 88, phi0: 5.0, step: 1, years: 20, evalCap: 10, guard: true });
  assert.ok(r1.brackets.every(([a, b]) => Math.abs(b - a - 1) < 1e-9), '1-day step: no subdivision');
});
