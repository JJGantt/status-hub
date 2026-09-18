// The phone home page's own middle. Everything else on it is a shared card core.js already paints;
// this file holds the three things that are this surface's — today's strip, the session list, the
// tail of the conversation — plus the swipe panes around them.
//
// It is the phone's analogue of tv-home.js. Where the wall gives a column to today's dial and a
// column to the focused session's whole answer, this gives neither: a phone is read at arm's length
// for a few seconds, so the day lies down and a session is a title with a line under it.
import { esc, state } from './shared.js';
import { mount } from './cards/dayline.js';
import { mountStrip } from './cards/daystrip.js';
import { mountSessions } from './cards/sessions.js';
import { onThread } from './voiceagent.js';
import { loadHistory, onHistoryLoaded, pinRight } from './heathistory.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';

// ---- today, and the days after it ----------------------------------------
//
// ONE fetch for all of it. `day=1&full=1&ahead=7` carries the seven days starting today and the
// overdue list, and the strip draws them as one continuous axis — so the look-ahead is not a second
// surface here, it is the same timeline scrolled right. `full=1` is what makes `overdue` ship; the
// dayline itself goes unused, because an hour-row column is the lists pane's shape, not this one's.
const strip = mountStrip(document.getElementById('ph-strip'));
mount(null, {
  url: '/api/calendar?day=1&full=1&ahead=7',
  onload: (d) => { if (strip) strip.paint(d); },
});

// ---- the whole archive, in the two maps -----------------------------------
//
// The status frame carries a fixed window because it is re-pushed on every realtime event; everything
// older is one request (`/api/heat-history`), made once, and the maps here are marked `data-history`
// so cards/heathistory.js prefixes it to what the frame ships. They scroll sideways through it and
// land on the newest week — scrollLeft 0 is the OLDEST, which is not where anyone opens a heat map.
loadHistory();
onHistoryLoaded(() => {
  if (!state.last) return;
  workouts.render(state.last);
  nutritionlog.render(state.last);
});

// LANDING ON THE NEWEST WEEK, AND MOVING AS ONE. The two maps and the weigh-in plot over them are
// three views of one axis — the same Sunday-aligned weeks at the same cell — so dragging any of them
// drags the others. They are mirrored by DISTANCE FROM THE RIGHT rather than by scrollLeft: the food
// map's archive is shorter than the training map's (intake logging started later), so the two agree
// about where `now` is and diverge only at the far end, where the shorter one has nothing anyway.
//
// scrollLeft 0 is the OLDEST, which on a map whose first columns predate the logging is a box of
// empty cells — which is exactly how it looked. Watched rather than pinned once: the cards rebuild
// these grids on every frame and `paintScrolled` carries the position across, so a single pin at the
// wrong moment (before the archive lands, before the columns have their width) is a wrong position
// that then persists all day. It stops as soon as he has dragged one, at which point holding his
// place is what paintScrolled is for.
const rails = () => [document.getElementById('nutheat'), document.getElementById('heatwrap'),
  document.querySelector('#weightweeks .wp-scroll')].filter(Boolean);
const endOf = (el) => Math.max(0, el.scrollWidth - el.scrollLeft - el.clientWidth);
let mirroring = false, dragged = false;

// The flag is cleared a FRAME later, not on the next line. Setting scrollLeft fires a scroll event
// of its own, asynchronously — so clearing it synchronously let the mirrored rails answer back, and
// the shortest of them (the food map, whose archive starts later) dragged everyone to its own end.
// The training map could then never be scrolled past where the food map runs out.
function mirror(src) {
  if (mirroring) return;
  mirroring = true;
  const end = endOf(src);
  for (const el of rails()) {
    if (el === src) continue;
    el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth - end);
  }
  requestAnimationFrame(() => { mirroring = false; });
}

function watch(el) {
  if (!el || el.dataset.railed) return;
  el.dataset.railed = '1';
  el.addEventListener('scroll', () => {
    if (!mirroring) dragged = endOf(el) > 4;
    mirror(el);
  }, { passive: true });
}

function pinRail() {
  if (dragged) return;
  for (const el of rails()) pinRight(el);
}

for (const id of ['nutheat', 'heatwrap', 'weightweeks']) {
  const host = document.getElementById(id);
  if (!host) continue;
  // The plot's scroller is rebuilt with the plot, so the listener is (re)attached on each rebuild;
  // the two maps keep their own element and only their contents change.
  new MutationObserver(() => { rails().forEach(watch); pinRail(); }).observe(host, { childList: true, subtree: true });
}
rails().forEach(watch);
pinRail();

// ---- what is running -----------------------------------------------------
//
// EVERY session, in a box three rows tall that scrolls. The wall caps its list because a wall cannot
// be scrolled; here the cap would only be hiding rows that cost nothing to keep. TAPPABLE, which the
// wall's are not: a row opens the session in the view the lists pane already has, with the whole
// conversation and a composer, so a title truncated in this column costs nothing — it is a way in,
// not the answer.
mountSessions({ list: document.getElementById('ph-sess-list'), max: 40, tap: true });

// ---- the tail of the conversation ----------------------------------------
//
// The end of the hub thread, scrolling, pinned to the newest line. It is the block that takes
// whatever height the rest of the screen did not need, and it is the only one that can spend an
// arbitrary amount of it — more room is simply more of the conversation. The composer is one swipe
// left, with the whole thing.
//
// Rows arrive through voiceagent's own stream (onThread), never a second EventSource — and `null`
// means resync, which is when the current context is re-read. `mode=active` resolves hub vs agent on
// the server, which is the same rule the conversation card follows.
const conv = document.getElementById('ph-conv');
const TAIL = 30;        // lines held; past that the top of the context is off the end of the scroll
let thread = [];        // [{role, text}] oldest first

// Whether he has scrolled UP to read something. Held as a flag rather than measured at paint time:
// measuring the old content's scroll position just before replacing it wholesale is measuring the
// wrong thing, and one early paint against an empty box left the thread parked mid-way and never
// recovering. Our own scrollTop write fires this too, which is right — it lands at the bottom.
let held = false;
if (conv) {
  conv.addEventListener('scroll', () => {
    held = conv.scrollHeight - conv.scrollTop - conv.clientHeight > 24;
  }, { passive: true });
  // This block's height is whatever the rest of the screen did not need, so it is not settled when
  // the thread first paints into it — and a bottom pinned against the wrong height is a thread
  // parked mid-way that nothing afterwards corrects. Re-pin whenever the box itself resizes.
  try {
    new ResizeObserver(() => { if (!held) conv.scrollTop = conv.scrollHeight; }).observe(conv);
  } catch (_) { /* no ResizeObserver: the paint-time pin is what there is */ }
}

function paintConv(pin) {
  if (!conv) return;
  const stick = pin || !held;
  conv.innerHTML = thread.map((r) => {
    const said = r.role === 'assistant';
    return `<div class="ph-convline ${said ? 'said' : 'ask'}">` +
      `<span class="ph-convk">${said ? 'Hub' : 'You'}</span>` +
      `<span class="ph-convt">${esc(r.text)}</span></div>`;
  }).join('');
  // Synchronously: scrollHeight is already final after the assignment above, and deferring it to a
  // frame let the next paint overwrite the position before it was ever applied.
  // Twice: once now, because scrollHeight is already final after the assignment above, and once on
  // the next frame, because this block's own height is whatever the rest of the screen did not need
  // and is not settled until the flex pass has run.
  const bottom = () => { conv.scrollTop = conv.scrollHeight; held = false; };
  if (stick) { bottom(); requestAnimationFrame(() => { if (!held) bottom(); }); }
}

// One line, collapsed: a reply arrives with its paragraphs intact and a row here is a single line.
const oneLine = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

function takeRow(r) {
  const text = oneLine(r.text);
  if (!text) return;                       // a photo-only message has no line to show
  if (r.role !== 'user' && r.role !== 'assistant') return;
  thread.push({ role: r.role, text });
  if (thread.length > TAIL) thread = thread.slice(-TAIL);
}

async function resync() {
  try {
    const rows = await (await fetch('/api/voice-messages?focus=hub&mode=active&limit=' + TAIL)).json();
    thread = [];
    for (const r of rows || []) takeRow(r);
    paintConv(true);
  } catch (_) { /* the next push or resync reconciles */ }
}

onThread((row) => { if (!row) { resync(); return; } takeRow(row); paintConv(); });

// ---- the swipe panes -----------------------------------------------------
//
// [chat] [home] [misc] [maint] [lists] [repos] [reports], landing on home. The wall's version of this
// (wall.js) also scales a 1920x1080 canvas down to fit; there is nothing to scale here — the page is
// laid out at the phone's own size — so only the paging is left.
const panes = document.getElementById('wallpanes');
if (panes) {
  requestAnimationFrame(() => { panes.scrollLeft = panes.clientWidth; });
  // Jump to a named pane. The native app calls this when a widget is tapped, so each widget lands on
  // the part of the hub it actually depicts rather than on whatever pane was last open — the due
  // widget is useless if tapping it drops you on the chat pane.
  window.__showPane = (name) => {
    const el = panes.querySelector(`.pane-${String(name).replace(/[^a-z]/g, '')}`);
    if (!el) return false;
    // scroll-snap owns the physics; setting scrollLeft to the pane's offset lands it exactly.
    panes.scrollTo({ left: el.offsetLeft, behavior: 'smooth' });
    return true;
  };
}
