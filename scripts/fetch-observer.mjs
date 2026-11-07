#!/usr/bin/env node
/**
 * fetch-observer.mjs — one-off fixture generator for the scientist-facing quantities (`npm run data:observer`).
 *
 * Fetches, from the JPL Horizons API, the reference values that verify src/astro/apparent.js, photometry.js,
 * elements.js, orientation.js (Moon libration, Saturn ring plane) and the lunar perigee/apogee events:
 *
 *   1. OBSERVER tables, geocentric (CENTER='500@399'), for the seven planets other than Earth at 12 TT epochs
 *      2020–2027, QUANTITIES='1,2,9,14,20,29':
 *        1  astrometric RA/Dec (ICRF, light-time only)             → apparent.js astrometric place
 *        2  apparent RA/Dec (true equator & equinox of date,        → apparent.js apparent place (Horizons: "airless",
 *           "EOP-corrected IAU76/80", light-time + deflection +        light-time, stellar aberration, precession &
 *           stellar aberration + precession + nutation)               nutation, gravitational deflection)
 *        9  APmag, S-brt (Mallama & Hilton 2018 models; "n.a."       → photometry.js
 *           outside the observed phase-angle range)
 *       14  sub-observer planetodetic longitude/latitude             → geometry.js sub-Earth latitude (Saturn's ring
 *                                                                        opening B), orientation.js poles
 *       20  delta (light-time-aberrated range, AU), deldot (km/s)   → apparent.js distance / range-rate
 *       29  constellation of the astrometric position               → stored for future use
 *      → test/fixtures/horizons/observer.json (+ observer.raw.txt).
 *   2. ELEMENTS tables (EPHEM_TYPE='ELEMENTS', CENTER='500@10', REF_PLANE='ECLIPTIC', REF_SYSTEM='ICRF', AU-D,
 *      TP_TYPE='ABSOLUTE') for the Mars (4) and Jupiter (5) barycentres at four epochs that are also rows of the
 *      VECTORS fixtures mars.json / jupiter.json, so elements.js can be checked state → elements against Horizons'
 *      own osculating elements with the SAME input state. Horizons accepts only TDB for element epochs; the JD list
 *      is passed as TDB (|TDB − TT| ≤ 1.7 ms ≈ 0.04 km of Mars, far below the 1e-6 AU test tolerance).
 *      → test/fixtures/horizons/elements.json (+ elements.raw.txt).
 *   3. Saturn sub-Earth latitude every 6 h over 2025-03-01 → 2025-04-15 (QUANTITIES='14'): the sign change is the
 *      Earth's crossing of Saturn's ring plane, the independent date the gated test in test/orientation.test.mjs
 *      waited for. → test/fixtures/horizons/saturn-rings-2025.json (+ raw).
 *   4. Moon sub-Earth longitude/latitude (optical + physical libration, IAU_MOON frame) every 30 d 2024–2027
 *      (QUANTITIES='14') → test/fixtures/horizons/moon-libration.json (+ raw): verifies the IAU 2015 lunar
 *      rotational elements in bodies.js / orientation.js.
 *   5. Moon geocentric range every hour 2025-01-01 → 2025-04-01 (QUANTITIES='20') → perigee/apogee instants by a
 *      parabola through the three samples around each extremum → test/fixtures/horizons/moon-apsides-2025.json (+ raw).
 *
 * The browser app NEVER calls Horizons (NASA CORS policy, JPL fair use); fixtures are generated here and committed.
 *
 * Fair use (https://ssd-api.jpl.nasa.gov/ "API Fair Use Policy": "only one API request at a time", "backing off
 * … rather than repeatedly retrying"): exactly 12 GET requests, strictly sequential, ≥ 1.5 s apart, exponential
 * backoff 5 / 20 / 60 s on an HTTP error, network error or a response that fails validation, then abort — the same
 * discipline as scripts/fetch-horizons.mjs, whose `buildUrl` / `julianDate` / `epochList` are reused.
 *
 * Horizons quirks observed (API version 1.2, 2026-11-06): with CAL_FORMAT='JD' the first CSV column is
 * `Date_________JDTT`; the two blank columns after it are the solar/lunar presence markers; `n.a.` marks an
 * unavailable magnitude; sub-observer longitudes are WEST-positive for Mars/Mercury/Venus/Jupiter/Saturn/Uranus/
 * Neptune ("{West-longitude positive}" in the header) and EAST-positive for the Moon; sub-observer latitudes are
 * planetoDETIC (oblateness included).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { julianDate, buildUrl } from './fetch-horizons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'test', 'fixtures', 'horizons');

/** Minimum spacing between consecutive requests, ms (fair use; as fetch-horizons.mjs). */
const MIN_SPACING_MS = 1500;
/** Backoff delays after a failed attempt, ms; after the last one the script aborts. */
const BACKOFF_MS = [5000, 20000, 60000];
/** Per-request HTTP timeout, ms. */
const TIMEOUT_MS = 90000;

/**
 * OBSERVER bodies: fixture key → Horizons COMMAND id of the planet CENTRE (what an observer sees; the VECTORS fixtures
 * use the system barycentres 4–8, which differ from the centres by ≤ 290 km ≈ 0.07″ at Jupiter/Saturn — documented in
 * test/apparent.test.mjs).
 */
const OBSERVER_BODIES = [
  ['mercury', '199'], ['venus', '299'], ['mars', '499'], ['jupiter', '599'], ['saturn', '699'], ['uranus', '799'], ['neptune', '899'],
];

/**
 * OBSERVER epochs: 12 instants at 0h TT spread over 2020–2027 so Mercury and Venus are sampled at phase angles across
 * their validity ranges and Mars near and far from opposition (2022-12-08 is the opposition date).
 * @returns {number[]} JD(TT), sorted
 */
export function observerEpochs() {
  const cal = [
    [2020, 1, 1], [2020, 8, 15], [2021, 3, 1], [2021, 10, 15], [2022, 5, 1], [2022, 12, 8],
    [2023, 7, 1], [2024, 2, 1], [2024, 9, 15], [2025, 6, 1], [2026, 1, 20], [2027, 1, 1],
  ];
  return cal.map(([y, m, d]) => julianDate(y, m, d, 0));
}

/**
 * ELEMENTS epochs: four rows that exist in the VECTORS fixtures (fetch-horizons.mjs epochList): J2000.0, the grid
 * epoch 2025.0 (2415020 + 25·1826.25), 2460000.5 (2023-02-25) and 2461297.0 (2026-09-13 12h).
 * @returns {number[]}
 */
export function elementsEpochs() {
  return [2451545.0, 2460000.5, 2415020.0 + 25 * 1826.25, 2461297.0];
}

const ELEMENTS_BODIES = [['mars', '4'], ['jupiter', '5']];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requestLog = [];
let lastRequestEnd = -Infinity;

/**
 * One GET, strictly sequential with MIN_SPACING_MS between the previous response and the next request, with
 * BACKOFF_MS retries on failure (HTTP/network/validation) and abort after the last backoff.
 * @param {string} label @param {string} url @param {(text: string) => void} validate
 * @returns {Promise<string>}
 */
async function fetchSequential(label, url, validate) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestEnd + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const start = Date.now();
    let text = '';
    let error = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      validate(text);
    } catch (e) { error = e; }
    lastRequestEnd = Date.now();
    requestLog.push({ label, attempt, start, end: lastRequestEnd, ok: !error });
    if (!error) { console.log(`  ${label}: HTTP OK, ${text.length} bytes, ${lastRequestEnd - start} ms (attempt ${attempt + 1})`); return text; }
    console.error(`  ${label}: attempt ${attempt + 1} failed: ${error.message}`);
    if (attempt >= BACKOFF_MS.length) throw new Error(`${label}: giving up after ${attempt + 1} attempts (fair use: no further retries)`);
    console.error(`  backing off ${BACKOFF_MS[attempt] / 1000} s`);
    await sleep(BACKOFF_MS[attempt]);
  }
}

/** @param {string} text @param {string} prefix @returns {string} the first line starting with prefix, trimmed ('' if none) */
function headerLine(text, prefix) {
  return text.split(/\r?\n/).find((l) => l.startsWith(prefix))?.trim() ?? '';
}

/**
 * Parse a Horizons CSV table (OBSERVER or ELEMENTS): the column-name line is the line two above `$$SOE` (between two
 * rows of asterisks); data rows lie between `$$SOE` and `$$EOE`, every row ending with a trailing comma.
 * @param {string} text
 * @returns {{names: string[], rows: string[][]}} trimmed column names and row fields (same count as names)
 */
export function parseCsvTable(text) {
  for (const needle of ['API VERSION', '$$SOE', '$$EOE']) {
    if (!text.includes(needle)) throw new Error(`missing required line "${needle}"`);
  }
  const lines = text.split(/\r?\n/);
  const soe = lines.indexOf('$$SOE');
  const eoe = lines.indexOf('$$EOE');
  if (soe < 2 || eoe < soe) throw new Error('$$SOE/$$EOE block malformed');
  const names = lines[soe - 2].split(',').map((s) => s.trim());
  if (names.length < 3) throw new Error(`column-name line not found above $$SOE: "${lines[soe - 2]}"`);
  const rows = [];
  for (const line of lines.slice(soe + 1, eoe)) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length !== names.length) throw new Error(`row has ${f.length} fields, header ${names.length}: ${line}`);
    rows.push(f);
  }
  if (!rows.length) throw new Error('no data rows');
  return { names, rows };
}

/** @param {string[]} names @param {RegExp} re @returns {number} column index @throws when absent */
function col(names, re) {
  const i = names.findIndex((n) => re.test(n));
  if (i < 0) throw new Error(`column ${re} not in header [${names.join(' | ')}]`);
  return i;
}

/** @param {string} s @returns {number|null} number, or null for Horizons "n.a." */
function num(s) {
  if (s === 'n.a.' || s === '') return null;
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`not a number: "${s}"`);
  return v;
}

/**
 * Parse an OBSERVER response with QUANTITIES='1,2,9,14,20,29', ANG_FORMAT='DEG', CAL_FORMAT='JD'.
 * @param {string} text
 * @returns {{jdTT:number, raIcrfDeg:number, decIcrfDeg:number, raAppDeg:number, decAppDeg:number, apMag:number|null,
 *   surfaceBrightness:number|null, subLonDeg:number|null, subLatDeg:number|null, deltaAu:number, deldotKmS:number,
 *   constellation:string}[]}
 */
export function parseObserverRows(text) {
  const { names, rows } = parseCsvTable(text);
  const c = {
    jd: col(names, /^Date.*JD/), raI: col(names, /^R\.A\._+\(ICRF\)/), decI: col(names, /^DEC_+\(ICRF\)/),
    raA: col(names, /^R\.A\._+\(a-app\)/), decA: col(names, /^DEC_+\(a-app\)/), mag: col(names, /^APmag$/),
    sb: col(names, /^S-brt$/), slon: col(names, /^ObsSub-LON$/), slat: col(names, /^ObsSub-LAT$/),
    delta: col(names, /^delta$/), deldot: col(names, /^deldot$/), cnst: col(names, /^Cnst$/),
  };
  return rows.map((f) => ({
    jdTT: Number(f[c.jd]),
    raIcrfDeg: /** @type {number} */ (num(f[c.raI])), decIcrfDeg: /** @type {number} */ (num(f[c.decI])),
    raAppDeg: /** @type {number} */ (num(f[c.raA])), decAppDeg: /** @type {number} */ (num(f[c.decA])),
    apMag: num(f[c.mag]), surfaceBrightness: num(f[c.sb]),
    subLonDeg: num(f[c.slon]), subLatDeg: num(f[c.slat]),
    deltaAu: /** @type {number} */ (num(f[c.delta])), deldotKmS: /** @type {number} */ (num(f[c.deldot])),
    constellation: f[c.cnst],
  }));
}

/**
 * Parse a QUANTITIES='14' response (sub-observer longitude/latitude only), CAL_FORMAT='JD'.
 * @param {string} text @returns {{jd:number, subLonDeg:number, subLatDeg:number}[]}
 */
export function parseSubPointRows(text) {
  const { names, rows } = parseCsvTable(text);
  const jd = col(names, /^Date.*JD/), lon = col(names, /^ObsSub-LON$/), lat = col(names, /^ObsSub-LAT$/);
  return rows.map((f) => ({ jd: Number(f[jd]), subLonDeg: /** @type {number} */ (num(f[lon])), subLatDeg: /** @type {number} */ (num(f[lat])) }));
}

/**
 * Parse a QUANTITIES='20' response (range and range-rate), CAL_FORMAT='JD'.
 * @param {string} text @returns {{jd:number, deltaAu:number, deldotKmS:number}[]}
 */
export function parseRangeRows(text) {
  const { names, rows } = parseCsvTable(text);
  const jd = col(names, /^Date.*JD/), d = col(names, /^delta$/), dd = col(names, /^deldot$/);
  return rows.map((f) => ({ jd: Number(f[jd]), deltaAu: /** @type {number} */ (num(f[d])), deldotKmS: /** @type {number} */ (num(f[dd])) }));
}

/**
 * Parse an ELEMENTS response (CSV, AU-D, degrees, TP_TYPE='ABSOLUTE'): columns JDTDB, Calendar Date (TDB), EC, QR, IN,
 * OM, W, Tp, N, MA, TA, A, AD, PR.
 * @param {string} text
 * @returns {{jdTdb:number, ec:number, qrAu:number, inDeg:number, omDeg:number, wDeg:number, tpJd:number,
 *   nDegPerDay:number, maDeg:number, taDeg:number, aAu:number, adAu:number, prDays:number}[]}
 */
export function parseElementRows(text) {
  const { names, rows } = parseCsvTable(text);
  const c = {
    jd: col(names, /^JDTDB$/), ec: col(names, /^EC$/), qr: col(names, /^QR$/), inc: col(names, /^IN$/), om: col(names, /^OM$/),
    w: col(names, /^W$/), tp: col(names, /^Tp$/), n: col(names, /^N$/), ma: col(names, /^MA$/), ta: col(names, /^TA$/),
    a: col(names, /^A$/), ad: col(names, /^AD$/), pr: col(names, /^PR$/),
  };
  return rows.map((f) => ({
    jdTdb: Number(f[c.jd]), ec: Number(f[c.ec]), qrAu: Number(f[c.qr]), inDeg: Number(f[c.inc]), omDeg: Number(f[c.om]),
    wDeg: Number(f[c.w]), tpJd: Number(f[c.tp]), nDegPerDay: Number(f[c.n]), maDeg: Number(f[c.ma]), taDeg: Number(f[c.ta]),
    aAu: Number(f[c.a]), adAu: Number(f[c.ad]), prDays: Number(f[c.pr]),
  }));
}

/**
 * Extrema of a uniformly sampled series by the parabola through each grid extremum and its neighbours (Meeus ch. 3,
 * eqs. 3.9–3.10 — the same formula as numeric.parabolicExtremum, repeated here because scripts import nothing from
 * src/).
 * @param {{jd:number, v:number}[]} s
 * @returns {{kind:'min'|'max', jd:number, v:number}[]}
 */
export function seriesExtrema(s) {
  const out = [];
  for (let i = 1; i + 1 < s.length; i++) {
    const f0 = s[i - 1].v, f1 = s[i].v, f2 = s[i + 1].v;
    const isMin = f1 < f0 && f1 <= f2, isMax = f1 > f0 && f1 >= f2;
    if (!isMin && !isMax) continue;
    const h = s[i + 1].jd - s[i].jd;
    const c = f0 - 2 * f1 + f2, ab = f2 - f0;
    const jd = c === 0 ? s[i].jd : s[i].jd - (ab / (2 * c)) * h;
    const v = c === 0 ? f1 : f1 - (ab * ab) / (8 * c);
    out.push({ kind: isMin ? 'min' : 'max', jd, v });
  }
  return out;
}

/**
 * Sign change of a sampled series by linear interpolation (first crossing only).
 * @param {{jd:number, v:number}[]} s @returns {number|null} JD of the crossing
 */
export function firstZeroCrossing(s) {
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i].v, b = s[i + 1].v;
    if (a === 0) return s[i].jd;
    if ((a < 0) !== (b < 0)) return s[i].jd + (s[i + 1].jd - s[i].jd) * (a / (a - b));
  }
  return null;
}

const fmtJd = (jd) => (Number.isInteger(jd) ? jd.toFixed(1) : String(jd));

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const fetchedAt = new Date().toISOString();

  // 1. OBSERVER tables, seven planets ---------------------------------------------------------------------------------
  const epochs = observerEpochs();
  const tlist = epochs.map(fmtJd).join(' ');
  const observer = {
    source: 'JPL Horizons API, EPHEM_TYPE=OBSERVER, CENTER=500@399 (geocentric), QUANTITIES=1,2,9,14,20,29, '
      + 'ANG_FORMAT=DEG, EXTRA_PREC=YES, CAL_FORMAT=JD, TIME_TYPE=TT, APPARENT=AIRLESS, CSV_FORMAT=YES; planet centres 199…899',
    apiVersion: '', fetchedAt, center: '500@399', timeType: 'TT', quantities: '1,2,9,14,20,29',
    columns: {
      raIcrfDeg: 'astrometric RA, ICRF, light-time only (deg)', decIcrfDeg: 'astrometric Dec (deg)',
      raAppDeg: 'airless apparent RA, true equator & equinox of date, EOP-corrected IAU76/80, light-time + gravitational deflection + stellar aberration + precession + nutation (deg)',
      decAppDeg: 'airless apparent Dec of date (deg)', apMag: 'APmag (null = n.a.)', surfaceBrightness: 'S-brt mag/arcsec² (null = n.a.)',
      subLonDeg: 'ObsSub-LON, planetodetic, light-time corrected; WEST-positive for these bodies (deg)',
      subLatDeg: 'ObsSub-LAT, planetoDETIC (deg)', deltaAu: 'delta, light-time-aberrated range (AU)', deldotKmS: 'deldot (km/s)',
      constellation: 'Cnst, IAU constellation of the astrometric position',
    },
    epochs,
    bodies: /** @type {Record<string, object>} */ ({}),
  };
  const observerRaw = [];
  for (const [body, command] of OBSERVER_BODIES) {
    const url = buildUrl({
      format: 'text', COMMAND: command, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER', CENTER: '500@399',
      QUANTITIES: '1,2,9,14,20,29', TLIST_TYPE: 'JD', TIME_TYPE: 'TT', TLIST: tlist, CSV_FORMAT: 'YES', ANG_FORMAT: 'DEG',
      EXTRA_PREC: 'YES', CAL_FORMAT: 'JD', APPARENT: 'AIRLESS',
    });
    let rows;
    const text = await fetchSequential(`observer ${body}`, url, (t) => {
      if (!t.includes(`Target body name:`) || !t.includes(`(${command})`)) throw new Error(`target ${command} not in header`);
      if (!t.includes('Center body name: Earth (399)')) throw new Error('not geocentric');
      rows = parseObserverRows(t);
      if (rows.length !== epochs.length) throw new Error(`expected ${epochs.length} rows, got ${rows.length}`);
      for (let i = 0; i < epochs.length; i++) if (Math.abs(rows[i].jdTT - epochs[i]) > 1e-6) throw new Error(`row ${i}: JD ${rows[i].jdTT} ≠ ${epochs[i]}`);
    });
    observerRaw.push(text);
    observer.apiVersion = headerLine(text, 'API VERSION').replace('API VERSION:', '').trim();
    observer.bodies[body] = {
      command, url,
      targetLine: headerLine(text, 'Target body name'),
      poleLine: headerLine(text, 'Target pole/equ'),
      radiiLine: headerLine(text, 'Target radii'),
      rows,
    };
  }
  await writeFile(resolve(OUT_DIR, 'observer.json'), `${JSON.stringify(observer, null, 1)}\n`);
  await writeFile(resolve(OUT_DIR, 'observer.raw.txt'), observerRaw.join('\n\n==================== NEXT RESPONSE ====================\n\n'));
  console.log(`  wrote observer.json: ${OBSERVER_BODIES.length} bodies × ${epochs.length} epochs`);

  // 2. ELEMENTS, Mars and Jupiter barycentres ----------------------------------------------------------------------------
  const eEpochs = elementsEpochs();
  const elements = {
    source: 'JPL Horizons API, EPHEM_TYPE=ELEMENTS, CENTER=500@10 (Sun centre), REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF, '
      + 'OUT_UNITS=AU-D, TP_TYPE=ABSOLUTE, CSV_FORMAT=YES, TIME_TYPE=TDB (the only type Horizons accepts for elements; '
      + 'the JD list equals the TT epochs of the VECTORS fixtures, |TDB − TT| ≤ 1.7 ms)',
    apiVersion: '', fetchedAt, center: '500@10', timeType: 'TDB', epochs: eEpochs,
    columns: 'ec eccentricity; qrAu periapsis distance; inDeg inclination; omDeg longitude of ascending node; wDeg argument of periapsis; '
      + 'tpJd time of periapsis (JD TDB); nDegPerDay mean motion; maDeg mean anomaly; taDeg true anomaly; aAu semi-major axis; adAu apoapsis; prDays period',
    bodies: /** @type {Record<string, object>} */ ({}),
  };
  const elementsRaw = [];
  for (const [body, command] of ELEMENTS_BODIES) {
    const url = buildUrl({
      format: 'text', COMMAND: command, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'ELEMENTS', CENTER: '500@10',
      REF_PLANE: 'ECLIPTIC', REF_SYSTEM: 'ICRF', OUT_UNITS: 'AU-D', TLIST_TYPE: 'JD', TIME_TYPE: 'TDB',
      TLIST: eEpochs.map(fmtJd).join(' '), CSV_FORMAT: 'YES', TP_TYPE: 'ABSOLUTE',
    });
    let rows;
    const text = await fetchSequential(`elements ${body}`, url, (t) => {
      if (!t.includes(`(${command})`)) throw new Error(`target ${command} not in header`);
      if (!t.includes('Center body name: Sun (10)')) throw new Error('not heliocentric');
      if (!t.includes('Reference frame : Ecliptic of J2000.0')) throw new Error('frame is not Ecliptic of J2000.0');
      rows = parseElementRows(t);
      if (rows.length !== eEpochs.length) throw new Error(`expected ${eEpochs.length} rows, got ${rows.length}`);
      for (let i = 0; i < eEpochs.length; i++) if (Math.abs(rows[i].jdTdb - eEpochs[i]) > 1e-6) throw new Error(`row ${i}: JD ${rows[i].jdTdb} ≠ ${eEpochs[i]}`);
    });
    elementsRaw.push(text);
    elements.apiVersion = headerLine(text, 'API VERSION').replace('API VERSION:', '').trim();
    const gmLine = headerLine(text, 'Keplerian GM');
    const gm = Number((gmLine.match(/:\s*([-+0-9.Ee]+)/) || [])[1]);
    if (!Number.isFinite(gm)) throw new Error(`${body}: "Keplerian GM" line not found/parsed: "${gmLine}"`);
    elements.bodies[body] = {
      command, url, targetLine: headerLine(text, 'Target body name'), frameLine: headerLine(text, 'Reference frame'),
      unitsLine: headerLine(text, 'Output units'), keplerianGmLine: gmLine, keplerianGmAu3D2: gm, rows,
    };
  }
  await writeFile(resolve(OUT_DIR, 'elements.json'), `${JSON.stringify(elements, null, 1)}\n`);
  await writeFile(resolve(OUT_DIR, 'elements.raw.txt'), elementsRaw.join('\n\n==================== NEXT RESPONSE ====================\n\n'));
  console.log(`  wrote elements.json: ${ELEMENTS_BODIES.map(([b]) => `${b} GM ${elements.bodies[b].keplerianGmAu3D2}`).join(', ')}`);

  // 3. Saturn ring-plane crossing 2025 ---------------------------------------------------------------------------------
  const satUrl = buildUrl({
    format: 'text', COMMAND: '699', OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER', CENTER: '500@399',
    QUANTITIES: '14', START_TIME: '2025-03-01', STOP_TIME: '2025-04-15', STEP_SIZE: '6h', TIME_TYPE: 'TT',
    CSV_FORMAT: 'YES', ANG_FORMAT: 'DEG', CAL_FORMAT: 'JD',
  });
  let satRows;
  const satText = await fetchSequential('saturn sub-Earth latitude 2025', satUrl, (t) => {
    if (!t.includes('Saturn (699)')) throw new Error('target is not Saturn 699');
    satRows = parseSubPointRows(t);
    if (satRows.length < 150) throw new Error(`too few rows: ${satRows.length}`);
  });
  const satCrossing = firstZeroCrossing(satRows.map((r) => ({ jd: r.jd, v: r.subLatDeg })));
  if (satCrossing === null) throw new Error('no sign change of Saturn\'s sub-Earth latitude in the window');
  await writeFile(resolve(OUT_DIR, 'saturn-rings-2025.json'), `${JSON.stringify({
    source: 'JPL Horizons API, EPHEM_TYPE=OBSERVER, COMMAND=699 (Saturn), CENTER=500@399, QUANTITIES=14 (ObsSub-LON/ObsSub-LAT: apparent '
      + 'planetodetic sub-Earth point, light-time corrected), START_TIME=2025-03-01, STOP_TIME=2025-04-15, STEP_SIZE=6h, TIME_TYPE=TT, CAL_FORMAT=JD',
    url: satUrl, apiVersion: headerLine(satText, 'API VERSION').replace('API VERSION:', '').trim(), fetchedAt,
    poleLine: headerLine(satText, 'Target pole/equ'), radiiLine: headerLine(satText, 'Target radii'),
    method: 'The Earth crosses Saturn\'s ring (equatorial) plane when the sub-Earth latitude changes sign; the instant is the linear '
      + 'interpolation between the two 6-hour samples that bracket the sign change (planetodetic and planetocentric latitudes share the zero).',
    crossingJdTT: satCrossing,
    rows: satRows.map((r) => [r.jd, r.subLonDeg, r.subLatDeg]),
  }, null, 1)}\n`);
  await writeFile(resolve(OUT_DIR, 'saturn-rings-2025.raw.txt'), satText);
  console.log(`  wrote saturn-rings-2025.json: ${satRows.length} rows, crossing at JD(TT) ${satCrossing.toFixed(4)}`);

  // 4. Moon libration (sub-Earth point) 2024–2027 ---------------------------------------------------------------------
  const libUrl = buildUrl({
    format: 'text', COMMAND: '301', OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER', CENTER: '500@399',
    QUANTITIES: '14', START_TIME: '2024-01-01', STOP_TIME: '2027-12-31', STEP_SIZE: '30d', TIME_TYPE: 'TT',
    CSV_FORMAT: 'YES', ANG_FORMAT: 'DEG', CAL_FORMAT: 'JD',
  });
  let libRows;
  const libText = await fetchSequential('moon libration', libUrl, (t) => {
    if (!t.includes('Moon (301)')) throw new Error('target is not Moon 301');
    libRows = parseSubPointRows(t);
    if (libRows.length < 40) throw new Error(`too few rows: ${libRows.length}`);
  });
  await writeFile(resolve(OUT_DIR, 'moon-libration.json'), `${JSON.stringify({
    source: 'JPL Horizons API, EPHEM_TYPE=OBSERVER, COMMAND=301 (Moon), CENTER=500@399, QUANTITIES=14 (ObsSub-LON/ObsSub-LAT in the '
      + 'IAU_MOON frame, apparent = light-time corrected, planetodetic = planetocentric for the spherical IAU Moon), START_TIME=2024-01-01, '
      + 'STOP_TIME=2027-12-31, STEP_SIZE=30d, TIME_TYPE=TT, CAL_FORMAT=JD',
    url: libUrl, apiVersion: headerLine(libText, 'API VERSION').replace('API VERSION:', '').trim(), fetchedAt,
    poleLine: headerLine(libText, 'Target pole/equ'), radiiLine: headerLine(libText, 'Target radii'),
    rows: libRows.map((r) => ({ jdTT: r.jd, subLonDeg: r.subLonDeg, subLatDeg: r.subLatDeg })),
  }, null, 1)}\n`);
  await writeFile(resolve(OUT_DIR, 'moon-libration.raw.txt'), libText);
  console.log(`  wrote moon-libration.json: ${libRows.length} rows (${headerLine(libText, 'Target pole/equ')})`);

  // 5. Moon perigees/apogees 2025 Jan–Mar from hourly ranges ------------------------------------------------------------
  const rngUrl = buildUrl({
    format: 'text', COMMAND: '301', OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER', CENTER: '500@399',
    QUANTITIES: '20', START_TIME: '2025-01-01', STOP_TIME: '2025-04-01', STEP_SIZE: '1h', TIME_TYPE: 'TT',
    CSV_FORMAT: 'YES', CAL_FORMAT: 'JD',
  });
  let rngRows;
  const rngText = await fetchSequential('moon range 2025', rngUrl, (t) => {
    if (!t.includes('Moon (301)')) throw new Error('target is not Moon 301');
    rngRows = parseRangeRows(t);
    if (rngRows.length < 2000) throw new Error(`too few rows: ${rngRows.length}`);
  });
  const apsides = seriesExtrema(rngRows.map((r) => ({ jd: r.jd, v: r.deltaAu })))
    .map((e) => ({ kind: e.kind === 'min' ? 'perigee' : 'apogee', jdTT: e.jd, distAu: e.v, distKm: e.v * 149597870.700 }));
  if (apsides.length < 5) throw new Error(`expected ≥ 5 apsides in 3 months, got ${apsides.length}`);
  await writeFile(resolve(OUT_DIR, 'moon-apsides-2025.json'), `${JSON.stringify({
    source: 'JPL Horizons API, EPHEM_TYPE=OBSERVER, COMMAND=301 (Moon), CENTER=500@399, QUANTITIES=20 (delta = light-time-aberrated '
      + 'geocentric range, AU; deldot km/s), START_TIME=2025-01-01, STOP_TIME=2025-04-01, STEP_SIZE=1h, TIME_TYPE=TT, CAL_FORMAT=JD',
    url: rngUrl, apiVersion: headerLine(rngText, 'API VERSION').replace('API VERSION:', '').trim(), fetchedAt,
    method: 'Perigee (apogee) = parabola through the hourly sample that is a local minimum (maximum) of delta and its two neighbours '
      + '(Meeus ch. 3 eqs. 3.9–3.10); sub-minute timing for the Moon\'s smooth range curve. The light-time aberration of delta '
      + '(≤ 0.1 km) does not move the extremum at this level.',
    apsides,
    rows: rngRows.map((r) => [r.jd, r.deltaAu, r.deldotKmS]),
  }, null, 1)}\n`);
  await writeFile(resolve(OUT_DIR, 'moon-apsides-2025.raw.txt'), rngText);
  console.log(`  wrote moon-apsides-2025.json: ${rngRows.length} hourly rows, apsides: ${apsides.map((a) => `${a.kind} JD ${a.jdTT.toFixed(4)} ${a.distKm.toFixed(0)} km`).join('; ')}`);

  // Sequential-timing self-check ---------------------------------------------------------------------------------------
  for (let i = 1; i < requestLog.length; i++) {
    const gap = requestLog[i].start - requestLog[i - 1].end;
    if (gap < MIN_SPACING_MS - 5) throw new Error(`request ${i} started ${gap} ms after the previous one finished (< ${MIN_SPACING_MS})`);
  }
  console.log(`\nSequential timing OK: ${requestLog.length} requests, min gap ${Math.min(...requestLog.slice(1).map((r, i) => r.start - requestLog[i].end))} ms`);
  console.log(`Wrote observer / elements / saturn-rings-2025 / moon-libration / moon-apsides-2025 fixtures to ${OUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nFAILED: ${e.stack ?? e}`);
    process.exit(1);
  });
}
