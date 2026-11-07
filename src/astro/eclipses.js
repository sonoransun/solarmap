// Solar and lunar eclipse geometry from the shadow axis — the Besselian picture of the Explanatory Supplement to the
// Astronomical Almanac (3rd ed. 2013, ch. 11 "Eclipses of the Sun and Moon") with the classification limits and
// magnitude definitions of Meeus, Astronomical Algorithms 2nd ed. ch. 54 "Eclipses" (pp. 379–383). Meeus derives γ and
// u from a mean-phase series; here both come straight from the ephemeris vectors, so the same geometry serves the
// events scan (events.js finds the minimum of the axis distance around each new/full Moon) and the UI.
//
// Solar eclipse (shadow of the Moon on the Earth). With the Sun at the origin, the Earth's heliocentric position E and
// the Moon's geocentric position m (both at time t), the shadow axis is the line from the Sun through the Moon as it was
// τ = |m|/c ≈ 1.3 s earlier (M = E + m − τ(V_E + v_m); the Earth and the Moon both travel ≈ 39 km in that time, so the
// surviving effect is the Moon's 1.3 km of geocentric motion: ≈ 0.001 Earth radii in γ, test/eclipses.test.mjs).
// The fundamental plane is the plane through the Earth's centre perpendicular to the axis direction a = M/|M|:
//   γ  = signed distance of the axis from the Earth's centre in the fundamental plane, in Earth equatorial radii,
//        positive when the axis passes north of the centre (Meeus p. 381; "north" = the Earth's equatorial north
//        projected on the plane, the Besselian y-axis);
//   z  = distance from the Moon to the fundamental plane along the axis (≈ 60 Earth radii);
//   l₁ = (R☾ + z tan f₂)/R⊕, radius of the penumbral cone in the plane,  sin f₂ = (R☉ + R☾)/|M|;
//   u  = l₂ = (z tan f₁ − R☾)/R⊕, Besselian radius of the umbral cone in the plane, sin f₁ = (R☉ − R☾)/|M|: NEGATIVE
//        when the plane cuts the real umbra (the Moon's disc can cover the Sun → total), positive beyond the vertex
//        (annular). Meeus's u is this quantity (p. 381, "u < 0: total").
//   ω  = tan f₁ · √(1 − γ²): how much closer the surface point under the axis is to the Moon than the plane, in the
//        same units (Meeus's 0.00464 √(1 − γ²); tan f₁ ≈ 0.00464).
// Classification (Meeus pp. 381–382): |γ| ≥ 0.9972 + l₁ → no eclipse (Meeus writes the partial limit as 1.5433 + u,
// i.e. 0.9972 + l₁ with l₁ ≈ 0.5461 + u); |γ| < 0.9972 → central: total if u < 0, annular if u > ω, annular–total
// ("hybrid") otherwise; 0.9972 ≤ |γ| < 0.9972 + |u| → non-central total/annular; else partial. The 0.9972 is the
// Earth's radius in the fundamental plane averaged over the flattening. Magnitude of a partial eclipse (Meeus p. 382):
// (1.5433 + u − |γ|)/(0.5461 + 2u) = (0.9972 + l₁ − |γ|)/(l₁ + u); of a central eclipse: the ratio of the Moon's to the
// Sun's apparent diameter from the surface point under the axis (R☾/d☾)/(R☉/d☉).
//
// Lunar eclipse (shadow of the Earth on the Moon). The axis is the line from the Sun through the Earth's centre as it
// was τ earlier (E_ret = E − τ V_E), direction a = E_ret/|E_ret|; the Moon's offset from the axis d⃗ = m′ − (m′·a)a with
// m′ = E + m − E_ret, and γ = ±|d⃗|/R⊕, positive when the Moon passes north of the axis. At the Moon's distance along
// the axis x = m′·a the shadow radii are, with the Earth's radius enlarged by 1/85 for its atmosphere (Danjon's rule,
// the convention of the NASA eclipse publications: Espenak & Meeus, Five Millennium Canon of Lunar Eclipses, NASA/TP-
// 2009-214172 §1.4; Meeus's 1.2848/0.7403 constants use the older 2 % rule):
//   penumbra ρ = (R′ + x tan f₂)/R⊕,  sin f₂ = (R☉ + R′)/|E_ret|;   umbra σ = (R′ − x tan f₁)/R⊕,  sin f₁ = (R☉ − R′)/|E_ret|
// and the magnitudes (Meeus p. 382 with k = R☾/R⊕): penumbral (ρ + k − |γ|)/(2k), umbral (σ + k − |γ|)/(2k); total if the
// umbral magnitude ≥ 1, partial if > 0, penumbral if the penumbral magnitude > 0.
//
// Reference values (NASA GSFC Five Millennium Canon pages, https://eclipse.gsfc.nasa.gov/SEcat5/SE2001-2100.html and
// LEcat5/LE2001-2100.html) are compared in test/eclipses.test.mjs: γ to 0.02 (measured ≤ 0.004), instants to 6 min.
// All functions are allocation-free with `out`; vectors are plain numbers in the scene frame (AU, AU/day).
import { AU_KM, SUN_RADIUS_KM, C_AU_DAY, RAD } from './constants.js';
import { EQ_TO_ECL } from './frames.js';
import { body } from './bodies.js';
import { MOON } from './moon.js';

/** Earth's equatorial radius, km (IAU 2015 / pck00011, bodies.js) — the Besselian unit (NASA: 6378.137). */
export const EARTH_RADIUS_KM = body('earth').radiusEqKm;
/** Moon's radius in Earth radii, k = 1737.4/6378.1366 = 0.27240 (NASA uses k = 0.2725076 for lunar eclipses). */
export const MOON_RADIUS_ER = MOON.radiusKm / EARTH_RADIUS_KM;
/** Danjon's enlargement of the Earth's shadow for the atmosphere: radius × (1 + 1/85) (Espenak & Meeus 2009 §1.4). */
export const DANJON_ENLARGEMENT = 1 / 85;
/** Meeus p. 381: |γ| below this the solar eclipse is central (Earth's radius in the fundamental plane with flattening). */
export const CENTRAL_LIMIT = 0.9972;

/** Earth's equatorial north pole in the scene frame: EQ_TO_ECL · (0, 0, 1) = (0, sin ε, cos ε). */
const NORTH = [EQ_TO_ECL[2], EQ_TO_ECL[5], EQ_TO_ECL[8]];
const SUN_RADIUS_AU = SUN_RADIUS_KM / AU_KM;
const MOON_RADIUS_AU = MOON.radiusKm / AU_KM;
const EARTH_RADIUS_AU = EARTH_RADIUS_KM / AU_KM;

/** @typedef {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} State */

/**
 * @typedef {object} SolarEclipseGeometry
 * @property {number} gamma signed axis distance from the Earth's centre, Earth radii (+ north)
 * @property {number} axisDistanceEr |γ|
 * @property {number} u Besselian umbral radius l₂ in the fundamental plane (negative = real umbra reaches the plane)
 * @property {number} l1 penumbral radius in the fundamental plane, Earth radii
 * @property {number} omega surface correction tan f₁ √(1 − γ²) (0 when |γ| ≥ 1)
 * @property {number} zEr Moon → fundamental plane distance along the axis, Earth radii
 * @property {number} moonDistKm geocentric distance of the Moon
 * @property {number} sunDistAu heliocentric distance of the Earth
 * @property {number} moonDiameterArcmin apparent lunar diameter from the Earth's centre
 * @property {number} sunDiameterArcmin apparent solar diameter from the Earth's centre
 */

/** @returns {SolarEclipseGeometry} */
export function newSolarGeometry() {
  return { gamma: 0, axisDistanceEr: 0, u: 0, l1: 0, omega: 0, zEr: 0, moonDistKm: 0, sunDistAu: 0, moonDiameterArcmin: 0, sunDiameterArcmin: 0 };
}

/**
 * Shadow-axis geometry of a (possible) solar eclipse at one instant (module header, "Solar eclipse").
 * @param {State} E heliocentric Earth state (AU, AU/day, scene frame)
 * @param {State} m geocentric Moon state (AU, AU/day)
 * @param {SolarEclipseGeometry} [out]
 * @returns {SolarEclipseGeometry}
 */
export function solarEclipseGeometry(E, m, out = newSolarGeometry()) {
  const mDist = Math.hypot(m.x, m.y, m.z);
  const tau = mDist / C_AU_DAY;
  // Retarded heliocentric Moon: M = E + m − τ (V_E + v_m)
  const Mx = E.x + m.x - tau * (E.vx + m.vx), My = E.y + m.y - tau * (E.vy + m.vy), Mz = E.z + m.z - tau * (E.vz + m.vz);
  const Mlen = Math.hypot(Mx, My, Mz);
  const ax = Mx / Mlen, ay = My / Mlen, az = Mz / Mlen;
  // Foot of the perpendicular from E on the axis (through the origin): F = (E·a) a; offset d⃗ = F − E
  const Ea = E.x * ax + E.y * ay + E.z * az;
  const dx = Ea * ax - E.x, dy = Ea * ay - E.y, dz = Ea * az - E.z;
  const dist = Math.hypot(dx, dy, dz);
  // North direction in the fundamental plane: ŷ ∝ N − (N·a) a
  const Na = NORTH[0] * ax + NORTH[1] * ay + NORTH[2] * az;
  const yx = NORTH[0] - Na * ax, yy = NORTH[1] - Na * ay, yz = NORTH[2] - Na * az;
  const sign = dx * yx + dy * yy + dz * yz >= 0 ? 1 : -1;
  const gamma = sign * dist / EARTH_RADIUS_AU;
  // Moon → fundamental plane along the axis: z = (E − M)·a = E·a − |M|
  const z = Ea - Mlen;
  const sinF1 = (SUN_RADIUS_AU - MOON_RADIUS_AU) / Mlen, sinF2 = (SUN_RADIUS_AU + MOON_RADIUS_AU) / Mlen;
  const tanF1 = sinF1 / Math.sqrt(1 - sinF1 * sinF1), tanF2 = sinF2 / Math.sqrt(1 - sinF2 * sinF2);
  out.gamma = gamma;
  out.axisDistanceEr = Math.abs(gamma);
  out.u = (z * tanF1 - MOON_RADIUS_AU) / EARTH_RADIUS_AU;
  out.l1 = (MOON_RADIUS_AU + z * tanF2) / EARTH_RADIUS_AU;
  out.omega = Math.abs(gamma) < 1 ? tanF1 * Math.sqrt(1 - gamma * gamma) : 0;
  out.zEr = z / EARTH_RADIUS_AU;
  out.moonDistKm = mDist * AU_KM;
  out.sunDistAu = Math.hypot(E.x, E.y, E.z);
  out.moonDiameterArcmin = 2 * Math.asin(MOON_RADIUS_AU / mDist) * RAD * 60;
  out.sunDiameterArcmin = 2 * Math.asin(SUN_RADIUS_AU / out.sunDistAu) * RAD * 60;
  return out;
}

/**
 * Solar eclipse type from the geometry (Meeus pp. 381–382; module header).
 * @param {SolarEclipseGeometry} g
 * @returns {'total'|'annular'|'hybrid'|'partial'|null} null = the penumbra misses the Earth
 */
export function classifySolar(g) {
  const ag = Math.abs(g.gamma);
  if (ag >= CENTRAL_LIMIT + g.l1) return null;
  if (ag < CENTRAL_LIMIT) {
    if (g.u < 0) return 'total';
    if (g.u > g.omega) return 'annular';
    return 'hybrid';
  }
  if (ag < CENTRAL_LIMIT + Math.abs(g.u)) return g.u < 0 ? 'total' : 'annular'; // non-central
  return 'partial';
}

/** @param {SolarEclipseGeometry} g @returns {boolean} the axis meets the Earth (|γ| < 0.9972) */
export function isCentral(g) {
  return Math.abs(g.gamma) < CENTRAL_LIMIT;
}

/**
 * Magnitude of a solar eclipse at greatest eclipse: partial → (0.9972 + l₁ − |γ|)/(l₁ + u) (Meeus p. 382, the fraction
 * of the Sun's diameter covered at the point of greatest eclipse); central or non-central total/annular → the ratio of
 * the Moon's to the Sun's apparent diameter from the surface point under the axis (d☾ = z − √(1 − γ²) R⊕ along the
 * axis, |γ| clamped to 1), > 1 for total, < 1 for annular.
 * @param {SolarEclipseGeometry} g
 * @returns {number} NaN when there is no eclipse
 */
export function solarMagnitude(g) {
  const type = classifySolar(g);
  if (type === null) return NaN;
  if (type === 'partial') return (CENTRAL_LIMIT + g.l1 - Math.abs(g.gamma)) / (g.l1 + g.u);
  const h = Math.sqrt(Math.max(0, 1 - g.gamma * g.gamma)); // Earth radii
  const dMoonAu = (g.zEr - h) * EARTH_RADIUS_AU;
  const dSunAu = g.sunDistAu - h * EARTH_RADIUS_AU;
  return (MOON_RADIUS_AU / dMoonAu) / (SUN_RADIUS_AU / dSunAu);
}

/**
 * @typedef {object} LunarEclipseGeometry
 * @property {number} gamma signed distance of the Moon's centre from the shadow axis, Earth radii (+ north)
 * @property {number} axisDistanceEr |γ|
 * @property {number} penumbraRadiusEr ρ at the Moon's distance (Danjon-enlarged)
 * @property {number} umbraRadiusEr σ at the Moon's distance (Danjon-enlarged)
 * @property {number} penumbralMagnitude (ρ + k − |γ|)/(2k)
 * @property {number} umbralMagnitude (σ + k − |γ|)/(2k)
 * @property {number} moonDistKm geocentric distance of the Moon
 * @property {number} sunDistAu heliocentric distance of the Earth
 */

/** @returns {LunarEclipseGeometry} */
export function newLunarGeometry() {
  return { gamma: 0, axisDistanceEr: 0, penumbraRadiusEr: 0, umbraRadiusEr: 0, penumbralMagnitude: 0, umbralMagnitude: 0, moonDistKm: 0, sunDistAu: 0 };
}

/**
 * Shadow-axis geometry of a (possible) lunar eclipse at one instant (module header, "Lunar eclipse").
 * @param {State} E heliocentric Earth state
 * @param {State} m geocentric Moon state
 * @param {LunarEclipseGeometry} [out]
 * @returns {LunarEclipseGeometry}
 */
export function lunarEclipseGeometry(E, m, out = newLunarGeometry()) {
  const mDist = Math.hypot(m.x, m.y, m.z);
  const tau = mDist / C_AU_DAY;
  // Retarded Earth defines the axis; the Moon's offset from the retarded Earth is m′ = m + τ V_E
  const Ex = E.x - tau * E.vx, Ey = E.y - tau * E.vy, Ez = E.z - tau * E.vz;
  const Elen = Math.hypot(Ex, Ey, Ez);
  const ax = Ex / Elen, ay = Ey / Elen, az = Ez / Elen;
  const mx = m.x + tau * E.vx, my = m.y + tau * E.vy, mz = m.z + tau * E.vz;
  const x = mx * ax + my * ay + mz * az; // along the axis, beyond the Earth
  const dx = mx - x * ax, dy = my - x * ay, dz = mz - x * az;
  const dist = Math.hypot(dx, dy, dz);
  const Na = NORTH[0] * ax + NORTH[1] * ay + NORTH[2] * az;
  const yx = NORTH[0] - Na * ax, yy = NORTH[1] - Na * ay, yz = NORTH[2] - Na * az;
  const sign = dx * yx + dy * yy + dz * yz >= 0 ? 1 : -1;
  const gamma = sign * dist / EARTH_RADIUS_AU;
  const Rp = EARTH_RADIUS_AU * (1 + DANJON_ENLARGEMENT);
  const sinF1 = (SUN_RADIUS_AU - Rp) / Elen, sinF2 = (SUN_RADIUS_AU + Rp) / Elen;
  const tanF1 = sinF1 / Math.sqrt(1 - sinF1 * sinF1), tanF2 = sinF2 / Math.sqrt(1 - sinF2 * sinF2);
  const rho = (Rp + x * tanF2) / EARTH_RADIUS_AU, sigma = (Rp - x * tanF1) / EARTH_RADIUS_AU;
  const k = MOON_RADIUS_ER;
  out.gamma = gamma;
  out.axisDistanceEr = Math.abs(gamma);
  out.penumbraRadiusEr = rho;
  out.umbraRadiusEr = sigma;
  out.penumbralMagnitude = (rho + k - Math.abs(gamma)) / (2 * k);
  out.umbralMagnitude = (sigma + k - Math.abs(gamma)) / (2 * k);
  out.moonDistKm = mDist * AU_KM;
  out.sunDistAu = Math.hypot(E.x, E.y, E.z);
  return out;
}

/**
 * Lunar eclipse type: total (umbral magnitude ≥ 1), partial (> 0), penumbral (penumbral magnitude > 0), else null.
 * @param {LunarEclipseGeometry} g
 * @returns {'total'|'partial'|'penumbral'|null}
 */
export function classifyLunar(g) {
  if (g.umbralMagnitude >= 1) return 'total';
  if (g.umbralMagnitude > 0) return 'partial';
  if (g.penumbralMagnitude > 0) return 'penumbral';
  return null;
}
