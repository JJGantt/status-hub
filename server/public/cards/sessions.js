// What Claude sessions are running, and what the focused one last said.
//
// ONE implementation for every surface that shows it — the home wall's right column and the phone's
// home column. They differ in which ELEMENTS they hand over: the wall gives a list, a head and a
// reply panel; the phone gives a list alone, because a phone has nowhere to put a model's answer and
// the list is the part a glance is for. Nothing else differs, which is the point — the numbering, the
// ordering, the highlight and the activity line are what "the second session" means out loud, and two
// copies of that is two surfaces that can disagree about which session is the second one.
//
// DISPLAY ONLY. Voice starts sessions, voice focuses them; this is where the answer comes back.
import { esc, liveStream, PIN_SVG } from '../shared.js';

// A BACKSTOP, not the mechanism: every change arrives as a `sessions` frame the moment it happens.
// This only covers what a dropped frame or a reconnect would lose. At 5s it was ~76k Supabase reads a
// day to watch a list that changed about six times.
const REFRESH_MS = 5 * 60 * 1000;

/**
 * Which session the panel opens: the FOCUSED one — the session a spoken follow-up lands in, which is
 * the most recently active unless he pinned one — so what the surface is showing and what he is about
 * to talk to are the same session.
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
const listed = (d, max) => [...(d.resident || []), ...(d.evicted || [])]
  .sort((a, b) => (a.n || 99) - (b.n || 99)).slice(0, max);

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
  // reads as a session that has done nothing. The surface is also blank on arrival otherwise, since
  // live frames only start once it is watching.
  const a = activity.get(s.id);
  const live = a && (a.state === 'tool' || a.state === 'text');
  const text = oneLine(live ? a.text : ((a && a.text) || s.last_reply));
  // The line is ALWAYS rendered, empty or not. Growing a row when a tool fires and collapsing it when
  // one stops would make the whole list jump every few seconds, which is unreadable at any size.
  if (!text) return '<span class="hw-row-act idle"></span>';
  return `<span class="hw-row-act ${live ? a.state : 'done'}">${esc(text)}</span>`;
}

const panels = [];   // every mounted panel: { list, head, reply, max }
let last = null;     // the most recent /api/sessions payload, so an activity frame can repaint alone

function render(d) {
  if (d) last = d;
  d = last;
  if (!d) return;
  for (const p of panels) paint(p, d);
}

function paint(p, d) {
  const on = shown(d);
  if (p.list) {
    p.list.innerHTML = listed(d, p.max).map((s) =>
      // `on` is the FOCUSED session — where a spoken follow-up goes, and what a surface with a reply
      // panel is showing below. `unread` is a finished answer nobody has opened. Two different
      // questions, so two different marks: one row can carry both.
      `<div class="hw-row${on && s.id === on.id ? ' on' : ''}${s.unread ? ' unread' : ''}` +
        '"' +
        `${p.tap ? ` data-open="${esc(String(s.id))}"` : ''}>` +
        '<div class="hw-row-top">' +
          `<span class="hw-sess-dot${s.working ? '' : ' idle'}"></span>` +
          `<span class="hw-row-n">${s.n ?? ''}</span>` +
          `<span class="hw-row-name">${pinMark(d, s)}${esc(name(s))}</span>` +
          `<span class="hw-row-where">${s.worker === 'desk' ? 'Mac' : s.worker === 'fly-desk' ? 'Fly' : 'Pi'}</span>` +
        '</div>' +
        rowActivity(s) +
      '</div>').join('');
  }
  if (!p.head && !p.reply) return;
  // Nothing running and nothing parked is a real state, and an empty panel is its honest rendering.
  if (!on) {
    if (p.head) p.head.innerHTML = '';
    if (p.reply) p.reply.textContent = '';
    return;
  }
  if (p.head) {
    p.head.innerHTML = `<span class="hw-sess-name">${pinMark(d, on)}${esc(name(on))}</span>` +
      `<span class="hw-sess-where">${esc(on.repo)} · ${on.worker === 'desk' ? 'Mac' : on.worker === 'fly-desk' ? 'Fly' : 'Pi'}</span>`;
  }
  // textContent, not innerHTML: a reply is a model's prose and may hold anything that looks like
  // markup. The panel scrolls rather than truncating — however long the answer is, it is the answer.
  if (p.reply) p.reply.textContent = (on.last_reply || '').trim();
}

async function load() {
  try { render(await (await fetch('/api/sessions')).json()); }
  catch (_) { /* a failed poll leaves the last frame up; the next one reconciles */ }
}

let started = false;

/**
 * Mount a sessions panel. `list` is the numbered list of what is running; `head` and `reply` are the
 * focused session's name and its last answer, and a surface with no room for an answer simply omits
 * them. `max` is how many rows the list holds — the wall keeps it to three because the room it was
 * taking above the answer is worth more to the answer, and a surface with no answer under it can
 * afford more.
 */
export function mountSessions({ list = null, head = null, reply = null, max = 3, tap = false } = {}) {
  if (!list && !head && !reply) return;
  panels.push({ list, head, reply, max, tap });
  // `tap` opens the row in the session VIEW — the one the repos pane already has, with the whole
  // conversation and a composer. A wall never asks for it (nothing is standing at one to tap), and
  // this is a delegate rather than a listener per row because the list is rebuilt on every frame.
  if (tap && list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-open]');
      if (row && window.__showSession) window.__showSession(row.dataset.open);
    });
  }
  if (last) render(null);
  if (started) return;
  started = true;
  load();
  // The poll is a BACKSTOP, not the mechanism. Tool calls and finished turns arrive by push the
  // moment they happen; this catches what a dropped frame or a reconnect would otherwise lose, and
  // carries the things no event announces — a session dying, the focus moving, the numbering changing.
  setInterval(load, REFRESH_MS);
  liveStream('/api/session-stream', {
    // THE MECHANISM: the whole list, queue and focus, pushed when any of them changes — a session
    // starting or dying, the focus moving, the numbering changing, a turn's reply landing.
    sessions: (e) => { try { render(JSON.parse(e.data)); } catch (_) {} },
    // Live activity from either machine, one event of a conversation's list (server.js, the event
    // log): a tool call or in-between text is the row's live line; a prompt or a reply, the last thing
    // said. A finished turn also repaints from the `sessions` frame that follows its write.
    ev: (e) => {
      let a;
      try { a = JSON.parse(e.data); } catch { return; }
      if (!a || !a.ev) return;
      const live = a.ev.kind === 'tool' || a.ev.kind === 'text';
      activity.set(a.session, { state: live ? a.ev.kind : 'done', text: a.ev.text });
      render(null);
    },
  });
}
