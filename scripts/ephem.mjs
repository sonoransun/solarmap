#!/usr/bin/env node
// scripts/ephem.mjs — command-line ephemeris check (plan §Project layout: "CLI: npm run ephem -- 2026-09-13T12:00Z
// prints all states … and Horizons residuals where a fixture epoch matches").
//
//   node scripts/ephem.mjs                          states for "now" (Date.now())
//   node scripts/ephem.mjs 2026-09-13T12:00:00Z     any Date-parsable ISO 8601 instant, read as UTC
//   node scripts/ephem.mjs --jd 2461296.9992         Julian Date, UTC
//   node scripts/ephem.mjs --tt 2461297.0            Julian Date, TT (the scale of the Horizons fixture epochs)
//   node scripts/ephem.mjs --residuals               recompute VSOP87-vs-Horizons residuals for EVERY fixture row and
//                                                   rewrite test/fixtures/horizons/residuals.md (tables per body/epoch)
//
// Pipeline (CLAUDE.md §Frame, units, time): UTC → TT = UTC + ΔT/86400 (time.js) → ephemeris.state(body, jdTT), which
// applies TDB − TT internally and rotates VSOP87A into the scene frame (Horizons "Ecliptic of J2000.0"). Residuals
// are computed exactly as in test/horizons.test.mjs: position |Δr| in km, angle atan2(|v×h|, v·h) in arcsec
// (CLAUDE.md: never acos), velocity |Δv| in AU/day. Only astro-layer modules are used; nothing here is imported by the app.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris, PLANETS } from '../src/astro/ephemeris.js';
import { jdFromDate, ttFromUtc, utcFromTt, deltaT, tdbMinusTt, calendarFromJd } from '../src/astro/time.js';
import { AU_KM, DAY_S, ARCSEC_PER_RAD, RAD, J2000, JULIAN_YEAR_DAYS } from '../src/astro/constants.js';
import { angleBetween, wrap360 } from '../src/astro/vec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Directory of the committed Horizons fixtures (written by scripts/fetch-horizons.mjs). */
export const FIXTURE_DIR = resolve(HERE, '../test/fixtures/horizons');
/** Residual tables written by `--residuals`. */
export const RESIDUALS_MD = resolve(FIXTURE_DIR, 'residuals.md');
/** A fixture row "matches" the requested instant when the TT epochs agree within this (task spec: 1e-6 d ≈ 0.09 s). */
export const EPOCH_MATCH_D = 1e-6;

/**
 * Julian epoch year of a JD(TT): y = 2000 + (jd − J2000)/365.25 (IAU Julian epoch, Meeus AA ch. 21 eq. 21.1 form).
 * The Horizons 5-year grid JD 2415020.0 + k·1826.25 maps to exactly 1900 + 5k on this scale (2415020.0 = J1900.0),
 * which is why the plan's tolerance bands are stated in Julian epoch years, not calendar years.
 * @param {number} jdTT
 * @returns {number} Julian epoch year
 */
export function epochYear(jdTT) {
  return 2000 + (jdTT - J2000) / JULIAN_YEAR_DAYS;
}

/** Position-tolerance bands of the plan's "horizons (scene frame)" verification row, keyed by short id. */
export const BANDS = Object.freeze({
  A: '1900–2050',
  B: '1850 & 2055–2100',
  C: '1800 & 2200',
  D: '1600–1700 & 2300–2600',
});

/**
 * Band of a fixture epoch (closed Julian-epoch-year ranges with ±0.5 y slack so the Jan-1 12h TT epochs of 1700, 2300 …,
 * which are a few hundredths of a Julian year off the round number, land where the plan intends).
 * @param {number} jdTT
 * @returns {'A'|'B'|'C'|'D'}
 */
export function bandOf(jdTT) {
  const y = epochYear(jdTT);
  if (y >= 1899.5 && y <= 2050.5) return 'A';
  if (Math.abs(y - 1850) <= 0.5 || (y >= 2054.5 && y <= 2100.5)) return 'B';
  if (Math.abs(y - 1800) <= 0.5 || Math.abs(y - 2200) <= 0.5) return 'C';
  if ((y >= 1599.5 && y <= 1700.5) || (y >= 2299.5 && y <= 2600.5)) return 'D';
  throw new RangeError(`epoch JD ${jdTT} (J${y.toFixed(3)}) lies in no tolerance band`);
}

/**
 * @param {string} body one of PLANETS
 * @returns {{body:string, command:string, apiVersion:string, fetchedAt:string, targetLine:string, rows:Array<{jdTT:number, calendar:string, x:number, y:number, z:number, vx:number, vy:number, vz:number}>}}
 */
export function loadFixture(body) {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${body}.json`), 'utf8'));
}

/**
 * Residual of one ephemeris state against one Horizons row.
 * @param {{x:number,y:number,z:number,vx:number,vy:number,vz:number}} s ephemeris state (scene frame, AU, AU/day)
 * @param {{x:number,y:number,z:number,vx:number,vy:number,vz:number}} r Horizons row (same frame and units)
 * @returns {{km:number, arcsec:number, auDay:number}}
 */
export function residual(s, r) {
  return {
    km: Math.hypot(s.x - r.x, s.y - r.y, s.z - r.z) * AU_KM,
    arcsec: angleBetween([s.x, s.y, s.z], [r.x, r.y, r.z]) * ARCSEC_PER_RAD,
    auDay: Math.hypot(s.vx - r.vx, s.vy - r.vy, s.vz - r.vz),
  };
}

/**
 * Residuals of `eph.state(body, jdTT)` against every row of the body's fixture.
 * @param {ReturnType<typeof createEphemeris>} eph
 * @param {string} body
 * @returns {Array<{jdTT:number, calendar:string, year:number, band:'A'|'B'|'C'|'D', km:number, arcsec:number, auDay:number}>}
 */
export function residualsForBody(eph, body) {
  const fx = loadFixture(body);
  return fx.rows.map((r) => {
    const s = eph.state(body, r.jdTT);
    return { jdTT: r.jdTT, calendar: r.calendar, year: epochYear(r.jdTT), band: bandOf(r.jdTT), ...residual(s, r) };
  });
}

/**
 * Per-band and 1900–2100 maxima of a residual list.
 * @param {ReturnType<typeof residualsForBody>} rows
 * @returns {{bands: Record<string, {n:number, km:number, arcsec:number, auDay:number}>, window: {n:number, km:number, arcsec:number, auDay:number}}}
 */
export function summarise(rows) {
  const bands = {};
  const window = { n: 0, km: 0, arcsec: 0, auDay: 0 };
  const bump = (acc, r) => {
    acc.n++;
    if (r.km > acc.km) acc.km = r.km;
    if (r.arcsec > acc.arcsec) acc.arcsec = r.arcsec;
    if (r.auDay > acc.auDay) acc.auDay = r.auDay;
  };
  for (const r of rows) {
    bump(bands[r.band] ??= { n: 0, km: 0, arcsec: 0, auDay: 0 }, r);
    if (r.year >= 1899.5 && r.year <= 2100.5) bump(window, r);
  }
  return { bands, window };
}

// ---------------------------------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------------------------------

/** @param {number} x @param {number} w @param {number} d @returns {string} fixed-point, right-aligned */
function f(x, w, d) {
  return x.toFixed(d).padStart(w);
}
/** @param {number} x @param {number} w @param {number} d @returns {string} exponent form, right-aligned */
function e(x, w, d) {
  return x.toExponential(d).padStart(w);
}
/** @param {number} n @returns {string} integer with thin-space thousands grouping (README/About style) */
function grp(n) {
  return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
}

/**
 * 'YYYY-MM-DD hh:mm:ss.sss' (proleptic Gregorian, time.js calendarFromJd).
 * @param {number} jd @returns {string}
 */
function stamp(jd) {
  const c = calendarFromJd(jd);
  const p = (v, n = 2) => String(v).padStart(n, '0');
  const y = c.year < 0 ? '-' + p(-c.year, 4) : p(c.year, 4);
  return `${y}-${p(c.month)}-${p(c.day)} ${p(c.hour)}:${p(c.minute)}:${p(c.second)}.${p(c.ms, 3)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Print the eight planet states at one instant and the Horizons residuals if a fixture epoch matches.
 * @param {ReturnType<typeof createEphemeris>} eph
 * @param {number} jdUtc
 * @param {number} jdTT
 */
export function printStates(eph, jdUtc, jdTT) {
  const dT = deltaT(jdUtc);
  const tdb = tdbMinusTt(jdTT);
  const lines = [];
  lines.push(`Solar Map ephemeris — VSOP87A (IMCCE, ${grp(META.termsTotal)} terms after truncation) in the Horizons "Ecliptic of J2000.0" frame`);
  lines.push(`UTC  ${stamp(jdUtc)}   JD(UTC) ${jdUtc.toFixed(6)}`);
  lines.push(`TT   ${stamp(jdTT)}   JD(TT)  ${jdTT.toFixed(6)}   ΔT = ${dT.seconds.toFixed(3)} s${dT.assumed ? ' (assumed: leap-second table expired, polynomial extrapolation)' : ''}`);
  lines.push(`TDB − TT = ${tdb >= 0 ? '+' : ''}${(tdb * 1000).toFixed(3)} ms   JD(TDB) ${(jdTT + tdb / DAY_S).toFixed(9)}   (VSOP87 argument)`);
  lines.push('');
  lines.push('Heliocentric states, scene frame (x → ICRF x ≈ vernal equinox, z → ecliptic north J2000). λ/β = ecliptic longitude/latitude of J2000.');
  lines.push(`${'body'.padEnd(8)} ${'x [AU]'.padStart(17)} ${'y [AU]'.padStart(17)} ${'z [AU]'.padStart(17)} ${'vx [AU/d]'.padStart(16)} ${'vy [AU/d]'.padStart(16)} ${'vz [AU/d]'.padStart(16)} ${'r [AU]'.padStart(10)} ${'v [km/s]'.padStart(9)} ${'λ [°]'.padStart(9)} ${'β [°]'.padStart(8)}`);
  for (const body of PLANETS) {
    const s = eph.state(body, jdTT);
    const r = Math.hypot(s.x, s.y, s.z);
    const v = Math.hypot(s.vx, s.vy, s.vz) * AU_KM / DAY_S;
    const lon = wrap360(Math.atan2(s.y, s.x) * RAD);
    const lat = Math.atan2(s.z, Math.hypot(s.x, s.y)) * RAD;
    lines.push(`${body.padEnd(8)} ${f(s.x, 17, 12)} ${f(s.y, 17, 12)} ${f(s.z, 17, 12)} ${e(s.vx, 16, 8)} ${e(s.vy, 16, 8)} ${e(s.vz, 16, 8)} ${f(r, 10, 6)} ${f(v, 9, 3)} ${f(lon, 9, 4)} ${f(lat, 8, 4)}`);
  }

  // Horizons residuals when the TT epoch coincides with a fixture row (all eight fixtures share the same epoch list).
  const hits = [];
  for (const body of PLANETS) {
    const fx = loadFixture(body);
    const row = fx.rows.find((r) => Math.abs(r.jdTT - jdTT) < EPOCH_MATCH_D);
    if (row) hits.push({ body, row, res: residual(eph.state(body, row.jdTT), row) });
  }
  lines.push('');
  if (hits.length === 0) {
    lines.push(`No Horizons fixture row within ${EPOCH_MATCH_D} d of JD(TT) ${jdTT.toFixed(6)} — use --tt <JD> with an epoch from test/fixtures/README.md to compare.`);
  } else {
    const h0 = hits[0];
    lines.push(`Residuals vs JPL Horizons DE441 (${h0.row.calendar} TT, JD ${h0.row.jdTT}; heliocentric, geometric, Ecliptic of J2000.0):`);
    lines.push(`${'body'.padEnd(8)} ${'|Δr| km'.padStart(12)} ${'Δangle ″'.padStart(10)} ${'|Δv| AU/d'.padStart(12)} ${'|Δv| mm/s'.padStart(10)}   band`);
    for (const h of hits) {
      lines.push(`${h.body.padEnd(8)} ${f(h.res.km, 12, 2)} ${f(h.res.arcsec, 10, 4)} ${e(h.res.auDay, 12, 3)} ${f(h.res.auDay * AU_KM * 1e6 / DAY_S, 10, 3)}   ${BANDS[bandOf(h0.row.jdTT)]}`);
    }
    lines.push('Committed tolerances: test/horizons.test.mjs (position per band, angle/velocity for 1900–2100).');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Markdown residual tables for every body and fixture epoch (written to test/fixtures/horizons/residuals.md).
 * @param {ReturnType<typeof createEphemeris>} eph
 * @returns {string}
 */
export function renderResidualsMarkdown(eph) {
  const out = [];
  const perBody = {};
  const fetched = [];
  for (const body of PLANETS) {
    perBody[body] = residualsForBody(eph, body);
    fetched.push(loadFixture(body).fetchedAt);
  }
  const bandIds = Object.keys(BANDS);
  out.push('# VSOP87A (truncated, scene frame) − JPL Horizons DE441 residuals');
  out.push('');
  out.push('Generated by `node scripts/ephem.mjs --residuals` — do not edit by hand. Rerun after `npm run data:vsop87` or');
  out.push('`npm run data:horizons`; the committed tolerances in `test/horizons.test.mjs` must stay ≥ 1.3× the maxima below');
  out.push('(plan §Data pipeline 2; widenings are logged in `test/fixtures/README.md`).');
  out.push('');
  out.push(`- Ephemeris: \`ephemeris.state(body, jdTT)\` on \`src/astro/data/vsop87a.js\` (${grp(META.termsTotal)} terms, generated ${META.generatedAt}, cutoffs ${JSON.stringify(META.cutoffs)}), TDB − TT applied, rotated with \`M_VSOP_TO_ECL\`.`);
  fetched.sort();
  const fetchedRange = fetched[0] === fetched.at(-1) ? fetched[0] : `${fetched[0]} … ${fetched.at(-1)}`;
  out.push(`- Reference: \`test/fixtures/horizons/<body>.json\` (Horizons API ${loadFixture('earth').apiVersion}, fetched ${fetchedRange}), heliocentric, geometric, "Ecliptic of J2000.0", AU and AU/day, TT epochs.`);
  out.push('- Residuals: `|Δr|` km = |VSOP − Horizons| · 149 597 870.700; angle ″ = atan2(|v×h|, v·h) (never acos); `|Δv|` AU/d.');
  out.push('- Bands (Julian epoch years, `y = 2000 + (JD − 2451545)/365.25`): A = 1900–2050 (34 epochs incl. 2440000.5, 2460000.5, 2461297.0), B = 1850 & 2055–2100 (11), C = 1800 & 2200 (2), D = 1600–1700 & 2300–2600 (6). Angle/velocity window = 1900–2100 (44 epochs).');
  out.push('');
  out.push('## Maxima per body and band');
  out.push('');
  out.push('| body | band | n | max \\|Δr\\| km | 1.3× km | max angle ″ | max \\|Δv\\| AU/d |');
  out.push('|---|---|---:|---:|---:|---:|---:|');
  for (const body of PLANETS) {
    const { bands } = summarise(perBody[body]);
    for (const id of bandIds) {
      const b = bands[id];
      out.push(`| ${body} | ${id} ${BANDS[id]} | ${b.n} | ${b.km.toFixed(2)} | ${(1.3 * b.km).toFixed(1)} | ${b.arcsec.toFixed(4)} | ${b.auDay.toExponential(3)} |`);
    }
  }
  out.push('');
  out.push('## Maxima over 1900–2100 (angle and velocity tolerances)');
  out.push('');
  out.push('| body | n | max \\|Δr\\| km | max angle ″ | 1.3× ″ | max \\|Δv\\| AU/d | 1.3× AU/d |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const body of PLANETS) {
    const { window: w } = summarise(perBody[body]);
    out.push(`| ${body} | ${w.n} | ${w.km.toFixed(2)} | ${w.arcsec.toFixed(4)} | ${(1.3 * w.arcsec).toFixed(4)} | ${w.auDay.toExponential(3)} | ${(1.3 * w.auDay).toExponential(3)} |`);
  }
  out.push('');
  out.push('## Per-epoch residuals');
  for (const body of PLANETS) {
    out.push('');
    out.push(`### ${body} (Horizons COMMAND ${loadFixture(body).command})`);
    out.push('');
    out.push('| JD(TT) | epoch (TT) | band | \\|Δr\\| km | angle ″ | \\|Δv\\| AU/d |');
    out.push('|---:|---|:-:|---:|---:|---:|');
    for (const r of perBody[body]) {
      out.push(`| ${r.jdTT.toFixed(2)} | ${r.calendar.replace(/^A\.D\. /, '').replace(/\.0000$/, '')} | ${r.band} | ${r.km.toFixed(2)} | ${r.arcsec.toFixed(4)} | ${r.auDay.toExponential(3)} |`);
    }
  }
  out.push('');
  return out.join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{mode:'states', jdUtc:number, jdTT:number} | {mode:'residuals'}}
 */
export function parseArgs(argv) {
  if (argv.includes('--residuals')) return { mode: 'residuals' };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node scripts/ephem.mjs [ISO-8601 UTC instant | --jd <JD UTC> | --tt <JD TT> | --residuals]\n');
    process.exit(0);
  }
  const jdIdx = argv.indexOf('--jd');
  const ttIdx = argv.indexOf('--tt');
  let jdUtc;
  let jdTT;
  if (ttIdx >= 0) {
    jdTT = Number(argv[ttIdx + 1]);
    if (!Number.isFinite(jdTT)) throw new RangeError(`--tt needs a Julian Date, got '${argv[ttIdx + 1]}'`);
    jdUtc = utcFromTt(jdTT);
  } else if (jdIdx >= 0) {
    jdUtc = Number(argv[jdIdx + 1]);
    if (!Number.isFinite(jdUtc)) throw new RangeError(`--jd needs a Julian Date, got '${argv[jdIdx + 1]}'`);
    jdTT = ttFromUtc(jdUtc);
  } else {
    const iso = argv.find((a) => !a.startsWith('-'));
    const date = iso === undefined ? new Date() : new Date(iso);
    if (Number.isNaN(date.getTime())) throw new RangeError(`cannot parse '${iso}' as an ISO 8601 instant`);
    jdUtc = jdFromDate(date);
    jdTT = ttFromUtc(jdUtc);
  }
  return { mode: 'states', jdUtc, jdTT };
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const eph = createEphemeris(SERIES, { meta: META });
  if (args.mode === 'residuals') {
    const md = renderResidualsMarkdown(eph);
    writeFileSync(RESIDUALS_MD, md);
    process.stdout.write(`wrote ${RESIDUALS_MD} (${Buffer.byteLength(md)} bytes)\n`);
    // Echo the per-band maxima so a regeneration run shows at once whether the committed tolerances still hold.
    for (const body of PLANETS) {
      const { bands, window: w } = summarise(residualsForBody(eph, body));
      const cells = Object.keys(BANDS).map((id) => `${id} ${f(bands[id].km, 10, 1)} km`).join(' | ');
      process.stdout.write(`${body.padEnd(8)} ${cells} | 1900–2100 ${f(w.arcsec, 7, 4)}″ ${e(w.auDay, 9, 2)} AU/d\n`);
    }
    return;
  }
  printStates(eph, args.jdUtc, args.jdTT);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node scripts/ephem.mjs | head` closes the pipe early: exit quietly instead of dumping an EPIPE stack trace.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  try {
    main();
  } catch (err) {
    process.stderr.write(`ephem: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
