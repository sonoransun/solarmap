import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EPS76_RAD, ARCSEC_PER_RAD, EPS76_ARCSEC } from '../src/astro/constants.js';
import { mat3Mul, mat3T, mat3Apply, rotX, rotY, rotZ, angleBetween, norm } from '../src/astro/vec.js';
import {
  M_VSOP_TO_FK5, M_VSOP_TO_ECL, EQ_TO_ECL, ECL_TO_EQ, precessionAngles, precessionMatrix, rotationVector,
} from '../src/astro/frames.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function maxAbsDiff(A, B) { let m = 0; for (let k = 0; k < 9; k++) m = Math.max(m, Math.abs(A[k] - B[k])); return m; }

test('rotation matrices are orthonormal with det +1', () => {
  for (const R of [rotX(0.3), rotY(-1.1), rotZ(2.4), EQ_TO_ECL, ECL_TO_EQ, precessionMatrix(0.5)]) {
    assert.ok(maxAbsDiff(mat3Mul(R, mat3T(R)), I) < 1e-12, 'R·Rᵀ = I to 1e-12');
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    assert.ok(Math.abs(det - 1) < 1e-12, 'det = +1');
  }
});

test('EQ_TO_ECL maps the J2000 north celestial pole to (0, +sin ε, +cos ε)', () => {
  const p = mat3Apply(EQ_TO_ECL, [0, 0, 1]);
  assert.ok(Math.abs(p[0]) < 1e-15);
  assert.ok(Math.abs(p[1] - Math.sin(EPS76_RAD)) < 1e-15, 'y = +sin ε (0.397777)');
  assert.ok(Math.abs(p[2] - Math.cos(EPS76_RAD)) < 1e-15, 'z = +cos ε (0.917482)');
  assert.ok(Math.abs(p[1] - 0.397777155932) < 1e-10 && Math.abs(p[2] - 0.917482062069) < 1e-10, 'CONSTANTS research §4 cos/sin ε76');
  const back = mat3Apply(ECL_TO_EQ, p);
  assert.ok(Math.abs(back[2] - 1) < 1e-15 && Math.abs(back[1]) < 1e-15, 'round trip');
});

test('M_VSOP_TO_FK5 implies obliquity 84381.409″ and M_VSOP_TO_ECL is a ≈0.1″ rotation', () => {
  const eps = Math.atan2(M_VSOP_TO_FK5[7], M_VSOP_TO_FK5[8]) * ARCSEC_PER_RAD;
  assert.ok(Math.abs(eps - 84381.4091) < 0.002, `vsop87.doc matrix obliquity ${eps}″ ≈ 84381.409″`);
  assert.ok(maxAbsDiff(mat3Mul(M_VSOP_TO_ECL, mat3T(M_VSOP_TO_ECL)), I) < 1e-9, 'orthonormal to 1e-9 (doc matrix is rounded to 12 digits)');
  const w = rotationVector(M_VSOP_TO_ECL).map((x) => x * ARCSEC_PER_RAD);
  // POC §6: rotation vector of R_x(ε76)·M_doc ≈ (−0.0389″, −0.0394″, −0.0908″)
  assert.ok(Math.abs(w[0] + 0.0389) < 0.003 && Math.abs(w[1] + 0.0394) < 0.003 && Math.abs(w[2] + 0.0908) < 0.003,
    `rotation vector ${w.map((x) => x.toFixed(4)).join(', ')}″ within ±0.003″ of (−0.0389, −0.0394, −0.0908)`);
  assert.ok(Math.abs(EPS76_ARCSEC - eps - 0.0389) < 0.001, 'Δε = 84381.448 − 84381.409 = 0.039″');
});

test('IAU 1976 precession angles and matrix', () => {
  const T = (2461297.0 - 2451545.0) / 36525; // 2026-09-13 12:00 TT
  assert.ok(Math.abs(T - 0.266995) < 1e-6);
  const a = precessionAngles(T);
  const deg = 180 / Math.PI;
  assert.ok(Math.abs(a.zeta * deg - 0.171048) < 1e-6, `ζ = ${a.zeta * deg}° vs 0.171048° (precision design test 8)`);
  assert.ok(Math.abs(a.z * deg - 0.171063) < 1e-6, `z = ${a.z * deg}° vs 0.171063°`);
  assert.ok(Math.abs(a.theta * deg - 0.148642) < 1e-6, `θ = ${a.theta * deg}° vs 0.148642°`);
  assert.ok(maxAbsDiff(precessionMatrix(0), I) < 1e-15, 'P(0) = I');
  // The J2000 equinox, expressed in the frame of date, has RA ≈ ζ + z = 0.342111°
  const e = mat3Apply(precessionMatrix(T), [1, 0, 0]);
  const ra = Math.atan2(e[1], e[0]) * deg;
  assert.ok(Math.abs(ra - 0.342111) < 2e-6, `J2000 equinox at RA ${ra}° of date (expected 0.342111°)`);
  // P31 = sin θ cos ζ (Meeus 21.4 structure check)
  const P = precessionMatrix(T);
  assert.ok(Math.abs(P[6] - Math.sin(a.theta) * Math.cos(a.zeta)) < 1e-15);
});

test('angleBetween is stable at 0.001″', () => {
  const tiny = 0.001 / ARCSEC_PER_RAD;
  const u = [1, 0, 0], v = [Math.cos(tiny), Math.sin(tiny), 0];
  assert.ok(Math.abs(angleBetween(u, v) - tiny) < 1e-6 / ARCSEC_PER_RAD, 'atan2 form keeps 1e-6″ precision');
  assert.equal(norm([3, 4, 12]), 13);
});
