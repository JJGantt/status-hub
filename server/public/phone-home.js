// The phone home page's own middle. Everything else on it is a shared card core.js already paints;
// this file holds the three things that are this surface's — today's strip, the session list, the
// tail of the conversation — plus the swipe panes around them.
//
// It is the phone's analogue of tv-home.js. Where the wall gives a column to today's dial and a
// column to the focused session's whole answer, this gives neither: a phone is read at arm's length
// for a few seconds, so the day lies down and a session is a title with a line under it.
import { esc, md, state } from './shared.js';
import { mount } from './cards/dayline.js';
import { mountStrip } from './cards/daystrip.js';
import { mountMonth } from './cards/month.js';
import { openSection } from './expand.js';
import { mountSessions } from './cards/sessions.js';
import { onThread, onPending, onActivity } from './voiceagent.js';
import { loadHistory, onHistoryLoaded, pinRight } from './heathistory.js';
import * as workouts from './cards/workouts.js';
import * as nutritionlog from './cards/nutritionlog.js';

// ---- today, and the days after it ----------------------------------------
//
// ONE fetch for all of it. `day=1&full=1&ahead=60` carries two months from today and the
// overdue list, and the strip draws them as one continuous axis — so the look-ahead is not a second
// surface here, it is the same timeline scrolled right. `full=1` is what makes `overdue` ship; the
// dayline itself goes unused, because an hour-row column is the lists pane's shape, not this one's.
const strip = mountStrip(document.getElementById('ph-strip'));
mount(null, {
  url: '/api/calendar?day=1&full=1&ahead=60',
  onload: (d) => { if (strip) strip.paint(d); },
});

// The month, in the calendar sheet the strip opens (expand.js, `cal`), above the day and the lists.
// It re-reads on the page's one list stream (`hub:lists`, from cards/dayline.js) and whenever the
// sheet opens, which is also what catches a push missed while the phone slept.
const month = mountMonth(document.getElementById('calmonth'));
if (month) {
  document.addEventListener('hub:lists', month.load);
  document.addEventListener('hub:sheetopen', (e) => { if (e.detail === 'cal') month.load(); });
}

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
const COLW = 13;   // one week: the 12px cell plus the 1px gap (phone-home.css --cell)
const rails = () => [document.getElementById('nutheat'), document.getElementById('heatwrap'),
  document.querySelector('#weightweeks .wp-scroll')].filter(Boolean);
const maxOf = (el) => Math.max(0, el.scrollWidth - el.clientWidth);
let mirroring = false, dragged = false, weeksBack = 0;

// MIRRORED IN WEEKS, not in pixels. All three span the same weeks now (the archive builds both maps
// over the longer of the two, and ships a plot across it), so "N columns back from now" is the same
// week in each and there is nothing left for them to drift on. Pixels would have been close and not
// equal: the plot's drawing is inset half a cell at each end, so its scroll range is a column
// narrower than a map's.
function mirror(src) {
  if (mirroring) return;
  mirroring = true;
  weeksBack = Math.round((maxOf(src) - src.scrollLeft) / COLW);
  for (const el of rails()) {
    if (el === src) continue;
    el.scrollLeft = Math.max(0, maxOf(el) - weeksBack * COLW);
  }
  // A frame later, not on the next line: setting scrollLeft fires a scroll event of its own, and
  // clearing the flag synchronously let the mirrored rails answer back.
  requestAnimationFrame(() => { mirroring = false; });
}

function watch(el) {
  if (!el || el.dataset.railed) return;
  el.dataset.railed = '1';
  el.addEventListener('scroll', () => {
    if (!mirroring) dragged = maxOf(el) - el.scrollLeft > 4;
    mirror(el);
  }, { passive: true });
}

// After a rebuild, back to the week they were on. The two maps keep their own element and
// `paintScrolled` carries their position across, but the plot is replaced outright and would come
// back at `now` while the maps stayed where he left them — which is the two of them showing
// different months again, once a minute, without him touching anything.
function restore() {
  for (const el of rails()) el.scrollLeft = Math.max(0, maxOf(el) - (dragged ? weeksBack * COLW : 0));
}

for (const id of ['nutheat', 'heatwrap', 'weightweeks']) {
  const host = document.getElementById(id);
  if (!host) continue;
  new MutationObserver(() => { rails().forEach(watch); restore(); }).observe(host, { childList: true, subtree: true });
}
rails().forEach(watch);
restore();

// BACK TO NOW — the page as it opens, without opening it again. That is the whole bar: anything a
// fresh load would not be showing has to be given up here, and the things that are not scroll
// positions are the ones that get forgotten. Each card gives up its own (the day strip's expanded
// day, the surf plots' offset, both heat maps' selected day, the muscle sheet, an open section sheet,
// a session opened over the repos list); this handler is what THIS page owns — the three rails, every
// list's scroll, the pane it lands on, and the thread at its newest message.
window.addEventListener('hubreset', () => {
  dragged = false; weeksBack = 0;
  restore();
  for (const sel of ['#nutinfo', '#heatinfo', '.ph-sess-list', '#todopane', '#daycard',
                     '#repospane', '#reportspane']) {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }
  // The pane it opens on. Instant, not smooth: this is the page as loaded, not a navigation.
  const pn = document.getElementById('wallpanes');
  if (pn) pn.scrollLeft = pn.clientWidth;
  toLast();
});

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
const TAIL = 30;        // messages held; past that the top of the context is off the end of the scroll
let thread = [];        // [{role, text, session}] oldest first

// Whether he has scrolled UP to read something. Held as a flag rather than measured at paint time:
// measuring the old content's scroll position just before replacing it wholesale is measuring the
// wrong thing, and one early paint against an empty box left the thread parked mid-way and never
// recovering. Our own scrollTop write fires this too, which is right — it lands at the bottom.
let held = false;

// WHAT HAS BEEN HEARD BUT IS NOT IN THE THREAD YET. The worker writes the user bubble only when the run
// is over, so without this the box sat unchanged from the moment he spoke until the whole reply landed,
// and then both lines appeared together. `null` is nothing in flight; `{text:''}` is a clip being
// transcribed, where the words are not known yet and the line is three dots; anything else is the
// transcript, standing in for the row that will replace it.
let pending = null;
let pendingT = 0;       // a run that never reports back must not leave the line up forever
onPending((p) => {
  if (!p) return;
  clearTimeout(pendingT);
  if (p.state === 'clear') pending = null;
  else if (p.state === 'transcribing') pending = { text: '' };
  else if (p.state === 'prompt') pending = { text: String(p.text || '') };
  else return;
  if (pending) pendingT = setTimeout(() => { pending = null; paintConv(); }, 5 * 60 * 1000);
  paintConv(true);
});
// WHAT THE MODEL IS DOING RIGHT NOW, on ONE line, at the bottom of the box. The run pushes a frame
// per tool call and per thought; this keeps only the NEWEST, and keeps nothing at all once the reply
// lands. The session view is where every step is listed and read — here the question is only whether
// it is working, and a stack of tool calls in a box this size is the whole box.
//
// `{text:''}` is a run that has started and not reported a step yet, which is the caret alone.
let act = null;
let actT = 0;           // a run that never reports an end must not leave the line up for ever
onActivity((a) => {
  const state = a.state || 'tool';
  const first = !act;              // the run's FIRST frame — see the pin below
  clearTimeout(actT);
  if (state === 'done' || state === 'error') act = null;
  else if (state === 'working') act = { text: '' };
  else act = { text: String(a.text || '').replace(/\s+/g, ' ').trim() };
  if (act) actT = setTimeout(() => { act = null; paintConv(); }, 5 * 60 * 1000);
  // PINNED ON THE FIRST FRAME ONLY. The box lands on the TOP of the last message, so with a long
  // reply above it the new line is below the fold and the one thing it exists to say is invisible —
  // the run's first frame is therefore worth the jump, exactly as his own prompt landing is. Every
  // frame after it repaints where he left it, so a line changing every few seconds cannot drag him
  // back down while he is reading.
  paintConv(first && !!act);
});
function clearAct() { clearTimeout(actT); act = null; }

// The row the placeholder was standing in for has arrived — or the reply has, which means the run is
// over whatever the thread looks like. Only ever called on a LIVE row: a resync replays the whole
// history, where an old assistant row would take down a placeholder put up a second ago.
function settle(row) {
  // The reply IS the end of the run, whatever frames did or did not arrive, so the activity line
  // comes down with it rather than waiting for a `done` that a dropped socket may have eaten.
  if (row.role === 'assistant') clearAct();
  if (!pending) return;
  const t = String((row && row.text) || '').trim();
  if (row.role === 'assistant' || (row.role === 'user' && t && t === pending.text.trim())) {
    clearTimeout(pendingT); pending = null;
  }
}

// WHERE IT LANDS: the top of the LAST message at the top of the box, not the bottom of the thread.
// A reply is read from its first line, and a box scrolled to the very end opens on the last line of
// it with the rest above — so the newest thing on screen was its own tail. The session view has
// landed this way for a while (`open` in cards/repos.js); this is the same rule in the small box.
//
// Clamped, so a short last message simply rests at the end of the scroll, which is where it already
// was. Measured off the rects rather than offsetTop: the box is not an offset parent, so offsetTop
// is against some ancestor and the difference is only a shift, not the number wanted.
function toLast() {
  if (!conv) return;
  const el = conv.lastElementChild;
  const max = Math.max(0, conv.scrollHeight - conv.clientHeight);
  if (!el) { conv.scrollTop = max; held = false; return; }
  const delta = el.getBoundingClientRect().top - conv.getBoundingClientRect().top;
  conv.scrollTop = Math.max(0, Math.min(max, conv.scrollTop + delta));
  held = false;
}

if (conv) {
  conv.addEventListener('scroll', () => {
    held = conv.scrollHeight - conv.scrollTop - conv.clientHeight > 24;
  }, { passive: true });
  // This block's height is whatever the rest of the screen did not need, so it is not settled when
  // the thread first paints into it — and a position taken against the wrong height is a thread
  // parked somewhere nothing afterwards corrects. Re-place it whenever the box itself resizes.
  try {
    new ResizeObserver(() => { if (!held) toLast(); }).observe(conv);
  } catch (_) { /* no ResizeObserver: the paint-time placement is what there is */ }
}

function paintConv(pin) {
  if (!conv) return;
  const stick = pin || !held;
  conv.innerHTML = thread.map((r) => {
    const said = r.role === 'assistant';
    // NO `You` / `Hub` label. His own words are dim and the hub's are not, which already says which
    // is which — a word in a gutter said it twice and took the gutter's width off every line.
    // A reply RELAYED FROM A SESSION keeps its name, because that is the one thing the colour cannot
    // carry: it is a machine reporting back, not the hub answering.
    const from = said && r.session ? r.session : null;
    return `<div class="ph-convline ${said ? 'said' : 'ask'}${from ? ' sess' : ''}">` +
      (from ? `<span class="ph-convk">${esc(from)}</span>` : '') +
      `<div class="ph-convt">${md(r.text)}</div></div>`;
  }).join('') + (pending
    ? '<div class="ph-convline ask pend"><div class="ph-convt">' +
      (pending.text ? md(pending.text) : '<span class=ph-dots><i></i><i></i><i></i></span>') +
      '</div></div>'
    : '') + (act
    // The lowest line, under his words and above nothing: the caret says it is working and the step
    // says what it is doing. Plain text, collapsed and clipped to the one line — a thought arrives as
    // markdown and this is not the surface that reads one.
    ? '<div class="ph-convline work"><div class="ph-convt"><span class="ph-caret">\u258d</span>' +
      '<span class="ph-worktxt">' + esc(act.text) + '</span></div></div>'
    : '');
  // Twice: once now, because the layout is already final after the assignment above, and once on the
  // next frame, because this block's own height is whatever the rest of the screen did not need and
  // is not settled until the flex pass has run.
  if (stick) { toLast(); requestAnimationFrame(() => { if (!held) toLast(); }); }
}

// The text is kept WHOLE — paragraphs, lists and all. It arrives as markdown and is rendered as
// markdown (`md` in shared.js); collapsing it to one line was reading the SOURCE of a reply rather
// than the reply, with `**bold**` and `- ` left standing in the middle of the prose.
function takeRow(r) {
  const text = String(r.text == null ? '' : r.text).trim();
  if (!text) return;                       // a photo-only message has nothing to show
  if (r.role !== 'user' && r.role !== 'assistant') return;
  thread.push({ role: r.role, text, session: r.session_id ? (r.session_label || '') : '' });
  if (thread.length > TAIL) thread = thread.slice(-TAIL);
}

async function resync() {
  try {
    const rows = await (await fetch('/api/voice-messages?focus=hub&mode=active&limit=' + TAIL)).json();
    thread = [];
    for (const r of rows || []) takeRow(r);
    // The placeholder survives a resync unless the row it was standing in for is now in the thread.
    if (pending && pending.text) {
      const last = [...thread].reverse().find((r) => r.role === 'user');
      if (last && last.text.trim() === pending.text.trim()) { clearTimeout(pendingT); pending = null; }
    }
    paintConv(true);
  } catch (_) { /* the next push or resync reconciles */ }
}

onThread((row) => { if (!row) { resync(); return; } takeRow(row); settle(row); paintConv(); });

// ---- the swipe panes -----------------------------------------------------
//
// [sessions] [home] [reports], landing on home — index 1, which is what
// `clientWidth` means here and what the reset returns to. The wall's version of this (wall.js) also
// scales a 1920x1080 canvas down to fit; there is nothing to scale here — the page is laid out at the
// phone's own size — so only the paging is left.
const panes = document.getElementById('wallpanes');
if (panes) {
  requestAnimationFrame(() => { panes.scrollLeft = panes.clientWidth; });
  // Jump to a named pane. The native app calls this when a widget is tapped, so each widget lands on
  // the part of the hub it actually depicts rather than on whatever pane was last open — the due
  // widget is useless if tapping it drops you on the chat pane.
  window.__showPane = (name) => {
    // The lists are in the calendar sheet here, not a pane of their own.
    if (name === 'todo') return openSection('cal');
    const el = panes.querySelector(`.pane-${String(name).replace(/[^a-z]/g, '')}`);
    if (!el) return false;
    // scroll-snap owns the physics; setting scrollLeft to the pane's offset lands it exactly.
    panes.scrollTo({ left: el.offsetLeft, behavior: 'smooth' });
    return true;
  };
}
