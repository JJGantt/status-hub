// expand.js — phone wall (the main mobile UI). Adds a minimal expand icon to the nutrition + workout
// sections; tapping it opens that section as a full-screen overlay: the heatmap across the top, the list
// below. It REUSES the live card elements — the real #nutheat/#nutinfo (and #heatwrap/#heatinfo) are moved
// into the sheet and moved back on close — so the existing render + tap-to-select-day interactions keep
// working untouched (they all key off element IDs, which survive the move). No render logic is duplicated.

const SECTIONS = {
  nut: { host: '#nutritionlog', heat: '#nutheat', list: '#nutinfo', title: 'Nutrition' },
  wk:  { host: '#workouts',     heat: '#heatwrap', list: '#heatinfo', title: 'Workouts' },
};

// corner "expand" glyph (diagonal arrows). Sized big in the SVG because it lives INSIDE the CSS-scaled
// wall shell (~0.36×), so it renders small on screen — matching the "as minimal as possible" ask.
const ICON = '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M15 3h6v6M21 3l-8 8M9 21H3v-6M3 21l8-8"/></svg>';

let sheet = null;
let restore = [];

function ensureSheet() {
  if (sheet) return;
  sheet = document.createElement('div');
  sheet.className = 'sectsheet';
  sheet.innerHTML =
    '<div class="ss-head"><span class="ss-title"></span>' +
    '<button class="ss-x" type="button" aria-label="Close">✕</button></div>' +
    '<div class="ss-heat"></div><div class="ss-list"></div>';
  sheet.querySelector('.ss-x').addEventListener('click', closeSheet);
  document.body.appendChild(sheet);
}

function openSheet(key) {
  const sec = SECTIONS[key];
  const heat = document.querySelector(sec.heat);
  const list = document.querySelector(sec.list);
  if (!heat || !list) return;
  ensureSheet();
  sheet.querySelector('.ss-title').textContent = sec.title;
  // leave an anchor where each element lived so it goes back to the exact same spot on close
  restore = [heat, list].map((el) => { const a = document.createComment('ss'); el.before(a); return { el, a }; });
  sheet.querySelector('.ss-heat').appendChild(heat);
  sheet.querySelector('.ss-list').appendChild(list);
  document.body.classList.add('ss-open');
  requestAnimationFrame(() => sheet.classList.add('open'));
}

function closeSheet() {
  if (!sheet) return;
  restore.forEach(({ el, a }) => a.replaceWith(el));
  restore = [];
  sheet.classList.remove('open');
  document.body.classList.remove('ss-open');
}

function mount() {
  // main mobile UI only = the wall on a phone-sized viewport. (Big-screen kiosk / desktop are untouched.)
  if (!document.body.classList.contains('tv') || window.innerWidth >= 1400) return;
  for (const key of Object.keys(SECTIONS)) {
    const host = document.querySelector(SECTIONS[key].host);
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

// The section hosts are in the static markup, so mount as soon as the wall is up. Retry briefly in case
// wall.js is still arranging the phone panes when this first runs.
function boot() { mount(); if (!document.querySelector('.expand-btn')) setTimeout(mount, 400); }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
