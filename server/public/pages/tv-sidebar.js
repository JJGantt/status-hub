// Entry for tv-sidebar.html: one conversation, drawn narrow and see-through for the bedroom TV's
// overlay (google-tv repo). Display only — the TV's remote drives the app underneath, never this.
//
// Which one is `sidebar_view` on the sessions frame (the tv_sidebar_view setting, written when a
// `sidebar` command names a view): the focused session, or the voice orchestrator's conversation,
// which is the CURRENT context of the voice thread (/api/voice-messages?mode=active, the watch's view).
//
// It shows the FOCUSED session (pickFocus in server.js): where a spoken follow-up goes, so it follows
// whatever he is working in. The `sessions` frame on the stream carries focus, so a change moves it.
// Its own small renderer rather than cards/repos.js, which carries a composer, a recorder and a list.
import { esc, md, liveStream } from '../shared.js';

let rowId = null, conv = null, epoch = null, events = [];

const nameEl = document.getElementById('sb-name');
const body = document.getElementById('sb-body');

function absorb(list) {
  const by = new Map(events.map((e) => [e.seq, e]));
  for (const e of list || []) if (e && Number.isFinite(e.seq)) by.set(e.seq, e);
  events = [...by.values()].sort((a, b) => a.seq - b.seq);
}

// A prompt is drawn at its LATEST occurrence, as everywhere else (it moves from queued to read).
function shown() {
  const seen = new Set(), out = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'prompt') { if (seen.has(e.id)) continue; seen.add(e.id); }
    out.push(e);
  }
  return out.reverse();
}

// The box is anchored to its bottom (justify-content:flex-end, overflow hidden): the newest thing is
// always on screen and older turns fall off the top. Only the tail is drawn, since nothing scrolls.
function paint() {
  const list = shown().slice(-40);
  const working = list.length > 0 && list[list.length - 1].kind !== 'reply';
  body.innerHTML = list.map((e) =>
    e.kind === 'prompt' ? `<div class="sb-words">${esc(e.text || '')}</div>`
    : e.kind === 'reply' ? `<div class="sb-reply">${md(String(e.text || '').trim())}</div>`
    : e.kind === 'text' ? `<div class="sb-thought">${md(e.text || '')}</div>`
    : `<div class="sb-tool">${esc(e.text || '')}</div>`).join('') +
    (working ? '<div class="sb-caret">▍</div>' : '');
}

async function load(id) {
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(id));
    if (!r.ok) return;
    const d = await r.json();
    if (id !== rowId) return;
    if (d.epoch !== epoch) events = [];
    epoch = d.epoch;
    conv = d.claude_session_id || d.id;   // the conversation key the stream frames carry (server.js rowConv)
    nameEl.textContent = d.custom_title || d.label || d.repo || '';
    absorb(d.events);
    paint();
  } catch (_) { /* the stream's reconnect reloads */ }
}

function focusOn(id) {
  if (!id || id === rowId) return;
  rowId = id; conv = null; events = [];
  load(id);
}

const vo = document.getElementById('vo');
const ss = document.getElementById('ss');
let view = 'session';

function frame(d) {
  if (!d) return;
  view = d.sidebar_view === 'orchestrator' ? 'orchestrator' : 'session';
  vo.hidden = view !== 'orchestrator';
  ss.hidden = view === 'orchestrator';
  if (view === 'orchestrator') loadVoice();
  focusOn(d.focus);
}

async function boot() {
  try {
    const r = await fetch('/api/sessions?brief=1');
    if (r.ok) frame(await r.json());
  } catch (_) {}
}

liveStream('/api/session-stream', {
  sessions: (e) => { try { frame(JSON.parse(e.data)); } catch (_) {} },
  ev: (e) => {
    let a; try { a = JSON.parse(e.data); } catch (_) { return; }
    if (!a || !a.ev || !conv || a.conversation !== conv) return;
    if (a.session && a.session !== rowId) rowId = a.session;
    const last = events.length ? events[events.length - 1].seq : 0;
    if (a.epoch !== epoch || a.ev.seq > last + 1) { load(rowId); return; }
    absorb([a.ev]);
    paint();
  },
}, { onOpen: () => { if (rowId) load(rowId); } });

// ---- the orchestrator ----------------------------------------------------------------------------
const voBody = document.getElementById('vo-body');

// Refetched on each voice frame rather than patched: the server owns which rows are the current
// context (opensContext, reset, unread answers, agent_mode), and a frame arrives only when something
// was said, so this is one request per message.
let voBusy = false, voAgain = false;
async function loadVoice() {
  if (view !== 'orchestrator') return;
  if (voBusy) { voAgain = true; return; }
  voBusy = true;
  try {
    const r = await fetch('/api/voice-messages?focus=hub&mode=active&limit=40');
    if (r.ok) paintVoice((await r.json()).filter((m) => m.role === 'user' || m.role === 'assistant'));
  } catch (_) { /* the stream's reconnect reloads */ }
  voBusy = false;
  if (voAgain) { voAgain = false; loadVoice(); }
}

function paintVoice(rows) {
  const last = rows[rows.length - 1];
  const working = !!last && (last.role === 'user' || !String(last.text || '').trim());
  voBody.innerHTML = rows.slice(-40).map((m) => m.role === 'user'
    ? `<div class="sb-words">${esc(m.text || '')}</div>`
    : `<div class="sb-reply">${md(String(m.text || '').trim())}</div>`).join('') +
    (working ? '<div class="sb-caret">▍</div>' : '');
}

liveStream('/api/voice-stream', {
  voice: (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m && (m.kind === 'message' || m.kind === 'reset')) loadVoice();
  },
}, { onOpen: loadVoice });

boot();
