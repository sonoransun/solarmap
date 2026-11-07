// story.test.mjs — scheduler semantics of the story engine (src/app/story.js): two-phase chapter start, sequencing,
// holds with their caps, pause / resume, next / prev, snapshot restore on stop, reduced-motion timing, cues, the title
// card flag and the store patch contract (spec-contracts §Store, §Story engine).
// src/app/story.js is pure (no DOM, no three.js), so it is imported directly; every dependency is a fake below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStory, HOLD_CAP_S, HOLD_CAP_REDUCED_S, REDUCED_MOTION_EXTRA_S, TITLE_CARD_S, LIVE_INTERVAL_S, PREV_RESTART_S,
  estimateDurationS, formatTourDuration, formatFor,
} from '../src/app/story.js';
import { THIN_SPACE } from '../src/astro/format.js';

// ---------------------------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------------------------

/** A tour of three plain chapters (2 s, 3 s, 4 s) plus whatever `extra` chapters are appended. */
function makeTour(extra = [], id = 't') {
  return {
    id, title: 'Test tour', tagline: 'tagline',
    chapters: [
      { id: 'a', title: 'A', caption: 'cap a', detail: 'det a', seconds: 2, card: true, jdUtc: 2460000.5, rate: 365.25, paused: false, settings: { sizeK: 50 }, run: (ctx) => ctx.resetHome() },
      { id: 'b', title: 'B', caption: 'cap b', seconds: 3, paused: true, jdUtc: 2459000.5, run: (ctx) => { ctx.select('mars'); ctx.overlay({ kind: 'opposition', bodies: ['mars'], label: 'x' }); } },
      { id: 'c', title: 'C', caption: 'cap c', seconds: 4, rate: 1, paused: false, settings: { sizeK: 1 } },
      ...extra,
    ],
  };
}

function makeDeps({ tours, reduced = false, rig = true } = {}) {
  const state = { selected: 'earth', beamPartner: null, flyby: null, settings: { sizeK: 1, showOrientationDebug: false, introOnLoad: true }, story: null, jdUtc: 2461000.5 };
  const patches = [];
  const store = {
    get: () => state,
    set(p) { patches.push(p); Object.assign(state, p); },
  };
  const ck = { jd: 2461000.5, rate: 7, playing: true, target: 7, setJd: 0, setRate: 0 };
  const calls = [];
  const clock = {
    setJd(j) { ck.jd = j; ck.setJd += 1; calls.push(['setJd', j]); return j; },
    setRate(r) { ck.rate = r; ck.target = r; ck.setRate += 1; calls.push(['setRate', r]); },
    play() { ck.playing = true; calls.push(['play']); },
    pause() { ck.playing = false; calls.push(['pause']); },
    jd: () => ck.jd, rate: () => ck.rate, playing: () => ck.playing, target: () => ck.target,
  };
  const rigObj = rig ? {
    flyTo: (id) => { calls.push(['flyTo', id]); return true; },
    resetHome: () => calls.push(['resetHome']),
    frameBodies: (ids, o) => calls.push(['frameBodies', ids, o]),
    skyView: (a, b, o) => calls.push(['skyView', a, b, o]),
    setSkyFov: (f, s) => calls.push(['setSkyFov', f, s]),
    orbitDwell: (o) => calls.push(['orbitDwell', o]),
    stopDwell: () => calls.push(['stopDwell']),
    dollyTo: (d, s) => calls.push(['dollyTo', d, s]),
  } : null;
  let isReduced = reduced;
  const deps = {
    store, clock,
    rig: () => rigObj,
    sync: () => calls.push(['sync']),
    isReducedMotion: () => isReduced,
    nowJd: () => 2461000.5,
    overlays: { showAlignment: (ev) => calls.push(['overlay', ev]), hide: () => calls.push(['overlayHide']) },
    select: (id) => { calls.push(['select', id]); state.selected = id; },
    beam: (a, b) => { calls.push(['beam', a, b]); if (a == null) state.beamPartner = null; else { state.selected = a; state.beamPartner = b; } },
    settings: { get: () => state.settings, set: (p) => { calls.push(['settings', p]); state.settings = { ...state.settings, ...p }; } },
    providers: null,
    tours: tours ?? [makeTour()],
  };
  return { deps, state, ck, calls, patches, setReduced: (v) => { isReduced = v; } };
}

/** Run one frame: update(dt) then the camera phase (as main.js does after recomputing the states). */
function frame(story, dt) {
  const cam = story.update(dt);
  if (cam) cam();
  return cam;
}
/** Advance by `seconds` in `step` frames. */
function run(story, seconds, step = 0.1) {
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) frame(story, step);
}
const names = (calls) => calls.map((c) => c[0]);

// ---------------------------------------------------------------------------------------------------------------------
// Two-phase start
// ---------------------------------------------------------------------------------------------------------------------

test('play() does nothing until update(); the first update applies the clock and returns the camera phase', () => {
  const { deps, calls, ck, state } = makeDeps();
  const story = createStory(deps);
  assert.equal(story.active(), false, 'idle before play');
  assert.equal(story.play('nope'), false, 'unknown tour id is rejected');
  assert.equal(story.play('t'), true);
  assert.equal(story.status(), 'playing');
  assert.equal(state.story?.status, 'playing', 'store patch is published at play() for immediate UI feedback');
  assert.equal(calls.filter((c) => c[0] === 'setJd').length, 0, 'no clock mutation before the first update (two-phase start)');

  const cam = story.update(0.016);
  assert.equal(typeof cam, 'function', 'the start frame returns the pendingCamera closure');
  assert.equal(ck.jd, 2460000.5, 'clock phase ran inside update(): jdUtc applied');
  assert.equal(ck.rate, 365.25, 'rate applied in the clock phase');
  assert.equal(ck.playing, true);
  assert.ok(names(calls).includes('sync'), 'sync() pushed the clock into the store');
  assert.ok(names(calls).includes('settings'), 'settings override applied in the clock phase (sizeK matters to the rig planning)');
  assert.equal(names(calls).includes('resetHome'), false, 'camera actions wait for the camera phase');
  cam();
  assert.ok(names(calls).includes('resetHome'), 'camera phase runs the chapter.run camera action');
  assert.equal(state.story.caption, 'cap a');
  assert.equal(state.story.index, 0);
  assert.equal(state.story.count, 3);
});

test('a camera phase the host skipped runs on the next update, so a tour never stalls', () => {
  const { deps, calls } = makeDeps();
  const story = createStory(deps);
  story.play('t');
  story.update(0.016); // closure dropped on purpose
  assert.equal(names(calls).includes('resetHome'), false);
  story.update(0.016);
  assert.ok(names(calls).includes('resetHome'), 'the pending camera phase was executed by the following update');
});

// ---------------------------------------------------------------------------------------------------------------------
// Sequencing, progress, finish
// ---------------------------------------------------------------------------------------------------------------------

test('chapters advance after their dwell, the store reports progress, and the tour finishes with story: null', () => {
  const { deps, state, ck } = makeDeps();
  const story = createStory(deps);
  story.play('t');
  frame(story, 0);                    // start frame (no time advance)
  run(story, 1.0);
  assert.equal(state.story.index, 0);
  assert.ok(Math.abs(state.story.chapterProgress - 0.5) <= 0.02, `chapterProgress ≈ 0.5 after 1 of 2 s (got ${state.story.chapterProgress}; publish quantises to 0.01)`);
  assert.ok(Math.abs(state.story.progress - 0.5 / 3) <= 0.01, `overall progress ≈ (0 + 0.5)/3 (got ${state.story.progress}; quantised to 1/400)`);
  run(story, 1.05);                   // → chapter b starts (its clock phase pauses the clock)
  assert.equal(state.story.index, 1, 'second chapter after 2 s');
  assert.equal(ck.playing, false, 'chapter b paused the clock');
  assert.equal(ck.jd, 2459000.5, 'chapter b jumped the clock');
  assert.equal(state.story.caption, 'cap b');
  run(story, 3.05);
  assert.equal(state.story.index, 2, 'third chapter after 2 + 3 s');
  assert.equal(ck.playing, true, 'chapter c plays the clock');
  run(story, 4.05);
  assert.equal(state.story, null, 'finished: store.story is null');
  assert.equal(story.active(), false);
  assert.equal(story.lastReason(), 'finished');
});

test('estimateDurationS adds a nominal hold per held chapter; formatTourDuration rounds to half minutes', () => {
  const tour = { id: 'x', title: 'x', chapters: [{ id: 'a', caption: '', seconds: 10 }, { id: 'b', caption: '', seconds: 5, hold: 'arrived' }] };
  assert.equal(estimateDurationS(tour), 19, '10 + 5 + 4 (HOLD_NOMINAL_S.arrived)');
  assert.equal(formatTourDuration(50), '≈ 1 min', '50 s rounds to the 1 min floor');
  assert.equal(formatTourDuration(91), '≈ 1½ min');
  assert.equal(formatTourDuration(147), '≈ 2½ min');
  assert.equal(formatTourDuration(180), '≈ 3 min');
});

// ---------------------------------------------------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------------------------------------------------

test('a held chapter waits for its rig signal (dwell timer frozen), fires `arrived` once, and is capped at HOLD_CAP_S', () => {
  const held = { id: 'h', caption: 'hold', seconds: 2, hold: 'arrived', run: (ctx) => ctx.flyTo('saturn'), arrived: (ctx) => ctx.orbitDwell({ degPerS: 4 }), end: (ctx) => ctx.stopDwell() };
  const { deps, state, calls } = makeDeps({ tours: [{ id: 'h', title: 'H', chapters: [held, { id: 'z', caption: 'z', seconds: 1 }] }] });
  const story = createStory(deps);
  story.play('h');
  frame(story, 0);
  assert.equal(state.story.holding, true, 'holding after the camera phase launched the flight');
  run(story, 5);
  assert.equal(state.story.index, 0, 'dwell did not run while holding (5 s > 2 s dwell)');
  assert.equal(state.story.chapterProgress, 0);
  assert.equal(story.notify({ type: 'poseDone' }), false, 'a different signal does not resolve an arrival hold');
  assert.equal(story.notify({ type: 'arrived', id: 'saturn' }), true);
  assert.equal(state.story.holding, false);
  assert.equal(names(calls).filter((n) => n === 'orbitDwell').length, 1, '`arrived` hook ran once when the hold resolved');
  run(story, 2.05);
  assert.equal(state.story.index, 1, 'dwell ran after the hold');
  assert.ok(names(calls).includes('stopDwell'), 'chapter.end ran when the chapter was left');

  // Cap: no signal at all.
  const d2 = makeDeps({ tours: [{ id: 'h', title: 'H', chapters: [held, { id: 'z', caption: 'z', seconds: 1 }] }] });
  const s2 = createStory(d2.deps);
  s2.play('h');
  frame(s2, 0);
  run(s2, HOLD_CAP_S.arrived - 0.2);
  assert.equal(d2.state.story.index, 0, 'still holding just before the cap');
  run(s2, 0.3 + 2.05);
  assert.equal(d2.state.story.index, 1, `proceeds after the ${HOLD_CAP_S.arrived} s cap plus the 2 s dwell`);
});

test('a hold is skipped when run() returns false (nothing launched) or when there is no rig', () => {
  const chapters = [{ id: 'h', caption: 'h', seconds: 1, hold: 'arrived', run: () => false }, { id: 'z', caption: 'z', seconds: 1 }];
  const a = makeDeps({ tours: [{ id: 'h', title: 'H', chapters }] });
  const sa = createStory(a.deps); sa.play('h'); frame(sa, 0);
  assert.equal(a.state.story.holding, false, 'run() === false cancels the hold');
  const b = makeDeps({ tours: [{ id: 'h', title: 'H', chapters: [{ ...chapters[0], run: (ctx) => ctx.flyTo('mars') }, chapters[1]] }], rig: false });
  const sb = createStory(b.deps); sb.play('h'); frame(sb, 0);
  assert.equal(b.state.story.holding, false, 'no rig → no hold (ctx.flyTo reports false)');
});

test('a `cancelled` rig signal resolves any hold (the user interrupted the flight)', () => {
  const held = { id: 'h', caption: 'hold', seconds: 1, hold: 'skyReady', run: (ctx) => ctx.skyView('earth', ['mars']) };
  const { deps, state } = makeDeps({ tours: [{ id: 'h', title: 'H', chapters: [held, { id: 'z', caption: 'z', seconds: 1 }] }] });
  const story = createStory(deps);
  story.play('h'); frame(story, 0);
  assert.equal(state.story.holding, true);
  assert.equal(story.notify('cancelled'), true, 'string form of notify is accepted');
  assert.equal(state.story.holding, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Pause / resume / toggle
// ---------------------------------------------------------------------------------------------------------------------

test('pause() freezes the dwell and the sim clock it stopped; resume() gives both back; toggle() alternates', () => {
  const { deps, state, ck } = makeDeps();
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  run(story, 0.5);
  assert.equal(story.pause('interaction'), true);
  assert.equal(state.story.status, 'paused');
  assert.equal(state.story.pausedBy, 'interaction');
  assert.equal(ck.playing, false, 'the running clock was paused with the story');
  run(story, 5);
  assert.equal(state.story.index, 0, 'no chapter advance while paused');
  assert.equal(story.pause(), false, 'pause() is idempotent');
  assert.equal(story.resume(), true);
  assert.equal(ck.playing, true, 'the clock the story paused is running again');
  assert.equal(state.story.status, 'playing');
  assert.equal(story.toggle(), true); assert.equal(story.status(), 'paused');
  assert.equal(story.toggle(), true); assert.equal(story.status(), 'playing');
  run(story, 1.6);
  assert.equal(state.story.index, 1, 'the dwell continued from 0.5 s: chapter b after 2 s of story time');
});

test('a clock the user had paused is not started by resume(); a paused tableau chapter stays paused', () => {
  const { deps, ck } = makeDeps();
  ck.playing = false;
  const story = createStory(deps);
  story.play('t'); frame(story, 0);          // chapter a: paused:false → plays (the tour's wish)
  assert.equal(ck.playing, true);
  run(story, 2.1);                           // chapter b: paused:true
  assert.equal(ck.playing, false);
  story.pause('user');
  story.resume();
  assert.equal(ck.playing, false, 'resume() only restarts a clock the story itself paused');
});

// ---------------------------------------------------------------------------------------------------------------------
// next / prev
// ---------------------------------------------------------------------------------------------------------------------

test('next() and prev() are two-phase (applied on the next update); prev restarts after PREV_RESTART_S', () => {
  const { deps, state, ck, calls } = makeDeps();
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  assert.equal(story.next(), true);
  assert.equal(state.story.index, 0, 'index changes on the next update, not synchronously');
  const cam = story.update(0.016);
  assert.equal(typeof cam, 'function', 'the skip frame returns the camera phase');
  assert.equal(ck.jd, 2459000.5, 'chapter b clock phase applied before the camera phase');
  const before = calls.length;
  cam();
  assert.ok(calls.slice(before).some((c) => c[0] === 'select' && c[1] === 'mars'), 'camera phase of chapter b ran');
  assert.equal(state.story.index, 1);
  run(story, 0.5);
  assert.equal(story.prev(), true); frame(story, 0.016);
  assert.equal(state.story.index, 0, 'prev() within PREV_RESTART_S goes to the previous chapter');
  run(story, PREV_RESTART_S + 0.2 > 2 ? 1.9 : PREV_RESTART_S + 0.1);
  // chapter a lasts 2 s; use chapter c (4 s) to test the restart rule
  story.next(); frame(story, 0); story.next(); frame(story, 0);
  assert.equal(state.story.index, 2);
  run(story, PREV_RESTART_S + 0.2);
  story.prev(); frame(story, 0.016);
  assert.equal(state.story.index, 2, `prev() after ${PREV_RESTART_S} s restarts the current chapter`);
  assert.equal(state.story.chapterProgress, 0, 'restart resets the dwell');
  story.next(); frame(story, 0);
  assert.equal(state.story, null, 'next() on the last chapter finishes the tour');
  assert.equal(story.lastReason(), 'finished');
});

test('prev() on the first chapter restarts it; next()/prev() while paused keep the story paused', () => {
  const { deps, state } = makeDeps();
  const story = createStory(deps);
  story.play('t'); frame(story, 0); run(story, 0.5);
  story.prev(); frame(story, 0.016);
  assert.equal(state.story.index, 0);
  story.pause('user');
  story.next(); frame(story, 0.016);
  assert.equal(state.story.index, 1, 'skip applies while paused');
  assert.equal(state.story.status, 'paused', 'still paused after a skip');
});

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot / restore on stop
// ---------------------------------------------------------------------------------------------------------------------

test('stop() restores settings, selection, overlay and rate the tour changed, and leaves a tableau clock paused', () => {
  const { deps, state, ck, calls } = makeDeps();
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  assert.equal(state.settings.sizeK, 50, 'override applied');
  run(story, 2.1); // chapter b (selects mars, overlay, paused clock, no sizeK → restored to 1)
  assert.equal(state.settings.sizeK, 1, 'a key no longer requested goes back to the pre-tour value between chapters');
  assert.equal(state.selected, 'mars');
  assert.ok(names(calls).includes('overlay'));
  const n0 = calls.length;
  assert.equal(story.stop('user'), true);
  const after = calls.slice(n0);
  assert.ok(after.some((c) => c[0] === 'overlayHide'), 'overlay hidden on stop');
  assert.ok(after.some((c) => c[0] === 'select' && c[1] === 'earth'), 'selection restored to the pre-tour body');
  assert.ok(after.some((c) => c[0] === 'setRate' && c[1] === 7), 'rate restored to the user\'s 7 d/s (the tour set 365.25)');
  assert.equal(ck.playing, false, 'a paused tableau stays paused on a user stop (the moment can be explored)');
  assert.equal(state.story, null);
  assert.equal(story.lastReason(), 'user');
  assert.equal(story.stop(), false, 'stop() when idle is a no-op');
});

test('stop() leaves alone what the user changed since the tour set it (settings, selection, rate)', () => {
  const { deps, state, ck, calls } = makeDeps();
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  // user edits during chapter a
  state.settings = { ...state.settings, sizeK: 500 };
  state.selected = 'venus';
  ck.rate = 30; ck.target = 30;
  run(story, 2.1); // chapter b selects mars
  const n0 = calls.length;
  story.stop('user');
  const after = calls.slice(n0);
  assert.equal(state.settings.sizeK, 500, 'user\'s sizeK kept (differs from the tour\'s 50)');
  assert.ok(after.some((c) => c[0] === 'select' && c[1] === 'earth'), 'selection: the tour set mars last and it is still mars → restored');
  assert.equal(after.some((c) => c[0] === 'setRate'), false, 'rate left alone: the user changed it after the tour set it');
});

test('on a natural finish the finale\'s running clock is paused again if the user had it paused; beams are restored', () => {
  const tour = makeTour([{ id: 'beam', caption: 'beam', seconds: 1, run: (ctx) => ctx.beam('earth', 'mars') }]);
  const { deps, state, ck, calls } = makeDeps({ tours: [tour] });
  ck.playing = false;
  state.beamPartner = 'jupiter';
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  run(story, 2.1 + 3.05 + 4.05);
  assert.equal(state.story.index, 3);
  assert.equal(state.beamPartner, 'mars', 'tour beam active');
  run(story, 1.1);
  assert.equal(state.story, null, 'finished');
  assert.equal(ck.playing, false, 'user had the clock paused: paused again after the tour');
  assert.ok(calls.some((c) => c[0] === 'beam' && c[1] === 'earth' && c[2] === 'jupiter'), 'pre-tour beam restored');
});

test('starting another tour while one runs stops the first (reason replaced) and re-snapshots', () => {
  const t2 = makeTour([], 'u');
  const { deps, state } = makeDeps({ tours: [makeTour(), t2] });
  const story = createStory(deps);
  story.play('t'); frame(story, 0); run(story, 0.5);
  story.play('u');
  assert.equal(story.lastReason(), null, 'lastReason resets on play');
  assert.equal(story.tourId(), 'u');
  frame(story, 0);
  assert.equal(state.story.tourId, 'u');
  assert.equal(state.settings.sizeK, 50, 'new tour applied its override');
});

// ---------------------------------------------------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------------------------------------------------

test('reduced motion: every caption stays REDUCED_MOTION_EXTRA_S longer, holds are capped at HOLD_CAP_REDUCED_S, no dwell', () => {
  const held = { id: 'h', caption: 'hold', seconds: 2, hold: 'arrived', run: (ctx) => ctx.flyTo('saturn'), arrived: (ctx) => ctx.orbitDwell({ degPerS: 4 }) };
  const { deps, state, calls } = makeDeps({ reduced: true, tours: [{ id: 'h', title: 'H', chapters: [held, { id: 'z', caption: 'z', seconds: 1 }] }] });
  const story = createStory(deps);
  story.play('h'); frame(story, 0);
  run(story, HOLD_CAP_REDUCED_S + 0.1);
  assert.equal(state.story.holding, false, `hold capped at ${HOLD_CAP_REDUCED_S} s under reduced motion`);
  assert.equal(names(calls).includes('orbitDwell'), false, 'no auto-rotate under reduced motion');
  run(story, 2.0);
  assert.equal(state.story.index, 0, 'dwell is 2 + 1.5 s under reduced motion: still chapter 0 after 2 s');
  run(story, REDUCED_MOTION_EXTRA_S + 0.1);
  assert.equal(state.story.index, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Cues, live detail, caption functions, title card
// ---------------------------------------------------------------------------------------------------------------------

test('cues fire once when the dwell crosses t; live detail refreshes every LIVE_INTERVAL_S; caption may be a function', () => {
  let liveN = 0;
  const ch = {
    id: 'l', caption: (ctx) => `cap ${ctx.memo.flag ? 'flagged' : 'plain'}`, seconds: 3,
    jdUtc: (ctx) => { ctx.memo.flag = true; return undefined; },
    live: () => `live ${++liveN}`, cues: [{ t: 1, run: (ctx) => ctx.setSkyFov(0.3, 2) }],
  };
  const { deps, state, calls, ck } = makeDeps({ tours: [{ id: 'l', title: 'L', chapters: [ch] }] });
  const story = createStory(deps);
  story.play('l'); frame(story, 0);
  assert.equal(ck.setJd, 0, 'a jdUtc function returning undefined leaves the clock alone');
  assert.equal(state.story.caption, 'cap flagged', 'caption(ctx) evaluated after the clock phase (memo set in jdUtc)');
  assert.equal(state.story.detail, 'live 1', 'live detail computed at chapter start');
  run(story, 0.9);
  assert.equal(names(calls).filter((n) => n === 'setSkyFov').length, 0);
  run(story, 0.2);
  assert.equal(names(calls).filter((n) => n === 'setSkyFov').length, 1, 'cue fired once at t = 1 s');
  run(story, 1.5);
  assert.equal(names(calls).filter((n) => n === 'setSkyFov').length, 1, 'cue does not repeat');
  const expected = 1 + Math.floor(2.6 / LIVE_INTERVAL_S);
  assert.ok(Math.abs(liveN - expected) <= 1, `live() evaluated about every ${LIVE_INTERVAL_S} s (got ${liveN}, expected ≈ ${expected})`);
});

test('title card flag is true on chapter 0 for TITLE_CARD_S seconds (including holds), then false; never on later chapters', () => {
  // Chapter 0 must outlast the card (the real tours dwell ≥ 5 s): 6 s here.
  const tour = makeTour();
  tour.chapters[0] = { ...tour.chapters[0], seconds: 6 };
  const { deps, state } = makeDeps({ tours: [tour] });
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  assert.equal(state.story.card, true);
  run(story, TITLE_CARD_S - 0.3);
  assert.equal(state.story.card, true);
  run(story, 0.4);
  assert.equal(state.story.card, false, 'card dropped after TITLE_CARD_S');
  story.next(); frame(story, 0);
  assert.equal(state.story.card, false, 'no card on chapter 1');
});

// ---------------------------------------------------------------------------------------------------------------------
// Store patch contract, state(), list(), ctx helpers
// ---------------------------------------------------------------------------------------------------------------------

test('the store patch carries the contract fields and is only republished on visible change', () => {
  const { deps, state, patches } = makeDeps();
  const story = createStory(deps);
  story.play('t'); frame(story, 0);
  const st = state.story;
  for (const k of ['tourId', 'index', 'count', 'status', 'progress', 'title', 'caption', 'detail', 'holding']) {
    assert.ok(k in st, `story.${k} present (spec-contracts §Store)`);
  }
  assert.equal(st.tourId, 't'); assert.equal(st.status, 'playing'); assert.equal(st.holding, false);
  const n0 = patches.length;
  story.update(0.0001); // < 1 % of the chapter: nothing visible changed
  assert.equal(patches.length, n0, 'no store patch when nothing visible changed');
  const s = story.state();
  assert.equal(s.tourId, 't'); assert.equal(s.chapter.id, 'a'); assert.equal(s.count, 3);
  assert.equal(story.state() === null, false);
  story.stop();
  assert.equal(story.state(), null, 'state() is null when idle');
});

test('list() summarises the tours with an estimated duration', () => {
  const { deps } = makeDeps({ tours: [makeTour()] });
  const story = createStory(deps);
  const l = story.list();
  assert.equal(l.length, 1);
  assert.deepEqual(Object.keys(l[0]).sort(), ['chapters', 'durationS', 'id', 'tagline', 'title']);
  assert.equal(l[0].durationS, 9, '2 + 3 + 4 s, no holds');
});

test('ctx camera helpers tolerate an older rig: frameBodies falls back to frameTopDown, dollyTo/orbitDwell report false', () => {
  const calls = [];
  const oldRig = { frameTopDown: (o) => calls.push(['frameTopDown', o]), flyTo: () => true };
  let got = null;
  const ch = { id: 'f', caption: 'f', seconds: 1, run: (ctx) => { got = { fb: ctx.frameBodies(['earth', 'mars'], { seconds: 2 }), dolly: ctx.dollyTo(6, 2), dwell: ctx.orbitDwell({}) }; } };
  const { deps } = makeDeps({ tours: [{ id: 'f', title: 'F', chapters: [ch] }] });
  deps.rig = () => oldRig;
  deps.providers = { bodyInfo: (id) => ({ rSunAu: id === 'mars' ? 1.6 : 1.0 }) };
  const story = createStory(deps);
  story.play('f'); frame(story, 0);
  assert.equal(got.fb, true);
  assert.equal(got.dolly, false);
  assert.equal(got.dwell, false);
  assert.equal(calls[0][0], 'frameTopDown');
  assert.ok(Math.abs(calls[0][1].radius - 1.6 * 1.25) < 1e-12, 'fallback radius = max heliocentric distance × 1.25 margin');
  assert.equal(calls[0][1].seconds, 2);
});

test('formatFor() merges providers.format over the astro/format.js fallbacks', () => {
  const f = formatFor(null);
  assert.equal(f.au(1), '1.0000 AU');
  assert.equal(f.lightTime(499.004783836), '8 min 19 s');
  const g = formatFor({ format: { au: () => 'custom' } });
  assert.equal(g.au(1), 'custom');
  assert.equal(g.km(1000), `1${THIN_SPACE}000 km`, 'other keys keep the fallback (thousands grouped with U+2009 THIN SPACE, format.js)');
});

test('ctx.separationDeg uses providers.separationDeg, else bodyState vectors, else NaN', () => {
  let seen = null;
  const ch = { id: 's', caption: 's', seconds: 1, run: (ctx) => { seen = ctx.separationDeg('earth', 'jupiter', 'saturn'); } };
  const mk = (providers) => { const d = makeDeps({ tours: [{ id: 's', title: 'S', chapters: [ch] }] }); d.deps.providers = providers; const s = createStory(d.deps); s.play('s'); frame(s, 0); return seen; };
  assert.equal(mk({ separationDeg: () => 0.1 }), 0.1);
  const st = { earth: { x: 0, y: 0, z: 0 }, jupiter: { x: 1, y: 0, z: 0 }, saturn: { x: 0, y: 1, z: 0 } };
  assert.ok(Math.abs(mk({ bodyState: (id) => st[id] }) - 90) < 1e-9, 'perpendicular directions → 90° (angleBetween, atan2 form)');
  assert.ok(Number.isNaN(mk(null)), 'NaN without providers');
});
