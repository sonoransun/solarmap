import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GALACTIC_POLE_ECL, GALACTIC_CENTRE_ECL, GALACTIC_Y_ECL, GALACTIC_POLE_EQ_DEG, GALACTIC_CENTRE_EQ_DEG,
  unitFromRaDec, galacticCoords, dirFromGalactic,
  bvToTemperature, temperatureToSrgb, srgbToLinear, bvToRgb,
  magnitudeToIntensity, starPointSizePx, starIntensity,
  STAR_MAG_BRIGHT, STAR_MAG_FAINT, STAR_PX_MIN, STAR_PX_MAX, STAR_PX_FLOOR, STAR_INTENSITY_MIN, STAR_INTENSITY_MAX,
  BACKGROUND_MAG_MAX, starDirectionsEcliptic, createSkyData, mulberry32,
} from '../src/astro/sky.js';
import { STARS, STAR_COUNT, STAR_STRIDE, STAR_NAMES } from '../src/astro/data/stars.js';
import { equatorialToEcliptic } from '../src/astro/frames.js';
import { EPS76_RAD, DEG, RAD } from '../src/astro/constants.js';
import { angleBetween, norm, dot, cross } from '../src/astro/vec.js';

/** @param {string} name @returns {number} catalogue index */
function indexOf(name) {
  for (const [i, n] of Object.entries(STAR_NAMES)) if (n === name) return Number(i);
  throw new Error(`no star named ${name}`);
}

test('sky.js: star directions are unit vectors in the ecliptic frame, brightest first, with Polaris near the pole', () => {
  const sky = starDirectionsEcliptic();
  assert.equal(sky.count, STAR_COUNT);
  assert.equal(sky.dirs.length, STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const n = Math.hypot(sky.dirs[i * 3], sky.dirs[i * 3 + 1], sky.dirs[i * 3 + 2]);
    assert.ok(Math.abs(n - 1) < 1e-6, `|dir| = 1 to 1e-6 (float32 storage) at star ${i}: ${n}`);
    assert.equal(sky.mags[i], STARS[i * STAR_STRIDE + 2]);
    assert.equal(sky.bv[i], STARS[i * STAR_STRIDE + 3]);
  }
  // Polaris (HR 424) is 0.74° from the J2000 north celestial pole, which the frame rotation puts at (0, sin ε, cos ε).
  const p = indexOf('Polaris');
  const polaris = [sky.dirs[p * 3], sky.dirs[p * 3 + 1], sky.dirs[p * 3 + 2]];
  const ncpEcl = [0, Math.sin(EPS76_RAD), Math.cos(EPS76_RAD)];
  const sep = angleBetween(polaris, ncpEcl) * RAD;
  assert.ok(sep > 0.6 && sep < 0.8, `Polaris ${sep.toFixed(3)}° from the NCP direction (0, sin ε, cos ε); BSC5 Dec +89°15′51″ → 0.736°`);
  // Sirius: the same rotation as frames.equatorialToEcliptic applied to the catalogue RA/Dec.
  const ref = equatorialToEcliptic(unitFromRaDec(STARS[0], STARS[1]));
  const sirius = [sky.dirs[0], sky.dirs[1], sky.dirs[2]];
  assert.ok(angleBetween(ref, sirius) < 1e-6, 'Sirius direction matches equatorialToEcliptic to 1e-6 rad (float32)');
  // Sirius ecliptic latitude −39.6° (Meeus-style conversion of 06h45m −16°43′ with ε = 23.44°).
  const beta = Math.atan2(sirius[2], Math.hypot(sirius[0], sirius[1])) * RAD;
  assert.ok(Math.abs(beta + 39.6) < 0.1, `Sirius β = ${beta.toFixed(2)}° vs −39.6° (±0.1°)`);
  // prefix selection keeps the brightest and drops names beyond the prefix
  const few = starDirectionsEcliptic({ count: 10 });
  assert.equal(few.count, 10);
  assert.equal(few.names[0], 'Sirius');
  assert.equal(few.names[50], undefined, 'Polaris (index 50) is not in the 10-star prefix');
});

test('sky.js: galactic frame — pole ⟂ centre, right-handed basis, NCP at l = 122.932°, b = +27.128°', () => {
  // The published directions themselves (before orthogonalisation) are perpendicular to 1e-6.
  const pEq = unitFromRaDec(GALACTIC_POLE_EQ_DEG.raDeg, GALACTIC_POLE_EQ_DEG.decDeg);
  const cEq = unitFromRaDec(GALACTIC_CENTRE_EQ_DEG.raDeg, GALACTIC_CENTRE_EQ_DEG.decDeg);
  assert.ok(Math.abs(dot(pEq, cEq)) < 1e-6, `pole · centre = ${dot(pEq, cEq)} (Reid & Brunthaler 2004 values; < 1e-6)`);
  // The exported basis is exactly orthonormal and right-handed (double precision).
  assert.ok(Math.abs(dot(GALACTIC_POLE_ECL, GALACTIC_CENTRE_ECL)) < 1e-15, 'orthogonalised centre ⟂ pole to 1e-15');
  for (const v of [GALACTIC_POLE_ECL, GALACTIC_CENTRE_ECL, GALACTIC_Y_ECL]) assert.ok(Math.abs(norm(v) - 1) < 1e-15, 'unit basis vectors');
  const handed = dot(cross(GALACTIC_CENTRE_ECL, GALACTIC_Y_ECL), GALACTIC_POLE_ECL);
  assert.ok(Math.abs(handed - 1) < 1e-14, `x × y · z = ${handed} (right-handed)`);
  // Pole and centre land where the frame rotation says (same rotation as frames.js).
  assert.ok(angleBetween(GALACTIC_POLE_ECL, equatorialToEcliptic(pEq)) < 1e-12, 'pole rotated with EQ_TO_ECL');
  // Coordinates: the centre is (0, 0), the pole is b = 90°.
  const gc = galacticCoords(GALACTIC_CENTRE_ECL);
  assert.ok(Math.abs(gc.l) < 1e-12 && Math.abs(gc.b) < 1e-12, 'centre → (l, b) = (0, 0)');
  assert.ok(Math.abs(galacticCoords(GALACTIC_POLE_ECL).b - Math.PI / 2) < 1e-12, 'pole → b = 90°');
  // The north celestial pole: b = δ(NGP) = 27.128° by symmetry, l = 122.932° (IAU 1958: 123°; astropy 122.9319°).
  const ncp = galacticCoords(equatorialToEcliptic([0, 0, 1]));
  assert.ok(Math.abs(ncp.b * RAD - 27.12825) < 1e-4, `NCP b = ${ncp.b * RAD}° vs +27.12825° (±1e-4°)`);
  assert.ok(Math.abs(ncp.l * RAD - 122.932) < 2e-3, `NCP l = ${ncp.l * RAD}° vs 122.932° (±0.002°)`);
  // Round trip through dirFromGalactic.
  const d = dirFromGalactic(1.2, -0.4);
  const back = galacticCoords(d);
  assert.ok(Math.abs(back.l - 1.2) < 1e-12 && Math.abs(back.b + 0.4) < 1e-12, 'dirFromGalactic ∘ galacticCoords = id');
  // Deneb (α Cyg) sits in the Milky Way: |b| < 3°; Arcturus is far from it (b ≈ +69°).
  const sky = starDirectionsEcliptic();
  const at = (name) => { const i = indexOf(name); return galacticCoords([sky.dirs[i * 3], sky.dirs[i * 3 + 1], sky.dirs[i * 3 + 2]]); };
  assert.ok(Math.abs(at('Deneb').b * RAD - 2.0) < 1.0, `Deneb b = ${at('Deneb').b * RAD}° (SIMBAD: +2.0°, ±1°)`);
  assert.ok(Math.abs(at('Arcturus').b * RAD - 69.1) < 1.0, `Arcturus b = ${at('Arcturus').b * RAD}° (SIMBAD: +69.1°, ±1°)`);
  assert.ok(Math.abs(at('Antares').l * RAD - 351.9 + 360) % 360 < 1.0 || Math.abs(((at('Antares').l * RAD) + 360) % 360 - 351.9) < 1.0,
    `Antares l = ${((at('Antares').l * RAD) + 360) % 360}° (SIMBAD: 351.9°, ±1°)`);
});

test('sky.js: colour — Ballesteros temperature, Helland fit, monotonic in B−V, Sirius white-blue, Betelgeuse orange', () => {
  assert.ok(Math.abs(bvToTemperature(0.65) - 5778) < 5, `T(B−V = 0.65) = ${bvToTemperature(0.65)} K vs 5778 K (Ballesteros 2012 eq. 14, ±5 K)`);
  assert.ok(Math.abs(bvToTemperature(0.0) - 10125) < 10, `T(0.0) = ${bvToTemperature(0)} K (A0 star; formula gives 10125 K)`);
  assert.ok(Math.abs(bvToTemperature(1.85) - 3333) < 10, `T(1.85) = ${bvToTemperature(1.85)} K (Betelgeuse; formula gives 3333 K)`);
  assert.equal(bvToTemperature(-5), bvToTemperature(-0.4), 'input clamped to the fit range');
  // Helland fit anchors (his published table): 6600 K → (255, 255, 253) white; 3000 K → (255, 180, 107); 10000 K → (201, 218, 255).
  const white = temperatureToSrgb(6600);
  assert.ok(white[0] === 1 && white[1] > 0.97 && white[2] > 0.97, `6600 K → (${white.map((x) => x.toFixed(3))}): white within 3 %`);
  const warm = temperatureToSrgb(3000);
  assert.ok(warm[0] === 1 && Math.abs(warm[1] - 0.706) < 0.02 && Math.abs(warm[2] - 0.420) < 0.03, `3000 K → (1, 0.71, 0.42): got (${warm.map((x) => x.toFixed(3))})`);
  const cool = temperatureToSrgb(10000);
  assert.ok(Math.abs(cool[0] - 0.788) < 0.02 && Math.abs(cool[1] - 0.855) < 0.02 && cool[2] === 1, `10000 K → (0.79, 0.85, 1): got (${cool.map((x) => x.toFixed(3))})`);
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.2140) < 1e-3 && Math.abs(srgbToLinear(0.04) - 0.0031) < 1e-4, 'sRGB EOTF (IEC 61966-2-1)');
  // Sirius (B−V 0.00): white-blue → blue channel strongest, red still bright (near-white).
  const sirius = bvToRgb(0.0);
  assert.ok(sirius[2] === 1 && sirius[0] < sirius[1] && sirius[1] < sirius[2] && sirius[0] > 0.5,
    `Sirius linear RGB (${sirius.map((x) => x.toFixed(3))}): b = 1 > g > r > 0.5`);
  // Betelgeuse (B−V 1.85): orange → red strongest, blue well below.
  const betelgeuse = bvToRgb(1.85);
  assert.ok(betelgeuse[0] === 1 && betelgeuse[1] < 0.6 && betelgeuse[2] < 0.25,
    `Betelgeuse linear RGB (${betelgeuse.map((x) => x.toFixed(3))}): r = 1, g < 0.6, b < 0.25`);
  // The Sun (0.65) is nearly white with a warm tint.
  const sun = bvToRgb(0.65);
  assert.ok(sun[0] === 1 && sun[1] > 0.8 && sun[2] > 0.6, `Sun-like linear RGB (${sun.map((x) => x.toFixed(3))})`);
  // Monotonic: the blue/red ratio never increases as B−V increases (redder stars are never bluer).
  let prev = Infinity;
  for (let bv = -0.4; bv <= 2.0 + 1e-9; bv += 0.025) {
    const c = bvToRgb(bv);
    const ratio = c[2] / c[0];
    assert.ok(ratio <= prev + 1e-9, `b/r non-increasing in B−V at ${bv.toFixed(3)}: ${ratio} > ${prev}`);
    prev = ratio;
  }
});

test('sky.js: brightness — Pogson ratio and the star display law', () => {
  assert.equal(magnitudeToIntensity(3, 3), 1);
  assert.ok(Math.abs(magnitudeToIntensity(5) - 0.01) < 1e-12, 'Δm = 5 ↔ 100× (Pogson 1856)');
  assert.ok(Math.abs(magnitudeToIntensity(1) - 1 / 2.5118864315) < 1e-10, 'Δm = 1 ↔ 2.512×');
  assert.ok(Math.abs(magnitudeToIntensity(-1.46) / magnitudeToIntensity(0.03) - 3.95) < 0.01, 'Sirius/Vega flux ratio 3.95');
  // Endpoints of the display law.
  assert.ok(Math.abs(starPointSizePx(STAR_MAG_FAINT) - STAR_PX_MIN) < 1e-9, `V 6.5 → ${STAR_PX_MIN} px`);
  assert.ok(Math.abs(starPointSizePx(STAR_MAG_BRIGHT) - STAR_PX_MAX) < 1e-9, `V −1.5 → ${STAR_PX_MAX} px`);
  assert.ok(Math.abs(starIntensity(STAR_MAG_FAINT) - STAR_INTENSITY_MIN) < 1e-9, `V 6.5 → intensity ${STAR_INTENSITY_MIN}`);
  assert.ok(Math.abs(starIntensity(STAR_MAG_BRIGHT) - STAR_INTENSITY_MAX) < 1e-9, `V −1.5 → intensity ${STAR_INTENSITY_MAX} (HDR)`);
  assert.equal(starPointSizePx(-5), STAR_PX_MAX, 'brighter than −1.5 is clamped');
  assert.equal(starPointSizePx(BACKGROUND_MAG_MAX), STAR_PX_FLOOR, 'V 8 sits on the 1 px floor');
  assert.ok(starIntensity(BACKGROUND_MAG_MAX) > 0.1 && starIntensity(BACKGROUND_MAG_MAX) < STAR_INTENSITY_MIN, 'V 8 is dimmer than V 6.5 but not black');
  // Monotonic and continuous over the whole span.
  let ps = starPointSizePx(-2), pi = starIntensity(-2);
  for (let m = -1.99; m <= 8.5; m += 0.01) {
    const s = starPointSizePx(m), k = starIntensity(m);
    assert.ok(s <= ps + 1e-12 && k <= pi + 1e-12, `size and intensity non-increasing in m at ${m.toFixed(2)}`);
    assert.ok(ps - s < 0.05 && pi - k < 0.05, `no jumps larger than 0.05 per 0.01 mag at ${m.toFixed(2)}`);
    ps = s; pi = k;
  }
  // Mid-range checks a reviewer can reproduce: V 2 → 2.6 px / 0.74; V 4 → 1.8 px / 0.43 (≈ 10 % tolerance on the law).
  assert.ok(Math.abs(starPointSizePx(2) - 2.62) < 0.1 && Math.abs(starIntensity(2) - 0.74) < 0.05, `V 2 → ${starPointSizePx(2).toFixed(2)} px, ${starIntensity(2).toFixed(2)}`);
  assert.ok(Math.abs(starPointSizePx(4) - 1.83) < 0.1 && Math.abs(starIntensity(4) - 0.43) < 0.05, `V 4 → ${starPointSizePx(4).toFixed(2)} px, ${starIntensity(4).toFixed(2)}`);
});

test('sky.js: createSkyData bundles catalogue + seeded background with sizes, colours and the galactic basis', () => {
  const sky = createSkyData({ background: 2000, seed: 7 });
  assert.equal(sky.catalogueCount, STAR_COUNT);
  assert.equal(sky.count, STAR_COUNT + 2000);
  assert.equal(sky.dirs.length, sky.count * 3);
  assert.equal(sky.sizes.length, sky.count);
  assert.equal(sky.rgb.length, sky.count * 3);
  assert.deepEqual(sky.galPole, [...GALACTIC_POLE_ECL]);
  assert.deepEqual(sky.galCentre, [...GALACTIC_CENTRE_ECL]);
  assert.deepEqual(sky.galY, [...GALACTIC_Y_ECL]);
  let planeCount = 0;
  const g = { l: 0, b: 0 };
  for (let i = 0; i < sky.count; i++) {
    const d = [sky.dirs[i * 3], sky.dirs[i * 3 + 1], sky.dirs[i * 3 + 2]];
    assert.ok(Math.abs(norm(d) - 1) < 1e-6, `unit direction at ${i}`);
    assert.ok(sky.sizes[i] >= STAR_PX_FLOOR && sky.sizes[i] <= STAR_PX_MAX + 1e-6, `size in [1, 5] px at ${i}: ${sky.sizes[i]}`);
    const peak = Math.max(sky.rgb[i * 3], sky.rgb[i * 3 + 1], sky.rgb[i * 3 + 2]);
    assert.ok(Math.abs(peak - starIntensity(sky.mags[i])) < 1e-5, `peak channel = starIntensity(V) at ${i}`);
    if (i >= sky.catalogueCount) {
      assert.ok(sky.mags[i] >= STAR_MAG_FAINT && sky.mags[i] <= BACKGROUND_MAG_MAX, `background V in [6.5, 8] at ${i}: ${sky.mags[i]}`);
      assert.ok(sky.bv[i] >= 0 && sky.bv[i] <= 1.4, 'background B−V in [0, 1.4]');
      galacticCoords(d, g);
      if (Math.abs(g.b) < 15 * DEG) planeCount++;
    }
  }
  // Half the background follows a σ = 15° Gaussian in b (68 % within ±15°), the other half is uniform (26 % within ±15°):
  // expect ≈ 47 % of the 2 000 points within ±15° of the plane (binomial σ ≈ 1.1 %).
  const frac = planeCount / 2000;
  assert.ok(frac > 0.40 && frac < 0.54, `background fraction within |b| < 15°: ${(frac * 100).toFixed(1)} % (expected ≈ 47 %)`);
  for (const [i, name] of Object.entries(sky.names)) assert.ok(Number(i) < sky.catalogueCount, `name ${name} belongs to a catalogue star`);
  // Deterministic for a seed; different seeds differ.
  const again = createSkyData({ background: 2000, seed: 7 });
  assert.deepEqual(again.dirs, sky.dirs, 'same seed → identical background');
  const other = createSkyData({ background: 2000, seed: 8 });
  assert.notDeepEqual(other.dirs, sky.dirs, 'different seed → different background');
  const r = mulberry32(1);
  const a = r(), b = r();
  assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1 && a !== b, 'mulberry32 yields uniform deviates in [0, 1)');
});
