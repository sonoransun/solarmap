// Pure wording helpers of the UI (src/ui/copy.js is DOM-free and imports only src/astro). Expected strings are the
// exact phrases the lay-first HUD, tabs and toasts print; tolerances are stated where a number is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jdFromGregorian, RATES } from '../src/astro/clock.js';
import { KINDS } from '../src/astro/events.js';
import { THIN_SPACE } from '../src/astro/format.js';
import {
  NBSP, SEP, nameOfId, articled, listOf, humanDate, humanDay, RATE_WORDS, presetIndex, nearestPresetIndex, humanRate,
  hudHumanLine, scientistParts, scientistLine, auWords, speedWords, lightTimeWords, cameraContextParts, cameraContext,
  arrivalMessage, modeMessage, spinCapMessage, rateChangeMessage, sizeBadge, ACCURACY_BADGE, WHY_IT_MATTERS, whyItMatters,
  EVENT_PRESETS, presetMatches, BEST_MIN_SCORE, scanStatusText, emptyEventsText, dayLengthText, yearLengthText, skyText,
  phaseText, magnitudeText, angularSizeText, MOON_MEAN_DIAMETER_ARCSEC, gravityText, formatRa, formatDec,
  addCalendarYears, LOADING_FACTS, shareDescription, FRAME_LABEL, EPHEMERIS_LABEL,
} from '../src/ui/copy.js';

const TS = THIN_SPACE;

test('humanDate: day month year · hh:mm UTC, rounded to the minute; BC years use the historians’ era', () => {
  assert.equal(humanDate(jdFromGregorian(2026, 11, 8, 18, 19, 20)), '8 November 2026 · 18:19 UTC');
  assert.equal(humanDate(jdFromGregorian(2026, 11, 8, 18, 19, 20), { short: true }), '8 Nov 2026 · 18:19 UTC');
  assert.equal(humanDate(jdFromGregorian(2026, 11, 8, 18, 19, 40)), '8 November 2026 · 18:20 UTC', 'rounded to the nearest minute');
  assert.equal(humanDate(jdFromGregorian(-499, 1, 1)), '1 January 500 BC · 00:00 UTC', 'astronomical −499 = 500 BC');
  assert.equal(humanDate(jdFromGregorian(0, 3, 1)), '1 March 1 BC · 00:00 UTC', 'year 0 = 1 BC');
  assert.equal(humanDate(jdFromGregorian(2025, 1, 16, 2, 31, 0), { seconds: true }), '16 January 2025 · 02:31:00 UTC');
  assert.equal(humanDay(jdFromGregorian(2025, 1, 16, 2, 31)), '16 January 2025');
  assert.equal(humanDate(NaN), '—');
});

test('RATE_WORDS mirror astro/clock.js RATES and carry readable, short and spoken forms', () => {
  assert.deepEqual(RATE_WORDS.map((r) => r.days), [RATES.realtime, RATES.hour, RATES.day, RATES.week, RATES.month, RATES.year, RATES.decade]);
  assert.deepEqual(RATE_WORDS.map((r) => r.label), ['Real time', '1 hour/s', '1 day/s', '1 week/s', '1 month/s', '1 year/s', '10 years/s']);
  assert.deepEqual(RATE_WORDS.map((r) => r.short), ['Real', '1 h', '1 d', '1 w', '1 mo', '1 y', '10 y']);
  for (const r of RATE_WORDS) assert.ok(!/per second per second/.test(r.aria), `aria never doubles "per second": ${r.aria}`);
  assert.equal(presetIndex(7 * 1.003), 3, 'within 0.5 % of a preset (log scale)');
  assert.equal(presetIndex(5), -1);
  assert.equal(nearestPresetIndex(1), 2);
  assert.equal(nearestPresetIndex(0), 2, 'a zero/invalid rate snaps to 1 day/s');
});

test('humanRate: presets in words, free values with units, direction and pause', () => {
  assert.equal(humanRate(1, true), '1 day per second');
  assert.equal(humanRate(1 / 86400, true), 'real time');
  assert.equal(humanRate(-7, true), '1 week per second backwards');
  assert.equal(humanRate(3652.5, true), '10 years per second');
  assert.equal(humanRate(1 / 24, true), '1 hour per second');
  assert.equal(humanRate(2.5, true), '2.5 days per second');
  assert.equal(humanRate(0.5, true), '12 hours per second');
  assert.equal(humanRate(2, true), '2 days per second');
  assert.equal(humanRate(1, false), 'paused');
  assert.equal(humanRate(0, true), 'paused');
  assert.equal(humanRate(1, true, { short: true }), '1 day/s');
  assert.equal(humanRate(-30.436875, true, { short: true }), '1 month/s ◀');
  assert.equal(hudHumanLine(jdFromGregorian(2026, 11, 8, 18, 19), 1, true), '8 November 2026 · 18:19 UTC · 1 day per second');
  assert.equal(hudHumanLine(jdFromGregorian(2026, 11, 8, 18, 19), 1, false), '8 November 2026 · 18:19 UTC · paused');
});

test('scientist line: JD · TT = UTC + ΔT (no-break space) · frame · ephemeris', () => {
  const parts = scientistParts({ jdUtc: 2461353.26319, deltaT: 69.184 });
  assert.deepEqual(parts, ['JD 2461353.26319', `TT = UTC + ΔT${NBSP}69.184 s`, 'ecliptic J2000 (ICRF)', 'VSOP87A / DE441-verified']);
  assert.equal(parts[1].charCodeAt(parts[1].indexOf('ΔT') + 2), 0x00A0, 'the ΔT value is joined with U+00A0, which flex rows cannot trim');
  const line = scientistLine({ jdUtc: 2461353.26319, deltaT: 69.3, deltaTAssumed: true });
  assert.ok(line.includes(`ΔT${NBSP}69.3 s (assumed)`), 'assumed ΔT keeps format.js wording');
  assert.ok(!/ΔT\d/.test(line), 'never "ΔT69.184 s"');
  assert.equal(FRAME_LABEL, 'ecliptic J2000 (ICRF)');
  assert.equal(EPHEMERIS_LABEL, 'VSOP87A / DE441-verified');
});

test('auWords / speedWords / lightTimeWords: prose precision', () => {
  assert.equal(auWords(42.3), '42 AU');
  assert.equal(auWords(9.4321), '9.4 AU');
  assert.equal(auWords(1), '1.0 AU');
  assert.equal(auWords(0.387), '0.39 AU');
  assert.equal(auWords(0.00257), '0.0026 AU');
  assert.equal(auWords(NaN), '— AU');
  assert.equal(speedWords(2300), `2${TS}300 × light speed`, 'format.js grouping with THIN SPACE');
  assert.equal(speedWords(0.87), '0.87 × light speed');
  assert.equal(speedWords(0.1), `29${TS}979 km/s`, 'below 0.5 c stays in km/s (0.1 × 299 792.458)');
  assert.equal(lightTimeWords(1), '8 min 19 s', '1 AU = 499.004783836 s');
  assert.equal(lightTimeWords(NaN), '—');
});

test('cameraContext: whole system, following, Earth’s sky, flying (speed split for the light-speed beat)', () => {
  assert.equal(cameraContext({ mode: 'free', distAu: 42 }), 'Looking at the whole system from 42 AU');
  assert.equal(cameraContext({ mode: 'free', distAu: 0.02, selected: 'saturn' }), 'Near Saturn · 0.02 AU from the Sun');
  assert.equal(cameraContext({ mode: 'free' }), 'Looking at the whole system');
  assert.equal(cameraContext({ mode: 'follow', followed: 'saturn', rSunAu: 9.43 }), 'Following Saturn — 9.4 AU from the Sun');
  assert.equal(cameraContext({ mode: 'follow', followed: 'sun' }), 'Following the Sun — the centre of it all');
  assert.equal(cameraContext({ mode: 'skyView', skyFrom: 'earth', skyTo: ['jupiter', 'saturn'] }), 'Earth’s sky toward Jupiter and Saturn'.replace('’', "'"));
  assert.equal(cameraContext({ mode: 'skyView', selected: 'mars' }), "Earth's sky toward Mars", 'falls back to the selection');
  const p = cameraContextParts({ mode: 'flyby', flybyTarget: 'neptune', speedC: 2300 });
  assert.deepEqual(p, { text: 'Flying to Neptune', speed: `2${TS}300 × light speed` });
  assert.equal(cameraContext({ mode: 'tour', flybyTarget: 'neptune', speedC: 2300 }), `Flying to Neptune · 2${TS}300 × light speed`);
  assert.equal(cameraContext({ mode: 'flyby', flybyTarget: 'sun', speedC: 0 }), 'Flying to the Sun');
  const named = cameraContext({ mode: 'follow', followed: 'mars', rSunAu: 1.5 }, (id) => (id === 'mars' ? 'Marte' : nameOfId(id)));
  assert.equal(named, 'Following Marte — 1.5 AU from the Sun', 'provider names are honoured');
});

test('arrivalMessage: planets, Earth (home) and the Sun — never "AU AU" or "0 s light-time"', () => {
  assert.equal(arrivalMessage('Saturn', 9.43, 4740), 'Saturn · 9.4 AU from the Sun · light takes 79 min 00 s from Earth');
  assert.equal(arrivalMessage('Neptune', 29.9, 15000), 'Neptune · 30 AU from the Sun · light takes 4 h 10 min from Earth');
  assert.equal(arrivalMessage('Earth', 1.0, 0), 'Earth · 1.0 AU from the Sun · home');
  assert.equal(arrivalMessage('Sun', 0, 499.005), 'The Sun · light takes 8 min 19 s to reach Earth');
  assert.equal(arrivalMessage('Mars', NaN, NaN), 'Mars', 'missing numbers are simply omitted');
  assert.ok(!/AU AU/.test(arrivalMessage('Mars', 1.52, 300)));
  assert.equal(arrivalMessage('Mars', 1.52, 300, { lightTime: (s) => `${s}s` }), 'Mars · 1.5 AU from the Sun · light takes 300s from Earth', 'formatter override');
});

test('mode, spin-cap and rate toasts; size and accuracy badges', () => {
  assert.equal(modeMessage('follow', 'Mars'), 'Following Mars');
  assert.equal(modeMessage('free'), 'Free view · drag to look around');
  assert.equal(modeMessage('skyView', 'Jupiter'), "Earth's sky toward Jupiter");
  assert.equal(modeMessage('home'), 'Back to the whole system');
  assert.equal(spinCapMessage('Saturn'), 'Time slowed near Saturn so it does not spin into a blur');
  assert.equal(rateChangeMessage(7), 'Time: 1 week per second');
  assert.equal(sizeBadge(50), 'Planets drawn 50× larger — tap for true scale');
  assert.equal(sizeBadge(2.5), 'Planets drawn 2.5× larger — tap for true scale');
  assert.equal(sizeBadge(1), 'True scale — tap to enlarge the planets');
  assert.equal(ACCURACY_BADGE, 'Before 1600 / after 2600: accuracy reduced');
});

test('whyItMatters: one sentence for every events.js kind, the E kinds, and \'\' for unknown kinds', () => {
  for (const k of KINDS) assert.ok(k in WHY_IT_MATTERS, `table has ${k}`);
  for (const k of KINDS) {
    const s = whyItMatters({ kind: k, bodies: ['mars', 'jupiter'], value: {} });
    assert.ok(s.length > 20 && /[.!]$/.test(s), `${k}: a full sentence (${s})`);
  }
  for (const k of ['transit', 'eclipse-solar', 'eclipse-lunar', 'moon-phase', 'equinox', 'solstice']) assert.ok(whyItMatters({ kind: k, bodies: ['moon'] }).length > 20, k);
  assert.equal(whyItMatters({ kind: 'opposition', bodies: ['mars'] }), 'Mars is opposite the Sun in our sky: closest, brightest and up all night.');
  assert.equal(whyItMatters({ kind: 'pair', bodies: ['jupiter', 'saturn'] }), 'Jupiter and Saturn appear side by side in our sky — two planets in one view.');
  assert.match(whyItMatters({ kind: 'greatest-elongation', bodies: ['venus'], value: { side: 'W' } }), /before sunrise\.$/);
  assert.match(whyItMatters({ kind: 'greatest-elongation', bodies: ['venus'], value: { side: 'E' } }), /after sunset\.$/);
  assert.match(whyItMatters({ kind: 'inferior-conjunction', bodies: ['venus'], value: { transit: true } }), /^Venus crosses the face of the Sun/);
  assert.match(whyItMatters({ kind: 'stationary', bodies: ['mars'], value: { phase: 'retrograde-start' } }), /the start of its retrograde loop/);
  assert.match(whyItMatters({ kind: 'moon-phase', bodies: ['moon'], value: { phase: 'full' } }), /^Full Moon/);
  assert.match(whyItMatters({ kind: 'solstice', bodies: ['earth'], value: { season: 'june' } }), /farthest north/);
  assert.equal(whyItMatters({ kind: 'something-new', bodies: ['mars'] }), '', 'unknown kinds are tolerated');
  assert.equal(whyItMatters(null), '');
});

test('event presets: All / Best / Visible from Earth', () => {
  assert.deepEqual(EVENT_PRESETS.map((p) => p.id), ['all', 'best', 'visible']);
  assert.equal(BEST_MIN_SCORE, 60);
  const opp = { kind: 'opposition', score: 75, observable: true };
  const conj = { kind: 'conjunction', score: 20 };
  const pairHidden = { kind: 'pair', score: 70, observable: false };
  assert.equal(presetMatches('all', conj), true);
  assert.equal(presetMatches('all', conj, 40), false, 'the scientist-mode floor applies to every preset');
  assert.equal(presetMatches('best', opp), true);
  assert.equal(presetMatches('best', { kind: 'opposition', score: 59 }), false);
  assert.equal(presetMatches('visible', opp), true);
  assert.equal(presetMatches('visible', conj), false, 'a conjunction with the Sun cannot be seen');
  assert.equal(presetMatches('visible', pairHidden), false, 'observable === false is honoured');
  assert.equal(presetMatches('visible', { kind: 'inferior-conjunction', score: 100, value: { transit: true } }), true, 'a transit is visible');
  assert.equal(presetMatches('visible', { kind: 'eclipse-lunar', score: 80 }), true, 'E kinds are known to the preset');
  assert.equal(presetMatches('visible', { kind: 'equinox', score: 50 }), false);
});

test('scan status / empty-list wording', () => {
  assert.equal(scanStatusText('scanning', { missingYears: [2031, 2032] }), 'Scanning 2031…');
  assert.equal(scanStatusText('scanning', { scanningYear: 2029 }), 'Scanning 2029…');
  assert.equal(scanStatusText('scanning'), 'Scanning…');
  assert.equal(scanStatusText('idle'), 'Not scanned yet');
  assert.equal(scanStatusText('ready', { missingYears: [] }), '', 'fully scanned window: no status line');
  assert.equal(scanStatusText('ready', { missingYears: [2040] }), '2040 not scanned yet');
  assert.equal(scanStatusText('ready', { missingYears: [2040, 2041] }), '2040–2041 not scanned yet');
  assert.match(scanStatusText('error'), /^Events are unavailable/);
  assert.equal(scanStatusText('ready', { providersReady: false }), 'Loading the planetary data…');
  assert.match(emptyEventsText('best'), /try All/);
  assert.match(emptyEventsText('all'), /earlier or later/);
});

test('bodies tab lay rows: day length, year length, sky position, phase, magnitude, size, gravity', () => {
  assert.equal(dayLengthText(23.934470), '23 h 56 min', 'Earth sidereal day');
  assert.equal(dayLengthText(9.92492), '9 h 55 min', 'Jupiter (9.925 h rounds to 9 h 55 min)');
  assert.equal(dayLengthText(58.6462 * 24), '58.6 days', 'Mercury');
  assert.equal(dayLengthText(243.0185 * 24, true), '243 days · spins backwards', 'Venus');
  assert.equal(dayLengthText(NaN), '—');
  assert.equal(yearLengthText(87.969), '88 days');
  assert.equal(yearLengthText(686.98), '687 days');
  assert.equal(yearLengthText(4332.589), '11.9 Earth years');
  assert.equal(skyText(45, 'E'), 'evening sky · 45° from the Sun');
  assert.equal(skyText(20.4, 'W'), 'morning sky · 20° from the Sun');
  assert.equal(skyText(5, 'W'), 'too close to the Sun to see', '< 10° (events.js OBSERVABLE_MIN_ELONGATION_DEG)');
  assert.equal(skyText(178, null), 'opposite the Sun · up all night');
  assert.equal(skyText(NaN, 'E'), '—');
  assert.equal(phaseText(0.634), '63% lit');
  assert.equal(magnitudeText(-2.1), '−2.1 (very bright)', 'Unicode minus');
  assert.equal(magnitudeText(-4.4), '−4.4 (dazzling)');
  assert.equal(magnitudeText(0.5), '0.5 (bright)');
  assert.equal(magnitudeText(5.7), '5.7 (faint, needs a dark sky)');
  assert.equal(magnitudeText(7.8), '7.8 (needs binoculars or a telescope)');
  assert.ok(Math.abs(MOON_MEAN_DIAMETER_ARCSEC - 1861.6) < 1, '2·atan(1737.4/385000.56) = 1861.6″ (NSSDC: 31.1′ at 384 400 km)');
  assert.equal(angularSizeText(18.2), '18.2″ across (1/102 of the full Moon)');
  assert.equal(angularSizeText(MOON_MEAN_DIAMETER_ARCSEC), '31.0′ across (about the full Moon)');
  assert.equal(angularSizeText(MOON_MEAN_DIAMETER_ARCSEC * 2), '62.1′ across (2× the full Moon)');
  assert.equal(angularSizeText(0), '—');
  assert.equal(gravityText(0.38), '0.38 × Earth');
});

test('formatRa / formatDec: sexagesimal with carries and wrap', () => {
  assert.equal(formatRa(83.63308), '05h 34m 31.9s', 'Betelgeuse-like RA');
  assert.equal(formatRa(0), '00h 00m 00.0s');
  assert.equal(formatRa(359.99999), '00h 00m 00.0s', 'rounds up to 24h and wraps to 0');
  assert.equal(formatRa(-15), '23h 00m 00.0s', 'negative RA wraps');
  assert.equal(formatDec(22.0145), '+22° 00′ 52″');
  assert.equal(formatDec(-5.5), '−05° 30′ 00″');
  assert.equal(formatDec(NaN), '—');
});

test('addCalendarYears keeps month, day and time of day; 29 February rolls into 1 March', () => {
  const t = jdFromGregorian(2025, 6, 15, 12, 0, 0.4);
  assert.ok(Math.abs(addCalendarYears(t, 1) - jdFromGregorian(2026, 6, 15, 12, 0, 0.4)) < 1e-9, '+1 y (tolerance 1e-9 d ≈ 0.1 ms)');
  assert.ok(Math.abs(addCalendarYears(t, -3) - jdFromGregorian(2022, 6, 15, 12, 0, 0.4)) < 1e-9, '−3 y');
  assert.ok(Math.abs(addCalendarYears(jdFromGregorian(2024, 2, 29, 12), 1) - jdFromGregorian(2025, 3, 1, 12)) < 1e-9, 'leap day → 1 March');
  const late = jdFromGregorian(2025, 12, 31, 23, 59, 59.8);
  assert.ok(Math.abs(addCalendarYears(late, 1) - jdFromGregorian(2026, 12, 31, 23, 59, 59.8)) < 1e-9, 'no rounding into the next day');
  assert.ok(Math.abs(addCalendarYears(t, 1) - t - 365) < 1e-9, 'a non-leap step is exactly 365 d, not 365.25');
});

test('misc: names, lists, loading facts, share description', () => {
  assert.equal(nameOfId('mars'), 'Mars');
  assert.equal(articled('sun'), 'the Sun');
  assert.equal(articled('moon'), 'the Moon');
  assert.equal(listOf(['Jupiter']), 'Jupiter');
  assert.equal(listOf(['Jupiter', 'Saturn']), 'Jupiter and Saturn');
  assert.equal(listOf(['Venus', 'Jupiter', 'Saturn']), 'Venus, Jupiter and Saturn');
  assert.ok(LOADING_FACTS.length >= 5 && LOADING_FACTS.every((f) => typeof f === 'string' && f.length > 20));
  assert.equal(SEP, ' · ');
  assert.equal(shareDescription({ jdUtc: jdFromGregorian(2025, 1, 16, 2, 31), view: { kind: 'follow', id: 'mars' } }), 'Shared view · 16 January 2025 · following Mars');
  assert.equal(shareDescription({ view: { kind: 'sky', from: 'earth', to: ['jupiter', 'saturn'] } }), "Shared view · Earth's sky toward Jupiter and Saturn");
  assert.equal(shareDescription({ selected: 'sun' }), 'Shared view · the Sun');
  assert.equal(shareDescription({}), 'Shared view');
});
