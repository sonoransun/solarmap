// Pure fly-by math (no DOM, no three.js): duration law, warp (log-speed) and min-jerk profiles, the arcing path
// between MOVING endpoints, the true (path) speed for the HUD / light-speed beat, the arrival offset and the
// sim-rate cap. Everything here works on plain [x, y, z] arrays in AU and real seconds.
// The last section holds the camera-glide helpers shared by src/render/camera.js (glide duration law, zoom space,
// bounding sphere, sky-view fov fit, frame-rate-independent OrbitControls damping, Esc deceleration law) so that the
// rig's arithmetic is testable from test/ without three.js.
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
//  - Bounding sphere: Ritter 1990, "An efficient bounding sphere", Graphics Gems (Glassner ed.), pp. 301–303.
//  - Zoom space log(tan(fov/2)): the camera's magnification is ∝ 1/tan(fov/2), so a lerp there is a constant-rate zoom.

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

// ---------------------------------------------------------------------------------------------------------------
// Camera glides (contracts §"Camera rig API additions"; used by src/render/camera.js)
// ---------------------------------------------------------------------------------------------------------------

/** Glide duration bounds, real seconds (contracts: "viewPose duration scaled with the pose distance (0.8–2.2 s)"). */
export const GLIDE_MIN_S = 0.8;
export const GLIDE_MAX_S = 2.2;
/** Travel effort is log-scaled: log10(1 + d/GLIDE_TRAVEL_REF_AU) reaches 1 (full effort) at GLIDE_TRAVEL_FULL_AU
 *  (≈ the radius of Neptune's orbit, i.e. crossing the whole map). */
export const GLIDE_TRAVEL_REF_AU = 0.01;
export const GLIDE_TRAVEL_FULL_AU = 50;
/** Zoom effort reaches 1 after this many decades of distance / magnification change. */
export const GLIDE_ZOOM_FULL_DECADES = 3;

/**
 * Duration of a camera glide: GLIDE_MIN_S + (GLIDE_MAX_S − GLIDE_MIN_S) × the largest of three normalised efforts —
 * travel log10(1 + d/0.01 AU)/log10(1 + 50/0.01), turn |angle|/π and zoom |decades|/3 — so a fixed 1.2 s from any pose
 * (the critique's "whip pans") becomes 0.8 s for a nudge and 2.2 s for crossing the map or turning right round.
 * With a min-jerk slerp the peak angular speed is 1.875·angle/T (minJerkDeriv max): 180° over 2.2 s peaks at 153°/s
 * and 60° over 1.27 s at 89°/s.
 * @param {{travelAu?: number, turnRad?: number, zoomDecades?: number}} p efforts (any may be omitted; NaN counts as 0)
 * @returns {number} seconds in [GLIDE_MIN_S, GLIDE_MAX_S]
 */
export function glideDuration({ travelAu = 0, turnRad = 0, zoomDecades = 0 } = {}) {
  const full = Math.log10(1 + GLIDE_TRAVEL_FULL_AU / GLIDE_TRAVEL_REF_AU);
  const eTravel = travelAu > 0 ? Math.log10(1 + travelAu / GLIDE_TRAVEL_REF_AU) / full : 0;
  const eTurn = Math.abs(turnRad) / Math.PI;
  const eZoom = Math.abs(zoomDecades) / GLIDE_ZOOM_FULL_DECADES;
  let e = Math.max(eTravel, eTurn > 0 ? eTurn : 0, eZoom > 0 ? eZoom : 0);
  if (!(e >= 0)) e = 0;
  return GLIDE_MIN_S + (GLIDE_MAX_S - GLIDE_MIN_S) * clamp(e, 0, 1);
}

/**
 * Zoom space z = ln(tan(fov/2)). The pinhole magnification is ∝ 1/tan(fov/2), so equal steps in z are equal
 * magnification ratios and a min-jerk lerp in z reads as one smooth zoom from 50° to 0.25° (a lerp in degrees would
 * spend 90 % of its time wide and then dive). Vertical fov in radians, 0 < fov < π.
 * @param {number} fovRad @returns {number}
 */
export function zoomFromFov(fovRad) {
  return Math.log(Math.tan(fovRad / 2));
}

/**
 * Inverse of zoomFromFov: fov = 2·atan(eᶻ).
 * @param {number} z @returns {number} radians
 */
export function fovFromZoom(z) {
  return 2 * Math.atan(Math.exp(z));
}

const _bsA = [0, 0, 0];
const _bsB = [0, 0, 0];

/**
 * Approximate minimal bounding sphere of a point set (Ritter 1990, Graphics Gems pp. 301–303): start from the two
 * mutually farthest points of a two-pass scan, then grow the sphere just enough to swallow each point still outside
 * (centre shifts by (d − r)/2 toward the point, radius becomes (d + r)/2). Radius ≤ ~5 % above optimal, exact for
 * 1 or 2 points; empty input gives radius 0 at the origin. Used by frameBodies().
 * @param {ArrayLike<ArrayLike<number>>} points [x, y, z] arrays, AU
 * @param {{center: number[], radius: number}} [out]
 * @returns {{center: number[], radius: number}}
 */
export function boundingSphere(points, out = { center: [0, 0, 0], radius: 0 }) {
  const c = out.center;
  const n = points.length;
  if (n === 0) { c[0] = 0; c[1] = 0; c[2] = 0; out.radius = 0; return out; }
  const farthestFrom = (p, into) => {
    let best = -1, bi = 0;
    for (let i = 0; i < n; i++) {
      const q = points[i];
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      if (d > best) { best = d; bi = i; }
    }
    into[0] = points[bi][0]; into[1] = points[bi][1]; into[2] = points[bi][2];
    return into;
  };
  farthestFrom(points[0], _bsA); // y: farthest from x = points[0]
  farthestFrom(_bsA, _bsB);      // z: farthest from y
  c[0] = 0.5 * (_bsA[0] + _bsB[0]); c[1] = 0.5 * (_bsA[1] + _bsB[1]); c[2] = 0.5 * (_bsA[2] + _bsB[2]);
  let r = 0.5 * Math.hypot(_bsB[0] - _bsA[0], _bsB[1] - _bsA[1], _bsB[2] - _bsA[2]);
  for (let i = 0; i < n; i++) {
    const q = points[i];
    const dx = q[0] - c[0], dy = q[1] - c[1], dz = q[2] - c[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > r) {
      const nr = 0.5 * (d + r);
      const k = (d - r) / (2 * d); // shift the centre (d − r)/2 toward q
      c[0] += dx * k; c[1] += dy * k; c[2] += dz * k;
      r = nr;
    }
  }
  out.radius = r;
  return out;
}

/** Sky view fit (plan §Fly-by "Sky view"; contracts): every target ≥ SKY_TARGET_PX px of projected radius, groups
 *  fit their angular spread with SKY_PAIR_MARGIN, fov never below SKY_MIN_FOV_RAD (0.25°) nor above SKY_MAX_FOV_RAD. */
export const SKY_TARGET_PX = 40;
export const SKY_PAIR_MARGIN = 1.35;
export const SKY_MIN_FOV_RAD = 0.25 * DEG;
export const SKY_MAX_FOV_RAD = 100 * DEG;

/**
 * Sky-view vertical field of view. Inverting pxRadius = R/d/tan(fov/2)·H/2 (plan §Rendering "Markers") gives
 * tan(fov/2) ≤ R·H/(2·px·d) per target; the narrowest of those is widened to 2·spread·margin so a pair or group stays
 * on screen, then clamped to [minFovRad, maxFovRad]. Without a viewport height (H ≤ 0) the pixel rule is skipped and
 * the result starts from baseFovRad. Example (Great Conjunction, H = 900 px): Jupiter R = 4.67e-4 AU at 5.9 AU wants
 * 0.102°, Saturn 0.048°, the 6′ pair spread wants 0.137° → clamped up to 0.25°, where Jupiter is ≈ 16 px and Saturn
 * ≈ 8 px in radius (the old 10° floor left both below one pixel).
 * @param {object} p
 * @param {ArrayLike<{dist: number, rDisp: number, offAxisRad: number}>} p.targets distance from the camera (AU),
 *   displayed radius (AU) and angle between the target direction and the view axis (rad)
 * @param {number} [p.count=targets.length] how many leading entries of `targets` to use (callers reuse a scratch array)
 * @param {number} p.H viewport height, CSS px
 * @param {number} p.baseFovRad the camera's normal fov (upper start value)
 * @param {number} [p.px=SKY_TARGET_PX] @param {number} [p.margin=SKY_PAIR_MARGIN]
 * @param {number} [p.minFovRad=SKY_MIN_FOV_RAD] @param {number} [p.maxFovRad=SKY_MAX_FOV_RAD]
 * @returns {number} radians
 */
export function skyFitFovRad({
  targets, count = targets.length, H, baseFovRad, px = SKY_TARGET_PX, margin = SKY_PAIR_MARGIN,
  minFovRad = SKY_MIN_FOV_RAD, maxFovRad = SKY_MAX_FOV_RAD,
}) {
  let tanHalf = Math.tan(baseFovRad / 2);
  let spread = 0;
  for (let i = 0; i < count; i++) {
    const t = targets[i];
    if (H > 0 && t.dist > 0 && t.rDisp > 0) tanHalf = Math.min(tanHalf, t.rDisp * H / (2 * px * t.dist));
    if (t.offAxisRad > spread) spread = t.offAxisRad;
  }
  let fov = 2 * Math.atan(tanHalf);
  if (count > 1 && spread > 0) fov = Math.max(fov, 2 * spread * margin);
  return clamp(fov, minFovRad, maxFovRad);
}

/**
 * OrbitControls (three r186) applies its damping once per update() call — `spherical += delta·f` then
 * `delta *= (1 − f)`, OrbitControls.js lines 717–718 and 801–804 — independent of the deltaTime argument (which only
 * scales autoRotate, lines 932–940). For the same feel at any frame rate the per-call factor must satisfy
 * (1 − f(dt))^(1/dt) = (1 − f60)^60, i.e. f(dt) = 1 − (1 − f60)^(60·dt). The total travel Σ f(1 − f)^k = 1 is the
 * same for every f, so only the time constant changes, never where the camera ends up.
 * @param {number} f60 damping factor tuned for a 60 Hz frame (0 < f60 < 1)
 * @param {number} dt this frame's real seconds (≥ 0)
 * @returns {number} damping factor for this frame
 */
export function dampingForFrame(f60, dt) {
  return 1 - Math.pow(1 - f60, 60 * (dt > 0 ? dt : 0));
}

/** Esc mid-flight: decelerate in place over at most CANCEL_DECEL_S, coasting ≤ CANCEL_COAST_FRACTION of the remaining
 *  chord (plan §Fly-by "Arrival"; critique: keeps "in place" honest at 10³ c). */
export const CANCEL_DECEL_S = 0.6;
export const CANCEL_COAST_FRACTION = 0.25;

/**
 * Length of the Esc deceleration. v(t) = v0·(1 − minJerk(t/T_d)) travels v0·T_d/2, so T_d = min(0.6 s,
 * 2·0.25·remaining/v0) keeps the coast within a quarter of the remaining chord WITHOUT touching v0: the speed is
 * continuous at the cancel instant (the critique's one-frame speed drop came from clamping v0 instead of T_d).
 * @param {number} speedAuPerS current true speed, AU per real second (≥ 0)
 * @param {number} remainingAu distance still to go along the chord, AU (≥ 0)
 * @param {number} [maxS=CANCEL_DECEL_S] @param {number} [coastFraction=CANCEL_COAST_FRACTION]
 * @returns {number} seconds in [0, maxS]
 */
export function cancelDecelSeconds(speedAuPerS, remainingAu, maxS = CANCEL_DECEL_S, coastFraction = CANCEL_COAST_FRACTION) {
  if (!(speedAuPerS > 0)) return maxS;
  const byCoast = 2 * coastFraction * Math.max(remainingAu, 0) / speedAuPerS;
  return Math.min(maxS, byCoast);
}
