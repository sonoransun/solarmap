// Toast queue: one message at a time, 4 s each, role="status" aria-live="polite" (critique byf0bzyiw §aria).
// `mute(on)` silences non-critical toasts (a running tour draws its own captions; spec-contracts.md §Story): muted
// messages are handed to `onSuppressed` so the UI can still announce them to screen readers through its live region.
import { setText } from './dom.js';

/** Display time of one toast (ms). */
export const TOAST_MS = 4000;

/**
 * @typedef {object} ToastOptions
 * @property {'info'|'warn'|'success'} [kind='info']
 * @property {number} [ms=TOAST_MS]
 * @property {string} [key]        same key within 1.5 s → ignored (rate cap / spin cap re-fire while conditions persist)
 * @property {boolean} [now=false] replace whatever is showing
 * @property {boolean} [critical=false]  shown even while muted (warnings are always critical)
 * @property {boolean} [muted=false]     per-call mute flag from main.js (same effect as mute(true) for this call)
 */

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el  the #toast element (role=status, aria-live=polite are (re)asserted here)
 * @param {(msg: string, opts: ToastOptions) => void} [opts.onSuppressed]  receives messages dropped by the mute
 * @returns {{
 *   show: (msg: string, opts?: ToastOptions) => void, clear: () => void,
 *   mute: (on?: boolean) => void, unmute: () => void, isMuted: () => boolean, dispose: () => void,
 * }}
 */
export function createToast({ el, onSuppressed = null }) {
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  /** @type {{ msg: string, kind: string, ms: number, key: string|undefined }[]} */
  const queue = [];
  let timer = 0;
  let hideTimer = 0;
  let showing = false;
  let muted = false;
  let lastKey;
  let lastAt = 0;

  function next() {
    const item = queue.shift();
    if (!item) { showing = false; return; }
    showing = true;
    setText(el, item.msg);
    el.className = `is-visible ${item.kind}`;
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.remove('is-visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(next, 200);
    }, item.ms);
  }

  function clear() {
    queue.length = 0;
    clearTimeout(timer); clearTimeout(hideTimer);
    showing = false;
    el.classList.remove('is-visible');
  }

  return {
    show(msg, opts = {}) {
      const { kind = 'info', ms = TOAST_MS, key, now: immediate = false, critical = false, muted: mutedCall = false } = opts;
      if (!msg) return;
      if ((muted || mutedCall) && !critical && kind !== 'warn') { onSuppressed?.(msg, opts); return; }
      // `now`: replace whatever is showing (a caption must track the step it belongs to).
      if (immediate) {
        queue.length = 0;
        clearTimeout(timer); clearTimeout(hideTimer);
        lastKey = key; lastAt = Date.now();
        queue.push({ msg, kind, ms, key });
        showing = false;
        next();
        return;
      }
      // Same keyed message within 1.5 s → ignore (rate cap and spin cap can re-fire while conditions persist).
      const t = Date.now();
      if (key && key === lastKey && t - lastAt < 1500) return;
      lastKey = key; lastAt = t;
      // Collapse duplicates already waiting.
      if (queue.some((q) => q.msg === msg)) return;
      if (queue.length >= 4) queue.shift();
      queue.push({ msg, kind, ms, key });
      if (!showing) next();
    },
    clear,
    /** Silence non-critical toasts (tours); muting also clears what is queued so stale messages never surface later. */
    mute(on = true) { muted = !!on; if (muted) clear(); },
    unmute() { muted = false; },
    isMuted: () => muted,
    dispose() {
      clear();
    },
  };
}
