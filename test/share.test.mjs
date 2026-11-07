// Deep-link encode/decode (src/app/share.js is pure: no DOM, no three). Round trips are exact; parsing is tolerant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jdFromGregorian, DEFAULT_MIN_JD, DEFAULT_MAX_JD, RATES } from '../src/astro/clock.js';
import {
  SHARE_KEYS, isoUtc, parseIsoUtc, compactNumber, buildShareParams, buildShareHash, buildShareUrl, parseShareHash,
  isShareHash, FOV_LIMITS, SIZE_K_LIMITS,
} from '../src/app/share.js';

const T_MARS = jdFromGregorian(2025, 1, 16, 2, 31, 0);

test('isoUtc / parseIsoUtc round trip, negative years, bare JD, impossible dates', () => {
  assert.equal(isoUtc(T_MARS), '2025-01-16T02:31:00Z');
  assert.equal(parseIsoUtc('2025-01-16T02:31:00Z'), T_MARS);
  assert.equal(parseIsoUtc('2025-01-16T02:31'), T_MARS, 'seconds optional');
  assert.equal(parseIsoUtc('2025-01-16 02:31:00'), T_MARS, 'space separator, no Z');
  assert.equal(parseIsoUtc('2025-01-16'), jdFromGregorian(2025, 1, 16), 'date only = 00:00 UTC');
  assert.ok(Math.abs(parseIsoUtc('2025-01-16T02:31:00.5Z') - (T_MARS + 0.5 / 86400)) < 1e-12, 'fractional seconds');
  assert.equal(isoUtc(jdFromGregorian(-500, 3, 1, 6, 7, 8)), '-0500-03-01T06:07:08Z');
  assert.equal(parseIsoUtc('-0500-03-01T06:07:08Z'), jdFromGregorian(-500, 3, 1, 6, 7, 8));
  assert.equal(parseIsoUtc('2451545'), 2451545, 'a bare Julian Date');
  assert.ok(Number.isNaN(parseIsoUtc('2025-13-01')), 'month 13');
  assert.ok(Number.isNaN(parseIsoUtc('2025-01-16T25:00')), 'hour 25');
  assert.ok(Number.isNaN(parseIsoUtc('garbage')));
  assert.ok(Number.isNaN(parseIsoUtc('')));
  assert.ok(Number.isNaN(parseIsoUtc('42')), 'a small number is not a JD');
});

test('compactNumber: significant digits, no trailing zeros', () => {
  assert.equal(compactNumber(42), '42');
  assert.equal(compactNumber(9.43210001, 5), '9.4321');
  assert.equal(compactNumber(-0.30000001, 7), '-0.3');
  assert.equal(compactNumber(1e-7), '1e-7');
});

test('full round trip: follow view with camera, rate, size, tour and event', () => {
  const state = {
    jdUtc: T_MARS, selected: 'mars', cameraMode: 'follow', followed: 'mars', rate: 1, playing: true,
    settings: { sizeK: 50 }, story: { tourId: 'welcome', index: 3 }, activeEventId: 'opposition:mars:1294637171',
  };
  const camera = { position: [1.2, -0.3, 0.5], target: [1.1, -0.2, 0.4] };
  const hash = buildShareHash(state, camera);
  assert.equal(hash, '#t=2025-01-16T02:31:00Z&sel=mars&view=follow:mars&cam=1.2,-0.3,0.5,1.1,-0.2,0.4&rate=1&k=50&tour=welcome:3&ev=opposition:mars:1294637171');
  assert.deepEqual(parseShareHash(hash), {
    jdUtc: T_MARS, selected: 'mars', view: { kind: 'follow', id: 'mars' },
    camera: { position: [1.2, -0.3, 0.5], target: [1.1, -0.2, 0.4] }, rate: 1, sizeK: 50,
    tour: { id: 'welcome', index: 3 }, eventId: 'opposition:mars:1294637171',
  });
  assert.deepEqual(buildShareParams(state, camera).map((p) => p[0]), ['t', 'sel', 'view', 'cam', 'rate', 'k', 'tour', 'ev']);
  for (const [k] of buildShareParams(state, camera)) assert.ok(SHARE_KEYS.includes(k), `${k} is a contract key`);
});

test('sky view: from>to list with fov; literal, percent-encoded and arrow forms all parse', () => {
  const state = { jdUtc: T_MARS, cameraMode: 'skyView', sky: { from: 'earth', to: ['jupiter', 'saturn'], fovDeg: 1.2, locked: false }, rate: 0, playing: false };
  const hash = buildShareHash(state, null);
  assert.equal(hash, '#t=2025-01-16T02:31:00Z&view=sky:earth>jupiter,saturn&fov=1.2&paused=1');
  const expected = { jdUtc: T_MARS, view: { kind: 'sky', from: 'earth', to: ['jupiter', 'saturn'] }, fovDeg: 1.2, paused: true };
  assert.deepEqual(parseShareHash(hash), expected);
  assert.deepEqual(parseShareHash(hash.replace('>', '%3E')), expected, 'browsers serialise > as %3E');
  assert.deepEqual(parseShareHash(hash.replace('>', '→')), expected, 'hand-written arrow');
  assert.deepEqual(parseShareHash('view=sky:mars>earth+venus').view, { kind: 'sky', from: 'mars', to: ['earth', 'venus'] }, "'+' separates targets too");
  assert.equal(parseShareHash('view=sky:earth').view, undefined, 'no targets → no view');
  const fovFromCamera = buildShareHash({ cameraMode: 'skyView', selected: 'jupiter' }, { fovDeg: 0.3 });
  assert.equal(fovFromCamera, '#sel=jupiter&view=sky:earth>jupiter&fov=0.3', 'selection is the fallback target; fov may come from the camera');
});

test('top view, free view with camera, fly-by encodes as follow of its target, Vector3-like camera objects', () => {
  assert.equal(buildShareHash({ cameraMode: 'free' }, { view: 'top', position: [0, 0, 20] }), '#view=top&cam=0,0,20,0,0,0', 'a missing target defaults to the origin');
  assert.equal(buildShareHash({ cameraMode: 'free', rate: -7 }, { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }), '#view=free&cam=1,2,3,0,0,0&rate=-7');
  assert.equal(buildShareHash({ cameraMode: 'flyby', flyby: { target: 'neptune' }, rate: 1 }), '#view=follow:neptune&rate=1');
  assert.equal(buildShareHash({ cameraMode: 'tour', flyby: { target: 'saturn' } }), '#view=follow:saturn');
  assert.deepEqual(parseShareHash('#view=top').view, { kind: 'top' });
  assert.deepEqual(parseShareHash('#view=home').view, { kind: 'free' });
  assert.deepEqual(parseShareHash('cam=1,2,3').camera, { position: [1, 2, 3], target: [0, 0, 0] }, 'three numbers = position only');
});

test('tolerant parsing: no hash sign, ; separators, named rates, unknown keys, garbage values dropped key by key', () => {
  assert.deepEqual(parseShareHash('sel=venus;rate=-week;foo=bar'), { selected: 'venus', rate: -RATES.week });
  assert.deepEqual(parseShareHash('?rate=rt&paused=false'), { rate: RATES.realtime, paused: false });
  assert.deepEqual(parseShareHash('sel=Mars&RATE=1'), { selected: 'mars', rate: 1 }, 'case-insensitive key and id');
  assert.deepEqual(parseShareHash('t=garbage&sel=Mars!&view=orbit:mars&cam=1,2&rate=abc&k=5000&fov=0&tour=welcome:x&ev=<script>'), {}, 'nothing valid → {}');
  assert.deepEqual(parseShareHash(''), {});
  assert.deepEqual(parseShareHash('#'), {});
  assert.deepEqual(parseShareHash(null), {});
  assert.deepEqual(parseShareHash('&&=&sel=&=mars'), {});
  assert.equal(parseShareHash('fov=0.25').fovDeg, 0.25);
  assert.equal(parseShareHash(`fov=${FOV_LIMITS.max + 1}`).fovDeg, undefined);
  assert.equal(parseShareHash(`k=${SIZE_K_LIMITS.max}`).sizeK, 1000);
  assert.equal(parseShareHash('k=0.5').sizeK, undefined);
  assert.equal(parseShareHash('rate=1e9').rate, undefined, '|rate| above the limit is ignored');
  assert.deepEqual(parseShareHash('tour=alignments').tour, { id: 'alignments', index: 0 }, 'index defaults to 0');
  assert.equal(isShareHash('#foo=bar'), false);
  assert.equal(isShareHash('#sel=mars'), true);
});

test('time is clamped to the clock range and the url builder replaces an existing hash', () => {
  assert.equal(parseShareHash('t=9999-12-31T00:00:00Z').jdUtc, DEFAULT_MAX_JD, 'clamped to 4000-12-31 23:59:59');
  assert.equal(parseShareHash('t=-4500-01-01').jdUtc, DEFAULT_MIN_JD, 'clamped to −4000-01-01');
  const url = buildShareUrl({ jdUtc: T_MARS, selected: 'mars', cameraMode: 'free' }, null, 'https://example.org/solarmap/#old=1');
  assert.equal(url, 'https://example.org/solarmap/#t=2025-01-16T02:31:00Z&sel=mars&view=free');
  assert.equal(buildShareUrl({ cameraMode: 'free' }, null, ''), '#view=free', 'no base → bare hash (node has no location)');
  assert.equal(buildShareUrl({ cameraMode: 'free' }, null), '#view=free', 'default base under node is empty');
});
