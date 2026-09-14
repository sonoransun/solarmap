// Scalar root finding, minimisation and grid scanning for the event engine (events.js).
// Pure functions: no DOM, no three.js, no ephemeris knowledge. All "x"/"t" arguments are plain numbers in the
// caller's units (the event engine passes Julian Dates and expects tolerances in days).
//
// Sources:
//   Brent, R. P. (1973) "Algorithms for Minimization without Derivatives", Prentice-Hall — ch. 4 (procedure `zero`,
//     root finding by bisection + secant + inverse quadratic interpolation) and ch. 5 (procedure `localmin`,
//     golden-section search + successive parabolic interpolation).
//   Press et al., Numerical Recipes (2nd/3rd ed.) §9.3 `zbrent` and §10.2 `brent` (the same two algorithms,
//     whose bookkeeping this file follows).
//   Meeus, Astronomical Algorithms (2nd ed.) ch. 3 "Interpolation", eqs. 3.9–3.10 (extremum of a parabola through
//     three equidistant samples).
//   Alignment-events research (bq2vila6z.txt §B.2–B.4): scan step < half the shortest root spacing, sign-change
//     bracketing, Brent to 1e-6 d, and the |Δλ| > 90° aliasing guard implemented here as the sin/cos double-sign
//     test with local subdivision (plan §Events: "subdivide when both flip").

/** IEEE-754 double machine epsilon (2⁻⁵²). */
const EPS = Number.EPSILON;
/** Golden-section fraction (3 − √5)/2 ≈ 0.381966 (Brent 1973 ch. 5; NR `CGOLD`). */
const CGOLD = 0.3819660112501051;
/** Maximum recursion depth of the alias guard: an interval is split at most 2⁶ = 64 ways (plan §Events). */
const ALIAS_MAX_DEPTH = 6;

/**
 * Root of a continuous scalar function on a bracket [a, b] with f(a)·f(b) < 0 (Brent 1973 ch. 4; NR `zbrent`).
 * Combines bisection (guaranteed progress) with secant and inverse quadratic interpolation (superlinear
 * convergence). Terminates when the bracket half-width ≤ tol1 = 2·EPS·|b| + tol/2, so |x − root| ≲ tol.
 * The returned point is the best iterate, typically far closer to the root than `tol` (last step is superlinear).
 * @param {(x:number)=>number} f continuous function
 * @param {number} a one end of the bracket
 * @param {number} b other end of the bracket
 * @param {{tol?:number, maxIter?:number}} [opts] tol = ABSOLUTE tolerance on x (default 1e-6, i.e. ≈ 0.09 s for
 *   Julian Dates); maxIter = iteration cap (default 100; Brent needs ≲ log₂((b−a)/tol) + a few for smooth f)
 * @returns {number} x with f(x) ≈ 0
 * @throws {RangeError} if f(a) and f(b) have the same sign, or maxIter is exhausted
 */
export function brentRoot(f, a, b, opts) {
  const tol = opts && opts.tol !== undefined ? opts.tol : 1e-6;
  const maxIter = opts && opts.maxIter !== undefined ? opts.maxIter : 100;
  let fa = f(a), fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if ((fa > 0) === (fb > 0)) throw new RangeError('brentRoot: f(a) and f(b) must have opposite signs');
  let c = a, fc = fa;   // c is the previous iterate; [b, c] always brackets the root
  let d = b - a, e = d; // d = last step, e = step before that (controls when interpolation is allowed)
  for (let iter = 0; iter < maxIter; iter++) {
    if ((fb > 0) === (fc > 0)) { c = a; fc = fa; d = b - a; e = d; } // rename so that b and c bracket
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; } // b = best estimate
    const tol1 = 2 * EPS * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      // Attempt inverse quadratic interpolation (secant when only two distinct points are available).
      const s = fb / fa;
      let p, q;
      if (a === c) { p = 2 * xm * s; q = 1 - s; }
      else {
        const qq = fa / fc, r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      const min1 = 3 * xm * q - Math.abs(tol1 * q), min2 = Math.abs(e * q);
      if (2 * p < (min1 < min2 ? min1 : min2)) { e = d; d = p / q; } // accept interpolation
      else { d = xm; e = d; }                                          // fall back to bisection
    } else { d = xm; e = d; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (xm >= 0 ? tol1 : -tol1); // never step by less than tol1
    fb = f(b);
  }
  throw new RangeError('brentRoot: no convergence within maxIter = ' + maxIter);
}

/**
 * Local minimum of a scalar function on [a, b] (Brent 1973 ch. 5 `localmin`; NR `brent`): golden-section steps
 * guarantee convergence, successive parabolic interpolation through the three best points gives superlinear
 * convergence near a smooth minimum. Use `brentMin((x) => -g(x), …)` for a maximum.
 * Deviation from Brent's tolerance `eps·|x| + t` (eps = √EPS): the relative √EPS term is replaced by a
 * representability floor 4·EPS·|x| because the event engine works in Julian Dates (|x| ≈ 2.46e6, where √EPS·|x|
 * would be 0.037 d); `tol` is therefore an ABSOLUTE tolerance on x. Note that for a flat extremum the achievable
 * accuracy in x is limited by f's own resolution (≈ √(EPS·|f| / f″)), not by `tol` (research §B.1).
 * @param {(x:number)=>number} f function to minimise
 * @param {number} a lower end of the search interval
 * @param {number} b upper end of the search interval
 * @param {{tol?:number, maxIter?:number}} [opts] tol = absolute tolerance on x (default 1e-7); maxIter default 200
 * @param {{x:number, fx:number, evals:number}} [out] optional result object to fill (no allocation)
 * @returns {{x:number, fx:number, evals:number}} abscissa and value of the minimum, and the number of f evaluations
 * @throws {RangeError} if maxIter is exhausted
 */
export function brentMin(f, a, b, opts, out) {
  const tol = opts && opts.tol !== undefined ? opts.tol : 1e-7;
  const maxIter = opts && opts.maxIter !== undefined ? opts.maxIter : 200;
  if (a > b) { const t = a; a = b; b = t; }
  // x = best point, w = second best, v = previous w; u = latest trial point.
  let x = a + CGOLD * (b - a), w = x, v = x;
  let fx = f(x), fw = fx, fv = fx;
  let d = 0, e = 0; // d = current step, e = step before last
  let evals = 1;
  for (let iter = 0; iter < maxIter; iter++) {
    const xm = 0.5 * (a + b);
    const tol1 = tol + 4 * EPS * Math.abs(x);
    const tol2 = 2 * tol1;
    if (Math.abs(x - xm) <= tol2 - 0.5 * (b - a)) { // whole interval within 2·tol1 of x
      const res = out || { x: 0, fx: 0, evals: 0 };
      res.x = x; res.fx = fx; res.evals = evals;
      return res;
    }
    if (Math.abs(e) > tol1) {
      // Parabola through (x, fx), (w, fw), (v, fv): trial step p/q (Brent 1973 eq. 5.5 form).
      let r = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p;
      q = Math.abs(q);
      const etemp = e;
      e = d;
      if (Math.abs(p) >= Math.abs(0.5 * q * etemp) || p <= q * (a - x) || p >= q * (b - x)) {
        // Parabolic step rejected (too large or outside [a, b]): golden-section step into the larger segment.
        e = x >= xm ? a - x : b - x;
        d = CGOLD * e;
      } else {
        d = p / q;
        const u = x + d;
        if (u - a < tol2 || b - u < tol2) d = xm - x >= 0 ? tol1 : -tol1; // keep away from the ends
      }
    } else {
      e = x >= xm ? a - x : b - x;
      d = CGOLD * e;
    }
    const u = Math.abs(d) >= tol1 ? x + d : x + (d >= 0 ? tol1 : -tol1); // never evaluate closer than tol1
    const fu = f(u);
    evals++;
    if (fu <= fx) {
      if (u >= x) a = x; else b = x;
      v = w; fv = fw; w = x; fw = fx; x = u; fx = fu;
    } else {
      if (u < x) a = u; else b = u;
      if (fu <= fw || w === x) { v = w; fv = fw; w = u; fw = fu; }
      else if (fu <= fv || v === x || v === w) { v = u; fv = fu; }
    }
  }
  throw new RangeError('brentMin: no convergence within maxIter = ' + maxIter);
}

/**
 * Vertex of the parabola through three equispaced samples (x0, f0), (x0 + h, f1), (x0 + 2h, f2).
 * Meeus, Astronomical Algorithms ch. 3 eqs. 3.9–3.10 with a = f1 − f0, b = f2 − f1, c = b − a = f0 − 2f1 + f2:
 *   y_m = f1 − (a + b)² / (8c),  n_m = −(a + b) / (2c) (in units of h, measured from the middle sample).
 * When f1 is a grid local extremum (f1 ≤ f0, f1 ≤ f2 or the reverse) |n_m| ≤ 1/2, i.e. the vertex lies within
 * half a step of the middle sample; the caller (parade refinement) relies on this to stay inside the window.
 * Collinear samples (c = 0) have no vertex: the middle sample is returned unchanged.
 * @param {number} x0 abscissa of the first sample
 * @param {number} f0 value at x0
 * @param {number} f1 value at x0 + h
 * @param {number} f2 value at x0 + 2h
 * @param {number} h sample spacing
 * @param {{x:number, f:number}} [out] optional result object to fill
 * @returns {{x:number, f:number}} abscissa and value of the vertex (a minimum if f0 − 2f1 + f2 > 0, else a maximum)
 */
export function parabolicExtremum(x0, f0, f1, f2, h, out) {
  const res = out || { x: 0, f: 0 };
  const c = f0 - 2 * f1 + f2;   // second difference (curvature × h²)
  const ab = f2 - f0;           // a + b (first differences summed)
  if (c === 0) { res.x = x0 + h; res.f = f1; return res; }
  res.x = x0 + h - (ab / (2 * c)) * h;
  res.f = f1 - (ab * ab) / (8 * c);
  return res;
}

/**
 * Number of grid intervals covering [t0, t1] with spacing `step`; the last node is clipped to t1.
 * Grid nodes are computed as t0 + i·step (identical doubles across scans of different functions, so a memoising
 * caller shares evaluations).
 * @param {number} t0 @param {number} t1 @param {number} step
 * @returns {number} n ≥ 1
 */
function gridIntervals(t0, t1, step) {
  if (!(step > 0)) throw new RangeError('scan: step must be > 0');
  if (!(t1 > t0)) throw new RangeError('scan: t1 must be > t0');
  return Math.max(1, Math.ceil((t1 - t0) / step - 1e-9));
}

/**
 * Sign-change brackets of f on a uniform grid over [t0, t1] (research §B.3).
 * A grid node with f = 0 exactly yields the degenerate bracket [t, t] (brentRoot returns it immediately).
 * Alias guard (plan §Events, research §B.3 "|Δλ| jumps by > 90° between samples"): when `aliasGuard` supplies the
 * sine and cosine of the underlying phase (sin defaults to f itself), a candidate interval on which BOTH sin and
 * cos change sign — the phase crossed two quadrant boundaries, so it advanced by more than ≈90° and the interval
 * may straddle a wrong-kind or aliased root — is bisected recursively (depth ≤ 6, i.e. down to step/64) and the
 * halves are re-examined, instead of being accepted as one bracket. At the depth limit a sign change of the
 * continuous f is still a genuine root bracket and is accepted (narrowed to step/64).
 * @param {(t:number)=>number} f scalar function
 * @param {number} t0 scan start
 * @param {number} t1 scan end (> t0)
 * @param {number} step grid spacing (must be < half the shortest root spacing, research §B.2)
 * @param {{aliasGuard?:{sin?:(t:number)=>number, cos:(t:number)=>number}}} [opts]
 * @returns {number[][]} brackets [[a, b], …] in increasing order, each with f(a)·f(b) < 0 (or a = b, f(a) = 0)
 */
export function scanBrackets(f, t0, t1, step, opts) {
  const guard = opts && opts.aliasGuard ? opts.aliasGuard : null;
  const sinF = guard ? (guard.sin || f) : null;
  const cosF = guard ? guard.cos : null;
  const n = gridIntervals(t0, t1, step);
  /** @type {number[][]} */
  const out = [];

  // Examine [a, b] with known f values; sa/ca/sb/cb are sin/cos at the ends when already known (NaN = unknown).
  const visit = (a, fa, b, fb, sa, ca, sb, cb, depth) => {
    if (fa === 0) return;                       // handled at the node level
    if (fb === 0 || (fa > 0) === (fb > 0)) return; // no sign change inside (a zero at b is reported by the node)
    if (guard) {
      if (sa !== sa) { sa = sinF(a); ca = cosF(a); }
      if (sb !== sb) { sb = sinF(b); cb = cosF(b); }
      if ((sa > 0) !== (sb > 0) && (ca > 0) !== (cb > 0) && depth < ALIAS_MAX_DEPTH) {
        const m = 0.5 * (a + b);
        const fm = f(m);
        if (fm === 0) { out.push([m, m]); return; }
        const sm = sinF(m), cm = cosF(m);
        visit(a, fa, m, fm, sa, ca, sm, cm, depth + 1);
        visit(m, fm, b, fb, sm, cm, sb, cb, depth + 1);
        return;
      }
    }
    out.push([a, b]);
  };

  let ta = t0, fa = f(ta);
  if (fa === 0) out.push([ta, ta]);
  for (let i = 1; i <= n; i++) {
    const tb = i < n ? t0 + i * step : t1;
    if (tb <= ta) break; // clipped final node coincides with the previous one
    const fb = f(tb);
    visit(ta, fa, tb, fb, NaN, NaN, NaN, NaN, 0);
    if (fb === 0) out.push([tb, tb]);
    ta = tb; fa = fb;
  }
  return out;
}

/**
 * Candidate windows around grid local extrema of f on a uniform grid over [t0, t1]: a node t_i is a local minimum
 * when f_i < f_{i−1} and f_i ≤ f_{i+1} (a maximum for the reversed inequalities; the asymmetry avoids reporting
 * a flat pair twice). Each window [t_{i−1}, t_{i+1}] is meant for `brentMin` (plan §Events: greatest elongation,
 * closest approach, minimum separation) or `parabolicExtremum(t_{i−1}, f_{i−1}, f_i, f_{i+1}, step)`.
 * The grid nodes are the same doubles as in scanBrackets (t0 + i·step, last clipped to t1).
 * @param {(t:number)=>number} f scalar function
 * @param {number} t0 scan start
 * @param {number} t1 scan end (> t0)
 * @param {number} step grid spacing
 * @param {{kind?:'min'|'max'|'both'}} [opts] which extrema to report (default 'both')
 * @returns {{a:number, b:number, t:number, f:number, kind:'min'|'max'}[]} windows in increasing order; t, f = the
 *   grid sample at the extremum (a, b = the neighbouring nodes)
 */
export function scanExtrema(f, t0, t1, step, opts) {
  const kind = opts && opts.kind ? opts.kind : 'both';
  const wantMin = kind !== 'max', wantMax = kind !== 'min';
  const n = gridIntervals(t0, t1, step);
  /** @type {{a:number, b:number, t:number, f:number, kind:'min'|'max'}[]} */
  const out = [];
  if (n < 2) return out;
  let tp = t0, fp = f(tp);                  // previous node
  let tc = t0 + step, fc = f(tc);           // current node
  for (let i = 2; i <= n; i++) {
    const tn = i < n ? t0 + i * step : t1;  // next node
    if (tn <= tc) break;
    const fn = f(tn);
    if (wantMin && fc < fp && fc <= fn) out.push({ a: tp, b: tn, t: tc, f: fc, kind: 'min' });
    else if (wantMax && fc > fp && fc >= fn) out.push({ a: tp, b: tn, t: tc, f: fc, kind: 'max' });
    tp = tc; fp = fc; tc = tn; fc = fn;
  }
  return out;
}
