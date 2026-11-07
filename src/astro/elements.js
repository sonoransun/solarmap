// Osculating (instantaneous two-body) orbital elements from a heliocentric state vector — the classical "RV2COE"
// conversion: Vallado, Fundamentals of Astrodynamics and Applications (4th ed. 2013) §2.5 Algorithm 9; Bate, Mueller &
// White, Fundamentals of Astrodynamics (1971) §2.4 ("Determining the orbital elements from r and v"); Meeus,
// Astronomical Algorithms ch. 30 (Kepler's equation) for E ↔ M. Frame: whatever the input is in — here the scene frame
// (Horizons "Ecliptic of J2000.0"), so Ω is measured from the ICRF-based J2000 equinox along the J2000 ecliptic, as in a
// Horizons ELEMENTS table with REF_PLANE='ECLIPTIC' (test/fixtures/horizons/elements.json).
//
// Formulas (μ = GM of the Sun unless `mu` is given; r, v in AU and AU/day):
//   h = r × v                                   specific angular momentum;      p = h²/μ
//   n = ẑ × h = (−h_y, h_x, 0)                  node vector
//   e⃗ = ((v² − μ/r) r − (r·v) v)/μ,  e = |e⃗|    eccentricity vector (toward perihelion)
//   ξ = v²/2 − μ/r,  a = −μ/(2ξ)                 specific energy, semi-major axis (ellipse: ξ < 0)
//   i = atan2(|h_xy|, h_z)                       inclination (never acos — CLAUDE.md)
//   Ω = atan2(n_y, n_x) = atan2(h_x, −h_y)       longitude of the ascending node
//   ω = atan2((n × e⃗)·ĥ, n·e⃗)                     argument of perihelion (signed angle about ĥ from the node to perihelion)
//   ν = atan2((e⃗ × r)·ĥ, e⃗·r)                     true anomaly
//   E = atan2(√(1−e²) sin ν, e + cos ν),  M = E − e sin E   (Vallado 2.9 / Meeus 30.1)
//   n̄ = √(μ/a³),  P = 2π/n̄,  T_p = t − M/n̄        mean motion, period, time of perihelion passage (the one before t)
//   q = a(1 − e),  Q = a(1 + e),  ϖ = Ω + ω,  L = ϖ + M (mean longitude)
// Near-circular or equatorial orbits make ω / Ω individually ill-conditioned (|e| → 0, |n| → 0) but ϖ, L and ν + ω
// stay well defined; the planets have e ≥ 0.0068 and i ≥ 0.77° (Earth: i ≈ 0.0003° — Ω jitters at the 0.01° level
// for the Earth, as it does in Horizons' own table).
import { AU_KM, DAY_S, GM_SUN_KM3_S2, RAD } from './constants.js';
import { body } from './bodies.js';

/**
 * Heliocentric gravitational constant in AU³/day²: GM☉ (DE440, km³/s², constants.js) × 86400² / AU_KM³
 * = 2.959122082841195e-4 (the Gaussian value k² = 2.959122082855911e-4 differs in the 11th digit).
 */
export const GM_SUN_AU3_D2 = GM_SUN_KM3_S2 * DAY_S * DAY_S / (AU_KM * AU_KM * AU_KM);

/**
 * Two-body gravitational parameter of a body's heliocentric orbit, μ = GM☉ + GM(body), in AU³/day² — the convention of
 * the Horizons ELEMENTS tables ("Keplerian GM": Mars barycentre 2.9591230378e-4, Jupiter barycentre 2.9619474286e-4,
 * test/fixtures/horizons/elements.json), i.e. the relative two-body problem of the Sun and the planet (system GM for
 * Mars–Neptune, bodies.js/DE440). With GM☉ alone Jupiter's osculating a would be 5e-3 AU and ω 1° off (test).
 * @param {string} id 'sun' (→ GM☉) or any bodies.js id
 * @returns {number} AU³/day²
 */
export function muForBody(id) {
  if (id === 'sun') return GM_SUN_AU3_D2;
  return (GM_SUN_KM3_S2 + body(id).gmKm3S2) * DAY_S * DAY_S / (AU_KM * AU_KM * AU_KM);
}

/**
 * @typedef {object} OsculatingElements  angles in degrees ([0, 360) unless noted), lengths in AU, times in days / JD
 * @property {number} a semi-major axis (negative for a hyperbolic state)
 * @property {number} e eccentricity
 * @property {number} iDeg inclination to the reference plane, [0, 180]
 * @property {number} OmegaDeg longitude of the ascending node Ω
 * @property {number} omegaDeg argument of perihelion ω
 * @property {number} varpiDeg longitude of perihelion ϖ = Ω + ω
 * @property {number} MDeg mean anomaly
 * @property {number} EDeg eccentric anomaly
 * @property {number} nuDeg true anomaly
 * @property {number} LDeg mean longitude L = ϖ + M
 * @property {number} q perihelion distance a(1 − e)
 * @property {number} Q aphelion distance a(1 + e)
 * @property {number} p semi-latus rectum h²/μ
 * @property {number} h specific angular momentum |r × v| (AU²/day)
 * @property {number} rAu heliocentric distance
 * @property {number} vAuDay speed
 * @property {number} meanMotionDegPerDay n̄ = √(μ/a³) in °/day
 * @property {number} periodDays sidereal period 2π/n̄
 * @property {number} tPeriJd time of the perihelion passage preceding the epoch (JD, same scale as `jd`)
 * @property {number} jd epoch of the elements (as passed in)
 * @property {number} mu gravitational parameter used (AU³/day²)
 */

/** @returns {OsculatingElements} */
export function newElements() {
  return {
    a: 0, e: 0, iDeg: 0, OmegaDeg: 0, omegaDeg: 0, varpiDeg: 0, MDeg: 0, EDeg: 0, nuDeg: 0, LDeg: 0,
    q: 0, Q: 0, p: 0, h: 0, rAu: 0, vAuDay: 0, meanMotionDegPerDay: 0, periodDays: 0, tPeriJd: 0, jd: 0, mu: 0,
  };
}

/** @param {number} d degrees @returns {number} degrees in [0, 360) */
function wrap360(d) {
  const t = d % 360;
  return t < 0 ? t + 360 : t;
}

/**
 * Osculating elements of a heliocentric state (Vallado Algorithm 9; see the module header for every formula).
 * Allocation-free when `out` is supplied.
 * @param {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} state position AU, velocity AU/day, any
 *   inertial frame with the primary at the origin (scene frame → ecliptic elements)
 * @param {number} jd epoch of the state (JD; T_p comes out in the same scale)
 * @param {OsculatingElements} [out] reused result object
 * @param {number} [mu] gravitational parameter in AU³/day² (default GM_SUN_AU3_D2)
 * @returns {OsculatingElements}
 */
export function osculatingElements(state, jd, out = newElements(), mu = GM_SUN_AU3_D2) {
  const x = state.x, y = state.y, z = state.z, vx = state.vx, vy = state.vy, vz = state.vz;
  const r = Math.hypot(x, y, z);
  const v2 = vx * vx + vy * vy + vz * vz;
  const rv = x * vx + y * vy + z * vz;
  // h = r × v
  const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
  const h = Math.hypot(hx, hy, hz);
  // e⃗ = ((v² − μ/r) r − (r·v) v)/μ
  const c1 = v2 - mu / r;
  const ex = (c1 * x - rv * vx) / mu, ey = (c1 * y - rv * vy) / mu, ez = (c1 * z - rv * vz) / mu;
  const e = Math.hypot(ex, ey, ez);
  const xi = v2 / 2 - mu / r;
  const a = -mu / (2 * xi);
  const p = h * h / mu;
  // Unit angular momentum and the node vector n = ẑ × h = (−h_y, h_x, 0)
  const ux = hx / h, uy = hy / h, uz = hz / h;
  const nx = -hy, ny = hx;
  const iRad = Math.atan2(Math.hypot(hx, hy), hz);
  const OmegaRad = Math.atan2(ny, nx);
  // ω: signed angle from n to e⃗ about ĥ: atan2((n × e⃗)·ĥ, n·e⃗) with n × e⃗ = (ny ez, −nx ez, nx ey − ny ex)
  const omegaRad = Math.atan2((ny * ez) * ux + (-nx * ez) * uy + (nx * ey - ny * ex) * uz, nx * ex + ny * ey);
  // ν: signed angle from e⃗ to r about ĥ
  const cx = ey * z - ez * y, cy = ez * x - ex * z, cz = ex * y - ey * x; // e⃗ × r
  const nuRad = Math.atan2(cx * ux + cy * uy + cz * uz, ex * x + ey * y + ez * z);
  // E and M from ν (Vallado eq. 2-9: tan(E/2) = √((1−e)/(1+e)) tan(ν/2) ⇔ the atan2 form below), Kepler M = E − e sin E
  const ERad = Math.atan2(Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(nuRad), e + Math.cos(nuRad));
  let MRad = ERad - e * Math.sin(ERad);
  MRad -= 2 * Math.PI * Math.floor(MRad / (2 * Math.PI)); // [0, 2π): the perihelion passage preceding the epoch
  const nMean = Math.sqrt(mu / Math.abs(a * a * a));
  out.a = a;
  out.e = e;
  out.iDeg = iRad * RAD;
  out.OmegaDeg = wrap360(OmegaRad * RAD);
  out.omegaDeg = wrap360(omegaRad * RAD);
  out.varpiDeg = wrap360(out.OmegaDeg + out.omegaDeg);
  out.MDeg = MRad * RAD;
  out.EDeg = wrap360(ERad * RAD);
  out.nuDeg = wrap360(nuRad * RAD);
  out.LDeg = wrap360(out.varpiDeg + out.MDeg);
  out.q = a * (1 - e);
  out.Q = a * (1 + e);
  out.p = p;
  out.h = h;
  out.rAu = r;
  out.vAuDay = Math.sqrt(v2);
  out.meanMotionDegPerDay = nMean * RAD;
  out.periodDays = 2 * Math.PI / nMean;
  out.tPeriJd = jd - MRad / nMean;
  out.jd = jd;
  out.mu = mu;
  return out;
}

/**
 * Osculating heliocentric elements of a planet (or the Moon) from an ephemeris states snapshot, with the Horizons
 * two-body μ = GM☉ + GM(body) (muForBody) — the variant the Bodies tab shows.
 * @param {Record<string, {x:number, y:number, z:number, vx:number, vy:number, vz:number}>} S heliocentric states
 * @param {string} id planet id (or 'moon' when S.moon is present)
 * @param {number} jdTT epoch of the snapshot
 * @param {OsculatingElements} [out]
 * @returns {OsculatingElements}
 */
export function planetElements(S, id, jdTT, out = newElements()) {
  const s = S[id];
  if (s === undefined || id === 'sun') throw new RangeError(`elements: no heliocentric orbit for '${id}'`);
  return osculatingElements(s, jdTT, out, muForBody(id));
}

/**
 * Solve Kepler's equation M = E − e sin E for the eccentric anomaly (Meeus ch. 30, third method: Newton–Raphson
 * E₁ = E₀ + (M + e sin E₀ − E₀)/(1 − e cos E₀), started at E₀ = M, which converges quadratically for e < 0.99; the
 * radian form of keplerian.js solveKepler, kept here so the app never imports the test-only module).
 * @param {number} MRad mean anomaly, radians
 * @param {number} e eccentricity (0 ≤ e < 1)
 * @param {number} [tol] convergence threshold on |ΔE|, radians (default 1e-12 ≈ 2e-7″)
 * @returns {number} E in radians
 */
export function solveKeplerRad(MRad, e, tol = 1e-12) {
  let E = MRad;
  for (let k = 0; k < 60; k++) {
    const dE = (MRad + e * Math.sin(E) - E) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) <= tol) return E;
  }
  throw new RangeError(`solveKeplerRad: no convergence for M=${MRad}, e=${e}`);
}

/**
 * Inverse of osculatingElements for an elliptic orbit: heliocentric state from (a, e, i, Ω, ω, M) at the epoch of M
 * (Vallado Algorithm 10 "COE2RV": perifocal r = (a(cos E − e), a√(1−e²) sin E, 0), v = (√(μa)/r)(−sin E, √(1−e²) cos E, 0),
 * rotated by R_z(Ω)·R_x(i)·R_z(ω)). Used by the tests as a round-trip check and by the UI to draw an osculating ellipse.
 * @param {{a:number, e:number, iDeg:number, OmegaDeg:number, omegaDeg:number, MDeg:number}} el
 * @param {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} [out]
 * @param {number} [mu] AU³/day² (default GM_SUN_AU3_D2)
 * @returns {{x:number, y:number, z:number, vx:number, vy:number, vz:number}}
 */
export function stateFromElements(el, out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, mu = GM_SUN_AU3_D2) {
  const { a, e } = el;
  const E = solveKeplerRad(el.MDeg / RAD, e);
  const cE = Math.cos(E), sE = Math.sin(E), s1e = Math.sqrt(1 - e * e);
  const px = a * (cE - e), py = a * s1e * sE;
  const r = a * (1 - e * cE);
  const k = Math.sqrt(mu * a) / r;
  const pvx = -k * sE, pvy = k * s1e * cE;
  const cO = Math.cos(el.OmegaDeg / RAD), sO = Math.sin(el.OmegaDeg / RAD);
  const ci = Math.cos(el.iDeg / RAD), si = Math.sin(el.iDeg / RAD);
  const cw = Math.cos(el.omegaDeg / RAD), sw = Math.sin(el.omegaDeg / RAD);
  // R = R_z(Ω)·R_x(i)·R_z(ω) (active, vec.js conventions); only the first two columns act on (px, py, 0)
  const r00 = cO * cw - sO * ci * sw, r01 = -cO * sw - sO * ci * cw;
  const r10 = sO * cw + cO * ci * sw, r11 = -sO * sw + cO * ci * cw;
  const r20 = si * sw, r21 = si * cw;
  out.x = r00 * px + r01 * py; out.y = r10 * px + r11 * py; out.z = r20 * px + r21 * py;
  out.vx = r00 * pvx + r01 * pvy; out.vy = r10 * pvx + r11 * pvy; out.vz = r20 * pvx + r21 * pvy;
  return out;
}
