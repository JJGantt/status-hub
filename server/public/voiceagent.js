// In-app Raspy. Three pieces sharing one pipeline (→ /api/voice-command|voice-text →
// voice_requests → Mac worker → the shared 'hub' voice_messages thread):
//   1. A full-height conversation card at the end of the hub (#ai-log): type, talk, reset.
//   2. A fixed quick-add mic FAB (bottom-right) for a one-off voice command without scrolling.
//   3. A bottom activity bar (bottom-left, sized to never touch the FAB) that shows live progress —
//      Listening / Transcribing / Thinking, then each tool call WITH its arguments as it runs.
// Tool-call rows (role='tool') are surfaced ONLY in the activity bar, never in the conversation
// thread. All skipped on the TV wall (no mic; it renders the conversation itself via tv.js).
import { esc } from './shared.js';

let phoneHangMs = 3000;   // phone trailing-silence (ms) for the FAB VAD; overridden by the phone_silence_s setting

if (!document.body.classList.contains('tv')) boot();

function boot() {
  fetch('/api/settings').then((r) => r.json()).then((s) => {
    const n = parseFloat(s.phone_silence_s); if (Number.isFinite(n) && n > 0) phoneHangMs = n * 1000;
  }).catch(() => {});
  const activity = initActivityBar();
  const card = initCard();           // null if the conversation card isn't on this page
  initFab(activity);

  // One voice stream feeds both the conversation and the activity bar.
  const sse = new EventSource('/api/voice-stream');
  sse.addEventListener('voice', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'reset') { if (card) card.clear(); activity.clear(); return; }
    if (msg.kind === 'activity') {                 // live progress, pushed direct from the worker (low-latency)
      const a = msg.row || {};
      if ((a.focus || 'hub') !== 'hub') return;
      if (a.state === 'done') activity.done(a.text); else activity.tool(a.text);
      return;
    }
    if (msg.kind !== 'message') return;
    const row = msg.row;
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if (row.role === 'tool') return;               // (tools now arrive as 'activity', never as messages)
    if (card) card.upsert(row);                    // user/assistant → conversation
  });
  if (card) card.backfill();
}

// A self-contained recorder: getUserMedia → MediaRecorder → upload to /api/voice-command.
// quick=true marks a one-off quick-add (the FAB) so the server tags it for a terse reply.
function makeRecorder({ onStatus, onActive, quick, autoStop }) {
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
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    if (!blob.size) { onStatus('', 'clear'); return; }
    onStatus('Transcribing…', 'busy');
    try {
      const r = await fetch('/api/voice-command' + (quick ? '?quick=1' : ''), {
        method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) onStatus(j.error || 'Send failed', 'err');
      else if (!j.transcript) onStatus('Didn’t catch that — try again', 'err');
      else { onStatus(j.transcript, 'prompt'); onStatus('Thinking…', 'busy'); } // show what was heard, then stream the run
    } catch (_) { onStatus('Send failed', 'err'); }
  }
  return { toggle() { recording ? stop() : start(); } };
}

// ---- bottom activity bar -------------------------------------------------
function initActivityBar() {
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
    el: bar,
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
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scrollEnd = () => { log.scrollTop = log.scrollHeight; };
  function bubbleHtml(row) {
    const side = (row.role || 'assistant') === 'user' ? 'user' : 'assistant';
    const t = row.text == null ? '' : String(row.text);
    const body = t ? esc(t).replace(/\n/g, '<br>') : '<span class=ai-caret>▍</span>';
    return '<div class="ai-msg ai-msg-' + side + '"><div class=ai-msg-text>' + body + '</div></div>';
  }
  function upsert(row) {
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if (row.role === 'tool') return;        // tool calls live in the activity bar, not the thread
    const stick = nearBottom();
    const tmp = document.createElement('div'); tmp.innerHTML = bubbleHtml(row);
    const el = tmp.firstElementChild, existing = seen.get(row.id);
    if (existing) existing.replaceWith(el); else log.appendChild(el);
    seen.set(row.id, el);
    if (stick) scrollEnd();
  }
  function clear() { log.innerHTML = ''; seen.clear(); }
  async function backfill() {
    try {
      const r = await fetch('/api/voice-messages?focus=hub&limit=50');
      if (!r.ok) return;
      clear();
      for (const row of await r.json()) upsert(row);
      scrollEnd();
    } catch (_) {}
  }

  async function sendText() {
    const text = (textEl.value || '').trim();
    if (!text) return;
    textEl.value = ''; setStatus('Sent — working…');
    try {
      const r = await fetch('/api/voice-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      setStatus(r.ok ? '' : 'Send failed');
    } catch (_) { setStatus('Send failed'); }
  }
  sendBtn.addEventListener('click', sendText);
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset the conversation? Raspy will forget the prior context.')) return;
    clear(); setStatus('Context reset');
    try { await fetch('/api/voice-reset', { method: 'POST' }); } catch (_) {}
    setTimeout(() => setStatus(''), 2500);
  });
  // The card shows the transcript as its own user bubble, so ignore the 'prompt' status kind here.
  const cardRec = makeRecorder({ onStatus: (t, kind) => { if (kind !== 'prompt') setStatus(t); }, onActive: (a) => micBtn.classList.toggle('ai-rec', a) });
  micBtn.addEventListener('click', () => cardRec.toggle());

  return { upsert, clear, backfill };
}

// ---- fixed quick-add mic FAB ---------------------------------------------
function initFab(activity) {
  const wrap = document.createElement('div');
  wrap.className = 'ai-fab-wrap';
  wrap.innerHTML =
    '<button class="ai-fab" id="ai-fab" type="button" aria-label="Quick voice command">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path>' +
        '<line x1="12" y1="18" x2="12" y2="22"></line></svg></button>';
  document.body.appendChild(wrap);
  const fab = wrap.querySelector('#ai-fab');

  const onStatus = (t, kind) => {
    if (kind === 'rec') activity.rec(t);
    else if (kind === 'prompt') activity.prompt(t);   // surface the transcribed command above the status
    else if (kind === 'err') activity.err(t);
    else if (kind === 'clear') activity.clear();
    else activity.busy(t);
  };
  const fabRec = makeRecorder({ onStatus, onActive: (a) => fab.classList.toggle('ai-rec', a), quick: true, autoStop: true });
  fab.addEventListener('click', () => fabRec.toggle());

  // Hide the FAB + activity bar while the full conversation card is on screen (its input is there).
  const card = document.querySelector('.airow');
  if (card && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      const onScreen = es[0].isIntersecting;
      wrap.classList.toggle('hidden', onScreen);
      activity.el.classList.toggle('ai-act-off', onScreen);
    }, { threshold: 0.12 }).observe(card);
  }
}
