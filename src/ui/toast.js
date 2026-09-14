// Toast queue: one message at a time, 4 s each, role="status" aria-live="polite" (critique byf0bzyiw §aria).
import { setText } from './dom.js';

/** Display time of one toast (ms). */
export const TOAST_MS = 4000;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el  the #toast element (role=status, aria-live=polite are (re)asserted here)
 * @returns {{ show: (msg: string, opts?: { kind?: 'info'|'warn'|'success', ms?: number, key?: string, now?: boolean }) => void, clear: () => void, dispose: () => void }}
 */
export function createToast({ el }) {
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  /** @type {{ msg: string, kind: string, ms: number, key: string|undefined }[]} */
  const queue = [];
  let timer = 0;
  let hideTimer = 0;
  let showing = false;
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

  return {
    show(msg, { kind = 'info', ms = TOAST_MS, key, now: immediate = false } = {}) {
      if (!msg) return;
      // `now`: replace whatever is showing (guided-tour captions must track the step they belong to).
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
      const now = Date.now();
      if (key && key === lastKey && now - lastAt < 1500) return;
      lastKey = key; lastAt = now;
      // Collapse duplicates already waiting.
      if (queue.some((q) => q.msg === msg)) return;
      if (queue.length >= 4) queue.shift();
      queue.push({ msg, kind, ms, key });
      if (!showing) next();
    },
    clear() {
      queue.length = 0;
      clearTimeout(timer); clearTimeout(hideTimer);
      showing = false;
      el.classList.remove('is-visible');
    },
    dispose() {
      queue.length = 0;
      clearTimeout(timer); clearTimeout(hideTimer);
      el.classList.remove('is-visible');
    },
  };
}
