// expand.js — phone wall (the main mobile UI). A minimal expand icon on the nutrition + workout sections
// opens each as a full-screen sheet: heatmap across the top, list below. The WHOLE delegation host is moved
// into the sheet (nutrition taps are delegated on #nutritionlog; workout taps on #workouts) so tapping a day
// and the list's buttons keep working — the point of expanding is to make those EASIER to use, not disable
// them. Elements are moved (and restored on close) so the live render + all handlers stay intact.

import { state } from './shared.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';
import * as surf from './cards/surf.js';
import { loadHistory, onHistoryLoaded, pinRight } from './heathistory.js';

const HEATS = [workouts, nutritionlog];
const SECTIONS = {
  // `icon` = element the corner glyph is placed on. `move` = ordered elements pulled into the sheet body
  // (their event delegation + listeners travel with them). Restored to their exact spots on close.
  // `heat` = the scroll container holding that section's grid, pinned to its newest column on open.
  // `cards` = the modules to re-run once the elements have moved, because every one of these draws
  // itself to the size and window the surface gives it and the sheet is a different surface.
  // `tap` = open by tapping this, instead of by a corner glyph.
  nut: { icon: '#nutritionlog', move: ['#nutritionlog'], title: 'Nutrition', heat: '#nutheat', cards: HEATS },
  wk:  { icon: '#workouts',     move: ['#workouts', '#heatinfo'], title: 'Workouts', heat: '#heatwrap', cards: HEATS },
  // SURF opens by tapping the plots themselves. A corner glyph is 64px square and this card is a
  // fifth of a phone screen — the glyph would cover the thing it opens. The card is deliberately bare
  // and short (see phone-home.css); this is the other half of that bargain, where it gets the height
  // to be read and its labels back.
  surf: { icon: '#surf', move: ['#surf'], title: 'Surf', cards: [surf], tap: '.surfheat, .surfwater' },
};

// corner "expand" glyph (diagonal arrows). Big in the SVG because it lives INSIDE the ~0.36×-scaled wall
// shell, so it reads small on screen.
const ICON = '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M15 3h6v6M21 3l-8 8M9 21H3v-6M3 21l8-8"/></svg>';

let sheet = null;
let restore = [];
let openKey = null;

// The sheet is the only surface wide enough to scroll a grid, so it is what pays for the history
// fetch — once per page, the first time one is opened.
onHistoryLoaded(() => { if (openKey) repaint(openKey); });

// Cards paint from the last frame, so re-running them is how the grid picks up the sheet (its
// history, and the cell size the sheet gives it). Then pin to the newest column: scrollLeft 0 is
// the OLDEST week, which is not where anyone opens a heatmap to look.
function repaint(key) {
  const sec = SECTIONS[key];
  if (state.last) for (const card of sec.cards) card.render(state.last);
  if (!sec.heat) return;      // surf holds its own place, as a distance from the right-hand end
  const el = document.querySelector(sec.heat);
  if (el) requestAnimationFrame(() => pinRight(el));
}

function ensureSheet() {
  if (sheet) return;
  sheet = document.createElement('div');
  sheet.className = 'sectsheet';
  sheet.innerHTML =
    '<div class="ss-head"><span class="ss-title"></span>' +
    '<button class="ss-x" type="button" aria-label="Close">✕</button></div>' +
    '<div class="ss-body"></div>';
  sheet.querySelector('.ss-x').addEventListener('click', closeSheet);
  document.body.appendChild(sheet);
}

function openSheet(key) {
  const sec = SECTIONS[key];
  const els = sec.move.map((s) => document.querySelector(s)).filter(Boolean);
  if (els.length !== sec.move.length) return;
  ensureSheet();
  sheet.dataset.sec = key;
  sheet.querySelector('.ss-title').textContent = sec.title;
  const body = sheet.querySelector('.ss-body');
  // leave an anchor where each element lived so it goes back to the exact same spot on close
  restore = els.map((el) => { const a = document.createComment('ss'); el.before(a); return { el, a }; });
  els.forEach((el) => body.appendChild(el));
  document.body.classList.add('ss-open');
  openKey = key;
  requestAnimationFrame(() => { sheet.classList.add('open'); repaint(key); loadHistory(); });
}

function closeSheet() {
  if (!sheet) return;
  restore.forEach(({ el, a }) => a.replaceWith(el));
  restore = [];
  sheet.classList.remove('open');
  document.body.classList.remove('ss-open');
  const was = openKey;
  openKey = null;
  // Back to the size and window the page itself gives it — the cards read both off the element, and
  // the element has just moved back.
  if (state.last && was) for (const card of SECTIONS[was].cards) card.render(state.last);
}

// Back to now: a sheet left open is the largest piece of state on the page, and a fresh load has none.
window.addEventListener('hubreset', () => { if (openKey) closeSheet(); });

function mount() {
  // main mobile UI only = the wall on a phone-sized viewport. (Big-screen kiosk / desktop are untouched.)
  if (!document.body.classList.contains('tv') || window.innerWidth >= 1400) return;
  for (const key of Object.keys(SECTIONS)) {
    const host = document.querySelector(SECTIONS[key].icon);
    if (!host) continue;
    if (SECTIONS[key].tap) { bindTap(host, key); continue; }
    if (host.querySelector('.expand-btn')) continue;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const b = document.createElement('button');
    b.className = 'expand-btn';
    b.type = 'button';
    b.dataset.sec = key;
    b.setAttribute('aria-label', 'Expand ' + SECTIONS[key].title);
    b.innerHTML = ICON;
    b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); openSheet(key); });
    host.appendChild(b);
  }
}

// TAP TO OPEN, on a thing that also scrolls sideways. The plots are a horizontal scroller, so the
// gesture that opens the sheet and the gesture that drags the timeline start identically — a plain
// click handler turns every flick into an open. Bound on the HOST and delegated, because the card
// rebuilds its innards on every broadcast and a listener on those would be thrown away twice a minute.
//
// A tap is: the pointer barely moved, AND the scroller under it did not. The second test is what
// catches a flick that was answered by momentum rather than by the finger.
function bindTap(host, key) {
  if (host.dataset.ssTap) return;
  host.dataset.ssTap = '1';
  let x = 0, y = 0, left = 0;
  const scrollerAt = (e) => (e.target.closest ? e.target.closest('.surfscroll') : null);
  host.addEventListener('pointerdown', (e) => {
    const box = scrollerAt(e);
    x = e.clientX; y = e.clientY; left = box ? box.scrollLeft : 0;
  }, { passive: true });
  host.addEventListener('pointerup', (e) => {
    if (openKey) return;                                          // already in the sheet
    if (!e.target.closest || !e.target.closest(SECTIONS[key].tap)) return;
    if (Math.abs(e.clientX - x) > 6 || Math.abs(e.clientY - y) > 6) return;
    const box = scrollerAt(e);
    if (box && Math.abs(box.scrollLeft - left) > 2) return;
    openSheet(key);
  }, { passive: true });
}

function boot() { mount(); if (!document.querySelector('.expand-btn')) setTimeout(mount, 400); }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
