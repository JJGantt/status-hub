// What Claude sessions are running, and what the focused one last said.
//
// ONE implementation for every surface that shows it — the home wall's right column and the phone's
// home column. They differ in which ELEMENTS they hand over: the wall gives a list, a head and a
// reply panel; the phone gives a list alone, because a phone has nowhere to put a model's answer and
// the list is the part a glance is for. Nothing else differs, which is the point — the ordering, the
// highlight and the activity line are shared, and two copies of them are two surfaces that disagree.
//
// DISPLAY ONLY. Voice starts sessions, voice focuses them; this is where the answer comes back.
import { esc, md, liveStream, PIN_SVG, toolParts } from '../shared.js';

// A BACKSTOP, not the mechanism: every change arrives as a `sessions` frame the moment it happens.
// This only covers what a dropped frame or a reconnect would lose. At 5s it was ~76k Supabase reads a
// day to watch a list that changed about six times.
const REFRESH_MS = 5 * 60 * 1000;

/**
 * Which session the panel opens: the FOCUSED one — the session a spoken follow-up lands in, which is
 * the most recently active unless the user pinned one — so what the surface is showing and what the user is about
 * to talk to are the same session.
 *
 * `focus` is null only while a dispatch is still opening or when nothing is running; then it falls
 * back to the first running one, else the most recent parked one, so the panel says something rather
 * than nothing. The list marks whichever is being shown — one highlight meaning "this is the answer
 * below", never a second one claiming to mean focus, which the footer already carries.
 */
const shown = (d) => (d.resident || []).find((s) => s.id === d.focus) || (d.resident || [])[0]
  || (d.evicted || [])[0] || null;

// In the server's `n` order (pins first, then most recently active), so every surface lists the same
// sessions in the same order. The number itself is not drawn.
const listed = (d, max) => [...(d.resident || []), ...(d.evicted || [])]
  .sort((a, b) => (a.n || 99) - (b.n || 99)).slice(0, max);

const name = (s) => s.custom_title || s.label || s.repo;
// A pinned session carries the pin wherever it is named; automatic focus carries nothing extra.
const pinMark = (d, s) => (s && s.pinned ? PIN_SVG : '');

// What each session is doing right now, keyed by id and held between polls: `/api/sessions` knows
// nothing about tool calls, so a re-render would wipe the line the moment the list refreshed.
// Transient by nature — the last thing said is the only thing worth a row's second line, and it is
// replaced, never accumulated.
const activity = new Map();   // session id -> { state, text }

// One line, collapsed: a reply arrives with its paragraphs intact and this is a single row.
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();

function rowActivity(s) {
  // Stopped on a permission dialog: that IS what it is doing, and the one thing on the row owed an
  // answer. The line is the call it wants to make; the session view has the buttons.
  if (s.prompt) return `<span class="hw-row-act asking">${esc(oneLine(s.prompt.line))}</span>`;
  // Live first — a tool call in flight, or what the session said between two of them, is the most
  // current thing it has to say. Falling back to `last_reply` is what makes a quiet session say
  // anything at all: nothing is streaming to it, but it still answered something, and a blank line
  // reads as a session that has done nothing. The surface is also blank on arrival otherwise, since
  // live frames only start once it is watching.
  // While a turn runs, the line is what it is on NOW and never the reply to the turn before: a live frame
  // heard since the page opened, else the server's `live`, which is the same thing for a page that opened
  // mid-turn and has heard no frame yet.
  let a = activity.get(s.id);
  const heard = a && (a.state === 'tool' || a.state === 'text');
  if (s.working && !heard && s.live) a = { state: s.live.kind === 'prompt' ? 'done' : s.live.kind, text: s.live.text };
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
      `<div class="hw-row${on && s.id === on.id ? ' on' : ''}${s.unread ? ' unread' : ''}${s.working ? ' working' : ''}${s.incident ? ' incident' : ''}${s.codex ? ' codex' : ''}${s.prompt ? ' asking' : ''}` +
        '"' +
        (s.machine_color ? ` style="--mc:${esc(s.machine_color)}"` : '') +
        `${p.tap ? ` data-open="${esc(String(s.id))}"` : ''}>` +
        '<div class="hw-row-top">' +
          `<span class="hw-sess-dot${s.working ? '' : ' idle'}"></span>` +
          `<span class="hw-row-name">${pinMark(d, s)}${esc(name(s))}</span>` +
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
  if (p.reply) paintTurn(p.reply, on);
}

// ---- the focused session's turn, in the reply panel ---------------------------------------------
//
// While a turn runs, the panel is that turn as it happens: what was said to the session, then every
// tool call and every note between them, newest at the bottom and the panel held there. When it ends,
// the panel is the answer, from its first line, scrolled rather than cut however long it is. Only a
// surface with a reply panel follows the conversation; the phone's list alone never fetches it.
//
// The events are the conversation's own list (routes/conversation.js): loaded whole when the focus
// moves or the stream reconnects, then extended by each `ev` frame. A frame that skips a sequence
// number, or a new epoch, means something was missed, and the list is loaded again.
const turn = { row: null, conv: null, epoch: null, events: [] };

function absorb(list) {
  const by = new Map(turn.events.map((e) => [e.seq, e]));
  for (const e of list || []) if (e && Number.isFinite(e.seq)) by.set(e.seq, e);
  turn.events = [...by.values()].sort((a, b) => a.seq - b.seq);
}

async function loadTurn(id) {
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(id));
    if (!r.ok) return;
    const d = await r.json();
    if (id !== turn.row) return;
    if (d.epoch !== turn.epoch) turn.events = [];
    turn.epoch = d.epoch;
    turn.conv = d.claude_session_id || d.id;   // the key `ev` frames carry (routes/conversation.js rowConv)
    absorb(d.events);
    render(null);
  } catch (_) { /* the stream's reconnect loads it again */ }
}

function follow(id) {
  if (!id || id === turn.row) return;
  Object.assign(turn, { row: id, conv: null, epoch: null, events: [] });
  loadTurn(id);
}

// The running turn's events: from its prompt (its latest copy — a prompt moves from queued to read) on.
// Null when the newest event is a reply, i.e. no turn is running.
function running() {
  const ev = turn.events;
  if (!ev.length || ev[ev.length - 1].kind === 'reply') return null;
  let i = ev.length - 1;
  while (i > 0 && ev[i - 1].kind !== 'reply') i--;
  const seen = new Set(), out = [];
  for (let j = ev.length - 1; j >= i; j--) {
    const e = ev[j];
    if (e.kind === 'prompt') { if (seen.has(e.id)) continue; seen.add(e.id); }
    out.push(e);
  }
  return out.reverse().slice(-80);
}

function turnHtml(list) {
  return '<div class="sess-turn">' + list.map((e) => {
    if (e.kind === 'prompt') return `<div class="sess-turn-words">${esc(e.text || '')}</div>`;
    if (e.kind === 'text') return `<div class="sess-turn-text">${md(String(e.text || '').trim())}</div>`;
    const { head, args } = toolParts(e.text);
    return `<div class="sess-turn-tool">${esc(head)}${args ? `<div class="sess-turn-args">${esc(args)}</div>` : ''}</div>`;
  }).join('') + '<div class="sess-turn-caret">▍</div></div>';
}

function paintTurn(el, on) {
  follow(on.id);
  const live = turn.row === on.id ? running() : null;
  if (live) {
    el.innerHTML = turnHtml(live);
    el.scrollTop = el.scrollHeight;
    el.dataset.view = 'turn';
    return;
  }
  // textContent, not innerHTML: a reply is a model's prose and may hold anything that looks like
  // markup. The panel scrolls rather than truncating — however long the answer is, it is the answer.
  const text = (on.last_reply || '').trim();
  if (el.dataset.view !== 'reply' || el.textContent !== text) {
    el.textContent = text;
    el.scrollTop = 0;
  }
  el.dataset.view = 'reply';
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
    // The TV Guide's shelves changed (routes/tv.js): passed on to cards/guide.js, which has no stream.
    guide: () => window.dispatchEvent(new Event('hub:guide')),
    // Live activity from either machine, one event of a conversation's list (routes/conversation.js, the event
    // log): a tool call or in-between text is the row's live line; a prompt or a reply, the last thing
    // said. A finished turn also repaints from the `sessions` frame that follows its write.
    ev: (e) => {
      let a;
      try { a = JSON.parse(e.data); } catch { return; }
      if (!a || !a.ev) return;
      const live = a.ev.kind === 'tool' || a.ev.kind === 'text';
      activity.set(a.session, { state: live ? a.ev.kind : 'done', text: a.ev.text });
      if (turn.conv && a.conversation === turn.conv) {
        const lastSeq = turn.events.length ? turn.events[turn.events.length - 1].seq : 0;
        if (a.epoch !== turn.epoch || a.ev.seq > lastSeq + 1) loadTurn(turn.row);
        else absorb([a.ev]);
      }
      render(null);
    },
  }, { onOpen: () => { if (turn.row) loadTurn(turn.row); } });
}
