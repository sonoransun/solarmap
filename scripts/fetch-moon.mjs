#!/usr/bin/env node
/**
 * fetch-moon.mjs — one-off fixture generator for the Moon (`npm run data:moon`).
 *
 * Fetches GEOCENTRIC state vectors of the Moon (Horizons body 301, centre 500@399) in the "Ecliptic of J2000.0" frame
 * (REF_PLANE='ECLIPTIC', REF_SYSTEM='ICRF', VEC_CORR='NONE' = geometric, OUT_UNITS='KM-S') and writes
 * `test/fixtures/horizons/moon.json` (+ the verbatim responses as `moon.raw.txt`). The browser app never calls
 * Horizons; the fixture verifies src/astro/moon.js (Meeus, Astronomical Algorithms ch. 47, abridged ELP-2000/82).
 *
 * Fair use (https://ssd-api.jpl.nasa.gov/ "API Fair Use Policy"): strictly sequential requests ≥ 1.5 s apart,
 * exponential backoff 5 / 20 / 60 s, then abort — the same discipline as scripts/fetch-horizons.mjs. Exactly three
 * requests are made:
 *   1. the 53 planet epochs of fetch-horizons.mjs (TLIST, 1600–2600 incl. the 1900–2100 5-year grid),
 *   2. a dense 3-day grid 2024-01-01 → 2027-12-31 (START/STOP/STEP; the years the guided tours visit),
 *   3. eclipse instants (TLIST): greatest eclipse / maximum of well-documented solar and lunar eclipses, from
 *      NASA GSFC eclipse pages (https://eclipse.gsfc.nasa.gov/), used to verify the eclipse detector.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { julianDate, epochList, buildUrl } from './fetch-horizons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'test', 'fixtures', 'horizons');
const MIN_SPACING_MS = 1500;
const BACKOFF_MS = [5000, 20000, 60000];
const TIMEOUT_MS = 90000;

/**
 * Eclipse instants (UT → converted to TT with the ΔT value stated on the NASA page; ΔT ≈ 69 s for 2017–2026,
 * so TT = UT + 69 s). Greatest eclipse (solar) / greatest eclipse (lunar), NASA GSFC Five Millennium Canon
 * (https://eclipse.gsfc.nasa.gov/SEcat5/SE2001-2100.html, https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html):
 *   2017-08-21 18:26:40 TD total solar (greatest eclipse), 2024-04-08 18:17:16 TD total solar,
 *   2026-08-12 17:46:59 TD total solar, 2019-07-02 19:22:57 TD total solar,
 *   2022-11-08 10:59:11 TD total lunar, 2025-03-14 06:58:43 TD total lunar, 2025-09-07 18:11:48 TD total lunar.
 * The TD (= TT) values are used directly as JD(TT).
 */
const ECLIPSE_INSTANTS_TT = [
  { label: 'solar-2017-08-21', jd: julianDate(2017, 8, 21, 18 + 26 / 60 + 40 / 3600) },
  { label: 'solar-2019-07-02', jd: julianDate(2019, 7, 2, 19 + 22 / 60 + 57 / 3600) },
  { label: 'solar-2024-04-08', jd: julianDate(2024, 4, 8, 18 + 17 / 60 + 16 / 3600) },
  { label: 'solar-2026-08-12', jd: julianDate(2026, 8, 12, 17 + 46 / 60 + 59 / 3600) },
  { label: 'lunar-2022-11-08', jd: julianDate(2022, 11, 8, 10 + 59 / 60 + 11 / 3600) },
  { label: 'lunar-2025-03-14', jd: julianDate(2025, 3, 14, 6 + 58 / 60 + 43 / 3600) },
  { label: 'lunar-2025-09-07', jd: julianDate(2025, 9, 7, 18 + 11 / 60 + 48 / 3600) },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestEnd = -Infinity;

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
    if (!error) { console.log(`  ${label}: HTTP OK, ${text.length} bytes, ${lastRequestEnd - start} ms`); return text; }
    console.error(`  ${label}: attempt ${attempt + 1} failed: ${error.message}`);
    if (attempt >= BACKOFF_MS.length) throw new Error(`${label}: giving up after ${attempt + 1} attempts`);
    await sleep(BACKOFF_MS[attempt]);
  }
}

const REQUIRED = ['API VERSION', 'Target body name: Moon (301)', 'Center body name: Earth (399)', 'Reference frame : Ecliptic of J2000.0', '$$SOE', '$$EOE'];

/**
 * Parse a CSV VECTORS response (VEC_TABLE='2', KM-S): `JD, calendar, X, Y, Z, VX, VY, VZ,`.
 * @param {string} text
 * @returns {{jdTT:number, calendar:string, x:number, y:number, z:number, vx:number, vy:number, vz:number}[]}
 */
export function parseMoonVectors(text) {
  for (const needle of REQUIRED) if (!text.includes(needle)) throw new Error(`missing required line "${needle}"`);
  if (!/Output units\s*:\s*KM-S/.test(text)) throw new Error('units are not KM-S');
  const lines = text.split(/\r?\n/);
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
  if (!rows.length) throw new Error('no rows');
  return rows;
}

const BASE = {
  format: 'text', COMMAND: '301', OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS', CENTER: '500@399',
  REF_PLANE: 'ECLIPTIC', REF_SYSTEM: 'ICRF', OUT_UNITS: 'KM-S', VEC_TABLE: '2', VEC_CORR: 'NONE', CSV_FORMAT: 'YES',
  VEC_LABELS: 'NO', TIME_TYPE: 'TT',
};
const fmt = (jd) => (Number.isInteger(jd) ? jd.toFixed(1) : String(jd));

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const raw = [];

  // 1. planet epochs
  const epochs = epochList();
  const url1 = buildUrl({ ...BASE, TLIST_TYPE: 'JD', TLIST: epochs.map(fmt).join(' ') });
  let rows1;
  raw.push(await fetchSequential('moon epochs', url1, (t) => { rows1 = parseMoonVectors(t); if (rows1.length !== epochs.length) throw new Error(`expected ${epochs.length} rows, got ${rows1.length}`); }));
  // Known row (Horizons probe run 2026-11-06, API 1.2, DE441): J2000.0 geocentric Moon
  // (−2.916083842345213E+05, −2.749797416199811E+05, 3.627119662782984E+04) km.
  const r0 = rows1.find((r) => r.jdTT === 2451545.0);
  if (!r0 || Math.abs(r0.x + 291608.3842345213) > 1e-6 || Math.abs(r0.y + 274979.7416199811) > 1e-6 || Math.abs(r0.z - 36271.19662782984) > 1e-6) {
    throw new Error(`J2000 Moon row differs from the recorded probe value: ${JSON.stringify(r0)}`);
  }
  console.log('  J2000 row matches the recorded probe to 1e-6 km');

  // 2. dense grid 2024–2027 (3-day step)
  const url2 = buildUrl({ ...BASE, START_TIME: '2024-01-01', STOP_TIME: '2027-12-31', STEP_SIZE: '3d' });
  let rows2;
  raw.push(await fetchSequential('moon 2024–2027 grid', url2, (t) => { rows2 = parseMoonVectors(t); if (rows2.length < 400) throw new Error(`too few grid rows: ${rows2.length}`); }));

  // 3. eclipse instants
  const url3 = buildUrl({ ...BASE, TLIST_TYPE: 'JD', TLIST: ECLIPSE_INSTANTS_TT.map((e) => fmt(e.jd)).join(' ') });
  let rows3;
  raw.push(await fetchSequential('moon eclipse instants', url3, (t) => { rows3 = parseMoonVectors(t); if (rows3.length !== ECLIPSE_INSTANTS_TT.length) throw new Error(`expected ${ECLIPSE_INSTANTS_TT.length} rows, got ${rows3.length}`); }));

  const fixture = {
    body: 'moon', command: '301', center: '500@399', frame: 'Ecliptic of J2000.0 (ICRF x-axis, IAU76 obliquity), geocentric, geometric (VEC_CORR=NONE)',
    units: 'km, km/s', timeType: 'TT', fetchedAt, urls: [url1, url2, url3],
    apiVersion: (raw[0].match(/API VERSION:\s*(\S+)/) || [])[1] ?? '',
    source: (raw[0].match(/Target body name: Moon \(301\)\s*(\{source: [^}]+\})/) || [])[1] ?? '',
    epochs: rows1,
    grid: rows2,
    // Horizons returns TLIST rows sorted chronologically whatever the request order: match by JD, not by index.
    eclipses: ECLIPSE_INSTANTS_TT.map((e) => {
      const row = rows3.find((r) => Math.abs(r.jdTT - e.jd) < 1e-6);
      if (!row) throw new Error(`eclipse instant ${e.label} (JD ${e.jd}) missing from the response`);
      return { label: e.label, ...row };
    }),
    notes: 'Eclipse instants are greatest-eclipse times (TD) from the NASA GSFC Five Millennium Canon pages; grid rows are every 3 days 2024-01-01 → 2027-12-31 TT.',
  };
  await writeFile(resolve(OUT_DIR, 'moon.json'), JSON.stringify(fixture, null, 1));
  await writeFile(resolve(OUT_DIR, 'moon.raw.txt'), raw.join('\n\n==================== NEXT RESPONSE ====================\n\n'));
  console.log(`wrote moon.json: ${rows1.length} epochs + ${rows2.length} grid rows + ${rows3.length} eclipse rows`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
