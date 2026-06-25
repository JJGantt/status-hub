// /tv kiosk voice layer. The full hub dashboard is rendered by core.js from /api/stream (same cards as the
// main hub). This module adds ONLY the compact voice column: a minimal live conversation panel for the hub
// thread, plus the bottom-strip emission feed. It reads /api/voice-stream (event: voice {kind,row}).
import { esc } from './shared.js';

// ---------------------------------------------------------------------------
// Conversation panel — hub voice_messages, oldest→newest. user = blue, assistant = gray. No role labels.
// ---------------------------------------------------------------------------
const log = document.getElementById('tv-log');
const seen = new Map(); // row id -> bubble element, so streamed UPDATEs replace in place

function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
function scrollToEnd() { log.scrollTop = log.scrollHeight; }

// One bubble. Only user vs assistant matters; tool/system fold into the assistant (gray) bucket. Empty
// streaming rows show a typing caret.
function bubbleHtml(row) {
  const side = (row.role || 'assistant') === 'user' ? 'user' : 'assistant';
  const txt = (row.text == null ? '' : String(row.text));
  const body = txt ? esc(txt).replace(/\n/g, '<br>') : '<span class=tv-caret>▍</span>';
  return '<div class="tv-msg tv-msg-' + side + (row.done === false ? ' tv-streaming' : '') + '">' +
    '<div class=tv-msg-text>' + body + '</div></div>';
}

function upsert(row) {
  if (!row || row.focus !== 'hub') return;
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
    const r = await fetch('/api/voice-messages?focus=hub&limit=50');
    if (!r.ok) return;
    const rows = await r.json();
    log.innerHTML = ''; seen.clear();
    for (const row of rows) upsert(row);
    scrollToEnd();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Bottom-strip emission feed: listening (blue) → working/tools (amber, the ESP-flashing phase) →
// resolution (green, same line pushed to the phone), then it fades.
// ---------------------------------------------------------------------------
const emitEl = document.getElementById('emit');
let emitFade = null;
const EMIT_STYLE = {
  listening: { c: '#3b82f6', l: 'Listening' },   // blue — matches the ESP solid-blue capture cue
  working:   { c: '#eab308', l: 'Working' },      // amber — thinking, matches the ESP flashing
  tool:      { c: '#eab308', l: 'Working' },
  done:      { c: '#22c55e', l: 'Done' },         // green — resolution, then fades
};
function showEmit(state, text) {
  if (!emitEl) return;
  clearTimeout(emitFade);
  const s = EMIT_STYLE[state] || EMIT_STYLE.tool;
  emitEl.innerHTML = '<span class="em-dot"></span><span class="em-label"></span><span class="em-text"></span>';
  emitEl.querySelector('.em-dot').style.background = s.c;
  emitEl.querySelector('.em-label').textContent = s.l;
  emitEl.querySelector('.em-text').textContent = text || '';
  emitEl.classList.add('show');
  // Persist the resolution as long as the worker holds context; a 'reset' clears it (not a cosmetic timer).
  if (state === 'done') emitFade = setTimeout(() => emitEl.classList.remove('show'), 300000);
}

// ---------------------------------------------------------------------------
// Voice stream. (core.js owns /api/stream for the dashboard cards.)
// ---------------------------------------------------------------------------
const voice = new EventSource('/api/voice-stream');
voice.addEventListener('voice', (e) => {
  let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (msg.kind === 'activity') { const a = msg.row || {}; showEmit(a.state, a.text); }
  else if (msg.kind === 'message') upsert(msg.row);
  else if (msg.kind === 'reset') {
    log.innerHTML = ''; seen.clear();
    if (emitEl) { clearTimeout(emitFade); emitEl.classList.remove('show'); }
  }
});

backfill();
