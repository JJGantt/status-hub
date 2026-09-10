// In-app conversation. Three pieces sharing one pipeline (→ /api/voice-command|voice-text →
// voice_requests → Mac worker → the shared 'hub' voice_messages thread):
//   1. A full-height conversation card at the end of the hub (#ai-log): type, talk, reset.
//   2. A fixed quick-add mic FAB (bottom-right) for a one-off voice command without scrolling.
//   3. A bottom activity bar (bottom-left, sized to never touch the FAB) that shows live progress —
//      Listening / Transcribing / Thinking, then each tool call WITH its arguments as it runs, plus the
//      Sonnet→Opus escalation when a turn leaves the fast path (its own row + a sticky OPUS chip).
// Tool-call rows (role='tool') are surfaced ONLY in the activity bar, never in the conversation
// thread. All skipped on the TV wall (no mic; it renders the conversation itself via tv.js).
import { esc, localNowNaive, liveStream, KIOSK } from './shared.js';

let phoneHangMs = 3000;   // phone trailing-silence (ms) for the FAB VAD; overridden by the phone_silence_s setting
let resetMs = 30 * 60 * 1000;   // context-reset idle gap (ms) = session_reset_s. A message arriving after a gap
                                // this long means the agent reset its context, so the shown thread resets too.
// How long a FINISHED row — the reply, or an error — holds on the activity bar before it hides. The
// running states (Listening / Thinking / each tool call) are sticky and ignore this entirely; only the
// terminal row is on a timer. A new command still clears it immediately, because show() resets the
// pending timeout on every call, so this is a ceiling and never a floor.
let activityHoldMs = 60 * 1000;
// The interactive client (boot(), below) and the kiosk (tv.js) each already fetch /api/settings, so the
// module that owns the bar takes the value from them rather than making a third request of its own.
export function applyActivitySettings(s) {
  const n = parseFloat((s || {}).activity_hold_s);
  if (Number.isFinite(n) && n > 0) activityHoldMs = n * 1000;
}
let _activityBar = null;        // shared activity-popup singleton — declared up here so boot() (below) can call activityBar() without a TDZ error
let _outboxBusy = false;        // photo-outbox reentrancy latch — up here for the same reason: boot() runs runPhotoOutbox()
let _card = null;               // the conversation card (null on pages without it)
let micStream = null;           // the page's one held microphone — see holdMic(); up here for the same reason
let micPending = null;          // an in-flight getUserMedia, so concurrent callers share one acquisition
let _voiceChain = Promise.resolve();   // voice-outbox passes run one after another — see runVoiceOutbox()
let _voiceBacklogStatus = () => {};    // where a resent clip with no live recorder reports; boot() points it at the activity bar
const voiceOwners = new Map();         // clip id -> the live recorder that took it: { onStatus, onTranscript }
// Both durable outboxes, up here because boot() drains them at load (idbBox is a hoisted declaration).
const photoBox = idbBox('hub-photo-outbox');
const voiceBox = idbBox('hub-voice-outbox');
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

// The kiosk has tv.js's own voice layer and no input; everything else boots the interactive client.
// KIOSK also picks the activity bar's mount point below.
if (!KIOSK) boot();

function boot() {
  holdMic();                       // the microphone is open for as long as the hub is on screen
  const activity = activityBar();
  // Heard-you pop. The UI plays it ITSELF the instant the words land on screen — synced to the paint.
  const popSound = new Audio('/pop.m4a');
  popSound.preload = 'auto';
  const playPop = () => { try { popSound.currentTime = 0; popSound.play().catch(() => {}); } catch (_) {} };
  _card = initCard();                // null if the conversation card isn't on this page
  setMode('hub');                    // default indicator until settings load

  // Durable outboxes (photos, and every voice clip): resume any interrupted send now, and again whenever
  // we return to the foreground, regain the network, or restore from bfcache — so anything caught
  // mid-send by a screen-lock or a dropped connection finishes itself the moment the hub is reopened.
  // Progress routes to the activity bar.
  const photoStatus = (t, kind) => {
    if (!t) return;
    if (kind === 'done') activity.done(t);
    else if (kind === 'wait') activity.err(t);
    else activity.busy(t);
  };
  // A voice clip resent with no recorder left to report to (the page was reloaded) reports here, mapped
  // the way the navbar's voice button maps its own.
  _voiceBacklogStatus = (t, kind) => {
    if (kind === 'prompt') activity.prompt(t);
    else if (kind === 'err') activity.err(t);
    else if (kind === 'clear') activity.clear();
    else activity.busy(t);
  };
  const resume = () => { runPhotoOutbox(photoStatus); runVoiceOutbox(); };
  resume();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  fetch('/api/settings').then((r) => r.json()).then((s) => {
    const n = parseFloat(s.phone_silence_s); if (Number.isFinite(n) && n > 0) phoneHangMs = n * 1000;
    const rs = parseFloat(s.session_reset_s); if (Number.isFinite(rs) && rs > 0) resetMs = rs * 1000;
    applyActivitySettings(s);
    setMode(['1', 'true', 'on', 'yes'].includes(String(s.agent_mode ?? '0').toLowerCase()) ? 'agent' : 'hub');
  }).catch(() => {});

  // One voice stream feeds the conversation, the activity bar, and the live mode switch.
  liveStream('/api/voice-stream', { voice: (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'reset') { if (_card) _card.clear(); activity.clear(); return; }
    if (msg.kind === 'mode') { setMode(msg.row && msg.row.agent ? 'agent' : 'hub'); return; }  // toggle flipped → switch thread
    if (msg.kind === 'activity') {                 // live progress, pushed direct from the worker (low-latency)
      const a = msg.row || {};
      if ((a.focus || 'hub') !== 'hub') return;
      if (a.state === 'working') playPop();        // his words just landed on screen
      if (a.state === 'done') activity.done(a.text);
      else if (a.state === 'escalate') activity.escalate(a.text);   // Sonnet handed off to Opus mid-run
      else activity.tool(a.text);
      return;
    }
    if (msg.kind !== 'message') return;
    const row = msg.row;
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if ((row.mode || 'hub') !== activeMode) return;   // only the ACTIVE mode's messages land in the panel
    if (row.role === 'tool') return;               // (tools now arrive as 'activity', never as messages)
    if (_card) _card.upsert(row);                  // user/assistant → conversation
  } }, { onOpen: () => { if (_card) _card.backfill(); } });
  // The conversation must reflect the active mode's thread live, from ANY source — hence the onOpen
  // resync above (every reconnect, including the watchdog's rebuild and the first connect) plus this
  // one on returning to the foreground. A mobile browser silently suspends the stream when backgrounded
  // and never replays what it missed; without these the thread shows only what THIS device sent until a
  // manual refresh. backfill() is idempotent — a full rebuild — so resyncing costs nothing.
  if (_card) document.addEventListener('visibilitychange', () => { if (!document.hidden) _card.backfill(); });
}

// ONE microphone, held for as long as the hub is on screen.
//
// iOS takes up to two seconds to hand over a capture device — measured at 2,017ms on his phone from the
// tap to the first captured frame — and acquiring per recording put that wait between every tap and the
// red fill. So the hub warms the stream when the page comes up and keeps it, and a recording is just a
// MediaRecorder over a device that is already open.
//
// Released the moment the page is hidden, and re-warmed when it comes back: iOS interrupts a
// backgrounded capture anyway, and the recording indicator has no business staying lit over another app.
// A track can also end under us (another app takes the mic, the OS interrupts) — hence the readyState
// check rather than trusting the reference.
// (`micStream`/`micPending` are declared at the top of the file with the rest of boot()'s state — boot()
// runs above this point, and a `let` it touches would still be in the temporal dead zone here.)
function micLive() { return micStream && micStream.getTracks().some((t) => t.readyState === 'live'); }
function mic() {
  if (micLive()) return Promise.resolve(micStream);
  micStream = null;
  if (!micPending) {
    micPending = navigator.mediaDevices.getUserMedia({ audio: true })
      .then((s) => { micStream = s; return s; })
      .finally(() => { micPending = null; });
  }
  return micPending;
}
function releaseMic() {
  const s = micStream; micStream = null;
  if (s) s.getTracks().forEach((t) => t.stop());
  if (micPending) micPending.then((p) => p.getTracks().forEach((t) => t.stop())).catch(() => {});
}
// Called by every surface that can record (the hub's boot, and the /mic web-clip).
export function holdMic() {
  const warm = () => { if (document.visibilityState === 'visible') mic().catch(() => {}); };
  warm();
  document.addEventListener('visibilitychange', () => (document.hidden ? releaseMic() : warm()));
  window.addEventListener('pagehide', releaseMic);
}

// TEMPORARY. Every pointer event and every recorder state change, reported to the hub's log, because
// the stop tap misbehaves only on his phone and nothing here can see that. `fly logs | grep tap`.
// Delete this and /api/tapdebug once the stop path is understood.
function trace(ev, extra) {
  try {
    const body = JSON.stringify({ ev, ...(extra || {}), ms: Math.round(performance.now()) });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/tapdebug', new Blob([body], { type: 'application/json' }));
    else fetch('/api/tapdebug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
  } catch (_) {}
}

// A tap fires on pointerdown, not on click: click lands when the finger LIFTS, and the gap between the
// two is long enough to read as an unresponsive button — 90ms for a mouse press, more for a finger.
// The click still arrives afterwards (preventDefault on pointerdown does not reliably suppress it), and
// on a toggle a second call would undo the first, so it is swallowed. Only a click with no pointerdown
// in front of it and no click count — keyboard Enter or Space — is allowed through.
export function bindTap(el, fn) {
  let fromPointer = false;
  el.addEventListener('pointerdown', (e) => {
    trace('pointerdown', { type: e.pointerType, id: e.pointerId, primary: e.isPrimary });
    e.preventDefault(); fromPointer = true; fn();
  });
  el.addEventListener('click', (e) => {
    trace('click', { detail: e.detail, fromPointer });
    if (fromPointer || e.detail !== 0) { fromPointer = false; return; }
    fn();
  });
  el.addEventListener('pointercancel', () => trace('pointercancel'));
}

// Speech needs a few tens of kbps. Left to itself iOS Safari's recorder has produced ~1.5 Mbps, which
// put a two-minute command over the transcription service's upload cap. The server now takes a clip of
// any size (lib/transcribe.js), but every byte still has to go up over the phone's connection first.
const VOICE_BPS = 32000;

// A self-contained recorder: getUserMedia → MediaRecorder → upload to /api/voice-command.
// quick=true marks a one-off quick-add (the FAB) so the server tags it for a terse reply.
// dryWhen (optional): checked at upload time — when true, the server only transcribes (?dry=1) and the
// text goes to onTranscript instead of enqueueing. The chat composer uses this while photos are pending,
// so a dictated command joins the text box and sends WITH the photos, not ahead of them.
// Exported so the wall-mode push-to-talk button (wall.js) can reuse the exact same pipeline.
// onState reports the button's one visual state: 'armed' (tapped — the mic is opening, or the clip is
// on its way up), 'rec' (actually capturing) or 'idle'. Callers paint it; nothing else infers it.
export function makeRecorder({ onStatus = () => {}, onState = () => {}, quick, autoStop, dryWhen, onTranscript }) {
  let recording = false, rec = null, chunks = [], stream = null, startedAt = 0;
  let arming = false;                 // tapped, mic not open yet — see start()
  let sending = false;                // stopped, clip still on its way up — see stop()
  let heardSpeech = false;            // the VAD crossed its threshold at least once this recording
  let vadRan = false;                 // the VAD actually got a Web Audio graph (it can't on every browser)
  let actx = null, vadTimer = null;
  const pickMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'])
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  };
  // Voice-activity auto-stop (FAB): once speech begins, end + send on a short trailing silence — the
  // "return to baseline" behavior the ESP/server use, so the quick mic is press-once with no second tap.
  function startVAD() {
    stopVAD();                       // never leave a previous interval or context running
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.resume) actx.resume();
      const an = actx.createAnalyser(); an.fftSize = 1024;
      actx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize), t0 = performance.now();
      let floor = Infinity, spoke = false, silence = 0;
      const HANG_MS = phoneHangMs, GRACE_MS = Math.max(8000, phoneHangMs + 3000);   // trailing-silence from the phone_silence_s setting
      vadTimer = setInterval(() => {
        if (!recording) return;
        an.getByteTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; s += d * d; }
        const rms = Math.sqrt(s / buf.length), now = performance.now();
        // The noise floor is the QUIETEST frame heard so far, tracked for the whole recording. It used
        // to be the mean of an opening 350ms calibration window, which assumed a pause before speaking:
        // talk immediately and his own voice set the threshold above itself, so the clip never counted
        // as speech — no trailing-silence stop, just a hang until the grace timer gave up. A minimum
        // needs no such pause, because the gaps between words are themselves near the floor.
        if (rms < floor) floor = rms;
        const thr = Math.max(floor * 2.5, 0.02);
        if (rms >= thr) { spoke = true; heardSpeech = true; silence = 0; }   // speaking
        else if (spoke) { if (!silence) silence = now; else if (now - silence >= HANG_MS) { trace('vad:silence'); stop(); } }  // trailing silence → send
        else if (now - t0 > GRACE_MS) { trace('vad:grace'); stop(); }   // pressed but never spoke → give up (upload() drops it)
      }, 60);
      vadRan = true;
    } catch (_) { /* no Web Audio → falls back to tap-to-stop */ }
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
  // A tap has to LOOK live from the instant it lands. getUserMedia takes a beat on a phone — longer
  // after the page has been backgrounded — and `recording` only flipped once it resolved, so the button
  // sat unchanged through that window, the press read as dropped, and the retap started a SECOND capture
  // on top of the first. Both then shared one `chunks`/`vadTimer`/`actx`: the orphaned VAD stopped the
  // live recording on its own clock and the orphaned stream held the mic open, so what reached Groq was
  // an empty clip — which it transcribes as "Thank you." rather than as nothing.
  // `arming` is set synchronously, before the await, so a second tap can only ever be a stop.
  async function start() {
    if (recording || arming || sending) return;
    arming = true; onState('armed');          // the tap is acknowledged here, not when the mic opens
    trace('start:arming');
    let s;
    try { s = await mic(); }     // already open in the normal case, so this resolves in the same tick
    catch (_) { arming = false; onState('idle'); onStatus('Mic permission denied', 'err'); return; }
    if (!arming) return;         // tapped again while arming → cancelled; the mic stays warm for the next one
    arming = false; stream = s;
    const mime = pickMime();
    chunks = []; heardSpeech = false; vadRan = false;
    rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: VOICE_BPS });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => upload(mime);
    rec.start(); recording = true; startedAt = performance.now(); onState('rec');   // capturing for real now — full fill
    trace('start:recording', { mime });
    muteOthers(true);   // mute every other listener (Mac + ESP) while this explicit command records
    onStatus(autoStop ? 'Listening…' : 'Listening… tap to send', 'rec');
    // No duration cap. A recording ends when HE stops talking (the VAD below) or taps again —
    // never on a clock. A wall-clock cap cut long instructions off mid-sentence.
    if (autoStop) startVAD();
  }
  function stop() {
    // Tapped again before the mic ever opened: cancel the arming rather than fall through as a no-op.
    if (arming) { arming = false; onState('idle'); onStatus('', 'clear'); return; }
    if (!recording) return;
    recording = false; stopVAD();
    const live = rec && rec.state !== 'inactive';
    // The tap that ends a recording has to land visibly too. Stopping is instant, but the clip then
    // spends a second or two being uploaded and transcribed with nothing on the button to show for it,
    // which read as a dropped press — and the retap, on a toggle, started a WHOLE NEW recording. So the
    // button holds an in-flight state and taps do nothing until upload() clears it (see toggle()).
    // The flag is only armed when a stop event is actually coming, so it can never strand the button.
    trace('stop:enter', { live, recState: rec ? rec.state : null });
    if (live) { sending = true; onState('armed'); } else onState('idle');
    try { if (live) rec.stop(); } catch (_) {}
    if (!live) release();          // no onstop is coming, so let go of the mic here instead
  }
  // The page owns the microphone (see mic() above), so a finished recording drops its reference and
  // leaves the device open for the next tap. Stopping the tracks here is what used to make every tap
  // pay the acquisition cost again.
  function release() { stream = null; }
  async function upload(mime) {
    trace('upload:begin');
    try { await send(mime); } finally { sending = false; onState('idle'); trace('upload:end'); }
  }
  async function send(mime) {
    release();
    muteOthers(false);   // FAB done with the mic → the other listeners resume
    const dry = typeof dryWhen === 'function' && dryWhen();
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    // Nothing worth sending: no bytes at all, or the VAD watched the whole clip and never once crossed
    // the noise floor. Uploading silence is worse than uploading nothing, because Whisper does not
    // return an empty string for it — it invents a plausible phrase ("Thank you."), and the worker then
    // acts on that. A dictation caller is told, so it can leave its own "nothing heard" state.
    if (!blob.size || (autoStop && vadRan && !heardSpeech)) {
      if (dry && typeof onTranscript === 'function') onTranscript('');
      onStatus('', 'clear');
      return;
    }
    // Durable from here: the clip stays on the phone until the server confirms it (the voice outbox).
    await sendVoice({ blob, dry, quick: !!quick, dur: (performance.now() - startedAt) / 1000 }, { onStatus, onTranscript });
  }
  return {
    toggle() {
      trace('toggle', { recording, arming, sending, recState: rec ? rec.state : null });
      if (sending) return;
      (recording || arming) ? stop() : start();
    }, start, stop };
}

// ---- bottom activity bar -------------------------------------------------
// Singleton: ONE shared activity popup per page — used by the page view (boot), the wall (tv.js), and the
// navbar's voice buttons, so they all drive the same floating overlay.
// ---- photo upload (shared by the composer's attach tray AND the navbar's one-shot camera button) --------
// Downscale to the model's vision-optimum JPEG (≤1568px — quick on cellular too), then hand it to /api/attach.
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
async function uploadBlob(blob, contentType) {
  const ct = contentType || blob.type || 'image/jpeg';
  const r = await fetch('/api/attach', { method: 'POST', headers: { 'Content-Type': ct }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.path) throw new Error(j.error || 'upload failed');
  return j.path;
}

// ===== durable photo outbox ==============================================================
// A captured photo is written to IndexedDB the INSTANT it's taken — before any shrink or upload — so it
// can't be lost to a screen-lock, app kill, reload, or dropped connection. A guarded processor drives
// each pending photo shrink → upload → send, checkpointing the uploaded object name so a resumed run
// skips straight to the (tiny) send. It runs on capture, on boot, on return-to-foreground
// (visibilitychange), when the network returns (online), and on bfcache restore (pageshow) — so an
// interrupted send finishes the moment the hub is reopened. iOS freezes JS + kills in-flight fetches on
// screen-off (and the only APIs that outlive a page — sendBeacon / keepalive — cap at ~64 KB, far under a
// photo), so a real upload can't complete in the background; this guarantees no LOSS and an automatic,
// immediate resume instead. client_now is stamped at CAPTURE time so a photo sent minutes later (after an
// unlock) still logs against when it was actually taken; client_msg_id makes a resent send idempotent.
const uid = () => ((self.crypto && crypto.randomUUID)
  ? crypto.randomUUID() : 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));

// One database per outbox (photoBox / voiceBox, created at the top of the file), each holding a single
// 'pending' store keyed by id — so neither outbox can ever need a schema migration for the other's sake.
function idbBox(name) {
  const open = () => new Promise((resolve, reject) => {
    let rq;
    try { rq = indexedDB.open(name, 1); } catch (e) { return reject(e); }
    rq.onupgradeneeded = () => rq.result.createObjectStore('pending', { keyPath: 'id' });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('pending', mode);
    const rq = fn(tx.objectStore('pending'));          // an IDBRequest (result read on complete) or undefined
    tx.oncomplete = () => resolve(rq ? rq.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
  return {
    put: (item) => run('readwrite', (s) => s.put(item)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
    all: () => run('readonly', (s) => s.getAll()),
  };
}

async function outboxBadge() {
  let n = 0;
  try { n = ((await photoBox.all()) || []).length; } catch (_) {}
  try { window.dispatchEvent(new CustomEvent('hub-photo-outbox', { detail: { pending: n } })); } catch (_) {}
}
export async function pendingPhotoCount() { try { return ((await photoBox.all()) || []).length; } catch (_) { return 0; } }

const shrinkTwice = async (file) => {                  // the iOS canvas decode can miss transiently; one retry before the raw fallback
  try { return await shrink(file); } catch (_) { return await shrink(file); }
};

async function sendOutboxItem(item, onStatus) {
  if (!item.path) {                                    // not uploaded yet — shrink to JPEG (raw file as fallback), upload, then checkpoint
    onStatus && onStatus('Uploading photo…', 'busy');
    let blob, ct;
    try { blob = await shrinkTwice(item.file); ct = 'image/jpeg'; }
    catch (_) { blob = item.file; ct = item.type || (item.file && item.file.type) || 'application/octet-stream'; }
    item.path = await uploadBlob(blob, ct);
    await photoBox.put(item);                          // an interruption from here on resumes straight at the send
    if (_card && item.clientMsgId) _card.setPendingPath(item.clientMsgId, item.path);   // reconcile its optimistic chat bubble to the real object
  }
  const r = await fetch('/api/voice-text', {           // stays on 'Uploading photo…' through this tiny send
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: item.text || '', attachments: [item.path], client_now: item.client_now, client_msg_id: item.clientMsgId }),
  });
  if (!r.ok) throw new Error('send failed');
}

// Surface a failure the phone's console would otherwise hide, into the hub's log (`fly logs | grep clientlog`).
function clientLog(obj) {
  try {
    const payload = JSON.stringify({ ...obj, ua: navigator.userAgent });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/clientlog', new Blob([payload], { type: 'application/json' }));
    else fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
  } catch (_) {}
}
function beaconOutboxError(err, item) {
  clientLog({
    ev: 'quick-photo-fail',
    err: String((err && err.message) || err),
    fileType: (item && (item.type || (item.file && item.file.type))) || '',
    fileSize: (item && item.file && item.file.size) || 0,
    uploaded: !!(item && item.path),
  });
}

// Drive every queued photo to completion. onStatus(text, kind) surfaces progress: kind 'busy' | 'done' | 'wait'.
export async function runPhotoOutbox(onStatus) {
  if (_outboxBusy) return;                             // one processor at a time; the loop re-reads so mid-run enqueues are still caught
  _outboxBusy = true;
  try {
    for (;;) {
      let items = [];
      try { items = (await photoBox.all()) || []; } catch (_) { break; }
      if (!items.length) break;
      items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      let progressed = false;
      for (const item of items) {
        try {
          await sendOutboxItem(item, onStatus);
          await photoBox.del(item.id);
          progressed = true;
          // 200 back from /api/voice-text = the request row exists and the worker is processing it server-side.
          onStatus && onStatus('Processing photo', 'done');
        } catch (e) {
          beaconOutboxError(e, item);
          onStatus && onStatus('Photo captured — it’ll send when you reopen the hub', 'wait');
        }
      }
      if (!progressed) break;                          // a full pass sent nothing (e.g. offline) — stop; a later trigger retries
    }
  } finally {
    _outboxBusy = false;
    outboxBadge();
  }
}

// Capture entry point (navbar camera button): persist FIRST, then kick the processor. Resolves as soon as
// the photo is safely on disk; the upload+send proceed in the background and survive interruption.
export async function enqueuePhoto(file, onStatus) {
  const item = { id: uid(), createdAt: Date.now(), file, type: (file && file.type) || '',
    client_now: localNowNaive(), clientMsgId: uid(), path: null, text: '' };
  await photoBox.put(item);                            // from here the photo cannot be lost
  outboxBadge();
  // Show it in the conversation the instant it's taken (where a chat card exists), not only once the worker
  // replies. Keyed by clientMsgId so the outbox can attach the uploaded path, and the server row can replace it.
  if (_card) { try { _card.optimistic({ localImages: [URL.createObjectURL(file)], clientId: item.clientMsgId, kind: 'photo' }); } catch (_) {} }
  runPhotoOutbox(onStatus);                            // fire-and-forget; resumes later if this send is interrupted (shows 'Uploading photo…' first)
}

// ===== durable voice outbox ==============================================================
// A finished recording is written to IndexedDB BEFORE it is uploaded, and deleted only once the server
// confirms it: the command is enqueued (its transcript is then the durable copy, in voice_requests), or a
// dictation's transcript has been handed back. Any failure — a dropped connection, a screen-lock
// mid-upload, the server refusing it — leaves the clip on the phone, and it goes again on the same
// triggers as a photo (boot, return to the foreground, network back, bfcache restore).
//
// Clips go oldest first. A NETWORK failure ends the pass, since everything behind it would fail the same
// way and must not overtake it. A server REFUSAL keeps the clip for the next pass but lets the queue
// move on, so one clip the server can never take cannot hold every later command hostage.
// client_now is stamped when the clip was recorded, not when it finally sends; client_msg_id (the clip's
// id) makes a resend the server already enqueued a no-op.
//
// A dictation (dry — the composer while photos are pending, the repos card's session prompt) only means
// something to the recorder that took it, so it is sent only while that recorder is alive. One stranded
// by a reload is kept, not sent.
async function sendVoice(clip, owner) {
  const item = { id: uid(), createdAt: Date.now(), client_now: localNowNaive(), type: clip.blob.type || 'audio/webm', ...clip };
  try { await voiceBox.put(item); }
  catch (_) {                                          // no IndexedDB (a private window) — memory is the only copy there is
    try { await deliverVoice(item, owner.onStatus, owner); } catch (e) { voiceFailed(e, item, owner.onStatus); }
    return;
  }
  voiceOwners.set(item.id, owner);
  await runVoiceOutbox();
}

// Upload one clip and act on the answer. Throws if the server did not take it; `refused` marks an
// answer from the server, as opposed to never reaching it.
async function deliverVoice(item, onStatus, owner) {
  onStatus('Transcribing…', 'busy');
  const qp = new URLSearchParams();
  if (item.dry) qp.set('dry', '1');
  if (item.quick) qp.set('quick', '1');
  qp.set('client_now', item.client_now);               // this device's own wall clock, wherever it is
  qp.set('client_msg_id', item.id);
  if (item.dur > 0) qp.set('dur', item.dur.toFixed(1));
  const r = await fetch('/api/voice-command?' + qp, {
    method: 'POST', headers: { 'Content-Type': item.type }, body: item.blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || 'Send failed'), { refused: true });
  if (j.duplicate) onStatus('', 'clear');                                    // an earlier attempt already enqueued it
  else if (!j.transcript) onStatus('Didn’t catch that — try again', 'err');
  else if (item.dry) { owner.onTranscript(j.transcript); onStatus('', 'clear'); }   // compose mode: into the text box
  else {                                                                     // show what was heard, then stream the run
    if (_card) _card.optimistic({ text: j.transcript, kind: 'text' });       // the spoken command as its own live user bubble
    onStatus(j.transcript, 'prompt'); onStatus('Thinking…', 'busy');
  }
}

function voiceFailed(err, item, onStatus) {
  onStatus(err && err.refused ? err.message : 'Send failed', 'err');
  clientLog({ ev: 'voice-send-fail', err: String((err && err.message) || err), refused: !!(err && err.refused),
    bytes: item.blob ? item.blob.size : 0, type: item.type, dur: item.dur });
}

// Passes run one after another, never two at once: every caller — boot, a trigger, a recorder that has
// just queued a clip — gets a whole pass that starts after its clip was written, so awaiting the returned
// promise means that clip has been tried.
export function runVoiceOutbox() {
  _voiceChain = _voiceChain.then(voicePass, voicePass);
  return _voiceChain;
}
async function voicePass() {
  let items;
  try { items = (await voiceBox.all()) || []; } catch (_) { return; }
  items = items.filter((i) => !i.dry || voiceOwners.has(i.id))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (let k = 0; k < items.length; k++) {
    const item = items[k], owner = voiceOwners.get(item.id);
    const onStatus = owner ? owner.onStatus : _voiceBacklogStatus;
    try {
      await deliverVoice(item, onStatus, owner);
    } catch (e) {
      voiceFailed(e, item, onStatus);
      if (e && e.refused) continue;
      for (const later of items.slice(k + 1)) {        // held back behind it; a live recorder still hears so
        const o = voiceOwners.get(later.id);
        if (o) o.onStatus('Send failed', 'err');
      }
      return;
    }
    await voiceBox.del(item.id).catch(() => {});       // a failed delete only means a resend, which the server drops
    voiceOwners.delete(item.id);
  }
}

export function activityBar() { return (_activityBar = _activityBar || initActivityBar()); }
export function initActivityBar() {
  const bar = document.createElement('div');
  bar.className = 'ai-act';
  // A quoted "what you said" line (filled after transcription) stacked above the live status row.
  bar.innerHTML =
    '<div class="ai-act-prompt"></div>' +
    '<div class="ai-act-row"><span class="ai-act-dot"></span><span class="ai-act-txt"></span>' +
      '<span class="ai-act-model"></span></div>';
  // On the kiosk this lives in the footer's reserved lane rather than floating over a card. The phone
  // and the Mac app load the same markup, so #tv-act exists there too — but it sits inside .tv-shell,
  // which wall.js transform-scales to fit the screen, and a transformed ancestor both scales a
  // descendant's text and becomes the containing block for its position:fixed. Mounted there, the
  // phone's popup rendered at about a third of its size, pinned inside the shell. So off the kiosk it
  // goes on <body>, outside the scaled shell, and keeps its float. Same element and same states either
  // way — only the mount point differs, so nothing downstream has to know which surface it is on.
  const lane = KIOSK && document.getElementById('tv-act');
  (lane || document.body).appendChild(bar);
  const txt = bar.querySelector('.ai-act-txt');
  const prm = bar.querySelector('.ai-act-prompt');
  const mdl = bar.querySelector('.ai-act-model');
  const STATES = ['ai-act-rec', 'ai-act-busy', 'ai-act-tool', 'ai-act-esc', 'ai-act-done', 'ai-act-err'];
  let hideT = null;
  function setPrompt(text) {
    const t = (text || '').trim();
    prm.textContent = t ? '“' + t + '”' : '';
    bar.classList.toggle('has-prompt', !!t);     // persists across status changes; cleared on hide/reset
  }
  // Which model is running this turn. Only set when a run LEAVES the default fast path (Sonnet→Opus),
  // and — like the prompt line — it stays up for every later tool row, so the escalation is still
  // visible when the hop itself has scrolled by. Cleared on hide/reset, i.e. per command.
  function setModel(name) {
    mdl.textContent = name || '';
    bar.classList.toggle('has-model', !!name);
  }
  function show(text, kind, sticky) {
    txt.textContent = text || '';
    bar.classList.remove(...STATES);
    bar.classList.add('show', 'ai-act-' + (kind || 'busy'));
    clearTimeout(hideT);
    if (!sticky) hideT = setTimeout(() => { bar.classList.remove('show'); setPrompt(''); setModel(''); }, activityHoldMs);
  }
  return {
    prompt(t) { setPrompt(t); },                  // the transcribed command; stays up for the whole run
    rec(t) { setPrompt(''); setModel(''); show(t || 'Listening…', 'rec', true); },
    busy(t) { show(t, 'busy', true); },          // Transcribing… / Thinking…
    tool(t) { show('⚙ ' + (t || 'tool'), 'tool', true); },
    // The Sonnet→Opus hop: announced on its own row, then remembered as the OPUS chip.
    escalate(t) { setModel('Opus'); show('⤴ ' + (t || 'Escalated to Opus'), 'esc', true); },
    done(t) { show(t ? '✓ ' + t : 'Done ✓', 'done', false); },
    err(t) { show(t, 'err', false); },
    clear() { clearTimeout(hideT); bar.classList.remove('show'); setPrompt(''); setModel(''); },
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
  const pending = new Map();   // optimistic (locally-sent, not-yet-processed) bubbles: clientId -> {el, paths, text, kind, localImages, at}
  const PENDING_TTL = 120000;  // an optimistic bubble no server row matched is dropped after this on the next backfill (self-heals a missed reconcile)
  const MAX_MSGS = 240;   // cap retained bubbles so a long-open hub tab never grows #ai-log + `seen` unbounded
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scrollEnd = () => { log.scrollTop = log.scrollHeight; };
  function bubbleHtml(row) {
    const side = (row.role || 'assistant') === 'user' ? 'user' : 'assistant';
    const t = row.text == null ? '' : String(row.text);
    // Thumbnails: an optimistic (just-sent) bubble carries local blob URLs (row.localImages) shown directly;
    // a server row carries object names (row.attachments) shown via the auth-gated proxy. A photo-only send
    // has no text — the thumbnails ARE the bubble, so no typing caret for it.
    const local = Array.isArray(row.localImages) ? row.localImages : [];
    const atts = Array.isArray(row.attachments) ? row.attachments : [];
    const imgs = local.length
      ? local.map((u) => '<img src="' + u + '" alt="" loading=lazy>').join('')
      : atts.map((p) => '<img src="/api/attachment?path=' + encodeURIComponent(p) + '" alt="" loading=lazy>').join('');
    let inner = (local.length || atts.length) ? '<div class=ai-msg-imgs>' + imgs + '</div>' : '';
    if (t) inner += '<div class=ai-msg-text>' + esc(t).replace(/\n/g, '<br>') + '</div>';
    else if (!local.length && !atts.length) inner += '<div class=ai-msg-text><span class=ai-caret>▍</span></div>';
    // Which worker answered (mac/pi/fly) — dimmed for the expected mac, so a fallback visually pops.
    if (side === 'assistant' && row.worker) {
      const w = esc(String(row.worker));
      inner += '<span class="ai-worker ai-worker-' + w + '">' + w + '</span>';
    }
    return '<div class="ai-msg ai-msg-' + side + (row.pending ? ' ai-msg-pending' : '') + '">' + inner + '</div>';
  }
  let lastTs = 0;   // created_at (ms) of the newest message shown — to detect a context-reset gap
  function upsert(row) {
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if (row.role === 'tool') return;        // tool calls live in the activity bar, not the thread
    reconcile(row);                         // a real row for a locally-sent message replaces its optimistic bubble
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
  function dropPending(cid) {
    const p = pending.get(cid); if (!p) return;
    p.el.remove();
    (p.localImages || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
    pending.delete(cid);
  }
  function clear() { log.innerHTML = ''; seen.clear(); lastTs = 0; for (const cid of [...pending.keys()]) dropPending(cid); }
  // Optimistic send: render the user's own message/photo the instant they send it, before the worker has
  // processed anything. The matching server row (via SSE or backfill) replaces it later — see reconcile().
  function optimistic(o) {
    const cid = o.clientId || ('c-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
    const holder = document.createElement('div');
    holder.innerHTML = bubbleHtml({ role: 'user', text: o.text || '', localImages: o.localImages || [], pending: true });
    const el = holder.firstElementChild;
    const stick = nearBottom();
    log.appendChild(el);
    pending.set(cid, { el, paths: (o.paths || []).filter(Boolean), text: (o.text || '').trim(),
      kind: o.kind || (o.localImages && o.localImages.length ? 'photo' : (o.text ? 'text' : 'voice')),
      localImages: o.localImages || [], at: Date.now() });
    if (stick) scrollEnd();
    return cid;
  }
  function setPendingPath(cid, paths) { const p = pending.get(cid); if (p) p.paths = [].concat(paths || []).filter(Boolean); }
  // Match an incoming server user row to a pending optimistic bubble and drop the placeholder. Photos match on
  // the uploaded object path (exact); typed text matches on the text; a text-bearing row also stands in for
  // the oldest voice placeholder (the transcript arriving for a spoken command).
  function reconcile(row) {
    if (!row || row.role !== 'user' || !pending.size) return;
    const atts = Array.isArray(row.attachments) ? row.attachments : [];
    let hit = null;
    if (atts.length) {
      for (const [cid, p] of pending) if (p.paths.some((x) => atts.includes(x))) { hit = cid; break; }
    } else {
      const txt = String(row.text || '').trim();
      if (txt) for (const [cid, p] of pending) if (p.kind === 'text' && p.text && p.text === txt) { hit = cid; break; }
      if (!hit && txt) for (const [cid, p] of pending) if (p.kind === 'voice') { hit = cid; break; }
    }
    if (hit) dropPending(hit);
  }
  async function backfill() {
    try {
      const r = await fetch('/api/voice-messages?focus=hub&mode=' + activeMode + '&limit=200');   // the active mode's thread (server scopes hub to the current context)
      if (!r.ok) return;
      const rows = await r.json();
      const now = Date.now();
      log.innerHTML = ''; seen.clear(); lastTs = 0;      // detaches server + optimistic els; the pending map still holds the optimistic ones
      for (const row of rows) upsert(row);               // reconcile() drops any pending the server thread now contains
      for (const cid of [...pending.keys()]) {           // re-append still-unmatched optimistic bubbles at the bottom
        const p = pending.get(cid);
        if (now - p.at > PENDING_TTL) dropPending(cid);  // never matched in time → it landed under a different key; stop showing it
        else log.appendChild(p.el);
      }
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

  const syncTray = () => tray.classList.toggle('show', attItems.length > 0);
  function addFiles(files) {
    for (const f of files) {
      const item = { path: null, url: '', rawUrl: '', el: document.createElement('div') };
      try { item.rawUrl = URL.createObjectURL(f); } catch (_) {}   // instant thumbnail for the optimistic chat bubble
      item.el.className = 'ai-tray-item';
      item.promise = shrink(f).then(async (blob) => {
        item.url = URL.createObjectURL(blob);
        item.el.style.backgroundImage = 'url(' + item.url + ')';
        item.path = await uploadBlob(blob); item.el.classList.add('ai-up');
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
    textEl.value = '';
    const cid = optimistic({ text, localImages: items.map((i) => i.rawUrl).filter(Boolean) });   // show it the instant it's sent
    setStatus(items.length ? 'Uploading…' : 'Sent — working…');
    try {
      await Promise.all(items.map((i) => i.promise));
      const attachments = items.map((i) => i.path).filter(Boolean);
      if (attachments.length !== items.length) {   // a photo never made it up — don't send half a thought
        setStatus('A photo failed to upload — remove it (✕) and send again');
        textEl.value = text; dropPending(cid);
        return;
      }
      setPendingPath(cid, attachments);            // let the eventual server row reconcile against the uploaded object
      setStatus('Sent — working…');
      const r = await fetch('/api/voice-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, client_now: localNowNaive(), ...(attachments.length ? { attachments } : {}) }) });
      if (r.ok) clearTray(); else dropPending(cid);
      setStatus(r.ok ? '' : 'Send failed');
    } catch (_) { setStatus('Send failed'); textEl.value = text; dropPending(cid); }
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
  // Photos pending → the mic composes instead of firing: its transcript joins the text box and the
  // whole thing (text + photos) goes when Send is tapped. Empty tray → fire-and-forget as always.
  const cardRec = makeRecorder({
    onStatus: (t, kind) => { if (kind !== 'prompt') setStatus(t); },
    onState: (s) => { micBtn.classList.toggle('ai-rec', s === 'rec');
                      micBtn.classList.toggle('ai-armed', s === 'armed'); },
    dryWhen: () => attItems.length > 0,
    onTranscript: (t) => { textEl.value = (textEl.value.trim() ? textEl.value.trim() + ' ' : '') + t; },
  });
  bindTap(micBtn, () => cardRec.toggle());

  return { upsert, clear, backfill, optimistic, setPendingPath, dropPending };
}

