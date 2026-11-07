#!/usr/bin/env node
/**
 * build-stars.mjs — generate `src/astro/data/stars.js` from the Yale Bright Star Catalogue (`npm run data:stars`).
 *
 * Source: Bright Star Catalogue, 5th Revised Ed. (Hoffleit D., Warren Jr W.H., 1991), VizieR V/50, distributed by the
 * Harvard-Smithsonian CfA Telescope Data Center: http://tdc-www.harvard.edu/catalogs/bsc5.html (bsc5.dat.gz, bsc5.readme).
 * The catalogue is public data (ADC/NSSDC); the citation is "Hoffleit & Warren 1991, The Bright Star Catalogue, 5th
 * Revised Ed. (Preliminary Version)". The 197-byte fixed-width record layout below is transcribed from bsc5.readme.
 *
 * Output: one flat, quantised array of [RA°, Dec° (J2000, epoch 2000.0), V, B−V] per star brighter than V = 6.5
 * (the whole naked-eye sky, 9 0xx stars), the HR numbers for provenance, and the IAU proper names of the brightest
 * stars keyed by catalogue index. The browser app never fetches the catalogue: this script downloads it once into
 * data/raw/ (cached), and the generated module is committed.
 *
 * Record layout (bytes, 1-based, from bsc5.readme):
 *   1-4 HR · 5-14 Name (Flamsteed/Bayer/constellation) · 76-77 RAh · 78-79 RAm · 80-83 RAs · 84 Dec sign · 85-86 DEd ·
 *   87-88 DEm · 89-90 DEs · 103-107 Vmag · 110-114 B-V · 128-147 SpType
 * 14 records (novae / extragalactic objects kept for numbering) have no J2000 position and are skipped.
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(HERE, '..', 'data', 'raw');
const RAW_FILE = resolve(RAW_DIR, 'bsc5.dat.gz');
const OUT_FILE = resolve(HERE, '..', 'src', 'astro', 'data', 'stars.js');
const URL = 'http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz';
/** Faintest star kept (BSC is complete to V = 6.5; a handful of entries are fainter). */
const MAG_LIMIT = 6.5;

/**
 * IAU-approved proper names (IAU Working Group on Star Names, https://www.iau.org/public/themes/naming_stars/),
 * keyed by the Bayer designation as it appears in the BSC Name field (Greek letter abbreviation + constellation).
 * Only the brightest / best-known stars are listed: they are drawn as labels in the sky view.
 */
const PROPER_NAMES = {
  'Alp CMa': 'Sirius', 'Alp Car': 'Canopus', 'Alp Boo': 'Arcturus', 'Alp1Cen': 'Rigil Kentaurus', 'Alp Lyr': 'Vega',
  'Alp Aur': 'Capella', 'Bet Ori': 'Rigel', 'Alp CMi': 'Procyon', 'Alp Eri': 'Achernar', 'Alp Ori': 'Betelgeuse',
  'Bet Cen': 'Hadar', 'Alp Aql': 'Altair', 'Alp Tau': 'Aldebaran', 'Alp Sco': 'Antares', 'Alp Vir': 'Spica',
  'Bet Gem': 'Pollux', 'Alp PsA': 'Fomalhaut', 'Alp Cyg': 'Deneb', 'Bet Cru': 'Mimosa', 'Alp Leo': 'Regulus',
  'Alp1Cru': 'Acrux', 'Eps CMa': 'Adhara', 'Lam Sco': 'Shaula', 'Gam Cru': 'Gacrux', 'Alp Gem': 'Castor',
  'Eps UMa': 'Alioth', 'Eta UMa': 'Alkaid', 'Alp UMa': 'Dubhe', 'Alp Per': 'Mirfak', 'Bet Aur': 'Menkalinan',
  'Alp UMi': 'Polaris', 'Eps Sgr': 'Kaus Australis', 'Alp Oph': 'Rasalhague', 'Bet Tau': 'Elnath', 'Alp Hya': 'Alphard',
  'Alp Ari': 'Hamal', 'Bet Leo': 'Denebola', 'Alp And': 'Alpheratz', 'Alp Cas': 'Schedar', 'Alp Peg': 'Markab',
  'Alp Cet': 'Menkar', 'Alp CrB': 'Alphecca', 'Bet Per': 'Algol', 'Gam Ori': 'Bellatrix', 'Zet Ori': 'Alnitak',
  'Eps Ori': 'Alnilam', 'Del Ori': 'Mintaka', 'Kap Ori': 'Saiph', 'Bet UMi': 'Kochab', 'Eps Peg': 'Enif',
  'Alp Phe': 'Ankaa', 'Alp Gru': 'Alnair', 'Alp Pav': 'Peacock', 'Alp TrA': 'Atria', 'Bet Car': 'Miaplacidus',
  'Eps Car': 'Avior', 'Zet Pup': 'Naos', 'Bet CMa': 'Mirzam', 'Del CMa': 'Wezen', 'Zet UMa': 'Mizar',
  'Bet UMa': 'Merak', 'Gam UMa': 'Phecda', 'Del UMa': 'Megrez', 'Gam1Leo': 'Algieba', 'Del Leo': 'Zosma',
  'Bet Cas': 'Caph', 'Alp Col': 'Phact', 'Gam Gem': 'Alhena', 'Alp1Her': 'Rasalgethi', 'Bet Her': 'Kornephoros',
  'Del Sco': 'Dschubba', 'Sig Sgr': 'Nunki', 'Zet Sgr': 'Ascella', 'Del Sgr': 'Kaus Media', 'Lam Sgr': 'Kaus Borealis',
  'Gam Dra': 'Eltanin', 'Bet Dra': 'Rastaban', 'Del Cap': 'Deneb Algedi', 'Alp Aqr': 'Sadalmelik', 'Bet Aqr': 'Sadalsuud',
  'Bet Peg': 'Scheat', 'Gam Peg': 'Algenib', 'Eps Boo': 'Izar', 'Eta Boo': 'Muphrid', 'Alp2Lib': 'Zubenelgenubi',
  'Bet Lib': 'Zubeneschamali', 'Eps Vir': 'Vindemiatrix', 'Bet Cnc': 'Tarf', 'Eta Tau': 'Alcyone', 'Gam Crv': 'Gienah',
  'Bet Crv': 'Kraz', 'Gam Cyg': 'Sadr', 'Bet1Cyg': 'Albireo', 'Gam Aql': 'Tarazed', 'Bet Cet': 'Diphda', 'Alp Lep': 'Arneb',
  'The Sco': 'Sargas', 'Alp Cap': 'Algedi', 'Alp Lup': 'Men', 'Gam Vel': 'Regor', 'Del Vel': 'Alsephina',
  'Alp Mus': 'Mus', 'Bet Gru': 'Tiaki', 'Eps Cyg': 'Aljanah', 'Alp Hyi': 'Hydrus', 'Eta Oph': 'Sabik', 'Zet Oph': 'Zet Oph',
  'Alp Sgr': 'Rukbat', 'The Eri': 'Acamar', 'Gam Eri': 'Zaurak', 'Bet And': 'Mirach', 'Gam1And': 'Almach',
  'Alp Tri': 'Mothallah', 'Bet Ari': 'Sheratan', 'Alp Pic': 'Alp Pic', 'Alp Ser': 'Unukalhai', 'Alp Lac': 'Alp Lac',
  'Bet Sco': 'Acrab', 'Eps Sco': 'Larawag', 'Kap Sco': 'Girtab', 'Ups Sco': 'Lesath', 'Alp Cen': 'Rigil Kentaurus',
  'Alp Cru': 'Acrux', 'Gam Leo': 'Algieba', 'Alp Her': 'Rasalgethi', 'Alp Lib': 'Zubenelgenubi', 'Bet Cyg': 'Albireo',
  'Gam And': 'Almach', 'Zet Gem': 'Mekbuda', 'Mu  Gem': 'Tejat', 'Eta Gem': 'Propus', 'Eps Gem': 'Mebsuta',
  'Alp Crv': 'Alchiba', 'Del Crv': 'Algorab', 'Alp Cnc': 'Acubens', 'Eps Tau': 'Ain', 'Zet Tau': 'Tianguan',
  'Alp Del': 'Sualocin', 'Bet Del': 'Rotanev', 'Zet Aql': 'Okab', 'Bet Cap': 'Dabih', 'Nu  Oph': 'Nu Oph',
};
// Entries whose value equals the key (placeholders) are not real IAU names: drop them so nothing invented is shown.
for (const [k, v] of Object.entries(PROPER_NAMES)) if (v === k || v === 'Mus' || v === 'Hydrus') delete PROPER_NAMES[k];

/**
 * Fetch the catalogue once into data/raw (the committed copy makes the build reproducible offline).
 * @returns {Promise<string>} the decompressed catalogue text
 */
async function loadCatalogue() {
  await mkdir(RAW_DIR, { recursive: true });
  let gz;
  try {
    await access(RAW_FILE);
    gz = await readFile(RAW_FILE);
    console.log(`using cached ${RAW_FILE} (${gz.length} bytes)`);
  } catch {
    console.log(`downloading ${URL}`);
    const res = await fetch(URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    gz = Buffer.from(await res.arrayBuffer());
    await writeFile(RAW_FILE, gz);
    console.log(`saved ${RAW_FILE} (${gz.length} bytes)`);
  }
  return gunzipSync(gz).toString('latin1');
}

/**
 * Parse one 197-byte record (bytes are 1-based in the readme; `slice(a − 1, b)`).
 * @param {string} line
 * @returns {{hr:number, name:string, raDeg:number, decDeg:number, vmag:number, bv:number, sp:string}|null}
 */
export function parseRecord(line) {
  const hr = Number(line.slice(0, 4));
  const name = line.slice(4, 14);
  const rah = line.slice(75, 77).trim();
  if (!rah) return null; // no J2000 position (nova / galaxy placeholder)
  const ram = Number(line.slice(77, 79));
  const ras = Number(line.slice(79, 83));
  const sign = line.slice(83, 84) === '-' ? -1 : 1;
  const ded = Number(line.slice(84, 86));
  const dem = Number(line.slice(86, 88));
  const des = Number(line.slice(88, 90));
  const vmagStr = line.slice(102, 107).trim();
  if (!vmagStr) return null;
  const vmag = Number(vmagStr);
  const bvStr = line.slice(109, 114).trim();
  const bv = bvStr ? Number(bvStr) : NaN;
  const sp = line.slice(127, 147).trim();
  const raDeg = 15 * (Number(rah) + ram / 60 + ras / 3600);
  const decDeg = sign * (ded + dem / 60 + des / 3600);
  if (![raDeg, decDeg, vmag].every(Number.isFinite)) return null;
  return { hr, name, raDeg, decDeg, vmag, bv, sp };
}

/**
 * Bayer key as used in PROPER_NAMES: the Name field is "<Flamsteed><Greek><component> <Con>", e.g. "9Alp CMa",
 * "  Alp1Cen", "41Gam1And". The Greek abbreviation starts at byte 4 of the 10-byte field.
 * @param {string} name 10-character Name field
 * @returns {string|null}
 */
export function bayerKey(name) {
  const greek = name.slice(3, 6);
  const comp = name.slice(6, 7);
  const con = name.slice(7, 10);
  if (!/^[A-Z][a-z]{2}$/.test(greek) || !/^[A-Z][A-Za-z]{2}$/.test(con)) return null;
  return `${greek}${comp === ' ' ? ' ' : comp}${con}`;
}

/**
 * Quantise one value for the generated literal (RA/Dec to 1e-4° ≈ 0.36″ — the catalogue gives 0.1 s of RA ≈ 1.5″
 * and 1″ of Dec; magnitudes and colours to 0.01).
 * @param {number} x @param {number} decimals
 */
const q = (x, decimals) => Number(x.toFixed(decimals));

async function main() {
  const text = await loadCatalogue();
  const lines = text.split(/\r?\n/).filter((l) => l.length >= 90);
  const stars = [];
  let skipped = 0;
  for (const line of lines) {
    const rec = parseRecord(line);
    if (!rec) { skipped++; continue; }
    if (rec.vmag > MAG_LIMIT) { skipped++; continue; }
    stars.push(rec);
  }
  stars.sort((a, b) => a.vmag - b.vmag); // brightest first: the renderer can take any prefix as "the N brightest"
  const flat = [];
  const hr = [];
  const names = {};
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    flat.push(q(s.raDeg, 4), q(s.decDeg, 4), q(s.vmag, 2), Number.isFinite(s.bv) ? q(s.bv, 2) : 0.6);
    hr.push(s.hr);
    const key = bayerKey(s.name);
    if (key && PROPER_NAMES[key] && !Object.values(names).includes(PROPER_NAMES[key])) names[i] = PROPER_NAMES[key];
  }
  const sirius = stars.findIndex((s) => bayerKey(s.name) === 'Alp CMa');
  if (sirius !== 0) throw new Error(`expected Sirius to be the brightest star, got index ${sirius}`);
  const s0 = stars[0];
  // Sanity: Sirius J2000 06h45m08.9s −16°42′58″ (BSC5 HR 2491), V = −1.46.
  if (s0.hr !== 2491 || Math.abs(s0.raDeg - 101.287) > 0.01 || Math.abs(s0.decDeg + 16.716) > 0.01 || Math.abs(s0.vmag + 1.46) > 0.01) {
    throw new Error(`Sirius row unexpected: ${JSON.stringify(s0)}`);
  }
  const header = `// GENERATED by scripts/build-stars.mjs — do not edit by hand.
// Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991, VizieR V/50), via the CfA Telescope Data
// Center (http://tdc-www.harvard.edu/catalogs/bsc5.html). Public data; cite Hoffleit & Warren 1991.
// ${stars.length} stars with V ≤ ${MAG_LIMIT}, sorted brightest first. STARS is a flat array of
// [RA° (J2000, epoch 2000.0), Dec° (J2000), V magnitude, B−V colour (0.6 when the catalogue has none)] per star;
// STAR_HR holds the Harvard Revised numbers; STAR_NAMES maps a star index to its IAU proper name.
// Positions are quantised to 1e-4° (≈ 0.36″), far below the catalogue's own 1″ precision. Generated ${new Date().toISOString()}.
`;
  const body = `${header}
export const STAR_COUNT = ${stars.length};
export const STAR_MAG_LIMIT = ${MAG_LIMIT};
export const STAR_STRIDE = 4;
export const STARS = new Float32Array([
${chunk(flat, 16).map((row) => '  ' + row.join(',')).join(',\n')}
]);
export const STAR_HR = [
${chunk(hr, 32).map((row) => '  ' + row.join(',')).join(',\n')}
];
export const STAR_NAMES = Object.freeze(${JSON.stringify(names, null, 0).replace(/"(\d+)":/g, '$1:')});
`;
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, body);
  console.log(`wrote ${OUT_FILE}: ${stars.length} stars (skipped ${skipped}), ${Object.keys(names).length} named, ${body.length} bytes`);
}

/** @param {any[]} arr @param {number} n */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
