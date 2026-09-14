// Main-thread client for the events worker: per-year cache, prefetch window, latest-request-wins scheduling.
// Years are Julian-calendar-agnostic buckets: [Jan 1 00:00 UTC, next Jan 1) in TT (converted by the caller).

/**
 * @param {object} opts
 * @param {Worker} opts.worker
 * @param {ArrayLike<number>|object} opts.series   VSOP87 SERIES object to transfer to the worker
 * @param {(year:number) => number} opts.jdOfYearStartTT   JD(TT) of Jan 1 00:00 UTC for a year
 * @param {(status:{status:string, progress:number}) => void} [opts.onStatus]
 * @param {(year:number, events:object[]) => void} [opts.onYear]
 */
export function createEventsClient({ worker, series, jdOfYearStartTT, onStatus, onYear }) {
  /** @type {Map<number, object[]>} */
  const cache = new Map();
  const pending = new Map(); // year → request id
  const queue = []; // years to scan, priority order
  let nextId = 1;
  let ready = false;
  let inFlight = null; // {id, year}
  let centreYear = null;
  let radius = 2;
  let enabled = true;
  const PAD_DAYS = 40;

  function status() {
    const total = radius * 2 + 1;
    const done = centreYear == null ? 0 : [...cache.keys()].filter((y) => Math.abs(y - centreYear) <= radius).length;
    onStatus?.({ status: !ready ? 'idle' : (inFlight || queue.length) ? 'scanning' : 'ready', progress: total ? done / total : 0 });
  }

  function pump() {
    if (!ready || !enabled || inFlight) return;
    while (queue.length) {
      const year = queue.shift();
      if (cache.has(year)) continue;
      const id = nextId++;
      inFlight = { id, year };
      pending.set(year, id);
      const jd0 = jdOfYearStartTT(year) - PAD_DAYS;
      const jd1 = jdOfYearStartTT(year + 1) + PAD_DAYS;
      worker.postMessage({ type: 'scan', id, year, jd0, jd1, opts: {} });
      status();
      return;
    }
    status();
  }

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') { ready = true; pump(); return; }
    if (msg.type === 'result' || msg.type === 'error') {
      if (inFlight && inFlight.id === msg.id) inFlight = null;
      if (msg.type === 'result' && pending.get(msg.year) === msg.id) {
        const y0 = jdOfYearStartTT(msg.year), y1 = jdOfYearStartTT(msg.year + 1);
        // keep only events whose UTC instant falls inside the year (overlap is for detection only)
        const events = msg.events.filter((ev) => ev.jdTT >= y0 && ev.jdTT < y1);
        cache.set(msg.year, events);
        pending.delete(msg.year);
        onYear?.(msg.year, events);
      } else if (msg.type === 'error') {
        pending.delete(msg.year);
        console.warn('[events] scan failed', msg.year, msg.error);
      }
      pump();
    }
  };

  worker.postMessage({ type: 'init', series });

  return {
    /** Re-centre the prefetch window (latest request wins; queue is rebuilt by distance). */
    setCentre(year, r = 2) {
      centreYear = year; radius = r;
      queue.length = 0;
      const years = [];
      for (let d = 0; d <= r; d++) { years.push(year + d); if (d) years.push(year - d); }
      for (const y of years) if (!cache.has(y) && !(inFlight && inFlight.year === y)) queue.push(y);
      pump();
    },
    /** Suspend scanning (e.g. while the time rate is very high). */
    setEnabled(on) { enabled = on; if (on) pump(); else status(); },
    /** Events in [jdA, jdB) TT from the cache, sorted by time. */
    query(jdA, jdB, { minScore = 0, kinds = null } = {}) {
      const out = [];
      for (const [, list] of cache) {
        for (const ev of list) {
          if (ev.jdTT < jdA || ev.jdTT >= jdB) continue;
          if (ev.score < minScore) continue;
          if (kinds && !kinds.has(ev.kind)) continue;
          out.push(ev);
        }
      }
      out.sort((a, b) => a.jdTT - b.jdTT);
      return out;
    },
    hasYear(year) { return cache.has(year); },
    cachedYears() { return [...cache.keys()].sort((a, b) => a - b); },
    dispose() { worker.terminate(); },
  };
}
