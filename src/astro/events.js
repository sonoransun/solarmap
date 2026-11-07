// Alignment-event engine: detectors, scanning, classification, dedupe and notability — plan §"Events (events.js,
// numeric.js)". Pure (no DOM, no three.js): takes an ephemeris instance and a TT window, returns Event objects.
//
// Geometry (alignment-events research bq2vila6z.txt §A; plan §Events): heliocentric scene-frame vectors E (Earth), P, Q;
// geocentric g = P − E, s = −E. All Sun-relative events use the HELIOCENTRIC longitude difference Δλ = λ_P − λ_E, which
// is equivalent to the Almanac's geocentric definition (λ_☉ = λ_E + 180°) by projection (final critique byf0bzyiw.txt
// "Event classification … correct"). Times are geometric — no light-time, no aberration — so oppositions and
// conjunctions land 6–40 min before almanac "apparent" instants and greatest elongations up to a few hours away
// while the angle agrees to 0.002° (research §A "Geometric vs apparent").
//
// Scan design (plan §Events "Scan"; research §B): a 1-day grid aligned to 0h TT (JD ≡ 0.5 mod 1) over the window
// widened by SCAN_OVERLAP_D on both sides; ONE ephemeris.states() per grid day, memoised per absolute day index so
// every detector shares it; sign-change brackets with the sin/cos double-sign alias guard (numeric.scanBrackets);
// brentRoot to 1e-6 d (≈ 0.09 s); extrema via brentMin; parade minima via a 3-point parabola (never Brent across
// membership changes). The absolute grid alignment makes a chunked scan bit-identical to one scan (tested).
// Off-grid evaluations (Brent iterates, alias-guard midpoints) compute only the bodies a detector needs.
//
// Seasons, Moon and eclipses (seasons.js, moon.js, eclipses.js, apparent.js): the four seasons are the crossings of the
// Sun's APPARENT longitude of date (nutation + aberration) through 0°/90°/180°/270° (Meeus ch. 27); lunar phases are the
// crossings of the apparent-longitude difference Moon − Sun through 0°/90°/180°/270° (Meeus ch. 49 definition); solar
// and lunar eclipses are searched only around each new/full Moon as the minimum of the shadow-axis distance (greatest
// eclipse) and classified by Meeus ch. 54's limits; perigee/apogee are the zeros of the geocentric r·ṙ of the Moon.
// The Moon is cheap (Meeus 47, ≈ 4 µs) and is memoised per grid day like the planets; the Earth's state at off-grid
// instants of these Moon detectors is a second-order Taylor step from the nearest grid node (error < 15 km ≈ 0.02″ of
// solar direction, 0.002 Earth radii of eclipse γ) instead of a 90 µs series evaluation, which keeps the whole lunar
// block below 10 % of the scan (measured in test/eclipses.test.mjs).
import { AU_KM, LIGHT_TIME_AU_S, RAD, SUN_RADIUS_KM, ARCSEC_PER_RAD, DAYS_PER_CENTURY, C_AU_DAY } from './constants.js';
import { PLANETS, BODIES } from './ephemeris.js';
import { utcFromTt } from './time.js';
import { brentRoot, brentMin, scanBrackets, scanExtrema, parabolicExtremum } from './numeric.js';
import {
  helioLonDeltaSinCos, geoLonDeltaSinCos, elongationRad, elongationSide, separationRad, distanceAu,
  geocentricLongitudeRad, paradeArc, geocentricParade, PARADE_MIN_ELONGATION_DEG,
} from './geometry.js';
import { body } from './bodies.js';
import { moonState, moonIllumination, moonAngularDiameterDeg } from './moon.js';
import { apparentPlace, newApparentPlace, apparentSunLongitudeDeg } from './apparent.js';
import { GM_SUN_AU3_D2 } from './elements.js';
import { SEASON_KINDS, SEASON_LONGITUDE_DEG } from './seasons.js';
import {
  solarEclipseGeometry, lunarEclipseGeometry, classifySolar, classifyLunar, solarMagnitude, isCentral,
  newSolarGeometry, newLunarGeometry,
} from './eclipses.js';
import { groupThousands } from './format.js';

// ---------------------------------------------------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------------------------------------------------

/** Lunar event kinds (Moon phases, apsides, eclipses). */
export const LUNAR_KINDS = Object.freeze([
  'moon-new', 'moon-first-quarter', 'moon-full', 'moon-last-quarter', 'moon-perigee', 'moon-apogee',
  'solar-eclipse', 'lunar-eclipse',
]);

/** Event kinds (plan §Events table rows; the Sun-relative row yields four kinds) plus seasons and lunar kinds. */
export const KINDS = Object.freeze([
  'opposition', 'conjunction', 'inferior-conjunction', 'superior-conjunction',
  'greatest-elongation', 'pair', 'closest-approach', 'perihelion', 'aphelion',
  'helio-parade', 'stationary', 'geo-parade',
  ...SEASON_KINDS, ...LUNAR_KINDS,
]);

/** Experimental classes (plan §Events: stationary points hidden below score 40; geocentric parade experimental). */
export const EXPERIMENTAL_KINDS = Object.freeze(['stationary', 'geo-parade']);

/** Scan overlap added on both sides of the requested window, days (plan §Events "+40 d overlap"). */
export const SCAN_OVERLAP_D = 40;
/** Grid spacing, days (plan §Events "1-day grid"; research §B.2: < half the shortest root spacing, Mercury 58 d). */
export const GRID_STEP_D = 1;
/** brentRoot absolute tolerance, days (plan §Events "brentRoot tol 1e-6 d (≈0.1 s)"). */
export const ROOT_TOL_D = 1e-6;
/** brentMin absolute tolerance on the abscissa, days (same order as the root tolerance). */
export const MIN_TOL_D = 1e-6;
/** Half-width of the minimum-separation search around a planet–planet λ-conjunction, days (plan: "±15 d"). */
export const PAIR_SEARCH_HALF_WIDTH_D = 15;
/** Half-width of the elongation-extremum search around a Sun-relative crossing, days (plan: "Brent min within ±3 d"). */
export const PSI_EXTREMUM_HALF_WIDTH_D = 3;
/** Heliocentric-parade arc thresholds by member count k, degrees (plan §Events; research §A.5 / §C6). */
export const PARADE_THRESHOLDS_DEG = Object.freeze({ 3: 10, 4: 60, 5: 90, 6: 120, 7: 150, 8: 180 });
/** Geocentric parade: minimum number of planets with elongation > 10° on one side (plan: "interval when N ≥ 5"). */
export const GEO_PARADE_MIN_N = 5;
/** Elongation above which a body counts as observable / a pair as `observable` (plan: "observable if both > 10°"). */
export const OBSERVABLE_MIN_ELONGATION_DEG = 10;
/**
 * Merge windows, days: same-kind same-bodies events closer than this are merged, keeping the higher score (plan
 * §Events: 10 d greatest elongation, 30 d opposition/conjunction, 5 d pair, 20 d apsis, 10 d stationary). Closest
 * approach uses the apsis window (a distance extremum with one minimum per synodic period — never triggers in
 * practice); the parade classes rely on the (kind, bodies, minute) dedupe key only.
 */
export const MERGE_WINDOWS_D = Object.freeze({
  'opposition': 30, 'conjunction': 30, 'inferior-conjunction': 30, 'superior-conjunction': 30,
  'greatest-elongation': 10, 'pair': 5, 'closest-approach': 20, 'perihelion': 20, 'aphelion': 20,
  'helio-parade': 0, 'stationary': 10, 'geo-parade': 0,
  'equinox-march': 30, 'solstice-june': 30, 'equinox-september': 30, 'solstice-december': 30,
  'moon-new': 5, 'moon-first-quarter': 5, 'moon-full': 5, 'moon-last-quarter': 5, 'moon-perigee': 10, 'moon-apogee': 10,
  'solar-eclipse': 10, 'lunar-eclipse': 10,
});
/** Cap on walking an interval event (parade entry/exit) beyond the scan range, days; beyond it entry/exit = null. */
export const MAX_INTERVAL_WALK_D = 366;
/** Half-width of the greatest-eclipse search around a new/full Moon, days (conjunction → greatest eclipse ≤ ≈ 1 h). */
export const ECLIPSE_SEARCH_HALF_WIDTH_D = 0.25;
/** A full Moon closer than this is labelled a "supermoon" (perigee full Moon; a common popular threshold). */
export const SUPERMOON_MAX_DIST_KM = 360000;
/**
 * Body order for sorting event bodies and the dedupe key: Sun, planets Sun-outward, then the Moon (so ['earth','moon']
 * reads inside-out and the planet-only order of PLANETS is unchanged).
 */
export const BODY_ORDER = Object.freeze(['sun', ...PLANETS, 'moon']);

/** Solar radius in AU (IAU 2015 nominal 695 700 km, constants.js) — transit threshold asin(R☉/|E|) ≈ 0.2665° at 1 AU. */
const SUN_RADIUS_AU = SUN_RADIUS_KM / AU_KM;
const INNER = new Set(['mercury', 'venus']);
/** The seven planets other than Earth, Sun-outward. */
const NON_EARTH = Object.freeze(PLANETS.filter((p) => p !== 'earth'));
const ORDER_INDEX = new Map(BODY_ORDER.map((p, i) => [p, i]));
const SUN_RELATIVE_KINDS = ['opposition', 'conjunction', 'inferior-conjunction', 'superior-conjunction'];
const APSIS_KINDS = ['perihelion', 'aphelion'];
const PHASE_KINDS = ['moon-new', 'moon-first-quarter', 'moon-full', 'moon-last-quarter'];
const MOON_APSIS_KINDS = ['moon-perigee', 'moon-apogee'];
const ECLIPSE_KINDS = ['solar-eclipse', 'lunar-eclipse'];
const ROOT_OPTS = Object.freeze({ tol: ROOT_TOL_D });
const MIN_OPTS = Object.freeze({ tol: MIN_TOL_D });
const MINUTES_PER_DAY = 1440;
/**
 * IAU 1976 general precession in longitude at J2000, p = 5029.0966″ per Julian century (Lieske et al. 1977; Meeus 21.6
 * linear term) in radians per day: the rate at which a longitude OF DATE exceeds the J2000 one (stationary points).
 */
const PRECESSION_RAD_PER_DAY = 5029.0966 / ARCSEC_PER_RAD / DAYS_PER_CENTURY;

/**
 * @typedef {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} State
 * @typedef {Record<string, State>} States
 * @typedef {{
 *   id: string, kind: string, bodies: string[], jdTT: number, jdUtc: number,
 *   value: Record<string, any>, score: number, observable: boolean, label: string,
 * }} Event
 */

// ---------------------------------------------------------------------------------------------------------------------
// Scan context: aligned grid + per-day memo + off-grid scratch
// ---------------------------------------------------------------------------------------------------------------------

/** @returns {State} */
function newState() {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
}

/**
 * @typedef {{
 *   g0: number, g1: number, n: number,
 *   day: (i: number) => States, at: (t: number, needs: readonly string[]) => States,
 *   moonAt: (t: number) => State, earthNear: (t: number) => States,
 *   sc: {sin:number, cos:number}, minOut: {x:number, fx:number, evals:number},
 * }} Ctx
 */

/**
 * Build the scan context. Grid node i is at JD(TT) g0 + i with g0 ≡ 0.5 (mod 1), i.e. 0h TT, so two scans of
 * overlapping windows evaluate identical doubles and produce identical brackets and roots.
 * @param {ReturnType<import('./ephemeris.js').createEphemeris>} eph
 * @param {number} jdTT0 @param {number} jdTT1
 * @returns {Ctx}
 */
function createContext(eph, jdTT0, jdTT1) {
  const g0 = Math.floor(jdTT0 - SCAN_OVERLAP_D - 0.5) + 0.5; // 0h TT on/before the widened start
  const g1 = Math.ceil(jdTT1 + SCAN_OVERLAP_D - 0.5) + 0.5;  // 0h TT on/after the widened end
  const n = Math.round(g1 - g0);
  /** @type {Map<number, States>} */
  const cache = new Map();
  /** @type {States} */
  const scratch = {};
  for (const b of BODIES) scratch[b] = newState();
  /** @type {Record<string, boolean>} */
  const offDone = {};
  let offT = NaN;

  /** States at grid day index i (any integer; days outside the scan range are computed on demand and memoised). */
  function day(i) {
    let S = cache.get(i);
    if (S === undefined) {
      S = eph.states(g0 + i, {}); // own object per day: the ephemeris memo would be overwritten by the next day
      cache.set(i, S);
    }
    return S;
  }

  /**
   * States at an arbitrary instant: the memoised day object when t is a grid node, otherwise a scratch object in
   * which only `needs` (plus the Sun) are valid for this t — every detector reads only the bodies it asked for.
   */
  function at(t, needs) {
    const i = t - g0;
    if (i === Math.floor(i)) return day(i);
    if (t !== offT) {
      offT = t;
      for (let k = 0; k < PLANETS.length; k++) offDone[PLANETS[k]] = false;
    }
    for (let k = 0; k < needs.length; k++) {
      const b = needs[k];
      if (b !== 'sun' && !offDone[b]) {
        eph.state(b, t, scratch[b]);
        offDone[b] = true;
      }
    }
    return scratch;
  }

  // Moon (moon.js, geocentric): memoised per grid day, scratch off-grid.
  /** @type {Map<number, State>} */
  const moonCache = new Map();
  const moonScratch = newState();
  let moonOffT = NaN;

  /** Geocentric Moon state at t (grid nodes memoised). */
  function moonAt(t) {
    const i = t - g0;
    if (i === Math.floor(i)) {
      let m = moonCache.get(i);
      if (m === undefined) {
        m = moonState(t, newState());
        moonCache.set(i, m);
      }
      return m;
    }
    if (t !== moonOffT) { moonState(t, moonScratch); moonOffT = t; }
    return moonScratch;
  }

  // Earth near a grid node by a second-order Taylor step (two-body acceleration): E(t₀ + δ) ≈ E + V δ + ½ A δ²,
  // A = −μ E/r³; |δ| ≤ 0.5 d → truncation (1/6)|J|δ³ ≲ 1e-7 AU (15 km), far below the planets' own 16 km residual.
  const nearStates = { sun: newState(), earth: newState() };
  let nearT = NaN;

  /** {sun, earth} states at t for the Moon detectors (not the planets); exact at grid nodes. */
  function earthNear(t) {
    const i = t - g0;
    if (i === Math.floor(i)) return day(i);
    if (t === nearT) return nearStates;
    nearT = t;
    const i0 = Math.round(i);
    const E = day(i0).earth;
    const d = t - (g0 + i0);
    const r = Math.hypot(E.x, E.y, E.z);
    const k = -GM_SUN_AU3_D2 / (r * r * r);
    const h = 0.5 * d * d;
    const o = nearStates.earth;
    o.x = E.x + E.vx * d + h * k * E.x;
    o.y = E.y + E.vy * d + h * k * E.y;
    o.z = E.z + E.vz * d + h * k * E.z;
    o.vx = E.vx + d * k * E.x;
    o.vy = E.vy + d * k * E.y;
    o.vz = E.vz + d * k * E.z;
    return nearStates;
  }

  return { g0, g1, n, day, at, moonAt, earthNear, sc: { sin: 0, cos: 0 }, minOut: { x: 0, fx: 0, evals: 0 } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Notability, labels, event assembly
// ---------------------------------------------------------------------------------------------------------------------

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Notability score 0–100, exactly the plan §Events "Notability" rules:
 * transit 100; all-8 parade 90; Mars opposition 75 (+15 if Δ < 0.6 AU); Jupiter/Saturn opposition 60; Uranus/Neptune 35;
 * pair 40 + 40·clamp(1 − θ°/2, 0, 1) (+10 if Venus or Jupiter in the pair, +15 if Jupiter–Saturn and θ < 30′,
 * ×0.5 if either elongation < 15°, clamp 100); Venus GE 45 / Mercury 35; inferior conjunction Venus 45 / Mercury 25;
 * superior 20/15; outer conjunction 20; helio parade 10·k + 30·clamp(1 − arc/threshold_k, 0, 1) (floored at 90 for
 * k = 8 so "all-8 parade 90" holds for the loosest one); geo parade 50 + 8·(N − 5); Earth-closest Mars 60 (+10 if
 * < 0.6 AU), Venus 30, others 20; apsides Earth 20, others 15; stationary Mars 35, others 25.
 * @param {string} kind @param {string[]} bodies (sorted Sun-outward) @param {Record<string, any>} value
 * @returns {number}
 */
export function notabilityScore(kind, bodies, value) {
  const p = bodies[0];
  let s;
  switch (kind) {
    case 'opposition':
      s = p === 'mars' ? (value.distanceAu < 0.6 ? 90 : 75) : (p === 'jupiter' || p === 'saturn') ? 60 : 35;
      break;
    case 'conjunction': s = 20; break;
    case 'inferior-conjunction': s = value.transit ? 100 : p === 'venus' ? 45 : 25; break;
    case 'superior-conjunction': s = p === 'venus' ? 20 : 15; break;
    case 'greatest-elongation': s = p === 'venus' ? 45 : 35; break;
    case 'pair': {
      s = 40 + 40 * clamp(1 - value.separationDeg / 2, 0, 1);
      if (bodies.includes('venus') || bodies.includes('jupiter')) s += 10;
      if (bodies.includes('jupiter') && bodies.includes('saturn') && value.separationArcmin < 30) s += 15;
      if (Math.min(value.elongationsDeg[0], value.elongationsDeg[1]) < 15) s *= 0.5;
      break;
    }
    case 'closest-approach':
      s = p === 'mars' ? (value.distanceAu < 0.6 ? 70 : 60) : p === 'venus' ? 30 : 20;
      break;
    case 'perihelion':
    case 'aphelion': s = p === 'earth' ? 20 : 15; break;
    case 'helio-parade': {
      // Tightness dominates: a 6-planet spread of 104° is not news, three planets inside 1° is. The quadratic
      // keeps loose groupings below the UI's default filter (40) while tight ones stay near the top of the list.
      const k = value.k;
      const tight = clamp(1 - value.arcDeg / PARADE_THRESHOLDS_DEG[k], 0, 1);
      s = 6 * k + 50 * tight * tight;
      if (k === 8) s = Math.max(50, s); // all eight planets on one side of the Sun is worth surfacing
      break;
    }
    case 'stationary': s = p === 'mars' ? 35 : 25; break;
    case 'geo-parade': s = 50 + 8 * (value.n - GEO_PARADE_MIN_N); break;
    // Seasons: four a year, universally meaningful — shown by the default filter (≥ 40) but below the rare alignments.
    case 'equinox-march': case 'solstice-june': case 'equinox-september': case 'solstice-december': s = 45; break;
    // Lunar phases: frequent, low (the Moon is always "doing something"); a perigee full Moon ("supermoon") stands out.
    case 'moon-new': s = 15; break;
    case 'moon-full': s = value.supermoon ? 35 : 20; break;
    case 'moon-first-quarter': case 'moon-last-quarter': s = 10; break;
    case 'moon-perigee': s = 12; break;
    case 'moon-apogee': s = 8; break;
    // Eclipses: total solar eclipses are the rarest spectacle; partial ones scale with the covered fraction.
    case 'solar-eclipse':
      s = value.type === 'total' ? 98 : value.type === 'hybrid' ? 95 : value.type === 'annular' ? 90 : 50 + 30 * clamp(value.magnitude, 0, 1);
      break;
    case 'lunar-eclipse': s = value.type === 'total' ? 75 : value.type === 'partial' ? 55 : 25; break;
    default: throw new RangeError(`events: unknown kind '${kind}'`);
  }
  return clamp(s, 0, 100);
}

/** @param {string} id @returns {string} 'mars' → 'Mars' */
function nameOf(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Separation for labels: arcminutes below 1°, else degrees with one decimal. @param {number} deg @returns {string} */
function fmtSep(deg) {
  return deg < 1 ? `${Math.round(deg * 60)}′` : `${deg.toFixed(1)}°`;
}

/**
 * Human-readable one-line label per kind.
 * @param {string} kind @param {string[]} bodies @param {Record<string, any>} value @returns {string}
 */
export function labelFor(kind, bodies, value) {
  const n = nameOf(bodies[0]);
  switch (kind) {
    case 'opposition': return `${n} at opposition`;
    case 'conjunction': return `${n} in conjunction with the Sun`;
    case 'inferior-conjunction': return `${n} at inferior conjunction${value.transit ? ' — transit of the Sun' : ''}`;
    case 'superior-conjunction': return `${n} at superior conjunction`;
    case 'greatest-elongation': return `${n} greatest elongation ${value.elongationDeg.toFixed(1)}° ${value.side}`;
    case 'pair': return `${n}–${nameOf(bodies[1])} conjunction, ${fmtSep(value.separationDeg)} apart`;
    case 'closest-approach': return `${n} closest to Earth, ${value.distanceAu.toFixed(4)} AU`;
    case 'perihelion': return `${n} at perihelion, ${value.rAu.toFixed(4)} AU`;
    case 'aphelion': return `${n} at aphelion, ${value.rAu.toFixed(4)} AU`;
    case 'helio-parade': return `${value.k} planets within ${value.arcDeg.toFixed(1)}° of heliocentric longitude`;
    case 'stationary': return `${n} stationary — retrograde ${value.phase === 'retrograde-start' ? 'begins' : 'ends'}`;
    case 'geo-parade': return `${value.n} planets in the ${value.side} sky`;
    case 'equinox-march': return 'March equinox — day and night nearly equal; spring begins in the north, autumn in the south';
    case 'solstice-june': return 'June solstice — the longest day in the north, the shortest in the south';
    case 'equinox-september': return 'September equinox — day and night nearly equal; autumn begins in the north, spring in the south';
    case 'solstice-december': return 'December solstice — the shortest day in the north, the longest in the south';
    case 'moon-new': return 'New Moon';
    case 'moon-first-quarter': return 'First quarter Moon';
    case 'moon-full': return value.supermoon ? `Full Moon near perigee (a "supermoon"), ${groupThousands(value.distKm)} km away` : 'Full Moon';
    case 'moon-last-quarter': return 'Last quarter Moon';
    case 'moon-perigee': return `Moon at perigee (closest to Earth), ${groupThousands(value.distKm)} km`;
    case 'moon-apogee': return `Moon at apogee (farthest from Earth), ${groupThousands(value.distKm)} km`;
    case 'solar-eclipse':
      switch (value.type) {
        case 'total': return 'Total solar eclipse — the Moon covers the whole Sun along a narrow track';
        case 'annular': return 'Annular solar eclipse — a ring of sunlight stays visible around the Moon';
        case 'hybrid': return 'Hybrid solar eclipse — total along part of the track, annular elsewhere';
        default: return `Partial solar eclipse — the Moon covers ${Math.round(value.magnitude * 100)}% of the Sun’s width at most`;
      }
    case 'lunar-eclipse':
      switch (value.type) {
        case 'total': return 'Total lunar eclipse — the full Moon turns copper-red inside Earth’s shadow';
        case 'partial': return `Partial lunar eclipse — Earth’s shadow covers ${Math.round(value.umbralMagnitude * 100)}% of the Moon’s width`;
        default: return 'Penumbral lunar eclipse — a faint shading of the full Moon';
      }
    default: throw new RangeError(`events: unknown kind '${kind}'`);
  }
}

/** Sort body ids Sun-outward (BODY_ORDER: Sun, planets, Moon) — the dedupe key and pair naming use this order. */
function sortBodies(bodies) {
  return bodies.slice().sort((a, b) => ORDER_INDEX.get(a) - ORDER_INDEX.get(b));
}

/**
 * Dedupe key (kind, sorted bodies, jdTT rounded to the minute) — plan §Events; doubles as the event id.
 * @param {string} kind @param {string[]} sortedBodies @param {number} jdTT @returns {string}
 */
export function eventKey(kind, sortedBodies, jdTT) {
  return `${kind}:${sortedBodies.join('+')}:${Math.round(jdTT * MINUTES_PER_DAY)}`;
}

/**
 * Observable = every non-Earth body involved is more than 10° from the Sun as seen from Earth at the event instant
 * (plan: pair "observable if both > 10°"; oppositions → true, conjunctions → false by construction).
 * @param {Ctx} ctx @param {string[]} bodies @param {number} jdTT @returns {boolean}
 */
function isObservable(ctx, bodies, jdTT) {
  const S = ctx.at(jdTT, bodies.includes('earth') ? bodies : bodies.concat('earth'));
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b === 'earth' || b === 'moon' || b === 'sun') continue; // lunar kinds pass their own flag (makeEvent)
    if (!(elongationRad(S, b) * RAD > OBSERVABLE_MIN_ELONGATION_DEG)) return false;
  }
  return true;
}

/**
 * Assemble an Event (plan: `{id, kind, bodies, jdTT, jdUtc, value:{…}, score 0–100, observable, label}`).
 * @param {Ctx} ctx @param {string} kind @param {string[]} bodies @param {number} jdTT @param {Record<string, any>} value
 * @param {boolean} [observable] explicit flag for kinds whose visibility is not "every body > 10° from the Sun"
 *   (eclipses are visible from Earth by definition; a new Moon is not)
 * @returns {Event}
 */
function makeEvent(ctx, kind, bodies, jdTT, value, observable) {
  const sorted = sortBodies(bodies);
  return {
    id: eventKey(kind, sorted, jdTT),
    kind,
    bodies: sorted,
    jdTT,
    jdUtc: utcFromTt(jdTT),
    value,
    score: notabilityScore(kind, sorted, value),
    observable: observable === undefined ? isObservable(ctx, sorted, jdTT) : observable,
    label: labelFor(kind, sorted, value),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sun-relative events (plan §Events row 1): zero of sin(Δλ), Δλ = heliocentric λ_P − λ_E, alias-guarded by cos Δλ;
 * cos Δλ > 0 → inner planet inferior conjunction / outer planet opposition; cos Δλ < 0 → superior conjunction /
 * conjunction. Value: elongation ψ and Earth distance at the crossing, plus the ψ extremum (brentMin within ±3 d:
 * maximum for oppositions, minimum otherwise) and, for inferior conjunctions, the transit flag
 * ψ_min < asin(R☉/|E|) + asin(R_p/Δ): the discs overlap when the centres are closer than the sum of the solar
 * semidiameter (≈ 0.267°, research §A.6; final critique: "0.262–0.271°") and the planet's own (Venus ≈ 30″, Mercury
 * ≈ 6″ at inferior conjunction) — the grazing-transit case the six-lens review flagged.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectSunRelative(ctx, out) {
  const { g0, g1, at, sc, minOut } = ctx;
  for (const p of NON_EARTH) {
    const needs = ['earth', p];
    const f = (t) => helioLonDeltaSinCos(at(t, needs), p, 'earth', sc).sin;
    const c = (t) => helioLonDeltaSinCos(at(t, needs), p, 'earth', sc).cos;
    const brackets = scanBrackets(f, g0, g1, GRID_STEP_D, { aliasGuard: { sin: f, cos: c } });
    for (let i = 0; i < brackets.length; i++) {
      let t;
      try { t = brentRoot(f, brackets[i][0], brackets[i][1], ROOT_OPTS); } catch { continue; }
      const S = at(t, needs);
      const cosD = helioLonDeltaSinCos(S, p, 'earth', sc).cos;
      const inner = INNER.has(p);
      const kind = cosD > 0 ? (inner ? 'inferior-conjunction' : 'opposition') : (inner ? 'superior-conjunction' : 'conjunction');
      const psi = elongationRad(S, p);
      const dist = distanceAu(S, 'earth', p);
      // Elongation extremum (syzygy instant, research §A.6): maximum of ψ at opposition, minimum at conjunctions.
      const sign = kind === 'opposition' ? -1 : 1;
      const m = brentMin((u) => sign * elongationRad(at(u, needs), p),
        t - PSI_EXTREMUM_HALF_WIDTH_D, t + PSI_EXTREMUM_HALF_WIDTH_D, MIN_OPTS, minOut);
      const tExt = m.x, psiExt = sign * m.fx;
      const value = {
        elongationDeg: psi * RAD,
        distanceAu: dist,
        distanceKm: dist * AU_KM,
        lightTimeS: dist * LIGHT_TIME_AU_S,
        extremumElongationDeg: psiExt * RAD,
        jdTTExtremum: tExt,
        jdUtcExtremum: utcFromTt(tExt),
      };
      if (kind === 'inferior-conjunction') {
        const Sx = at(tExt, needs);
        const E = Sx.earth;
        const limit = Math.asin(SUN_RADIUS_AU / Math.hypot(E.x, E.y, E.z)); // solar semidiameter seen from Earth
        const semi = Math.asin(body(p).radiusEqKm / AU_KM / distanceAu(Sx, 'earth', p)); // planet's semidiameter
        value.transitLimitDeg = limit * RAD;
        value.planetSemidiameterDeg = semi * RAD;
        value.transit = psiExt < limit + semi;
      }
      out.push(makeEvent(ctx, kind, [p], t, value));
    }
  }
}

/**
 * Greatest elongations of Mercury and Venus (plan row 2): grid local maxima of ψ = angleBetween(g, s), refined by
 * brentMin(−ψ) on [t_{i−1}, t_{i+1}]; side E if sin(λ_P − λ_☉) > 0 else W (geometry.elongationSide).
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectGreatestElongation(ctx, out) {
  const { g0, g1, at, minOut } = ctx;
  for (const p of ['mercury', 'venus']) {
    const needs = ['earth', p];
    const f = (t) => elongationRad(at(t, needs), p);
    const windows = scanExtrema(f, g0, g1, GRID_STEP_D, { kind: 'max' });
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      let m;
      try { m = brentMin((u) => -f(u), w.a, w.b, MIN_OPTS, minOut); } catch { continue; }
      const t = m.x, psi = -m.fx;
      const S = at(t, needs);
      const value = { elongationDeg: psi * RAD, side: elongationSide(S, p), distanceAu: distanceAu(S, 'earth', p) };
      out.push(makeEvent(ctx, 'greatest-elongation', [p], t, value));
    }
  }
}

/**
 * Planet–planet conjunctions, 21 pairs among the seven planets other than Earth (plan row 3): trigger = zero of
 * sin(λgeo_a − λgeo_b) with cos > 0 (geocentric λ-conjunction, research §A.4 (a)); headline = minimum angular
 * separation (Meeus ch. 17 "least distance", §A.4 (b)) found by brentMin within ±15 d of the trigger — the search
 * window is narrowed to the grid local minimum of the separation nearest the trigger (falls back to the full ±15 d).
 * Value: separation (arcmin, deg), λ-conjunction time, both elongations and sides; `observable` if both > 10°.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectPairs(ctx, out) {
  const { g0, g1, at, sc, minOut } = ctx;
  for (let ia = 0; ia < NON_EARTH.length; ia++) {
    for (let ib = ia + 1; ib < NON_EARTH.length; ib++) {
      const a = NON_EARTH[ia], b = NON_EARTH[ib];
      const needs = ['earth', a, b];
      const f = (t) => geoLonDeltaSinCos(at(t, needs), a, b, sc).sin;
      const c = (t) => geoLonDeltaSinCos(at(t, needs), a, b, sc).cos;
      const sep = (t) => separationRad(at(t, needs), a, b);
      const brackets = scanBrackets(f, g0, g1, GRID_STEP_D, { aliasGuard: { sin: f, cos: c } });
      for (let i = 0; i < brackets.length; i++) {
        let tL;
        try { tL = brentRoot(f, brackets[i][0], brackets[i][1], ROOT_OPTS); } catch { continue; }
        if (!(c(tL) > 0)) continue; // Δλ = 180°: the two planets are opposite in the sky, not in conjunction
        // Grid local minimum of the separation nearest the trigger, within ±15 d.
        const i0 = Math.ceil(tL - PAIR_SEARCH_HALF_WIDTH_D - g0), i1 = Math.floor(tL + PAIR_SEARCH_HALF_WIDTH_D - g0);
        let best = -1, bestDist = Infinity;
        let sPrev = sep(g0 + i0), sCur = sep(g0 + i0 + 1);
        for (let j = i0 + 1; j < i1; j++) {
          const sNext = sep(g0 + j + 1);
          if (sCur < sPrev && sCur <= sNext) {
            const d = Math.abs(g0 + j - tL);
            if (d < bestDist) { bestDist = d; best = j; }
          }
          sPrev = sCur; sCur = sNext;
        }
        let m;
        try {
          m = best >= 0
            ? brentMin(sep, g0 + best - 1, g0 + best + 1, MIN_OPTS, minOut)
            : brentMin(sep, tL - PAIR_SEARCH_HALF_WIDTH_D, tL + PAIR_SEARCH_HALF_WIDTH_D, MIN_OPTS, minOut);
        } catch { continue; }
        const t = m.x, theta = m.fx;
        const S = at(t, needs);
        const value = {
          separationArcmin: theta * RAD * 60,
          separationDeg: theta * RAD,
          jdTTLambda: tL,
          jdUtcLambda: utcFromTt(tL),
          elongationsDeg: [elongationRad(S, a) * RAD, elongationRad(S, b) * RAD],
          sides: [elongationSide(S, a), elongationSide(S, b)],
        };
        out.push(makeEvent(ctx, 'pair', [a, b], t, value));
      }
    }
  }
}

/**
 * Earth–planet closest approaches (plan row 4): grid local minima of |g| refined by brentMin.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectClosestApproach(ctx, out) {
  const { g0, g1, at, minOut } = ctx;
  for (const p of NON_EARTH) {
    const needs = ['earth', p];
    const f = (t) => distanceAu(at(t, needs), 'earth', p);
    const windows = scanExtrema(f, g0, g1, GRID_STEP_D, { kind: 'min' });
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      let m;
      try { m = brentMin(f, w.a, w.b, MIN_OPTS, minOut); } catch { continue; }
      const t = m.x, d = m.fx;
      const S = at(t, needs);
      const value = { distanceAu: d, distanceKm: d * AU_KM, lightTimeS: d * LIGHT_TIME_AU_S, elongationDeg: elongationRad(S, p) * RAD };
      out.push(makeEvent(ctx, 'closest-approach', [p], t, value));
    }
  }
}

/**
 * Perihelion / aphelion of the eight planets (plan row 5; Meeus ch. 38): zero of P·V = r·dr/dt, − → + perihelion,
 * + → − aphelion. Earth is the VSOP87 geocentre, never the Earth–Moon barycentre (research §A.7: the EMB perihelion
 * of 2025 is 27.5 h earlier than the geocentre's).
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectApsides(ctx, out) {
  const { g0, g1, at } = ctx;
  for (const p of PLANETS) {
    const needs = [p];
    const f = (t) => { const s = at(t, needs)[p]; return s.x * s.vx + s.y * s.vy + s.z * s.vz; };
    const brackets = scanBrackets(f, g0, g1, GRID_STEP_D);
    for (let i = 0; i < brackets.length; i++) {
      const [a, b] = brackets[i];
      let t;
      try { t = brentRoot(f, a, b, ROOT_OPTS); } catch { continue; }
      const fa = a === b ? f(a - 0.25) : f(a); // sign before the root (grid node → memoised)
      const kind = fa < 0 ? 'perihelion' : 'aphelion';
      const s = at(t, needs)[p];
      const r = Math.hypot(s.x, s.y, s.z);
      out.push(makeEvent(ctx, kind, [p], t, { rAu: r, rKm: r * AU_KM }));
    }
  }
}

/**
 * Linear interpolation of the instant where a daily-sampled function crosses `thr` between grid days j and j + 1.
 * @param {number} g0 @param {number} j @param {number} fj @param {number} fj1 @param {number} thr @returns {number} JD(TT)
 */
function crossingBetween(g0, j, fj, fj1, thr) {
  return g0 + j + (thr - fj) / (fj1 - fj);
}

/**
 * Heliocentric parades, k = 3…8 (plan row 6; research §A.5): on the daily grid the smallest arc of heliocentric
 * longitude containing k planets (geometry.paradeArc); each grid local minimum below PARADE_THRESHOLDS_DEG[k] is an
 * event whose peak is refined by a 3-point parabola (Meeus ch. 3; never Brent across membership changes). Entry and
 * exit are the threshold crossings around the minimum, walked day by day (beyond the scan range on demand, capped at
 * MAX_INTERVAL_WALK_D → null). Members are those at the minimum's grid node, Sun-outward.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectHelioParades(ctx, out) {
  const { g0, n, day } = ctx;
  const arcOut = { arcDeg: 0, members: [] };
  const pe = { x: 0, f: 0 };
  const ks = [3, 4, 5, 6, 7, 8];
  const arcs = ks.map(() => new Float64Array(n + 1));
  for (let i = 0; i <= n; i++) {
    const S = day(i);
    for (let q = 0; q < ks.length; q++) arcs[q][i] = paradeArc(S, ks[q], arcOut).arcDeg;
  }
  const arcAt = (k, j) => (j >= 0 && j <= n) ? arcs[k - 3][j] : paradeArc(day(j), k, arcOut).arcDeg;
  for (let q = 0; q < ks.length; q++) {
    const k = ks[q], thr = PARADE_THRESHOLDS_DEG[k], A = arcs[q];
    for (let i = 1; i < n; i++) {
      if (!(A[i] < thr && A[i] < A[i - 1] && A[i] <= A[i + 1])) continue;
      parabolicExtremum(g0 + i - 1, A[i - 1], A[i], A[i + 1], GRID_STEP_D, pe);
      const members = sortBodies(paradeArc(day(i), k, arcOut).members);
      // Entry: walk left while below the threshold.
      let entry = null, exit = null;
      let j = i, fj = A[i];
      while (i - j < MAX_INTERVAL_WALK_D) {
        const fp = arcAt(k, j - 1);
        if (!(fp < thr)) { entry = crossingBetween(g0, j - 1, fp, fj, thr); break; }
        j--; fj = fp;
      }
      j = i; fj = A[i];
      while (j - i < MAX_INTERVAL_WALK_D) {
        const fn = arcAt(k, j + 1);
        if (!(fn < thr)) { exit = crossingBetween(g0, j, fj, fn, thr); break; }
        j++; fj = fn;
      }
      const value = {
        k,
        arcDeg: Math.max(0, pe.f),
        arcGridDeg: A[i],
        jdTTGrid: g0 + i,
        thresholdDeg: thr,
        members,
        entry: entry === null ? null : { jdTT: entry, jdUtc: utcFromTt(entry) },
        exit: exit === null ? null : { jdTT: exit, jdUtc: utcFromTt(exit) },
      };
      out.push(makeEvent(ctx, 'helio-parade', members, pe.x, value));
    }
  }
}

/**
 * Stationary points (experimental, plan row 7; Meeus ch. 36 2nd ed.): zero of dλ/dt of the APPARENT geocentric
 * longitude of date — the quantity almanacs tabulate (the Horizons-derived fixture uses ObsEcLon). From the memoised
 * states alone (no extra evaluations): g = P − E − τ V_P (first-order light-time, τ = |P − E|/c; the omitted ½τ²A term
 * is < 2e-9 AU), ġ = V_P − V_E − τ A_P with the two-body A_P; the apparent direction u = ĝ + V_E/c (first-order
 * aberration, Meeus 23.2) with u̇ = (ġ − ĝ(ĝ·ġ))/|g| + A_E/c; then dλ_date/dt ∝ (u × u̇)_z + p (u_x² + u_y²), p = the
 * general precession rate (longitudes of date gain 50.29″/yr on J2000 ones). Light-time shifts the instant by τ
 * (4–40 min), aberration by up to a few hours, precession by ≈ 2 min. + → − retrograde begins, − → + retrograde ends.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectStationary(ctx, out) {
  const { g0, g1, at } = ctx;
  for (const p of NON_EARTH) {
    const needs = ['earth', p];
    const f = (t) => {
      const S = at(t, needs), P = S[p], E = S.earth;
      const gx0 = P.x - E.x, gy0 = P.y - E.y, gz0 = P.z - E.z;
      const tau = Math.hypot(gx0, gy0, gz0) / C_AU_DAY;
      const rP = Math.hypot(P.x, P.y, P.z), kP = -GM_SUN_AU3_D2 / (rP * rP * rP);
      const rE = Math.hypot(E.x, E.y, E.z), kE = -GM_SUN_AU3_D2 / (rE * rE * rE);
      // astrometric vector and its rate
      const gx = gx0 - tau * P.vx, gy = gy0 - tau * P.vy, gz = gz0 - tau * P.vz;
      const dgx = P.vx - E.vx - tau * kP * P.x, dgy = P.vy - E.vy - tau * kP * P.y, dgz = P.vz - E.vz - tau * kP * P.z;
      const g = Math.hypot(gx, gy, gz);
      const ux0 = gx / g, uy0 = gy / g, uz0 = gz / g;
      const ug = ux0 * dgx + uy0 * dgy + uz0 * dgz;
      // apparent direction (aberration) and its rate
      const ux = ux0 + E.vx / C_AU_DAY, uy = uy0 + E.vy / C_AU_DAY;
      const dux = (dgx - ux0 * ug) / g + kE * E.x / C_AU_DAY;
      const duy = (dgy - uy0 * ug) / g + kE * E.y / C_AU_DAY;
      return ux * duy - uy * dux + PRECESSION_RAD_PER_DAY * (ux * ux + uy * uy);
    };
    const brackets = scanBrackets(f, g0, g1, GRID_STEP_D);
    for (let i = 0; i < brackets.length; i++) {
      const [a, b] = brackets[i];
      let t;
      try { t = brentRoot(f, a, b, ROOT_OPTS); } catch { continue; }
      const fa = a === b ? f(a - 0.25) : f(a);
      const S = at(t, needs);
      const value = {
        phase: fa > 0 ? 'retrograde-start' : 'retrograde-end',
        elongationDeg: elongationRad(S, p) * RAD,
        side: elongationSide(S, p),
        geocentricLongitudeDeg: geocentricLongitudeRad(S, p) * RAD,
      };
      out.push(makeEvent(ctx, 'stationary', [p], t, value));
    }
  }
}

/**
 * Geocentric planet parades (experimental, plan row 8; research §A.5 "N planets with elongation > ~10° on the same
 * side"): on the daily grid, count the planets with ψ > 10° in the evening (E) and morning (W) sky; every maximal
 * run of days with N ≥ GEO_PARADE_MIN_N on one side is one interval event (walked beyond the scan range on demand,
 * capped at MAX_INTERVAL_WALK_D); the event instant is noon TT of the first day with the run's largest N, and
 * value.entry/exit bound the half-open interval of whole days [entry, exit) at 0h TT.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectGeoParades(ctx, out) {
  const { g0, n, day } = ctx;
  const gp = { evening: [], morning: [] };
  const sides = ['evening', 'morning'];
  const counts = [new Int8Array(n + 1), new Int8Array(n + 1)];
  for (let i = 0; i <= n; i++) {
    geocentricParade(day(i), PARADE_MIN_ELONGATION_DEG, gp);
    counts[0][i] = gp.evening.length;
    counts[1][i] = gp.morning.length;
  }
  for (let s = 0; s < 2; s++) {
    const side = sides[s], C = counts[s];
    const countAt = (j) => (j >= 0 && j <= n) ? C[j] : geocentricParade(day(j), PARADE_MIN_ELONGATION_DEG, gp)[side].length;
    let i = 0;
    while (i <= n) {
      if (C[i] < GEO_PARADE_MIN_N) { i++; continue; }
      // Run containing i: extend left (only possible at the scan edge) and right.
      let lo = i, hi = i, capped = false;
      while (i - lo < MAX_INTERVAL_WALK_D && countAt(lo - 1) >= GEO_PARADE_MIN_N) lo--;
      if (i - lo >= MAX_INTERVAL_WALK_D) capped = true;
      while (hi - i < MAX_INTERVAL_WALK_D && countAt(hi + 1) >= GEO_PARADE_MIN_N) hi++;
      if (hi - i >= MAX_INTERVAL_WALK_D) capped = true;
      let peak = lo, best = -1;
      for (let j = lo; j <= hi; j++) { const cj = countAt(j); if (cj > best) { best = cj; peak = j; } }
      const members = geocentricParade(day(peak), PARADE_MIN_ELONGATION_DEG, gp)[side].slice();
      // Interval of whole days [entry, exit): entry = first 0h-TT sample with N ≥ 5, exit = the first sample after
      // the run; the event instant is noon TT of the peak day (a 0h-TT node would display as the previous UTC day).
      const tEntry = g0 + lo, tExit = g0 + hi + 1;
      const value = {
        n: best,
        side,
        members,
        days: hi - lo + 1,
        entry: capped ? null : { jdTT: tEntry, jdUtc: utcFromTt(tEntry) },
        exit: capped ? null : { jdTT: tExit, jdUtc: utcFromTt(tExit) },
      };
      out.push(makeEvent(ctx, 'geo-parade', members, g0 + peak + 0.5, value));
      i = Math.max(hi + 1, i + 1);
    }
  }
}

/**
 * Equinoxes and solstices (seasons.js; Meeus ch. 27): crossings of the Sun's apparent longitude of date λ☉ through
 * 0°/90°/180°/270°, bracketed on the daily grid with sin(λ☉ − λ_k) (alias guard cos > 0 picks the wanted crossing of
 * the two 180° apart) and refined by brentRoot on the exact ephemeris (the Earth only). Value: the Sun's apparent
 * declination (±ε at the solstices, 0 at the equinoxes) and the Earth–Sun distance.
 * @param {Ctx} ctx @param {Event[]} out
 */
function detectSeasons(ctx, out) {
  const { g0, g1, at } = ctx;
  const needs = ['earth'];
  const place = newApparentPlace();
  for (const kind of SEASON_KINDS) {
    const lam = SEASON_LONGITUDE_DEG[kind] / RAD;
    const f = (t) => Math.sin(apparentSunLongitudeDeg(at(t, needs), t) / RAD - lam);
    const c = (t) => Math.cos(apparentSunLongitudeDeg(at(t, needs), t) / RAD - lam);
    const brackets = scanBrackets(f, g0, g1, GRID_STEP_D, { aliasGuard: { sin: f, cos: c } });
    for (let i = 0; i < brackets.length; i++) {
      let t;
      try { t = brentRoot(f, brackets[i][0], brackets[i][1], ROOT_OPTS); } catch { continue; }
      if (!(c(t) > 0)) continue; // the opposite season's crossing (sin = 0 with cos = −1)
      const S = at(t, needs);
      const p = apparentPlace(S, 'sun', t, place);
      const value = {
        sunLongitudeDeg: SEASON_LONGITUDE_DEG[kind],
        sunDeclinationDeg: p.decAppDeg,
        earthDistAu: p.distAu,
        earthDistKm: p.distAu * AU_KM,
      };
      out.push(makeEvent(ctx, kind, ['earth'], t, value, true));
    }
  }
}

/**
 * Apparent geocentric longitude difference Moon − Sun at t, radians: both bodies through the same apparent-place
 * reduction (apparent.js) so light-time, aberration, precession and nutation are treated alike (precession and nutation
 * cancel in the difference; the Sun's 20″ aberration shifts a quarter by ≈ 40 s, which is why the geometric
 * J2000 difference is not used).
 * @param {Ctx} ctx @param {number} t @param {{sun: import('./apparent.js').ApparentPlace, moon: import('./apparent.js').ApparentPlace}} scr
 * @returns {number} radians in (−π, π]
 */
function moonSunDeltaLon(ctx, t, scr) {
  const S = ctx.earthNear(t);
  const m = ctx.moonAt(t);
  MOON_HELIO.x = S.earth.x + m.x; MOON_HELIO.y = S.earth.y + m.y; MOON_HELIO.z = S.earth.z + m.z;
  MOON_HELIO.vx = S.earth.vx + m.vx; MOON_HELIO.vy = S.earth.vy + m.vy; MOON_HELIO.vz = S.earth.vz + m.vz;
  LUNAR_STATES.sun = S.sun; LUNAR_STATES.earth = S.earth; LUNAR_STATES.moon = MOON_HELIO;
  const ps = apparentPlace(LUNAR_STATES, 'sun', t, scr.sun);
  const pm = apparentPlace(LUNAR_STATES, 'moon', t, scr.moon);
  let d = (pm.lonAppDeg - ps.lonAppDeg) / RAD;
  if (d > Math.PI) d -= 2 * Math.PI; else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
const MOON_HELIO = newState();
/** @type {States} */
const LUNAR_STATES = {};

/**
 * Lunar phases, perigee/apogee and eclipses (Meeus ch. 49, 50, 54; eclipses.js):
 *  - phases: zeros of sin(D) and cos(D), D = apparent λ☾ − λ☉ (new 0°, first quarter 90°, full 180°, last quarter
 *    270°; D advances 12.2°/day so the daily grid brackets every crossing, the sin/cos alias guard tells the pairs
 *    apart); value: Moon distance, apparent diameter, illuminated fraction, elongation;
 *  - eclipses: around each new (full) Moon the minimum of the solar (lunar) shadow-axis distance within ±0.25 d is the
 *    greatest eclipse; emitted when eclipses.classify* says the shadow reaches the Earth / the Moon;
 *  - apsides: zeros of the geocentric r·ṙ, − → + perigee, + → − apogee (Meeus ch. 50 defines them by the distance).
 * The Earth at off-grid instants comes from ctx.earthNear (Taylor step, see the header); nothing here evaluates the
 * planetary series off the grid.
 * @param {Ctx} ctx @param {Event[]} out @param {Set<string>} wanted
 */
function detectLunar(ctx, out, wanted) {
  const { g0, g1, moonAt, earthNear } = ctx;
  const scr = { sun: newApparentPlace(), moon: newApparentPlace() };
  const illum = { phaseAngleDeg: 0, illuminatedFraction: 0, elongationDeg: 0 };
  const sunGeo = [0, 0, 0];
  const wantPhases = PHASE_KINDS.some((k) => wanted.has(k));
  const wantSolar = wanted.has('solar-eclipse'), wantLunar = wanted.has('lunar-eclipse');

  /** Phase value block at t (distance, diameter, illumination). */
  function phaseValue(t, elongationDeg) {
    const S = earthNear(t), m = moonAt(t);
    sunGeo[0] = -S.earth.x; sunGeo[1] = -S.earth.y; sunGeo[2] = -S.earth.z;
    moonIllumination(m, sunGeo, illum);
    const distKm = Math.hypot(m.x, m.y, m.z) * AU_KM;
    return {
      elongationDeg,
      distKm,
      angularDiameterArcmin: moonAngularDiameterDeg(distKm) * 60,
      illuminatedFraction: illum.illuminatedFraction,
      phaseAngleDeg: illum.phaseAngleDeg,
    };
  }

  if (wantPhases || wantSolar || wantLunar) {
    const fs = (t) => Math.sin(moonSunDeltaLon(ctx, t, scr));
    const fc = (t) => Math.cos(moonSunDeltaLon(ctx, t, scr));
    // New and full Moons: sin D = 0, cos D = ±1
    const syzygies = scanBrackets(fs, g0, g1, GRID_STEP_D, { aliasGuard: { sin: fs, cos: fc } });
    for (let i = 0; i < syzygies.length; i++) {
      let t;
      try { t = brentRoot(fs, syzygies[i][0], syzygies[i][1], ROOT_OPTS); } catch { continue; }
      const isNew = fc(t) > 0;
      if (wantPhases) {
        const kind = isNew ? 'moon-new' : 'moon-full';
        const value = phaseValue(t, isNew ? 0 : 180);
        if (!isNew) value.supermoon = value.distKm < SUPERMOON_MAX_DIST_KM;
        out.push(makeEvent(ctx, kind, ['moon'], t, value, !isNew));
      }
      if (isNew ? wantSolar : wantLunar) detectEclipseNear(ctx, out, t, isNew, scr);
    }
    if (wantPhases) {
      // Quarters: cos D = 0, sin D = ±1
      const quarters = scanBrackets(fc, g0, g1, GRID_STEP_D, { aliasGuard: { sin: fc, cos: fs } });
      for (let i = 0; i < quarters.length; i++) {
        let t;
        try { t = brentRoot(fc, quarters[i][0], quarters[i][1], ROOT_OPTS); } catch { continue; }
        const first = fs(t) > 0;
        out.push(makeEvent(ctx, first ? 'moon-first-quarter' : 'moon-last-quarter', ['moon'], t, phaseValue(t, first ? 90 : 270), true));
      }
    }
  }

  if (MOON_APSIS_KINDS.some((k) => wanted.has(k))) {
    const f = (t) => { const m = moonAt(t); return m.x * m.vx + m.y * m.vy + m.z * m.vz; };
    const brackets = scanBrackets(f, g0, g1, GRID_STEP_D);
    for (let i = 0; i < brackets.length; i++) {
      const [a, b] = brackets[i];
      let t;
      try { t = brentRoot(f, a, b, ROOT_OPTS); } catch { continue; }
      const fa = a === b ? f(a - 0.25) : f(a);
      const kind = fa < 0 ? 'moon-perigee' : 'moon-apogee';
      const m = moonAt(t);
      const S = earthNear(t);
      sunGeo[0] = -S.earth.x; sunGeo[1] = -S.earth.y; sunGeo[2] = -S.earth.z;
      moonIllumination(m, sunGeo, illum);
      const distKm = Math.hypot(m.x, m.y, m.z) * AU_KM;
      const value = {
        distKm,
        distEarthRadii: distKm / body('earth').radiusEqKm,
        angularDiameterArcmin: moonAngularDiameterDeg(distKm) * 60,
        illuminatedFraction: illum.illuminatedFraction,
        elongationDeg: illum.elongationDeg,
      };
      out.push(makeEvent(ctx, kind, ['moon'], t, value, illum.elongationDeg > OBSERVABLE_MIN_ELONGATION_DEG));
    }
  }
}

const SOLAR_G = newSolarGeometry();
const LUNAR_G = newLunarGeometry();

/**
 * Greatest eclipse around a syzygy at tSyzygy: minimise the squared shadow-axis distance (solar: axis from the Sun
 * through the Moon vs the Earth's centre; lunar: axis from the Sun through the Earth vs the Moon's centre) with
 * brentMin on ±ECLIPSE_SEARCH_HALF_WIDTH_D, then classify (eclipses.js). Bodies: ['earth', 'moon'] for both kinds
 * (the Sun is implicit) so the UI frames the Earth–Moon pair.
 * @param {Ctx} ctx @param {Event[]} out @param {number} tSyzygy @param {boolean} solar
 * @param {{sun: object, moon: object}} scr
 */
function detectEclipseNear(ctx, out, tSyzygy, solar, scr) {
  const { moonAt, earthNear, minOut } = ctx;
  const dist2 = solar
    ? (t) => { const g = solarEclipseGeometry(earthNear(t).earth, moonAt(t), SOLAR_G); return g.axisDistanceEr * g.axisDistanceEr; }
    : (t) => { const g = lunarEclipseGeometry(earthNear(t).earth, moonAt(t), LUNAR_G); return g.axisDistanceEr * g.axisDistanceEr; };
  let m;
  try { m = brentMin(dist2, tSyzygy - ECLIPSE_SEARCH_HALF_WIDTH_D, tSyzygy + ECLIPSE_SEARCH_HALF_WIDTH_D, MIN_OPTS, minOut); } catch { return; }
  const t = m.x;
  if (solar) {
    const g = solarEclipseGeometry(earthNear(t).earth, moonAt(t), SOLAR_G);
    const type = classifySolar(g);
    if (type === null) return;
    const value = {
      type,
      gamma: g.gamma,
      magnitude: solarMagnitude(g),
      central: isCentral(g),
      u: g.u,
      penumbraRadiusEr: g.l1,
      moonDistKm: g.moonDistKm,
      sunDistAu: g.sunDistAu,
      moonDiameterArcmin: g.moonDiameterArcmin,
      sunDiameterArcmin: g.sunDiameterArcmin,
      jdTTNewMoon: tSyzygy,
      jdUtcNewMoon: utcFromTt(tSyzygy),
    };
    out.push(makeEvent(ctx, 'solar-eclipse', ['earth', 'moon'], t, value, true));
  } else {
    const g = lunarEclipseGeometry(earthNear(t).earth, moonAt(t), LUNAR_G);
    const type = classifyLunar(g);
    if (type === null) return;
    const value = {
      type,
      gamma: g.gamma,
      umbralMagnitude: g.umbralMagnitude,
      penumbralMagnitude: g.penumbralMagnitude,
      umbraRadiusEr: g.umbraRadiusEr,
      penumbraRadiusEr: g.penumbraRadiusEr,
      moonDistKm: g.moonDistKm,
      moonDiameterArcmin: moonAngularDiameterDeg(g.moonDistKm) * 60,
      jdTTFullMoon: tSyzygy,
      jdUtcFullMoon: utcFromTt(tSyzygy),
    };
    out.push(makeEvent(ctx, 'lunar-eclipse', ['earth', 'moon'], t, value, true));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Dedupe, merge, ordering
// ---------------------------------------------------------------------------------------------------------------------

/** @param {Event} p @param {Event} q @returns {number} */
function compareEvents(p, q) {
  return p.jdTT - q.jdTT || (p.kind < q.kind ? -1 : p.kind > q.kind ? 1 : 0) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
}

/**
 * Exact-duplicate removal by (kind, sorted bodies, minute) key, then a greedy time-ordered merge of same-kind
 * same-bodies events closer than MERGE_WINDOWS_D[kind] to the last kept one (keeping the higher score, else the
 * earlier). The output is sorted by time.
 * @param {Event[]} events @returns {Event[]}
 */
function dedupeAndMerge(events) {
  events.sort(compareEvents);
  const seen = new Set();
  /** @type {Map<string, Event>} */
  const last = new Map();
  /** @type {Event[]} */
  const kept = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const group = `${e.kind}:${e.bodies.join('+')}`;
    const prev = last.get(group);
    const window = MERGE_WINDOWS_D[e.kind] || 0;
    if (prev !== undefined && e.jdTT - prev.jdTT < window) {
      if (e.score > prev.score) { kept[kept.indexOf(prev)] = e; last.set(group, e); }
      continue;
    }
    kept.push(e);
    last.set(group, e);
  }
  kept.sort(compareEvents);
  return kept;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Scan [jdTT0, jdTT1) for alignment events (plan §Events). The scan grid is widened by SCAN_OVERLAP_D on both sides
 * so events near the edges are refined with full context; only events whose instant lies inside the window are
 * returned, sorted by time. Scanning consecutive chunks therefore yields the same events as one scan.
 * @param {ReturnType<import('./ephemeris.js').createEphemeris>} eph ephemeris instance (full tier)
 * @param {number} jdTT0 window start, JD(TT) inclusive
 * @param {number} jdTT1 window end, JD(TT) exclusive (> jdTT0)
 * @param {{kinds?: Iterable<string>, minScore?: number}} [opts] kinds = subset of KINDS to detect (default all);
 *   minScore = drop events scoring below it (default 0)
 * @returns {Event[]}
 */
export function findEvents(eph, jdTT0, jdTT1, opts = {}) {
  if (!(Number.isFinite(jdTT0) && Number.isFinite(jdTT1) && jdTT1 > jdTT0)) {
    throw new RangeError('findEvents: jdTT1 must be > jdTT0 (finite Julian dates)');
  }
  const wanted = new Set(opts.kinds === undefined ? KINDS : opts.kinds);
  for (const k of wanted) if (!KINDS.includes(k)) throw new RangeError(`findEvents: unknown kind '${k}'`);
  const minScore = opts.minScore === undefined ? 0 : opts.minScore;
  const wants = (kinds) => kinds.some((k) => wanted.has(k));

  const ctx = createContext(eph, jdTT0, jdTT1);
  /** @type {Event[]} */
  const raw = [];
  if (wants(SUN_RELATIVE_KINDS)) detectSunRelative(ctx, raw);
  if (wanted.has('greatest-elongation')) detectGreatestElongation(ctx, raw);
  if (wanted.has('pair')) detectPairs(ctx, raw);
  if (wanted.has('closest-approach')) detectClosestApproach(ctx, raw);
  if (wants(APSIS_KINDS)) detectApsides(ctx, raw);
  if (wanted.has('helio-parade')) detectHelioParades(ctx, raw);
  if (wanted.has('stationary')) detectStationary(ctx, raw);
  if (wanted.has('geo-parade')) detectGeoParades(ctx, raw);
  if (wants(SEASON_KINDS)) detectSeasons(ctx, raw);
  if (wants(LUNAR_KINDS)) detectLunar(ctx, raw, wanted);

  const merged = dedupeAndMerge(raw);
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i];
    if (e.jdTT >= jdTT0 && e.jdTT < jdTT1 && wanted.has(e.kind) && e.score >= minScore) out.push(e);
  }
  return out;
}
