#!/usr/bin/env node
// Build the VSOP87A data module and its test fixtures (plan §Data pipeline 1).
//
//   node scripts/build-vsop87.mjs        (npm run data:vsop87)
//
// 1. Fetch VSOP87A.{mer,ven,ear,mar,jup,sat,ura,nep} + vsop87.chk from IMCCE into data/raw/ (skipped when a cached
//    copy with the expected byte size exists).
// 2. Parse by FIXED COLUMNS only (vsop87.doc TERM RECORD "1x,4i1,i5,12i3,f15.11,2f18.11,f14.11,f20.11", HEADER RECORD
//    "17x,i1,4x,a7,12x,i1,17x,i1,i7"; vsop87.f reads "79x,f18.11,f14.11,f20.11").
// 3. Assert per-file totals and header structure; self-check the FULL series against every VSOP87A row of vsop87.chk
//    (8 bodies × 10 epochs, positions and velocities) to ≤ 2e-10; abort otherwise.
// 4. Sort each series by |A| descending (stable), apply per-body amplitude cutoffs, record the 1e-7 display prefix,
//    measure truncated-vs-full and display-vs-full bounds.
// 5. Write src/astro/data/vsop87a.js, test/fixtures/vsop87-chk.json, test/fixtures/vsop87a-full-reference.json.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvaluator, BODY_KEYS, COORD_KEYS, DISPLAY_CUTOFF_AU, prefixCount } from '../src/astro/vsop87.js';
import { AU_KM, J2000 } from '../src/astro/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const OUT_MODULE = path.join(ROOT, 'src', 'astro', 'data', 'vsop87a.js');
const OUT_CHK_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'vsop87-chk.json');
const OUT_REF_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'vsop87a-full-reference.json');

/** IMCCE mirror of VSOP87 (Bretagnon & Francou 1988, A&A 202, 309). */
const BASE_URL = 'https://ftp.imcce.fr/pub/ephem/planets/vsop87/';
const CHK_FILE = 'vsop87.chk';
const FILES = {
  mercury: 'VSOP87A.mer', venus: 'VSOP87A.ven', earth: 'VSOP87A.ear', mars: 'VSOP87A.mar',
  jupiter: 'VSOP87A.jup', saturn: 'VSOP87A.sat', uranus: 'VSOP87A.ura', neptune: 'VSOP87A.nep',
};
/** Content-Length of each file on the mirror (ephemeris research §1.2, HEAD 2026-09-13, Last-Modified 05 Apr 2005). */
const EXPECTED_BYTES = {
  'VSOP87A.mer': 848141, 'VSOP87A.ven': 315875, 'VSOP87A.ear': 472948, 'VSOP87A.mar': 943103,
  'VSOP87A.jup': 592116, 'VSOP87A.sat': 1001490, 'VSOP87A.ura': 705299, 'VSOP87A.nep': 352450,
};
/** Term totals per file (ephemeris research §1.4; README record counts minus headers). */
const EXPECTED_TERMS = {
  mercury: 6359, venus: 2357, earth: 3538, mars: 7073, jupiter: 4434, saturn: 7512, uranus: 5289, neptune: 2636,
};
/** Header term counts per coordinate and power (ephemeris research §1.4 for Mars; POC §4 for Neptune). */
const EXPECTED_HEADERS = {
  mars: { x: [1584, 956, 387, 135, 41, 21], y: [1612, 969, 384, 136, 44, 21], z: [355, 232, 122, 51, 16, 7] },
  // Uranus and Neptune have no T⁵ series and their Z has no T⁴: 5 + 5 + 4 = 14 headers each
  // (README record counts: ura 5303 = 5289 + 14, nep 2650 = 2636 + 14; ephemeris research §1.2).
  uranus: { x: [1464, 649, 249, 84, 12], y: [1447, 659, 255, 80, 12], z: [235, 98, 33, 12] },
  neptune: { x: [772, 330, 102, 33, 7], y: [746, 325, 97, 34, 7], z: [133, 37, 11, 2] },
};
/** Header (series) count per file: 3 coordinates × 6 powers, except the ice giants (see EXPECTED_HEADERS). */
const EXPECTED_HEADER_COUNT = {
  mercury: 18, venus: 18, earth: 18, mars: 18, jupiter: 18, saturn: 18, uranus: 14, neptune: 14,
};
/** Amplitude cutoffs |A| ≥ cutoff (AU), plan §Decisions 2: 1e-9 Mercury–Mars, 1e-8 Jupiter/Saturn, full ice giants. */
const CUTOFFS = {
  mercury: 1e-9, venus: 1e-9, earth: 1e-9, mars: 1e-9, jupiter: 1e-8, saturn: 1e-8, uranus: 0, neptune: 0,
};
/** Expected kept counts after the cutoffs (POC §7 / plan vsop87 test row). Printed as a warning if different. */
const EXPECTED_KEPT = {
  mercury: 1485, venus: 1347, earth: 2202, mars: 4997, jupiter: 3235, saturn: 6583, uranus: 5289, neptune: 2636,
};
/** Self-check tolerance vs vsop87.chk (printed to 10 decimals → rounding ≤ 5e-11; POC observed ≤ 5e-11). */
const CHK_TOL_AU = 2e-10;
const CHK_TOL_AU_DAY = 2e-10;
/** Measurement grid: JD 2415020.0 + k·1826.25 (k = 0…40; 1900–2100 every 5 y, J2000 at k = 20) + 1800 + 2200. */
const GRID = Array.from({ length: 41 }, (_, k) => 2415020.0 + k * 1826.25);
const EXTRA_EPOCHS = [2378496.5, 2524594.0]; // 1800-01-01 0h, 2200-01-02 12h (plan §Data pipeline)
const CHK_NAMES = {
  mercury: 'MERCURY', venus: 'VENUS', earth: 'EARTH', mars: 'MARS',
  jupiter: 'JUPITER', saturn: 'SATURN', uranus: 'URANUS', neptune: 'NEPTUNE',
};

function fail(msg) {
  console.error(`\nbuild-vsop87: ${msg}`);
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function norm3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function fmtKm(au) {
  return (au * AU_KM).toFixed(3).padStart(10);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Fetch (sequential; cached in data/raw which is git-ignored)
// ---------------------------------------------------------------------------------------------------------------
/**
 * @param {string} name file name on the mirror
 * @param {number|undefined} expectedBytes
 * @returns {Promise<{buffer: Buffer, fetched: boolean, mtime: Date}>}
 */
async function ensureFile(name, expectedBytes) {
  const p = path.join(RAW_DIR, name);
  try {
    const s = await stat(p);
    if (s.size > 0 && (expectedBytes === undefined || s.size === expectedBytes)) {
      console.log(`  cached  ${name} (${s.size} bytes)`);
      return { buffer: await readFile(p), fetched: false, mtime: s.mtime };
    }
    console.log(`  cached ${name} has ${s.size} bytes, expected ${expectedBytes}; re-fetching`);
  } catch { /* not cached */ }
  const url = BASE_URL + name;
  console.log(`  fetch   ${url}`);
  const res = await fetch(url);
  assert(res.ok, `HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert(expectedBytes === undefined || buffer.length === expectedBytes,
    `${name}: got ${buffer.length} bytes, expected ${expectedBytes}`);
  await writeFile(p, buffer);
  return { buffer, fetched: true, mtime: new Date() };
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Fixed-column parser
// ---------------------------------------------------------------------------------------------------------------
/**
 * @typedef {{A: string, B: string, C: string, a: number}} Term  raw decimal strings + numeric |A| for sorting/cutoff
 */
/**
 * @param {string} text VSOP87A file content
 * @param {string} name for messages
 * @returns {{coords: Term[][][], headers: {ic: number, alpha: number, n: number}[]}} coords[ic][alpha] = Term[]
 */
function parseVsop87a(text, name) {
  const lines = text.split('\n');
  /** @type {Term[][][]} */
  const coords = [[], [], []];
  const headers = [];
  let cur = null;
  let curHeader = null;
  for (const line of lines) {
    if (line.startsWith(' VSOP87')) {
      // HEADER RECORD 17x,i1,4x,a7,12x,i1,17x,i1,i7 → ic col 42, it col 60, in cols 61–67 (1-based)
      const ic = +line[41];
      const alpha = +line[59];
      const n = +line.slice(60, 67);
      assert(ic >= 1 && ic <= 3, `${name}: bad coordinate index in header: ${line}`);
      assert(alpha >= 0 && alpha <= 5, `${name}: bad power in header: ${line}`);
      assert(line[17] === '1', `${name}: header is not VSOP87A (version code '${line[17]}')`);
      assert(coords[ic - 1][alpha] === undefined, `${name}: duplicate header ic=${ic} alpha=${alpha}`);
      cur = [];
      curHeader = { ic, alpha, n };
      coords[ic - 1][alpha] = cur;
      headers.push(curHeader);
      continue;
    }
    if (line.length < 131) {
      assert(line.trim() === '', `${name}: short non-blank line: '${line}'`);
      continue;
    }
    assert(cur !== null, `${name}: term record before any header`);
    // TERM RECORD 1x,4i1,i5,12i3,f15.11,2f18.11,f14.11,f20.11 → A cols 80–97, B cols 98–111, C cols 112–131 (1-based)
    assert(line[1] === '1' && +line[3] === curHeader.ic && +line[4] === curHeader.alpha,
      `${name}: term record does not match its header: '${line.slice(0, 12)}'`);
    const A = line.slice(79, 97).trim();
    const B = line.slice(97, 111).trim();
    const C = line.slice(111, 131).trim();
    for (const [k, v] of [['A', A], ['B', B], ['C', C]]) {
      assert(/^-?\d+\.\d+$/.test(v), `${name}: field ${k} is not a plain decimal: '${v}'`);
    }
    cur.push({ A, B, C, a: Number(A) });
  }
  for (const h of headers) {
    assert(coords[h.ic - 1][h.alpha].length === h.n,
      `${name}: series ic=${h.ic} alpha=${h.alpha} has ${coords[h.ic - 1][h.alpha].length} terms, header says ${h.n}`);
  }
  for (let ic = 0; ic < 3; ic++) {
    for (let a = 0; a < coords[ic].length; a++) {
      assert(coords[ic][a] !== undefined, `${name}: coordinate ${ic + 1} has a hole at power ${a}`);
    }
  }
  return { coords, headers };
}

/**
 * Parse the VSOP87A rows of vsop87.chk:
 *   " VSOP87A  MERCURY     JD2451545.0  01/01/2000 12h TDB"
 *   " x   -.1300934115  au       y   -.4472876716  au       z   -.0245983802  au"
 *   " x'   .0213663982  au/d     y'  -.0064479797  au/d     z'  -.0024878668  au/d"
 * @param {string} text
 * @returns {Record<string, {jd: number, pos: number[], vel: number[]}[]>} keyed by upper-case body name
 */
function parseChk(text) {
  const lines = text.split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^ VSOP87A\s+([A-Z]+)\s+JD(\d+\.\d+)/.exec(lines[i]);
    if (!m) continue;
    const p = /^ x\s+(-?\d*\.\d+)\s+au\s+y\s+(-?\d*\.\d+)\s+au\s+z\s+(-?\d*\.\d+)\s+au/.exec(lines[i + 1] ?? '');
    const v = /^ x'\s+(-?\d*\.\d+)\s+au\/d\s+y'\s+(-?\d*\.\d+)\s+au\/d\s+z'\s+(-?\d*\.\d+)\s+au\/d/.exec(lines[i + 2] ?? '');
    assert(p && v, `vsop87.chk: cannot parse the rows after line ${i + 1}: '${lines[i]}'`);
    (out[m[1]] ??= []).push({ jd: +m[2], pos: [+p[1], +p[2], +p[3]], vel: [+v[1], +v[2], +v[3]] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// helpers to turn parsed terms into a SERIES object for the evaluator
// ---------------------------------------------------------------------------------------------------------------
/** @param {Term[][][]} coords @returns {{x:number[][], y:number[][], z:number[][]}} */
function toNumericSeries(coords) {
  const s = {};
  for (let ic = 0; ic < 3; ic++) {
    s[COORD_KEYS[ic]] = coords[ic].map((terms) => {
      const flat = new Array(terms.length * 3);
      for (let i = 0; i < terms.length; i++) {
        flat[3 * i] = terms[i].a;
        flat[3 * i + 1] = Number(terms[i].B);
        flat[3 * i + 2] = Number(terms[i].C);
      }
      return flat;
    });
  }
  return s;
}

/** @param {ReturnType<typeof createEvaluator>} ev @param {string} body @param {number} jd @param {'full'|'display'} tier */
function evalPV(ev, body, jd, tier = 'full') {
  const s = ev.evalRaw(body, jd, { tier, velocity: true });
  return { pos: [s.x, s.y, s.z], vel: [s.vx, s.vy, s.vz] };
}

/** @param {number} x @returns {number} 15 significant digits */
function sig15(x) {
  return Number(x.toPrecision(15));
}

// ---------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------
async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_MODULE), { recursive: true });
  await mkdir(path.dirname(OUT_CHK_FIXTURE), { recursive: true });

  console.log('Fetching / reading raw files');
  const rawFiles = {};
  const sha = {};
  let fetchedAt = null;
  for (const body of BODY_KEYS) {
    const name = FILES[body];
    const f = await ensureFile(name, EXPECTED_BYTES[name]);
    rawFiles[body] = f.buffer.toString('latin1');
    sha[name] = sha256(f.buffer);
    if (fetchedAt === null || f.mtime < fetchedAt) fetchedAt = f.mtime;
  }
  const chk = await ensureFile(CHK_FILE, undefined);
  sha[CHK_FILE] = sha256(chk.buffer);
  const chkRows = parseChk(chk.buffer.toString('latin1'));

  console.log('\nParsing (fixed columns)');
  /** @type {Record<string, Term[][][]>} */
  const parsed = {};
  for (const body of BODY_KEYS) {
    const { coords, headers } = parseVsop87a(rawFiles[body], FILES[body]);
    const total = headers.reduce((s, h) => s + h.n, 0);
    assert(total === EXPECTED_TERMS[body], `${FILES[body]}: ${total} terms, expected ${EXPECTED_TERMS[body]}`);
    const structure = { x: coords[0].map((t) => t.length), y: coords[1].map((t) => t.length), z: coords[2].map((t) => t.length) };
    if (EXPECTED_HEADERS[body]) {
      assert(JSON.stringify(structure) === JSON.stringify(EXPECTED_HEADERS[body]),
        `${FILES[body]}: header structure ${JSON.stringify(structure)} ≠ expected ${JSON.stringify(EXPECTED_HEADERS[body])}`);
    }
    assert(headers.length === EXPECTED_HEADER_COUNT[body],
      `${FILES[body]}: ${headers.length} headers, expected ${EXPECTED_HEADER_COUNT[body]}`);
    parsed[body] = coords;
    console.log(`  ${body.padEnd(8)} ${String(total).padStart(5)} terms, ${headers.length} headers  X ${structure.x.join('/')}  Y ${structure.y.join('/')}  Z ${structure.z.join('/')}`);
  }

  // ---- self-check of the FULL series (file order) against vsop87.chk -------------------------------------------
  console.log('\nSelf-check: full series (file order) vs vsop87.chk');
  const fullSeriesFileOrder = {};
  for (const body of BODY_KEYS) fullSeriesFileOrder[body] = toNumericSeries(parsed[body]);
  const evFileOrder = createEvaluator(fullSeriesFileOrder);
  const chkByBody = {};
  for (const body of BODY_KEYS) {
    const rows = chkRows[CHK_NAMES[body]];
    assert(rows && rows.length === 10, `vsop87.chk: ${body} has ${rows?.length ?? 0} VSOP87A rows, expected 10`);
    chkByBody[body] = rows;
    let maxP = 0, maxV = 0;
    for (const row of rows) {
      const { pos, vel } = evalPV(evFileOrder, body, row.jd);
      for (let k = 0; k < 3; k++) {
        maxP = Math.max(maxP, Math.abs(pos[k] - row.pos[k]));
        maxV = Math.max(maxV, Math.abs(vel[k] - row.vel[k]));
      }
    }
    assert(maxP <= CHK_TOL_AU, `${body}: full-series position differs from vsop87.chk by ${maxP} AU > ${CHK_TOL_AU}`);
    assert(maxV <= CHK_TOL_AU_DAY, `${body}: full-series velocity differs from vsop87.chk by ${maxV} AU/d > ${CHK_TOL_AU_DAY}`);
    console.log(`  ${body.padEnd(8)} max |Δpos| ${maxP.toExponential(2)} AU   max |Δvel| ${maxV.toExponential(2)} AU/d   (10 epochs, tol ${CHK_TOL_AU})`);
  }

  // ---- sort by |A| descending (stable), truncate, display prefix -----------------------------------------------
  console.log('\nSorting by |A| (stable) and truncating');
  /** @type {Record<string, Term[][][]>} */
  const sorted = {};
  /** @type {Record<string, Term[][][]>} */
  const kept = {};
  const displayCounts = {};
  const termsKept = {};
  const termsFull = {};
  for (const body of BODY_KEYS) {
    const cut = CUTOFFS[body];
    sorted[body] = parsed[body].map((powers) => powers.map((terms) => terms.slice().sort((p, q) => Math.abs(q.a) - Math.abs(p.a))));
    kept[body] = sorted[body].map((powers) => powers.map((terms) => terms.filter((t) => Math.abs(t.a) >= cut)));
    // Trailing powers may become empty after truncation; keep them (an empty flat array evaluates to 0) so that
    // the power index α stays aligned with the array index.
    const dc = {};
    for (let ic = 0; ic < 3; ic++) {
      dc[COORD_KEYS[ic]] = kept[body][ic].map((terms) => {
        let n = 0;
        for (const t of terms) { if (Math.abs(t.a) < DISPLAY_CUTOFF_AU) break; n++; }
        return n;
      });
    }
    displayCounts[body] = dc;
    termsKept[body] = kept[body].flat(2).length;
    termsFull[body] = EXPECTED_TERMS[body];
    if (termsKept[body] !== EXPECTED_KEPT[body]) {
      console.log(`  WARNING ${body}: kept ${termsKept[body]} terms, plan expected ${EXPECTED_KEPT[body]}`);
    }
  }

  const fullSeries = {};
  const truncSeries = {};
  for (const body of BODY_KEYS) {
    fullSeries[body] = toNumericSeries(sorted[body]);
    truncSeries[body] = toNumericSeries(kept[body]);
  }
  const evFull = createEvaluator(fullSeries);
  const evTrunc = createEvaluator(truncSeries, { displayCounts });
  // The evaluator derives the same display prefix from the 1e-7 threshold; make sure META agrees with it.
  for (const body of BODY_KEYS) {
    for (const key of COORD_KEYS) {
      const derived = truncSeries[body][key].map((flat) => prefixCount(flat, DISPLAY_CUTOFF_AU));
      assert(JSON.stringify(derived) === JSON.stringify(displayCounts[body][key]),
        `${body}.${key}: display prefix ${JSON.stringify(derived)} ≠ META ${JSON.stringify(displayCounts[body][key])}`);
    }
  }

  // ---- self-check again on the sorted full series (this ordering is what the reference fixture uses) ------------
  console.log('\nSelf-check: full series (sorted) vs vsop87.chk');
  for (const body of BODY_KEYS) {
    let maxP = 0, maxV = 0;
    for (const row of chkByBody[body]) {
      const { pos, vel } = evalPV(evFull, body, row.jd);
      for (let k = 0; k < 3; k++) {
        maxP = Math.max(maxP, Math.abs(pos[k] - row.pos[k]));
        maxV = Math.max(maxV, Math.abs(vel[k] - row.vel[k]));
      }
    }
    assert(maxP <= CHK_TOL_AU, `${body}: sorted full-series position differs from vsop87.chk by ${maxP} AU`);
    assert(maxV <= CHK_TOL_AU_DAY, `${body}: sorted full-series velocity differs from vsop87.chk by ${maxV} AU/d`);
    console.log(`  ${body.padEnd(8)} max |Δpos| ${maxP.toExponential(2)} AU   max |Δvel| ${maxV.toExponential(2)} AU/d`);
  }

  // ---- measure bounds -------------------------------------------------------------------------------------------
  console.log('\nMeasuring truncation bounds (41-epoch grid 1900–2100 + 1800 + 2200, and the 10 chk epochs)');
  const measureEpochs = [...GRID, ...EXTRA_EPOCHS];
  const truncatedAu = {};
  const truncatedAuDay = {};
  const displayAu = {};
  const displayAuDay = {};
  const chkFixture = {};
  const reference = {};
  for (const body of BODY_KEYS) {
    let mT = 0, mTv = 0, mD = 0, mDv = 0;
    for (const jd of measureEpochs) {
      const f = evalPV(evFull, body, jd);
      const t = evalPV(evTrunc, body, jd, 'full');
      const d = evalPV(evTrunc, body, jd, 'display');
      mT = Math.max(mT, norm3(f.pos, t.pos));
      mTv = Math.max(mTv, norm3(f.vel, t.vel));
      mD = Math.max(mD, norm3(f.pos, d.pos));
      mDv = Math.max(mDv, norm3(f.vel, d.vel));
    }
    truncatedAu[body] = mT;
    truncatedAuDay[body] = mTv;
    displayAu[body] = mD;
    displayAuDay[body] = mDv;

    chkFixture[body] = chkByBody[body].map((row) => {
      const f = evalPV(evFull, body, row.jd);
      const t = evalPV(evTrunc, body, row.jd, 'full');
      const dPos = norm3(f.pos, t.pos);
      const dVel = norm3(f.vel, t.vel);
      return {
        jd: row.jd,
        pos: row.pos,
        vel: row.vel,
        measuredTruncAu: sig15(dPos),
        measuredTruncAuDay: sig15(dVel),
        truncBoundAu: Math.max(1.5 * dPos, 1e-9),
        truncBoundAuDay: Math.max(1.5 * dVel, 1e-9),
      };
    });

    reference[body] = GRID.map((jd) => {
      const f = evalPV(evFull, body, jd);
      return { jd, pos: f.pos.map(sig15), vel: f.vel.map(sig15) };
    });
  }

  // ---- write the data module ------------------------------------------------------------------------------------
  const META = {
    source: `${BASE_URL} (VSOP87A, Bretagnon P., Francou G., 1988, A&A 202, 309; IMCCE files dated 2005-04-05)`,
    version: 'VSOP87A',
    frame: 'heliocentric, dynamical ecliptic and equinox J2000 (rotate with frames.M_VSOP_TO_ECL for the scene frame)',
    units: { A: 'AU / tjy^alpha', B: 'rad', C: 'rad / tjy', T: '(JD_TDB - 2451545) / 365250' },
    fetchedAt: fetchedAt.toISOString(),
    generatedAt: new Date().toISOString(),
    sha256: sha,
    cutoffs: CUTOFFS,
    displayCutoff: DISPLAY_CUTOFF_AU,
    terms: termsKept,
    termsTotal: BODY_KEYS.reduce((s, b) => s + termsKept[b], 0),
    termsFull,
    displayCounts,
    measuredBounds: {
      epochs: 'max over JD 2415020.0 + k*1826.25 (k = 0..40) plus JD 2378496.5 (1800) and 2524594.0 (2200)',
      truncatedAu: Object.fromEntries(BODY_KEYS.map((b) => [b, sig15(truncatedAu[b])])),
      truncatedAuDay: Object.fromEntries(BODY_KEYS.map((b) => [b, sig15(truncatedAuDay[b])])),
      displayAu: Object.fromEntries(BODY_KEYS.map((b) => [b, sig15(displayAu[b])])),
      displayAuDay: Object.fromEntries(BODY_KEYS.map((b) => [b, sig15(displayAuDay[b])])),
      chkTolAu: CHK_TOL_AU,
    },
  };

  const parts = [];
  parts.push('// GENERATED by scripts/build-vsop87.mjs — do not edit by hand (npm run data:vsop87 regenerates it).');
  parts.push(`// Source: VSOP87A, ${BASE_URL} — Bretagnon & Francou 1988, A&A 202, 309 (see vsop87.doc there).`);
  parts.push('// Frame: heliocentric rectangular, dynamical ecliptic and equinox J2000. X = Σ_α T^α Σ A cos(B + C T),');
  parts.push('// T = (JD_TDB − 2451545)/365250 (thousands of Julian years). A in AU/tjy^α, B in rad, C in rad/tjy.');
  parts.push('// SERIES[body][coord][α] = flat [A, B, C, A, B, C, …] sorted by |A| descending; per-body amplitude cutoffs');
  parts.push('// (META.cutoffs) applied; the first META.displayCounts[body][coord][α] terms form the 1e-7 "display" tier.');
  parts.push('// Numbers are the original file text (no re-rounding). Uranus and Neptune have no T⁵ series and their Z has no T⁴.');
  parts.push('');
  // Pretty JSON, but keep arrays of numbers on one line.
  const metaText = JSON.stringify(META, null, 2)
    .replace(/\[\s+((?:-?[\d.e+-]+,?\s+)+)\]/g, (_, inner) => `[${inner.trim().split(/,\s*/).join(', ')}]`);
  parts.push(`export const META = ${metaText};`);
  parts.push('');
  parts.push('export const SERIES = {');
  for (const body of BODY_KEYS) {
    parts.push(`  ${body}: {`);
    for (let ic = 0; ic < 3; ic++) {
      parts.push(`    ${COORD_KEYS[ic]}: [`);
      const powers = kept[body][ic];
      for (let a = 0; a < powers.length; a++) {
        const terms = powers[a];
        parts.push(`      // T^${a}: ${terms.length} of ${sorted[body][ic][a].length} terms (display prefix ${displayCounts[body][COORD_KEYS[ic]][a]})`);
        if (terms.length === 0) {
          parts.push('      [],');
          continue;
        }
        parts.push('      [');
        for (let i = 0; i < terms.length; i += 6) {
          const chunk = terms.slice(i, i + 6).map((t) => `${t.A},${t.B},${t.C}`).join(', ');
          parts.push(`        ${chunk},`);
        }
        parts.push('      ],');
      }
      parts.push('    ],');
    }
    parts.push('  },');
  }
  parts.push('};');
  parts.push('');
  const moduleText = parts.join('\n');
  await writeFile(OUT_MODULE, moduleText);

  // ---- fixtures -------------------------------------------------------------------------------------------------
  const chkJson = {
    source: `${BASE_URL}${CHK_FILE} (VSOP87A rows; sha256 ${sha[CHK_FILE]})`,
    frame: 'VSOP87A heliocentric, dynamical ecliptic and equinox J2000 (raw, unrotated)',
    units: { jd: 'JD (TDB)', pos: 'AU', vel: 'AU/day' },
    notes: [
      'pos/vel are the check-file values verbatim (10 decimals).',
      'measuredTruncAu / measuredTruncAuDay: |shipped truncated series − full series| at that epoch, measured by scripts/build-vsop87.mjs.',
      'truncBoundAu = max(1.5 × measuredTruncAu, 1e-9); truncBoundAuDay = max(1.5 × measuredTruncAuDay, 1e-9) (the 1e-9 floor absorbs the 1e-10 print rounding).',
    ],
    cutoffs: CUTOFFS,
    bodies: chkFixture,
  };
  await writeFile(OUT_CHK_FIXTURE, JSON.stringify(chkJson, null, 1) + '\n');

  const refJson = {
    source: `${BASE_URL} VSOP87A full (untruncated) series evaluated by scripts/build-vsop87.mjs`,
    frame: 'VSOP87A heliocentric, dynamical ecliptic and equinox J2000 (raw, unrotated)',
    units: { jd: 'JD (TDB)', pos: 'AU', vel: 'AU/day' },
    grid: 'JD 2415020.0 + k*1826.25, k = 0..40 (1900–2100 every 5 years; k = 20 is J2000 = 2451545.0)',
    precision: '15 significant digits',
    sha256: sha,
    epochs: GRID,
    bodies: reference,
  };
  await writeFile(OUT_REF_FIXTURE, JSON.stringify(refJson, null, 1) + '\n');

  // ---- report ---------------------------------------------------------------------------------------------------
  console.log('\nbody      kept / total   cutoff   trunc max km   display max km   trunc@chk max km   trunc max AU/d');
  for (const body of BODY_KEYS) {
    const chkMax = Math.max(...chkFixture[body].map((r) => r.measuredTruncAu));
    console.log(`${body.padEnd(9)} ${String(termsKept[body]).padStart(4)} / ${String(termsFull[body]).padStart(5)}   ${String(CUTOFFS[body]).padEnd(6)} ${fmtKm(truncatedAu[body])}   ${fmtKm(displayAu[body])}      ${fmtKm(chkMax)}      ${truncatedAuDay[body].toExponential(2)}`);
  }
  console.log(`total     ${META.termsTotal} terms kept of ${BODY_KEYS.reduce((s, b) => s + termsFull[b], 0)}`);
  console.log(`\nwrote ${path.relative(ROOT, OUT_MODULE)} (${(moduleText.length / 1024).toFixed(0)} KB)`);
  console.log(`wrote ${path.relative(ROOT, OUT_CHK_FIXTURE)}`);
  console.log(`wrote ${path.relative(ROOT, OUT_REF_FIXTURE)}`);
  console.log(`J2000 grid index: ${GRID.indexOf(J2000)}`);
}

main().catch((e) => fail(e.stack ?? String(e)));
