// Reference-frame rotations. Scene frame = JPL Horizons "Ecliptic of J2000.0" (ICRF rotated by the IAU76 obliquity).
// Sources: vsop87.doc (IMCCE, https://ftp.imcce.fr/pub/ephem/planets/vsop87/vsop87.doc) for M_VSOP_TO_FK5;
// Horizons output header for ε76; Meeus, Astronomical Algorithms (2nd ed.) eq. 21.2 for the IAU 1976 precession angles.
import { EPS76_RAD, DAYS_PER_CENTURY, J2000, ARCSEC_PER_RAD } from './constants.js';
import { rotX, rotY, rotZ, mat3Mul, mat3Apply } from './vec.js';

/**
 * VSOP87A dynamical ecliptic J2000 → FK5 equatorial J2000, verbatim from vsop87.doc:
 *   X_FK5 = +1.000000000000 X + 0.000000440360 Y − 0.000000190919 Z
 *   Y_FK5 = −0.000000479966 X + 0.917482137087 Y − 0.397776982902 Z
 *   Z_FK5 =  0.000000000000 X + 0.397776982902 Y + 0.917482137087 Z
 */
export const M_VSOP_TO_FK5 = [
  1.000000000000, 0.000000440360, -0.000000190919,
  -0.000000479966, 0.917482137087, -0.397776982902,
  0.000000000000, 0.397776982902, 0.917482137087,
];

/** ICRF/J2000 equatorial → ecliptic J2000 (Horizons frame): active R_x(−ε76). */
export const EQ_TO_ECL = rotX(-EPS76_RAD);
/** Ecliptic J2000 → ICRF/J2000 equatorial: active R_x(+ε76). */
export const ECL_TO_EQ = rotX(+EPS76_RAD);
/**
 * VSOP87A frame → scene (ICRF-based ecliptic J2000). Numeric value (row-major):
 *   [ 1.000000000000000,  0.000000440360000, −0.000000190919000 ]
 *   [−0.000000440360195,  1.000000000000155,  0.000000188592216 ]
 *   [ 0.000000190919510, −0.000000188592216,  1.000000000000155 ]
 * i.e. a rotation of ≈ (−0.039″, −0.039″, −0.091″).
 */
export const M_VSOP_TO_ECL = mat3Mul(EQ_TO_ECL, M_VSOP_TO_FK5);

/** @param {ArrayLike<number>} v VSOP87A vector @param {number[]} [out] @returns {number[]} scene-frame vector */
export function vsopToEcliptic(v, out) {
  return mat3Apply(M_VSOP_TO_ECL, v, out);
}

/** @param {ArrayLike<number>} v ICRF equatorial @param {number[]} [out] @returns {number[]} ecliptic J2000 */
export function equatorialToEcliptic(v, out) {
  return mat3Apply(EQ_TO_ECL, v, out);
}

/** @param {ArrayLike<number>} v ecliptic J2000 @param {number[]} [out] @returns {number[]} ICRF equatorial */
export function eclipticToEquatorial(v, out) {
  return mat3Apply(ECL_TO_EQ, v, out);
}

/**
 * IAU 1976 precession angles (Lieske et al. 1977; Meeus 21.2), J2000 → mean equator/equinox of date.
 * @param {number} T Julian centuries TT from J2000
 * @returns {{zeta:number, z:number, theta:number}} radians
 */
export function precessionAngles(T) {
  const T2 = T * T, T3 = T2 * T;
  const zeta = (2306.2181 * T + 0.30188 * T2 + 0.017998 * T3) / ARCSEC_PER_RAD;
  const z = (2306.2181 * T + 1.09468 * T2 + 0.018203 * T3) / ARCSEC_PER_RAD;
  const theta = (2004.3109 * T - 0.42665 * T2 - 0.041833 * T3) / ARCSEC_PER_RAD;
  return { zeta, z, theta };
}

/**
 * Precession matrix P(T) = R_z(z)·R_y(−θ)·R_z(ζ) mapping J2000 equatorial vectors to the mean equator and equinox
 * of date (the J2000 equinox lands at RA ≈ ζ + z of date).
 * @param {number} T Julian centuries TT from J2000
 * @returns {number[]} 3×3 row-major
 */
export function precessionMatrix(T) {
  const { zeta, z, theta } = precessionAngles(T);
  return mat3Mul(rotZ(z), mat3Mul(rotY(-theta), rotZ(zeta)));
}

/** @param {number} jdTT @returns {number} Julian centuries from J2000 */
export function centuriesFromJ2000(jdTT) {
  return (jdTT - J2000) / DAYS_PER_CENTURY;
}

/**
 * Small-rotation vector of a near-identity rotation matrix (for tests): M ≈ I + [w]×.
 * @param {ArrayLike<number>} M @returns {number[]} radians
 */
export function rotationVector(M) {
  return [(M[7] - M[5]) / 2, (M[2] - M[6]) / 2, (M[3] - M[1]) / 2];
}
