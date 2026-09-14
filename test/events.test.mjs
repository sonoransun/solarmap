// events.js — plan §Verification rows "events (geometric, times UTC)" and "events (almanac sanity, apparent)".
// Reference values live in test/fixtures/events.json (hand-entered from the alignment-events research bq2vila6z.txt
// §C with a source URL and a basis per row) and test/fixtures/horizons/mars-stationary-2024.json (Horizons OBSERVER
// run). Geometric tolerances: crossings ±3 min; closest approaches / apsides ±5 min; greatest-elongation times ±3 h;
// angles ±0.01°; separations ±0.5′ (Jupiter–Saturn ±0.3′); distances ±200 km / ±1e-5 AU (Uranus 1e-4, Neptune 3e-4);
// parade dates ±1 d, arcs ±0.5°. Almanac sanity: ±100 min (Neptune ±150 min; Venus superior +60 min), angles ±0.1°,
// distances ±1e-5 AU. Every widened tolerance is stated in the fixture row's note and in the assertion message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERIES, META } from '../src/astro/data/vsop87a.js';
import { createEphemeris, PLANETS } from '../src/astro/ephemeris.js';
import { jdFromCalendar, ttFromUtc, utcFromTt, deltaTSeconds, calendarFromJd } from '../src/astro/time.js';
import { DAY_S } from '../src/astro/constants.js';
import {
  findEvents, notabilityScore, labelFor, eventKey, KINDS, EXPERIMENTAL_KINDS, MERGE_WINDOWS_D, PARADE_THRESHOLDS_DEG,
  SCAN_OVERLAP_D, GEO_PARADE_MIN_N,
} from '../src/astro/events.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'));
const MARS_ST = JSON.parse(readFileSync(new URL('./fixtures/horizons/mars-stationary-2024.json', import.meta.url), 'utf8'));
const eph = createEphemeris(SERIES, { meta: META });

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

/** 'YYYY-MM-DD[THH:MM[:SS]]' (UTC) → JD(UTC). */
function jdUtcOf(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  assert.ok(m, `fixture time '${s}' must be YYYY-MM-DD[THH:MM[:SS]]`);
  return jdFromCalendar(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** JD(UTC) → 'YYYY-MM-DD HH:MM:SS' for messages. */
function fmt(jd) {
  const c = calendarFromJd(jd);
  const p = (n) => String(n).padStart(2, '0');
  return `${c.year}-${p(c.month)}-${p(c.day)} ${p(c.hour)}:${p(c.minute)}:${p(c.second)}`;
}

/** Windows scanned once and shared by every test (UTC calendar bounds → TT). */
const WINDOWS = [
  { name: '2024–2027', from: [2024, 1, 1], to: [2028, 1, 1] },
  { name: '2003', from: [2003, 6, 1], to: [2003, 12, 1] },
  { name: '2012', from: [2012, 5, 1], to: [2012, 8, 1] },
  { name: '2020', from: [2020, 11, 1], to: [2021, 2, 1] },
];
const scanCache = new Map();
/** @param {{name:string, from:number[], to:number[]}} w @returns {import('../src/astro/events.js').Event[]} */
function scanned(w) {
  let ev = scanCache.get(w.name);
  if (!ev) {
    ev = findEvents(eph, ttFromUtc(jdFromCalendar(...w.from)), ttFromUtc(jdFromCalendar(...w.to)));
    scanCache.set(w.name, ev);
  }
  return ev;
}
/** Events of the window covering a JD(UTC). */
function eventsAround(jdUtc) {
  for (const w of WINDOWS) {
    if (jdUtc >= jdFromCalendar(...w.from) && jdUtc < jdFromCalendar(...w.to)) return scanned(w);
  }
  throw new Error(`no scan window covers ${fmt(jdUtc)}`);
}

/** The event of `kind` with exactly `bodies` nearest to jdUtc (by the event's own instant), or undefined. */
function nearest(events, kind, bodies, jdUtc) {
  const key = bodies.join('+');
  let best, bestD = Infinity;
  for (const e of events) {
    if (e.kind !== kind || e.bodies.join('+') !== key) continue;
    const d = Math.abs(e.jdUtc - jdUtc);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Tolerance key for a value key: fooDeg → tolDeg, fooArcmin → tolArcmin, fooArcsec → tolArcsec, fooAu → tolAu, fooKm → tolKm. */
function tolKeyFor(key) {
  for (const unit of ['Deg', 'Arcmin', 'Arcsec', 'Au', 'Km']) if (key.endsWith(unit)) return 'tol' + unit;
  return null;
}

/** Assert every entry of `expect` against `value` (numbers within the unit tolerance, others equal). */
function checkExpect(expect, value, where) {
  for (const [key, want] of Object.entries(expect)) {
    if (key.startsWith('tol')) continue;
    const tolKey = tolKeyFor(key);
    if (tolKey !== null) {
      const tol = expect[tolKey];
      assert.ok(typeof tol === 'number', `${where}: fixture row needs ${tolKey} for ${key}`);
      assert.ok(Math.abs(value[key] - want) <= tol,
        `${where}: ${key} = ${value[key]} vs ${want} (|Δ| = ${Math.abs(value[key] - want)} > ±${tol}, fixture tolerance)`);
    } else if (Array.isArray(want)) {
      assert.deepEqual(value[key].slice().sort(), want.slice().sort(), `${where}: ${key}`);
    } else {
      assert.equal(value[key], want, `${where}: ${key}`);
    }
  }
}

/** Assert a UTC instant within ±tolMin of the fixture time; message quotes source/basis. */
function checkTime(jdUtc, utcString, tolMin, where) {
  const dMin = (jdUtc - jdUtcOf(utcString)) * 1440;
  assert.ok(Math.abs(dMin) <= tolMin, `${where}: ${fmt(jdUtc)} vs ${utcString} (Δ = ${dMin.toFixed(1)} min > ±${tolMin} min)`);
  return dMin;
}

/** Generic row check shared by the geometric and almanac tables (instant rows only). */
function checkRow(row, where) {
  const anchor = jdUtcOf(row.utc || row.lambdaUtc);
  const ev = nearest(eventsAround(anchor), row.kind, row.bodies, anchor);
  assert.ok(ev, `${where}: no ${row.kind} ${row.bodies.join('–')} event found near ${row.utc || row.lambdaUtc}`);
  let dMin = NaN;
  if (row.utc) dMin = checkTime(ev.jdUtc, row.utc, row.tolMin, where);
  if (row.lambdaUtc) checkTime(ev.value.jdUtcLambda, row.lambdaUtc, row.tolMinLambda, `${where} (λ-conjunction)`);
  if (row.expect) checkExpect(row.expect, ev.value, where);
  if (row.extremum) {
    const x = row.extremum;
    if (x.utc) checkTime(ev.value.jdUtcExtremum, x.utc, x.tolMin, `${where} (ψ extremum; ${x.note || ''})`);
    if (x.elongationDeg !== undefined) {
      assert.ok(Math.abs(ev.value.extremumElongationDeg - x.elongationDeg) <= x.tolDeg,
        `${where}: ψ extremum ${ev.value.extremumElongationDeg} vs ${x.elongationDeg} ±${x.tolDeg}°`);
    }
    if (x.elongationArcsec !== undefined) {
      const arcsec = ev.value.extremumElongationDeg * 3600;
      assert.ok(Math.abs(arcsec - x.elongationArcsec) <= x.tolArcsec,
        `${where}: ψ_min ${arcsec.toFixed(1)}″ vs ${x.elongationArcsec}″ ±${x.tolArcsec}″ (${x.source})`);
    }
  }
  if (row.rejectUtc) {
    const dReject = Math.abs(ev.jdUtc - jdUtcOf(row.rejectUtc)) * 1440;
    assert.ok(dReject >= row.rejectMinMin, `${where}: event ${fmt(ev.jdUtc)} is within ${dReject.toFixed(0)} min of the rejected instant ${row.rejectUtc} (EMB perihelion; Earth must be the geocentre)`);
  }
  if (row.its) checkTime(ev.jdUtc, row.its.utc, row.its.tolMin, `${where} (in-the-sky.org hh:mm, ±${row.its.tolMin} min: ${row.its.note})`);
  return { ev, dMin };
}

const rowName = (row) => `${row.kind} ${row.bodies ? row.bodies.join('–') : ''} ${row.utc || row.lambdaUtc || row.date} [${row.basis}]`;

// ---------------------------------------------------------------------------------------------------------------------
// Geometric fixtures (Horizons VEC_CORR=NONE)
// ---------------------------------------------------------------------------------------------------------------------

for (const row of FIX.geometric) {
  if (row.kind === 'helio-parade' || row.kind === 'stationary' || row.kind === 'geo-parade') continue;
  test(`geometric: ${rowName(row)}`, () => {
    checkRow(row, rowName(row));
  });
}

test('geometric: Venus 2012-06-06 inferior conjunction carries transit=true, score 100 and the transit label', () => {
  const row = FIX.geometric.find((r) => r.kind === 'inferior-conjunction' && r.utc.startsWith('2012'));
  const { ev } = checkRow(row, rowName(row));
  assert.equal(ev.value.transit, true, 'transit flag: ψ_min < asin(R☉/|E|)');
  assert.ok(ev.value.extremumElongationDeg < ev.value.transitLimitDeg, 'ψ_min below the solar semidiameter');
  assert.ok(Math.abs(ev.value.transitLimitDeg - 0.2665) < 0.006, `asin(R☉/|E|) ≈ 0.262–0.271° (final critique), got ${ev.value.transitLimitDeg}`);
  assert.equal(ev.score, 100, 'plan: transit 100');
  assert.match(ev.label, /transit/);
  // Every other inferior conjunction in 2024–2027 is NOT a transit.
  for (const e of scanned(WINDOWS[0])) if (e.kind === 'inferior-conjunction') assert.equal(e.value.transit, false, `${e.label} ${fmt(e.jdUtc)}`);
});

test('geometric: five all-8 heliocentric parades exist (existence, not count) and the k=3/4/5 minima', () => {
  const ev = scanned(WINDOWS[0]);
  for (const row of FIX.geometric) {
    if (row.kind !== 'helio-parade') continue;
    const jdDate = jdUtcOf(row.date);
    let best, bestD = Infinity;
    for (const e of ev) {
      if (e.kind !== 'helio-parade' || e.value.k !== row.k) continue;
      const d = Math.abs(e.jdUtc - jdDate);
      if (d < bestD) { bestD = d; best = e; }
    }
    const where = `helio-parade k=${row.k} ${row.date}`;
    assert.ok(best && bestD <= row.tolDays, `${where}: nearest k=${row.k} minimum is ${best ? fmt(best.jdUtc) : 'none'} (Δ = ${bestD.toFixed(2)} d > ±${row.tolDays} d)`);
    checkExpect(row.expect, best.value, where);
    assert.deepEqual(best.bodies, best.value.members, `${where}: bodies = members`);
    assert.ok(best.value.arcDeg <= best.value.thresholdDeg && best.value.thresholdDeg === PARADE_THRESHOLDS_DEG[row.k], `${where}: below threshold`);
    assert.ok(best.value.entry && best.value.exit && best.value.entry.jdTT < best.jdTT && best.jdTT < best.value.exit.jdTT,
      `${where}: entry < peak < exit`);
    if (row.k === 8) assert.ok(best.score >= 50, `all-8 parade ≥ 50 (tightness-weighted score), got ${best.score}`);
  }
  const all8 = ev.filter((e) => e.kind === 'helio-parade' && e.value.k === 8);
  assert.ok(all8.length >= 5, `at least the five listed all-8 events (found ${all8.length})`);
});

test('geometric: Mars stationary points within ±1 d of the Horizons-derived instants (mars-stationary-2024.json)', () => {
  const ev = scanned(WINDOWS[0]).filter((e) => e.kind === 'stationary' && e.bodies[0] === 'mars');
  assert.equal(MARS_ST.instants.length, 2, 'fixture has two instants');
  for (const inst of MARS_ST.instants) {
    let best, bestD = Infinity;
    for (const e of ev) { const d = Math.abs(e.jdUtc - inst.jdUt); if (d < bestD) { bestD = d; best = e; } }
    assert.ok(best && bestD <= 1, `Mars ${inst.kind} ${inst.iso}: nearest stationary event ${best ? fmt(best.jdUtc) : 'none'} (Δ = ${(bestD * 24).toFixed(1)} h > ±1 d, plan)`);
    assert.equal(best.value.phase, inst.kind, `phase at ${inst.iso}`);
    assert.ok(best.value.elongationDeg > 90, 'Mars is near opposition when stationary');
  }
  assert.ok(EXPERIMENTAL_KINDS.includes('stationary') && ev.every((e) => e.score < 40), 'experimental: hidden below the default filter 40');
});

test('geometric: geocentric parade on 2025-02-28 evening with N ≥ 4', () => {
  const row = FIX.geometric.find((r) => r.kind === 'geo-parade');
  const jd = jdUtcOf(row.date) + 0.5;
  const hits = scanned(WINDOWS[0]).filter((e) => e.kind === 'geo-parade' && e.value.side === row.side &&
    e.value.entry && e.value.exit && e.value.entry.jdUtc <= jd && jd < e.value.exit.jdUtc);
  assert.equal(hits.length, 1, `exactly one evening geo-parade interval contains ${row.date} (${row.source})`);
  const e = hits[0];
  assert.ok(e.value.n >= row.minN, `N = ${e.value.n} ≥ ${row.minN}`);
  assert.ok(e.value.n >= GEO_PARADE_MIN_N && e.value.members.length === e.value.n, 'members at the peak day');
  assert.equal(e.score, 50 + 8 * (e.value.n - 5), 'plan: geo parade 50 + 8·(N − 5)');
  assert.ok(e.value.days >= 1 && e.value.exit.jdTT - e.value.entry.jdTT === e.value.days, 'interval of whole days');
  assert.equal(e.observable, true);
});

test('scoring examples: Jupiter–Saturn 2020 = 100 (clamped), Mars 2025 opposition = 75, Venus–Jupiter 2025-08-12 ≈ 73', () => {
  for (const s of FIX.scores) {
    const jd = jdUtcOf(s.utc);
    const ev = nearest(eventsAround(jd), s.kind, s.bodies, jd);
    assert.ok(ev && Math.abs(ev.jdUtc - jd) < 0.01, `${s.kind} ${s.bodies} ${s.utc} found`);
    assert.ok(Math.abs(ev.score - s.score) <= s.tol, `${s.kind} ${s.bodies}: score ${ev.score} vs ${s.score} ±${s.tol} (${s.note})`);
    assert.equal(ev.score, notabilityScore(ev.kind, ev.bodies, ev.value), 'score = notabilityScore(kind, bodies, value)');
  }
  // Rule spot checks straight from the plan's table.
  assert.equal(notabilityScore('opposition', ['mars'], { distanceAu: 0.55 }), 90, 'Mars opposition 75 + 15 when Δ < 0.6 AU');
  assert.equal(notabilityScore('opposition', ['uranus'], { distanceAu: 18.5 }), 35);
  assert.equal(notabilityScore('inferior-conjunction', ['mercury'], { transit: true }), 100, 'transit 100');
  assert.equal(notabilityScore('helio-parade', [], { k: 4, arcDeg: 30 }), 24 + 50 * 0.25, '6k + 50·(1 − 30/60)²');
  assert.equal(notabilityScore('helio-parade', [], { k: 8, arcDeg: 177 }), 50, 'all-8 parade floor 50');
  assert.equal(notabilityScore('helio-parade', [], { k: 8, arcDeg: 102 }), 48 + 50 * (1 - 102 / 180) ** 2, 'formula above the floor');
  assert.equal(notabilityScore('pair', ['mercury', 'saturn'], { separationDeg: 1, separationArcmin: 60, elongationsDeg: [5, 5] }), 30, '(40 + 20) × 0.5 when an elongation < 15°');
  assert.equal(notabilityScore('closest-approach', ['mars'], { distanceAu: 0.37 }), 70);
  assert.equal(notabilityScore('perihelion', ['earth'], { rAu: 0.983 }), 20);
  assert.equal(notabilityScore('stationary', ['mars'], {}), 35);
  assert.equal(notabilityScore('geo-parade', [], { n: 7 }), 66);
});

// ---------------------------------------------------------------------------------------------------------------------
// Almanac sanity (apparent published values)
// ---------------------------------------------------------------------------------------------------------------------

const almanacDeviations = [];
for (const row of FIX.almanac) {
  const name = `almanac: ${rowName(row)}`;
  if (row.excluded) {
    test(`${name} — recorded, not asserted`, (t) => { t.diagnostic(`excluded: ${row.excluded}`); });
    continue;
  }
  test(name, () => {
    const { dMin } = checkRow(row, name);
    if (Number.isFinite(dMin)) almanacDeviations.push({ row, dMin });
  });
}

test('almanac: measured deviations summary (diagnostic)', (t) => {
  const byKind = new Map();
  for (const { row, dMin } of almanacDeviations) {
    const k = row.kind;
    const cur = byKind.get(k) || { n: 0, max: 0, sum: 0 };
    cur.n++; cur.sum += dMin; cur.max = Math.max(cur.max, Math.abs(dMin));
    byKind.set(k, cur);
  }
  for (const [k, s] of byKind) t.diagnostic(`${k}: n=${s.n} max |Δ| ${s.max.toFixed(1)} min, mean Δ ${(s.sum / s.n).toFixed(1)} min (geometric − almanac)`);
  assert.ok(byKind.size >= 6, 'summary covers every almanac kind');
});

// ---------------------------------------------------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------------------------------------------------

test('hygiene: Event shape, sorted output, sorted bodies, ids = dedupe keys, no duplicate keys over 2024–2027', () => {
  const ev = scanned(WINDOWS[0]);
  assert.ok(ev.length > 300, `a 4-year scan yields hundreds of events (got ${ev.length})`);
  const ids = new Set();
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    assert.deepEqual(Object.keys(e).sort(), ['bodies', 'id', 'jdTT', 'jdUtc', 'kind', 'label', 'observable', 'score', 'value']);
    assert.ok(KINDS.includes(e.kind), e.kind);
    assert.ok(Number.isFinite(e.jdTT) && Number.isFinite(e.jdUtc) && typeof e.label === 'string' && e.label.length > 0);
    assert.ok(e.score >= 0 && e.score <= 100, `score in [0, 100]: ${e.score}`);
    assert.equal(typeof e.observable, 'boolean');
    assert.equal(e.id, eventKey(e.kind, e.bodies, e.jdTT), 'id is the (kind, sorted bodies, minute) key');
    assert.equal(e.label, labelFor(e.kind, e.bodies, e.value));
    const order = e.bodies.map((b) => PLANETS.indexOf(b));
    assert.ok(order.every((o, j) => o >= 0 && (j === 0 || o > order[j - 1])), `bodies sorted Sun-outward: ${e.bodies}`);
    if (i > 0) assert.ok(e.jdTT >= ev[i - 1].jdTT, 'sorted by time');
    assert.ok(!ids.has(e.id), `duplicate key ${e.id}`);
    ids.add(e.id);
  }
  // Same-kind same-bodies events respect the merge windows.
  const lastOf = new Map();
  for (const e of ev) {
    const g = `${e.kind}:${e.bodies.join('+')}`;
    const prev = lastOf.get(g);
    if (prev) assert.ok(e.jdTT - prev.jdTT >= MERGE_WINDOWS_D[e.kind], `${g}: ${fmt(prev.jdUtc)} and ${fmt(e.jdUtc)} closer than the ${MERGE_WINDOWS_D[e.kind]} d merge window`);
    lastOf.set(g, e);
  }
});

test('hygiene: jdUtc − jdTT = −ΔT/86400 for every event (time.utcFromTt)', () => {
  for (const w of WINDOWS) {
    for (const e of scanned(w)) {
      const dtS = (e.jdTT - e.jdUtc) * DAY_S;
      assert.ok(Math.abs(dtS - deltaTSeconds(e.jdUtc)) < 1e-3, `${e.id}: jdTT − jdUtc = ${dtS} s vs ΔT ${deltaTSeconds(e.jdUtc)} s`);
      assert.ok(Math.abs(e.jdUtc - utcFromTt(e.jdTT)) < 1e-9);
      if (e.value.jdUtcLambda !== undefined) assert.ok(Math.abs(e.value.jdUtcLambda - utcFromTt(e.value.jdTTLambda)) < 1e-9);
      if (e.value.jdUtcExtremum !== undefined) assert.ok(Math.abs(e.value.jdUtcExtremum - utcFromTt(e.value.jdTTExtremum)) < 1e-9);
    }
  }
});

test('hygiene: observable flag = every involved body > 10° from the Sun; classes behave as expected', () => {
  const ev = scanned(WINDOWS[0]);
  const byKind = (k) => ev.filter((e) => e.kind === k);
  assert.ok(byKind('opposition').every((e) => e.observable && e.value.elongationDeg > 170), 'oppositions observable, ψ > 170°');
  assert.ok(byKind('conjunction').every((e) => !e.observable && e.value.elongationDeg < 3), 'outer conjunctions ψ < 3°, not observable');
  assert.ok(byKind('inferior-conjunction').every((e) => !e.observable && e.value.elongationDeg < 9), 'inferior conjunctions ψ < 9° (Venus 8.4° in 2025)');
  assert.ok(byKind('superior-conjunction').every((e) => !e.observable && e.value.elongationDeg < 3));
  assert.ok(byKind('greatest-elongation').every((e) => e.observable && (e.value.side === 'E' || e.value.side === 'W')));
  for (const e of byKind('pair')) {
    assert.equal(e.observable, Math.min(...e.value.elongationsDeg) > 10, `pair observable iff both elongations > 10°: ${e.label} ${e.value.elongationsDeg}`);
    assert.ok(e.value.separationArcmin >= 0 && Math.abs(e.value.jdTTLambda - e.jdTT) <= 15, 'λ-conjunction within ±15 d of the minimum separation');
  }
  const ge = byKind('greatest-elongation');
  assert.ok(ge.filter((e) => e.bodies[0] === 'mercury').length >= 24 && ge.filter((e) => e.bodies[0] === 'venus').length >= 4, 'Mercury ≈ 6–7 per year, Venus ≈ 1 per year');
  const mercuryApsides = ev.filter((e) => (e.kind === 'perihelion' || e.kind === 'aphelion') && e.bodies[0] === 'mercury');
  assert.ok(mercuryApsides.length >= 32 && mercuryApsides.every((e, i) => i === 0 || e.kind !== mercuryApsides[i - 1].kind), 'Mercury: alternating perihelia/aphelia every ≈ 44 d (≥ 32 in 4 y)');
  const earthApsides = ev.filter((e) => (e.kind === 'perihelion' || e.kind === 'aphelion') && e.bodies[0] === 'earth');
  assert.equal(earthApsides.length, 8, 'Earth: one perihelion and one aphelion per year');
  assert.ok(byKind('closest-approach').every((e) => e.value.distanceKm > 0 && e.value.lightTimeS > 0));
});

test('hygiene: kinds filter and minScore select subsets of the full scan; bad input throws', () => {
  const jd0 = ttFromUtc(jdFromCalendar(2025, 1, 1)), jd1 = ttFromUtc(jdFromCalendar(2025, 7, 1));
  const full = findEvents(eph, jd0, jd1);
  const opp = findEvents(eph, jd0, jd1, { kinds: ['opposition', 'greatest-elongation'] });
  assert.deepEqual(opp.map((e) => e.id), full.filter((e) => e.kind === 'opposition' || e.kind === 'greatest-elongation').map((e) => e.id));
  const notable = findEvents(eph, jd0, jd1, { minScore: 40 });
  assert.deepEqual(notable.map((e) => e.id), full.filter((e) => e.score >= 40).map((e) => e.id));
  assert.ok(full.every((e) => e.jdTT >= jd0 && e.jdTT < jd1), 'only events inside [jdTT0, jdTT1)');
  assert.throws(() => findEvents(eph, jd1, jd0), RangeError);
  assert.throws(() => findEvents(eph, jd0, jd1, { kinds: ['nope'] }), RangeError);
});

test('hygiene: chunked scans (30-day chunks) equal one scan of 2025, id for id and instant for instant', () => {
  const jd0 = ttFromUtc(jdFromCalendar(2025, 1, 1)), jd1 = ttFromUtc(jdFromCalendar(2026, 1, 1));
  const full = findEvents(eph, jd0, jd1);
  const chunked = [];
  for (let a = jd0; a < jd1; a += 30) chunked.push(...findEvents(eph, a, Math.min(a + 30, jd1)));
  assert.equal(chunked.length, full.length, `chunked ${chunked.length} vs full ${full.length} events`);
  assert.deepEqual(chunked.map((e) => e.id), full.map((e) => e.id), 'same ids in the same order (grid aligned to 0h TT → identical brackets)');
  for (let i = 0; i < full.length; i++) {
    assert.ok(Math.abs(chunked[i].jdTT - full[i].jdTT) < 1e-9, `${full[i].id}: jdTT differs by ${(chunked[i].jdTT - full[i].jdTT) * DAY_S} s`);
    assert.equal(chunked[i].score, full[i].score);
    assert.deepEqual(chunked[i].value, full[i].value, `${full[i].id}: value`);
  }
  assert.ok(SCAN_OVERLAP_D >= Math.max(...Object.values(MERGE_WINDOWS_D)), 'overlap covers every merge window');
});

test('performance guard: one year of scanning with all kinds completes in < 2 s (Node)', (t) => {
  const jd0 = ttFromUtc(jdFromCalendar(2026, 1, 1)), jd1 = ttFromUtc(jdFromCalendar(2027, 1, 1));
  const t0 = performance.now();
  const ev = findEvents(eph, jd0, jd1);
  const ms = performance.now() - t0;
  t.diagnostic(`findEvents 2026, all kinds: ${ev.length} events in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000, `plan: one year scans in < 2 s in Node (measured ${ms.toFixed(0)} ms)`);
});
