// The home wall's own middle. Everything else on this page is a shared card that core.js already
// paints; only two things are this wall's: the day column it mounts, and the session panel.
//
// DISPLAY ONLY, like every wall. Nothing here is interactive and nothing here writes — voice starts
// sessions, voice focuses them, and this is where the answer comes back.
import { esc, liveStream } from './shared.js';
import { mount } from './cards/dayline.js';

// The month grid is the calendar wall's; this column takes the day on its own, which is what
// `?day=1` serves.
mount(document.getElementById('cw-day'));

const REFRESH_MS = 5000;
const LIST_MAX = 5;      // enough to see what is running without the list becoming the column

/**
 * Which session the panel opens: the FOCUSED one — the session a spoken follow-up lands in, so what
 * the wall is showing and what he is about to talk to are the same session.
 *
 * `focus` is null when nothing has been dispatched or focused, or when the pointer names a session
 * that has since closed; then it falls back to the newest running one, so the panel says something
 * rather than nothing. The list marks whichever is being shown — one highlight meaning "this is the
 * answer below", never a second one claiming to mean focus, which the footer already carries.
 */
const shown = (d) => (d.resident || []).find((s) => s.id === d.focus) || (d.resident || [])[0]
  || (d.evicted || [])[0] || null;

// Running first, then parked, newest first within each — `n` is the number he says out loud, worked
// out by the server so every surface counts the same way. Ordering the list by it means "the second
// session" points at the second line.
const listed = (d) => [...(d.resident || []), ...(d.evicted || [])]
  .sort((a, b) => (a.n || 99) - (b.n || 99)).slice(0, LIST_MAX);

const name = (s) => s.custom_title || s.label || s.repo;

// What each session is doing right now, keyed by id and held between polls: `/api/sessions` knows
// nothing about tool calls, so a re-render would wipe the line the moment the list refreshed.
// Transient by nature — the last thing said is the only thing worth a row's second line, and it is
// replaced, never accumulated.
const activity = new Map();   // session id -> { state, text }

function rowActivity(s) {
  const a = activity.get(s.id);
  // The line is ALWAYS rendered, empty or not. Growing a row when a tool fires and collapsing it when
  // one stops would make the whole list jump every few seconds, which is unreadable across a room.
  if (!a) return '<span class="hw-row-act idle"></span>';
  return `<span class="hw-row-act ${a.state === 'done' ? 'done' : 'tool'}">${esc(a.text)}</span>`;
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
        `<span class="hw-row-name">${esc(name(s))}</span>` +
        `<span class="hw-row-where">${s.worker === 'desk' ? 'Mac' : 'Pi'}</span>` +
      '</div>' +
      rowActivity(s) +
    '</div>').join('');

  // Nothing running and nothing parked is a real state, and an empty panel is its honest rendering.
  if (!on) { head.innerHTML = ''; reply.textContent = ''; return; }
  head.innerHTML = `<span class="hw-sess-name">${esc(name(on))}</span>` +
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
