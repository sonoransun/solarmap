import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C_AU_S, AU_KM, SUN_RADIUS_KM, DEG } from '../src/astro/constants.js';
import { norm, dot, sub, mat3Apply, rotZ, normalize, angleBetween } from '../src/astro/vec.js';
import {
  duration, planProfile, arcHeight, bumpHeight, pathPoint, lateralNormal, trueSpeedC, arrivalOffset, rateCap,
  easeRate, smootherstep, minJerk, minJerkDeriv, warpCap, WARP_MIN_AU, WARP_RDISP_FACTOR, N_TABLE,
} from '../src/astro/flyby.js';

// Displayed radii at k = 1 (NSSDC mean radii, km / AU): R_disp is the only body-specific input of the profile.
const R_MARS = 3389.5 / AU_KM;
const R_EARTH = 6371.0 / AU_KM;
const R_NEPTUNE = 24622 / AU_KM;
const R_SUN = SUN_RADIUS_KM / AU_KM; // k = 1 (plan: R_disp(Sun) = R☉·min(k, 30))
const FOV = 50 * DEG;

/** The five plan distances with a plausible target radius each (plan test row "flyby"). */
const CASES = [
  { D: 0.005, rDisp: R_MARS }, { D: 0.01, rDisp: R_MARS }, { D: 0.5, rDisp: R_MARS },
  { D: 4.2, rDisp: R_EARTH }, { D: 30.5, rDisp: R_NEPTUNE },
];

/** Composite Simpson on [0, 1] with n (even) sub-intervals — independent of the module's midpoint/Hermite schemes. */
function simpson01(f, n) {
  const h = 1 / n;
  let s = f(0) + f(1);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(i * h);
  return s * h / 3;
}

test('elementary shapes: smootherstep, min-jerk, warp cap', () => {
  assert.equal(smootherstep(-1), 0); assert.equal(smootherstep(2), 1);
  assert.equal(smootherstep(0.5), 0.5, 'ss(0.5) = 6/32 − 15/16 + 10/8 = 0.5');
  // ss' = 30x²(1 − x)² vanishes at both ends, so the one-sided difference quotient over e is 10e² + O(e³).
  const e = 1e-3;
  assert.ok(Math.abs((smootherstep(e) - smootherstep(0)) / e) < 20 * e * e, "ss'(0) = 0 (Perlin: zero 1st/2nd derivative)");
  assert.ok(Math.abs((smootherstep(1) - smootherstep(1 - e)) / e) < 20 * e * e, "ss'(1) = 0");
  assert.equal(minJerk(0.5), 0.5, 'Flash & Hogan s(0.5) = 10/8 − 15/16 + 6/32');
  assert.equal(minJerkDeriv(0.5), 1.875, "max s' = 30·0.25·0.25 = 1.875 (research §3.1)");
  assert.equal(minJerk(0), 0); assert.equal(minJerk(1), 1); assert.equal(minJerkDeriv(0), 0); assert.equal(minJerkDeriv(1), 0);
  assert.equal(warpCap(0), 0); assert.equal(warpCap(1), 0); assert.equal(warpCap(0.5), 1); assert.equal(warpCap(0.05), 1);
});

test('duration law T = clamp(2 + 1.2·log10(1 + D/0.01), 1.5, 7)', () => {
  assert.ok(Math.abs(duration(0.5) - 4.05) < 0.01, `T(0.5 AU) = ${duration(0.5)} vs plan 4.05 ± 0.01 s (critique: 4.0491)`);
  assert.ok(Math.abs(duration(30.5) - 6.18) < 0.01, `T(30.5 AU) = ${duration(30.5)} vs plan 6.18 ± 0.01 s (critique: 6.1813)`);
  assert.ok(Math.abs(duration(0.01) - 2.4) < 0.05 && Math.abs(duration(1) - 4.4) < 0.05 && Math.abs(duration(30) - 6.2) < 0.05,
    'research §3.5: 0.01 → 2.4 s, 1 → 4.4 s, 30 → 6.2 s');
  assert.equal(duration(0), 2.0, 'log10(1) = 0');
  assert.equal(duration(1e9), 7.0, 'upper clamp 7 s');
});

test('warp profile: ∫v dt = D within 1e-6 relative, v(0) = v(T) = 0, s monotone with exact endpoints', () => {
  for (const { D, rDisp } of CASES) {
    const p = planProfile({ D, rDisp });
    assert.equal(p.kind, 'warp', `D = ${D} ≥ max(0.005, 20·R_disp) uses the warp branch`);
    assert.equal(p.exact, true, 'L_max solved inside [L_min, 6]');
    assert.ok(p.Lmax > -3 && p.Lmax < 6, `L_max = ${p.Lmax} inside the bisection bracket`);
    // Reference: Simpson with 65 536 sub-intervals on the module's own v(τ); ∫₀ᵀ v dt = T·∫₀¹ v dτ.
    const integral = p.T * simpson01(p.v, 1 << 16);
    assert.ok(Math.abs(integral - D) / D < 1e-6, `∫v dt = ${integral} vs D = ${D}: plan tolerance 1e-6 relative (measured ~1e-14)`);
    assert.equal(p.v(0), 0, 'v(0) = 0 (cap(0) = ss(0) = 0)');
    assert.equal(p.v(1), 0, 'v(T) = 0');
    assert.equal(p.s(0), 0, 's(0) = 0 exactly'); assert.equal(p.s(1), 1, 's(1) = 1 exactly (table normalised)');
    assert.equal(p.s(-0.5), 0); assert.equal(p.s(1.5), 1);
    assert.ok(Math.abs(p.s(0.5) - 0.5) < 1e-12, `s(0.5) = ${p.s(0.5)}: profile symmetric about τ = 0.5`);
    let prev = -1;
    for (let k = 0; k <= 20000; k++) {
      const s = p.s(k / 20000);
      assert.ok(s >= 0 && s <= 1 && s >= prev, `s(τ) monotone non-decreasing in [0, 1] (τ = ${k / 20000}, s = ${s}, prev = ${prev})`);
      prev = s;
    }
    // Hermite table reproduces the analytic ds/dτ = T·v/D at the nodes where the speed is not negligible.
    for (let k = 8; k < N_TABLE - 8; k += 7) {
      const tau = k / N_TABLE, e = 1e-6;
      const num = (p.s(tau + e) - p.s(tau - e)) / (2 * e);
      const an = p.T * p.v(tau) / D;
      if (p.speedC(tau) < 1e-3) continue;
      assert.ok(Math.abs(num - an) / an < 1e-4, `ds/dτ at node ${k}: table ${num} vs analytic ${an} (1e-4 rel; O(h⁴) Hermite)`);
    }
  }
});

test('acceleration continuity: central difference at 1 ms, adjacent |Δa| < 2 % of peak |a|', () => {
  // Critique measured 0.89 % (0.002/0.005 AU), 0.87 % (0.01), 0.59 % (0.5), 0.44 % (30.5) and set the threshold at 2 %.
  const h = 1e-3;
  for (const { D, rDisp } of CASES) {
    const p = planProfile({ D, rDisp });
    const N = Math.floor(p.T / h);
    let peakA = 0, maxDa = 0, prev = null;
    for (let i = 0; i <= N; i++) {
      const t = i * h;
      const a = (p.v((t + h) / p.T) - p.v((t - h) / p.T)) / (2 * h);
      peakA = Math.max(peakA, Math.abs(a));
      if (prev !== null) maxDa = Math.max(maxDa, Math.abs(a - prev));
      prev = a;
    }
    assert.ok(maxDa < 0.02 * peakA, `D = ${D}: max adjacent |Δa| = ${(100 * maxDa / peakA).toFixed(3)} % of peak a (plan/critique: < 2 %)`);
  }
});

test('peak chord speed: 346 c ± 5 (0.5 AU), 15 800 c ± 300 (30.5 AU); L_max pinned', () => {
  const a = planProfile({ D: 0.5, rDisp: R_MARS });
  const b = planProfile({ D: 30.5, rDisp: R_NEPTUNE });
  assert.ok(Math.abs(a.peakSpeedC - 346) < 5, `0.5 AU peak ${a.peakSpeedC} c vs plan 346 ± 5 (critique 345.5)`);
  assert.ok(Math.abs(b.peakSpeedC - 15800) < 300, `30.5 AU peak ${b.peakSpeedC} c vs plan 15 800 ± 300 (critique 15 804)`);
  assert.ok(Math.abs(a.Lmax - 2.5385) < 1e-3, `L_max(0.5 AU) = ${a.Lmax} vs critique 2.5385`);
  assert.ok(Math.abs(b.Lmax - 4.1988) < 1e-3, `L_max(30.5 AU) = ${b.Lmax} vs 10^4.1988 = 15 804 c`);
  let mx = 0;
  for (let k = 0; k <= 4096; k++) mx = Math.max(mx, a.speedC(k / 4096));
  assert.ok(Math.abs(mx - a.peakSpeedC) < 1e-9, 'peakSpeedC is the maximum of speedC (at τ = 0.5)');
});

test('1 c crossings: chord 0.98 s / 3.07 s ± 0.05 (0.5 AU); true speed (with the bump) re-derived and pinned', () => {
  const a = planProfile({ D: 0.5, rDisp: R_MARS });
  assert.equal(a.H, 0.09, 'H = 0.18·D for 0.5 AU (3·R_disp and 2 AU clamps inactive)');
  const [cOut, cIn] = a.chordLightspeedCrossings().map((tau) => tau * a.T);
  assert.ok(Math.abs(cOut - 0.98) < 0.05, `chord 1 c out at ${cOut} s vs plan 0.98 ± 0.05 (critique 0.984)`);
  assert.ok(Math.abs(cIn - 3.07) < 0.05, `chord 1 c in at ${cIn} s vs plan 3.07 ± 0.05 (critique 3.065)`);
  // True speed = chord speed × sqrt(1 + (4H(1 − 2s)/D)²): factor 1.2322 at the ends for H = 0.18 D, so the
  // outward crossing is earlier and the inward later. Values re-derived here with this module (plan: "pinned").
  const [tOut, tIn] = a.lightspeedCrossings().map((tau) => tau * a.T);
  assert.ok(Math.abs(tOut - 0.962) < 0.05, `true 1 c out at ${tOut} s (pinned 0.962 ± 0.05; earlier than the chord's 0.984)`);
  assert.ok(Math.abs(tIn - 3.087) < 0.05, `true 1 c in at ${tIn} s (pinned 3.087 ± 0.05; later than the chord's 3.065)`);
  assert.ok(tOut < cOut && tIn > cIn, 'the bump term widens the super-luminal interval');
  for (const tau of a.lightspeedCrossings()) {
    assert.ok(Math.abs(trueSpeedC(a, tau, a.D, a.H) - 1) < 1e-9, `trueSpeedC = 1 at the crossing τ = ${tau}`);
  }
  const b = planProfile({ D: 30.5, rDisp: R_NEPTUNE });
  assert.equal(b.H, 2, 'H clamps at 2 AU for 30.5 AU');
  const [bcOut, bcIn] = b.chordLightspeedCrossings().map((tau) => tau * b.T);
  assert.ok(Math.abs(bcOut - 1.251) < 0.05 && Math.abs(bcIn - 4.931) < 0.05, `30.5 AU chord crossings ${bcOut}/${bcIn} s vs critique 1.251/4.931`);
  const [btOut, btIn] = b.lightspeedCrossings().map((tau) => tau * b.T);
  assert.ok(Math.abs(btOut - 1.247) < 0.05 && Math.abs(btIn - 4.935) < 0.05, `30.5 AU true crossings ${btOut}/${btIn} s (pinned 1.247/4.935; factor only 1.034 at the ends since 4H/D = 0.262)`);
  // The rate-easing example from plan QA 6 uses these same durations.
  assert.ok(Math.abs(b.T - 6.18) < 0.01);
});

test('short hop: D = 0.001 AU with R_disp = 4e-5 uses min-jerk and never exceeds 1 c', () => {
  const p = planProfile({ D: 0.001, rDisp: 4e-5 });
  assert.equal(p.kind, 'minjerk');
  assert.equal(p.warpThresholdAu, WARP_MIN_AU, `threshold max(0.005, 20·4e-5 = 8e-4) = 0.005 AU`);
  assert.equal(p.Lmax, null);
  assert.equal(p.lightspeedCrossings(), null, 'no beat in the min-jerk branch');
  assert.equal(p.chordLightspeedCrossings(), null);
  assert.ok(Math.abs(p.peakSpeedC - 0.456) < 0.005, `min-jerk peak 1.875·D/T = ${p.peakSpeedC} c (critique 0.456 c)`);
  let mx = 0;
  for (let k = 0; k <= 4096; k++) mx = Math.max(mx, trueSpeedC(p, k / 4096));
  assert.ok(mx < 1, `true speed max ${mx} c < 1 c`);
  assert.equal(p.s(0.5), 0.5); assert.equal(p.s(0.25), minJerk(0.25));
  assert.ok(Math.abs(p.v(0.5) - 0.001 * 1.875 / p.T) < 1e-15, "v = D·s'(τ)/T");
  const integral = p.T * simpson01(p.v, 1 << 12);
  assert.ok(Math.abs(integral - 0.001) / 0.001 < 1e-9, 'min-jerk also integrates to D');
});

test('branch threshold max(0.005 AU, 20·R_disp) and custom override', () => {
  assert.equal(planProfile({ D: 0.005, rDisp: R_MARS }).kind, 'warp', 'D = threshold → warp');
  assert.equal(planProfile({ D: 0.0049, rDisp: R_MARS }).kind, 'minjerk');
  const rJup = 69911 / AU_KM; // 4.67e-4 AU → 20·R = 9.3e-3 AU > 0.005 AU
  assert.equal(WARP_RDISP_FACTOR * rJup > WARP_MIN_AU, true);
  assert.equal(planProfile({ D: 0.008, rDisp: rJup }).kind, 'minjerk', 'Jupiter re-frame at 17 R never warps (critique)');
  assert.equal(planProfile({ D: 0.01, rDisp: rJup }).kind, 'warp');
  assert.equal(planProfile({ D: 0.5, rDisp: R_MARS, warpThresholdAu: 1 }).kind, 'minjerk', 'explicit threshold honoured');
  const forced = planProfile({ D: 1e-7, rDisp: 1e-9, warpThresholdAu: 0 });
  assert.equal(forced.kind, 'minjerk', 'falls back to min-jerk when even L_max = L_min overshoots D');
  const custom = planProfile({ D: 0.5, rDisp: R_MARS, T: 3 });
  assert.equal(custom.T, 3, 'explicit T honoured');
  assert.ok(custom.peakSpeedC > planProfile({ D: 0.5, rDisp: R_MARS }).peakSpeedC, 'shorter T → higher peak');
});

test('arc height and bump: h(0) = h(1) = 0, max = H at s = 0.5', () => {
  assert.equal(arcHeight(0.5, R_MARS), 0.09, '0.18·D');
  assert.equal(arcHeight(30.5, R_NEPTUNE), 2, 'clamped at 2 AU');
  assert.equal(arcHeight(1e-4, R_SUN), 3 * R_SUN, 'floor 3·R_disp');
  const H = 0.09;
  assert.equal(bumpHeight(0, H), 0); assert.equal(bumpHeight(1, H), 0);
  assert.equal(bumpHeight(0.5, H), H, 'H·4·0.5·0.5 = H');
  let mx = 0;
  for (let k = 0; k <= 1000; k++) mx = Math.max(mx, bumpHeight(k / 1000, H));
  assert.equal(mx, H, 'maximum is H, attained at s = 0.5');
});

test('lateralNormal: unit, ⟂ chord, toward ecliptic north; x̂ × d̂ fallback; out param reused', () => {
  const A = [1, 0.2, 0.05], E = [4.2, -1.3, 0.4];
  const n = lateralNormal(A, E);
  const d = sub(E, A);
  assert.ok(Math.abs(norm(n) - 1) < 1e-15, 'unit');
  assert.ok(Math.abs(dot(n, d)) < 1e-12, '⟂ chord');
  assert.ok(n[2] > 0.9, 'points toward +z (ecliptic north) for a nearly in-plane chord');
  const out = [9, 9, 9];
  assert.equal(lateralNormal(A, E, [0, 0, 1], out), out, 'returns the out array (no allocation)');
  const par = lateralNormal([0, 0, 0], [0, 0, 5]);
  assert.deepEqual(par, [0, -1, 0], 'chord ∥ up → x̂ × ẑ = (0, −1, 0)');
  const up2 = lateralNormal([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.deepEqual(up2, [0, 1, 0], 'custom up already ⟂ chord is returned unchanged');
});

test('pathPoint: P(0) = A and P(1) = E exactly with moving endpoints; P(0.5) = midpoint + n·H', () => {
  const A = [0.98, 0.17, 0.001];
  const H = 0.09;
  for (let k = 0; k < 50; k++) {
    // E moves every step (the target planet keeps orbiting during the flight).
    const E = [1.4 + 0.01 * k, -0.3 + 0.004 * k, 0.02 - 0.0003 * k];
    const n = lateralNormal(A, E);
    assert.deepEqual(pathPoint(A, E, 0, H, n), A, `P(0) = A (step ${k})`);
    assert.deepEqual(pathPoint(A, E, 1, H, n), E, `P(1) = E exactly (lerp form) (step ${k})`);
    const mid = pathPoint(A, E, 0.5, H, n);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(mid[i] - (0.5 * (A[i] + E[i]) + n[i] * H)) < 1e-15, 'P(0.5) = (A + E)/2 + n·H');
    }
  }
  const out = [0, 0, 0];
  assert.equal(pathPoint(A, [2, 0, 0], 0.3, H, [0, 0, 1], out), out, 'returns out');
});

test('trueSpeedC vs finite difference of pathPoint at 120 Hz with endpoints frozen (0.5 % where ≥ 0.01 c)', () => {
  const dt = 1 / 120;
  for (const { D, rDisp } of CASES) {
    const p = planProfile({ D, rDisp });
    const A = [1, 0.2, 0.1];
    const E = [1 + D * 0.6, 0.2 + D * 0.8, 0.1]; // |E − A| = D
    assert.ok(Math.abs(norm(sub(E, A)) - D) < 1e-12);
    const n = lateralNormal(A, E);
    const M = Math.floor(p.T / dt);
    let worst = 0, worstAbs = 0;
    for (let k = 1; k < M; k++) {
      const t = k * dt;
      const Pp = pathPoint(A, E, p.s((t + dt) / p.T), p.H, n);
      const Pm = pathPoint(A, E, p.s((t - dt) / p.T), p.H, n);
      const fd = norm(sub(Pp, Pm)) / (2 * dt) / C_AU_S;
      const an = trueSpeedC(p, t / p.T, D, p.H);
      const err = Math.abs(fd - an);
      if (an >= 0.01) worst = Math.max(worst, err / an);
      worstAbs = Math.max(worstAbs, err / p.peakSpeedC);
    }
    // Below 0.01 c (the first/last ≈ 50 ms, inside the smootherstep cap where v ∝ τ³) the relative curvature of v is
    // unbounded and the HUD shows km/s; there the error is bounded relative to the peak instead.
    assert.ok(worst < 0.005, `D = ${D}: worst relative FD error ${(100 * worst).toFixed(3)} % where speed ≥ 0.01 c (plan: 0.5 %; measured ≤ 0.17 % with the Hermite table, 0.96 % with linear interpolation)`);
    assert.ok(worstAbs < 0.005, `D = ${D}: worst |error| ${(100 * worstAbs).toExponential(2)} % of peak over the whole flight`);
    // At τ = 0.5 the bump term vanishes (1 − 2s = 0); at the ends the factor is sqrt(1 + (4H/D)²).
    assert.ok(Math.abs(trueSpeedC(p, 0.5) / p.speedC(0.5) - 1) < 1e-9, 'true = chord speed at mid-flight');
    const endFactor = Math.sqrt(1 + (4 * p.H / D) ** 2);
    assert.ok(Math.abs(trueSpeedC(p, 0.01) / p.speedC(0.01) - endFactor) < 1e-3, `end factor ${endFactor} (1.2322 for H = 0.18 D, critique)`);
  }
  const a = planProfile({ D: 0.5, rDisp: R_MARS });
  assert.ok(Math.abs(Math.sqrt(1 + (4 * a.H / a.D) ** 2) - 1.2322) < 1e-4, 'critique: sqrt(1 + 0.72²) = 1.2322');
  // Defaults: trueSpeedC(profile, τ) uses profile.D and profile.H.
  assert.equal(trueSpeedC(a, 0.3), trueSpeedC(a, 0.3, a.D, a.H));
});

test('arrivalOffset: requested distance, 35° azimuth about +z, elevation 0.35; finite for the Sun from every planet', () => {
  const dist = R_MARS / (0.35 * Math.tan(FOV / 2));
  assert.ok(Math.abs(dist / R_MARS - 6.127) < 1e-3, 'research §3.2 / critique: 1/(0.35·tan 25°) = 6.127 R at fov 50°');
  // Planet target: sunward = −B/|B| rotated +35° about +z (vec.js rotZ convention), elevated 0.35, renormalised.
  const B = [1.2, -0.9, 0.03];
  const off = arrivalOffset({ bodyPos: B, departurePos: [0.7, 0.7, 0], rDisp: R_MARS, fovRad: FOV });
  assert.ok(Math.abs(norm(off) - dist) < 1e-15, `|offset| = ${norm(off)} = R_disp/(0.35·tan(fov/2))`);
  const sunward = normalize([-B[0], -B[1], -B[2]]);
  const expectDir = mat3Apply(rotZ(35 * DEG), sunward);
  expectDir[2] += 0.35;
  normalize(expectDir, expectDir);
  assert.ok(angleBetween(off, expectDir) < 1e-12, 'direction = R_z(35°)·sunward + 0.35·ẑ, normalised');
  // Sun as destination from approximate planet positions (a·(cos λ, sin λ), λ = plan §geometry 2025-01-16 helio
  // longitudes, with a small ecliptic latitude): sunward would be 0/0 — the departure direction is used instead.
  const planets = [[0.387, 247.46], [0.723, 75.23], [1.0, 115.75], [1.524, 115.81], [5.203, 79.31], [9.537, 349.93], [19.19, 55.57], [30.07, 358.88]];
  const sunDist = R_SUN / (0.35 * Math.tan(FOV / 2));
  for (const [a, lon] of planets) {
    const dep = [a * Math.cos(lon * DEG), a * Math.sin(lon * DEG), a * 0.02];
    const o = arrivalOffset({ bodyPos: [0, 0, 0], departurePos: dep, rDisp: R_SUN, fovRad: FOV });
    assert.ok(o.every(Number.isFinite), `finite for the Sun from a = ${a}`);
    assert.ok(Math.abs(norm(o) - sunDist) < 1e-15, 'Sun arrival distance R☉·k/(0.35·tan(fov/2))');
    const P1 = [0 + o[0], 0 + o[1], 0 + o[2]];
    assert.ok(P1.every(Number.isFinite), 'P(1) = B + offset finite');
    const depDir = normalize(dep);
    const ref = mat3Apply(rotZ(35 * DEG), depDir); ref[2] += 0.35; normalize(ref, ref);
    assert.ok(angleBetween(o, ref) < 1e-12, 'Sun: departure direction replaces sunward (critique fix)');
    assert.ok(o[2] > 0, 'elevated above the ecliptic');
    assert.ok(dot(o, dep) > 0, 'camera arrives on the departure side of the Sun');
  }
  const degenerate = arrivalOffset({ bodyPos: [0, 0, 0], departurePos: [0, 0, 0], rDisp: R_SUN, fovRad: FOV });
  assert.ok(degenerate.every(Number.isFinite) && Math.abs(norm(degenerate) - sunDist) < 1e-15, 'Sun from the Sun: x̂ fallback, still finite');
  const out = [0, 0, 0];
  assert.equal(arrivalOffset({ bodyPos: B, departurePos: [1, 0, 0], rDisp: R_MARS, fovRad: FOV }, out), out, 'returns out');
});

test('rateCap: 365.25 d/s × 6.18 s > Neptune 60 189/50 → cap; small rates → null; easeRate min-jerk over 0.5 s', () => {
  const T = duration(30.5);
  const cap = rateCap(365.25, T, 60189);
  assert.ok(cap !== null, 'critique: 365.25 × 6.18 = 2 257 d > 1 204 d → cap fires');
  assert.ok(Math.abs(cap - 60189 / (50 * T)) < 1e-12 && Math.abs(cap - 194.7) < 0.1, `cap = P/(50·T) = ${cap} d/s`);
  assert.ok(Math.abs(cap * T - 60189 / 50) < 1e-9, 'capped flight moves the target exactly P/50');
  assert.equal(rateCap(-365.25, T, 60189), -cap, 'sign preserved for reversed time');
  assert.equal(rateCap(1, T, 60189), null, '1 d/s × 6.18 s ≪ 1 204 d');
  assert.equal(rateCap(1, duration(0.5), 686.98), null, 'Mars at 1 d/s: 4.05 d < 13.7 d');
  assert.ok(Math.abs(rateCap(10, duration(0.5), 686.98) - 686.98 / (50 * duration(0.5))) < 1e-12, 'Mars at 10 d/s: 40.5 d > 13.7 d → cap');
  assert.equal(easeRate(365.25, cap, 0), 365.25);
  assert.equal(easeRate(365.25, cap, 0.5), cap);
  assert.equal(easeRate(365.25, cap, 1), cap);
  assert.ok(Math.abs(easeRate(365.25, cap, 0.25) - 0.5 * (365.25 + cap)) < 1e-12, 'min-jerk midpoint');
});
