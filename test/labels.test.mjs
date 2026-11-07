// Pure label-layout helpers (src/render/labelLayout.js has no three.js and no DOM; it is the one render module that
// node imports, by agreement with the task brief). Every tolerance is stated in the assertion message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMB_MODE_PX, LIMB_GAP_PX, MARKER_GAP_PX, HYSTERESIS_S, FADE_MIN, PARENT_MARGIN_PX, FEW_MIN_PRIORITY,
  smoothstep, placementMode, labelAnchor, clampAnchor, distanceFade, rectsOverlap, isOccluded, nearParent,
  passesDensity, createHysteresis, hysteresisStep,
} from '../src/render/labelLayout.js';

test('placementMode: marker up to 14 px, limb above (task brief: limb offset when pxRadius > 14 px)', () => {
  assert.equal(placementMode(0), 'marker');
  assert.equal(placementMode(LIMB_MODE_PX), 'marker', 'exactly 14 px is still a marker label');
  assert.equal(placementMode(LIMB_MODE_PX + 1e-9), 'limb');
  assert.equal(placementMode(400), 'limb');
});

test('labelAnchor: upper-right of the limb at pxRadius + 10 px; marker mode hugs the marker', () => {
  const a = labelAnchor(30);
  const r = Math.hypot(a[0], a[1]);
  assert.ok(Math.abs(r - (30 + LIMB_GAP_PX)) < 1e-9, `anchor radius ${r} = pxRadius + 10 (exact to 1e-9)`);
  assert.ok(a[0] > 0 && a[1] < 0, 'upper-right: +x, −y (screen y points down)');
  assert.ok(Math.abs(a[0] + a[1]) < 1e-9, '45°: |dx| = |dy| to 1e-9');
  const m = labelAnchor(5, [9, 9]);
  assert.deepEqual(m, [MARKER_GAP_PX, 0], 'marker mode: 2 px right of the marker centre, vertically centred');
  const out = [0, 0];
  assert.equal(labelAnchor(100, out), out, 'reuses the out array (no allocation in the layout loop)');
});

test('clampAnchor keeps a left-middle rect inside the viewport with an 8 px margin', () => {
  // inside: unchanged
  assert.deepEqual(clampAnchor(100, 200, 60, 28, 800, 600), [100, 200]);
  // off the right edge: x = viewW − w − margin
  assert.deepEqual(clampAnchor(790, 200, 60, 28, 800, 600), [800 - 60 - 8, 200]);
  // above the top: y = margin + h/2 so the rect's top edge is at the margin
  assert.deepEqual(clampAnchor(100, -40, 60, 28, 800, 600), [100, 8 + 14]);
  // below the bottom
  assert.deepEqual(clampAnchor(100, 900, 60, 28, 800, 600), [100, 600 - 14 - 8]);
  // left edge
  assert.deepEqual(clampAnchor(-50, 200, 60, 28, 800, 600), [8, 200]);
});

test('distanceFade: 1 up to 60 AU, 0.7 at the band midpoint (230 AU), 0.4 from 400 AU (plan §Labels)', () => {
  assert.equal(distanceFade(0), 1);
  assert.equal(distanceFade(60), 1);
  assert.ok(Math.abs(distanceFade(230) - 0.7) < 1e-12, `midpoint: 1 − 0.6·smoothstep(0.5) = 0.7 (got ${distanceFade(230)})`);
  assert.equal(distanceFade(400), FADE_MIN);
  assert.equal(distanceFade(5000), FADE_MIN);
  assert.ok(Math.abs(smoothstep(0, 1, 0.25) - 0.15625) < 1e-12, 'smoothstep(0.25) = 3·0.0625 − 2·0.015625 = 0.15625 (GLSL definition)');
});

test('rectsOverlap: left-middle rects with a 4 px margin', () => {
  // side by side, touching with less than the margin → overlap
  assert.equal(rectsOverlap(0, 100, 60, 28, 62, 100, 60, 28), true, '2 px apart horizontally < 4 px margin');
  assert.equal(rectsOverlap(0, 100, 60, 28, 64, 100, 60, 28), false, 'exactly the margin apart is clear');
  // stacked: centres 28 px apart with heights 28 → edges touch; the margin makes it an overlap
  assert.equal(rectsOverlap(0, 100, 60, 28, 0, 128, 60, 28), true);
  assert.equal(rectsOverlap(0, 100, 60, 28, 0, 132, 60, 28), false, '|dy| = (28+28)/2 + 4 → clear');
  // mixed heights (32 px coarse-pointer label beside a 28 px one)
  assert.equal(rectsOverlap(0, 100, 60, 32, 0, 133, 60, 28), true, '|dy| 33 < (32+28)/2 + 4 = 34');
  assert.equal(rectsOverlap(0, 100, 60, 32, 0, 134, 60, 28), false);
});

test('isOccluded: a body whose centre falls inside a nearer, larger disc is hidden; never the other way round', () => {
  // Mars (px 3, 6 AU away) behind Jupiter (px 40, 4 AU away), 10 px from its centre
  assert.equal(isOccluded(410, 300, 6, 3, 400, 300, 4, 40), true);
  // the same geometry with Mars in front
  assert.equal(isOccluded(410, 300, 3, 3, 400, 300, 4, 40), false, 'nearer body is not occluded');
  // outside the disc
  assert.equal(isOccluded(445, 300, 6, 3, 400, 300, 4, 40), false, '45 px > 40 px radius');
  // the "occluder" is smaller on screen (a moon in front of a planet seen from far away does not hide it)
  assert.equal(isOccluded(400, 300, 6, 40, 401, 300, 4, 3), false);
  // sub-pixel discs never occlude anything
  assert.equal(isOccluded(400, 300, 6, 0.1, 400, 300, 4, 0.8), false);
});

test('nearParent: the Moon is unlabelled within Earth pxRadius + 6 px of Earth\'s centre', () => {
  // home view: Earth 0.02 px, Moon 0.07 px away → hidden
  assert.equal(nearParent(400.07, 300, 400, 300, 0.02), true);
  // 5.9 px away with a 0.02 px Earth: still inside 6.02 px
  assert.equal(nearParent(405.9, 300, 400, 300, 0.02), true);
  assert.equal(nearParent(406.1, 300, 400, 300, 0.02), false, '6.1 px > 0.02 + 6 px');
  // following Earth at 60 Earth radii: Earth 50 px, Moon 3000 px away → shown
  assert.equal(nearParent(3400, 300, 400, 300, 50), false);
  assert.equal(PARENT_MARGIN_PX, 6);
});

test('passesDensity: few keeps priority ≥ 7 (Sun 10, Earth 9, Moon 8, Jupiter 8, Saturn 7), auto/all keep everything', () => {
  assert.equal(FEW_MIN_PRIORITY, 7);
  assert.equal(passesDensity(7, 'few'), true);
  assert.equal(passesDensity(6, 'few'), false, 'Mars (6) is dropped under few');
  assert.equal(passesDensity(2, 'auto'), true);
  assert.equal(passesDensity(2, 'all'), true);
  assert.equal(passesDensity(2, undefined), true);
});

test('hysteresis: first decision is immediate, flips need ≥ 0.4 s in the current state, blips never show', () => {
  assert.equal(HYSTERESIS_S, 0.4);
  const h = createHysteresis();
  assert.equal(hysteresisStep(h, true, 0.125), true, 'a fresh state applies the first wish at once');
  assert.equal(hysteresisStep(h, false, 0.125), true, 'hidden wish after 0.125 s is held off');
  assert.equal(hysteresisStep(h, false, 0.125), true, '0.25 s');
  assert.equal(hysteresisStep(h, false, 0.125), true, '0.375 s < 0.4 s: still shown');
  assert.equal(hysteresisStep(h, false, 0.125), false, '0.5 s ≥ 0.4 s: flips (steps of 0.125 s are exact in binary)');
  // a blip: wants to show for 0.125 s then hide again → never shows
  assert.equal(hysteresisStep(h, true, 0.125), false);
  assert.equal(hysteresisStep(h, false, 0.125), false);
  assert.equal(hysteresisStep(h, false, 5), false);
  assert.equal(hysteresisStep(h, true, 0.125), true, 'after a long hidden spell a show wish applies at once');
  // hold = 0 (the selected label) flips immediately both ways
  const s = createHysteresis();
  assert.equal(hysteresisStep(s, true, 0.01, 0), true);
  assert.equal(hysteresisStep(s, false, 0.01, 0), false);
  assert.equal(hysteresisStep(s, true, 0.01, 0), true);
});
