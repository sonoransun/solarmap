// About dialog: sources, accuracy statement with the measured per-planet residuals and the Uranus/Neptune caveat,
// leap-second assumption, "geometric events" note, licences (plan §UI, §Context, §Risks).
import { h, trapFocusIn } from './dom.js';
import { EVENTS_FOOTNOTE } from './eventsTab.js';

/** Measured residuals vs JPL Horizons DE441 (plan §Context, 1900–2100). */
export const ACCURACY_ROWS = Object.freeze([
  { body: 'Mercury, Venus, Earth, Mars', residual: '2–35 km', note: 'VSOP87A truncated at 1e-9 AU' },
  { body: 'Jupiter, Saturn', residual: '≤ 2 000 km', note: 'truncated at 1e-8 AU' },
  { body: 'Uranus', residual: '≤ ~16 000 km', note: 'full series; limited by the theory (fitted to DE200)' },
  { body: 'Neptune', residual: '≤ ~50 000 km', note: 'full series; limited by the theory (fitted to DE200)' },
]);

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean, dispose: () => void }}
 */
export function createAbout({ root }) {
  const btnClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' });
  btnClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const body = h('div', { class: 'dialog-body' },
    h('p', null, 'Solar Map shows the eight planets’ heliocentric positions and orientations for any date from −4000 to +4000, their mutual distances, notable alignments, and theatrical faster-than-light fly-bys — entirely in the browser, with no runtime network calls.'),

    h('h3', { text: 'Sources' }),
    h('ul', null,
      h('li', null, h('strong', null, 'Positions: '), 'VSOP87A (Bretagnon & Francou 1988, A&A 202, 309), heliocentric rectangular coordinates, dynamical ecliptic J2000, from the IMCCE distribution; rotated to the JPL “Ecliptic of J2000.0” frame (ICRF equatorial rotated by ε₇₆ = 84381.448″).'),
      h('li', null, h('strong', null, 'Verification: '), 'JPL Horizons state vectors (DE441) fetched once into committed test fixtures; the official VSOP87 check file; an independent Keplerian cross-check.'),
      h('li', null, h('strong', null, 'Orientation: '), 'IAU Working Group on Cartographic Coordinates and Rotational Elements, 2015 report (Archinal et al. 2018); Earth via GMST + precession (nutation and DUT1 neglected, ≤ 0.009°).'),
      h('li', null, h('strong', null, 'Time: '), 'ΔT from the IERS leap-second table (1972 onward) and the Espenak–Meeus polynomials before 1972; TDB−TT from the standard series.'),
      h('li', null, h('strong', null, 'Physical data: '), 'radii and rotation periods from NSSDC / IAU 2015; light-time from 1 AU = 149 597 870.700 km and c = 299 792.458 km/s.')),

    h('h3', { text: 'Accuracy' }),
    h('p', null, 'Measured against JPL Horizons (DE441) after the documented frame rotation, 1900–2100:'),
    h('table', { class: 'acc' },
      h('thead', null, h('tr', null, h('th', { text: 'Bodies' }), h('th', { text: 'Position residual' }), h('th', { text: 'Note' }))),
      h('tbody', null, ACCURACY_ROWS.map((r) => h('tr', null, h('td', { text: r.body }), h('td', { class: 'num', text: r.residual }), h('td', { class: 'muted', text: r.note }))))),
    h('p', null, 'Uranus and Neptune are limited by VSOP87 itself: the theory was fitted to the DE200 ephemeris, so their residuals against DE441 reach ~5 000–50 000 km in 1900–2100 and grow to ~10⁵ km beyond ±400 years. This is invisible at any zoom level but is stated here rather than a bare arc-second claim. The verified band is 1600–2600; outside it the HUD shows a “reduced accuracy” badge, and the clock is hard-limited to −4000…+4000 (proleptic Gregorian).'),
    h('p', null, 'Every displayed time is UTC. The ephemeris argument is TT = UTC + ΔT. The leap-second table is used through its IERS expiry of 2027-06-28; after that ΔT is extrapolated with a continuity-shifted polynomial and the HUD marks it “assumed”. Earth’s spin uses UT1 ≈ UTC.'),
    h('p', null, h('strong', null, 'Events are geometric. '), EVENTS_FOOTNOTE, '. Stationary points and geocentric planet parades are experimental.'),
    h('p', null, h('strong', null, 'Visuals. '), 'Planet surfaces are procedural (no photo textures); Earth’s cloud layer is visual only. “Planet size ×k” exaggerates radii for visibility (the Sun is capped at ×30) and is flagged “not to scale” in the HUD. Fly-by speeds are computed analytically from the camera path and shown in multiples of c; they are theatre, not physics.'),

    h('h3', { text: 'Licences' }),
    h('ul', null,
      h('li', null, 'VSOP87 — Bureau des Longitudes / IMCCE; free use with citation of Bretagnon & Francou (1988).'),
      h('li', null, 'JPL Horizons fixtures — NASA/JPL Solar System Dynamics, public data (used only in tests).'),
      h('li', null, 'IAU WGCCRE 2015 rotational elements — Archinal et al., Celest. Mech. Dyn. Astron. 130:22 (2018).'),
      h('li', null, 'webgl-noise (simplex noise) — Ashima Arts / Stefan Gustavson, MIT.'),
      h('li', null, h('strong', null, 'Surface maps: '),
        h('a', { href: 'https://www.solarsystemscope.com/textures/', target: '_blank', rel: 'noreferrer noopener' }, 'Solar System Scope'),
        ' texture maps, CC BY 4.0, compiled from NASA imagery and elevation data (MESSENGER, Magellan, Blue Marble, Earth at Night, Viking, Cassini, Voyager). Switch to procedural surfaces in Settings.'),
      h('li', null, 'three.js — MIT.'),
      h('li', null, 'Solar Map application code — see the repository README.')),
  );

  const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'about-title', tabindex: '-1' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'about-title', text: 'About Solar Map' }), btnClose),
    body);
  const backdrop = h('div', { class: 'dialog-backdrop', id: 'about' }, dialog);
  backdrop.hidden = true;
  root.append(backdrop);

  let openState = false;
  let lastFocus = null;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') trapFocusIn(dialog, e);
  };
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  btnClose.addEventListener('click', () => close());

  function open() {
    if (openState) return;
    openState = true;
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    dialog.addEventListener('keydown', onKey);
    dialog.focus({ preventScroll: true });
  }
  function close() {
    if (!openState) return;
    openState = false;
    backdrop.hidden = true;
    dialog.removeEventListener('keydown', onKey);
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }

  return { open, close, isOpen: () => openState, dispose() { close(); backdrop.remove(); } };
}
