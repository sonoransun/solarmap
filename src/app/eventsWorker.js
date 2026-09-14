// Browser Worker adapter around the pure events engine. The ephemeris series is injected by the main thread
// (postMessage) so the ~1.2 MB data module is never bundled twice. Requests carry an id; results for
// superseded requests (a newer scan for the same slot) are dropped by the client.
import { createEphemeris } from '../astro/ephemeris.js';
import { findEvents } from '../astro/events.js';

let eph = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'init') {
    eph = createEphemeris(msg.series);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'scan') {
    if (!eph) { self.postMessage({ type: 'error', id: msg.id, error: 'not initialised' }); return; }
    try {
      const t0 = performance.now();
      const events = findEvents(eph, msg.jd0, msg.jd1, msg.opts || {});
      self.postMessage({ type: 'result', id: msg.id, year: msg.year, events, ms: performance.now() - t0 });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, year: msg.year, error: String(err && err.stack || err) });
    }
  }
};
