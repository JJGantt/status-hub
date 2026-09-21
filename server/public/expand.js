// expand.js — the phone's section sheets. Tapping the thing that summarises a section opens it full-screen:
// the heat maps, the surf plots, the body figures, the weigh-in plot. The WHOLE delegation host is moved
// into the sheet (nutrition taps are delegated on #nutritionlog; workout taps on #workouts) so tapping a day
// and the list's buttons keep working — the point of expanding is to make those EASIER to use, not disable
// them. Elements are moved (and restored on close) so the live render + all handlers stay intact.

import { state } from './shared.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';
import * as surf from './cards/surf.js';
import * as muscle from './cards/muscle.js';
import * as maintviz from './cards/maintviz.js';
import { loadHistory, onHistoryLoaded, pinRight } from './heathistory.js';

const HEATS = [workouts, nutritionlog];
const SECTIONS = {
  // `host` = the element the tap is bound on. `move` = ordered elements pulled into the sheet body
  // (their event delegation + listeners travel with them). Restored to their exact spots on close.
  // `heat` = the scroll container holding that section's grid, pinned to its newest column on open.
  // `cards` = the modules to re-run once the elements have moved, because every one of these draws
  // itself to the size and window the surface gives it and the sheet is a different surface.
  // `tap` = what opens it inside the host. `scroller` = what a drag moves under the finger.
  //
  // THE HEAT MAPS open by tapping the map. A tap on a day still picks that day on the way in — the
  // card's own click lands after the sheet opens — so the sheet and the rings behind it are on the
  // day that was tapped.
  nut: { host: '#nutritionlog', move: ['#nutritionlog'], title: 'Nutrition', heat: '#nutheat', cards: HEATS,
         tap: '#nutheat', scroller: '#nutheat' },
  wk:  { host: '#workouts', move: ['#workouts', '#heatinfo'], title: 'Workouts', heat: '#heatwrap', cards: HEATS,
         tap: '#heatwrap', scroller: '#heatwrap' },
  // SURF opens by tapping the plots themselves. The card is deliberately bare and short (see
  // phone-home.css); this is the other half of that bargain, where it gets the height to be read and
  // its labels back.
  surf: { host: '#surf', move: ['#surf'], title: 'Surf', cards: [surf], tap: '.surfheat, .surfwater' },
  // THE BODY opens the same way, and for the same reason the small one does not select a muscle:
  // two whole figures in 133px puts a region at a few pixels. Expanded, the figures are aimable and
  // the volume bars come with them — twenty-three of them, which is the one thing the phone's home
  // screen has never had room for.
  body: { host: '#body', move: ['#body', '#volume'], title: 'Muscles', cards: [muscle], tap: '#body' },
  // THE WEIGHT PAGE — every weigh-in, the trend, the intake bars and the maintenance curves — opens by
  // tapping the weigh-in plot over the food map, which is its summary. The card lives in the page's
  // markup hidden, so it renders on every frame and is simply MOVED here, like the rest.
  // `scroller` is what a drag moves under the finger: the plot scrolls with the heat maps.
  wt: { host: '#weightweeks', move: ['#weightcard'], title: 'Weight', cards: [maintviz],
        heat: '#maintviz .mv-scroll', tap: '#weightweeks', scroller: '.wp-scroll' },
};

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
    const host = document.querySelector(SECTIONS[key].host);
    if (host) bindTap(host, key);
  }
}

// TAP TO OPEN, on a thing that also scrolls sideways. The heat maps, the surf plots and the weigh-in plot
// are horizontal scrollers, so the gesture that opens the sheet and the gesture that drags them start
// identically — a plain click handler turns every flick into an open. Bound on the HOST and delegated,
// because the card rebuilds its innards on every broadcast and a listener on those would be thrown away
// twice a minute.
//
// A tap is: the pointer barely moved, AND the scroller under it did not. The second test is what
// catches a flick that was answered by momentum rather than by the finger. pointerup JUDGES it and the
// click that follows OPENS it: a heat map's card picks the tapped day in its own click handler on this
// same host, registered first, so opening on the click is what guarantees the day is picked before the
// sheet moves the map.
function bindTap(host, key) {
  if (host.dataset.ssTap) return;
  host.dataset.ssTap = '1';
  let x = 0, y = 0, left = 0, tapped = false;
  const scroller = SECTIONS[key].scroller || '.surfscroll';
  const scrollerAt = (e) => (e.target.closest ? e.target.closest(scroller) : null);
  host.addEventListener('pointerdown', (e) => {
    const box = scrollerAt(e);
    x = e.clientX; y = e.clientY; left = box ? box.scrollLeft : 0; tapped = false;
  }, { passive: true });
  host.addEventListener('pointerup', (e) => {
    if (openKey) return;                                          // already in the sheet
    if (!e.target.closest || !e.target.closest(SECTIONS[key].tap)) return;
    if (Math.abs(e.clientX - x) > 6 || Math.abs(e.clientY - y) > 6) return;
    const box = scrollerAt(e);
    if (box && Math.abs(box.scrollLeft - left) > 2) return;
    tapped = true;
  }, { passive: true });
  host.addEventListener('click', () => { if (tapped) { tapped = false; openSheet(key); } });
}

// Once more a beat later, for a host the first render had not drawn yet; bindTap is idempotent.
function boot() { mount(); setTimeout(mount, 400); }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
