// Curated tours (data for the story engine, src/app/story.js). Pure: no DOM, no three.js; imports only src/astro.
//
// Rules of this file
//  - Every instant a tour visits comes from VERIFIED (a real event the test suite checks against
//    test/fixtures/events.json, which carries JPL Horizons / almanac provenance per row) or from EPOCHS (a date chosen
//    for a view, with the reason and a checkable expectation). No chapter carries a hand-typed date.
//  - Captions are one plain idea for a curious non-expert (≤ 110 characters); the detail line (≤ 140 characters) is
//    computed live from the ephemeris whenever a number is involved (ctx.bodyInfo / ctx.format), so every figure on
//    screen is the model's own value for the instant shown.
//  - Overview chapters ask for planets drawn 50× larger (settings.sizeK = 50) and say so; sky views ask for true
//    scale, because a telescope view of two discs 6′ apart only makes sense at real angular sizes.
//  - Each fact in a caption carries its source in a comment next to it.
import { jdFromCalendar } from '../astro/time.js';
import { RATES } from '../astro/clock.js';
import { LIGHT_TIME_AU_S } from '../astro/constants.js';
import { groupThousands } from '../astro/format.js';

// ---------------------------------------------------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------------------------------------------------

/**
 * JD(UTC) of an ISO-like instant 'YYYY-MM-DDTHH:MM[:SS]' (UTC, proleptic Gregorian) — the same parser rule as
 * test/events.test.mjs so a table entry and its fixture row are read identically.
 * @param {string} s
 * @returns {number}
 */
export function jdOfIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) throw new RangeError(`tours: instant '${s}' must be YYYY-MM-DD[THH:MM[:SS]]`);
  return jdFromCalendar(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/**
 * @typedef {object} VerifiedInstant
 * @property {string} kind       events.js kind (matches the fixture row)
 * @property {string[]} bodies   Sun-outward body ids (matches the fixture row; empty for date-only rows)
 * @property {string} utc        'YYYY-MM-DDTHH:MM[:SS]'
 * @property {number} jdUtc
 * @property {boolean} dateOnly  the fixture row carries a date (tolDays), not an instant
 * @property {string} source
 */

/** @param {Omit<VerifiedInstant, 'jdUtc'|'dateOnly'> & { dateOnly?: boolean }} v @returns {VerifiedInstant} */
function verified(v) {
  return Object.freeze({ ...v, dateOnly: !!v.dateOnly, jdUtc: jdOfIso(v.utc) });
}

/**
 * Verified instants used by the tours. Each is a geometric instant from JPL Horizons (VEC_CORR=NONE, the same model
 * class as this app's VSOP87 pipeline) recorded in test/fixtures/events.json with its tolerance; test/tours.test.mjs
 * asserts every entry against its fixture row (kind + bodies → utc within tolMin, or date within tolDays).
 */
export const VERIFIED = Object.freeze({
  /** Mars at opposition (geometric), fixture tolMin 3; apparent almanac value 01 h–02:38 (research §C1). */
  marsOpposition2025: verified({ kind: 'opposition', bodies: ['mars'], utc: '2025-01-16T02:31', source: 'JPL Horizons geometric minimum, events.json geometric row' }),
  /** Mars closest to Earth, 55 758 006 km: seds.org 09:51:14 UT; Horizons geometric 09:51:12 UT; NASA Hubble:
   * "closest … in nearly 60,000 years" (https://science.nasa.gov/missions/hubble/mars-closest-encounter/). */
  marsClosest2003: verified({ kind: 'closest-approach', bodies: ['mars'], utc: '2003-08-27T09:51:12', source: 'JPL Horizons geometric minimum 2003-08-27 09:51:12 UT, 55 758 005.7 km; seds.org; NASA Hubble' }),
  /** Transit of Venus: geometric inferior conjunction 01:02 UT (apparent 01:08); greatest transit 01:29:36 UT
   * (https://eclipse.gsfc.nasa.gov/OH/transit12.html). Venus is on the solar disc from 22:09 to 04:49 UT. */
  venusTransit2012: verified({ kind: 'inferior-conjunction', bodies: ['venus'], utc: '2012-06-06T01:02', source: 'JPL Horizons geometric λ-conjunction; NASA GSFC transit12' }),
  /** Great conjunction: geometric minimum separation 18:11 UT, 6.1′ (Wikipedia: closest 18:20 UTC apparent). */
  greatConjunction2020: verified({ kind: 'pair', bodies: ['jupiter', 'saturn'], utc: '2020-12-21T18:11', source: 'JPL Horizons geometric minimum separation; Wikipedia "Great conjunction"' }),
  /** Venus–Jupiter conjunction, 51.6′ (geometric minimum). */
  venusJupiter2025: verified({ kind: 'pair', bodies: ['venus', 'jupiter'], utc: '2025-08-12T06:37', source: 'JPL Horizons geometric minimum separation' }),
  /** The "seven-planet parade" evening of 28 February 2025 (Sky at Night Magazine; fixture geo-parade row, date
   * only). 18:00 UT is a European dusk; the geometry changes imperceptibly over the day. */
  parade2025: verified({ kind: 'geo-parade', bodies: ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'], utc: '2025-02-28T18:00', dateOnly: true, source: 'https://www.skyatnightmagazine.com/news/seven-planet-parade-28-february-2025; events.json geo-parade row' }),
});

/**
 * Dates chosen for what they show, not events. Each states why and an expectation test/tours.test.mjs checks with the
 * app's own ephemeris + orientation model.
 */
export const EPOCHS = Object.freeze({
  /** Saturn's rings wide open: northern-summer solstice was 2017-05-24 (NASA/JPL, Cassini "Saturn solstice"); the
   * sub-solar latitude B′ computed by this app (IAU 2015 pole + VSOP87) is +26.73° on 2017-06-15 (the maximum
   * possible, Saturn's obliquity 26.73°). The ring plane crossed the Sun on 2025-05-06 (B′ = 0, edge-on), B′ is only
   * −8° in late 2026, and the southern maximum −26.7° returns in April 2032. */
  saturnRingsOpen2017: Object.freeze({
    utc: '2017-06-15T00:00',
    jdUtc: jdOfIso('2017-06-15T00:00'),
    why: 'Saturn northern-summer solstice (2017-05-24): rings tipped the full 26.7° toward the Sun; edge-on in 2025, −8° in 2026, open again (southern face) in 2032',
    expect: Object.freeze({ body: 'saturn', minAbsSubSolarLatDeg: 25 }),
  }),
});

// ---------------------------------------------------------------------------------------------------------------------
// Constants quoted in captions (each with its source)
// ---------------------------------------------------------------------------------------------------------------------

/** Below this |sub-solar latitude| Saturn's rings look nearly edge-on; the Planets tour then jumps to EPOCHS.saturnRingsOpen2017. */
export const RING_OPEN_MIN_DEG = 15;
/** Proxima Centauri distance: Gaia DR3 parallax 768.0665 mas (Gaia Collaboration 2023, source id 5853498713190525696)
 * → 1/0.7680665 pc × 206 264.806 AU/pc = 268 553 AU = 4.2465 light-years. */
export const PROXIMA_AU = 268553;
/** Planet size exaggeration for overview chapters (captions say "drawn 50× larger"). */
export const OVERVIEW_SIZE_K = 50;

/** Settings bundles (restored by the engine when a chapter stops asking for them). */
const OVERVIEW = Object.freeze({ sizeK: OVERVIEW_SIZE_K });
const TRUE_SCALE = Object.freeze({ sizeK: 1 });
/** Earth chapters draw the spin axis and sub-solar dot (the scene's orientation overlay). */
const EARTH_AXIS = Object.freeze({ sizeK: OVERVIEW_SIZE_K, showOrientationDebug: true });

/** Slow auto-rotate while following a world (rig.orbitDwell; skipped under reduced motion by the engine). */
const DWELL = Object.freeze({ degPerS: 4 });

// ---------------------------------------------------------------------------------------------------------------------
// Live-detail helpers (every number computed for the instant shown)
// ---------------------------------------------------------------------------------------------------------------------

/** @param {any} ctx @param {string} id @returns {string} '5.2000 AU from the Sun · sunlight takes 43 min 16 s to arrive · moving at 13.07 km/s' */
function sunLine(ctx, id) {
  const info = ctx.bodyInfo(id);
  if (!info || !Number.isFinite(info.rSunAu)) return '';
  const f = ctx.format;
  return `${f.au(info.rSunAu)} from the Sun · sunlight takes ${f.lightTime(info.rSunAu * LIGHT_TIME_AU_S)} to arrive · moving at ${f.kmPerS(info.orbitalSpeedKmS)}`;
}

/** @param {any} ctx @param {string} a @param {string} b @param {string} label @returns {string} 'Earth–Mars 0.6428 AU · 96.16 M km · 5 min 21 s' */
function distanceLine(ctx, a, b, label) {
  const au = ctx.distanceAu(a, b);
  return Number.isFinite(au) ? `${label} ${ctx.format.distance(au)}` : '';
}

/** Sub-solar latitude of Earth as a sentence. @param {any} ctx @returns {string} */
function overheadLine(ctx) {
  const lat = ctx.bodyInfo('earth')?.subSolarLatDeg;
  return Number.isFinite(lat) ? `Right now the Sun is straight overhead at ${ctx.format.lonLat(lat, 'NS')}` : '';
}

/** Ring tilt sentence for Saturn (B′ = sub-solar latitude). @param {any} ctx @returns {string} */
function ringLine(ctx) {
  const b = ctx.bodyInfo('saturn')?.subSolarLatDeg;
  const base = sunLine(ctx, 'saturn');
  return Number.isFinite(b) ? `Rings tipped ${ctx.format.deg(Math.abs(b), 1)} toward the Sun · ${base}` : base;
}

/** Separation of two bodies in Earth's sky. @param {any} ctx @returns {string} '' when unavailable */
function separationText(ctx, a, b) {
  const d = ctx.separationDeg('earth', a, b);
  return Number.isFinite(d) ? ctx.format.angle(d) : '';
}

/** Sky-view camera speed / light-time while a fly-by runs, else the arrival line. @param {any} ctx @param {string} id */
function hopLine(ctx, id) {
  const fb = ctx.flyby();
  const f = ctx.format;
  if (fb && fb.target === id && Number.isFinite(fb.speedC)) {
    return `Camera at ${f.speed(fb.speedC)} · light would need ${f.lightTime(fb.lightMinutesToTarget * 60)} for what is left of this leg`;
  }
  const info = ctx.bodyInfo(id);
  if (!info) return '';
  return `Sunlight takes ${f.lightTime(info.rSunAu * LIGHT_TIME_AU_S)} to reach Neptune, and ${f.lightTime(info.earthDistAu * LIGHT_TIME_AU_S)} to come from Earth`;
}

/** Current sim date without seconds. @param {any} ctx @returns {string} */
function dateLine(ctx) {
  const jd = ctx.state()?.jdUtc;
  return Number.isFinite(jd) ? ctx.format.utc(jd, { seconds: false }) : '';
}

// ---------------------------------------------------------------------------------------------------------------------
// Chapter factories shared by several tours
// ---------------------------------------------------------------------------------------------------------------------

/** Title card chapter at the home view (chapter 0 of every tour). */
function titleCard(id, title, caption, detail, { seconds = 5, settings = OVERVIEW } = {}) {
  return {
    id, title, card: true, caption, detail, seconds, settings,
    jdUtc: (ctx) => ctx.nowJd(), rate: RATES.day, paused: false, hold: 'poseDone',
    run: (ctx) => { ctx.select(null); return ctx.resetHome(); },
  };
}

/** Mars at opposition, 16 January 2025 — top-down framing of Sun, Earth and Mars with the alignment overlay. */
function marsOpposition(caption, seconds) {
  return {
    id: 'mars-opposition', title: 'Mars at opposition', caption, seconds, settings: OVERVIEW,
    jdUtc: VERIFIED.marsOpposition2025.jdUtc, paused: true, hold: 'poseDone',
    run: (ctx) => {
      ctx.select('mars');
      ctx.overlay({ kind: 'opposition', bodies: ['mars'], label: 'Mars at opposition' });
      return ctx.frameBodies(['earth', 'mars'], { includeSun: true, polarDeg: 20, seconds: 1.5 });
    },
    // Mars shines brightest and rises at sunset around opposition (geometry: opposite the Sun in Earth's sky).
    live: (ctx) => { const d = distanceLine(ctx, 'earth', 'mars', 'Earth–Mars'); return d ? `${d} · Mars rises at sunset and shines all night` : 'Mars rises at sunset and shines all night'; },
  };
}

/** The Great Conjunction, 21 December 2020 — telescope sky view: 1.2° then eased to 0.3° so both discs resolve. */
function greatConjunction(caption, seconds) {
  return {
    id: 'great-conjunction', title: 'The Great Conjunction', caption, seconds, settings: TRUE_SCALE,
    jdUtc: VERIFIED.greatConjunction2020.jdUtc, paused: true, hold: 'skyReady',
    run: (ctx) => { ctx.select('jupiter'); return ctx.skyView('earth', ['jupiter', 'saturn'], { fovDeg: 1.2, animateS: 1.0 }); },
    cues: [{ t: 4, run: (ctx) => ctx.setSkyFov(0.3, 2.5) }],
    // "Closest since 1623": Wikipedia "Great conjunction" (1623 pair 5′ apart but lost in the Sun's glare; closest
    // easily observable since 1226).
    live: (ctx) => { const s = separationText(ctx, 'jupiter', 'saturn'); return `${s ? `Separation ${s} · ` : ''}the closest pairing since 1623 · zooming in to a telescope's view`; },
  };
}

/** Home view, clock back to now at one day per second (every tour's last chapter). */
function finale(caption, detail, seconds = 6) {
  return {
    id: 'finale', title: 'Back to today', caption, detail, seconds, settings: OVERVIEW,
    jdUtc: (ctx) => ctx.nowJd(), rate: RATES.day, paused: false,
    run: (ctx) => { ctx.select(null); ctx.resetHome(); },
  };
}

/** One world of the Planets tour: fly there, hold the arrival, dwell with a slow orbit. */
function world(id, title, caption, extra = {}) {
  return {
    id, title, caption, seconds: 11, rate: RATES.hour, paused: false, hold: 'arrived', settings: OVERVIEW,
    run: (ctx) => { ctx.select(id); return ctx.flyTo(id); },
    arrived: (ctx) => ctx.orbitDwell(DWELL),
    end: (ctx) => ctx.stopDwell(),
    live: (ctx) => sunLine(ctx, id),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Welcome (autoplay on first load) ≈ 90 s
// ---------------------------------------------------------------------------------------------------------------------
const WELCOME = Object.freeze({
  id: 'welcome',
  title: 'Welcome',
  tagline: 'The real solar system, computed live',
  chapters: [
    titleCard('title', 'Solar Map',
      'The real solar system, computed live: every planet exactly where it is right now.',
      // VSOP87 (Bretagnon & Francou 1988) is the planetary theory; the test suite compares it with JPL Horizons.
      'Positions from the VSOP87 planetary theory, checked against NASA/JPL Horizons. Planets drawn 50× larger than life.',
      { seconds: 6 }),
    {
      id: 'closer', title: 'Closer in', seconds: 6, settings: OVERVIEW,
      caption: 'Closer in. The four rocky planets huddle near the Sun; the giants circle far out in the cold.',
      run: (ctx) => ctx.dollyTo(6, 5),
      live: (ctx) => { const e = ctx.bodyInfo('earth'); const d = dateLine(ctx); return e ? `${d}${d ? ' · ' : ''}Earth is ${ctx.format.au(e.rSunAu)} from the Sun today` : d; },
    },
    {
      id: 'month', title: 'A month a second', seconds: 7, rate: RATES.month, paused: false, settings: OVERVIEW,
      caption: 'A month every second: Mercury and Venus race round while the outer planets barely move.',
      // Orbital periods: Mercury 87.969 d, Earth 365.256 d, Neptune 164.8 y (NSSDC planetary fact sheets).
      detail: 'Mercury’s year is 88 days, Earth’s 365, Neptune’s 165 years: the closer to the Sun, the faster the orbit.',
    },
    {
      id: 'earth', title: 'Earth', seconds: 8, rate: RATES.hour, paused: false, hold: 'arrived', settings: EARTH_AXIS,
      // Sidereal day 23 h 56 min 04 s (GMST rate 360.98564736629°/d); obliquity 23.44° (IAU 2006, J2000 23.4393°).
      caption: 'Earth: one turn every 23 hours 56 minutes, its axis tilted 23.4°. That tilt makes the seasons.',
      run: (ctx) => { ctx.select('earth'); return ctx.flyTo('earth'); },
      arrived: (ctx) => ctx.orbitDwell(DWELL),
      end: (ctx) => ctx.stopDwell(),
      live: (ctx) => { const o = overheadLine(ctx); return o ? `${o} · time runs at one hour per second` : 'Time runs at one hour per second'; },
    },
    marsOpposition('16 January 2025, 02:31 UTC: Mars at opposition. Sun, Earth and Mars in a line, Earth in the middle.', 9),
    greatConjunction('21 December 2020: the Great Conjunction. From Earth, Jupiter and Saturn looked almost like one star.', 11),
    {
      id: 'saturn', title: 'Saturn', seconds: 9, rate: RATES.hour, paused: false, hold: 'arrived', settings: OVERVIEW,
      // Main rings span 2 × 136 780 km (A-ring outer edge, bodies.js SATURN_RINGS) ≈ 270 000 km; they are mostly
      // water ice (Cassini). In December 2020 the rings were tipped 20° toward the Sun (this app's model).
      caption: 'Saturn, that same December. Rings 270 000 km across, mostly water ice, tipped toward the Sun.',
      run: (ctx) => { ctx.select('saturn'); return ctx.flyTo('saturn'); },
      arrived: (ctx) => ctx.orbitDwell(DWELL),
      end: (ctx) => ctx.stopDwell(),
      live: ringLine,
    },
    {
      id: 'neptune', title: 'Neptune', seconds: 8, settings: OVERVIEW, hold: 'arrived',
      caption: 'Neptune, four light-hours from the Sun. We make the hop in seconds; light would take hours.',
      run: (ctx) => { ctx.select('neptune'); return ctx.flyTo('neptune'); },
      arrived: (ctx) => ctx.orbitDwell(DWELL),
      end: (ctx) => ctx.stopDwell(),
      live: (ctx) => hopLine(ctx, 'neptune'),
    },
    {
      id: 'year', title: 'A year a second', seconds: 6, rate: RATES.year, paused: false, settings: OVERVIEW,
      // Start `seconds` years before now so the racing clock lands on today exactly when the chapter ends.
      jdUtc: (ctx) => ctx.nowJd() - ctx.chapterSeconds() * RATES.year,
      caption: 'A year every second. The years fly past, and the clock catches up with today.',
      run: (ctx) => { ctx.select(null); ctx.resetHome(); },
      live: dateLine,
    },
    finale('Back to today. Your turn: drag to orbit, scroll to zoom, click a planet. More tours under ▶ Tours.',
      'Space pauses a tour, ← → skip chapters, Esc leaves it. The Events tab lists the next alignments.'),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Planets — Sun to Neptune ≈ 2½ min
// ---------------------------------------------------------------------------------------------------------------------
const PLANETS = Object.freeze({
  id: 'planets',
  title: 'The planets',
  tagline: 'Sun to Neptune: one fact per world, every number live',
  chapters: [
    titleCard('title', 'The planets',
      'Nine stops, Sun to Neptune. Every number along the way is computed for this very moment.',
      'Planets drawn 50× larger than life on the way in; between worlds the camera flies faster than light.'),
    world('sun', 'The Sun',
      // NASA "Sun: In Depth": 99.8 % of the solar system's mass; 109 Earth diameters (1 391 400 km, IAU 2015 radius).
      'The Sun holds 99.8 % of all the mass in the solar system. Everything else is leftovers.',
      // Equatorial sidereal rotation 25.38 d = 360° / 14.1844°/d (IAU 2015 W rate, bodies.js).
      { live: undefined, detail: 'Diameter 1.39 million km, 109 Earths across · spins once in 25.4 days at the equator' }),
    world('mercury', 'Mercury',
      // Orbit 87.969 d; sidereal rotation 58.646 d (NSSDC Mercury fact sheet; IAU 2015 W rate 6.1385108°/d).
      'Mercury hurries round the Sun in 88 days but turns on its axis only once every 59 days.'),
    world('venus', 'Venus',
      // Retrograde rotation −243.02 d (IAU 2015 W rate −1.4813688°/d); orbit 224.701 d (NSSDC).
      'Venus spins backwards, and so slowly that its day (243 Earth days) outlasts its year (225 days).'),
    world('earth', 'Earth',
      'Earth: one turn every 23 hours 56 minutes, tilted 23.4°. The tilt, not the distance, gives us seasons.',
      { settings: EARTH_AXIS, live: (ctx) => { const o = overheadLine(ctx); const s = sunLine(ctx, 'earth'); return o ? `${o} · ${s}` : s; } }),
    world('mars', 'Mars',
      // Sidereal rotation 24.6229 h = 24 h 37 min; orbit 686.98 d (NSSDC Mars fact sheet); moons Phobos and Deimos.
      'Mars: a day of 24 hours 37 minutes, a year of 687 days, and two tiny potato-shaped moons.'),
    world('jupiter', 'Jupiter',
      // System III rotation 9.925 h (NSSDC); mass 1898.13e24 kg = 317.8 Earth masses (NSSDC).
      'Jupiter spins in under 10 hours, the fastest of the planets, and weighs 318 Earths.'),
    world('saturn', 'Saturn',
      (ctx) => (ctx.memo.saturnJumped
        // Mean density 687 kg/m³ < 1000 kg/m³ (NSSDC Saturn fact sheet).
        ? 'Saturn in June 2017, when its rings were tipped wide open. It is lighter than water: it would float.'
        : 'Saturn: rings of ice 270 000 km across. The planet is lighter than water: it would float.'),
      {
        // Date-aware: after the 2025 ring-plane crossing the rings are nearly edge-on for years; when the model's ring
        // tilt is small we show Saturn at EPOCHS.saturnRingsOpen2017 and the caption says so.
        jdUtc: (ctx) => {
          const b = ctx.bodyInfo('saturn')?.subSolarLatDeg;
          const open = Number.isFinite(b) && Math.abs(b) >= RING_OPEN_MIN_DEG;
          ctx.memo.saturnJumped = !open;
          return open ? undefined : EPOCHS.saturnRingsOpen2017.jdUtc;
        },
        live: ringLine,
      }),
    world('uranus', 'Uranus',
      // Obliquity 97.77° (NSSDC); orbit 84.0 y → ≈ 42 years of continuous daylight per pole (NASA Uranus facts).
      'Uranus rolls along on its side: its axis is tipped 98°, so each pole gets 42 years of daylight.'),
    world('neptune', 'Neptune',
      // Orbit 164.8 y (NSSDC 60 189 d); winds up to ≈ 2 000 km/h (NASA Neptune facts).
      'Neptune takes 165 years to circle the Sun; its winds blow at 2 000 km/h, the fastest known.'),
    finale('That is the neighbourhood. Back to today: pick any world in the Bodies tab to follow it yourself.',
      'Select a body and press F to fly there; the timeline sets how fast time runs while you watch.'),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Alignments — six real moments ≈ 2 min
// ---------------------------------------------------------------------------------------------------------------------
const ALIGNMENTS = Object.freeze({
  id: 'alignments',
  title: 'Alignments',
  tagline: 'When worlds line up: six real moments',
  chapters: [
    titleCard('title', 'Alignments',
      'Six real moments when the planets lined up, each one computed, not drawn.',
      'Every date here is checked against NASA/JPL Horizons to within a few minutes.'),
    marsOpposition('16 January 2025: Mars at opposition. Earth passes between the Sun and Mars, so Mars shines all night.', 11),
    {
      id: 'lapping', title: 'Earth laps Mars', seconds: 11, rate: RATES.month, paused: false, settings: OVERVIEW,
      // Synodic period 1 / (1/365.256 − 1/686.980) = 779.9 d ≈ 25.6 months.
      caption: 'Earth laps Mars every 26 months, and each lap brings a new opposition.',
      detail: 'Earth orbits in 365 days, Mars in 687; the inner, faster planet catches up every 780 days.',
    },
    {
      id: 'mars-closest', title: 'Mars at its closest', seconds: 11, settings: OVERVIEW,
      jdUtc: VERIFIED.marsClosest2003.jdUtc, paused: true, hold: 'poseDone',
      caption: '27 August 2003: Mars only 55.76 million km away, closer than at any time in almost 60 000 years.',
      run: (ctx) => { ctx.beam('earth', 'mars'); return ctx.frameBodies(['earth', 'mars'], { includeSun: true, polarDeg: 20, seconds: 1.5 }); },
      // Mars's orbital eccentricity 0.0934 (NSSDC): a perihelic opposition brings it ≈ 0.37 AU, an aphelic one ≈ 0.68 AU.
      live: (ctx) => { const d = distanceLine(ctx, 'earth', 'mars', 'Earth–Mars'); return `${d ? `${d} · ` : ''}Mars’s orbit is lopsided, so some oppositions bring it much closer`; },
    },
    {
      id: 'venus-transit', title: 'Transit of Venus', seconds: 10, settings: TRUE_SCALE,
      jdUtc: VERIFIED.venusTransit2012.jdUtc, paused: true, hold: 'skyReady',
      caption: '6 June 2012: Venus crosses the face of the Sun. The small black dot is a whole planet.',
      run: (ctx) => { ctx.select('venus'); return ctx.skyView('earth', ['sun', 'venus'], { fovDeg: 1.0, animateS: 1.0 }); },
      // Transit pairs 2004-06-08 / 2012-06-06; next 2117-12-11 / 2125-12-08 (NASA GSFC transit catalogue).
      detail: 'Transits of Venus come in pairs eight years apart, 2004 and 2012, and then not again until 2117.',
    },
    {
      id: 'venus-transit-motion', title: 'Six hours of transit', seconds: 10, rate: RATES.hour / 2, paused: false,
      settings: TRUE_SCALE, keep: true,
      caption: 'Six hours of transit in a few seconds, as Venus slides across the Sun’s face.',
      live: (ctx) => {
        const v = ctx.bodyInfo('venus')?.earthDistAu, s = ctx.distanceAu('earth', 'sun');
        if (!Number.isFinite(v) || !Number.isFinite(s)) return '';
        return `Venus ${ctx.format.au(v)} from Earth · Sun ${ctx.format.au(s)} · the Sun is ${(s / v).toFixed(1)}× farther behind Venus`;
      },
    },
    greatConjunction('21 December 2020: Jupiter and Saturn a fifth of a Moon-width apart in our sky, the closest since 1623.', 13),
    {
      id: 'venus-jupiter', title: 'Venus meets Jupiter', seconds: 10, settings: TRUE_SCALE,
      jdUtc: VERIFIED.venusJupiter2025.jdUtc, paused: true, hold: 'skyReady',
      caption: '12 August 2025, before dawn: Venus and Jupiter, the two brightest planets, less than a degree apart.',
      run: (ctx) => { ctx.select('venus'); return ctx.skyView('earth', ['venus', 'jupiter'], { animateS: 1.0 }); },
      live: (ctx) => {
        const s = separationText(ctx, 'venus', 'jupiter');
        const side = ctx.bodyInfo('venus')?.elongSide;
        const where = side === 'W' ? 'both in the morning sky, west of the Sun' : side === 'E' ? 'both in the evening sky, east of the Sun' : '';
        return [s ? `Separation ${s}` : '', where].filter(Boolean).join(' · ');
      },
    },
    {
      id: 'parade', title: 'Planet parade', seconds: 12, settings: TRUE_SCALE,
      jdUtc: VERIFIED.parade2025.jdUtc, paused: true, hold: 'skyReady',
      caption: '28 February 2025, after sunset: all seven other planets strung along one line across the sky.',
      run: (ctx) => { ctx.select(null); return ctx.skyView('earth', VERIFIED.parade2025.bodies, { fovDeg: 90, animateS: 1.2 }); },
      // Naked-eye: Mercury, Venus, Mars, Jupiter, Saturn; Uranus (mag 5.8) and Neptune (7.8) need optics.
      detail: 'Mercury, Venus, Mars, Jupiter and Saturn by eye; Uranus and Neptune need binoculars. The line is the ecliptic.',
    },
    finale('Back to today. The Events tab lists the next alignments, and its View button frames each one.',
      // Geometric vs apparent instants differ by light-time and aberration (events.json conventions).
      'Times here are geometric; published almanac times include light-time and can differ by a few minutes.'),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Scale & light ≈ 90 s
// ---------------------------------------------------------------------------------------------------------------------
const SCALE = Object.freeze({
  id: 'scale',
  title: 'Scale & light',
  tagline: 'How far is far? Measured in light',
  chapters: [
    titleCard('title', 'Scale & light',
      'How far apart are the planets? Let’s measure in the time light takes.',
      // c = 299 792.458 km/s (exact, SI).
      'Light covers 299 792 km every second. Planets drawn 50× larger than life so you can see them.'),
    {
      id: 'sun-earth', title: 'Sunlight', seconds: 14, settings: OVERVIEW, hold: 'poseDone',
      // Mean light-time for 1 AU = 499.005 s = 8 min 19 s (constants.js LIGHT_TIME_AU_S).
      caption: 'Sunlight takes about 8 minutes to reach Earth (8 min 19 s on average). You see the Sun as it was.',
      run: (ctx) => { ctx.beam('earth', 'sun'); return ctx.frameBodies(['earth'], { includeSun: true, polarDeg: 20, seconds: 1.5 }); },
      live: (ctx) => distanceLine(ctx, 'sun', 'earth', 'Sun–Earth'),
    },
    {
      id: 'earth-mars', title: 'Mars today', seconds: 13, settings: OVERVIEW, hold: 'poseDone',
      caption: 'Mars, right now. A radio message takes minutes to get there, and as long again for the reply.',
      run: (ctx) => { ctx.beam('earth', 'mars'); return ctx.frameBodies(['earth', 'mars'], { includeSun: true, polarDeg: 20, seconds: 1.5 }); },
      live: (ctx) => { const au = ctx.distanceAu('earth', 'mars'); return Number.isFinite(au) ? `Earth–Mars ${ctx.format.distance(au)} · round trip ${ctx.format.lightTime(2 * au * LIGHT_TIME_AU_S)}` : ''; },
    },
    {
      id: 'earth-neptune', title: 'Neptune today', seconds: 13, settings: OVERVIEW, hold: 'poseDone',
      // Voyager 2: launched 1977-08-20, Neptune closest approach 1989-08-25 (NASA/JPL Voyager mission pages).
      caption: 'Neptune: light needs about four hours to get there. Voyager 2 took twelve years.',
      run: (ctx) => { ctx.beam('earth', 'neptune'); return ctx.frameBodies(['earth', 'neptune'], { includeSun: true, polarDeg: 20, seconds: 1.5 }); },
      live: (ctx) => distanceLine(ctx, 'earth', 'neptune', 'Earth–Neptune'),
    },
    {
      id: 'hop', title: 'Faster than light', seconds: 11, settings: OVERVIEW, hold: 'arrived',
      caption: 'We make the hop in seconds: thousands of times faster than light. Nothing real can do that.',
      run: (ctx) => { ctx.beam(null); ctx.select('neptune'); return ctx.flyTo('neptune'); },
      arrived: (ctx) => ctx.orbitDwell(DWELL),
      end: (ctx) => ctx.stopDwell(),
      live: (ctx) => hopLine(ctx, 'neptune'),
    },
    {
      id: 'star', title: 'The nearest star', seconds: 13, settings: OVERVIEW,
      // PROXIMA_AU / 30 AU ≈ 8 950 ("about 9 000 times").
      caption: 'The nearest star, Proxima Centauri, is 4.2 light-years away: about 9 000 times farther than Neptune.',
      run: (ctx) => { ctx.select(null); ctx.resetHome(); },
      live: (ctx) => {
        const r = ctx.bodyInfo('neptune')?.rSunAu;
        if (!Number.isFinite(r) || !(r > 0)) return '';
        return `Proxima: ${groupThousands(PROXIMA_AU)} AU (Gaia parallax 0.768″) · Neptune today: ${ctx.format.au(r)} · that is ${groupThousands(PROXIMA_AU / r)}× farther`;
      },
    },
    finale('Back to today. Shift-click any two planets to measure the distance between them yourself.',
      'The Distances tab lists every pair in AU, kilometres and light-time.'),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Seasons ≈ 60 s (no fixed dates: the live sub-solar latitude tells the story at any epoch)
// ---------------------------------------------------------------------------------------------------------------------
const SEASONS = Object.freeze({
  id: 'seasons',
  title: 'Seasons',
  tagline: 'Why Earth has summers and winters',
  chapters: [
    {
      id: 'title', title: 'Seasons', card: true, seconds: 6, settings: EARTH_AXIS,
      jdUtc: (ctx) => ctx.nowJd(), rate: RATES.hour, paused: false, hold: 'arrived',
      caption: 'Earth’s axis leans 23.4° and keeps pointing the same way all year. That is the whole story.',
      detail: 'The line through the poles is drawn; the dot marks where the Sun is straight overhead.',
      run: (ctx) => { ctx.select('earth'); return ctx.flyTo('earth'); },
      arrived: (ctx) => ctx.orbitDwell(DWELL),
      end: (ctx) => ctx.stopDwell(),
    },
    {
      id: 'day', title: 'One day', seconds: 12, rate: RATES.hour, paused: false, settings: EARTH_AXIS, keep: true,
      caption: 'One hour per second: watch the day side turn. The Sun stands overhead along one line of latitude.',
      live: (ctx) => { const o = overheadLine(ctx); const d = dateLine(ctx); return [o, d].filter(Boolean).join(' · '); },
    },
    {
      id: 'year', title: 'One year', seconds: 14, rate: RATES.month, paused: false, settings: EARTH_AXIS, keep: true,
      // Sub-solar latitude swings between ±23.44° (the obliquity): June and December solstices.
      caption: 'A month per second. The overhead Sun drifts north to 23.4° in June and south to 23.4° in December.',
      live: (ctx) => { const o = overheadLine(ctx); const d = dateLine(ctx); return [o, d].filter(Boolean).join(' · '); },
    },
    {
      id: 'above', title: 'From above', seconds: 13, rate: RATES.month, paused: false, settings: EARTH_AXIS, hold: 'poseDone',
      caption: 'From above: the axis stays fixed as Earth circles the Sun. First one pole leans sunward, then the other.',
      run: (ctx) => { ctx.select('earth'); return ctx.frameBodies(['earth'], { includeSun: true, polarDeg: 35, seconds: 1.5 }); },
      // Earth's perihelion falls on 3–4 January (events.json perihelion rows): distance is not the cause of seasons.
      detail: 'Seasons come from the tilt, not from distance: Earth is actually closest to the Sun in early January.',
    },
    finale('Back to today. Follow Earth at one hour per second any time: select it, press F, then set the rate.',
      'The orientation overlay lives under Settings; the Bodies tab shows the sub-solar point in numbers.'),
  ],
});

/** All curated tours, in menu order. */
export const TOURS = Object.freeze([WELCOME, PLANETS, ALIGNMENTS, SCALE, SEASONS]);

/** Tour ids in menu order. */
export const TOUR_IDS = Object.freeze(TOURS.map((t) => t.id));

/**
 * @param {string} id
 * @returns {import('./story.js').Tour|null}
 */
export function tourById(id) {
  return TOURS.find((t) => t.id === id) ?? null;
}
