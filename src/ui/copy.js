// Pure, DOM-free wording for the UI: dates in words, time rates in words, the camera context line, toast strings,
// the "why it matters" sentence per event kind, lay descriptions of brightness / size / phase / day length, RA/Dec
// formatting, the event filter presets and two small calendar helpers. No DOM, no three.js, only relative imports of
// the pure astro layer, so test/copy.test.mjs imports it under plain node. Everything a lay reader sees is written
// here first; scientist-mode strings keep the units and symbols (JD, ΔT, RA/Dec) exactly as astronomers write them.
import { AU_KM } from '../astro/constants.js';
import { calendarFromJd, gregorianFromJdn, formatJd, formatDeltaT, formatLightTime, formatSpeed, SEP } from '../astro/format.js';
import { LIGHT_TIME_AU_S, ARCSEC_PER_RAD } from '../astro/constants.js';
import { jdFromGregorian, RATES } from '../astro/clock.js';

export { SEP };

/** U+00A0 NO-BREAK SPACE: keeps "ΔT 69.184 s" one unbreakable token inside flex rows (a trailing ASCII space at the
 * end of a flex item is trimmed by the CSS white-space rules, which is how "ΔT69.184 s" happened). */
export const NBSP = ' ';

/** Scene frame and ephemeris provenance, as printed on the scientist line and the loading screen (CLAUDE.md §Frame). */
export const FRAME_LABEL = 'ecliptic J2000 (ICRF)';
export const EPHEMERIS_LABEL = 'VSOP87A / DE441-verified';
/** Provenance footer of the loading screen. */
export const PROVENANCE_LINE = 'VSOP87A · IAU 2015 · checked against JPL Horizons';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {number} n @returns {string} */
function pad2(n) { return n < 10 ? `0${n}` : String(n); }

/** Strip trailing zeros of a fixed-point string: '1.50' → '1.5', '2.00' → '2'. @param {string} s */
function trimZeros(s) { return s.includes('.') ? s.replace(/\.?0+$/, '') : s; }

/** 2–3 significant figures for prose: 1234 → '1 234', 12.34 → '12.3', 1.234 → '1.23'. @param {number} n */
function prose(n) {
  const a = Math.abs(n);
  if (a >= 100) return groupedInt(n);
  if (a >= 10) return trimZeros(n.toFixed(1));
  return trimZeros(n.toFixed(2));
}

/** Integer with U+2009 THIN SPACE thousands (format.js convention). @param {number} n */
function groupedInt(n) {
  const v = Math.round(n);
  const s = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return (v < 0 ? '−' : '') + out;
}

/**
 * Display name of a body id when no provider is at hand: 'mars' → 'Mars', 'sun' → 'Sun'.
 * @param {string} id
 * @returns {string}
 */
export function nameOfId(id) {
  const s = String(id ?? '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * 'the Sun' / 'the Moon' in running text, plain names otherwise.
 * @param {string} id
 * @param {(id: string) => string} [nameOf]
 * @returns {string}
 */
export function articled(id, nameOf = nameOfId) {
  return id === 'sun' || id === 'moon' ? `the ${nameOf(id)}` : nameOf(id);
}

/**
 * Natural-language list: ['Jupiter', 'Saturn'] → 'Jupiter and Saturn'; three or more → 'Venus, Jupiter and Saturn'.
 * @param {string[]} items
 * @returns {string}
 */
export function listOf(items) {
  const a = (items || []).filter(Boolean);
  if (a.length === 0) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates and time rates in words
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A date in words, UTC, rounded to the minute: '8 November 2026 · 18:19 UTC' (short: '8 Nov 2026 · 18:19 UTC').
 * Years ≤ 0 use the historians' era: astronomical year 0 = 1 BC, −1 = 2 BC (proleptic Gregorian, CLAUDE.md).
 * @param {number} jdUtc
 * @param {{ short?: boolean, seconds?: boolean }} [opts]
 * @returns {string}
 */
export function humanDate(jdUtc, { short = false, seconds = false } = {}) {
  if (!Number.isFinite(jdUtc)) return '—';
  const c = calendarFromJd(jdUtc, seconds);
  const y = c[0];
  const year = y <= 0 ? `${1 - y} BC` : String(y);
  const month = (short ? MONTHS_SHORT : MONTHS)[c[1] - 1];
  const time = `${pad2(c[3])}:${pad2(c[4])}${seconds ? `:${pad2(c[5])}` : ''} UTC`;
  return `${c[2]} ${month} ${year}${SEP}${time}`;
}

/**
 * Date only, in words: '16 January 2025' (short: '16 Jan 2025').
 * @param {number} jdUtc
 * @param {{ short?: boolean }} [opts]
 * @returns {string}
 */
export function humanDay(jdUtc, { short = false } = {}) {
  if (!Number.isFinite(jdUtc)) return '—';
  const c = calendarFromJd(jdUtc, false);
  const y = c[0];
  return `${c[2]} ${(short ? MONTHS_SHORT : MONTHS)[c[1] - 1]} ${y <= 0 ? `${1 - y} BC` : y}`;
}

/**
 * Timeline rate presets with every wording the UI needs. `days` are the astro/clock.js RATES (sim days per real
 * second); `label` is the button text, `short` its narrow-width form, `words` the HUD phrase, `aria` the spoken one.
 * @type {ReadonlyArray<{ key: string, days: number, label: string, short: string, words: string, aria: string }>}
 */
export const RATE_WORDS = Object.freeze([
  { key: 'realtime', days: RATES.realtime, label: 'Real time', short: 'Real', words: 'real time', aria: 'Real time: one second per second' },
  { key: 'hour', days: RATES.hour, label: '1 hour/s', short: '1 h', words: '1 hour per second', aria: 'One hour of simulated time per real second' },
  { key: 'day', days: RATES.day, label: '1 day/s', short: '1 d', words: '1 day per second', aria: 'One day per real second' },
  { key: 'week', days: RATES.week, label: '1 week/s', short: '1 w', words: '1 week per second', aria: 'One week per real second' },
  { key: 'month', days: RATES.month, label: '1 month/s', short: '1 mo', words: '1 month per second', aria: 'One month per real second' },
  { key: 'year', days: RATES.year, label: '1 year/s', short: '1 y', words: '1 year per second', aria: 'One year per real second' },
  { key: 'decade', days: RATES.decade, label: '10 years/s', short: '10 y', words: '10 years per second', aria: 'Ten years per real second' },
]);

/**
 * Index of the preset equal to |rate| within 0.5 % (log scale), or −1.
 * @param {number} rate signed days per second
 * @returns {number}
 */
export function presetIndex(rate) {
  const r = Math.abs(rate);
  if (!(r > 0)) return -1;
  for (let i = 0; i < RATE_WORDS.length; i++) if (Math.abs(Math.log(r / RATE_WORDS[i].days)) < 0.005) return i;
  return -1;
}

/**
 * Index of the preset nearest to |rate| (log scale); a zero or invalid rate snaps to 1 day/s (index 2).
 * @param {number} rate
 * @returns {number}
 */
export function nearestPresetIndex(rate) {
  const r = Math.abs(rate) || 1;
  let best = 0; let bestD = Infinity;
  for (let i = 0; i < RATE_WORDS.length; i++) {
    const d = Math.abs(Math.log(r / RATE_WORDS[i].days));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const SHORT_UNIT = { hour: 'h', day: 'd', month: 'mo', year: 'y' };

/**
 * A signed sim rate in words: '1 day per second', '1 week per second backwards', 'real time', 'paused'
 * (short: '1 day/s', '1 week/s ◀', 'Real time').
 * @param {number} rate days per real second (sign = direction)
 * @param {boolean} [playing=true]
 * @param {{ short?: boolean }} [opts]
 * @returns {string}
 */
export function humanRate(rate, playing = true, { short = false } = {}) {
  if (!playing || !Number.isFinite(rate) || rate === 0) return 'paused';
  const r = Math.abs(rate);
  const i = presetIndex(r);
  let words;
  if (i >= 0) words = short ? RATE_WORDS[i].label : RATE_WORDS[i].words;
  else {
    let n; let unit;
    if (r < 1) { n = r * 24; unit = 'hour'; } else if (r < 30) { n = r; unit = 'day'; } else if (r < 365.25) { n = r / RATES.month; unit = 'month'; } else { n = r / RATES.year; unit = 'year'; }
    const ns = prose(n);
    words = short ? `${ns} ${SHORT_UNIT[unit]}/s` : `${ns} ${ns === '1' ? unit : `${unit}s`} per second`;
  }
  return rate < 0 ? `${words}${short ? ' ◀' : ' backwards'}` : words;
}

/**
 * HUD line 1: '8 November 2026 · 18:19 UTC · 1 day per second' (paused: '… · paused').
 * @param {number} jdUtc
 * @param {number} rate
 * @param {boolean} playing
 * @param {{ short?: boolean }} [opts]
 * @returns {string}
 */
export function hudHumanLine(jdUtc, rate, playing, { short = false } = {}) {
  return `${humanDate(jdUtc, { short })}${SEP}${humanRate(rate, playing, { short })}`;
}

/**
 * Scientist line parts: ['JD 2461353.26319', 'TT = UTC + ΔT 69.184 s', 'ecliptic J2000 (ICRF)', 'VSOP87A / DE441-verified'].
 * ΔT and its value are joined with NBSP so no renderer can collapse the space.
 * @param {{ jdUtc: number, deltaT: number, deltaTAssumed?: boolean }} s
 * @returns {string[]}
 */
export function scientistParts({ jdUtc, deltaT, deltaTAssumed = false }) {
  return [
    formatJd(jdUtc),
    `TT = UTC + ΔT${NBSP}${formatDeltaT(deltaT, deltaTAssumed)}`,
    FRAME_LABEL,
    EPHEMERIS_LABEL,
  ];
}

/** @param {{ jdUtc: number, deltaT: number, deltaTAssumed?: boolean }} s @returns {string} */
export function scientistLine(s) { return scientistParts(s).join(SEP); }

// ---------------------------------------------------------------------------------------------------------------------
// Distances and speeds in prose
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Distance in AU for prose: '42 AU', '9.4 AU', '1.0 AU', '0.39 AU', '0.0026 AU'.
 * @param {number} au
 * @returns {string}
 */
export function auWords(au) {
  if (!Number.isFinite(au)) return '— AU';
  const a = Math.abs(au);
  if (a >= 20) return `${Math.round(au)} AU`;
  if (a >= 1) return `${au.toFixed(1)} AU`;
  if (a >= 0.1) return `${au.toFixed(2)} AU`;
  return `${Number(au.toPrecision(2))} AU`;
}

/**
 * Speed for prose: '2 300 × light speed', '0.87 × light speed', '59 958 km/s' (below 0.5 c, format.js rule).
 * @param {number} speedC speed / c
 * @returns {string}
 */
export function speedWords(speedC) {
  const s = formatSpeed(speedC);
  return s.endsWith(' c') ? `${s.slice(0, -2)} × light speed` : s;
}

/**
 * Light travel time for a distance in AU: '8 min 19 s' for 1 AU (499.004783836 s/AU, constants.js).
 * @param {number} au
 * @returns {string}
 */
export function lightTimeWords(au) {
  return Number.isFinite(au) ? formatLightTime(au * LIGHT_TIME_AU_S) : '—';
}

// ---------------------------------------------------------------------------------------------------------------------
// Camera context (HUD line 2) and toasts
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} CameraContext
 * @property {string} mode            'free' | 'follow' | 'skyView' | 'flyby' | 'tour'
 * @property {string|null} [followed]
 * @property {string|null} [selected]
 * @property {number} [distAu]        camera distance from the Sun (free view)
 * @property {number} [rSunAu]        followed body's distance from the Sun
 * @property {number} [speedC]        camera speed / c while flying
 * @property {string} [skyFrom]       sky view observer body
 * @property {string[]} [skyTo]       sky view targets
 * @property {string|null} [flybyTarget]
 */

/**
 * The camera line in two parts so the speed can flash on the light-speed beat.
 * 'Looking at the whole system from 42 AU' · 'Following Saturn — 9.4 AU from the Sun' ·
 * "Earth's sky toward Jupiter and Saturn" · 'Flying to Neptune' + '2 300 × light speed'.
 * @param {CameraContext} ctx
 * @param {(id: string) => string} [nameOf]
 * @returns {{ text: string, speed: string }}
 */
export function cameraContextParts(ctx, nameOf = nameOfId) {
  const c = ctx || /** @type {CameraContext} */ ({ mode: 'free' });
  const mode = c.mode;
  if ((mode === 'flyby' || mode === 'tour') && c.flybyTarget) {
    const speed = Number.isFinite(c.speedC) && c.speedC > 1e-6 ? speedWords(c.speedC) : '';
    return { text: `Flying to ${articled(c.flybyTarget, nameOf)}`, speed };
  }
  if (mode === 'follow' && c.followed) {
    if (c.followed === 'sun') return { text: 'Following the Sun — the centre of it all', speed: '' };
    if (c.followed === 'moon') {
      // The Moon's distance from Earth is the number people know (mean 384 400 km), not its distance from the Sun.
      const km = Number.isFinite(c.earthDistAu) ? ` — ${Math.round(c.earthDistAu * AU_KM / 1000) * 1000}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' km from Earth' : '';
      return { text: `Following the Moon${km}`, speed: '' };
    }
    const r = Number.isFinite(c.rSunAu) ? ` — ${auWords(c.rSunAu)} from the Sun` : '';
    return { text: `Following ${nameOf(c.followed)}${r}`, speed: '' };
  }
  if (mode === 'skyView') {
    const from = c.skyFrom || 'earth';
    const to = (c.skyTo && c.skyTo.length ? c.skyTo : c.selected ? [c.selected] : []).map((id) => articled(id, nameOf));
    const whose = `${nameOf(from)}'s sky`;
    return { text: to.length ? `${whose} toward ${listOf(to)}` : whose, speed: '' };
  }
  if (Number.isFinite(c.distAu)) {
    if (c.distAu >= 5 || !c.selected) return { text: `Looking at the whole system from ${auWords(c.distAu)}`, speed: '' };
    return { text: `Near ${articled(c.selected, nameOf)}${SEP}${auWords(c.distAu)} from the Sun`, speed: '' };
  }
  return { text: 'Looking at the whole system', speed: '' };
}

/** @param {CameraContext} ctx @param {(id: string) => string} [nameOf] @returns {string} */
export function cameraContext(ctx, nameOf) {
  const p = cameraContextParts(ctx, nameOf);
  return p.speed ? `${p.text}${SEP}${p.speed}` : p.text;
}

/**
 * Arrival toast: 'Saturn · 9.4 AU from the Sun · light takes 1 h 19 min from Earth'. Earth itself:
 * 'Earth · 1.0 AU from the Sun · home'. The Sun: 'The Sun · light takes 8 min 19 s to reach Earth'.
 * @param {string} name display name ('Saturn')
 * @param {number} rSunAu distance from the Sun, AU
 * @param {number} lightSeconds light-time from Earth, s (for the Sun: Earth's light-time from the Sun)
 * @param {{ lightTime?: (s: number) => string }} [f] optional formatter overrides (providers.format)
 * @returns {string}
 */
export function arrivalMessage(name, rSunAu, lightSeconds, f = null) {
  const lt = (s) => (f?.lightTime ?? formatLightTime)(s);
  const isSun = /^(the )?sun$/i.test(String(name)) || (Number.isFinite(rSunAu) && rSunAu < 0.01);
  if (isSun) return Number.isFinite(lightSeconds) && lightSeconds > 0 ? `The Sun${SEP}light takes ${lt(lightSeconds)} to reach Earth` : 'The Sun';
  const from = Number.isFinite(rSunAu) ? `${SEP}${auWords(rSunAu)} from the Sun` : '';
  if (/^earth$/i.test(String(name)) || (Number.isFinite(lightSeconds) && lightSeconds < 1)) return `${name}${from}${SEP}home`;
  const light = Number.isFinite(lightSeconds) ? `${SEP}light takes ${lt(lightSeconds)} from Earth` : '';
  return `${name}${from}${light}`;
}

/**
 * Camera-mode toast: follow → 'Following Saturn'; free → 'Free view · drag to look around';
 * skyView → "Earth's sky toward Jupiter"; home → 'Back to the whole system'.
 * @param {'follow'|'free'|'skyView'|'home'|string} mode
 * @param {string} [name] display name of the body involved
 * @returns {string}
 */
export function modeMessage(mode, name = '') {
  switch (mode) {
    case 'follow': return name ? `Following ${name}` : 'Following';
    case 'skyView': return name ? `Earth's sky toward ${name}` : 'Sky view from Earth';
    case 'home': return 'Back to the whole system';
    case 'free': default: return `Free view${SEP}drag to look around`;
  }
}

/** @param {string} name @returns {string} */
export function spinCapMessage(name) { return `Time slowed near ${name} so it does not spin into a blur`; }
/** @returns {string} */
export function rateRestoredMessage() { return 'Time is back to the speed you chose'; }
/** @param {number} rate @param {boolean} [playing=true] @returns {string} 'Time: 1 week per second' */
export function rateChangeMessage(rate, playing = true) { return `Time: ${humanRate(rate, playing)}`; }
/** @param {string} label @returns {string} */
export function eventNowMessage(label) { return `Happening now: ${label}`; }
/** @returns {string} */
export function shareCopiedMessage() { return 'Link copied — it opens this exact view, date and time'; }
/** @returns {string} */
export function snapshotMessage() { return 'Snapshot saved to your downloads'; }
/** @param {number} year @returns {string} */
export function clockLimitMessage(year) { return `The map stops at the year ${year <= 0 ? `${1 - year} BC` : year}`; }

/**
 * HUD size badge (a button): 'Planets drawn 50× larger — tap for true scale' / 'True scale — tap to enlarge the planets'.
 * @param {number} k size exaggeration
 * @returns {string}
 */
export function sizeBadge(k) {
  if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-9) return 'True scale — tap to enlarge the planets';
  const kText = k >= 10 ? String(Math.round(k)) : trimZeros(k.toFixed(1));
  return `Planets drawn ${kText}× larger — tap for true scale`;
}

/** Reduced-accuracy badge (outside the verified 1600–2600 band, README §Precision). */
export const ACCURACY_BADGE = 'Before 1600 / after 2600: accuracy reduced';

// ---------------------------------------------------------------------------------------------------------------------
// Events: why it matters, presets, scan status
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One plain sentence per event kind. Keys are astro/events.js KINDS plus the kinds workstream E may add
 * (transit, eclipse-solar, eclipse-lunar, moon-phase, equinox, solstice); unknown kinds yield ''.
 * Each entry is a function of the event's body names (Sun-outward order) and its `value`.
 * @type {Readonly<Record<string, (names: string[], value: Record<string, any>) => string>>}
 */
export const WHY_IT_MATTERS = Object.freeze({
  'opposition': ([p]) => `${p} is opposite the Sun in our sky: closest, brightest and up all night.`,
  'conjunction': ([p]) => `${p} passes behind the Sun from our point of view — hidden in the glare for weeks.`,
  'inferior-conjunction': ([p], v) => (v?.transit
    ? `${p} crosses the face of the Sun — a transit, rare and only safe to watch with eye protection.`
    : `${p} passes between Earth and the Sun and swaps from evening star to morning star.`),
  'superior-conjunction': ([p]) => `${p} is on the far side of the Sun, swapping from the morning sky to the evening sky.`,
  'greatest-elongation': ([p], v) => `${p} is as far from the Sun in our sky as it gets — the best chance to spot it ${v?.side === 'W' ? 'before sunrise' : 'after sunset'}.`,
  'pair': ([p, q]) => `${p} and ${q || 'another planet'} appear side by side in our sky — two planets in one view.`,
  'closest-approach': ([p]) => `${p} is at its nearest to Earth — biggest and brightest in a telescope.`,
  'perihelion': ([p]) => `${p} is at the closest point of its orbit to the Sun, moving at its fastest.`,
  'aphelion': ([p]) => `${p} is at the farthest point of its orbit from the Sun, moving at its slowest.`,
  'helio-parade': () => 'Seen from above, the planets bunch up on one side of the Sun.',
  'geo-parade': (_n, v) => `Several planets line up across the ${v?.side === 'morning' ? 'morning' : 'evening'} sky at once.`,
  'stationary': ([p], v) => `${p} pauses against the stars and reverses direction — ${/start|begin/i.test(String(v?.phase ?? '')) ? 'the start' : 'the end'} of its retrograde loop.`,
  'transit': ([p]) => `${p} crosses the face of the Sun — rare, and only safe to watch with proper eye protection.`,
  'eclipse-solar': () => 'The Moon covers the Sun for a narrow strip of Earth: day turns to dusk for a few minutes.',
  'eclipse-lunar': () => 'Earth’s shadow falls on the full Moon and turns it copper-red for everyone on the night side.',
  // events.js kind ids of the season and lunar detectors (src/astro/seasons.js, eclipses.js).
  'equinox-march': () => 'The Sun crosses the equator heading north: day and night are nearly equal everywhere, and spring begins in the north.',
  'equinox-september': () => 'The Sun crosses the equator heading south: day and night are nearly equal everywhere, and autumn begins in the north.',
  'solstice-june': () => 'The Sun stands farthest north: the longest day of the year north of the equator, the shortest south of it.',
  'solstice-december': () => 'The Sun stands farthest south: the shortest day of the year north of the equator, the longest south of it.',
  'moon-new': () => 'The Moon passes between Earth and the Sun, its night side toward us: the darkest skies of the month for stargazing.',
  'moon-first-quarter': () => 'Half lit and high at sunset: the terminator’s long shadows make this the best night for craters in binoculars.',
  'moon-full': (_n, v) => (v && v.supermoon
    ? 'A full Moon near its closest point to Earth: up to 14 % wider and 30 % brighter than the smallest full Moons.'
    : 'The Moon stands opposite the Sun and rises as the Sun sets, lit face-on all night.'),
  'moon-last-quarter': () => 'Half lit again, but rising around midnight: the Moon of the pre-dawn sky.',
  'moon-perigee': () => 'The Moon reaches the closest point of its orbit; a perigee near full Moon is what people call a supermoon.',
  'moon-apogee': () => 'The Moon reaches the farthest point of its orbit, about 10 % farther and dimmer than at perigee.',
  'solar-eclipse': (_n, v) => {
    const t = v && v.type;
    if (t === 'total') return 'The Moon covers the whole Sun along a narrow track: day turns to twilight for a few minutes and the corona appears.';
    if (t === 'annular') return 'The Moon is too far away to cover the Sun completely, so a bright ring of sunlight stays visible around it.';
    if (t === 'hybrid') return 'Total along part of its track and annular along the rest: the rarest kind of solar eclipse.';
    return 'The Moon takes a bite out of the Sun for part of the Earth; never look without proper eye protection.';
  },
  'lunar-eclipse': (_n, v) => {
    const t = v && v.type;
    if (t === 'total') return 'Earth’s shadow swallows the full Moon and turns it copper-red for everyone on the night side.';
    if (t === 'partial') return 'Earth’s dark inner shadow bites into the full Moon; the rest stays bright.';
    return 'The Moon drifts through the pale outer part of Earth’s shadow: a subtle dimming of the full Moon.';
  },
  'moon-phase': (_n, v) => {
    const ph = String(v?.phase ?? v?.name ?? '').toLowerCase();
    if (/new/.test(ph)) return 'New Moon: the Moon sits between Earth and the Sun, so its night side faces us.';
    if (/full/.test(ph)) return 'Full Moon: Earth sits between the Moon and the Sun, so we see its whole lit face.';
    if (/first/.test(ph)) return 'First quarter: half lit, high in the evening sky.';
    if (/last|third/.test(ph)) return 'Last quarter: half lit, high in the morning sky.';
    return 'A turning point of the Moon’s cycle, set by where the Sun lights it.';
  },
  'equinox': () => 'The Sun stands over the equator: day and night are equal everywhere on Earth.',
  'solstice': (_n, v) => {
    const s = String(v?.season ?? v?.hemisphere ?? v?.month ?? '').toLowerCase();
    if (/jun|north|summer/.test(s)) return 'The Sun reaches its farthest north: the longest day of the northern year.';
    if (/dec|south|winter/.test(s)) return 'The Sun reaches its farthest south: the shortest day of the northern year.';
    return 'The Sun reaches its farthest north or south — the longest or shortest day of the year.';
  },
});

/**
 * The 'why it matters' sentence of an event, or '' for an unknown kind.
 * @param {{ kind?: string, bodies?: string[], value?: Record<string, any> }} ev
 * @param {(id: string) => string} [nameOf]
 * @returns {string}
 */
export function whyItMatters(ev, nameOf = nameOfId) {
  const fn = WHY_IT_MATTERS[String(ev?.kind ?? '')];
  if (!fn) return '';
  const names = (ev?.bodies || []).filter((b) => b !== 'sun').map((id) => nameOf(id));
  if (!names.length) names.push(ev?.bodies?.length ? nameOf(ev.bodies[0]) : 'The planet');
  try { return fn(names, ev?.value || {}); } catch { return ''; }
}

/** Lay filter presets of the Events tab. */
export const EVENT_PRESETS = Object.freeze([
  { id: 'all', label: 'All', hint: 'Every event the scan found' },
  { id: 'best', label: 'Best', hint: 'The most notable events (score 60 and above)' },
  { id: 'visible', label: 'Visible from Earth', hint: 'Things you could actually see in the sky' },
]);

/** Score threshold of the Best preset (events.js scores: Mars oppositions 75–90, great conjunctions ≥ 65). */
export const BEST_MIN_SCORE = 60;

/** Kinds a person on Earth can watch (sky phenomena); conjunctions with the Sun, apsides and heliocentric parades are not. */
export const VISIBLE_KINDS = Object.freeze(new Set([
  'opposition', 'greatest-elongation', 'pair', 'closest-approach', 'geo-parade', 'stationary',
  'transit', 'eclipse-solar', 'eclipse-lunar', 'moon-phase',
  'solar-eclipse', 'lunar-eclipse', 'moon-new', 'moon-first-quarter', 'moon-full', 'moon-last-quarter',
]));

/**
 * Whether an event passes a preset. `baseMin` is the scientist-mode slider (settings.eventMinScore).
 * @param {'all'|'best'|'visible'|string} presetId
 * @param {{ kind?: string, score?: number, observable?: boolean, value?: Record<string, any> }} ev
 * @param {number} [baseMin=0]
 * @returns {boolean}
 */
export function presetMatches(presetId, ev, baseMin = 0) {
  const score = Number.isFinite(ev?.score) ? ev.score : 0;
  if (score < baseMin) return false;
  if (presetId === 'best') return score >= BEST_MIN_SCORE;
  if (presetId === 'visible') {
    if (ev?.observable === false) return false;
    const kind = String(ev?.kind ?? '');
    return VISIBLE_KINDS.has(kind) || (kind === 'inferior-conjunction' && !!ev?.value?.transit);
  }
  return true;
}

/**
 * Status line of the Events tab. '' when the whole window is scanned and events are ready.
 * @param {'idle'|'scanning'|'ready'|'error'|string} status
 * @param {{ missingYears?: number[], scanningYear?: number|null, providersReady?: boolean }} [info]
 * @returns {string}
 */
export function scanStatusText(status, { missingYears = [], scanningYear = null, providersReady = true } = {}) {
  if (status === 'error') return 'Events are unavailable right now — the scanner could not start.';
  if (!providersReady) return 'Loading the planetary data…';
  if (status === 'scanning') {
    const y = scanningYear ?? missingYears[0];
    return Number.isFinite(y) ? `Scanning ${y}…` : 'Scanning…';
  }
  if (status === 'idle') return 'Not scanned yet';
  if (missingYears.length) return missingYears.length === 1 ? `${missingYears[0]} not scanned yet` : `${missingYears[0]}–${missingYears[missingYears.length - 1]} not scanned yet`;
  return '';
}

/** @param {'all'|'best'|'visible'|string} presetId @returns {string} */
export function emptyEventsText(presetId) {
  if (presetId === 'best') return 'Nothing in the top tier here — try All, or move a year later.';
  if (presetId === 'visible') return 'Nothing to see from Earth in this window — try All, or move a year later.';
  return 'Nothing notable in this window — move a year earlier or later.';
}

/** Lay footnote of the Events tab (the scientist footnote is eventsTab.js EVENTS_FOOTNOTE, verbatim from the plan). */
export const EVENTS_LAY_FOOTNOTE = 'Times are when the line-up is exact in space. In the sky it can look a few minutes to a few hours different, because light takes time to reach us.';

// ---------------------------------------------------------------------------------------------------------------------
// Bodies tab: lay descriptions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Day length (one sidereal spin): '23 h 56 min', '9 h 56 min', '58.6 days', '243 days · spins backwards'.
 * @param {number} hours sidereal rotation period in hours (orientation.js siderealRotationHours, always positive)
 * @param {boolean} [retrograde=false] Ẇ < 0 (Venus, Uranus)
 * @returns {string}
 */
export function dayLengthText(hours, retrograde = false) {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  let out;
  if (hours < 48) {
    const m = Math.round(hours * 60);
    out = `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
  } else {
    const d = hours / 24;
    out = `${d < 100 ? trimZeros(d.toFixed(1)) : Math.round(d)} days`;
  }
  return retrograde ? `${out}${SEP}spins backwards` : out;
}

/**
 * Year length: '88 days', '687 days', '11.9 Earth years'.
 * @param {number} days sidereal orbital period in days
 * @returns {string}
 */
export function yearLengthText(days) {
  if (!Number.isFinite(days) || days <= 0) return '—';
  return days < 2 * 365.25 ? `${Math.round(days)} days` : `${(days / 365.25).toFixed(1)} Earth years`;
}

/**
 * Where a planet sits in Earth's sky: 'evening sky · 45° from the Sun', 'morning sky · 20° from the Sun',
 * 'too close to the Sun to see' (< 10°, events.js OBSERVABLE_MIN_ELONGATION_DEG), 'opposite the Sun · up all night' (≥ 170°).
 * @param {number} elongationDeg
 * @param {'E'|'W'|null|undefined} side E = east of the Sun = evening, W = west = morning
 * @returns {string}
 */
export function skyText(elongationDeg, side) {
  if (!Number.isFinite(elongationDeg)) return '—';
  if (elongationDeg < 10) return 'too close to the Sun to see';
  if (elongationDeg >= 170) return `opposite the Sun${SEP}up all night`;
  const deg = `${Math.round(elongationDeg)}° from the Sun`;
  if (side === 'E') return `evening sky${SEP}${deg}`;
  if (side === 'W') return `morning sky${SEP}${deg}`;
  return deg;
}

/**
 * Illuminated fraction as seen from Earth: '63% lit'.
 * @param {number} fraction 0…1
 * @returns {string}
 */
export function phaseText(fraction) {
  if (!Number.isFinite(fraction)) return '—';
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return `${pct}% lit`;
}

/**
 * Apparent visual magnitude with a plain-words scale: '−2.1 (very bright)'. Thresholds: Venus/Jupiter class ≤ −1,
 * first-magnitude stars ≈ 1, the naked-eye limit ≈ 6 under a dark sky (Bortle 2001, S&T Feb. 2001).
 * @param {number} m
 * @returns {string}
 */
export function magnitudeText(m) {
  if (!Number.isFinite(m)) return '—';
  const words = m <= -4 ? 'dazzling' : m <= -1 ? 'very bright' : m <= 1 ? 'bright' : m <= 3 ? 'easy to see' : m <= 6 ? 'faint, needs a dark sky' : 'needs binoculars or a telescope';
  return `${m.toFixed(1).replace('-', '−')} (${words})`;
}

/** Mean apparent diameter of the full Moon, arcsec: 2·atan(1737.4 km / 385 000.56 km) ≈ 1862″ = 31.0′ — mean radius
 * from the IAU WGCCRE 2015 report (Archinal et al. 2018, Table 5), mean distance from Meeus, Astronomical Algorithms
 * ch. 47 (the ELP-2000/82 constant term); NSSDC moonfact quotes 31.1′ at the 384 400 km mean distance. */
export const MOON_MEAN_DIAMETER_ARCSEC = 2 * Math.atan(1737.4 / 385000.56) * ARCSEC_PER_RAD;

/**
 * Apparent size with a Moon comparison: '18.2″ across (1/102 of the full Moon)', '31.1′ across (about the full Moon)'.
 * @param {number} arcsec apparent angular diameter
 * @returns {string}
 */
export function angularSizeText(arcsec) {
  if (!Number.isFinite(arcsec) || arcsec <= 0) return '—';
  const size = arcsec >= 60 ? `${(arcsec / 60).toFixed(1)}′ across` : `${arcsec.toFixed(1)}″ across`;
  const ratio = MOON_MEAN_DIAMETER_ARCSEC / arcsec;
  if (ratio >= 1.5) return `${size} (1/${Math.round(ratio)} of the full Moon)`;
  if (ratio > 1 / 1.5) return `${size} (about the full Moon)`;
  return `${size} (${trimZeros((1 / ratio).toFixed(1))}× the full Moon)`;
}

/**
 * Surface gravity relative to Earth: '0.38 × Earth'.
 * @param {number} g gravity / Earth's
 * @returns {string}
 */
export function gravityText(g) {
  return Number.isFinite(g) ? `${g.toFixed(2)} × Earth` : '—';
}

/**
 * Right ascension in hours, minutes, seconds: 83.6331° → '05h 34m 31.9s'.
 * @param {number} deg
 * @returns {string}
 */
export function formatRa(deg) {
  if (!Number.isFinite(deg)) return '—';
  const hours = (((deg % 360) + 360) % 360) / 15;
  let tenths = Math.round(hours * 36000); // tenths of a second
  if (tenths >= 864000) tenths = 0;
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths - h * 36000) / 600);
  const s = (tenths - h * 36000 - m * 600) / 10;
  return `${pad2(h)}h ${pad2(m)}m ${s.toFixed(1).padStart(4, '0')}s`;
}

/**
 * Declination in degrees, arcminutes, arcseconds with the sign: 22.0145° → '+22° 00′ 52″'.
 * @param {number} deg
 * @returns {string}
 */
export function formatDec(deg) {
  if (!Number.isFinite(deg)) return '—';
  const sign = deg < 0 ? '−' : '+';
  const total = Math.round(Math.abs(deg) * 3600);
  const d = Math.floor(total / 3600);
  const m = Math.floor((total - d * 3600) / 60);
  const s = total - d * 3600 - m * 60;
  return `${sign}${pad2(d)}° ${pad2(m)}′ ${pad2(s)}″`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Add n calendar years, keeping month, day and time of day: 2024-02-29 + 1 y → 2025-03-01 (the Fliegel–Van Flandern
 * day count is continuous, so an impossible 29 February rolls into 1 March), 2025-06-15 12:00 + 1 y → 2026-06-15 12:00.
 * Replaces stepping by 365.25 d, which drifted the date by 6 h per year.
 * @param {number} jdUtc
 * @param {number} n signed whole years
 * @returns {number} JD(UTC)
 */
export function addCalendarYears(jdUtc, n) {
  const jdn = Math.floor(jdUtc + 0.5); // civil day (JD .5 = 00:00 UTC), no rounding to the second
  const frac = jdUtc + 0.5 - jdn; // time of day, kept exactly
  const c = gregorianFromJdn(jdn);
  return jdFromGregorian(c[0] + Math.trunc(n), c[1], c[2]) + frac;
}

// ---------------------------------------------------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------------------------------------------------

/** Rotating one-liners of the loading screen; each is a number the app itself computes or a NSSDC fact-sheet value. */
export const LOADING_FACTS = Object.freeze([
  'Sunlight takes 8 min 19 s to reach Earth — and over 4 hours to reach Neptune.',
  'Jupiter spins once in under 10 hours; its year lasts 11.9 of ours.',
  'Venus turns backwards, and its day (243 days) is longer than its year (225 days).',
  'On 21 December 2020 Jupiter and Saturn stood 6 arcminutes apart in our sky — a fifth of the Moon’s width.',
  'Mars came within 55.76 million km of Earth on 27 August 2003, its closest approach in almost 60 000 years.',
  'Uranus rolls around the Sun on its side, tilted 98°.',
  'Neptune has completed one orbit since its discovery in 1846.',
  'A year on Mercury lasts 88 days; one spin on its axis takes 59.',
]);

/**
 * Description of a parsed share link for a toast: 'Shared view · 16 January 2025 · following Mars'.
 * @param {{ jdUtc?: number, selected?: string, view?: { kind: string, id?: string, from?: string, to?: string[] } }} parsed
 * @param {(id: string) => string} [nameOf]
 * @returns {string}
 */
export function shareDescription(parsed, nameOf = nameOfId) {
  const parts = ['Shared view'];
  if (Number.isFinite(parsed?.jdUtc)) parts.push(humanDay(parsed.jdUtc));
  const v = parsed?.view;
  if (v?.kind === 'follow' && v.id) parts.push(`following ${articled(v.id, nameOf)}`);
  else if (v?.kind === 'sky' && v.to?.length) parts.push(`${nameOf(v.from || 'earth')}'s sky toward ${listOf(v.to.map((id) => articled(id, nameOf)))}`);
  else if (parsed?.selected) parts.push(articled(parsed.selected, nameOf));
  return parts.join(SEP);
}
