// Intro tour: the default first-load experience. A scripted sequence that flies through the solar system,
// visits well-known alignments and shows what the time controls do. Every step is driven from the frame loop
// (no timers), so it stays in sync with rendering and can be cancelled instantly by any user input.
//
// The dates are the verified geometric instants from test/fixtures/events.json (see the plan's verification table):
// they are real events, not decoration.

/**
 * @typedef {object} IntroStep
 * @property {string} [caption]        toast text shown when the step starts
 * @property {number} seconds          how long the step lasts (real seconds)
 * @property {number} [jdUtc]          jump the clock here first
 * @property {number} [rate]           set the sim rate (days per real second)
 * @property {boolean} [paused]        pause (true) or play (false) the clock
 * @property {(ctx: any) => void} [run] camera / scene action performed once at the start of the step
 */

/** Julian Date (UTC) from a calendar instant, proleptic Gregorian (same formula as astro/clock.js). */
function jd(year, month, day, hour = 0, minute = 0) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100)
    + Math.floor(y / 400) - 32045;
  return jdn - 0.5 + (hour + minute / 60) / 24;
}

/** Well-known instants used by the tour (UTC), all verified against JPL Horizons in the test fixtures. */
export const HIGHLIGHTS = Object.freeze({
  marsOpposition2025: jd(2025, 1, 16, 2, 31),
  greatConjunction2020: jd(2020, 12, 21, 18, 11),
  venusJupiter2025: jd(2025, 8, 12, 6, 37),
  parade2024: jd(2024, 11, 23, 0, 0),
  marsClosest2003: jd(2003, 8, 27, 9, 51),
});

/**
 * @param {object} deps
 * @param {{get: () => any, set: (p: any) => void}} deps.store
 * @param {{ setJd: (jd:number)=>any, setRate:(r:number)=>void, play:()=>void, pause:()=>void, jd:()=>number, rate:()=>number, playing:()=>boolean }} deps.clock
 * @param {any} deps.rig            camera rig (may be null until the scene is ready)
 * @param {{ toast: (msg:string, opts?:any) => void }} deps.ui
 * @param {() => void} deps.sync    push the clock state into the store
 * @param {() => boolean} deps.isReducedMotion
 * @param {() => number} deps.nowJd
 * @param {() => void} [deps.highlight]  mark the nearest notable event so its overlay is drawn
 */
export function createIntro({ store, clock, rig, ui, sync, isReducedMotion, nowJd, highlight = null }) {
  /** @type {IntroStep[]} */
  let steps = [];
  let index = -1;
  let elapsed = 0;
  let running = false;
  let onEnd = null;

  const ctx = { rig: () => rig, store };

  function build() {
    const now = nowJd();
    return /** @type {IntroStep[]} */ ([
      {
        caption: 'Solar Map — the real solar system, computed live',
        seconds: 5.5,
        jdUtc: now,
        rate: 1,
        paused: false,
        run: () => rig?.resetHome(),
      },
      {
        caption: 'One month per second — watch Mercury and Venus race ahead',
        seconds: 7,
        rate: 30.436875,
      },
      {
        caption: 'Earth — 23.9 h of rotation, tilted 23.44°',
        seconds: 9,
        rate: 1 / 24,
        run: () => rig?.flyTo('earth'),
      },
      {
        caption: 'Mars at opposition, 16 January 2025: Sun, Earth and Mars in line',
        seconds: 9,
        jdUtc: HIGHLIGHTS.marsOpposition2025,
        rate: 1 / 24,
        paused: true,
        run: () => { rig?.frameTopDown({ center: [0, 0, 0], radius: 2.2, seconds: 2.5 }); highlight?.(); },
      },
      {
        caption: 'The Great Conjunction of 2020 — Jupiter and Saturn 6 arcminutes apart, seen from Earth',
        seconds: 9,
        jdUtc: HIGHLIGHTS.greatConjunction2020,
        paused: true,
        run: () => { rig?.skyView('earth', ['jupiter', 'saturn']); highlight?.(); },
      },
      {
        caption: 'Saturn — rings tilted 26.7°, shadowed by the planet',
        seconds: 10,
        jdUtc: now,
        rate: 1 / 24,
        paused: false,
        run: () => rig?.flyTo('saturn'),
      },
      {
        caption: 'Faster than light: Saturn to Neptune in seconds',
        seconds: 9,
        run: () => rig?.flyTo('neptune'),
      },
      {
        caption: 'One year per second — the whole system in motion',
        seconds: 8,
        rate: 365.25,
        run: () => rig?.resetHome(),
      },
      {
        caption: 'Your turn: drag to orbit, pick a planet, or open Events for the next alignment',
        seconds: 3,
        jdUtc: now,
        rate: 1,
      },
    ]);
  }

  function applyStep(step) {
    if (step.jdUtc !== undefined) clock.setJd(step.jdUtc);
    if (step.rate !== undefined) clock.setRate(step.rate);
    if (step.paused === true) clock.pause();
    else if (step.paused === false) clock.play();
    sync();
    if (step.caption) ui.toast(step.caption, { key: 'intro', now: true, ms: Math.max(2500, step.seconds * 1000 - 800) });
    step.run?.(ctx);
  }

  return {
    /** @param {any} [newRig] rebind the camera rig (it is created after the data module loads) */
    setRig(newRig) { rig = newRig; },
    running: () => running,
    /** @param {() => void} [done] */
    start(done) {
      if (isReducedMotion()) { done?.(); return false; }
      steps = build();
      index = -1;
      elapsed = 0;
      running = true;
      onEnd = done ?? null;
      store.set({ intro: true });
      return true;
    },
    /** Cancel the tour, leaving the camera and clock where they are. */
    stop(silent = false) {
      if (!running) return;
      running = false;
      index = -1;
      store.set({ intro: false });
      if (!silent) ui.toast('Tour stopped', { key: 'intro', ms: 2000 });
      onEnd?.();
      onEnd = null;
    },
    /** Advance the script. @param {number} dt real seconds */
    update(dt) {
      if (!running) return;
      elapsed += dt;
      if (index < 0 || elapsed >= steps[index].seconds) {
        elapsed = index < 0 ? 0 : elapsed - steps[index].seconds;
        index += 1;
        if (index >= steps.length) {
          running = false;
          store.set({ intro: false });
          onEnd?.();
          onEnd = null;
          return;
        }
        applyStep(steps[index]);
      }
    },
    progress() {
      if (!running || index < 0) return 0;
      return (index + Math.min(1, elapsed / steps[index].seconds)) / steps.length;
    },
  };
}
