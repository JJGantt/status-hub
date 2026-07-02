// In-app conversation. Three pieces sharing one pipeline (→ /api/voice-command|voice-text →
// voice_requests → Mac worker → the shared 'hub' voice_messages thread):
//   1. A full-height conversation card at the end of the hub (#ai-log): type, talk, reset.
//   2. A fixed quick-add mic FAB (bottom-right) for a one-off voice command without scrolling.
//   3. A bottom activity bar (bottom-left, sized to never touch the FAB) that shows live progress —
//      Listening / Transcribing / Thinking, then each tool call WITH its arguments as it runs.
// Tool-call rows (role='tool') are surfaced ONLY in the activity bar, never in the conversation
// thread. All skipped on the TV wall (no mic; it renders the conversation itself via tv.js).
import { esc } from './shared.js';

let phoneHangMs = 3000;   // phone trailing-silence (ms) for the FAB VAD; overridden by the phone_silence_s setting
let resetMs = 30 * 60 * 1000;   // context-reset idle gap (ms) = session_reset_s. A message arriving after a gap
                                // this long means the agent reset its context, so the shown thread resets too.
let _activityBar = null;        // shared activity-popup singleton — declared up here so boot() (below) can call activityBar() without a TDZ error
let _card = null;               // the conversation card (null on pages without it)
let activeMode = 'hub';         // which mode's conversation the panel shows — follows agent_mode, live

// Switch the panel to a mode's conversation: reload its thread + update the on-screen indicator. Hub and
// full-agent keep SEPARATE threads (the worker tags each message); this is what makes the visible context
// follow the active mode, switching live when the agent_mode toggle flips from anywhere.
function setMode(mode) {
  const m = mode === 'agent' ? 'agent' : 'hub';
  if (m !== activeMode) { activeMode = m; if (_card) _card.backfill(); }
  const el = document.getElementById('ai-mode');
  if (el) { el.textContent = activeMode === 'agent' ? 'Agent' : 'Hub'; el.classList.toggle('is-agent', activeMode === 'agent'); }
}

// Boot everywhere EXCEPT the big-screen kiosk (≥1400px; it has tv.js's own panel and no input). The
// PHONE wall now hosts the chat pane, so it boots too. (body.phonewall isn't set yet at import time —
// wall.js loads after core.js's import graph — so test the same viewport predicate wall.js uses.)
if (!document.body.classList.contains('tv') || window.innerWidth < 1400) boot();

function boot() {
  const activity = activityBar();
  _card = initCard();                // null if the conversation card isn't on this page
  setMode('hub');                    // default indicator until settings load
  fetch('/api/settings').then((r) => r.json()).then((s) => {
    const n = parseFloat(s.phone_silence_s); if (Number.isFinite(n) && n > 0) phoneHangMs = n * 1000;
    const rs = parseFloat(s.session_reset_s); if (Number.isFinite(rs) && rs > 0) resetMs = rs * 1000;
    setMode(['1', 'true', 'on', 'yes'].includes(String(s.agent_mode ?? '0').toLowerCase()) ? 'agent' : 'hub');
  }).catch(() => {});

  // One voice stream feeds the conversation, the activity bar, and the live mode switch.
  const sse = new EventSource('/api/voice-stream');
  sse.addEventListener('voice', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'reset') { if (_card) _card.clear(); activity.clear(); return; }
    if (msg.kind === 'mode') { setMode(msg.row && msg.row.agent ? 'agent' : 'hub'); return; }  // toggle flipped → switch thread
    if (msg.kind === 'activity') {                 // live progress, pushed direct from the worker (low-latency)
      const a = msg.row || {};
      if ((a.focus || 'hub') !== 'hub') return;
      if (a.state === 'done') activity.done(a.text); else activity.tool(a.text);
      return;
    }
    if (msg.kind !== 'message') return;
    const row = msg.row;
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if ((row.mode || 'hub') !== activeMode) return;   // only the ACTIVE mode's messages land in the panel
    if (row.role === 'tool') return;               // (tools now arrive as 'activity', never as messages)
    if (_card) _card.upsert(row);                  // user/assistant → conversation
  });
  // The conversation must reflect the active mode's thread live, from ANY source — so resync on every
  // (re)connect AND whenever the view returns to the foreground. EventSource silently suspends when a
  // mobile browser backgrounds and never replays missed messages; without this the thread goes stale
  // (showing only what THIS device sent) until a manual refresh. backfill() is idempotent (full rebuild),
  // and 'open' fires on the first connect too, so it covers initial load as well.
  if (_card) {
    sse.addEventListener('open', () => _card.backfill());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _card.backfill(); });
  }
}

// A self-contained recorder: getUserMedia → MediaRecorder → upload to /api/voice-command.
// quick=true marks a one-off quick-add (the FAB) so the server tags it for a terse reply.
// Exported so the wall-mode push-to-talk button (wall.js) can reuse the exact same pipeline.
export function makeRecorder({ onStatus, onActive, quick, autoStop, tier }) {
  let recording = false, rec = null, chunks = [], stream = null, maxTimer = null;
  let actx = null, vadTimer = null;
  const pickMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'])
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  };
  // Voice-activity auto-stop (FAB): once speech begins, end + send on a short trailing silence — the
  // "return to baseline" behavior the ESP/server use, so the quick mic is press-once with no second tap.
  function startVAD() {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.resume) actx.resume();
      const an = actx.createAnalyser(); an.fftSize = 1024;
      actx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize), t0 = performance.now();
      let base = 0, baseN = 0, spoke = false, silence = 0;
      const CAL_MS = 350, HANG_MS = phoneHangMs, GRACE_MS = Math.max(8000, phoneHangMs + 3000);   // trailing-silence from the phone_silence_s setting
      vadTimer = setInterval(() => {
        if (!recording) return;
        an.getByteTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; s += d * d; }
        const rms = Math.sqrt(s / buf.length), now = performance.now();
        if (now - t0 < CAL_MS) { base += rms; baseN++; return; }       // calibrate the ambient noise floor first
        const thr = Math.max((baseN ? base / baseN : 0.01) * 2.5, 0.02);
        if (rms >= thr) { spoke = true; silence = 0; }                  // speaking
        else if (spoke) { if (!silence) silence = now; else if (now - silence >= HANG_MS) stop(); }  // trailing silence → send
        else if (now - t0 > GRACE_MS) stop();                          // pressed but never spoke → give up
      }, 60);
    } catch (_) { /* no Web Audio → falls back to tap-to-stop + the 60s cap */ }
  }
  function stopVAD() {
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    if (actx) { try { actx.close(); } catch (_) {} actx = null; }
  }
  // Global mute: an explicit FAB command is an explicit, hard-coded-route input — while it's capturing,
  // every always-on auto-routing listener (Mac wake-word, wake-free, ESP) must go deaf. Same shared
  // voice_muted flag the push-to-talk dictation uses; the listeners react to it via realtime.
  function muteOthers(on) {
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'voice_muted', value: on ? '1' : '0' }) }).catch(() => {});
  }
  async function start() {
    if (recording) return;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { onStatus('Mic permission denied', 'err'); return; }
    const mime = pickMime();
    chunks = [];
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => upload(mime);
    rec.start(); recording = true; onActive(true);
    muteOthers(true);   // mute every other listener (Mac + ESP) while this explicit command records
    onStatus(autoStop ? 'Listening…' : 'Listening… tap to send', 'rec');
    maxTimer = setTimeout(() => stop(), 60000);
    if (autoStop) startVAD();
  }
  function stop() {
    if (!recording) return;
    recording = false; onActive(false); clearTimeout(maxTimer); stopVAD();
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (_) {}
  }
  async function upload(mime) {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    muteOthers(false);   // FAB done with the mic → the other listeners resume
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    if (!blob.size) { onStatus('', 'clear'); return; }
    onStatus('Transcribing…', 'busy');
    try {
      const qp = new URLSearchParams();
      if (quick) qp.set('quick', '1');
      if (tier) qp.set('tier', tier);                 // 'fast' (sparkle) or 'power' (brain)
      const qs = qp.toString();
      const r = await fetch('/api/voice-command' + (qs ? '?' + qs : ''), {
        method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) onStatus(j.error || 'Send failed', 'err');
      else if (!j.transcript) onStatus('Didn’t catch that — try again', 'err');
      else { onStatus(j.transcript, 'prompt'); onStatus('Thinking…', 'busy'); } // show what was heard, then stream the run
    } catch (_) { onStatus('Send failed', 'err'); }
  }
  return { toggle() { recording ? stop() : start(); }, start, stop };
}

// ---- bottom activity bar -------------------------------------------------
// Singleton: ONE shared activity popup per page — used by the page view (boot), the wall (tv.js), and the
// navbar's voice buttons, so they all drive the same floating overlay.
export function activityBar() { return (_activityBar = _activityBar || initActivityBar()); }
export function initActivityBar() {
  const bar = document.createElement('div');
  bar.className = 'ai-act';
  // A quoted "what you said" line (filled after transcription) stacked above the live status row.
  bar.innerHTML =
    '<div class="ai-act-prompt"></div>' +
    '<div class="ai-act-row"><span class="ai-act-dot"></span><span class="ai-act-txt"></span></div>';
  document.body.appendChild(bar);
  const txt = bar.querySelector('.ai-act-txt');
  const prm = bar.querySelector('.ai-act-prompt');
  const STATES = ['ai-act-rec', 'ai-act-busy', 'ai-act-tool', 'ai-act-done', 'ai-act-err'];
  let hideT = null;
  function setPrompt(text) {
    const t = (text || '').trim();
    prm.textContent = t ? '“' + t + '”' : '';
    bar.classList.toggle('has-prompt', !!t);     // persists across status changes; cleared on hide/reset
  }
  function show(text, kind, sticky) {
    txt.textContent = text || '';
    bar.classList.remove(...STATES);
    bar.classList.add('show', 'ai-act-' + (kind || 'busy'));
    clearTimeout(hideT);
    if (!sticky) hideT = setTimeout(() => { bar.classList.remove('show'); setPrompt(''); }, 3500);
  }
  return {
    prompt(t) { setPrompt(t); },                  // the transcribed command; stays up for the whole run
    rec(t) { setPrompt(''); show(t || 'Listening…', 'rec', true); },
    busy(t) { show(t, 'busy', true); },          // Transcribing… / Thinking…
    tool(t) { show('⚙ ' + (t || 'tool'), 'tool', true); },
    done(t) { show(t ? '✓ ' + t : 'Done ✓', 'done', false); },
    err(t) { show(t, 'err', false); },
    clear() { clearTimeout(hideT); bar.classList.remove('show'); setPrompt(''); },
  };
}

// ---- conversation card (#ai-log) -----------------------------------------
function initCard() {
  const log = document.getElementById('ai-log');
  if (!log) return null;
  const textEl = document.getElementById('ai-text');
  const sendBtn = document.getElementById('ai-send');
  const micBtn = document.getElementById('ai-mic');
  const resetBtn = document.getElementById('ai-reset');
  const statusEl = document.getElementById('ai-status');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t || ''; };

  const seen = new Map();
  const MAX_MSGS = 240;   // cap retained bubbles so a long-open hub tab never grows #ai-log + `seen` unbounded
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scrollEnd = () => { log.scrollTop = log.scrollHeight; };
  function bubbleHtml(row) {
    const side = (row.role || 'assistant') === 'user' ? 'user' : 'assistant';
    const t = row.text == null ? '' : String(row.text);
    // Photo attachments (object names) → thumbnails via the auth-gated proxy. A photo-only send has no
    // text — the thumbnails ARE the bubble, so no typing caret for it.
    const atts = Array.isArray(row.attachments) ? row.attachments : [];
    let inner = atts.length
      ? '<div class=ai-msg-imgs>' + atts.map((p) =>
          '<img src="/api/attachment?path=' + encodeURIComponent(p) + '" alt="" loading=lazy>').join('') + '</div>'
      : '';
    if (t) inner += '<div class=ai-msg-text>' + esc(t).replace(/\n/g, '<br>') + '</div>';
    else if (!atts.length) inner += '<div class=ai-msg-text><span class=ai-caret>▍</span></div>';
    // Which worker answered (mac/pi/fly) — dimmed for the expected mac, so a fallback visually pops.
    if (side === 'assistant' && row.worker) {
      const w = esc(String(row.worker));
      inner += '<span class="ai-worker ai-worker-' + w + '">' + w + '</span>';
    }
    return '<div class="ai-msg ai-msg-' + side + '">' + inner + '</div>';
  }
  let lastTs = 0;   // created_at (ms) of the newest message shown — to detect a context-reset gap
  function upsert(row) {
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if (row.role === 'tool') return;        // tool calls live in the activity bar, not the thread
    // Hub only: a new message after a gap longer than the reset window means the hub reset its context — so
    // clear the thread first, mirroring the reset. Full-agent never gap-resets, so its thread persists.
    const ts = row.created_at ? Date.parse(row.created_at) : Date.now();
    const fresh = !seen.has(row.id);
    if (activeMode === 'hub' && fresh && lastTs && (ts - lastTs) > resetMs) clear();
    if (fresh) lastTs = ts;
    const stick = nearBottom();
    const tmp = document.createElement('div'); tmp.innerHTML = bubbleHtml(row);
    const el = tmp.firstElementChild, existing = seen.get(row.id);
    if (existing) existing.replaceWith(el); else log.appendChild(el);
    seen.set(row.id, el);
    while (log.childElementCount > MAX_MSGS) {
      const o = log.firstElementChild;
      for (const [id, e] of seen) { if (e === o) { seen.delete(id); break; } }
      o.remove();
    }
    if (stick) scrollEnd();
  }
  function clear() { log.innerHTML = ''; seen.clear(); lastTs = 0; }
  async function backfill() {
    try {
      const r = await fetch('/api/voice-messages?focus=hub&mode=' + activeMode + '&limit=200');   // the active mode's thread (server scopes hub to the current context)
      if (!r.ok) return;
      clear();
      for (const row of await r.json()) upsert(row);
      scrollEnd();
    } catch (_) {}
  }

  // ---- photo attachments --------------------------------------------------
  // An image button in the composer row + a pending-thumbnail tray above it. iOS presents its native
  // Take Photo / Photo Library sheet for the file input (the WKWebView app included). Files downscale
  // client-side (≤1568px JPEG — the model's vision optimum, and quick on cellular) and start uploading
  // the moment they're picked; send() waits for stragglers, then the object names ride the request.
  const inputRow = textEl.closest('.ai-input');
  const attBtn = document.createElement('button');
  attBtn.className = 'ai-attach'; attBtn.type = 'button'; attBtn.setAttribute('aria-label', 'Attach photos');
  attBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></svg>';
  const fileIn = document.createElement('input');
  fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.multiple = true; fileIn.style.display = 'none';
  const tray = document.createElement('div'); tray.className = 'ai-tray';
  inputRow.parentNode.insertBefore(tray, inputRow);
  inputRow.insertBefore(attBtn, textEl);
  inputRow.appendChild(fileIn);
  let attItems = [];   // {el, url, promise, path}

  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX = 1568;
        const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        cv.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }
  const syncTray = () => tray.classList.toggle('show', attItems.length > 0);
  function addFiles(files) {
    for (const f of files) {
      const item = { path: null, url: '', el: document.createElement('div') };
      item.el.className = 'ai-tray-item';
      item.promise = shrink(f).then(async (blob) => {
        item.url = URL.createObjectURL(blob);
        item.el.style.backgroundImage = 'url(' + item.url + ')';
        const r = await fetch('/api/attach', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.path) throw new Error(j.error || 'upload failed');
        item.path = j.path; item.el.classList.add('ai-up');
      }).catch((e) => { item.el.classList.add('ai-fail'); setStatus(String(e.message || e)); });
      const x = document.createElement('button');
      x.className = 'ai-tray-x'; x.type = 'button'; x.setAttribute('aria-label', 'Remove photo'); x.textContent = '✕';
      x.onclick = () => { attItems = attItems.filter((i) => i !== item); if (item.url) URL.revokeObjectURL(item.url); item.el.remove(); syncTray(); };
      item.el.appendChild(x);
      tray.appendChild(item.el);
      attItems.push(item);
    }
    syncTray();
  }
  function clearTray() { for (const i of attItems) { if (i.url) URL.revokeObjectURL(i.url); i.el.remove(); } attItems = []; syncTray(); }
  attBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { if (fileIn.files && fileIn.files.length) addFiles(fileIn.files); fileIn.value = ''; });

  async function sendText() {
    const text = (textEl.value || '').trim();
    const items = attItems.slice();
    if (!text && !items.length) return;
    textEl.value = ''; setStatus(items.length ? 'Uploading…' : 'Sent — working…');
    try {
      await Promise.all(items.map((i) => i.promise));
      const attachments = items.map((i) => i.path).filter(Boolean);
      if (attachments.length !== items.length) {   // a photo never made it up — don't send half a thought
        setStatus('A photo failed to upload — remove it (✕) and send again');
        textEl.value = text;
        return;
      }
      setStatus('Sent — working…');
      const r = await fetch('/api/voice-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(attachments.length ? { attachments } : {}) }) });
      if (r.ok) clearTray();
      setStatus(r.ok ? '' : 'Send failed');
    } catch (_) { setStatus('Send failed'); textEl.value = text; }
  }
  sendBtn.addEventListener('click', sendText);
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset the conversation? The prior context will be forgotten.')) return;
    clear(); setStatus('Context reset');
    try { await fetch('/api/voice-reset', { method: 'POST' }); } catch (_) {}
    setTimeout(() => setStatus(''), 2500);
  });
  // The card shows the transcript as its own user bubble, so ignore the 'prompt' status kind here.
  const cardRec = makeRecorder({ onStatus: (t, kind) => { if (kind !== 'prompt') setStatus(t); }, onActive: (a) => micBtn.classList.toggle('ai-rec', a) });
  micBtn.addEventListener('click', () => cardRec.toggle());

  return { upsert, clear, backfill };
}

