// The fixed sky, pure: catalogue star directions in the SCENE frame, the galactic reference frame, star colour from
// B−V, and the display laws (magnitude → point size / intensity) the renderer applies to every point source.
// No DOM, no three.js; the render layer receives only typed arrays built here (main.js: createSkyData() → createScene).
//
// Frame: the scene frame is the Horizons "Ecliptic of J2000.0" (CLAUDE.md), an inertial frame, so star directions
// are constant: the catalogue's ICRS/J2000 positions are rotated once by EQ_TO_ECL and never precessed (precession
// moves the equinox, not the stars). Proper motion is neglected: the fastest bright star in the catalogue, Arcturus
// (2.28″/yr, BSC5 / Hipparcos), drifts 0.32° over the app's ±500-year span, below the size of a rendered point.
//
// Sources:
//  - Positions, V and B−V: Yale Bright Star Catalogue 5th rev. ed. (Hoffleit & Warren 1991), data/stars.js (generated).
//  - Galactic frame: IAU 1958 definition (Blaauw et al. 1960, MNRAS 121, 123) expressed in J2000 equatorial
//    coordinates by Reid & Brunthaler 2004, ApJ 616, 872, §2: north galactic pole α = 12h51m26.282s,
//    δ = +27°07′42.01″ (192.85948°, +27.12825°); galactic centre α = 17h45m37.224s, δ = −28°56′10.23″
//    (266.40499°, −28.93617°). These are the values adopted by astropy.coordinates.Galactic.
//  - Colour: Ballesteros, F. J. (2012), "New insights into black bodies", EPL 97, 34008, eq. 14:
//    T = 4600 K · [1/(0.92 (B−V) + 1.7) + 1/(0.92 (B−V) + 0.62)]  (±≈5 % for −0.4 ≤ B−V ≤ 2.0; T(0.65) = 5778 K).
//    Temperature → sRGB: T. Helland's fit (2012, https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html)
//    to M. Charity's CIE 1931 → sRGB black-body table (http://www.vendian.org/mncharity/dir3/blackbody/).
//  - Brightness: Pogson's ratio, I₁/I₂ = 10^(−0.4 (m₁ − m₂)) (Pogson 1856, MNRAS 17, 12; Allen's Astrophysical
//    Quantities 4th ed. §15.1).

import { STARS, STAR_COUNT, STAR_STRIDE, STAR_NAMES } from './data/stars.js';
import { EQ_TO_ECL } from './frames.js';
import { DEG } from './constants.js';
import { mat3Apply, cross, normalize, dot } from './vec.js';

// --- galactic frame ----------------------------------------------------------------------------------------------

/** J2000 equatorial coordinates of the north galactic pole (Reid & Brunthaler 2004, §2), degrees. */
export const GALACTIC_POLE_EQ_DEG = Object.freeze({ raDeg: 192.85948, decDeg: 27.12825 });
/** J2000 equatorial coordinates of the galactic centre direction, l = b = 0 (Reid & Brunthaler 2004, §2), degrees. */
export const GALACTIC_CENTRE_EQ_DEG = Object.freeze({ raDeg: 266.40499, decDeg: -28.93617 });

/**
 * Unit vector from right ascension / declination (any equatorial frame).
 * @param {number} raDeg @param {number} decDeg @param {number[]} [out] @returns {number[]}
 */
export function unitFromRaDec(raDeg, decDeg, out = [0, 0, 0]) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const c = Math.cos(dec);
  out[0] = c * Math.cos(ra);
  out[1] = c * Math.sin(ra);
  out[2] = Math.sin(dec);
  return out;
}

/** North galactic pole, unit vector in the scene (ecliptic J2000) frame. */
export const GALACTIC_POLE_ECL = Object.freeze(
  mat3Apply(EQ_TO_ECL, unitFromRaDec(GALACTIC_POLE_EQ_DEG.raDeg, GALACTIC_POLE_EQ_DEG.decDeg)),
);
/**
 * Galactic centre direction (l = 0, b = 0), unit vector in the scene frame. The two published directions are
 * perpendicular to 1e-7 rad (rounding of the quoted coordinates); the component along the pole is removed so the
 * basis (centre, pole × centre, pole) is exactly orthonormal and right-handed.
 */
export const GALACTIC_CENTRE_ECL = Object.freeze((() => {
  const c = mat3Apply(EQ_TO_ECL, unitFromRaDec(GALACTIC_CENTRE_EQ_DEG.raDeg, GALACTIC_CENTRE_EQ_DEG.decDeg));
  const k = dot(c, GALACTIC_POLE_ECL);
  return normalize([c[0] - k * GALACTIC_POLE_ECL[0], c[1] - k * GALACTIC_POLE_ECL[1], c[2] - k * GALACTIC_POLE_ECL[2]]);
})());
/** Third galactic axis (l = 90°, b = 0) = pole × centre, unit vector in the scene frame. */
export const GALACTIC_Y_ECL = Object.freeze(normalize(cross(GALACTIC_POLE_ECL, GALACTIC_CENTRE_ECL)));

/**
 * Galactic longitude and latitude of a scene-frame direction.
 * @param {ArrayLike<number>} dirEcl unit vector, scene frame
 * @param {{ l: number, b: number }} [out]
 * @returns {{ l: number, b: number }} radians; l in (−π, π], b in [−π/2, π/2]
 */
export function galacticCoords(dirEcl, out = { l: 0, b: 0 }) {
  const x = dot(dirEcl, GALACTIC_CENTRE_ECL);
  const y = dot(dirEcl, GALACTIC_Y_ECL);
  const z = dot(dirEcl, GALACTIC_POLE_ECL);
  out.l = Math.atan2(y, x);
  out.b = Math.atan2(z, Math.hypot(x, y)); // atan2 form, never asin (CLAUDE.md: stable for small angles)
  return out;
}

/**
 * Scene-frame unit vector from galactic coordinates (inverse of galacticCoords).
 * @param {number} l radians @param {number} b radians @param {number[]} [out] @returns {number[]}
 */
export function dirFromGalactic(l, b, out = [0, 0, 0]) {
  const c = Math.cos(b);
  const x = c * Math.cos(l), y = c * Math.sin(l), z = Math.sin(b);
  out[0] = x * GALACTIC_CENTRE_ECL[0] + y * GALACTIC_Y_ECL[0] + z * GALACTIC_POLE_ECL[0];
  out[1] = x * GALACTIC_CENTRE_ECL[1] + y * GALACTIC_Y_ECL[1] + z * GALACTIC_POLE_ECL[1];
  out[2] = x * GALACTIC_CENTRE_ECL[2] + y * GALACTIC_Y_ECL[2] + z * GALACTIC_POLE_ECL[2];
  return out;
}

// --- colour --------------------------------------------------------------------------------------------------------

/** Range of B−V over which the Ballesteros fit is quoted; inputs are clamped to it. */
export const BV_MIN = -0.4;
export const BV_MAX = 2.0;

/**
 * Effective temperature from B−V (Ballesteros 2012, eq. 14). Returns 5778 K for the Sun's B−V = 0.65.
 * @param {number} bv
 * @returns {number} kelvin
 */
export function bvToTemperature(bv) {
  const c = Math.min(BV_MAX, Math.max(BV_MIN, bv));
  return 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
}

/**
 * Black-body colour in sRGB (0…1 per channel), T. Helland's piecewise fit to Charity's CIE→sRGB table.
 * Valid 1000–40000 K (clamped). Each channel is a log/power fit in t = T/100.
 * @param {number} kelvin
 * @param {number[]} [out]
 * @returns {number[]} [r, g, b] sRGB-encoded
 */
export function temperatureToSrgb(kelvin, out = [0, 0, 0]) {
  const t = Math.min(400, Math.max(10, kelvin / 100));
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  out[0] = Math.min(1, Math.max(0, r / 255));
  out[1] = Math.min(1, Math.max(0, g / 255));
  out[2] = Math.min(1, Math.max(0, b / 255));
  return out;
}

/**
 * sRGB electro-optical transfer function (IEC 61966-2-1): encoded value → linear light.
 * @param {number} s 0…1
 * @returns {number}
 */
export function srgbToLinear(s) {
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Star colour from B−V as LINEAR RGB chromaticity: the brightest channel is scaled to 1 so that brightness is
 * carried entirely by the magnitude law (Ballesteros temperature → Helland sRGB → linear).
 * @param {number} bv
 * @param {number[]|Float32Array} [out]
 * @returns {number[]|Float32Array} [r, g, b] linear, max channel = 1
 */
export function bvToRgb(bv, out = [0, 0, 0]) {
  const s = temperatureToSrgb(bvToTemperature(bv), _srgb);
  const r = srgbToLinear(s[0]), g = srgbToLinear(s[1]), b = srgbToLinear(s[2]);
  const peak = Math.max(r, g, b, 1e-6);
  out[0] = r / peak; out[1] = g / peak; out[2] = b / peak;
  return out;
}
const _srgb = [0, 0, 0];

// --- brightness ----------------------------------------------------------------------------------------------------

/**
 * Pogson's ratio: flux of a magnitude-m source relative to a magnitude-m0 source, 10^(−0.4 (m − m0)).
 * @param {number} m
 * @param {number} [m0=0]
 * @returns {number}
 */
export function magnitudeToIntensity(m, m0 = 0) {
  return Math.pow(10, -0.4 * (m - m0));
}

/**
 * Display law for catalogue stars (V from −1.5, Sirius, to 6.5, the naked-eye limit). A display cannot show the
 * 1585:1 flux range of that span, so both the rendered point size and its linear intensity are POWER LAWS of the
 * Pogson flux ratio f = 10^(−0.4 (m − 6.5)), with exponents chosen so that the faintest catalogue star is still drawn
 * (1.2 px, intensity 0.22) and the brightest reaches an HDR level the bloom pass picks up (5 px, 1.9):
 *   size = 1.2 px · f^0.194,  intensity = 0.22 · f^0.292   (f^0.68 for the total light, between Stevens' exponents
 * 0.33 (extended) and 0.5 (point-like) for perceived brightness — S. S. Stevens, Psychol. Rev. 64, 1957).
 * Stars fainter than 6.5 (procedural background) continue the law down to the 1 px floor.
 */
export const STAR_MAG_BRIGHT = -1.5;
export const STAR_MAG_FAINT = 6.5;
export const STAR_PX_MIN = 1.2;
export const STAR_PX_MAX = 5.0;
export const STAR_PX_FLOOR = 1.0;
export const STAR_INTENSITY_MIN = 0.22;
export const STAR_INTENSITY_MAX = 1.9;
const STAR_FLUX_RANGE = Math.pow(10, 0.4 * (STAR_MAG_FAINT - STAR_MAG_BRIGHT)); // 1584.9
const STAR_SIZE_EXP = Math.log(STAR_PX_MAX / STAR_PX_MIN) / Math.log(STAR_FLUX_RANGE);
const STAR_INTENSITY_EXP = Math.log(STAR_INTENSITY_MAX / STAR_INTENSITY_MIN) / Math.log(STAR_FLUX_RANGE);

/**
 * Rendered point diameter for a star of visual magnitude m (CSS px, before the device pixel ratio).
 * @param {number} m
 * @returns {number} 1.0 … 5.0
 */
export function starPointSizePx(m) {
  const f = magnitudeToIntensity(Math.max(STAR_MAG_BRIGHT, m), STAR_MAG_FAINT);
  return Math.max(STAR_PX_FLOOR, STAR_PX_MIN * Math.pow(f, STAR_SIZE_EXP));
}

/**
 * Linear intensity multiplier for a star of visual magnitude m (HDR > 1 for the brightest).
 * @param {number} m
 * @returns {number}
 */
export function starIntensity(m) {
  const f = magnitudeToIntensity(Math.max(STAR_MAG_BRIGHT, m), STAR_MAG_FAINT);
  return STAR_INTENSITY_MIN * Math.pow(f, STAR_INTENSITY_EXP);
}

// --- catalogue → scene frame -----------------------------------------------------------------------------------------

/**
 * @typedef {object} StarDirections
 * @property {Float32Array} dirs   N·3 unit vectors, scene frame (ecliptic J2000), brightest first
 * @property {Float32Array} mags   V magnitude per star
 * @property {Float32Array} bv     B−V per star (0.6 where the catalogue has none)
 * @property {Record<number, string>} names  star index → IAU proper name
 * @property {number} count
 */

/**
 * Catalogue stars as unit vectors in the scene frame.
 * @param {{ count?: number }} [opts] count: take only the N brightest (default: all 8 404)
 * @returns {StarDirections}
 */
export function starDirectionsEcliptic({ count = STAR_COUNT } = {}) {
  const n = Math.max(0, Math.min(STAR_COUNT, count | 0));
  const dirs = new Float32Array(n * 3);
  const mags = new Float32Array(n);
  const bv = new Float32Array(n);
  const v = [0, 0, 0];
  const e = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * STAR_STRIDE;
    unitFromRaDec(STARS[o], STARS[o + 1], v);
    mat3Apply(EQ_TO_ECL, v, e);
    dirs[i * 3] = e[0]; dirs[i * 3 + 1] = e[1]; dirs[i * 3 + 2] = e[2];
    mags[i] = STARS[o + 2];
    bv[i] = STARS[o + 3];
  }
  /** @type {Record<number, string>} */
  const names = {};
  for (const k of Object.keys(STAR_NAMES)) {
    const i = Number(k);
    if (i < n) names[i] = STAR_NAMES[k];
  }
  return { dirs, mags, bv, names, count: n };
}

/**
 * mulberry32 — small seeded PRNG (Tommy Ettinger, public domain; https://gist.github.com/tommyettinger/46a874533244883189143505d203312c).
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural background defaults: count, magnitude span and the share concentrated toward the galactic plane. */
export const BACKGROUND_COUNT = 6000;
export const BACKGROUND_MAG_MAX = 8.0;
/** Fraction of background stars drawn from a Gaussian in galactic latitude (σ below) rather than uniformly. */
export const BACKGROUND_PLANE_FRACTION = 0.5;
/** σ of that latitude distribution, radians (≈ the visual half-width of the Milky Way band). */
export const BACKGROUND_PLANE_SIGMA = 15 * DEG;

/**
 * @typedef {object} SkyData
 * @property {Float32Array} dirs   N·3 unit vectors (scene frame), catalogue stars first, then the background
 * @property {Float32Array} mags   V (catalogue) or synthetic V in [6.5, 8] (background)
 * @property {Float32Array} bv
 * @property {Float32Array} sizes  point diameter per star, CSS px (starPointSizePx)
 * @property {Float32Array} rgb    N·3 linear RGB × intensity (bvToRgb · starIntensity), HDR for the brightest
 * @property {Record<number, string>} names
 * @property {number} count           total points
 * @property {number} catalogueCount  the first `catalogueCount` points are BSC5 stars
 * @property {number[]} galPole       GALACTIC_POLE_ECL
 * @property {number[]} galCentre     GALACTIC_CENTRE_ECL
 * @property {number[]} galY          GALACTIC_Y_ECL
 */

/**
 * Everything the renderer needs for the sky, in one bundle (the contract object for createScene({ sky })): the
 * catalogue with precomputed display sizes/colours, a seeded procedural background of fainter points (V 6.5–8,
 * half of them concentrated toward the galactic plane) for density, and the galactic basis for the Milky Way shader.
 * @param {{ background?: number, seed?: number, count?: number }} [opts]
 * @returns {SkyData}
 */
export function createSkyData({ background = BACKGROUND_COUNT, seed = 42, count = STAR_COUNT } = {}) {
  const cat = starDirectionsEcliptic({ count });
  const nb = Math.max(0, background | 0);
  const n = cat.count + nb;
  const dirs = new Float32Array(n * 3);
  const mags = new Float32Array(n);
  const bv = new Float32Array(n);
  dirs.set(cat.dirs);
  mags.set(cat.mags);
  bv.set(cat.bv);

  const rng = mulberry32(seed);
  const d = [0, 0, 0];
  for (let i = cat.count; i < n; i++) {
    if (rng() < BACKGROUND_PLANE_FRACTION) {
      // Box–Muller normal deviate for the latitude; longitude uniform
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      const b = BACKGROUND_PLANE_SIGMA * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      dirFromGalactic(2 * Math.PI * rng() - Math.PI, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, b)), d);
    } else {
      // uniform on the sphere
      const z = 2 * rng() - 1;
      const phi = 2 * Math.PI * rng();
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      d[0] = r * Math.cos(phi); d[1] = r * Math.sin(phi); d[2] = z;
    }
    dirs[i * 3] = d[0]; dirs[i * 3 + 1] = d[1]; dirs[i * 3 + 2] = d[2];
    // more faint than bright: V = 6.5 + 1.5·u^0.6 puts ~70 % of the points fainter than V 7.2
    mags[i] = STAR_MAG_FAINT + (BACKGROUND_MAG_MAX - STAR_MAG_FAINT) * Math.pow(rng(), 0.6);
    bv[i] = 0.0 + 1.4 * rng(); // A to K colours
  }

  const sizes = new Float32Array(n);
  const rgb = new Float32Array(n * 3);
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    sizes[i] = starPointSizePx(mags[i]);
    const k = starIntensity(mags[i]);
    bvToRgb(bv[i], c);
    rgb[i * 3] = c[0] * k; rgb[i * 3 + 1] = c[1] * k; rgb[i * 3 + 2] = c[2] * k;
  }
  return {
    dirs, mags, bv, sizes, rgb,
    names: cat.names,
    count: n,
    catalogueCount: cat.count,
    galPole: GALACTIC_POLE_ECL.slice(),
    galCentre: GALACTIC_CENTRE_ECL.slice(),
    galY: GALACTIC_Y_ECL.slice(),
  };
}
