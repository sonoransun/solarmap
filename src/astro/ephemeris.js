// Ephemeris facade: heliocentric states of the eight planets in the SCENE frame (JPL Horizons "Ecliptic of J2000.0",
// see CLAUDE.md), built on the VSOP87A evaluator. Data-injected: `createEphemeris(SERIES, {meta})` so the series is
// imported once by the main thread and handed to the events worker by postMessage.
//
// Pipeline per call: jdTT → jdTdb = jdTT + (TDB−TT)/86400 (time.js tdbMinusTt) → vsop87.evalRaw (dynamical ecliptic
//                    J2000, AU, AU/day) → rotate position AND velocity with M_VSOP_TO_ECL (frames.js; constant matrix,
//                    so v rotates alike).
// The Moon (moon.js, Meeus ch. 47, geocentric) is available as 'moon' = Earth + geocentric offset through state() and
// position() always, and through states() when the instance is created with `{moon: true}` (the events worker keeps
// the planet-only memo; main.js opts in for rendering).
import { DAY_S } from './constants.js';
import { vsopToEcliptic } from './frames.js';
import { tdbMinusTt } from './time.js';
import { moonState } from './moon.js';
import { createEvaluator, BODY_KEYS } from './vsop87.js';

/** The eight planets, Sun-outward (VSOP87 body-code order). */
export const PLANETS = Object.freeze(BODY_KEYS.slice());

/** All bodies with a state: the Sun (origin, at rest) followed by the eight planets. */
export const BODIES = Object.freeze(['sun', ...PLANETS]);

/** BODIES followed by the Moon — the key list of states() for an instance created with `{moon: true}`. */
export const BODIES_WITH_MOON = Object.freeze([...BODIES, 'moon']);

/**
 * Sidereal orbital periods in days — NSSDC planetary fact sheets (https://nssdc.gsfc.nasa.gov/planetary/factsheet/
 * <planet>fact.html, "Sidereal orbit period"), as tabulated in the constants research. Used for orbit-line sampling
 * spans and event merge windows; not for positions.
 */
export const ORBITAL_PERIOD_DAYS = Object.freeze({
  mercury: 87.969,
  venus: 224.701,
  earth: 365.256,
  mars: 686.980,
  jupiter: 4332.589,
  saturn: 10755.699,
  uranus: 30685.400,
  neptune: 60189.018,
});

/**
 * @typedef {{x:number, y:number, z:number, vx:number, vy:number, vz:number}} State
 *   Heliocentric position (AU) and velocity (AU/day) in the scene frame.
 */

/** @returns {State} */
function newState() {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
}

const EVAL_OPTS = Object.freeze({
  full: Object.freeze({ tier: 'full', velocity: true }),
  display: Object.freeze({ tier: 'display', velocity: true }),
});
const EVAL_OPTS_POS = Object.freeze({
  full: Object.freeze({ tier: 'full', velocity: false }),
  display: Object.freeze({ tier: 'display', velocity: false }),
});

/**
 * @param {Record<string, {x:number[][], y:number[][], z:number[][]}>} SERIES the generated VSOP87A data (SERIES export)
 * @param {{meta?: object, tier?: 'full'|'display', moon?: boolean}} [options] `meta` = the data module's META
 *   (display-tier prefix counts); `tier` = default tier for every call (default 'full'; 'display' is the ≈1e-7 AU
 *   orbit-line tier); `moon` = include 'moon' (heliocentric: Earth + moon.js geocentric Moon) in states()
 * @returns {{
 *   state: (body: string, jdTT: number, out?: State, tier?: 'full'|'display') => State,
 *   position: (body: string, jdTT: number, out?: number[], tier?: 'full'|'display') => number[],
 *   states: (jdTT: number, out?: Record<string, State>, tier?: 'full'|'display') => Record<string, State>,
 *   moonGeocentric: (jdTT: number, out?: State) => State,
 *   bodies: readonly string[],
 *   moon: boolean,
 *   tier: 'full'|'display',
 *   evaluator: ReturnType<typeof createEvaluator>,
 * }}
 */
export function createEphemeris(SERIES, options = {}) {
  const defaultTier = options.tier ?? 'full';
  if (defaultTier !== 'full' && defaultTier !== 'display') throw new RangeError(`ephemeris: unknown tier '${defaultTier}'`);
  const withMoon = options.moon === true;
  const bodies = withMoon ? BODIES_WITH_MOON : BODIES;
  const evaluator = createEvaluator(SERIES, options.meta);

  // Scratch storage so the per-frame path allocates nothing.
  const raw = newState();
  const pIn = [0, 0, 0], pOut = [0, 0, 0];
  const vIn = [0, 0, 0], vOut = [0, 0, 0];
  const moonGeo = newState();   // geocentric Moon (moon.js output) — never the caller's `out`
  const moonHelio = newState(); // heliocentric Moon for position()

  /** @param {number} jdTT @returns {number} JD(TDB) */
  function jdTdbFromTt(jdTT) {
    return jdTT + tdbMinusTt(jdTT) / DAY_S;
  }

  /**
   * Geocentric state of the Moon (moon.js: Meeus ch. 47 rotated to the scene frame), AU and AU/day.
   * @param {number} jdTT Julian date, Terrestrial Time
   * @param {State} [out] reused target object
   * @returns {State}
   */
  function moonGeocentric(jdTT, out = newState()) {
    return moonState(jdTT, out);
  }

  /**
   * Heliocentric state of one body in the scene frame.
   * @param {string} body one of BODIES ('sun' → origin, zero velocity) or 'moon' (Earth + geocentric Moon)
   * @param {number} jdTT Julian date, Terrestrial Time
   * @param {State} [out] reused target object
   * @param {'full'|'display'} [tier] series tier (defaults to the ephemeris' tier)
   * @returns {State}
   */
  function state(body, jdTT, out = newState(), tier = defaultTier) {
    if (body === 'sun') {
      out.x = 0; out.y = 0; out.z = 0; out.vx = 0; out.vy = 0; out.vz = 0;
      return out;
    }
    if (body === 'moon') {
      state('earth', jdTT, out, tier);
      const m = moonState(jdTT, moonGeo);
      out.x += m.x; out.y += m.y; out.z += m.z;
      out.vx += m.vx; out.vy += m.vy; out.vz += m.vz;
      return out;
    }
    const opts = EVAL_OPTS[tier];
    if (opts === undefined) throw new RangeError(`ephemeris: unknown tier '${tier}'`);
    evaluator.evalRaw(body, jdTdbFromTt(jdTT), opts, raw);
    pIn[0] = raw.x; pIn[1] = raw.y; pIn[2] = raw.z;
    vIn[0] = raw.vx; vIn[1] = raw.vy; vIn[2] = raw.vz;
    vsopToEcliptic(pIn, pOut);
    vsopToEcliptic(vIn, vOut);
    out.x = pOut[0]; out.y = pOut[1]; out.z = pOut[2];
    out.vx = vOut[0]; out.vy = vOut[1]; out.vz = vOut[2];
    return out;
  }

  /**
   * Heliocentric position only (skips the sine sums) as a plain [x, y, z] array in AU, scene frame.
   * @param {string} body one of BODIES
   * @param {number} jdTT Julian date, Terrestrial Time
   * @param {number[]} [out] reused length-3 array
   * @param {'full'|'display'} [tier]
   * @returns {number[]}
   */
  function position(body, jdTT, out = [0, 0, 0], tier = defaultTier) {
    if (body === 'sun') {
      out[0] = 0; out[1] = 0; out[2] = 0;
      return out;
    }
    if (body === 'moon') {
      const s = state('moon', jdTT, moonHelio, tier);
      out[0] = s.x; out[1] = s.y; out[2] = s.z;
      return out;
    }
    const opts = EVAL_OPTS_POS[tier];
    if (opts === undefined) throw new RangeError(`ephemeris: unknown tier '${tier}'`);
    evaluator.evalRaw(body, jdTdbFromTt(jdTT), opts, raw);
    pIn[0] = raw.x; pIn[1] = raw.y; pIn[2] = raw.z;
    return vsopToEcliptic(pIn, out);
  }

  /** @type {Record<string, State>} */
  const memo = {};
  for (const b of bodies) memo[b] = newState();
  let memoJd = NaN;
  let memoTier = '';

  /**
   * States of every body (Sun + 8 planets, plus 'moon' for a `{moon: true}` instance) at one instant. Without `out`
   * the result is an internal object memoised on (jdTT, tier): the same instant returns the same object without
   * re-evaluating, a new instant overwrites it in place (copy what you need to keep). Pass `out` (an object with a
   * State per body, created on demand) to bypass the memo.
   * @param {number} jdTT Julian date, Terrestrial Time
   * @param {Record<string, State>} [out]
   * @param {'full'|'display'} [tier]
   * @returns {Record<string, State>} keyed by `bodies` (BODIES or BODIES_WITH_MOON)
   */
  function states(jdTT, out, tier = defaultTier) {
    if (out === undefined) {
      if (jdTT === memoJd && tier === memoTier) return memo;
      out = memo;
      memoJd = jdTT;
      memoTier = tier;
    }
    for (let i = 0; i < BODIES.length; i++) {
      const b = BODIES[i];
      out[b] = state(b, jdTT, out[b] ?? newState(), tier);
    }
    if (withMoon) {
      // Earth is already evaluated above: add the geocentric Moon without a second series evaluation.
      const e = out.earth;
      const m = moonState(jdTT, moonGeo);
      const o = out.moon ?? (out.moon = newState());
      o.x = e.x + m.x; o.y = e.y + m.y; o.z = e.z + m.z;
      o.vx = e.vx + m.vx; o.vy = e.vy + m.vy; o.vz = e.vz + m.vz;
    }
    return out;
  }

  return { state, position, states, moonGeocentric, bodies, moon: withMoon, tier: defaultTier, evaluator };
}
