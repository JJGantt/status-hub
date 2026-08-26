// /tv kiosk voice layer. The full hub dashboard is rendered by core.js from /api/stream (same cards as the
// main hub). This module adds ONLY the compact voice column: a minimal live conversation panel for the hub
// thread, plus the bottom-strip emission feed. It reads /api/voice-stream (event: voice {kind,row}).
import { esc } from './shared.js';
import { activityBar } from './voiceagent.js';

// ---------------------------------------------------------------------------
// Conversation panel — hub voice_messages, oldest→newest. user = blue, assistant = gray. No role labels.
// ---------------------------------------------------------------------------
const log = document.getElementById('tv-log');
const seen = new Map(); // row id -> bubble element, so streamed UPDATEs replace in place
let activeMode = 'hub'; // which mode's conversation the wall shows — follows agent_mode, switches live
const MAX_MSGS = 80;    // hard cap on retained bubbles so a 24/7 kiosk never grows #tv-log + `seen` unbounded

function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
function scrollToEnd() { log.scrollTop = log.scrollHeight; }

// One bubble. Only user vs assistant matters; tool/system fold into the assistant (gray) bucket. Empty
// streaming rows show a typing caret. Photo attachments render as thumbnails (auth-gated proxy);
// assistant rows carry a small chip naming the worker that answered (dimmed for the expected mac).
function bubbleHtml(row) {
  const side = (row.role || 'assistant') === 'user' ? 'user' : 'assistant';
  const txt = (row.text == null ? '' : String(row.text));
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  let inner = atts.length
    ? '<div class=tv-msg-imgs>' + atts.map((p) =>
        '<img src="/api/attachment?path=' + encodeURIComponent(p) + '" alt="" loading=lazy>').join('') + '</div>'
    : '';
  if (txt) inner += '<div class=tv-msg-text>' + esc(txt).replace(/\n/g, '<br>') + '</div>';
  else if (!atts.length) inner += '<div class=tv-msg-text><span class=tv-caret>▍</span></div>';
  if (side === 'assistant' && row.worker) {
    const w = esc(String(row.worker));
    inner += '<span class="tv-worker tv-worker-' + w + '">' + w + '</span>';
  }
  return '<div class="tv-msg tv-msg-' + side + (row.done === false ? ' tv-streaming' : '') + '">' + inner + '</div>';
}

function upsert(row) {
  if (!row || row.focus !== 'hub') return;
  if ((row.mode || 'hub') !== activeMode) return; // only the active mode's thread (hub vs full-agent)
  if (row.role === 'tool') return; // tool-call activity rows aren't part of the conversation thread
  const stick = nearBottom();
  const existing = seen.get(row.id);
  const tmp = document.createElement('div');
  tmp.innerHTML = bubbleHtml(row);
  const el = tmp.firstElementChild;
  if (existing) { existing.replaceWith(el); seen.set(row.id, el); }
  else { log.appendChild(el); seen.set(row.id, el); }
  // Evict oldest bubbles + their `seen` entries past the cap (prevents unbounded DOM/Map growth on the kiosk).
  while (log.childElementCount > MAX_MSGS) {
    const old = log.firstElementChild;
    for (const [id, e] of seen) { if (e === old) { seen.delete(id); break; } }
    old.remove();
  }
  if (stick) scrollToEnd();
}

async function backfill() {
  try {
    const r = await fetch('/api/voice-messages?focus=hub&mode=' + activeMode + '&limit=50');
    if (!r.ok) return;
    const rows = await r.json();
    log.innerHTML = ''; seen.clear();
    for (const row of rows) upsert(row);
    scrollToEnd();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Activity popup — the SAME floating .ai-act popup the page view uses (no reserved strip): live
// Listening → Working → each tool call → Done, with the result persisting briefly, floating on top.
// Exported so the wall mic buttons (wall.js) drive the same instance.
// ---------------------------------------------------------------------------
const activity = activityBar();

// Heard-you pop. The UI plays it ITSELF the instant your words land on screen — synced to the paint.
const popSound = new Audio('/pop.wav');
popSound.preload = 'auto';
function playPop() { try { popSound.currentTime = 0; popSound.play().catch(() => {}); } catch (_) {} }

// ---------------------------------------------------------------------------
// Voice stream. (core.js owns /api/stream for the dashboard cards.)
// ---------------------------------------------------------------------------
const voice = new EventSource('/api/voice-stream');
voice.addEventListener('voice', (e) => {
  let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (msg.kind === 'activity') {
    const a = msg.row || {};
    if (a.state === 'working') playPop();                                          // command's words just landed → pop
    // identical mapping to the page view, escalation included (Sonnet → Opus shows as its own row + chip)
    if (a.state === 'done') activity.done(a.text);
    else if (a.state === 'escalate') activity.escalate(a.text);
    else activity.tool(a.text);
  }
  else if (msg.kind === 'mode') { activeMode = msg.row && msg.row.agent ? 'agent' : 'hub'; backfill(); }  // toggle flipped → show that mode's thread
  else if (msg.kind === 'message') upsert(msg.row);
  else if (msg.kind === 'reset') { log.innerHTML = ''; seen.clear(); activity.clear(); }
});

// Pick up the active mode on load, then backfill that mode's thread.
fetch('/api/settings').then((r) => r.json()).then((s) => {
  activeMode = ['1', 'true', 'on', 'yes'].includes(String(s.agent_mode ?? '0').toLowerCase()) ? 'agent' : 'hub';
}).catch(() => {}).finally(() => backfill());
