// tours.test.mjs — validity of the curated tours (src/app/tours.js): unique ids, caption / detail lengths, duration
// targets from the brief, and provenance: every VERIFIED instant is matched against its row in
// test/fixtures/events.json (kind + bodies → utc within tolMin, or date within tolDays) and every fixed chapter date is
// one of those table entries (no hand-typed dates). The chosen Saturn epoch and the sky-view captions are checked
// against the app's own ephemeris + orientation model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOURS, TOUR_IDS, VERIFIED, EPOCHS, PROXIMA_AU, RING_OPEN_MIN_DEG, OVERVIEW_SIZE_K, jdOfIso, tourById } from '../src/app/tours.js';
import { estimateDurationS, formatFor } from '../src/app/story.js';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris } from '../src/astro/ephemeris.js';
import { ttFromUtc, jdFromCalendar } from '../src/astro/time.js';
import { subSolarPoint } from '../src/astro/orientation.js';
import { angleBetween } from '../src/astro/vec.js';
import { RAD, AU_KM } from '../src/astro/constants.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'));
const MIN_PER_DAY = 1440;

/** Caption limit (brief: ≤ 110 chars) and detail limit (≤ 140 chars). */
const CAPTION_MAX = 110;
const DETAIL_MAX = 140;

/** Duration targets from the brief (seconds, on estimateDurationS). */
const DURATION_RANGES = {
  welcome: [80, 95],
  planets: [120, 165],
  alignments: [95, 130],
  scale: [75, 100],
  seasons: [45, 75],
};

// ---------------------------------------------------------------------------------------------------------------------
// Mock chapter context (shape of createStory's ctx)
// ---------------------------------------------------------------------------------------------------------------------
function mockCtx({ empty = false, memo = {} } = {}) {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); return true; };
  const info = (id) => (empty ? null : {
    rSunAu: id === 'sun' ? 0 : id === 'neptune' ? 29.9 : 5.2, earthDistAu: 4.2, orbitalSpeedKmS: 13.07,
    siderealRotationHours: 9.9, subSolarLatDeg: -8.19, elongSide: 'W', elongationDeg: 40, phaseAngleDeg: 10,
  });
  return {
    calls, memo,
    nowJd: () => 2461000.5,
    reduced: () => false,
    chapterSeconds: () => 7,
    state: () => ({ jdUtc: 2461000.5, flyby: null }),
    format: formatFor(null),
    bodyInfo: info,
    distanceAu: () => (empty ? NaN : 0.6428),
    separationDeg: () => (empty ? NaN : 0.1017),
    flyby: () => (empty ? null : { target: 'neptune', speedC: 1340, lightMinutesToTarget: 239, tau: 0.5, from: 'earth', kind: 'warp' }),
    cameraInfo: () => null,
    rig: () => ({}),
    flyTo: rec('flyTo'), follow: rec('follow'), skyView: rec('skyView'), setSkyFov: rec('setSkyFov'), exitSkyView: rec('exitSkyView'),
    frameBodies: rec('frameBodies'), dollyTo: rec('dollyTo'), orbitDwell: rec('orbitDwell'), stopDwell: rec('stopDwell'),
    resetHome: rec('resetHome'), cancel: rec('cancel'), select: rec('select'), beam: rec('beam'), overlay: rec('overlay'), setRate: rec('setRate'),
  };
}

const captionOf = (ch, ctx) => (typeof ch.caption === 'function' ? ch.caption(ctx) : ch.caption);

// ---------------------------------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------------------------------

test('tour ids are unique, chapter ids unique within each tour, chapter 0 carries the title card', () => {
  assert.deepEqual(TOUR_IDS, ['welcome', 'planets', 'alignments', 'scale', 'seasons']);
  assert.equal(new Set(TOUR_IDS).size, TOURS.length, 'tour ids unique');
  for (const t of TOURS) {
    assert.ok(t.title && t.tagline, `${t.id}: title and tagline`);
    assert.ok(t.chapters.length >= 4, `${t.id}: at least 4 chapters`);
    const ids = t.chapters.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${t.id}: chapter ids unique (${ids.join(', ')})`);
    assert.equal(t.chapters[0].card, true, `${t.id}: chapter 0 is the title card`);
    assert.equal(t.chapters.slice(1).some((c) => c.card), false, `${t.id}: only chapter 0 has the card flag`);
    for (const c of t.chapters) {
      assert.ok(Number.isFinite(c.seconds) && c.seconds > 0 && c.seconds <= 20, `${t.id}/${c.id}: seconds in (0, 20] (got ${c.seconds})`);
      if (c.hold) assert.ok(['arrived', 'poseDone', 'skyReady'].includes(c.hold), `${t.id}/${c.id}: hold type`);
      if (c.rate !== undefined) assert.ok(Number.isFinite(c.rate) && c.rate > 0, `${t.id}/${c.id}: positive finite rate`);
    }
    assert.equal(t.chapters[t.chapters.length - 1].id, 'finale', `${t.id}: ends with the finale that returns to now`);
    assert.equal(tourById(t.id), t);
  }
  assert.equal(tourById('nope'), null);
});

test('durations match the brief (estimateDurationS)', () => {
  for (const t of TOURS) {
    const [lo, hi] = DURATION_RANGES[t.id];
    const d = estimateDurationS(t);
    assert.ok(d >= lo && d <= hi, `${t.id}: ${d.toFixed(1)} s should be within ${lo}–${hi} s (brief: Welcome ≈ 80–95 s, Planets ≈ 2.5 min, Alignments ≈ 2 min, Scale ≈ 90 s, Seasons ≈ 60 s)`);
  }
});

test('captions ≤ 110 and details ≤ 140 characters, with live details evaluated on a populated and an empty context', () => {
  for (const t of TOURS) {
    for (const ch of t.chapters) {
      for (const memo of [{}, { saturnJumped: true }, { saturnJumped: false }]) {
        const cap = captionOf(ch, mockCtx({ memo }));
        assert.equal(typeof cap, 'string');
        assert.ok(cap.length > 0 && cap.length <= CAPTION_MAX, `${t.id}/${ch.id}: caption ${cap.length} chars (max ${CAPTION_MAX}): "${cap}"`);
      }
      if (ch.detail !== undefined) assert.ok(ch.detail.length <= DETAIL_MAX, `${t.id}/${ch.id}: detail ${ch.detail.length} chars (max ${DETAIL_MAX})`);
      if (ch.live) {
        const full = ch.live(mockCtx());
        assert.equal(typeof full, 'string', `${t.id}/${ch.id}: live() returns a string`);
        assert.ok(full.length <= DETAIL_MAX, `${t.id}/${ch.id}: live detail ${full.length} chars (max ${DETAIL_MAX}): "${full}"`);
        const none = ch.live(mockCtx({ empty: true }));
        assert.equal(typeof none, 'string', `${t.id}/${ch.id}: live() without providers must not throw`);
        assert.ok(none.length <= DETAIL_MAX);
      }
      assert.ok(ch.detail || ch.live, `${t.id}/${ch.id}: has a detail line (static or live)`);
    }
  }
});

test('chapter run / arrived / end / cues execute against the mock context without throwing', () => {
  for (const t of TOURS) {
    for (const ch of t.chapters) {
      const ctx = mockCtx();
      if (typeof ch.jdUtc === 'function') ch.jdUtc(ctx);
      if (ch.run) ch.run(ctx);
      if (ch.arrived) ch.arrived(ctx);
      for (const cue of ch.cues ?? []) { assert.ok(cue.t >= 0 && cue.t < ch.seconds, `${t.id}/${ch.id}: cue at ${cue.t} s inside the dwell`); cue.run(ctx); }
      if (ch.end) ch.end(ctx);
      if (ch.hold === 'arrived') assert.ok(ctx.calls.some((c) => c[0] === 'flyTo'), `${t.id}/${ch.id}: an arrival hold launches a flight`);
      if (ch.hold === 'skyReady') assert.ok(ctx.calls.some((c) => c[0] === 'skyView'), `${t.id}/${ch.id}: a skyReady hold enters a sky view`);
      if (ch.hold === 'poseDone') assert.ok(ctx.calls.some((c) => c[0] === 'frameBodies' || c[0] === 'resetHome'), `${t.id}/${ch.id}: a poseDone hold frames or homes`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Provenance: the VERIFIED table against test/fixtures/events.json
// ---------------------------------------------------------------------------------------------------------------------

const sameBodies = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

for (const [key, v] of Object.entries(VERIFIED)) {
  test(`VERIFIED.${key} (${v.kind} ${v.bodies.join('+')} ${v.utc}) matches its fixture row within tolerance`, () => {
    assert.ok(v.source, 'every instant cites a source');
    assert.equal(v.jdUtc, jdOfIso(v.utc), 'jdUtc derives from the utc string');
    const rows = FIX.geometric.filter((r) => r.kind === v.kind && !r.excluded && (v.dateOnly ? true : sameBodies(r.bodies ?? [], v.bodies)));
    assert.ok(rows.length, `a geometric fixture row exists for ${v.kind} ${v.bodies.join('+')}`);
    if (v.dateOnly) {
      const date = v.utc.slice(0, 10);
      const row = rows.find((r) => r.date === date) ?? rows[0];
      const dDays = Math.abs(jdOfIso(date) - jdOfIso(row.date));
      const tol = row.tolDays ?? 1;
      assert.ok(dDays <= tol, `${key}: date ${date} within ±${tol} d of fixture ${row.date} (Δ = ${dDays} d)`);
    } else {
      let best = null, bestMin = Infinity;
      for (const r of rows) {
        const dMin = Math.abs(v.jdUtc - jdOfIso(r.utc)) * MIN_PER_DAY;
        if (dMin < bestMin) { bestMin = dMin; best = r; }
      }
      assert.ok(bestMin <= best.tolMin, `${key}: ${v.utc} within ±${best.tolMin} min of fixture ${best.utc} (Δ = ${bestMin.toFixed(2)} min; fixture basis ${best.basis})`);
    }
  });
}

test('every fixed chapter instant comes from VERIFIED or EPOCHS (no hand-typed dates); "now" chapters use a function', () => {
  const known = new Set([...Object.values(VERIFIED).map((v) => v.jdUtc), ...Object.values(EPOCHS).map((e) => e.jdUtc)]);
  let fixed = 0;
  for (const t of TOURS) {
    for (const ch of t.chapters) {
      if (typeof ch.jdUtc === 'number') { fixed += 1; assert.ok(known.has(ch.jdUtc), `${t.id}/${ch.id}: jdUtc ${ch.jdUtc} is a table entry`); }
      else if (ch.jdUtc !== undefined) assert.equal(typeof ch.jdUtc, 'function', `${t.id}/${ch.id}: jdUtc is a number or a function`);
    }
  }
  assert.ok(fixed >= 7, `at least the six alignment moments plus the Welcome ones are fixed (got ${fixed})`);
  const saturn = tourById('planets').chapters.find((c) => c.id === 'saturn');
  const ctx = mockCtx(); // B′ = −8.19° in the mock → below RING_OPEN_MIN_DEG → jumps to the open-ring epoch
  assert.equal(saturn.jdUtc(ctx), EPOCHS.saturnRingsOpen2017.jdUtc, 'Planets/Saturn jumps to the open-ring epoch when the rings are nearly edge-on');
  assert.equal(ctx.memo.saturnJumped, true);
  const open = mockCtx(); open.bodyInfo = () => ({ subSolarLatDeg: 25 });
  assert.equal(saturn.jdUtc(open), undefined, 'and stays at the current date when |B′| ≥ RING_OPEN_MIN_DEG');
  assert.equal(open.memo.saturnJumped, false);
  assert.ok(RING_OPEN_MIN_DEG >= 10 && RING_OPEN_MIN_DEG <= 20, 'threshold between "clearly open" and "edge-on"');
});

// ---------------------------------------------------------------------------------------------------------------------
// Claims checked against the app's own model (VSOP87 + IAU 2015 orientation)
// ---------------------------------------------------------------------------------------------------------------------
const eph = createEphemeris(SERIES, { meta: META });
const sub = { latDeg: 0, lonDeg: 0 };
/** Saturnicentric latitude of the Sun (ring tilt toward the Sun, degrees) at a JD(UTC). */
function saturnB(jdUtc) {
  const jdTT = ttFromUtc(jdUtc);
  const S = eph.states(jdTT);
  subSolarPoint('saturn', S.saturn, jdTT, jdUtc, sub);
  return sub.latDeg;
}
/** Geocentric separation (degrees) of two bodies at a JD(UTC). */
function sepDeg(jdUtc, a, b) {
  const S = eph.states(ttFromUtc(jdUtc));
  const e = S.earth;
  return angleBetween([S[a].x - e.x, S[a].y - e.y, S[a].z - e.z], [S[b].x - e.x, S[b].y - e.y, S[b].z - e.z]) * RAD;
}

test('EPOCHS.saturnRingsOpen2017: the rings really are open then, and were still open at the Great Conjunction epoch', () => {
  const e = EPOCHS.saturnRingsOpen2017;
  assert.ok(e.why, 'the epoch states why it was chosen');
  const b2017 = saturnB(e.jdUtc);
  assert.ok(Math.abs(b2017) >= e.expect.minAbsSubSolarLatDeg, `|B′| = ${Math.abs(b2017).toFixed(2)}° ≥ ${e.expect.minAbsSubSolarLatDeg}° on ${e.utc} (Saturn's obliquity 26.73° is the maximum)`);
  const bGC = saturnB(VERIFIED.greatConjunction2020.jdUtc);
  assert.ok(Math.abs(bGC) >= RING_OPEN_MIN_DEG, `Welcome/Saturn plays at the Great Conjunction epoch: |B′| = ${Math.abs(bGC).toFixed(2)}° ≥ ${RING_OPEN_MIN_DEG}° there`);
  const bCrossing = saturnB(jdFromCalendar(2025, 5, 6));
  assert.ok(Math.abs(bCrossing) < 1, `ring-plane crossing 2025-05-06: |B′| = ${Math.abs(bCrossing).toFixed(2)}° < 1° (why today's rings look edge-on)`);
});

test('sky-view captions are true in the model: 6′ great conjunction, Venus on the solar disc, Venus–Jupiter < 1°', () => {
  const gc = sepDeg(VERIFIED.greatConjunction2020.jdUtc, 'jupiter', 'saturn') * 60;
  assert.ok(Math.abs(gc - 6.1) <= 0.3, `Jupiter–Saturn ${gc.toFixed(2)}′ ≈ 6.1′ ± 0.3′ (fixture expect)`);
  assert.ok(gc / 31 <= 0.25, `"a fifth of a Moon-width": ${gc.toFixed(1)}′ / 31′ (mean lunar diameter) = ${(gc / 31).toFixed(2)}`);
  const vs = sepDeg(VERIFIED.venusTransit2012.jdUtc, 'venus', 'sun') * 60;
  assert.ok(vs < 15.8, `Venus ${vs.toFixed(2)}′ from the Sun's centre < 15.8′ solar radius: on the disc at the transit instant`);
  const vj = sepDeg(VERIFIED.venusJupiter2025.jdUtc, 'venus', 'jupiter') * 60;
  assert.ok(Math.abs(vj - 51.6) <= 0.5 && vj < 60, `Venus–Jupiter ${vj.toFixed(2)}′ ≈ 51.6′ ± 0.5′ (fixture expect), "less than a degree"`);
});

test('Mars 2003 caption: 55.76 million km in the model; Proxima ratio "about 9 000×" Neptune', () => {
  const S = eph.states(ttFromUtc(VERIFIED.marsClosest2003.jdUtc));
  const km = Math.hypot(S.mars.x - S.earth.x, S.mars.y - S.earth.y, S.mars.z - S.earth.z) * AU_KM;
  assert.ok(Math.abs(km - 55758006) <= 2000, `Earth–Mars ${km.toFixed(0)} km within 2 000 km of 55 758 006 km (seds / Horizons; VSOP87 vs DE441 residual)`);
  const rNep = Math.hypot(S.neptune.x, S.neptune.y, S.neptune.z);
  const ratio = PROXIMA_AU / rNep;
  assert.ok(ratio > 8500 && ratio < 9500, `PROXIMA_AU / r(Neptune) = ${ratio.toFixed(0)} ≈ 9 000 (Gaia DR3 parallax 768.07 mas → 268 553 AU)`);
});

test('overview chapters request 50× sizes and say so; sky-view chapters request true scale', () => {
  const welcome = tourById('welcome');
  const title = welcome.chapters[0];
  assert.equal(title.settings.sizeK, OVERVIEW_SIZE_K);
  assert.match(title.detail, /50×/, 'the Welcome title card tells the viewer planets are drawn 50× larger');
  for (const t of TOURS) {
    for (const ch of t.chapters) {
      const ctx = mockCtx();
      ch.run?.(ctx);
      if (ctx.calls.some((c) => c[0] === 'skyView')) {
        assert.equal(ch.settings?.sizeK, 1, `${t.id}/${ch.id}: a sky view needs true angular sizes (sizeK 1)`);
      }
    }
  }
  const gc = tourById('alignments').chapters.find((c) => c.id === 'great-conjunction');
  const ctx = mockCtx(); gc.run(ctx); gc.cues[0].run(ctx);
  const sky = ctx.calls.find((c) => c[0] === 'skyView');
  assert.deepEqual(sky[2], ['jupiter', 'saturn']);
  assert.ok(sky[3].fovDeg <= 1.2, 'enters at ≤ 1.2°');
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'setSkyFov').slice(1, 2), [0.3], 'then eases to the 0.3° telescope view');
  const parade = tourById('alignments').chapters.find((c) => c.id === 'parade');
  const p = mockCtx(); parade.run(p);
  const ps = p.calls.find((c) => c[0] === 'skyView');
  assert.deepEqual(ps[2], ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'], 'all seven other planets');
  assert.ok(ps[3].fovDeg >= 80 && ps[3].fovDeg <= 100, 'wide sky view');
  const transit = tourById('alignments').chapters.find((c) => c.id === 'venus-transit');
  const tr = mockCtx(); transit.run(tr);
  const ts = tr.calls.find((c) => c[0] === 'skyView');
  assert.ok(ts[2].includes('sun') && ts[2].includes('venus') && ts[3].fovDeg <= 1.0, 'transit: toward the Sun with Venus, fov ≤ 1°');
});

test('the Planets tour visits Sun → Neptune in order, and the Earth chapters switch the axis overlay on', () => {
  const ids = tourById('planets').chapters.filter((c) => c.hold === 'arrived').map((c) => c.id);
  assert.deepEqual(ids, ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
  for (const t of TOURS) {
    for (const ch of t.chapters) {
      if (ch.id === 'earth') assert.equal(ch.settings?.showOrientationDebug, true, `${t.id}/earth draws the tilted axis it talks about`);
    }
  }
});

test('finales return the clock to now at one day per second from the home view', () => {
  for (const t of TOURS) {
    const fin = t.chapters[t.chapters.length - 1];
    const ctx = mockCtx();
    assert.equal(fin.jdUtc(ctx), ctx.nowJd(), `${t.id}: finale jdUtc = now`);
    assert.equal(fin.rate, 1, `${t.id}: finale rate 1 d/s`);
    assert.equal(fin.paused, false);
    fin.run(ctx);
    assert.ok(ctx.calls.some((c) => c[0] === 'resetHome'), `${t.id}: finale goes home`);
  }
  const year = tourById('welcome').chapters.find((c) => c.id === 'year');
  const ctx = mockCtx();
  assert.ok(Math.abs(year.jdUtc(ctx) - (ctx.nowJd() - 7 * 365.25)) < 1e-9, 'the year-per-second chapter starts chapterSeconds years early so it lands on now');
});
