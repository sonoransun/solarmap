// Pure fly-by math (no DOM, no three.js): duration law, warp (log-speed) and min-jerk profiles, the arcing path
// between MOVING endpoints, the true (path) speed for the HUD / light-speed beat, the arrival offset and the
// sim-rate cap. Everything here works on plain [x, y, z] arrays in AU and real seconds.
//
// Sources:
//  - Plan §"Fly-by specification" (/Users/user/.claude/plans/implement-the-features-described-curried-spark.md):
//    duration law, warp branch threshold max(0.005 AU, 20·R_disp), speed law v = c·10^L(τ)·cap(τ), L_min = −3,
//    L_max ∈ [L_min, 6] by bisection with a 2 000-sample midpoint rule, 512-sample cumulative table, arc height
//    clamp(0.18 D, 3 R_disp, 2 AU), arrival offset R_disp/(0.35·tan(fov/2)) rotated 35° about north and elevated 0.35,
//    rate cap when rate·T > P/50.
//  - Rendering research §3 (bgcq10pmt.txt): min-jerk profile, path with moving endpoints, arrival offset code.
//  - Final critique (byf0bzyiw.txt): true speed must include the lateral bump term
//    v·sqrt(1 + (4H(1 − 2s)/D)²) (factor 1.2322 at the ends for H = 0.18 D); the Sun as destination uses the
//    departure direction in place of "sunward"; warp threshold raised to 0.005 AU; acceleration continuity 2 %.
//  - Min-jerk polynomial: Flash & Hogan 1985, J. Neurosci. 5(7):1688, https://pubmed.ncbi.nlm.nih.gov/4020415/
//  - Smootherstep 6x⁵ − 15x⁴ + 10x³: Perlin, "Improving Noise", SIGGRAPH 2002 (zero 1st and 2nd derivative at 0 and 1).
//  - Rodrigues' rotation formula (rotation of a vector about a unit axis), e.g. Goldstein, Classical Mechanics §4.

import { C_AU_S, DEG } from './constants.js';
import { sub, dot, cross, normalize } from './vec.js';

// ---------------------------------------------------------------------------------------------------------------
// Tunables (all from the plan §Fly-by specification unless noted)
// ---------------------------------------------------------------------------------------------------------------

/** Duration law T = clamp(T0 + T1·log10(1 + D/D_REF), T_MIN, T_MAX) seconds (research §3.5, plan §Fly-by). */
export const DURATION_BASE_S = 2.0;
export const DURATION_SLOPE_S = 1.2;
export const DURATION_REF_AU = 0.01;
export const DURATION_MIN_S = 1.5;
export const DURATION_MAX_S = 7.0;

/** Warp branch when D ≥ max(WARP_MIN_AU, WARP_RDISP_FACTOR·R_disp) (critique: 0.005 AU so re-framing never warps). */
export const WARP_MIN_AU = 0.005;
export const WARP_RDISP_FACTOR = 20;

/** log10 speed floor in units of c: v starts at 10⁻³ c before the cap (plan: L_min = −3). */
export const L_MIN = -3;
/** Upper bracket of the L_max bisection (plan: L_max ∈ [L_min, 6]). */
export const L_MAX_LIMIT = 6;
/** Smootherstep cap over the first and last 5 % of the flight (plan: cap(τ) = ss(τ/0.05)·ss((1−τ)/0.05)). */
export const CAP_FRACTION = 0.05;
/** Midpoint-rule samples used by the L_max bisection (plan: 2 000). */
export const N_INTEGRATION = 2000;
/** Cells of the cumulative-distance table (plan: 512 samples). */
export const N_TABLE = 512;
/** Bisection iterations: 9/2^60 ≈ 8e-18 in L_max, far below double precision on the integral. */
export const BISECTION_ITERATIONS = 60;

/** Arc height H = clamp(ARC_FRACTION·D, ARC_MIN_RDISP·R_disp, ARC_MAX_AU) (plan §Fly-by path). */
export const ARC_FRACTION = 0.18;
export const ARC_MIN_RDISP = 3;
export const ARC_MAX_AU = 2;

/** Arrival: the target fills ARRIVAL_FILL of the screen height; direction sunward rotated ARRIVAL_AZIMUTH about
 *  north and elevated ARRIVAL_ELEVATION (plan §Fly-by arrival offset; research §3.2 arrivalOffset). */
export const ARRIVAL_FILL = 0.35;
export const ARRIVAL_AZIMUTH_RAD = 35 * DEG;
export const ARRIVAL_ELEVATION = 0.35;
/** |bodyPos| below this (AU) is treated as the Sun at the origin (critique: sunward is NaN for B = 0). */
export const SUN_EPSILON_AU = 1e-9;

/** Rate easing: cap the sim rate when rate·T > P_target/RATE_PERIOD_FRACTION; ease over RATE_EASE_S (plan). */
export const RATE_PERIOD_FRACTION = 50;
export const RATE_EASE_S = 0.5;

/** Ecliptic north (scene up, CLAUDE.md: z → ecliptic north). */
const UP_Z = Object.freeze([0, 0, 1]);
/** Fallback axis for the lateral normal when the chord is parallel to up (plan: x̂ × d̂). */
const X_HAT = Object.freeze([1, 0, 0]);

// ---------------------------------------------------------------------------------------------------------------
// Elementary shapes
// ---------------------------------------------------------------------------------------------------------------

/** @param {number} x @param {number} lo @param {number} hi @returns {number} min(max(x, lo), hi) */
export function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * Perlin smootherstep 6x⁵ − 15x⁴ + 10x³, clamped to [0, 1]; ss' = ss'' = 0 at both ends (C² joins).
 * @param {number} x @returns {number}
 */
export function smootherstep(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Minimum-jerk position profile s(τ) = 10τ³ − 15τ⁴ + 6τ⁵ (Flash & Hogan 1985); s(0) = 0, s(1) = 1.
 * @param {number} tau normalised time in [0, 1] (clamped) @returns {number}
 */
export function minJerk(tau) {
  const t = clamp(tau, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * ds/dτ of the minimum-jerk profile: 30τ²(1 − τ)², max 1.875 at τ = 0.5, zero (with zero slope) at both ends.
 * @param {number} tau @returns {number}
 */
export function minJerkDeriv(tau) {
  if (tau <= 0 || tau >= 1) return 0;
  const u = 1 - tau;
  return 30 * tau * tau * u * u;
}

/**
 * Fly-by duration T = clamp(2.0 + 1.2·log10(1 + D/0.01), 1.5, 7.0) seconds (plan §Fly-by; research §3.5:
 * 0.01 AU → 2.4 s, 1 AU → 4.4 s, 30 AU → 6.2 s).
 * @param {number} D chord length at launch, AU @returns {number} seconds
 */
export function duration(D) {
  return clamp(DURATION_BASE_S + DURATION_SLOPE_S * Math.log10(1 + D / DURATION_REF_AU), DURATION_MIN_S, DURATION_MAX_S);
}

/**
 * Warp end caps cap(τ) = ss(τ/0.05)·ss((1 − τ)/0.05): 0 at τ = 0 and 1 with zero 1st/2nd derivative, 1 in between.
 * @param {number} tau @returns {number}
 */
export function warpCap(tau) {
  return smootherstep(tau / CAP_FRACTION) * smootherstep((1 - tau) / CAP_FRACTION);
}

/**
 * Log-speed shape g(τ) = 16τ²(1 − τ)²: 0 at the ends, 1 at τ = 0.5 (plan: L(τ) = L_min + (L_max − L_min)·g(τ)).
 * @param {number} tau @returns {number}
 */
export function logShape(tau) {
  const p = tau * (1 - tau);
  return 16 * p * p;
}

/**
 * Warp chord speed in units of c for a given L_max: 10^{L(τ)}·cap(τ) (plan §Fly-by speed law).
 * @param {number} tau @param {number} Lmax @returns {number} multiples of c
 */
export function warpSpeedC(tau, Lmax) {
  if (tau <= 0 || tau >= 1) return 0;
  return Math.pow(10, L_MIN + (Lmax - L_MIN) * logShape(tau)) * warpCap(tau);
}

// ---------------------------------------------------------------------------------------------------------------
// Profile planning
// ---------------------------------------------------------------------------------------------------------------

/**
 * Midpoint-rule integral ∫₀¹ 10^{L(τ)}·cap(τ) dτ with N_INTEGRATION samples (plan: 2 000-sample midpoint rule).
 * The integrand is smooth with vanishing 1st/2nd derivatives at both ends, so the midpoint rule is accurate far
 * beyond 1e-9 relative here (Euler–Maclaurin: the h² term is zero).
 * @param {Float64Array} shape g(τ) at the midpoints @param {Float64Array} cap cap(τ) at the midpoints
 * @param {number} Lmax @returns {number} dimensionless (multiples of c·1 s per unit τ)
 */
function midpointIntegral(shape, cap, Lmax) {
  const n = shape.length;
  const span = Lmax - L_MIN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.pow(10, L_MIN + span * shape[i]) * cap[i];
  return sum / n;
}

/**
 * Bracket-then-bisect the first and last τ where fn(τ) ≥ 1 on a 4 096-point scan (fn monotone across each crossing).
 * @param {(tau: number) => number} fn speed in multiples of c
 * @returns {number[] | null} [τ_out, τ_in] or null when the speed never reaches 1 c
 */
function findUnitCrossings(fn) {
  const M = 4096;
  let first = -1, last = -1;
  for (let k = 0; k <= M; k++) {
    if (fn(k / M) >= 1) { if (first < 0) first = k; last = k; }
  }
  if (first < 0) return null;
  const bisect = (lo, hi, rising) => {
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const above = fn(mid) >= 1;
      if (above === rising) hi = mid; else lo = mid;
    }
    return 0.5 * (lo + hi);
  };
  // Rising crossing between samples first−1 (below 1 c) and first (≥ 1 c); falling between last and last+1.
  const tauOut = first === 0 ? 0 : bisect((first - 1) / M, first / M, true);
  const tauIn = last === M ? 1 : bisect(last / M, (last + 1) / M, false);
  return [tauOut, tauIn];
}

/**
 * @typedef {object} FlybyProfile
 * @property {'warp' | 'minjerk'} kind      log-speed warp (with beat/streaks) or a min-jerk re-frame (no warp)
 * @property {number} D                     chord length at launch, AU
 * @property {number} T                     duration, s
 * @property {number} rDisp                 displayed radius of the target, AU
 * @property {number} H                     arc height arcHeight(D, rDisp), AU
 * @property {number} warpThresholdAu       branch threshold that was applied
 * @property {number | null} Lmax           solved log10 peak chord speed (c) for warp, null for min-jerk
 * @property {boolean} exact                false only when L_max hit L_MAX_LIMIT (D beyond ≈2 000 AU); s(τ) still
 *                                          reaches 1 because the table is normalised, but ∫v dt < D
 * @property {number} peakSpeedC            peak CHORD speed in c (at τ = 0.5)
 * @property {(tau: number) => number} s    normalised chord progress in [0, 1] (exactly 0 at τ ≤ 0, 1 at τ ≥ 1)
 * @property {(tau: number) => number} sDot ds/dt in 1/s (= v/D)
 * @property {(tau: number) => number} v    chord speed along E − A, AU/s (0 at both ends)
 * @property {(tau: number) => number} speedC chord speed in multiples of c
 * @property {() => number[] | null} lightspeedCrossings       [τ_out, τ_in] where the TRUE speed (with the lateral
 *                                          bump, H = profile.H) crosses 1 c; null for min-jerk (no beat) or never
 * @property {() => number[] | null} chordLightspeedCrossings  same for the chord speed alone
 */

/**
 * Plan a fly-by profile for chord length D (AU) and target displayed radius rDisp (AU).
 *
 * Warp branch (D ≥ warpThresholdAu): v(τ) = c·10^{L(τ)}·cap(τ), L(τ) = L_min + (L_max − L_min)·16τ²(1−τ)²,
 * L_max ∈ [L_min, 6] by bisection so that ∫₀ᵀ v dt = D (2 000-sample midpoint rule). A 512-cell cumulative table
 * (composite Simpson inside each cell, normalised so s(1) = 1) gives s(τ) by cubic Hermite interpolation with the
 * analytic node slopes (see the note at the lookup for why not linear).
 * Min-jerk branch: s(τ) = 10τ³ − 15τ⁴ + 6τ⁵, v = D·s'(τ)/T; never exceeds c below the threshold
 * (peak 1.875·D/T: 0.456 c at 0.001 AU, critique "VERIFIED OK").
 * If the warp integral at L_max = L_min already exceeds D (only possible with a custom threshold far below
 * WARP_MIN_AU) the profile silently falls back to min-jerk.
 *
 * @param {{D: number, T?: number, rDisp: number, warpThresholdAu?: number}} p
 *   D chord length (AU); T duration (s, default duration(D)); rDisp target displayed radius (AU);
 *   warpThresholdAu default max(WARP_MIN_AU, WARP_RDISP_FACTOR·rDisp)
 * @returns {FlybyProfile}
 */
export function planProfile({ D, T = duration(D), rDisp, warpThresholdAu = Math.max(WARP_MIN_AU, WARP_RDISP_FACTOR * rDisp) }) {
  const H = arcHeight(D, rDisp);
  let kind = D >= warpThresholdAu ? 'warp' : 'minjerk';
  let Lmax = null;
  let exact = true;
  /** @type {Float64Array | null} */
  let table = null;

  if (kind === 'warp') {
    // Midpoint samples of the shape and cap, reused by every bisection step.
    const shape = new Float64Array(N_INTEGRATION);
    const cap = new Float64Array(N_INTEGRATION);
    for (let i = 0; i < N_INTEGRATION; i++) {
      const tau = (i + 0.5) / N_INTEGRATION;
      shape[i] = logShape(tau);
      cap[i] = warpCap(tau);
    }
    // ∫₀ᵀ v dt = T·c·∫₀¹ 10^{L}·cap dτ = D  ⇒  target integral = D/(T·c).
    const target = D / (T * C_AU_S);
    let lo = L_MIN, hi = L_MAX_LIMIT;
    if (midpointIntegral(shape, cap, lo) > target) {
      kind = 'minjerk'; // too short even at the 10⁻³ c floor: re-frame instead
    } else if (midpointIntegral(shape, cap, hi) < target) {
      Lmax = hi; exact = false;
    } else {
      for (let i = 0; i < BISECTION_ITERATIONS; i++) {
        const mid = 0.5 * (lo + hi);
        if (midpointIntegral(shape, cap, mid) < target) lo = mid; else hi = mid;
      }
      Lmax = 0.5 * (lo + hi);
    }
  }

  /** @type {Float64Array | null} node slopes ds/dτ · cell width, for the cubic Hermite lookup */
  let slopes = null;
  if (kind === 'warp') {
    // Cumulative table: composite Simpson with 4 sub-intervals per cell (weights 1 4 2 4 1 · h/3), normalised to 1.
    table = new Float64Array(N_TABLE + 1);
    slopes = new Float64Array(N_TABLE + 1);
    const h = 1 / (4 * N_TABLE);
    let acc = 0;
    let fPrev = warpSpeedC(0, Lmax);
    slopes[0] = fPrev;
    for (let k = 0; k < N_TABLE; k++) {
      const t0 = k / N_TABLE;
      const f1 = warpSpeedC(t0 + h, Lmax);
      const f2 = warpSpeedC(t0 + 2 * h, Lmax);
      const f3 = warpSpeedC(t0 + 3 * h, Lmax);
      const f4 = warpSpeedC(t0 + 4 * h, Lmax);
      acc += (h / 3) * (fPrev + 4 * f1 + 2 * f2 + 4 * f3 + f4);
      table[k + 1] = acc;
      slopes[k + 1] = f4;
      fPrev = f4;
    }
    const total = table[N_TABLE];
    // Normalise so s(1) = 1 exactly (P(1) = E); slopes become ds/dτ at the nodes, pre-scaled by the cell width so
    // the Hermite basis can use the cell-local fraction directly.
    for (let k = 1; k <= N_TABLE; k++) table[k] /= total;
    for (let k = 0; k <= N_TABLE; k++) slopes[k] /= total * N_TABLE;
    table[N_TABLE] = 1;
    // Monotonicity limiter (Fritsch & Carlson 1980, SIAM J. Numer. Anal. 17(2):238, sufficient condition
    // m_k ≤ 3·min(δ_{k−1}, δ_k)): v starts like τ³ so s starts like τ⁴ and the exact slope at the first node is
    // 4× the cell secant, which would let the cubic dip to ≈ −2e-13 inside the first cell. Only the first/last few
    // cells (v < 1e-6 c) are affected.
    slopes[0] = 0; slopes[N_TABLE] = 0;
    for (let k = 1; k < N_TABLE; k++) {
      const lim = 3 * Math.min(table[k] - table[k - 1], table[k + 1] - table[k]);
      if (slopes[k] > lim) slopes[k] = lim;
    }
  }

  const isWarp = kind === 'warp';
  const tbl = table;
  const slp = slopes;
  const LmaxSolved = Lmax === null ? 0 : Lmax;

  /**
   * Cubic Hermite interpolation of the cumulative table with the analytic node slopes (C¹ progress; the derivative
   * equals v/D at every node). Linear interpolation was measured to bias the 120 Hz finite-difference speed by up
   * to 0.96 % (30.5 AU) because the cell slope is the cell AVERAGE of a steeply varying v; Hermite brings that below
   * the plan's 0.5 % with margin and removes the 512 tiny velocity steps a linear table would give the camera.
   * @param {number} tau @returns {number}
   */
  const s = isWarp
    ? (tau) => {
      if (tau <= 0) return 0;
      if (tau >= 1) return 1;
      const x = tau * N_TABLE;
      const i = x | 0;
      const f = x - i;
      const f2 = f * f, f3 = f2 * f;
      // h00 = 2f³ − 3f² + 1, h10 = f³ − 2f² + f, h01 = −2f³ + 3f², h11 = f³ − f²
      return (2 * f3 - 3 * f2 + 1) * tbl[i] + (f3 - 2 * f2 + f) * slp[i]
        + (-2 * f3 + 3 * f2) * tbl[i + 1] + (f3 - f2) * slp[i + 1];
    }
    : minJerk;

  /** @param {number} tau @returns {number} AU/s */
  const v = isWarp
    ? (tau) => C_AU_S * warpSpeedC(tau, LmaxSolved)
    : (tau) => D * minJerkDeriv(tau) / T;

  /** @type {FlybyProfile} */
  const profile = {
    kind, D, T, rDisp, H, warpThresholdAu, Lmax, exact,
    peakSpeedC: isWarp ? Math.pow(10, LmaxSolved) : 1.875 * D / T / C_AU_S,
    s,
    sDot: (tau) => v(tau) / D,
    v,
    speedC: (tau) => v(tau) / C_AU_S,
    lightspeedCrossings: () => null,
    chordLightspeedCrossings: () => null,
  };

  if (isWarp) {
    let trueX, chordX;
    let trueDone = false, chordDone = false;
    profile.lightspeedCrossings = () => {
      if (!trueDone) { trueX = findUnitCrossings((tau) => trueSpeedC(profile, tau, D, H)); trueDone = true; }
      return trueX;
    };
    profile.chordLightspeedCrossings = () => {
      if (!chordDone) { chordX = findUnitCrossings(profile.speedC); chordDone = true; }
      return chordX;
    };
  }
  return profile;
}

// ---------------------------------------------------------------------------------------------------------------
// Path geometry
// ---------------------------------------------------------------------------------------------------------------

/**
 * Arc height H = clamp(0.18·D, 3·R_disp, 2 AU) (plan §Fly-by path).
 * @param {number} D chord length, AU @param {number} rDisp displayed target radius, AU @returns {number} AU
 */
export function arcHeight(D, rDisp) {
  return clamp(ARC_FRACTION * D, ARC_MIN_RDISP * rDisp, ARC_MAX_AU);
}

/**
 * Lateral bump h(s) = H·4s(1 − s): zero at both ends, H at s = 0.5 (C² because s is).
 * @param {number} s @param {number} H @returns {number}
 */
export function bumpHeight(s, H) {
  return H * 4 * s * (1 - s);
}

const _d = [0, 0, 0];

/**
 * Unit vector ⟂ the chord A→E, pointing toward `up` (ecliptic north by default): n = up − (up·d̂)d̂ normalised;
 * fallback x̂ × d̂ when the chord is parallel to up (plan §Fly-by path; research §3.2). No allocation with `out`.
 * @param {ArrayLike<number>} A start, AU @param {ArrayLike<number>} E end, AU
 * @param {ArrayLike<number>} [up] @param {number[]} [out] @returns {number[]} unit vector
 */
export function lateralNormal(A, E, up = UP_Z, out = [0, 0, 0]) {
  sub(E, A, _d);
  normalize(_d, _d);
  const k = dot(up, _d);
  out[0] = up[0] - k * _d[0];
  out[1] = up[1] - k * _d[1];
  out[2] = up[2] - k * _d[2];
  if (dot(out, out) < 1e-8) cross(X_HAT, _d, out);
  return normalize(out, out);
}

/**
 * Point on the arcing path: P = (1 − s)·A + s·E + n·H·4s(1 − s). Written in lerp form so P is exactly A at s = 0
 * and exactly E at s = 1 even when the endpoints move between calls (plan: P(0) = A, P(1) = E with moving endpoints).
 * @param {ArrayLike<number>} A start, AU @param {ArrayLike<number>} E end (re-evaluated every frame), AU
 * @param {number} s progress from profile.s(τ) @param {number} H arc height, AU
 * @param {ArrayLike<number>} n unit lateral normal from lateralNormal() @param {number[]} [out]
 * @returns {number[]} AU
 */
export function pathPoint(A, E, s, H, n, out = [0, 0, 0]) {
  const h = bumpHeight(s, H);
  const u = 1 - s;
  out[0] = u * A[0] + s * E[0] + n[0] * h;
  out[1] = u * A[1] + s * E[1] + n[1] * h;
  out[2] = u * A[2] + s * E[2] + n[2] * h;
  return out;
}

/**
 * True path speed in multiples of c, including the lateral bump (critique fix): the HUD value and the quantity
 * whose 1 c crossings fire the light-speed beat.
 *   dP/dt = ṡ·[(E − A) + n·4H(1 − 2s)]  ⇒  |dP/dt| = ṡ·sqrt(D² + (4H(1 − 2s))²) = v·sqrt(1 + (4H(1 − 2s)/D)²)
 * with ṡ = v(τ)/D_launch. Passing the current chord length D (endpoints move) scales the chord term accordingly;
 * with D = profile.D this is exactly the plan formula. Factor 1.2322 at the ends for H = 0.18 D.
 * @param {FlybyProfile} profile @param {number} tau @param {number} [D] current chord length, AU
 * @param {number} [H] arc height, AU @returns {number} multiples of c
 */
export function trueSpeedC(profile, tau, D = profile.D, H = profile.H) {
  const sDot = profile.v(tau) / profile.D;
  const lat = 4 * H * (1 - 2 * profile.s(tau));
  return sDot * Math.sqrt(D * D + lat * lat) / C_AU_S;
}

// ---------------------------------------------------------------------------------------------------------------
// Arrival offset
// ---------------------------------------------------------------------------------------------------------------

const COS_AZ = Math.cos(ARRIVAL_AZIMUTH_RAD);
const SIN_AZ = Math.sin(ARRIVAL_AZIMUTH_RAD);
const _sunward = [0, 0, 0];
const _axis = [0, 0, 0];
const _kxv = [0, 0, 0];

/**
 * Camera offset from the target centre at arrival: distance R_disp/(0.35·tan(fov/2)) (≈ 6.127 R at fov 50°) along
 * the sunward direction rotated 35° about `up` (Rodrigues) and elevated by 0.35·up, renormalised
 * (plan §Fly-by arrival offset; research §3.2). Sunward = −bodyPos/|bodyPos|; for the Sun (|bodyPos| < 1e-9 AU)
 * the departure direction departurePos/|departurePos| is used instead (critique fix), and if that is also zero, x̂.
 * @param {{bodyPos: ArrayLike<number>, departurePos: ArrayLike<number>, rDisp: number, fovRad: number, up?: ArrayLike<number>}} p
 *   bodyPos target centre (AU); departurePos start position (AU); rDisp displayed target radius (AU);
 *   fovRad vertical field of view (rad); up ecliptic north by default
 * @param {number[]} [out] @returns {number[]} offset vector, AU (finite for every input)
 */
export function arrivalOffset({ bodyPos, departurePos, rDisp, fovRad, up = UP_Z }, out = [0, 0, 0]) {
  const dist = rDisp / (ARRIVAL_FILL * Math.tan(fovRad / 2));
  const rb = Math.hypot(bodyPos[0], bodyPos[1], bodyPos[2]);
  if (rb >= SUN_EPSILON_AU) {
    _sunward[0] = -bodyPos[0] / rb; _sunward[1] = -bodyPos[1] / rb; _sunward[2] = -bodyPos[2] / rb;
  } else {
    const rd = Math.hypot(departurePos[0], departurePos[1], departurePos[2]);
    if (rd >= SUN_EPSILON_AU) {
      _sunward[0] = departurePos[0] / rd; _sunward[1] = departurePos[1] / rd; _sunward[2] = departurePos[2] / rd;
    } else {
      _sunward[0] = 1; _sunward[1] = 0; _sunward[2] = 0;
    }
  }
  // Rodrigues: v' = v cosθ + (k × v) sinθ + k (k·v)(1 − cosθ), k = unit(up).
  normalize(up, _axis);
  cross(_axis, _sunward, _kxv);
  const kv = dot(_axis, _sunward) * (1 - COS_AZ);
  out[0] = _sunward[0] * COS_AZ + _kxv[0] * SIN_AZ + _axis[0] * kv + _axis[0] * ARRIVAL_ELEVATION;
  out[1] = _sunward[1] * COS_AZ + _kxv[1] * SIN_AZ + _axis[1] * kv + _axis[1] * ARRIVAL_ELEVATION;
  out[2] = _sunward[2] * COS_AZ + _kxv[2] * SIN_AZ + _axis[2] * kv + _axis[2] * ARRIVAL_ELEVATION;
  normalize(out, out);
  out[0] *= dist; out[1] *= dist; out[2] *= dist;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sim-rate easing
// ---------------------------------------------------------------------------------------------------------------

/**
 * Sim-rate cap during a fly-by: when |rate|·T > P_target/50 the destination would move more than 1/50 of its orbit
 * during the flight, so the rate is capped at ±P/(50·T) days per second (plan §Fly-by "Sim rate easing"; e.g.
 * 365.25 d/s × 6.18 s = 2 257 d > Neptune 60 189/50 = 1 204 d → cap ≈ 194.8 d/s). Sign of the rate is preserved.
 * @param {number} rateDaysPerS current sim rate, days per real second (signed)
 * @param {number} T flight duration, s @param {number} periodDays target orbital period, days
 * @returns {number | null} capped rate (days/s) or null when no cap is needed
 */
export function rateCap(rateDaysPerS, T, periodDays) {
  const limit = periodDays / (RATE_PERIOD_FRACTION * T);
  if (Math.abs(rateDaysPerS) * T <= periodDays / RATE_PERIOD_FRACTION) return null;
  return rateDaysPerS < 0 ? -limit : limit;
}

/**
 * Min-jerk blend between two rates over RATE_EASE_S seconds (plan: "ease the rate (min-jerk over 0.5 s)").
 * @param {number} from days/s @param {number} to days/s @param {number} tSinceStart s
 * @param {number} [easeS] @returns {number} days/s
 */
export function easeRate(from, to, tSinceStart, easeS = RATE_EASE_S) {
  const k = minJerk(tSinceStart / easeS);
  return from + (to - from) * k;
}
