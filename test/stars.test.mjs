import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STARS, STAR_COUNT, STAR_STRIDE, STAR_HR, STAR_NAMES, STAR_MAG_LIMIT } from '../src/astro/data/stars.js';
import { equatorialToEcliptic } from '../src/astro/frames.js';
import { DEG, RAD } from '../src/astro/constants.js';
import { angleBetween } from '../src/astro/vec.js';

/** @param {number} i @returns {{ra:number, dec:number, v:number, bv:number}} */
function star(i) {
  const o = i * STAR_STRIDE;
  return { ra: STARS[o], dec: STARS[o + 1], v: STARS[o + 2], bv: STARS[o + 3] };
}
/** @param {string} name */
function byName(name) {
  for (const [i, n] of Object.entries(STAR_NAMES)) if (n === name) return star(+i);
  throw new Error(`no star named ${name}`);
}
/** @param {number} raDeg @param {number} decDeg @returns {number[]} unit vector, equatorial J2000 */
function unit(raDeg, decDeg) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

test('stars.js: shape and limits (BSC5, V ≤ 6.5, brightest first)', () => {
  assert.equal(STARS.length, STAR_COUNT * STAR_STRIDE, 'flat array of STAR_STRIDE numbers per star');
  assert.equal(STAR_HR.length, STAR_COUNT, 'one HR number per star');
  assert.ok(STAR_COUNT > 8000 && STAR_COUNT < 9200, `BSC5 has 9 096 stars, 8 404 with V ≤ 6.5 (got ${STAR_COUNT})`);
  let prev = -Infinity;
  for (let i = 0; i < STAR_COUNT; i++) {
    const s = star(i);
    assert.ok(s.ra >= 0 && s.ra < 360, `RA in [0, 360): star ${i} = ${s.ra}`);
    assert.ok(s.dec >= -90 && s.dec <= 90, `Dec in [−90, 90]: star ${i} = ${s.dec}`);
    assert.ok(s.v <= STAR_MAG_LIMIT + 1e-6, `V ≤ ${STAR_MAG_LIMIT}: star ${i} = ${s.v}`);
    assert.ok(s.v >= prev - 1e-6, `sorted by V ascending (brightest first) at ${i}`);
    prev = s.v;
  }
});

test('stars.js: Sirius, Vega, Polaris and Betelgeuse at their catalogue positions (BSC5 J2000)', () => {
  // BSC5 HR 2491 Sirius: 06h45m08.9s −16°42′58″, V −1.46 (Hoffleit & Warren 1991).
  const sirius = star(0);
  assert.equal(STAR_HR[0], 2491, 'the brightest star is HR 2491 (Sirius)');
  assert.equal(STAR_NAMES[0], 'Sirius');
  assert.ok(Math.abs(sirius.ra - 101.2871) < 2e-4 && Math.abs(sirius.dec + 16.7161) < 2e-4, `Sirius at (${sirius.ra}, ${sirius.dec}) vs BSC5 (101.2871, −16.7161) to 1e-4° (quantisation)`);
  assert.ok(Math.abs(sirius.v + 1.46) < 1e-6, `Sirius V = ${sirius.v} vs −1.46`);
  // HR 7001 Vega: 18h36m56.3s +38°47′01″, V 0.03.
  const vega = byName('Vega');
  assert.ok(Math.abs(vega.ra - 279.2346) < 2e-4 && Math.abs(vega.dec - 38.7836) < 2e-4, `Vega at (${vega.ra}, ${vega.dec}) vs (279.2346, 38.7836)`);
  // HR 424 Polaris: 02h31m49.1s +89°15′51″, V 2.02 — within 0.75° of the J2000 pole.
  const polaris = byName('Polaris');
  assert.ok(polaris.dec > 89.2 && polaris.dec < 89.3, `Polaris Dec = ${polaris.dec} (BSC5: +89°15′51″ = 89.264°)`);
  // HR 2061 Betelgeuse: V 0.50, B−V +1.85 (a red supergiant: the reddest of the first-magnitude stars).
  const betelgeuse = byName('Betelgeuse');
  assert.ok(Math.abs(betelgeuse.v - 0.5) < 1e-6 && Math.abs(betelgeuse.bv - 1.85) < 1e-6, `Betelgeuse V ${betelgeuse.v} B−V ${betelgeuse.bv}`);
});

test('stars.js: the ecliptic-frame direction of Regulus lies within 0.5° of the ecliptic plane (β = +0.46°)', () => {
  // Regulus (α Leo, HR 3982) is the first-magnitude star closest to the ecliptic: ecliptic latitude +0°28′ (J2000),
  // e.g. Meeus AA ch. 13 worked example gives λ = 149.4°, β = +0.46° for the nearby Pollux... (Pollux is at β = +6.7°);
  // Regulus β = +0.465° from its J2000 RA/Dec via the IAU76 obliquity (Meeus eq. 13.4).
  const r = byName('Regulus');
  const ecl = equatorialToEcliptic(unit(r.ra, r.dec));
  const beta = Math.asin(ecl[2]) * RAD;
  const lambda = ((Math.atan2(ecl[1], ecl[0]) * RAD) % 360 + 360) % 360;
  assert.ok(Math.abs(beta - 0.465) < 0.01, `Regulus ecliptic latitude ${beta}° vs +0.465° (Meeus 13.4 with ε76; tolerance 0.01°)`);
  assert.ok(Math.abs(lambda - 149.83) < 0.02, `Regulus ecliptic longitude ${lambda}° vs 149.83° (J2000; tolerance 0.02°)`);
  // Sanity on the rotation itself: the north celestial pole maps to ecliptic latitude 90° − ε = 66.56°.
  const ncp = equatorialToEcliptic([0, 0, 1]);
  assert.ok(Math.abs(Math.asin(ncp[2]) * RAD - (90 - 23.4392911)) < 1e-6, 'NCP at β = 90° − ε76');
  // Sirius–Procyon angular separation 25.7° (a well-known pair; independent of frame).
  const p = byName('Procyon');
  const sep = angleBetween(unit(star(0).ra, star(0).dec), unit(p.ra, p.dec)) * RAD;
  assert.ok(Math.abs(sep - 25.71) < 0.05, `Sirius–Procyon separation ${sep}° vs 25.71°`);
});
