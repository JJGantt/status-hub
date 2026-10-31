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
// Tool calls are not listed: while a turn runs, only the one in progress is drawn, above the caret, and
// each new call replaces it. Every other surface lists them all; the TV wants a sign of life, not a log.
const toolLine = (t) => (t ? `<div class="sb-tool">${esc(t)}</div>` : '');

function paint() {
  const all = shown();
  const working = all.length > 0 && all[all.length - 1].kind !== 'reply';
  let tool = null;
  if (working) {
    for (let i = all.length - 1; i >= 0 && all[i].kind !== 'prompt'; i--) {
      if (!['reply', 'text'].includes(all[i].kind)) { tool = all[i].text; break; }
    }
  }
  const list = all.filter((e) => ['prompt', 'reply', 'text'].includes(e.kind)).slice(-40);
  body.innerHTML = list.map((e) =>
    e.kind === 'prompt' ? `<div class="sb-words">${esc(e.text || '')}</div>`
    : e.kind === 'reply' ? `<div class="sb-reply">${md(String(e.text || '').trim())}</div>`
    : `<div class="sb-thought">${md(e.text || '')}</div>`).join('') +
    (working ? toolLine(tool) + '<div class="sb-caret">▍</div>' : '');
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

let build = null;
function frame(d) {
  if (!d) return;
  // A deploy reaches the server, not an open page: reload when the build changes.
  if (d.commit) { if (build && d.commit !== build) { location.reload(); return; } build = d.commit; }
  view = d.sidebar_view === 'orchestrator' ? 'orchestrator' : 'session';
  if (Number(d.sidebar_font) > 0) document.body.style.fontSize = d.sidebar_font + 'px';
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
    const [r, q] = await Promise.all([fetch('/api/voice-messages?focus=hub&mode=active&limit=40'), fetch('/api/voice-pending')]);
    if (r.ok) voRows = (await r.json()).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (q.ok) { pending.clear(); for (const p of await q.json()) pending.set(p.id, p); }
    paintVoice();
  } catch (_) { /* the stream's reconnect reloads */ }
  voBusy = false;
  if (voAgain) { voAgain = false; loadVoice(); }
}

// His words are drawn from the request the moment it is created (`request` frames, /api/voice-pending)
// and handed over to the conversation row once that exists, which is only when the answer lands.
let voRows = [];
let voTool = null;   // the orchestrator's tool call in progress, from `activity` frames
const pending = new Map();   // request id -> { id, text, status }

function paintVoice() {
  const answered = new Set(voRows.map((m) => m.request_id).filter(Boolean));
  for (const id of [...pending.keys()]) if (answered.has(id)) pending.delete(id);
  const last = voRows[voRows.length - 1];
  const working = pending.size > 0 || (!!last && (last.role === 'user' || !String(last.text || '').trim()));
  voBody.innerHTML = voRows.slice(-40).map((m) => m.role === 'user'
    ? `<div class="sb-words">${esc(m.text || '')}</div>`
    : `<div class="sb-reply">${md(String(m.text || '').trim())}</div>`).join('') +
    [...pending.values()].map((p) => `<div class="sb-words">${esc(p.text)}</div>`).join('') +
    (working ? toolLine(voTool) + '<div class="sb-caret">▍</div>' : '');
}

liveStream('/api/voice-stream', {
  voice: (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (!m) return;
    if (m.kind === 'message' || m.kind === 'reset') loadVoice();
    else if (m.kind === 'activity' && m.row && (m.row.focus || 'hub') === 'hub') {
      const st = m.row.state;
      if (st === 'tool') voTool = m.row.text || null;
      else if (st !== 'text') voTool = null;   // working (a new command), done, error
      if (view === 'orchestrator') paintVoice();
    }
    else if (m.kind === 'request' && m.row) {
      // A finished request is dropped: its row arrives as a message, and a failed one may never get one.
      if (m.row.status === 'done' || m.row.status === 'error') pending.delete(m.row.id);
      else pending.set(m.row.id, m.row);
      if (view === 'orchestrator') paintVoice();
    }
  },
}, { onOpen: loadVoice });

boot();
