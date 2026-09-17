// The phone home page's own middle. Everything else on it is a shared card core.js already paints;
// this file holds the three things that are this surface's — today's strip, the session list, the
// tail of the conversation — plus the swipe panes around them.
//
// It is the phone's analogue of tv-home.js. Where the wall gives a column to today's dial and a
// column to the focused session's whole answer, this gives neither: a phone is read at arm's length
// for a few seconds, so the day lies down and a session is a title with a line under it.
import { esc } from './shared.js';
import { mount } from './cards/dayline.js';
import { mountStrip } from './cards/daystrip.js';
import { mountSessions } from './cards/sessions.js';
import { onThread } from './voiceagent.js';

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

// ---- what is running -----------------------------------------------------
//
// Three rows, the same as the wall. A fourth fits only by taking both lines of every row down to
// where the activity line under the title stops being readable, and that line is the whole reason
// the list is here rather than a count.
mountSessions({ list: document.getElementById('ph-sess-list'), max: 3 });

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
  const line = (kind, label, text) => (text
    ? `<div class="ph-convline ${kind}"><span class="ph-convk">${label}</span>` +
      `<span class="ph-convt">${esc(text)}</span></div>` : '');
  conv.innerHTML = line('ask', 'You', lastAsk) + line('said', 'Hub', lastSaid);
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
