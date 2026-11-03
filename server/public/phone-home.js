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
// that then persists all day. It stops as soon as the user has dragged one, at which point holding the user's
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
// back at `now` while the maps stayed where the user left them — which is the two of them showing
// different months again, once a minute, without the user touching anything.
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
//
// THE WHOLE CURRENT CONTEXT is held — the day since 4 AM, which is exactly what the model is replayed —
// and scrolling to the top of it loads the stretch before, a page at a time (`?history=1&before=`), with
// a rule wherever one context ends and the next begins. A box that showed only the last thirty lines
// of the last hour hid a conversation the model could still see.
const conv = document.getElementById('ph-conv');
const CTX_MAX = 500;    // the server's ceiling; a day is well under it
const PAGE = 60;        // rows per page further back
let thread = [];        // [{id, at, role, text, session, ctx}] oldest first — the current context
let older = [];         // the same, loaded by scrolling up past its start
let olderDone = false, olderBusy = false;

// NOTHING MOVES THE BOX WHILE IT IS BEING LOOKED AT. Not the user's transcript appearing, not the reply,
// not the activity line, not with the box already at the bottom: what arrives lands below and waits.
// The box LANDS (`toLast`) only on ARRIVAL — the first load, coming back to the page after it was hidden
// (`owed`, spent by the resync the stream does on the way back), and the reset button.
// `settling` is the stretch after a landing while the box's own height is still being decided by the
// flex pass; the ResizeObserver re-lands only then, and the user's first touch ends it.
let owed = true;
let settling = false;
document.addEventListener('visibilitychange', () => { if (document.hidden) owed = true; });

// WHAT HAS BEEN HEARD BUT IS NOT IN THE THREAD YET. The worker writes the user bubble only when the run
// is over, so without this the box sat unchanged from the moment the user spoke until the whole reply landed,
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
  paintConv();
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
  clearTimeout(actT);
  if (state === 'done' || state === 'error') act = null;
  else if (state === 'working') act = { text: '' };
  else act = { text: String(a.text || '').replace(/\s+/g, ' ').trim() };
  if (act) actT = setTimeout(() => { act = null; paintConv(); }, 5 * 60 * 1000);
  paintConv();
});
function clearAct() { clearTimeout(actT); act = null; }

// Whether a thread row is the one the placeholder stands in for. Whitespace-blind, and a PREFIX is
// enough: the worker's `working` frame carries the transcript cut to 240 characters, so a long command
// never equals its own row.
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function isPending(r) {
  if (!pending || !pending.text || !r || r.role !== 'user') return false;
  const p = norm(pending.text), t = norm(r.text);
  return !!p && (t === p || (p.length >= 200 && t.startsWith(p)));
}

// The row the placeholder was standing in for has arrived — or the reply has, which means the run is
// over whatever the thread looks like. Only ever called on a LIVE row: a resync replays the whole
// history, where an old assistant row would take down a placeholder put up a second ago.
function settle(row) {
  // The reply IS the end of the run, whatever frames did or did not arrive, so the activity line
  // comes down with it rather than waiting for a `done` that a dropped socket may have eaten.
  if (row.role === 'assistant') clearAct();
  if (!pending) return;
  if (row.role === 'assistant' || isPending(row)) { clearTimeout(pendingT); pending = null; }
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
  if (!el) { conv.scrollTop = max; return; }
  const delta = el.getBoundingClientRect().top - conv.getBoundingClientRect().top;
  conv.scrollTop = Math.max(0, Math.min(max, conv.scrollTop + delta));
}

if (conv) {
  conv.addEventListener('scroll', () => { if (conv.scrollTop < 80) loadOlder(); }, { passive: true });
  for (const ev of ['touchstart', 'wheel']) conv.addEventListener(ev, () => { settling = false; }, { passive: true });
  // This block's height is whatever the rest of the screen did not need, so it is not settled when
  // the thread first paints into it — and a position taken against the wrong height is a thread
  // parked somewhere nothing afterwards corrects. Re-place it whenever the box itself resizes.
  try {
    new ResizeObserver(() => { if (settling) toLast(); }).observe(conv);
  } catch (_) { /* no ResizeObserver: the paint-time placement is what there is */ }
}

function paintConv(land) {
  if (!conv) return;
  const keep = conv.scrollTop;
  const rows = older.concat(thread);
  conv.innerHTML = rows.map((r, i) => {
    const said = r.role === 'assistant';
    // NO `You` / `Hub` label. The user's own words are dim and the hub's are not, which already says which
    // is which — a word in a gutter said it twice and took the gutter's width off every line.
    // A reply RELAYED FROM A SESSION keeps its name, because that is the one thing the colour cannot
    // carry: it is a machine reporting back, not the hub answering.
    const from = said && r.session ? r.session : null;
    // A reply a fallback engine wrote (credits, Codex) is coloured by it.
    const eng = said && /^(credits|codex)$/.test(r.engine || '') ? ' eng-' + r.engine : '';
    // Where one context ends and the next begins — only between rows, never above the first.
    return (r.ctx && i > 0 ? '<div class="ph-convrule"></div>' : '') +
      `<div class="ph-convline ${said ? 'said' : 'ask'}${from ? ' sess' : ''}${eng}">` +
      (from ? `<span class="ph-convk">${esc(from)}</span>` : '') +
      `<div class="ph-convt">${md(r.text)}</div></div>`;
  }).join('') + (pending
    ? '<div class="ph-convline ask pend"><div class="ph-convt">' +
      (pending.text ? md(pending.text) : '<span class=ph-dots><i></i><i></i><i></i></span>') +
      '</div></div>'
    : '') + (act
    // The lowest line, under the user's words and above nothing: the caret says it is working and the step
    // says what it is doing. Plain text, collapsed and clipped to the one line — a thought arrives as
    // markdown and this is not the surface that reads one.
    ? '<div class="ph-convline work"><div class="ph-convt"><span class="ph-caret">\u258d</span>' +
      '<span class="ph-worktxt">' + esc(act.text) + '</span></div></div>'
    : '');
  // Twice: once now, because the layout is already final after the assignment above, and once on the
  // next frame, because this block's own height is whatever the rest of the screen did not need and
  // is not settled until the flex pass has run.
  if (land) { settling = true; toLast(); requestAnimationFrame(() => { if (settling) toLast(); }); }
  else conv.scrollTop = keep;
}

// The text is kept WHOLE — paragraphs, lists and all. It arrives as markdown and is rendered as
// markdown (`md` in shared.js); collapsing it to one line was reading the SOURCE of a reply rather
// than the reply, with `**bold**` and `- ` left standing in the middle of the prose.
// A row is kept with its context flag even when it has no text, so a photo-only message that opens a
// context still draws the rule — on the next row that does have words.
function rowOf(r) {
  if (r.role !== 'user' && r.role !== 'assistant') return null;
  return { id: r.id, at: r.created_at, role: r.role, text: String(r.text == null ? '' : r.text).trim(),
    session: r.session_id ? (r.session_label || '') : '', engine: r.engine || '', ctx: !!r.ctx_break };
}
function shown(list) {
  const out = [];
  let ctx = false;
  for (const r of list) {
    if (!r) continue;
    ctx = ctx || r.ctx;
    if (!r.text) continue;                 // a photo-only message has nothing to show
    out.push(ctx === r.ctx ? r : { ...r, ctx }); ctx = false;
  }
  return out;
}
function takeRow(r) {
  const row = rowOf(r);
  if (!row) return;
  // A live row that opens a new context (the 4 AM rollover, a reset) moves what was the current
  // context up into the scrolled-back part rather than dropping it.
  if (row.ctx && thread.length) { older = older.concat(thread); thread = []; }
  if (row.text) thread.push(row);
}

// The stretch before the oldest row held, one page further back. Keeps the reader's place: whatever
// was at the top of the box stays where it was, with the older rows landing above it.
async function loadOlder() {
  if (!conv || olderBusy || olderDone) return;
  olderBusy = true;
  try {
    // The first page back starts at the current context's own first row. Unread answers from an
    // earlier context are held ABOVE it (the server keeps them in), and they are about to arrive
    // again in their own place, so they leave the thread here rather than sit out of order.
    if (!older.length) {
      const k = thread.findIndex((x) => x.ctx);
      if (k > 0) thread = thread.slice(k);
    }
    const first = older[0] || thread[0];
    const before = first ? first.at : new Date().toISOString();
    const r = await fetch('/api/voice-messages?focus=hub&mode=active&history=1&limit=' + PAGE +
      '&before=' + encodeURIComponent(before));
    if (!r.ok) throw new Error('voice-messages ' + r.status);
    const rows = await r.json();
    if (!rows.length) { olderDone = true; return; }
    const have = new Set(older.concat(thread).map((x) => x.id));
    const page = shown(rows.map(rowOf).filter((x) => x && !have.has(x.id)));
    // The page's last row was followed by what is now the first one held; that row opens a context
    // exactly when it already says so, so nothing more is needed at the seam.
    const fromBottom = conv.scrollHeight - conv.scrollTop;
    older = page.concat(older);
    if (rows.length < PAGE) olderDone = true;
    paintConv(false);
    conv.scrollTop = conv.scrollHeight - fromBottom;
  } catch (e) {
    console.error('phone conversation: loading earlier messages failed', e);
  } finally { olderBusy = false; }
  // A box that does not overflow has nothing to scroll, so it cannot be scrolled to the top to ask for more.
  if (!olderDone && conv.scrollHeight <= conv.clientHeight) loadOlder();
}

// A fresh load holds only the current context, so the reset gives the scrolled-back part up too.
window.addEventListener('hubreset', () => { older = []; olderDone = false; paintConv(true); });

async function resync() {
  try {
    const rows = await (await fetch('/api/voice-messages?focus=hub&mode=active&limit=' + CTX_MAX)).json();
    thread = shown((rows || []).map(rowOf));
    // What was scrolled back to stays, minus anything the current context now holds itself.
    const have = new Set(thread.map((x) => x.id));
    const start = thread.length ? Date.parse(thread[0].at) : Infinity;
    older = older.filter((x) => !have.has(x.id) && Date.parse(x.at) < start);
    // The placeholder survives a resync unless the row it was standing in for is now in the thread —
    // ANYWHERE in it, not only as the newest message. A command from the watch reaches this page only
    // as its `working` frame, so with the phone asleep its rows arrive here, and by then a later
    // command can be the newest: matched against that alone, the placeholder never came down.
    if (pending && pending.text && thread.some(isPending)) { clearTimeout(pendingT); pending = null; }
    const land = owed && !document.hidden;
    if (land) owed = false;
    paintConv(land);
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
  // Land on home — or, after a reload, on the pane the user was on: the page reloads itself when a deploy
  // makes it stale, on the way back to visible, and a notification tap that has just opened a session
  // is exactly that moment (cards/repos.js keeps the session; this keeps the pane it is on). Unless
  // something has already asked for a pane: a tap on a cold launch can get there before this frame.
  const PANE_KEY = 'hub:pane';
  let landing = 1;
  try { const v = sessionStorage.getItem(PANE_KEY); if (v !== null) landing = +v || 0; } catch (_) {}
  requestAnimationFrame(() => { if (!panes.dataset.chosen) panes.scrollLeft = landing * panes.clientWidth; });
  let paneT = null;
  panes.addEventListener('scroll', () => {
    clearTimeout(paneT);
    paneT = setTimeout(() => {
      try { sessionStorage.setItem(PANE_KEY, String(Math.round(panes.scrollLeft / panes.clientWidth))); } catch (_) {}
    }, 200);
  }, { passive: true });
  // Jump to a named pane. The native app calls this when a widget is tapped, so each widget lands on
  // the part of the hub it actually depicts rather than on whatever pane was last open — the due
  // widget is useless if tapping it drops you on the chat pane.
  window.__showPane = (name) => {
    // The lists are in the calendar sheet here, not a pane of their own.
    if (name === 'todo') return openSection('cal');
    const el = panes.querySelector(`.pane-${String(name).replace(/[^a-z]/g, '')}`);
    if (!el) return false;
    panes.dataset.chosen = '1';
    // scroll-snap owns the physics; setting scrollLeft to the pane's offset lands it exactly.
    panes.scrollTo({ left: el.offsetLeft, behavior: 'smooth' });
    return true;
  };
}
