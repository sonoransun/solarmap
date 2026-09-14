#!/usr/bin/env node
/**
 * fetch-horizons.mjs — one-off fixture generator (`npm run data:horizons`).
 *
 * Fetches heliocentric state vectors for the eight planets from the JPL Horizons API and writes
 * them to `test/fixtures/horizons/<body>.json` (+ the verbatim response as `<body>.raw.txt`).
 * Additionally fetches a daily geocentric ecliptic-longitude table for Mars and derives the two
 * stationary (retrograde start/end) dates for the experimental stationary-point event class.
 *
 * The browser app NEVER calls Horizons (NASA CORS policy + JPL fair-use policy); fixtures are
 * generated here once and committed. VSOP87 residuals are NOT computed here (see test/horizons.test.mjs).
 *
 * Fair use (https://ssd-api.jpl.nasa.gov/ "API Fair Use Policy", verbatim excerpts):
 *   "You agree to submit only one API request at a time (no simultaneous requests)."
 *   "…backing off or reducing request rates rather than repeatedly retrying failed requests."
 * → strictly sequential requests, ≥ 1.5 s apart, exponential backoff 5 / 20 / 60 s, then abort.
 *
 * Query parameters (plan §Data pipeline 2; Horizons API doc https://ssd-api.jpl.nasa.gov/doc/horizons.html):
 *   format=text, COMMAND='<id>', OBJ_DATA='NO', MAKE_EPHEM='YES', EPHEM_TYPE='VECTORS',
 *   CENTER='500@10' (Sun body centre), REF_PLANE='ECLIPTIC', REF_SYSTEM='ICRF', OUT_UNITS='AU-D',
 *   VEC_TABLE='2' (position + velocity), VEC_CORR='NONE' (geometric), CSV_FORMAT='YES',
 *   VEC_LABELS='NO', TLIST_TYPE='JD', TIME_TYPE='TT', TLIST='<space-separated JDs>'.
 *   Never START_TIME/STOP_TIME/STEP_SIZE together with TLIST (doc: "When using TLIST, do not use any of
 *   the other time-span parameters"). Values are single-quoted exactly as in the research's working URL
 *   (research bsiou1mfc §5 / b4iv6z9la §6).
 *
 * Bodies: Mercury/Venus/Earth as planet centres 199/299/399; Mars…Neptune as system barycentres 4…8
 * (research bsiou1mfc caveat 4: Horizons 499 (mar099) has no data before 1600-01-01 TT; 499 vs 4 differ by
 * 6.4e-14 AU ≈ 1 cm at J2000; VSOP87 outer-planet series represent the barycentres).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'test', 'fixtures', 'horizons');

/** Horizons API endpoint (https://ssd-api.jpl.nasa.gov/doc/horizons.html). */
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
/** Minimum spacing between consecutive requests, ms (plan §Data pipeline 2: "1.5 s spacing"). */
const MIN_SPACING_MS = 1500;
/** Backoff delays after a failed attempt, ms (plan: "backoff 5/20/60"). After the last one the script aborts. */
const BACKOFF_MS = [5000, 20000, 60000];
/** Per-request HTTP timeout, ms. */
const TIMEOUT_MS = 90000;

/**
 * Bodies to fetch: fixture name → Horizons COMMAND id (plan §Data pipeline 2; ids verified against
 * `COMMAND='MB'` in research b4iv6z9la §6: 199 Mercury, 299 Venus, 399 Earth Geocenter, 4 Mars Barycenter,
 * 5 Jupiter Barycenter, 6 Saturn Barycenter, 7 Uranus Barycenter, 8 Neptune Barycenter).
 */
const BODIES = [
  ['mercury', '199'],
  ['venus', '299'],
  ['earth', '399'],
  ['mars', '4'],
  ['jupiter', '5'],
  ['saturn', '6'],
  ['uranus', '7'],
  ['neptune', '8'],
];

/**
 * Known reference rows (heliocentric ecliptic J2000, AU, JD 2451545.0 TT) quoted verbatim from the live
 * Horizons run in research bsiou1mfc §5 ("COMMAND='4' … 1.390715921745722E+00, -1.341631816512547E-02,
 * -3.446766277610819E-02"; "COMMAND='399' … -1.771350992582233E-01, 9.672416867691899E-01,
 * -4.085281582660778E-06"; "COMMAND='8' … 1.681204696805071E+01, -2.499176288928619E+01,
 * 1.272228799203305E-01"). Tolerance 1e-12 AU = the printed precision (16 significant digits).
 */
const KNOWN_ROWS = {
  mars: { jd: 2451545.0, x: 1.390715921745722, y: -0.01341631816512547, z: -0.03446766277610819 },
  earth: { jd: 2451545.0, x: -0.1771350992582233, y: 0.9672416867691899, z: -4.085281582660778e-6 },
  neptune: { jd: 2451545.0, x: 16.81204696805071, y: -24.99176288928619, z: 0.1272228799203305 },
};
/** Tolerance for the known-row assertions, AU (plan §Verification "scripts" row: "three known rows to 1e-12 AU"). */
const KNOWN_ROW_TOL_AU = 1e-12;

/**
 * Julian Date of a proleptic-Gregorian calendar instant.
 * Meeus, Astronomical Algorithms (2nd ed.) ch. 7, eq. 7.1 (Gregorian branch):
 *   if M ≤ 2 → Y −= 1, M += 12;  A = INT(Y/100);  B = 2 − A + INT(A/4);
 *   JD = INT(365.25 (Y + 4716)) + INT(30.6001 (M + 1)) + D + B − 1524.5
 * Checks: 2000-01-01 12h → 2451545.0; 1582-10-15 0h → 2299160.5; 1600-01-01 12h → 2305448.0.
 * @param {number} year
 * @param {number} month 1…12
 * @param {number} day 1…31
 * @param {number} [hour=0] hours (fractional allowed)
 * @returns {number} Julian Date
 */
export function julianDate(year, month, day, hour = 0) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + hour / 24 + b - 1524.5;
}

/**
 * Epoch list (JD TT), plan §Data pipeline 2:
 *  - 41-epoch grid JD 2415020.0 + k·1826.25, k = 0…40 (1900-01-00.5 … 2100, every 5 Julian years; k = 20 is J2000
 *    exactly: 2415020 + 20·1826.25 = 2451545.0). Multiples of 0.25 are exact in binary, so JD keys match exactly.
 *  - Jan 1 12:00 TT of 1600, 1700, 1800, 1850, 2200, 2300, 2400, 2500, 2600 (proleptic Gregorian; the critique
 *    byf0bzyiw asked for 2600 so the advertised 1600–2600 band is covered).
 *  - 2440000.5 (1968-05-24 0h), 2460000.5 (2023-02-25 0h), 2461297.0 (2026-09-13 12h TT) — the research
 *    proof-of-concept epochs (bsiou1mfc §5, byf0bzyiw sub-solar fixtures).
 * @returns {number[]} sorted, de-duplicated JDs
 */
export function epochList() {
  const jds = [];
  for (let k = 0; k <= 40; k++) jds.push(2415020.0 + k * 1826.25);
  for (const y of [1600, 1700, 1800, 1850, 2200, 2300, 2400, 2500, 2600]) jds.push(julianDate(y, 1, 1, 12));
  jds.push(2440000.5, 2460000.5, 2461297.0);
  return [...new Set(jds)].sort((p, q) => p - q);
}

/**
 * Format a JD for TLIST. Horizons treats a bare integer fine, but always print a decimal point so the
 * list is unambiguous (a value < 625360.5 would flip the list to MJD without TLIST_TYPE='JD'; we set it anyway).
 * @param {number} jd
 * @returns {string}
 */
function formatJd(jd) {
  return Number.isInteger(jd) ? jd.toFixed(1) : String(jd);
}

/**
 * Build the Horizons GET URL. `URLSearchParams` encodes `'` → %27, `@` → %40 and space → `+`, which is
 * byte-for-byte the working URL of research bsiou1mfc §5.
 * @param {Record<string, string>} params
 * @returns {string}
 */
export function buildUrl(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, k === 'format' ? v : `'${v}'`);
  return `${API}?${sp.toString()}`;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Timing log used by the sequential-timing self-check. */
const requestLog = [];
let lastRequestEnd = -Infinity;

/**
 * Perform one GET, strictly sequential: waits until MIN_SPACING_MS have elapsed since the previous
 * request finished. Retries with BACKOFF_MS on HTTP errors, network errors or a `validate` failure
 * (Horizons reports its own errors inside a 200 response, e.g. a missing `$$SOE`).
 * @param {string} label for logging
 * @param {string} url
 * @param {(text: string) => void} validate throws on an unusable response
 * @returns {Promise<string>} response text
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
    } catch (e) {
      error = e;
    }
    lastRequestEnd = Date.now();
    requestLog.push({ label, attempt, start, end: lastRequestEnd, ok: !error });
    if (!error) {
      console.log(`  ${label}: HTTP OK, ${text.length} bytes, ${lastRequestEnd - start} ms (attempt ${attempt + 1})`);
      return text;
    }
    console.error(`  ${label}: attempt ${attempt + 1} failed: ${error.message}`);
    if (attempt >= BACKOFF_MS.length) {
      throw new Error(`${label}: giving up after ${attempt + 1} attempts (fair use: no further retries)`);
    }
    console.error(`  backing off ${BACKOFF_MS[attempt] / 1000} s`);
    await sleep(BACKOFF_MS[attempt]);
  }
}

/**
 * Header lines the plan requires in every VECTORS response (plan §Data pipeline 2; verbatim from the
 * research response bsiou1mfc §5). `Output units    : AU-D` has exactly four spaces before the colon.
 */
const REQUIRED_VECTOR_LINES = [
  'API VERSION',
  'Center body name: Sun (10)',
  'Reference frame : Ecliptic of J2000.0',
  'Output units    : AU-D',
  '$$SOE',
  '$$EOE',
];

/**
 * Validate and parse a Horizons VECTORS text response (CSV_FORMAT='YES', VEC_TABLE='2').
 * Rows: `JD, calendar, X, Y, Z, VX, VY, VZ,` (trailing comma) between `$$SOE` and `$$EOE`.
 * @param {string} text
 * @param {number[]} epochs expected JDs (Horizons returns rows sorted chronologically, research bsiou1mfc caveat 8)
 * @returns {{apiVersion: string, targetLine: string, centerLine: string, frameLine: string, unitsLine: string,
 *   rows: {jdTT: number, calendar: string, x: number, y: number, z: number, vx: number, vy: number, vz: number}[]}}
 */
export function parseVectors(text, epochs) {
  for (const needle of REQUIRED_VECTOR_LINES) {
    if (!text.includes(needle)) throw new Error(`missing required line "${needle}"`);
  }
  const lines = text.split(/\r?\n/);
  const findLine = (prefix) => lines.find((l) => l.startsWith(prefix)) ?? '';
  const apiVersion = findLine('API VERSION').replace('API VERSION:', '').trim();
  const targetLine = findLine('Target body name').trim();
  const centerLine = findLine('Center body name').trim();
  const frameLine = findLine('Reference frame').trim();
  const unitsLine = findLine('Output units').trim();
  const soe = lines.indexOf('$$SOE');
  const eoe = lines.indexOf('$$EOE');
  if (soe < 0 || eoe < soe) throw new Error('$$SOE/$$EOE block malformed');
  const rows = [];
  for (const line of lines.slice(soe + 1, eoe)) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 8) throw new Error(`short row: ${line}`);
    const nums = f.slice(2, 8).map(Number);
    const jdTT = Number(f[0]);
    if (!Number.isFinite(jdTT) || nums.some((v) => !Number.isFinite(v))) throw new Error(`bad row: ${line}`);
    rows.push({ jdTT, calendar: f[1], x: nums[0], y: nums[1], z: nums[2], vx: nums[3], vy: nums[4], vz: nums[5] });
  }
  if (rows.length !== epochs.length) throw new Error(`expected ${epochs.length} rows, got ${rows.length}`);
  for (let i = 0; i < epochs.length; i++) {
    if (rows[i].jdTT !== epochs[i]) throw new Error(`row ${i}: JD ${rows[i].jdTT} ≠ requested ${epochs[i]}`);
    if (i > 0 && rows[i].jdTT <= rows[i - 1].jdTT) throw new Error('rows not sorted');
  }
  return { apiVersion, targetLine, centerLine, frameLine, unitsLine, rows };
}

/**
 * Validate and parse a Horizons OBSERVER response with QUANTITIES='31' (CSV_FORMAT='YES', ANG_FORMAT='DEG').
 * Rows: ` YYYY-Mon-DD HH:MM, <solar presence>, <lunar presence>, ObsEcLon, ObsEcLat,` — ObsEcLon/ObsEcLat are the
 * observer-centred (geocentric) APPARENT ecliptic-of-date longitude/latitude in degrees (Horizons manual §31;
 * research bq2vila6z §HZA).
 * @param {string} text
 * @returns {{date: string, lon: number, lat: number}[]}
 */
export function parseObserverEcLon(text) {
  for (const needle of ['API VERSION', 'ObsEcLon', '$$SOE', '$$EOE']) {
    if (!text.includes(needle)) throw new Error(`missing required line "${needle}"`);
  }
  const lines = text.split(/\r?\n/);
  const soe = lines.indexOf('$$SOE');
  const eoe = lines.indexOf('$$EOE');
  if (soe < 0 || eoe < soe) throw new Error('$$SOE/$$EOE block malformed');
  const out = [];
  for (const line of lines.slice(soe + 1, eoe)) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    // trailing comma → last field empty; ObsEcLon and ObsEcLat are the two fields before it
    const lat = Number(f[f.length - 2]);
    const lon = Number(f[f.length - 3]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`bad observer row: ${line}`);
    out.push({ date: f[0], lon, lat });
  }
  if (out.length < 3) throw new Error('too few observer rows');
  return out;
}

/** Horizons month abbreviations → month number (calendar strings like `2024-Oct-01 00:00`). */
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/**
 * Convert a Horizons calendar string `YYYY-Mon-DD HH:MM` to JD (UT here).
 * @param {string} s
 * @returns {number}
 */
function jdFromHorizonsDate(s) {
  const m = /^(\d{4})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s);
  if (!m) throw new Error(`unparseable date "${s}"`);
  return julianDate(+m[1], MONTHS[m[2]], +m[3], +m[4] + m[5] / 60);
}

/**
 * Inverse of julianDate for output labels (Meeus ch. 7 "Calendar date from JD", Gregorian branch).
 * @param {number} jd
 * @returns {string} ISO-like `YYYY-MM-DDTHH:MM` (UT)
 */
export function isoFromJd(jd) {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  const alpha = Math.floor((z - 1867216.25) / 36524.25);
  const a = z + 1 + alpha - Math.floor(alpha / 4);
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  const minutes = Math.round(f * 1440);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${year}-${p(month)}-${p(day)}T${p(hh)}:${p(mm)}`;
}

/**
 * Stationary instants from a daily longitude table: the finite difference v_i = λ(i+1) − λ(i)
 * (wrapped to (−180°, 180°]) is the mean rate over [t_i, t_i+1], attributed to the interval midpoint;
 * a sign change between consecutive v_i is a stationary point, located by linear interpolation of v.
 * + → − : retrograde begins; − → + : retrograde ends. Sub-day accuracy (~1 h) is more than the ±1 d
 * tolerance of the experimental stationary-point test needs.
 * @param {{date: string, lon: number}[]} table
 * @returns {{jd: number, iso: string, kind: 'retrograde-start' | 'retrograde-end'}[]}
 */
export function stationaryPoints(table) {
  const t = table.map((r) => jdFromHorizonsDate(r.date));
  const v = [];
  for (let i = 0; i + 1 < table.length; i++) {
    let d = table[i + 1].lon - table[i].lon;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    v.push({ tm: 0.5 * (t[i] + t[i + 1]), d });
  }
  const out = [];
  for (let i = 0; i + 1 < v.length; i++) {
    if (v[i].d === 0 || Math.sign(v[i].d) === Math.sign(v[i + 1].d)) continue;
    const jd = v[i].tm + (v[i + 1].tm - v[i].tm) * (v[i].d / (v[i].d - v[i + 1].d));
    out.push({ jd, iso: isoFromJd(jd), kind: v[i].d > 0 ? 'retrograde-start' : 'retrograde-end' });
  }
  return out;
}

/**
 * @param {string} body
 * @param {{rows: {jdTT: number, x: number, y: number, z: number}[]}} parsed
 */
function assertKnownRow(body, parsed) {
  const k = KNOWN_ROWS[body];
  if (!k) return;
  const row = parsed.rows.find((r) => r.jdTT === k.jd);
  if (!row) throw new Error(`${body}: known row JD ${k.jd} not returned`);
  for (const c of ['x', 'y', 'z']) {
    const diff = Math.abs(row[c] - k[c]);
    if (!(diff <= KNOWN_ROW_TOL_AU)) {
      throw new Error(`${body}: known row ${c} = ${row[c]} differs from research value ${k[c]} by ${diff} AU (> ${KNOWN_ROW_TOL_AU})`);
    }
  }
  console.log(`  ${body}: known J2000 row matches research values to ≤ ${KNOWN_ROW_TOL_AU} AU`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const epochs = epochList();
  console.log(`Epochs (${epochs.length}, JD TT): ${epochs.map(formatJd).join(' ')}`);
  // JD routine self-check (Meeus ch. 7 worked values)
  for (const [y, m, d, h, jd] of [[2000, 1, 1, 12, 2451545.0], [1582, 10, 15, 0, 2299160.5], [1600, 1, 1, 12, 2305448.0], [1968, 5, 24, 0, 2440000.5]]) {
    if (julianDate(y, m, d, h) !== jd) throw new Error(`julianDate(${y},${m},${d},${h}) = ${julianDate(y, m, d, h)} ≠ ${jd}`);
    if (isoFromJd(jd) !== `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`) throw new Error(`isoFromJd(${jd}) = ${isoFromJd(jd)}`);
  }
  const tlist = epochs.map(formatJd).join(' ');
  const fetchedAt = new Date().toISOString();

  const summary = [];
  for (const [body, command] of BODIES) {
    console.log(`\n[${body}] COMMAND='${command}'`);
    const url = buildUrl({
      format: 'text',
      COMMAND: command,
      OBJ_DATA: 'NO',
      MAKE_EPHEM: 'YES',
      EPHEM_TYPE: 'VECTORS',
      CENTER: '500@10',
      REF_PLANE: 'ECLIPTIC',
      REF_SYSTEM: 'ICRF',
      OUT_UNITS: 'AU-D',
      VEC_TABLE: '2',
      VEC_CORR: 'NONE',
      CSV_FORMAT: 'YES',
      VEC_LABELS: 'NO',
      TLIST_TYPE: 'JD',
      TIME_TYPE: 'TT',
      TLIST: tlist,
    });
    let parsed;
    const text = await fetchSequential(body, url, (t) => {
      parsed = parseVectors(t, epochs);
    });
    assertKnownRow(body, parsed);
    await writeFile(resolve(OUT_DIR, `${body}.raw.txt`), text);
    const fixture = {
      body,
      command,
      url,
      apiVersion: parsed.apiVersion,
      fetchedAt,
      targetLine: parsed.targetLine,
      centerLine: parsed.centerLine,
      frameLine: parsed.frameLine,
      unitsLine: parsed.unitsLine,
      rows: parsed.rows,
    };
    await writeFile(resolve(OUT_DIR, `${body}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    const j2000 = parsed.rows.find((r) => r.jdTT === 2451545.0);
    summary.push({ body, command, rows: parsed.rows.length, target: parsed.targetLine, j2000: `${j2000.x} ${j2000.y} ${j2000.z}` });
  }

  // Mars daily geocentric apparent ecliptic longitude → stationary dates (plan §Data pipeline 2)
  console.log(`\n[mars-stationary-2024] OBSERVER table, QUANTITIES='31'`);
  const obsUrl = buildUrl({
    format: 'text',
    COMMAND: '499',
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    CENTER: '500@399',
    QUANTITIES: '31',
    START_TIME: '2024-10-01',
    STOP_TIME: '2025-04-01',
    STEP_SIZE: '1d',
    CSV_FORMAT: 'YES',
    ANG_FORMAT: 'DEG',
    TIME_TYPE: 'UT',
  });
  let table;
  const obsText = await fetchSequential('mars-observer', obsUrl, (t) => {
    table = parseObserverEcLon(t);
  });
  await writeFile(resolve(OUT_DIR, 'mars-stationary-2024.raw.txt'), obsText);
  const points = stationaryPoints(table);
  if (points.length !== 2 || points[0].kind !== 'retrograde-start' || points[1].kind !== 'retrograde-end') {
    throw new Error(`expected exactly one retrograde start and one end, got ${JSON.stringify(points)}`);
  }
  const stationary = {
    source: 'JPL Horizons API, EPHEM_TYPE=OBSERVER, COMMAND=499 (Mars), CENTER=500@399 (geocentric), QUANTITIES=31 '
      + '(ObsEcLon/ObsEcLat: apparent ecliptic-of-date longitude/latitude, light-time + aberration), '
      + 'START_TIME=2024-10-01, STOP_TIME=2025-04-01, STEP_SIZE=1d, TIME_TYPE=UT, ANG_FORMAT=DEG',
    url: obsUrl,
    apiVersion: obsText.split(/\r?\n/).find((l) => l.startsWith('API VERSION'))?.replace('API VERSION:', '').trim() ?? '',
    fetchedAt,
    body: 'mars',
    rowsParsed: table.length,
    dates: points.map((p) => p.iso.slice(0, 10)),
    instants: points.map((p) => ({ kind: p.kind, jdUt: p.jd, iso: p.iso })),
    method: 'Daily finite differences v_i = λ(i+1) − λ(i) of the apparent geocentric ecliptic longitude '
      + '(wrapped to (−180°,180°]) attributed to the interval midpoints; a sign change of v between consecutive '
      + 'intervals is a stationary point, located by linear interpolation of v. + → − = retrograde start, '
      + '− → + = retrograde end. Apparent (of-date, light-time/aberration) vs geometric J2000 timing differs by '
      + 'well under a day; test tolerance ±1 d (plan §Verification events row).',
    lon: table.map((r) => [r.date, r.lon]),
  };
  await writeFile(resolve(OUT_DIR, 'mars-stationary-2024.json'), `${JSON.stringify(stationary, null, 2)}\n`);
  console.log(`  ${table.length} daily rows; stationary points: ${points.map((p) => `${p.kind} ${p.iso}`).join(', ')}`);

  // Sequential-timing self-check (plan §Verification "scripts" row: "sequential timing")
  for (let i = 1; i < requestLog.length; i++) {
    const gap = requestLog[i].start - requestLog[i - 1].end;
    if (gap < MIN_SPACING_MS - 5) throw new Error(`request ${i} started ${gap} ms after the previous one finished (< ${MIN_SPACING_MS})`);
  }
  console.log(`\nSequential timing OK: ${requestLog.length} requests, min gap ${Math.min(...requestLog.slice(1).map((r, i) => r.start - requestLog[i].end))} ms`);
  console.log('\nbody     id  rows  J2000 X Y Z (AU)                                              target');
  for (const s of summary) console.log(`${s.body.padEnd(8)} ${s.command.padEnd(3)} ${String(s.rows).padStart(4)}  ${s.j2000.padEnd(64)} ${s.target}`);
  console.log(`\nWrote ${BODIES.length} vector fixtures + mars-stationary-2024 to ${OUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\nFAILED: ${e.stack ?? e}`);
    process.exit(1);
  });
}
