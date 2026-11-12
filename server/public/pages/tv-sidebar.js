// Entry for tv-sidebar.html: one conversation, drawn narrow and see-through for the bedroom TV's
// overlay (google-tv repo). Display only — the TV's remote drives the app underneath, never this.
//
// Which one is `sidebar_view` on the sessions frame (the tv_sidebar_view setting, written when a
// `sidebar` command names a view): the focused session, or the voice orchestrator's conversation,
// which is the CURRENT context of the voice thread (/api/voice-messages, the watch's view).
//
// It shows the FOCUSED session (desk_sessions_state(), data-layer 00157): where a spoken follow-up goes, so it follows
// whatever the user is working in. The `sessions` frame on the stream carries focus, so a change moves it.
// Its own small renderer rather than cards/repos.js, which carries a composer, a recorder and a list.
//
// The third view, `content`, is whatever an agent put on the panel (`sidebar_content`, any markdown),
// drawn from the top and held until replaced, so he can keep talking while it stays up.
import { esc, md, liveStream, toolParts } from '../shared.js';

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
// A tool event's text is the tool's name and then its arguments as JSON, cut at 400 characters. The TV
// draws the name and the call's description on one line and the arguments under it, wrapped and held
// to three lines: an unbroken run of JSON is laid out but never painted by the TV's WebView, so the
// argument line must be allowed to break anywhere (`.sb-args`).
const toolLine = (t) => {
  if (!t) return '';
  const { head, args } = toolParts(t);
  return `<div class="sb-tool">${esc(head)}${args ? `<div class="sb-args">${esc(args)}</div>` : ''}</div>`;
};

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
  fit();
}

async function load(id) {
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(id));
    if (!r.ok) return;
    const d = await r.json();
    if (id !== rowId) return;
    if (d.epoch !== epoch) events = [];
    epoch = d.epoch;
    conv = d.claude_session_id || d.id;   // the conversation key the stream frames carry (routes/conversation.js rowConv)
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
const cv = document.getElementById('cv');
const cvBody = document.getElementById('cv-body');
let content = null;
let view = 'session';

// ---- width -----------------------------------------------------------------------------------------
// The app's window spans the screen and is see-through (the hub sends it width 1); the panel is drawn
// here. `sidebar_width` is its MINIMUM, as a fraction of the screen. Nothing on the TV scrolls, so a
// response that would run off the top widens the panel until the whole of it is below the fade, and the
// next shorter one brings it back to the minimum. The latest reply (or, mid-turn, the latest thing it
// said) is what must fit; a narrower window (bin/tv's own width) is filled from edge to edge.
const panel = document.getElementById('sb');
const FADE = 70;   // the top mask on the conversation box, px: text under it is not fully visible
let minWidth = 0.35;

function fit() {
  const W = window.innerWidth;
  const box = view === 'orchestrator' ? voBody : view === 'content' ? cvBody : body;
  // Content is drawn from the top, so it fits when nothing runs off the bottom.
  const fits = view === 'content' ? (w) => { panel.style.width = w + 'px'; return box.scrollHeight <= box.clientHeight + 1; } : (w) => {
    panel.style.width = w + 'px';
    const els = box.querySelectorAll('.sb-reply, .sb-thought');
    const el = els[els.length - 1];
    return !el || el.getBoundingClientRect().top >= box.getBoundingClientRect().top + FADE;
  };
  const min = Math.min(W, Math.round(minWidth * W));
  if (fits(min) || !fits(W)) return;   // fits at the minimum, or nothing fits it and it stays full
  let lo = min, hi = W;
  while (hi - lo > 8) { const mid = (lo + hi) >> 1; if (fits(mid)) hi = mid; else lo = mid; }
  fits(hi);
}
window.addEventListener('resize', () => fit());

let build = null;
function frame(d) {
  if (!d) return;
  // A deploy reaches the server, not an open page: reload when the build changes.
  if (d.commit) { if (build && d.commit !== build) { location.reload(); return; } build = d.commit; }
  const was = view;
  view = ['orchestrator', 'content'].includes(d.sidebar_view) ? d.sidebar_view : 'session';
  if (Number(d.sidebar_font) > 0) document.body.style.fontSize = d.sidebar_font + 'px';
  if (Number(d.sidebar_width) > 0) minWidth = Number(d.sidebar_width);
  vo.hidden = view !== 'orchestrator';
  cv.hidden = view !== 'content';
  ss.hidden = view !== 'session';
  if (typeof d.sidebar_content === 'string' && d.sidebar_content !== content) {
    content = d.sidebar_content;
    cvBody.innerHTML = `<div class="sb-reply">${md(content.trim())}</div>`;
  }
  fit();   // after the switch: a hidden box measures as nothing and would never fit
  // Read when the orchestrator view opens; while it stays open, voice frames keep it current.
  if (view === 'orchestrator' && was !== 'orchestrator') loadVoice();
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

// Read whole when the view opens and after a reset, because the server owns which rows are the current
// context; each new or changed message after that is patched in from its frame (takeVoiceRow).
let voBusy = false, voAgain = false;
function takeVoiceRow(row) {
  if (view !== 'orchestrator') return;
  if ((row.role !== 'user' && row.role !== 'assistant') || (row.mode && row.mode !== 'hub')) return;
  const i = voRows.findIndex((m) => m.id === row.id);
  if (i >= 0) voRows[i] = row;
  else {
    voRows.push(row);
    voRows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (voRows.length > 40) voRows = voRows.slice(-40);
  }
  paintVoice();
}
async function loadVoice() {
  if (view !== 'orchestrator') return;
  if (voBusy) { voAgain = true; return; }
  voBusy = true;
  try {
    const [r, q] = await Promise.all([fetch('/api/voice-messages?focus=hub&limit=40'), fetch('/api/voice-pending')]);
    if (r.ok) voRows = (await r.json()).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (q.ok) { pending.clear(); for (const p of await q.json()) pending.set(p.id, p); }
    paintVoice();
  } catch (_) { /* the stream's reconnect reloads */ }
  voBusy = false;
  if (voAgain) { voAgain = false; loadVoice(); }
}

// The user's words are drawn from the request the moment it is created (`request` frames, /api/voice-pending)
// and handed over to the conversation row once that exists, which is only when the answer lands. Before
// that, a pressed command the hub is still hearing is a request with no words (lib/streams.js heardStart).
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
    // A session's reply relayed into the thread wears the teal the phone and watch give it.
    : `<div class="sb-reply${m.session_id ? ' sb-sess' : ''}">${md(String(m.text || '').trim())}</div>`).join('') +
    // A command still being heard has no words yet: three dots stand where they will land.
    [...pending.values()].map((p) => `<div class="sb-words">${p.text ? esc(p.text) : '<span class="sb-dots"><i></i><i></i><i></i></span>'}</div>`).join('') +
    (working ? toolLine(voTool) + '<div class="sb-caret">▍</div>' : '');
  fit();
}

liveStream('/api/voice-stream', {
  voice: (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (!m) return;
    // A message frame carries the row, so it is drawn from the frame; only a reset (which changes
    // which rows are the current context) or a frame without a row goes back to the server.
    if (m.kind === 'message' && m.row && (m.row.focus || 'hub') === 'hub') takeVoiceRow(m.row);
    else if (m.kind === 'message' || m.kind === 'reset') loadVoice();
    else if (m.kind === 'activity' && m.row && (m.row.focus || 'hub') === 'hub') {
      const st = m.row.state;
      if (st === 'tool') voTool = m.row.text || null;
      else if (st !== 'text') voTool = null;   // working (a new command), done, error
      if (view === 'orchestrator') paintVoice();
    }
    else if (m.kind === 'request' && m.row) {
      // A finished request is dropped: its row arrives as a message, and a failed one may never get one.
      // `dropped` is a command the hub heard and enqueued nothing for (no words, not him).
      if (['done', 'error', 'dropped'].includes(m.row.status)) pending.delete(m.row.id);
      else pending.set(m.row.id, m.row);
      if (view === 'orchestrator') paintVoice();
    }
  },
}, { onOpen: loadVoice });

boot();
