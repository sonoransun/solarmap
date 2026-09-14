// Double-precision 3-vector and 3×3 matrix helpers on plain arrays.
// Vectors: [x, y, z]. Matrices: row-major length-9 arrays [m00, m01, m02, m10, …, m22].
// Rotations are ACTIVE right-handed rotations applied to column vectors (see CLAUDE.md).

/**
 * @param {number} x @param {number} y @param {number} z
 * @returns {number[]}
 */
export function v3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {number[]} [out] @returns {number[]} */
export function add(a, b, out = [0, 0, 0]) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {number[]} [out] @returns {number[]} a − b */
export function sub(a, b, out = [0, 0, 0]) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

/** @param {ArrayLike<number>} a @param {number} s @param {number[]} [out] @returns {number[]} */
export function scale(a, s, out = [0, 0, 0]) {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {number} */
export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {number[]} [out] @returns {number[]} a × b */
export function cross(a, b, out = [0, 0, 0]) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** @param {ArrayLike<number>} a @returns {number} Euclidean length */
export function norm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

/** @param {ArrayLike<number>} a @param {number[]} [out] @returns {number[]} unit vector (zero vector stays zero) */
export function normalize(a, out = [0, 0, 0]) {
  const n = norm(a);
  if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  return scale(a, 1 / n, out);
}

/**
 * Angle between two vectors, numerically stable for tiny angles (atan2 form, never acos).
 * @param {ArrayLike<number>} u @param {ArrayLike<number>} v @returns {number} radians in [0, π]
 */
export function angleBetween(u, v) {
  const c = cross(u, v);
  return Math.atan2(norm(c), dot(u, v));
}

/** @returns {number[]} 3×3 identity */
export function mat3Identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** Active rotation about +x by θ (radians). @param {number} t @returns {number[]} */
export function rotX(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Active rotation about +y by θ (radians). @param {number} t @returns {number[]} */
export function rotY(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Active rotation about +z by θ (radians). @param {number} t @returns {number[]} */
export function rotZ(t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** @param {ArrayLike<number>} A @param {ArrayLike<number>} B @param {number[]} [out] @returns {number[]} A·B */
export function mat3Mul(A, B, out = new Array(9)) {
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    }
  }
  for (let k = 0; k < 9; k++) out[k] = r[k];
  return out;
}

/** @param {ArrayLike<number>} A @param {number[]} [out] @returns {number[]} transpose */
export function mat3T(A, out = new Array(9)) {
  const r = [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
  for (let k = 0; k < 9; k++) out[k] = r[k];
  return out;
}

/** @param {ArrayLike<number>} M @param {ArrayLike<number>} v @param {number[]} [out] @returns {number[]} M·v */
export function mat3Apply(M, v, out = [0, 0, 0]) {
  const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
  const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
  const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Wrap an angle in radians into [0, 2π). @param {number} a @returns {number} */
export function wrap2Pi(a) {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/** Wrap an angle in radians into (−π, π]. @param {number} a @returns {number} */
export function wrapPi(a) {
  let t = a % (2 * Math.PI);
  if (t <= -Math.PI) t += 2 * Math.PI;
  else if (t > Math.PI) t -= 2 * Math.PI;
  return t;
}

/** Wrap degrees into [0, 360). @param {number} d @returns {number} */
export function wrap360(d) {
  const t = d % 360;
  return t < 0 ? t + 360 : t;
}

/** Wrap degrees into (−180, 180]. @param {number} d @returns {number} */
export function wrap180(d) {
  let t = d % 360;
  if (t <= -180) t += 360;
  else if (t > 180) t -= 360;
  return t;
}
