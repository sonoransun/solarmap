// About & sources (a tab of the Help dialog): what the map is, where every number comes from, the measured
// accuracy against JPL Horizons (same table as README §Precision), the time scales, the "events are geometric"
// note, the visuals, and the licences (plan §UI, §Context, §Risks; LICENSES.md).
import { h } from './dom.js';
import { EVENTS_FOOTNOTE } from './eventsTab.js';

/**
 * Measured residuals vs JPL Horizons DE441 over 1900–2100 after the frame rotation — the README §Precision table
 * (test/horizons.test.mjs tolerances). Angular = position residual seen from the Sun at the body's distance.
 */
export const ACCURACY_ROWS = Object.freeze([
  { body: 'Mercury, Venus, Earth', residual: '≤ 20–25 km', angular: '≤ 0.05″', note: 'VSOP87A truncated at 1e-9 AU' },
  { body: 'Mars', residual: '≤ 150 km', angular: '≤ 0.15″', note: 'truncated at 1e-9 AU' },
  { body: 'Jupiter, Saturn', residual: '≤ 2 000 km', angular: '≤ 0.5″', note: 'truncated at 1e-8 AU' },
  { body: 'Uranus', residual: '≤ 20 000 km', angular: '≤ 1.5″', note: 'full series; limited by the theory (fitted to DE200)' },
  { body: 'Neptune', residual: '≤ 60 000 km', angular: '≤ 3.0″', note: 'full series; limited by the theory (fitted to DE200)' },
]);

/**
 * The About content (no dialog chrome; the Help dialog hosts it).
 * @returns {HTMLElement}
 */
export function createAboutContent() {
  return h('div', { class: 'about' },
    h('p', { class: 'lead' }, 'Solar Map is the real solar system, computed live in your browser: where every planet is for any date from 4000 BC to AD 4000, which way it is turned, how far everything is from everything else, the alignments worth watching, and cinematic faster-than-light flights between them. Nothing is animated by hand and nothing is fetched while you use it.'),

    h('h3', { text: 'Where the numbers come from' }),
    h('ul', null,
      h('li', null, h('strong', null, 'Planet positions: '), 'VSOP87A (Bretagnon & Francou 1988, A&A 202, 309), heliocentric rectangular coordinates in the dynamical ecliptic J2000, from the IMCCE distribution; rotated to the JPL “Ecliptic of J2000.0” frame (ICRF equator rotated by ε₇₆ = 84381.448″).'),
      h('li', null, h('strong', null, 'Checked against: '), 'JPL Horizons state vectors (DE441) fetched once into committed test fixtures, the official VSOP87 check file, and an independent Keplerian cross-check.'),
      h('li', null, h('strong', null, 'Which way each body faces: '), 'IAU Working Group on Cartographic Coordinates and Rotational Elements, 2015 report (Archinal et al. 2018); Earth from sidereal time and precession (nutation and DUT1 neglected, ≤ 0.009°).'),
      h('li', null, h('strong', null, 'The Moon: '), 'Jean Meeus, Astronomical Algorithms (2nd ed.), chapter 47 — the abridged ELP-2000/82 series (60 terms each in longitude, distance and latitude), checked against Horizons; its orientation from the IAU 2015 lunar elements.'),
      h('li', null, h('strong', null, 'Stars: '), 'the Yale Bright Star Catalogue, 5th revised edition (Hoffleit & Warren 1991): the 8 400 stars brighter than magnitude 6.5, with their colours; proper names from the IAU Working Group on Star Names.'),
      h('li', null, h('strong', null, 'Time: '), 'ΔT from the IERS leap-second table (1972 onward) and the Espenak–Meeus polynomials before 1972; TDB−TT from the standard series.'),
      h('li', null, h('strong', null, 'Sizes and spins: '), 'radii and rotation periods from NASA NSSDC fact sheets and IAU 2015; light-time from 1 AU = 149 597 870.700 km and c = 299 792.458 km/s.')),

    h('h3', { text: 'How accurate is it?' }),
    h('p', null, 'Measured against JPL Horizons (DE441) after the documented frame rotation, 1900–2100:'),
    h('table', { class: 'acc' },
      h('thead', null, h('tr', null, h('th', { text: 'Bodies' }), h('th', { text: 'Position' }), h('th', { text: 'Angle' }), h('th', { text: 'Note' }))),
      h('tbody', null, ACCURACY_ROWS.map((r) => h('tr', null, h('td', { text: r.body }), h('td', { class: 'num', text: r.residual }), h('td', { class: 'num', text: r.angular }), h('td', { class: 'muted', text: r.note }))))),
    h('p', null, 'For scale: 60 000 km at Neptune’s distance is a few arcseconds — invisible at any zoom level, but stated here rather than hidden behind a bare arc-second claim. Uranus and Neptune are limited by VSOP87 itself, which was fitted to the older DE200 ephemeris; their residuals grow to ~10⁵ km beyond ±400 years. The verified band is 1600–2600; outside it the HUD says so, and the clock stops at −4000 and +4000 (proleptic Gregorian).'),
    h('p', null, 'Every displayed time is UTC. The ephemeris is evaluated at TT = UTC + ΔT. The leap-second table is used through its IERS expiry of 2027-06-28; after that ΔT is extrapolated with a continuity-shifted polynomial and scientist mode marks it “assumed”. Earth’s spin uses UT1 ≈ UTC.'),
    h('p', null, h('strong', null, 'Event times are geometric. '), EVENTS_FOOTNOTE, '. Stationary points and geocentric planet parades are experimental.'),
    h('p', null, h('strong', null, 'Visuals. '), 'Planet surfaces are photographic by default (Solar System Scope maps compiled from NASA imagery; switch to painted surfaces in Settings); Earth’s cloud layer is visual only. Planets are drawn larger than life (×50 at first, the Sun capped at ×30) so they can be seen from across the system — the badge in the top-left corner says so and switches to true scale. Flight speeds are computed from the camera path and shown in multiples of c; they are theatre, not physics.'),

    h('h3', { text: 'Licences' }),
    h('ul', null,
      h('li', null, 'VSOP87 — Bureau des Longitudes / IMCCE; free use with citation of Bretagnon & Francou (1988).'),
      h('li', null, 'JPL Horizons fixtures — NASA/JPL Solar System Dynamics, public data (used only in tests).'),
      h('li', null, 'IAU WGCCRE 2015 rotational elements — Archinal et al., Celest. Mech. Dyn. Astron. 130:22 (2018).'),
      h('li', null, 'Yale Bright Star Catalogue 5 — Hoffleit & Warren 1991, VizieR V/50, via the CfA Telescope Data Center; public data.'),
      h('li', null, 'Lunar theory — Meeus, Astronomical Algorithms, 2nd ed. (Willmann-Bell 1998), ch. 47 and 48 (abridged ELP-2000/82, Chapront-Touzé & Chapront 1983).'),
      h('li', null, 'webgl-noise (simplex noise) — Ashima Arts / Stefan Gustavson, MIT.'),
      h('li', null, h('strong', null, 'Surface maps: '),
        h('a', { href: 'https://www.solarsystemscope.com/textures/', target: '_blank', rel: 'noreferrer noopener' }, 'Solar System Scope'),
        ' texture maps (planets and the Moon), CC BY 4.0, compiled from NASA imagery and elevation data (MESSENGER, Magellan, Blue Marble, Earth at Night, Viking, Cassini, Voyager, LRO).'),
      h('li', null, 'three.js — MIT.'),
      h('li', null, 'Solar Map application code — MIT; see the repository README and LICENSES.md.')),
  );
}
