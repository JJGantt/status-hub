// The phone home page's own middle. Everything else on it is a shared card core.js already paints;
// this file holds the four things that are this surface's — the week, the overdue strip, the session
// list and the tail of the conversation — plus the swipe panes around them.
//
// It is the phone's analogue of tv-home.js. Where the wall gives a column to today's dial and a
// column to the focused session's whole answer, this gives neither: a phone is read at arm's length
// for a few seconds, so a day is a list and a session is a title with a line under it.
import { esc } from './shared.js';
import { mount, chip } from './cards/dayline.js';
import { mountSessions } from './cards/sessions.js';
import { onThread } from './voiceagent.js';

// ---- the week, and what is already late ----------------------------------
//
// SEVEN days starting today, as a list of days (cards/dayline.js). `full=1` is not for a dial here —
// there is none — it is what makes the response carry `overdue`, which is the other half of the
// answer: everything red and still open, on any day, which nothing else on this page would say
// exists. One request for both, so the two cannot disagree about which day it is.
const week = document.getElementById('cw-week');
const od = document.getElementById('ph-overdue');

// Four, then a count. A phone's overdue strip is a prompt to open the lists pane, not the list
// itself — past four rows it stops being a glance and starts being the thing it is pointing at.
const OVERDUE_MAX = 4;

// Oldest first, the way the server sends them, and the OLDEST are the ones that collapse into the
// +N: the rows worth keeping are the ones nearest the day they came off.
function paintOverdue(items) {
  if (!od) return;
  const all = items || [];
  if (!all.length) { od.innerHTML = ''; return; }
  const shown = all.slice(-OVERDUE_MAX);
  const more = all.length - shown.length;
  od.innerHTML = shown.map((it, k) =>
    '<div class="ph-odrow">' +
      `<span class="ph-odwhen">${esc(it.when || '')}</span>` +
      chip(it, true) +
      (k === 0 && more ? `<span class="cw-more">+${more}</span>` : '') +
    '</div>').join('');
}

mount(null, {
  url: '/api/calendar?day=1&full=1&ahead=7',
  ahead: week,
  onload: (d) => paintOverdue(d.overdue),
});

// ---- what is running -----------------------------------------------------
//
// Four rows, one more than the wall keeps. The wall spends its fourth on the focused session's
// answer; this column has no answer under it to protect, so the room goes back to the list.
mountSessions({ list: document.getElementById('ph-sess-list'), max: 4 });

// ---- the tail of the conversation ----------------------------------------
//
// The last thing he asked and the last thing that came back, and nothing else. The whole thread with
// its composer is one swipe left; this is here so the home column says what the hub is in the middle
// of without having to leave it.
//
// Rows arrive through voiceagent's own stream (onThread), never a second EventSource — and `null`
// means resync, which is when the current context is re-read. `mode=active` resolves hub vs agent on
// the server, which is the same rule the conversation card follows.
const conv = document.getElementById('ph-conv');
let lastAsk = null, lastSaid = null;

function paintConv() {
  if (!conv) return;
  const row = (kind, label, text) => (text
    ? `<div class="ph-convrow ${kind}"><span class="ph-convk">${label}</span>` +
      `<span class="ph-convt">${esc(text)}</span></div>` : '');
  conv.innerHTML = row('ask', 'You', lastAsk) + row('said', 'Hub', lastSaid);
}

// One line, collapsed: a reply arrives with its paragraphs intact and this is a single row.
const oneLine = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

function takeRow(r) {
  const t = oneLine(r.text);
  if (!t) return;                       // a photo-only message has no line to show
  if (r.role === 'user') lastAsk = t;
  else if (r.role === 'assistant') lastSaid = t;
}

async function resync() {
  try {
    const rows = await (await fetch('/api/voice-messages?focus=hub&mode=active&limit=40')).json();
    lastAsk = lastSaid = null;
    for (const r of rows || []) takeRow(r);
    paintConv();
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
