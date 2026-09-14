// Per-body physical table: Sun + the eight planets. Pure data (no imports beyond constants.js), consumed by
// orientation.js (IAU rotational elements), geometry.js, the renderer (radii, colours, rings, label priority) and the
// events/UI layers (Horizons ids, orbital periods).
//
// Sources (all values verbatim; see the constants research bhqes187e.txt for the fetched tables):
//  - Radii: IAU WGCCRE 2015 (Archinal et al. 2018, CMDA 130:22) shape table as encoded in NAIF pck00011.tpc
//    BODYnnn_RADII (a, b, c), https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc
//  - GM: JPL DE440 astrodynamic parameters, https://ssd.jpl.nasa.gov/astro_par.html (planet *system* GMs for
//    Mars–Neptune, as used by the Horizons barycentre ids 4–8)
//  - Sidereal orbit periods: NSSDC planetary fact sheets, https://nssdc.gsfc.nasa.gov/planetary/factsheet/<body>fact.html
//  - Rotational elements: IAU WGCCRE 2015 report Table 1 (pp. 8–9), identical in pck00011 (bhqes187e.txt §2)
//  - Saturn rings: NSSDC Saturnian rings fact sheet, https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html
//  - Colours: stylised (bhqes187e.txt §6, "representative", informed by NSSDC geometric albedo); not measured values
//  - Horizons ids: test/fixtures/README.md (199/299/399 planet centres, 4–8 system barycentres, 10 = Sun)
import { AU_KM, SUN_RADIUS_KM, GM_SUN_KM3_S2 } from './constants.js';

/**
 * @typedef {[number, number, number, 'd'|'T']} PeriodicTerm
 *   One IAU periodic term `amp · trig(arg0 + argRate · t)` in degrees: [amplitude°, arg0°, argRate, unit] with
 *   unit 'd' → t = d (days from J2000, rate in °/day) or 'T' → t = T (Julian centuries, rate in °/century).
 *   The trig function is fixed by the element, exactly as in the IAU table: sin for α0 and W, cos for δ0.
 */

/**
 * @typedef {object} IauRotation
 *   IAU WGCCRE 2015 rotational elements (degrees; T = Julian centuries, d = days from J2000.0 = JD 2451545.0 TDB).
 * @property {'iau'} model
 * @property {[number, number]} alpha0 [α0 at J2000 (°), rate (°/century)] — north pole right ascension (ICRF)
 * @property {[number, number]} delta0 [δ0 at J2000 (°), rate (°/century)] — north pole declination (ICRF)
 * @property {[number, number]} w [W at J2000 (°), Ẇ (°/day)] — prime meridian angle from the node Q = α0 + 90°
 * @property {{alpha0: PeriodicTerm[], delta0: PeriodicTerm[], w: PeriodicTerm[]}} [periodic] periodic terms (see PeriodicTerm)
 */

/**
 * @typedef {object} GmstRotation
 *   Earth: the 2015 IAU report gives no Earth expressions (footnote 2 refers users to the IERS); orientation.js uses
 *   GMST (IAU 1982) + IAU 1976 precession instead. Only the mean spin rate is tabulated here.
 * @property {'gmst'} model
 * @property {number} spinRateDegPerDay Ẇ = 360.98564736629 °/day (GMST linear coefficient, Meeus AA 12.4)
 */

/**
 * @typedef {object} Body
 * @property {string} id lower-case key ('sun', 'mercury', …)
 * @property {string} name display name
 * @property {number} horizonsId JPL Horizons COMMAND id used by scripts/fetch-horizons.mjs
 * @property {number} radiusEqKm equatorial radius a (km), IAU 2015 / pck00011
 * @property {number} radiusPolarKm polar radius c (km), IAU 2015 / pck00011
 * @property {number} gmKm3S2 GM (km³/s²), DE440
 * @property {number|null} siderealOrbitDays NSSDC sidereal orbit period (days); null for the Sun
 * @property {string} colour representative base colour (hex)
 * @property {string} accent representative secondary colour (hex)
 * @property {number} priority label overlap priority (plan §Labels: Sun 10 … Neptune 2; higher wins)
 * @property {IauRotation|GmstRotation} rotation
 * @property {SaturnRings} [rings]
 */

/**
 * @typedef {object} RingBand
 * @property {string} name
 * @property {number} innerKm inner edge radius from the planet centre (km)
 * @property {number} outerKm outer edge radius (km)
 * @property {'ring'|'gap'} kind
 * @property {[number, number]} opticalDepth NSSDC optical depth range (min, max)
 * @property {[number, number]|null} albedo NSSDC albedo range, null when not listed
 */

/**
 * @typedef {object} SaturnRings
 * @property {number} innerKm C ring inner edge (km)
 * @property {number} outerKm F ring radius (km) — outer extent to render
 * @property {RingBand[]} bands C, B, Cassini division, A (inside-out)
 * @property {{name: string, radiusKm: number}[]} gaps narrow gaps listed by NSSDC by inner-edge radius
 * @property {{name: string, radiusKm: number, opticalDepth: number, albedo: number}} fRing
 */

/**
 * Saturn's main rings, NSSDC (updated 19 April 2022): "Rings, ringlets and gaps of width less than 1000 km are listed
 * by inner edge radius." Radii in km from Saturn's centre (equator 60,268 km). D ring (66,900–74,510, τ 1e-5) and the
 * G/E rings (τ 1e-6) are omitted as invisible at rendering scale.
 * @type {SaturnRings}
 */
export const SATURN_RINGS = Object.freeze({
  innerKm: 74658,
  outerKm: 139826,
  bands: Object.freeze([
    Object.freeze({ name: 'C', innerKm: 74658, outerKm: 91975, kind: 'ring', opticalDepth: [0.05, 0.35], albedo: [0.12, 0.30] }),
    Object.freeze({ name: 'B', innerKm: 91975, outerKm: 117507, kind: 'ring', opticalDepth: [0.4, 2.5], albedo: [0.4, 0.6] }),
    Object.freeze({ name: 'Cassini division', innerKm: 117507, outerKm: 122340, kind: 'gap', opticalDepth: [0, 0.1], albedo: [0.2, 0.4] }),
    Object.freeze({ name: 'A', innerKm: 122340, outerKm: 136780, kind: 'ring', opticalDepth: [0.4, 1.0], albedo: [0.4, 0.6] }),
  ]),
  gaps: Object.freeze([
    Object.freeze({ name: 'Encke gap', radiusKm: 133410 }),
    Object.freeze({ name: 'Keeler gap', radiusKm: 136487 }),
  ]),
  fRing: Object.freeze({ name: 'F', radiusKm: 139826, opticalDepth: 0.1, albedo: 0.6 }),
});

/** Bodies in display order (Sun outward). */
export const BODY_IDS = Object.freeze(['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

/** The eight planets, Sun outward. */
export const PLANET_IDS = Object.freeze(BODY_IDS.slice(1));

/**
 * The body table. IAU 2015 rotational elements are transcribed VERBATIM from Archinal et al. 2018 Table 1
 * (bhqes187e.txt §2): "α0, δ0 are ICRF equatorial coordinates at epoch J2000.0 … T = Interval in Julian centuries
 * (36,525 days) from the standard epoch. d = Interval in days from the standard epoch. The standard epoch is
 * JD 2451545.0, i.e., 2000 January 1 12 h TDB." The north pole "is that pole of rotation that lies on the north side of
 * the invariable plane"; "If W increases with time, the planet has a direct (or prograde) rotation, and, if W
 * decreases with time, the rotation is said to be retrograde" — hence the NEGATIVE Ẇ of Venus and Uranus with
 * unflipped north poles.
 * @type {Readonly<Record<string, Body>>}
 */
export const BODIES = Object.freeze({
  sun: Object.freeze({
    id: 'sun',
    name: 'Sun',
    horizonsId: 10,
    radiusEqKm: SUN_RADIUS_KM, // 695700 (IAU 2015 B3 nominal; pck00011 BODY10_RADII)
    radiusPolarKm: SUN_RADIUS_KM,
    gmKm3S2: GM_SUN_KM3_S2, // 132712440041.279419 (DE440)
    siderealOrbitDays: null,
    colour: '#FFF4D6',
    accent: '#FFB300',
    priority: 10,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Sun: α0 = 286.13, δ0 = 63.87, W = 84.176 + 14.1844000 d (footnote a: W "corrected for light
      // travel time and removing the aberration correction", Seidelmann et al. 2007 appendix). Ẇ → 25.3800 d sidereal.
      alpha0: [286.13, 0],
      delta0: [63.87, 0],
      w: [84.176, 14.1844000],
    }),
  }),

  mercury: Object.freeze({
    id: 'mercury',
    name: 'Mercury',
    horizonsId: 199,
    radiusEqKm: 2440.53, // pck00011 BODY199_RADII = (2440.53, 2440.53, 2438.26)
    radiusPolarKm: 2438.26,
    gmKm3S2: 22031.868551, // DE440 astro_par
    siderealOrbitDays: 87.969, // NSSDC mercuryfact
    colour: '#9E9A93',
    accent: '#7B7873',
    priority: 4,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Mercury (updated in 2015; footnote b: the 20° meridian is defined by the crater Hun Kal):
      //   α0 = 281.0103 − 0.0328 T,  δ0 = 61.4155 − 0.0049 T,
      //   W  = 329.5988 + 6.1385108 d + 0.01067257 sin M1 − 0.00112309 sin M2 − 0.00011040 sin M3
      //        − 0.00002539 sin M4 − 0.00000571 sin M5
      //   M1 = 174.7910857 + 4.092335 d,  M2 = 349.5821714 + 8.184670 d,  M3 = 164.3732571 + 12.277005 d,
      //   M4 = 339.1643429 + 16.369340 d, M5 = 153.9554286 + 20.461675 d   (arguments in DAYS)
      alpha0: [281.0103, -0.0328],
      delta0: [61.4155, -0.0049],
      w: [329.5988, 6.1385108],
      periodic: Object.freeze({
        alpha0: [],
        delta0: [],
        w: [
          [+0.01067257, 174.7910857, 4.092335, 'd'], // sin M1
          [-0.00112309, 349.5821714, 8.184670, 'd'], // sin M2
          [-0.00011040, 164.3732571, 12.277005, 'd'], // sin M3
          [-0.00002539, 339.1643429, 16.369340, 'd'], // sin M4
          [-0.00000571, 153.9554286, 20.461675, 'd'], // sin M5
        ],
      }),
    }),
  }),

  venus: Object.freeze({
    id: 'venus',
    name: 'Venus',
    horizonsId: 299,
    radiusEqKm: 6051.8, // pck00011 BODY299_RADII = (6051.8, 6051.8, 6051.8)
    radiusPolarKm: 6051.8,
    gmKm3S2: 324858.592000, // DE440 astro_par
    siderealOrbitDays: 224.701, // NSSDC venusfact
    colour: '#E8CDA0',
    accent: '#D9B77A',
    priority: 5,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Venus (unchanged since 2009; footnote c: 0° meridian = central peak of crater Ariadne):
      //   α0 = 272.76, δ0 = 67.16, W = 160.20 − 1.4813688 d   (Ẇ < 0: retrograde; 243.0185 d sidereal)
      alpha0: [272.76, 0],
      delta0: [67.16, 0],
      w: [160.20, -1.4813688],
    }),
  }),

  earth: Object.freeze({
    id: 'earth',
    name: 'Earth',
    horizonsId: 399,
    radiusEqKm: 6378.1366, // pck00011 BODY399_RADII = (6378.1366, 6378.1366, 6356.7519)
    radiusPolarKm: 6356.7519,
    gmKm3S2: 398600.435507, // DE440 astro_par
    siderealOrbitDays: 365.256, // NSSDC earthfact
    colour: '#3F73C2',
    accent: '#4E8B4A',
    priority: 9,
    rotation: Object.freeze({
      model: 'gmst',
      // IAU 2015 report footnote 2 (p. 9): "Previous reports also included approximate expressions for the Earth.
      // Their accuracy was poor, and the expressions failed near the fundamental epoch (J2000.0) … Users should refer
      // to the [IERS] for appropriate models of the Earth's rotation." orientation.js therefore uses
      // M = EQ_TO_ECL · P(T)ᵀ · R_z(GMST(UT1)); the spin rate is the GMST linear coefficient
      // 360.98564736629 °/day (IAU 1982, Meeus AA 2nd ed. eq. 12.4) → 23.934470 h sidereal day.
      spinRateDegPerDay: 360.98564736629,
    }),
  }),

  mars: Object.freeze({
    id: 'mars',
    name: 'Mars',
    horizonsId: 4,
    radiusEqKm: 3396.19, // pck00011 BODY499_RADII = (3396.19, 3396.19, 3376.20)
    radiusPolarKm: 3376.20,
    gmKm3S2: 42828.375816, // DE440 astro_par (Mars system)
    siderealOrbitDays: 686.980, // NSSDC marsfact
    colour: '#C1572B',
    accent: '#8C3A1E',
    priority: 6,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Mars (footnote d: Viking 1 lander at 47°.95137 W, 0° meridian through crater Airy-0).
      // All 17 periodic terms are mandatory: the 0.5042615 °/century terms move the J2000 pole by +0.4117° in α and
      // −1.5461° in δ (omitting them gives a 1.3° obliquity error). Arguments in CENTURIES.
      //   α0 = 317.269202 − 0.10927547 T + 0.000068 sin(198.991226 + 19139.4819985 T)
      //        + 0.000238 sin(226.292679 + 38280.8511281 T) + 0.000052 sin(249.663391 + 57420.7251593 T)
      //        + 0.000009 sin(266.183510 + 76560.6367950 T) + 0.419057 sin(79.398797 + 0.5042615 T)
      //   δ0 = 54.432516 − 0.05827105 T + 0.000051 cos(122.433576 + 19139.9407476 T)
      //        + 0.000141 cos(43.058401 + 38280.8753272 T) + 0.000031 cos(57.663379 + 57420.7517205 T)
      //        + 0.000005 cos(79.476401 + 76560.6495004 T) + 1.591274 cos(166.325722 + 0.5042615 T)
      //   W  = 176.049863 + 350.891982443297 d + 0.000145 sin(129.071773 + 19140.0328244 T)
      //        + 0.000157 sin(36.352167 + 38281.0473591 T) + 0.000040 sin(56.668646 + 57420.9295360 T)
      //        + 0.000001 sin(67.364003 + 76560.2552215 T) + 0.000001 sin(104.792680 + 95700.4387578 T)
      //        + 0.584542 sin(95.391654 + 0.5042615 T)
      alpha0: [317.269202, -0.10927547],
      delta0: [54.432516, -0.05827105],
      w: [176.049863, 350.891982443297],
      periodic: Object.freeze({
        alpha0: [
          [0.000068, 198.991226, 19139.4819985, 'T'],
          [0.000238, 226.292679, 38280.8511281, 'T'],
          [0.000052, 249.663391, 57420.7251593, 'T'],
          [0.000009, 266.183510, 76560.6367950, 'T'],
          [0.419057, 79.398797, 0.5042615, 'T'],
        ],
        delta0: [
          [0.000051, 122.433576, 19139.9407476, 'T'],
          [0.000141, 43.058401, 38280.8753272, 'T'],
          [0.000031, 57.663379, 57420.7517205, 'T'],
          [0.000005, 79.476401, 76560.6495004, 'T'],
          [1.591274, 166.325722, 0.5042615, 'T'],
        ],
        w: [
          [0.000145, 129.071773, 19140.0328244, 'T'],
          [0.000157, 36.352167, 38281.0473591, 'T'],
          [0.000040, 56.668646, 57420.9295360, 'T'],
          [0.000001, 67.364003, 76560.2552215, 'T'],
          [0.000001, 104.792680, 95700.4387578, 'T'],
          [0.584542, 95.391654, 0.5042615, 'T'],
        ],
      }),
    }),
  }),

  jupiter: Object.freeze({
    id: 'jupiter',
    name: 'Jupiter',
    horizonsId: 5,
    radiusEqKm: 71492, // pck00011 BODY599_RADII = (71492, 71492, 66854) (1-bar level)
    radiusPolarKm: 66854,
    gmKm3S2: 126712764.100000, // DE440 astro_par (Jupiter system)
    siderealOrbitDays: 4332.589, // NSSDC jupiterfact
    colour: '#D8B48A',
    accent: '#A5714E',
    priority: 8,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Jupiter (unchanged since 2009; footnote e: W is System III, the magnetic-field rotation).
      //   α0 = 268.056595 − 0.006499 T + 0.000117 sin Ja + 0.000938 sin Jb + 0.001432 sin Jc + 0.000030 sin Jd + 0.002150 sin Je
      //   δ0 = 64.495303 + 0.002413 T + 0.000050 cos Ja + 0.000404 cos Jb + 0.000617 cos Jc − 0.000013 cos Jd + 0.000926 cos Je
      //   W  = 284.95 + 870.5360000 d
      //   Ja = 99.360714 + 4850.4046 T, Jb = 175.895369 + 1191.9605 T, Jc = 300.323162 + 262.5475 T,
      //   Jd = 114.012305 + 6070.2476 T, Je = 49.511251 + 64.3000 T   (arguments in CENTURIES)
      alpha0: [268.056595, -0.006499],
      delta0: [64.495303, 0.002413],
      w: [284.95, 870.5360000],
      periodic: Object.freeze({
        alpha0: [
          [0.000117, 99.360714, 4850.4046, 'T'], // sin Ja
          [0.000938, 175.895369, 1191.9605, 'T'], // sin Jb
          [0.001432, 300.323162, 262.5475, 'T'], // sin Jc
          [0.000030, 114.012305, 6070.2476, 'T'], // sin Jd
          [0.002150, 49.511251, 64.3000, 'T'], // sin Je
        ],
        delta0: [
          [+0.000050, 99.360714, 4850.4046, 'T'], // cos Ja
          [+0.000404, 175.895369, 1191.9605, 'T'], // cos Jb
          [+0.000617, 300.323162, 262.5475, 'T'], // cos Jc
          [-0.000013, 114.012305, 6070.2476, 'T'], // cos Jd
          [+0.000926, 49.511251, 64.3000, 'T'], // cos Je
        ],
        w: [],
      }),
    }),
  }),

  saturn: Object.freeze({
    id: 'saturn',
    name: 'Saturn',
    horizonsId: 6,
    radiusEqKm: 60268, // pck00011 BODY699_RADII = (60268, 60268, 54364) (1-bar level)
    radiusPolarKm: 54364,
    gmKm3S2: 37940584.841800, // DE440 astro_par (Saturn system)
    siderealOrbitDays: 10755.699, // NSSDC saturnfact
    colour: '#E7D3A4',
    accent: '#D6C39E',
    priority: 7,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Saturn (unchanged since 2009; footnote e: System III):
      //   α0 = 40.589 − 0.036 T, δ0 = 83.537 − 0.004 T, W = 38.90 + 810.7939024 d
      alpha0: [40.589, -0.036],
      delta0: [83.537, -0.004],
      w: [38.90, 810.7939024],
    }),
    rings: SATURN_RINGS,
  }),

  uranus: Object.freeze({
    id: 'uranus',
    name: 'Uranus',
    horizonsId: 7,
    radiusEqKm: 25559, // pck00011 BODY799_RADII = (25559, 25559, 24973) (1-bar level)
    radiusPolarKm: 24973,
    gmKm3S2: 5794556.400000, // DE440 astro_par (Uranus system)
    siderealOrbitDays: 30685.4, // NSSDC uranusfact
    colour: '#A9DDE6',
    accent: '#7FC3CF',
    priority: 3,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Uranus (unchanged since 2009; footnote e: System III):
      //   α0 = 257.311, δ0 = −15.175, W = 203.81 − 501.1600928 d   (Ẇ < 0: retrograde; 17.24000 h sidereal)
      alpha0: [257.311, 0],
      delta0: [-15.175, 0],
      w: [203.81, -501.1600928],
    }),
  }),

  neptune: Object.freeze({
    id: 'neptune',
    name: 'Neptune',
    horizonsId: 8,
    radiusEqKm: 24764, // pck00011 BODY899_RADII = (24764, 24764, 24341)
    radiusPolarKm: 24341,
    gmKm3S2: 6836527.100580, // DE440 astro_par (Neptune system)
    siderealOrbitDays: 60189.018, // NSSDC neptunefact
    colour: '#3E66C9',
    accent: '#2C4FA6',
    priority: 2,
    rotation: Object.freeze({
      model: 'iau',
      // IAU 2015 Table 1, Neptune (W updated in 2015 to System II, Karkoschka 2011: 15.96630 ± 0.00003 h):
      //   α0 = 299.36 + 0.70 sin N, δ0 = 43.46 − 0.51 cos N, W = 249.978 + 541.1397757 d − 0.48 sin N,
      //   N = 357.85 + 52.316 T   (argument in CENTURIES)
      alpha0: [299.36, 0],
      delta0: [43.46, 0],
      w: [249.978, 541.1397757],
      periodic: Object.freeze({
        alpha0: [[+0.70, 357.85, 52.316, 'T']], // sin N
        delta0: [[-0.51, 357.85, 52.316, 'T']], // cos N
        w: [[-0.48, 357.85, 52.316, 'T']], // sin N
      }),
    }),
  }),
});

/**
 * @param {string} id body id
 * @returns {Body}
 * @throws {RangeError} unknown id
 */
export function body(id) {
  const b = BODIES[id];
  if (b === undefined) throw new RangeError(`bodies: unknown body '${id}'`);
  return b;
}

/** @param {string} id @returns {number} equatorial radius in AU */
export function radiusAu(id) {
  return body(id).radiusEqKm / AU_KM;
}

/** @param {string} id @returns {number} polar radius in AU */
export function radiusPolarAu(id) {
  return body(id).radiusPolarKm / AU_KM;
}

/** @param {string} id @returns {number} flattening f = (a − c)/a (Earth 1/298.26, Saturn 0.098) */
export function flattening(id) {
  const b = body(id);
  return (b.radiusEqKm - b.radiusPolarKm) / b.radiusEqKm;
}

/** @param {string} id @returns {boolean} true for the eight planets */
export function isPlanet(id) {
  return id !== 'sun' && BODIES[id] !== undefined;
}
