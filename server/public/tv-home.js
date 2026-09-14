// The home wall's own middle. Everything else on this page is a shared card that core.js already
// paints; only two things are this wall's: the day columns it mounts, and the session panel.
//
// DISPLAY ONLY, like every wall. Nothing here is interactive and nothing here writes — voice starts
// sessions, voice focuses them, and this is where the answer comes back.
import { esc, liveStream, PIN_SVG } from './shared.js';
import { mount } from './cards/dayline.js';

// The month grid is the calendar wall's; this column takes the day on its own. `full=1` for the
// whole clock rather than 7a-10p, because the dial centres on now and needs something to show in
// both directions — by evening the short range has nothing left below the line.
//
// `ahead=6` carries the six days after today in the SAME response, painted into the column beside
// it. One fetch and one reload for both: they answer one question between them, and two of them
// re-reading on their own clocks is two chances to be showing different days at the same moment.
mount(document.getElementById('cw-day'), {
  // SEVEN, not six. The first day back is TODAY and it feeds the dock at the bottom of the dial
  // (see paintDock in cards/dayline.js); the look-ahead column draws the six after it.
  url: '/api/calendar?day=1&full=1&ahead=7',
  dial: true,
  ahead: document.getElementById('cw-week'),
  dock: true,
});

const REFRESH_MS = 5000;
// Three, not five. The list is a glance at what is running; the room it was taking above the answer
// is worth more to the answer, which is the thing on this column actually read word by word.
const LIST_MAX = 3;

/**
 * Which session the panel opens: the FOCUSED one — the session a spoken follow-up lands in, which is
 * the most recently active unless he pinned one — so what the wall is showing and what he is about to
 * talk to are the same session.
 *
 * `focus` is null only while a dispatch is still opening or when nothing is running; then it falls
 * back to the first running one, else the most recent parked one, so the panel says something rather
 * than nothing. The list marks whichever is being shown — one highlight meaning "this is the answer
 * below", never a second one claiming to mean focus, which the footer already carries.
 */
const shown = (d) => (d.resident || []).find((s) => s.id === d.focus) || (d.resident || [])[0]
  || (d.evicted || [])[0] || null;

// Running first, then parked, most recently active first within each — `n` is the number he says out
// loud, worked out by the server so every surface counts the same way. Ordering the list by it means
// "the second session" points at the second line.
const listed = (d) => [...(d.resident || []), ...(d.evicted || [])]
  .sort((a, b) => (a.n || 99) - (b.n || 99)).slice(0, LIST_MAX);

const name = (s) => s.custom_title || s.label || s.repo;
// A pinned session carries the pin wherever it is named; automatic focus carries nothing extra.
const pinMark = (d, s) => (d.pinned && s.id === d.focus ? PIN_SVG : '');

// What each session is doing right now, keyed by id and held between polls: `/api/sessions` knows
// nothing about tool calls, so a re-render would wipe the line the moment the list refreshed.
// Transient by nature — the last thing said is the only thing worth a row's second line, and it is
// replaced, never accumulated.
const activity = new Map();   // session id -> { state, text }

// One line, collapsed: a reply arrives with its paragraphs intact and this is a single row.
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();

function rowActivity(s) {
  // Live first — a tool call in flight, or what the session said between two of them, is the most
  // current thing it has to say. Falling back to `last_reply` is what makes a quiet session say
  // anything at all: nothing is streaming to it, but it still answered something, and a blank line
  // reads as a session that has done nothing. The wall is also blank on arrival otherwise, since live
  // frames only start once it is watching.
  const a = activity.get(s.id);
  const live = a && (a.state === 'tool' || a.state === 'text');
  const text = oneLine(live ? a.text : ((a && a.text) || s.last_reply));
  // The line is ALWAYS rendered, empty or not. Growing a row when a tool fires and collapsing it when
  // one stops would make the whole list jump every few seconds, which is unreadable across a room.
  if (!text) return '<span class="hw-row-act idle"></span>';
  return `<span class="hw-row-act ${live ? a.state : 'done'}">${esc(text)}</span>`;
}

let last = null;   // the most recent /api/sessions payload, so an activity frame can repaint alone

function render(d) {
  if (d) last = d;
  d = last;
  if (!d) return;
  const list = document.getElementById('hw-sess-list');
  const head = document.getElementById('hw-sess-head');
  const reply = document.getElementById('hw-sess-reply');
  if (!list || !head || !reply) return;
  const on = shown(d);

  list.innerHTML = listed(d).map((s) =>
    `<div class="hw-row${on && s.id === on.id ? ' on' : ''}${s.status === 'resident' ? '' : ' parked'}">` +
      '<div class="hw-row-top">' +
        `<span class="hw-sess-dot${s.working ? '' : ' idle'}"></span>` +
        `<span class="hw-row-n">${s.n ?? ''}</span>` +
        `<span class="hw-row-name">${pinMark(d, s)}${esc(name(s))}</span>` +
        `<span class="hw-row-where">${s.worker === 'desk' ? 'Mac' : 'Pi'}</span>` +
      '</div>' +
      rowActivity(s) +
    '</div>').join('');

  // Nothing running and nothing parked is a real state, and an empty panel is its honest rendering.
  if (!on) { head.innerHTML = ''; reply.textContent = ''; return; }
  head.innerHTML = `<span class="hw-sess-name">${pinMark(d, on)}${esc(name(on))}</span>` +
    `<span class="hw-sess-where">${esc(on.repo)} · ${on.worker === 'desk' ? 'Mac' : 'Pi'}</span>`;
  // textContent, not innerHTML: a reply is a model's prose and may hold anything that looks like
  // markup. The panel scrolls rather than truncating — however long the answer is, it is the answer.
  reply.textContent = (on.last_reply || '').trim();
}

async function load() {
  try { render(await (await fetch('/api/sessions')).json()); }
  catch (_) { /* a failed poll leaves the last frame up; the next one reconciles */ }
}

load();
// The poll is now a BACKSTOP, not the mechanism. Tool calls and finished turns arrive by push the
// moment they happen; this catches what a dropped frame or a reconnect would otherwise lose, and
// carries the things no event announces — a session dying, the focus moving, the numbering changing.
setInterval(load, REFRESH_MS);

// Live activity from either machine. A finished turn repaints immediately with the reply it carries,
// rather than waiting for the poll to fetch a `last_reply` that has already been written.
liveStream('/api/session-stream', { session: (e) => {
  let a;
  try { a = JSON.parse(e.data); } catch { return; }
  activity.set(a.session, { state: a.state, text: a.text });
  if (a.state === 'done') load(); else render(null);
} });
