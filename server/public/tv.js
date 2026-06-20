// /tv kiosk: trimmed HUD summary (left) + the live Claude conversation panel (right).
// Two independent streams: /api/stream for the assembled status frame (HUD), and
// /api/voice-stream for voice_messages / voice_focus rows (the conversation).
import { esc, ago, hueColor } from './shared.js';

// Phase 1 focus is always 'hub'. The focus header / fetch key live here so Phase 2 can swap in
// a session id + label (and a terminal panel) by changing currentFocus + the header render.
let currentFocus = 'hub';

// ---------------------------------------------------------------------------
// HUD (left column) — a passive, read-only summary of the existing status frame.
// ---------------------------------------------------------------------------
const STATUS_LABEL = { READY: 'Ready', CLEAN_CYCLE: 'Cleaning', CAT_SENSOR_INTERRUPTED: 'Stuck (auto-resuming)',
  PAUSED: 'Paused', CAT_DETECTED: 'Cat detected', CAT_SENSOR_TIMING: 'Waiting (post-cat)',
  CLEAN_CYCLE_COMPLETE: 'Cycle complete', DRAWER_FULL: 'Drawer full!', OFFLINE: 'Offline', OFF: 'Off' };
const STATUS_COLOR = { READY: '#3b82f6', CLEAN_CYCLE: '#eab308', CAT_SENSOR_INTERRUPTED: '#f97316',
  PAUSED: '#f97316', DRAWER_FULL: '#ef4444', OFFLINE: '#ef4444', OFF: '#566' };

let lastStatus = null;

function renderHud(s) {
  if (!s || s.error) return;
  lastStatus = s;
  const L = s.litter || {};
  const st = L.status || 'OFFLINE';
  document.getElementById('tv-litter').innerHTML =
    '<h3>Litter-Robot</h3>' +
    '<div class=tv-line><span class=dot style="background:' + (STATUS_COLOR[st] || '#8b96a5') + '"></span>' +
      '<span class=tv-line-v>' + esc(STATUS_LABEL[st] || st) + '</span></div>' +
    '<div class=tv-kv><span>Litter</span><b>' + (L.litter_level_pct != null ? L.litter_level_pct + '%' : '—') + '</b></div>' +
    '<div class=tv-kv><span>Drawer</span><b>' + (L.waste_drawer_pct != null ? L.waste_drawer_pct + '%' : '—') + '</b></div>';

  const n = s.nutrition || {};
  const tgt = (n.target && n.target.calories) || null;
  const calCol = tgt ? hueColor(n.calories / tgt) : '#e8eaed';
  document.getElementById('tv-nutrition').innerHTML =
    '<h3>Today · Nutrition</h3>' +
    '<div class=tv-big style="color:' + calCol + '">' + (n.calories || 0) + (tgt ? ' <span class=tv-of>/ ' + tgt + '</span>' : '') + '</div>' +
    '<div class=tv-kvrow>' +
      '<div class=tv-kv><span>P</span><b>' + (n.protein_g || 0) + 'g</b></div>' +
      '<div class=tv-kv><span>C</span><b>' + (n.carbs_g || 0) + 'g</b></div>' +
      '<div class=tv-kv><span>F</span><b>' + (n.fat_g || 0) + 'g</b></div>' +
    '</div>';

  const groups = (s.volume && s.volume.groups) || [];
  const flat = groups.flatMap((g) => g.muscles || []);
  const top = flat.filter((m) => (m.sets || 0) > 0).sort((a, b) => (b.sets || 0) - (a.sets || 0)).slice(0, 5);
  document.getElementById('tv-workout').innerHTML =
    '<h3>Muscle Volume · 7-Day</h3>' +
    (top.length ? top.map((m) =>
      '<div class=tv-kv><span>' + esc(m.label || m.muscle || '') + '</span><b>' + (m.sets || 0) + '</b></div>').join('')
      : '<div class=tv-empty>no sets logged</div>');
}

function renderFoot() {
  if (!lastStatus) return;
  const L = lastStatus.litter || {};
  document.getElementById('tv-foot').textContent =
    'litter ' + ago(L.updated_at) + ' · ' + new Date().toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Conversation panel (right) — voice_messages for the current focus, oldest→newest.
// ---------------------------------------------------------------------------
const log = document.getElementById('tv-log');
const seen = new Map(); // row id -> bubble element, so streamed UPDATEs replace in place

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}
function scrollToEnd() { log.scrollTop = log.scrollHeight; }

// One message row. role drives styling: user / assistant get distinct bubbles; tool / system
// render as subtle inline meta lines. Empty-text streaming rows show a typing caret.
function bubbleHtml(row) {
  const role = row.role || 'assistant';
  const txt = (row.text == null ? '' : String(row.text));
  const body = txt ? esc(txt).replace(/\n/g, '<br>') : '<span class=tv-caret>▍</span>';
  return '<div class="tv-msg tv-msg-' + esc(role) + (row.done === false ? ' tv-streaming' : '') + '">' +
    '<span class=tv-msg-role>' + esc(role) + '</span>' +
    '<div class=tv-msg-text>' + body + '</div></div>';
}

function upsert(row) {
  if (!row || row.focus !== currentFocus) return; // ignore other foci (Phase 2 may have several)
  const stick = nearBottom();
  const existing = seen.get(row.id);
  const tmp = document.createElement('div');
  tmp.innerHTML = bubbleHtml(row);
  const el = tmp.firstElementChild;
  if (existing) { existing.replaceWith(el); seen.set(row.id, el); }
  else { log.appendChild(el); seen.set(row.id, el); }
  if (stick) scrollToEnd();
}

// Latest voice_focus row we've seen, so re-renders (e.g. after the sessions list changes)
// keep the right label/terminal_url.
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
    if (focus === 'hub') backfill(); // reloaded conversation for the hub
  }

  // View switch: 'hub' → conversation panel; anything else → web terminal on row.terminal_url.
  if (focus === 'hub') {
    teardownTerminal();
    log.hidden = false;
  } else {
    log.hidden = true;
    mountTerminal((row && row.terminal_url) || null);
  }
}

// ---------------------------------------------------------------------------
// Web terminal (Phase 2) — xterm.js bound directly to the orchestrator's ws (cross-origin).
// Loaded lazily from jsdelivr ESM the first time a session is focused.
// ---------------------------------------------------------------------------
const TERM_EL = document.getElementById('tv-term');
let xtermMods = null;          // { Terminal, FitAddon } once loaded
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
  // Best-effort: orchestrators that understand it can resize the pty; others ignore it.
  try { termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch (_) {}
}

async function mountTerminal(url) {
  if (term && termUrl === url) { fit && fit.fit(); return; } // already on this session
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

  termWs = new WebSocket(url);
  termWs.binaryType = 'arraybuffer';
  termWs.onopen = () => sendResize();
  termWs.onmessage = (e) => {
    const d = e.data;
    if (typeof d === 'string') term.write(d);
    else term.write(new Uint8Array(d)); // binary frames (ArrayBuffer) → bytes
  };
  termWs.onclose = () => { if (term) term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n'); };
  // Keystrokes → ws (so a keyboard plugged into the Pi drives the session too).
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
// Focusable session list (left footer) — voice_sessions, refreshed on the 'sessions' signal.
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
// Wire up streams.
// ---------------------------------------------------------------------------
const status = new EventSource('/api/stream');
status.onmessage = (e) => { try { renderHud(JSON.parse(e.data)); } catch (_) {} };

const voice = new EventSource('/api/voice-stream');
voice.addEventListener('voice', (e) => {
  let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (msg.kind === 'message') upsert(msg.row);
  else if (msg.kind === 'focus') { renderFocus(msg.row); loadSessions(); } // refresh list highlight
  else if (msg.kind === 'sessions') loadSessions();
});

renderFocus(null);
backfill();
loadSessions();
setInterval(renderFoot, 1000);
