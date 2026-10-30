// Entry for tv-sidebar.html: the focused session, drawn narrow and see-through for the bedroom TV's
// overlay (google-tv repo). Display only — the TV's remote drives the app underneath, never this.
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

async function boot() {
  try {
    const r = await fetch('/api/sessions?brief=1');
    if (r.ok) focusOn((await r.json()).focus);
  } catch (_) {}
}

liveStream('/api/session-stream', {
  sessions: (e) => { try { focusOn(JSON.parse(e.data).focus); } catch (_) {} },
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

boot();
