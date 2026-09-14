// Right glass panel (≥ 900 px) / bottom sheet (≤ 900 px) with a WAI-ARIA tablist (roving focus, arrow keys).
// The sheet sits above the timeline (critique byf0bzyiw §responsive): peek 96 px, drag handle owning its pointer events.
import { h, setAttr } from './dom.js';

const SHEET_MQ = '(max-width: 900px)';
const PEEK_PX = 96;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el  #panel
 * @param {{ id: string, label: string, el: HTMLElement, hint?: string }[]} opts.tabs  tab panels (already built)
 * @param {(id: string) => void} [opts.onChange]
 * @returns {{
 *   show: (id: string) => void, current: () => string, next: (dir: 1|-1) => void,
 *   open: () => void, peek: () => void, isOpen: () => boolean, setCollapsed: (on: boolean) => void, dispose: () => void,
 * }}
 */
export function createPanel({ el, tabs, onChange }) {
  el.classList.add('glass');
  el.setAttribute('aria-label', 'Details panel');

  let mq = null;
  try { mq = globalThis.matchMedia?.(SHEET_MQ) ?? null; } catch { mq = null; }
  const isSheet = () => !!mq?.matches;

  // Drag handle (bottom sheet only; hidden by CSS on desktop).
  const handle = h('button', { class: 'sheet-handle', type: 'button', 'aria-label': 'Expand panel', 'aria-expanded': 'false', title: 'Drag or tap to expand' });
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Panel sections' });
  const tabButtons = tabs.map((t, i) => h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${t.id}`, 'aria-controls': `tabpanel-${t.id}`,
    'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1', text: t.label, title: t.hint || t.label,
  }));
  tabButtons.forEach((b) => tablist.append(b));

  for (const t of tabs) {
    t.el.classList.add('tabpanel');
    t.el.setAttribute('role', 'tabpanel');
    t.el.id = `tabpanel-${t.id}`;
    t.el.setAttribute('aria-labelledby', `tab-${t.id}`);
    t.el.tabIndex = 0;
  }

  el.replaceChildren(handle, tablist, ...tabs.map((t) => t.el));

  let currentId = tabs[0]?.id ?? '';
  let open = false;

  function show(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    currentId = id;
    tabs.forEach((t, i) => {
      const on = i === idx;
      t.el.hidden = !on;
      setAttr(tabButtons[i], 'aria-selected', on ? 'true' : 'false');
      setAttr(tabButtons[i], 'tabindex', on ? '0' : '-1');
    });
    onChange?.(id);
  }

  tabButtons.forEach((b, i) => {
    b.addEventListener('click', () => {
      show(tabs[i].id);
      if (isSheet() && !open) setOpen(true);
    });
    b.addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j < 0) return;
      e.preventDefault(); e.stopPropagation();
      show(tabs[j].id);
      tabButtons[j].focus();
    });
  });

  // --- bottom sheet
  function setOpen(on) {
    open = on;
    el.classList.toggle('is-open', on);
    setAttr(handle, 'aria-expanded', on ? 'true' : 'false');
    setAttr(handle, 'aria-label', on ? 'Collapse panel' : 'Expand panel');
  }
  handle.addEventListener('click', () => { if (!dragMoved) setOpen(!open); });

  let dragId = -1; let dragStartY = 0; let dragStartOffset = 0; let dragMoved = false; let lastY = 0; let lastT = 0; let vel = 0;
  const closedOffset = () => Math.max(0, el.getBoundingClientRect().height - PEEK_PX);
  handle.addEventListener('pointerdown', (e) => {
    if (!isSheet()) return;
    dragId = e.pointerId; dragStartY = e.clientY; lastY = e.clientY; lastT = e.timeStamp; vel = 0; dragMoved = false;
    dragStartOffset = open ? 0 : closedOffset();
    el.classList.add('is-dragging');
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dy) > 4) dragMoved = true;
    const off = Math.max(0, Math.min(closedOffset(), dragStartOffset + dy));
    el.style.transform = `translateY(${off}px)`;
    const dt = Math.max(1, e.timeStamp - lastT);
    vel = (e.clientY - lastY) / dt; lastY = e.clientY; lastT = e.timeStamp;
  });
  const endDrag = (e) => {
    if (e.pointerId !== dragId) return;
    dragId = -1;
    el.classList.remove('is-dragging');
    el.style.transform = '';
    if (!dragMoved) return; // click handler decides
    const off = Math.max(0, Math.min(closedOffset(), dragStartOffset + (e.clientY - dragStartY)));
    const shouldOpen = vel < -0.3 ? true : vel > 0.3 ? false : off < closedOffset() / 2;
    setOpen(shouldOpen);
    // Suppress the synthetic click that follows the drag.
    setTimeout(() => { dragMoved = false; }, 0);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(false); }
  });

  const onMq = () => { if (!isSheet()) { el.classList.remove('is-open'); el.style.transform = ''; } else setOpen(open); };
  mq?.addEventListener?.('change', onMq);

  show(currentId);

  return {
    show,
    current: () => currentId,
    next(dir) {
      const i = tabs.findIndex((t) => t.id === currentId);
      show(tabs[(i + dir + tabs.length) % tabs.length].id);
    },
    open: () => setOpen(true),
    peek: () => setOpen(false),
    isOpen: () => open,
    setCollapsed(on) { el.classList.toggle('is-collapsed', on); },
    dispose() {
      mq?.removeEventListener?.('change', onMq);
      el.replaceChildren();
    },
  };
}
