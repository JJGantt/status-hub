// expand.js — phone wall (the main mobile UI). A minimal expand icon on the nutrition + workout sections
// opens each as a full-screen sheet: heatmap across the top, list below. The WHOLE delegation host is moved
// into the sheet (nutrition taps are delegated on #nutritionlog; workout taps on #workouts) so tapping a day
// and the list's buttons keep working — the point of expanding is to make those EASIER to use, not disable
// them. Elements are moved (and restored on close) so the live render + all handlers stay intact.

import { state } from './shared.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';
import { loadHistory, onHistoryLoaded, pinRight } from './heathistory.js';

const SECTIONS = {
  // `icon` = element the corner glyph is placed on. `move` = ordered elements pulled into the sheet body
  // (their event delegation + listeners travel with them). Restored to their exact spots on close.
  // `heat` = the scroll container holding that section's grid, pinned to its newest column on open.
  nut: { icon: '#nutritionlog', move: ['#nutritionlog'], title: 'Nutrition', heat: '#nutheat' },
  wk:  { icon: '#workouts',     move: ['#workouts', '#heatinfo'], title: 'Workouts', heat: '#heatwrap' },
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
  if (state.last) { workouts.render(state.last); nutritionlog.render(state.last); }
  const el = document.querySelector(SECTIONS[key].heat);
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
  openKey = null;
  if (state.last) { workouts.render(state.last); nutritionlog.render(state.last); }  // back to the frame's window
}

function mount() {
  // main mobile UI only = the wall on a phone-sized viewport. (Big-screen kiosk / desktop are untouched.)
  if (!document.body.classList.contains('tv') || window.innerWidth >= 1400) return;
  for (const key of Object.keys(SECTIONS)) {
    const host = document.querySelector(SECTIONS[key].icon);
    if (!host || host.querySelector('.expand-btn')) continue;
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

function boot() { mount(); if (!document.querySelector('.expand-btn')) setTimeout(mount, 400); }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
