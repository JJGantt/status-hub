// /tv kiosk voice layer. The full hub dashboard is rendered by core.js from /api/stream (same
// cards as the main hub). This module adds ONLY the compact voice column: a minimal live
// conversation panel for focus 'hub', a session terminal that overlays when focus != 'hub',
// and the focusable session list. It reads /api/voice-stream (event: voice {kind,row}).
import { esc } from './shared.js';

let currentFocus = 'hub';

// ---------------------------------------------------------------------------
// Conversation panel — voice_messages for the current focus, oldest→newest.
// Minimal bubbles: user = blue, assistant = gray. No role labels.
// ---------------------------------------------------------------------------
const log = document.getElementById('tv-log');
const seen = new Map(); // row id -> bubble element, so streamed UPDATEs replace in place

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}
function scrollToEnd() { log.scrollTop = log.scrollHeight; }

// One message bubble. Only user vs assistant matters for styling; tool/system fold into the
// assistant (gray) bucket so the panel stays a simple two-color chat. Empty streaming rows
// show a typing caret.
function bubbleHtml(row) {
  const side = (row.role || 'assistant') === 'user' ? 'user' : 'assistant';
  const txt = (row.text == null ? '' : String(row.text));
  const body = txt ? esc(txt).replace(/\n/g, '<br>') : '<span class=tv-caret>▍</span>';
  return '<div class="tv-msg tv-msg-' + side + (row.done === false ? ' tv-streaming' : '') + '">' +
    '<div class=tv-msg-text>' + body + '</div></div>';
}

function upsert(row) {
  if (!row || row.focus !== currentFocus) return;
  if (row.role === 'tool') return; // tool-call activity rows aren't part of the conversation thread
  const stick = nearBottom();
  const existing = seen.get(row.id);
  const tmp = document.createElement('div');
  tmp.innerHTML = bubbleHtml(row);
  const el = tmp.firstElementChild;
  if (existing) { existing.replaceWith(el); seen.set(row.id, el); }
  else { log.appendChild(el); seen.set(row.id, el); }
  if (stick) scrollToEnd();
}

async function backfill() {
  try {
    const r = await fetch('/api/voice-messages?focus=' + encodeURIComponent(currentFocus) + '&limit=50');
    if (!r.ok) return;
    const rows = await r.json();
    log.innerHTML = ''; seen.clear();
    for (const row of rows) upsert(row);
    scrollToEnd();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Focus header + view switch: 'hub' → conversation panel; else → terminal overlay.
// ---------------------------------------------------------------------------
let lastFocusRow = null;

function renderFocus(row) {
  if (row) lastFocusRow = row;
  row = lastFocusRow;
  const focus = (row && row.focus) || 'hub';
  const head = document.getElementById('tv-focus');
  const label = (row && row.label) || (focus === 'hub' ? 'Hub' : focus);
  head.dataset.focus = focus;
  head.querySelector('.tv-focus-label').textContent = label;

  if (focus !== currentFocus) {
    currentFocus = focus;
    if (focus === 'hub') backfill();
  }

  // body.tv-focused drives the CSS that overlays the terminal over the voice column.
  if (focus === 'hub') {
    document.body.classList.remove('tv-focused');
    teardownTerminal();
  } else {
    document.body.classList.add('tv-focused');
    mountTerminal((row && row.terminal_url) || null);
  }
}

// ---------------------------------------------------------------------------
// Session terminal (focus != 'hub') — xterm.js bound to row.terminal_url (ws:// or wss://).
// Loaded lazily from jsdelivr ESM the first time a session is focused.
// ---------------------------------------------------------------------------
const TERM_EL = document.getElementById('tv-term');
let xtermMods = null;
let term = null, fit = null, termWs = null, termRO = null, termUrl = null;

async function loadXterm() {
  if (xtermMods) return xtermMods;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm'),
    import('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm'),
  ]);
  xtermMods = { Terminal, FitAddon };
  return xtermMods;
}

function sendResize() {
  if (!term || !termWs || termWs.readyState !== WebSocket.OPEN) return;
  try { termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch (_) {}
}

async function mountTerminal(url) {
  if (term && termUrl === url) { fit && fit.fit(); return; }
  teardownTerminal();
  termUrl = url;
  TERM_EL.hidden = false;
  if (!url) { TERM_EL.textContent = 'waiting for terminal…'; return; }
  TERM_EL.textContent = '';

  const { Terminal, FitAddon } = await loadXterm();
  if (termUrl !== url) return; // focus changed again while loading
  term = new Terminal({
    cursorBlink: true, fontSize: 15, scrollback: 5000,
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
    theme: { background: '#06080a', foreground: '#e6eaf0' },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(TERM_EL);
  fit.fit();

  termWs = new WebSocket(url); // whatever the focus row says (ws:// or wss://)
  termWs.binaryType = 'arraybuffer';
  termWs.onopen = () => sendResize();
  termWs.onmessage = (e) => {
    const d = e.data;
    if (typeof d === 'string') term.write(d);
    else term.write(new Uint8Array(d));
  };
  termWs.onclose = () => { if (term) term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n'); };
  term.onData((d) => { if (termWs && termWs.readyState === WebSocket.OPEN) termWs.send(d); });

  termRO = new ResizeObserver(() => { try { fit.fit(); sendResize(); } catch (_) {} });
  termRO.observe(TERM_EL);
}

function teardownTerminal() {
  if (termRO) { try { termRO.disconnect(); } catch (_) {} termRO = null; }
  if (termWs) { try { termWs.onclose = null; termWs.close(); } catch (_) {} termWs = null; }
  if (term) { try { term.dispose(); } catch (_) {} term = null; }
  fit = null; termUrl = null;
  TERM_EL.hidden = true;
  TERM_EL.textContent = '';
}

// ---------------------------------------------------------------------------
// Focusable session list — voice_sessions, refreshed on the 'sessions' signal.
// ---------------------------------------------------------------------------
async function loadSessions() {
  try {
    const r = await fetch('/api/voice-sessions');
    if (!r.ok) return;
    renderSessions(await r.json());
  } catch (_) {}
}
function renderSessions(rows) {
  const el = document.getElementById('tv-sessions');
  if (!el) return;
  const list = Array.isArray(rows) ? rows : [];
  el.innerHTML = '<h3>Sessions</h3>' + (list.length
    ? list.map((s) => '<div class="tv-sess' + (s.id === currentFocus ? ' on' : '') + '">' +
        '<span class=tv-sess-dot></span><span class=tv-sess-title>' + esc(s.title || s.id || '') + '</span></div>').join('')
    : '<div class=tv-empty>none</div>');
}

// ---------------------------------------------------------------------------
// Wire up the voice stream. (core.js owns /api/stream for the dashboard cards.)
// ---------------------------------------------------------------------------
const voice = new EventSource('/api/voice-stream');
voice.addEventListener('voice', (e) => {
  let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (msg.kind === 'message') upsert(msg.row);
  else if (msg.kind === 'reset') { log.innerHTML = ''; seen.clear(); }
  else if (msg.kind === 'focus') { renderFocus(msg.row); loadSessions(); }
  else if (msg.kind === 'sessions') loadSessions();
});

renderFocus(null);
backfill();
loadSessions();
