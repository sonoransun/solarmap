// Story UI: the lower-third caption bar (#story), the centred title card and the "Tours" popover (#tours).
// Plain DOM; it renders whatever src/app/story.js publishes under store.story and never touches physics — every
// button goes through `actions` (playTour, stopTour, toggleTour, nextChapter, prevChapter, setSettings).
// Captions are announced once per chapter through a polite live region; they never use the toast queue.
import { h, svg, setText, setAttr, trapFocusIn } from './dom.js';
import { formatTourDuration } from '../app/story.js';

const ICONS = {
  prev: '<path d="M6 5v14"/><path d="M19 6l-10 6 10 6z"/>',
  next: '<path d="M18 5v14"/><path d="M5 6l10 6-10 6z"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

/** Text of the detail line while the story is paused (the bar's own state, not a toast). */
export const PAUSED_TEXT = 'Paused — press Space or ▶ to continue';

/**
 * @param {object} opts
 * @param {HTMLElement} [opts.root]  document.body; the bar is appended to #app when present (so CSS can see #panel)
 * @param {ReturnType<import('../app/state.js').createStore>} opts.store
 * @param {object} opts.actions      playTour(id), stopTour(), toggleTour(), nextChapter(), prevChapter(), setSettings(patch)
 * @param {() => object|null} [opts.getProviders]  providers.tours?() may list the tours when listTours is absent
 * @param {() => { id: string, title: string, tagline: string, durationS: number }[]} [opts.listTours]
 * @returns {{
 *   el: HTMLElement, card: HTMLElement, popover: HTMLElement,
 *   open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean,
 *   update: (s: import('../app/state.js').AppState) => void, dispose: () => void,
 * }}
 */
export function createStoryUI({ root = document.body, store, actions, getProviders = () => null, listTours = null }) {
  const host = /** @type {HTMLElement} */ (root.querySelector('#app') ?? root);
  const body = root.ownerDocument?.body ?? document.body;

  // ---- lower third -------------------------------------------------------------------------------------------------
  const elTour = h('span', { class: 'story-tour' });
  const elChapter = h('span', { class: 'story-chapter' });
  const elCount = h('span', { class: 'story-count' });
  const elCaption = h('p', { class: 'story-cap' });
  const elDetail = h('p', { class: 'story-detail' });
  const elSegs = h('div', { class: 'story-segs', role: 'progressbar', 'aria-label': 'Tour progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });

  const ctl = (icon, attrs) => h('button', { class: 'icon-btn story-btn', type: 'button', ...attrs }, svg(ICONS[icon]));
  const btnPrev = ctl('prev', { 'aria-label': 'Previous chapter', title: 'Previous chapter (←)', 'aria-keyshortcuts': 'ArrowLeft', onclick: () => actions.prevChapter?.() });
  const btnPlay = ctl('pause', { 'aria-label': 'Pause the tour', title: 'Pause (Space)', 'aria-keyshortcuts': 'Space', onclick: () => actions.toggleTour?.() });
  const btnNext = ctl('next', { 'aria-label': 'Next chapter', title: 'Next chapter (→)', 'aria-keyshortcuts': 'ArrowRight', onclick: () => actions.nextChapter?.() });
  const btnStop = ctl('close', { 'aria-label': 'Leave the tour', title: 'Leave the tour (Esc)', 'aria-keyshortcuts': 'Escape', onclick: () => actions.stopTour?.() });
  const hint = h('span', { class: 'story-hint', 'aria-hidden': 'true' }, h('kbd', { text: 'Space' }), ' pause ', h('kbd', { text: '←' }), h('kbd', { text: '→' }), ' chapters ', h('kbd', { text: 'Esc' }), ' leave');

  const el = h('section', { id: 'story', class: 'story', role: 'region', 'aria-label': 'Guided tour', hidden: true },
    h('div', { class: 'story-head' }, elTour, elChapter, elCount),
    elCaption,
    elDetail,
    h('div', { class: 'story-foot' }, elSegs, hint, h('div', { class: 'story-ctl', role: 'group', 'aria-label': 'Tour controls' }, btnPrev, btnPlay, btnNext, btnStop)),
    live,
  );

  // ---- title card --------------------------------------------------------------------------------------------------
  const cardTitle = h('div', { class: 'story-card-title' });
  const cardTag = h('div', { class: 'story-card-tag' });
  const card = h('div', { class: 'story-card', 'aria-hidden': 'true' }, cardTitle, cardTag);

  // ---- Tours popover -----------------------------------------------------------------------------------------------
  const list = h('div', { class: 'story-list', role: 'list' });
  const swLoad = h('button', {
    class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'true', id: 'sw-introOnLoad',
    onclick: () => actions.setSettings?.({ introOnLoad: !(store.get().settings?.introOnLoad !== false) }),
  });
  const btnPopClose = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close tours', title: 'Close (Esc)', onclick: () => close() }, svg(ICONS.close));
  const popover = h('div', { class: 'popover glass story-pop', id: 'tours', role: 'dialog', 'aria-label': 'Tours', tabindex: '-1' },
    h('div', { class: 'popover-head' }, h('h2', { text: 'Tours' }), btnPopClose),
    h('p', { class: 'story-pop-intro', text: 'Short guided journeys. You can pause, skip or leave at any time.' }),
    list,
    h('div', { class: 'field' }, h('label', { for: 'sw-introOnLoad' }, 'Guided tour on load', h('small', { text: 'Play the Welcome tour when the page opens' })), swLoad),
  );
  popover.hidden = true;

  host.append(el, card);
  root.append(popover);

  // ---- state ---------------------------------------------------------------------------------------------------------
  let visible = false;
  let tourId = null;
  let lastSeq = -1;
  let segCount = -1;
  /** @type {HTMLElement[]} */
  let segBars = [];
  let segEls = [];
  let playIcon = 'pause';
  let openState = false;
  let lastFocus = null;
  let activeId = null;

  function tours() {
    try {
      const t = listTours ? listTours() : getProviders()?.tours?.();
      return Array.isArray(t) ? t : [];
    } catch { return []; }
  }

  function buildList() {
    const rows = tours().map((t) => h('button', {
      class: 'story-row', type: 'button', role: 'listitem', dataset: { tour: t.id },
      'aria-label': `${t.title}: ${t.tagline}. ${formatTourDuration(t.durationS)}`,
      onclick: () => { close(); actions.playTour?.(t.id); },
    },
    h('span', { class: 'story-row-main' }, h('span', { class: 'story-row-title', text: t.title }), h('span', { class: 'story-row-tag', text: t.tagline })),
    h('span', { class: 'story-row-dur', text: formatTourDuration(t.durationS) })));
    if (!rows.length) rows.push(h('p', { class: 'empty', text: 'Tours appear once the planets have loaded.' }));
    list.replaceChildren(...rows);
    markActive();
  }

  function markActive() {
    for (const b of list.querySelectorAll('.story-row')) setAttr(b, 'aria-current', b.dataset.tour === activeId ? 'true' : null);
  }

  function buildSegments(n) {
    segCount = n;
    segBars = []; segEls = [];
    const kids = [];
    for (let i = 0; i < n; i++) {
      const bar = h('i');
      const seg = h('span', { class: 'story-seg' }, bar);
      segBars.push(bar); segEls.push(seg); kids.push(seg);
    }
    elSegs.replaceChildren(...kids);
  }

  function show() {
    visible = true;
    el.hidden = false;
    body.classList.add('has-story');
  }
  function hide() {
    visible = false;
    el.hidden = true;
    card.classList.remove('is-visible');
    body.classList.remove('has-story');
    tourId = null; activeId = null; lastSeq = -1;
    markActive();
  }

  /** @param {import('../app/state.js').AppState} s */
  function update(s) {
    const st = s.story;
    setAttr(swLoad, 'aria-checked', s.settings?.introOnLoad !== false ? 'true' : 'false');
    if (!st) { if (visible) hide(); return; }
    if (!visible) show();
    if (st.tourId !== tourId) {
      tourId = st.tourId; activeId = st.tourId;
      if (openState) markActive();
    }
    setText(cardTitle, st.title || st.tourTitle || '');
    setText(cardTag, st.tagline || '');
    setText(elTour, st.tourTitle || '');
    setText(elChapter, st.title || '');
    setText(elCount, `${st.index + 1} / ${st.count}`);
    setText(elCaption, st.caption || st.title || '');

    const paused = st.status === 'paused';
    setText(elDetail, paused ? PAUSED_TEXT : (st.detail || ''));
    elDetail.classList.toggle('is-paused', paused);
    el.classList.toggle('is-paused', paused);
    el.classList.toggle('is-holding', !!st.holding);
    const wantIcon = paused ? 'play' : 'pause';
    if (wantIcon !== playIcon) {
      playIcon = wantIcon;
      btnPlay.replaceChildren(svg(ICONS[wantIcon]));
      setAttr(btnPlay, 'aria-label', paused ? 'Resume the tour' : 'Pause the tour');
      setAttr(btnPlay, 'title', paused ? 'Resume (Space)' : 'Pause (Space)');
    }
    btnPrev.disabled = false;
    btnNext.disabled = false;

    if (st.count !== segCount) buildSegments(st.count);
    for (let i = 0; i < segCount; i++) {
      const done = i < st.index;
      segEls[i].classList.toggle('is-done', done);
      segEls[i].classList.toggle('is-current', i === st.index);
      const w = done ? '100%' : i === st.index ? `${Math.round(Math.max(0, Math.min(1, st.chapterProgress)) * 100)}%` : '0%';
      if (segBars[i].style.width !== w) segBars[i].style.width = w;
    }
    setAttr(elSegs, 'aria-valuenow', String(Math.round(Math.max(0, Math.min(1, st.progress)) * 100)));
    setAttr(elSegs, 'aria-valuetext', `Chapter ${st.index + 1} of ${st.count}`);

    card.classList.toggle('is-visible', !!st.card);

    if (st.seq !== lastSeq) {
      lastSeq = st.seq;
      setText(live, `${st.tourTitle}, chapter ${st.index + 1} of ${st.count}: ${st.caption || st.title || ''}`);
    }
  }

  // ---- popover open / close --------------------------------------------------------------------------------------------
  const onDocPointer = (e) => {
    if (!openState) return;
    const t = /** @type {Node} */ (e.target);
    if (popover.contains(t)) return;
    if (t instanceof Element && t.closest('[data-tours-toggle]')) return;
    close();
  };
  const onKey = (e) => {
    if (!openState) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (e.key === 'Tab') trapFocusIn(popover, e);
  };

  function open() {
    if (openState) return;
    openState = true;
    buildList();
    popover.hidden = false;
    lastFocus = document.activeElement;
    document.addEventListener('pointerdown', onDocPointer, true);
    popover.addEventListener('keydown', onKey);
    const first = /** @type {HTMLElement|null} */ (popover.querySelector('.story-row'));
    (first ?? popover).focus({ preventScroll: true });
  }
  function close() {
    if (!openState) return;
    openState = false;
    popover.hidden = true;
    document.removeEventListener('pointerdown', onDocPointer, true);
    popover.removeEventListener('keydown', onKey);
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }

  const unsubscribe = store.subscribe((s, changed) => {
    if (changed.has('story') || changed.has('settings')) update(s);
  });
  update(store.get());

  return {
    el,
    card,
    popover,
    open,
    close,
    toggle() { if (openState) close(); else open(); },
    isOpen: () => openState,
    update,
    dispose() {
      unsubscribe();
      close();
      hide();
      el.remove(); card.remove(); popover.remove();
    },
  };
}
