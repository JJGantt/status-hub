// In-app conversation. Three pieces sharing one pipeline (→ /api/voice-command|voice-text →
// voice_requests → Mac worker → the shared 'hub' voice_messages thread):
//   1. A full-height conversation card at the end of the hub (#ai-log): type, talk, reset.
//   2. A fixed quick-add mic FAB (bottom-right) for a one-off voice command without scrolling.
//   3. A bottom activity bar (bottom-left, sized to never touch the FAB) that shows live progress —
//      Listening / Transcribing / Thinking, then each tool call WITH its arguments as it runs.
// Tool-call rows (role='tool') are surfaced ONLY in the activity bar, never in the conversation
// thread. All skipped on the TV wall (no mic; it renders the conversation itself via tv.js).
import { esc, md, localNowNaive, liveStream, KIOSK, holdReload } from './shared.js';

let phoneHangMs = 3000;   // the always-on listener's trailing silence (ms); overridden by the phone_silence_s setting
// How long a FINISHED row — the reply, or an error — holds on the kiosk's activity bar before it hides.
// There the running states (Listening / Thinking / each tool call) are sticky and ignore this entirely;
// only the terminal row is on a timer. A new command still clears it immediately, because show() resets the
// pending timeout on every call, so this is a ceiling and never a floor.
let activityHoldMs = 60 * 1000;
// Off the kiosk the bar floats OVER the page, and the reply is one swipe away in the conversation pane,
// so a finished row only has to be glanced at — `phone_activity_hold_s`, not the wall's minute.
let phoneHoldMs = 8 * 1000;
// Off the kiosk, the running states are not sticky forever either. Several turns never send the `done`
// that would close them — a command injected into a focused session, a context reset, a dropped
// duplicate, a run that crashed — and a phone backgrounded mid-run never hears a `done` that WAS sent,
// since a suspended stream does not replay. Each of those left "Thinking…" or the last tool row floating
// over the phone for good. So a running row hides once nothing has touched it for this long; a later
// frame of a run that is merely slow brings it straight back. Listening is exempt: a live recorder
// always ends it itself.
const PHONE_STALE_MS = 2 * 60 * 1000;
// The interactive client (boot(), below) and the kiosk (tv.js) each already fetch /api/settings, so the
// module that owns the bar takes the value from them rather than making a third request of its own.
export function applyActivitySettings(s) {
  const n = parseFloat((s || {}).activity_hold_s);
  if (Number.isFinite(n) && n > 0) activityHoldMs = n * 1000;
  const p = parseFloat((s || {}).phone_activity_hold_s);
  if (Number.isFinite(p) && p > 0) phoneHoldMs = p * 1000;
}
let _activityBar = null;        // shared activity-popup singleton — declared up here so boot() (below) can call activityBar() without a TDZ error
let _outboxBusy = false;        // photo-outbox reentrancy latch — up here for the same reason: boot() runs runPhotoOutbox()
let _card = null;               // the conversation card (null on pages without it)
let micStream = null;           // the page's one microphone, open only while something records — see claimMic(); up here for the same reason
let micPending = null;          // an in-flight getUserMedia, so concurrent callers share one acquisition
let micUsers = 0;               // how many recorders hold it right now; the device closes at zero
let _voiceChain = Promise.resolve();   // voice-outbox passes run one after another — see runVoiceOutbox()
let _voiceBacklogStatus = () => {};    // where a resent clip with no live recorder reports; boot() points it at the activity bar
const voiceOwners = new Map();         // clip id -> the live recorder that took it: { onStatus, onTranscript }
// One clip's upload + transcription, up here because boot() starts the outbox. A ten-minute clip at
// VOICE_BPS is ~7MB and Groq answers in seconds, so two minutes means the request is not coming back.
const VOICE_SEND_MS = 120000;
// Both durable outboxes, up here because boot() drains them at load (idbBox is a hoisted declaration).
// The PHOTO outbox is drained and never filled: the navbar camera that queued into it is gone, and a
// picture now goes through the composer. This only empties whatever that camera left behind.
const photoBox = idbBox('hub-photo-outbox');
const voiceBox = idbBox('hub-voice-outbox');
let activeMode = 'hub';         // which mode's conversation the panel shows — follows agent_mode, live
// Other views of the hub thread: a page can show the conversation somewhere besides the card, and the
// phone home's one-line prompt/reply strip does. They subscribe here rather than opening their own
// EventSource — this page already holds /api/voice-stream open, and a second one on the same endpoint
// is the duplication tv.js was split out to stop. Declared up here with the rest of boot()'s state,
// since boot() runs above the bottom of this file.
const threadSubs = [];

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
  watchMic();                      // the microphone opens only while something is recording
  const activity = activityBar();
  // Heard-you pop. The UI plays it ITSELF the instant the words land on screen — synced to the paint.
  // ONLY WHILE THE PAGE IS ON SCREEN. A media element takes a non-mixing playback session, so a pop
  // from a page running behind another app pauses that app's video — and the iOS app keeps this page
  // running for minutes after it leaves the screen, while every command from any device (the watch, a
  // false wake on a video's own speech) arrives here as `working`. WebKit still reports the page
  // `visible` while the app is backgrounded, so the app's own word (`__appActive`, StatusHubApp.swift)
  // decides there. In the app each pop is kept in client_log (`pop`, with `played`), so a reported
  // pause can be checked against it.
  const popSound = new Audio('/pop.m4a');
  popSound.preload = 'auto';
  const inApp = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.alarmAudio);
  const playPop = () => {
    const shown = document.visibilityState === 'visible' && window.__appActive !== false;
    if (inApp) clientLog({ src: 'phone', ev: 'pop', played: shown });
    if (!shown) return;
    try { popSound.currentTime = 0; popSound.play().catch(() => {}); } catch (_) {}
  };
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
    applyActivitySettings(s);
    setMode(['1', 'true', 'on', 'yes'].includes(String(s.agent_mode ?? '0').toLowerCase()) ? 'agent' : 'hub');
  }).catch(() => {});

  // One voice stream feeds the conversation, the activity bar, and the live mode switch.
  liveStream('/api/voice-stream', { voice: (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'reset') { if (_card) _card.rule(); activity.clear(); return; }   // the old context stays, behind a divider
    if (msg.kind === 'mode') { setMode(msg.row && msg.row.agent ? 'agent' : 'hub'); return; }  // toggle flipped → switch thread
    if (msg.kind === 'activity') {                 // live progress, pushed direct from the worker (low-latency)
      const a = msg.row || {};
      if ((a.focus || 'hub') !== 'hub') return;
      // The user's words just landed on screen — and this is the one event that carries them to a device that
      // did not do the recording, so it is what puts a command spoken at the ESP into every thread view.
      if (a.state === 'working') { playPop(); pushPending({ state: 'prompt', text: a.text }); }
      pushActivity(a);               // any other view of the run — see onActivity below
      if (a.state === 'done') activity.done(a.text);
      else if (a.state === 'error') activity.err(a.text);           // a command it could not act on
      else if (a.state === 'text') activity.thought(a.text);        // what it said between tool calls
      else activity.tool(a.text);
      return;
    }
    if (msg.kind !== 'message') return;
    const row = msg.row;
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if ((row.mode || 'hub') !== activeMode) return;   // only the ACTIVE mode's messages land in the panel
    if (row.role === 'tool') return;               // (tools now arrive as 'activity', never as messages)
    if (_card) _card.upsert(row);                  // user/assistant → conversation
    threadSubs.forEach((f) => f(row));             // any other view of the same thread
  } }, { onOpen: () => { if (_card) _card.backfill(); threadSubs.forEach((f) => f(null)); } });
  // The conversation must reflect the active mode's thread live, from ANY source — hence the onOpen
  // resync above (every reconnect, including the watchdog's rebuild and the first connect) plus this
  // one on returning to the foreground. A mobile browser silently suspends the stream when backgrounded
  // and never replays what it missed; without these the thread shows only what THIS device sent until a
  // manual refresh. backfill() is idempotent — a full rebuild — so resyncing costs nothing.
  if (_card) document.addEventListener('visibilitychange', () => { if (!document.hidden) _card.backfill(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) threadSubs.forEach((f) => f(null)); });
}

// ---- other views of the hub thread ---------------------------------------
// A page can show the conversation somewhere besides the card — the phone home's one-line
// prompt/reply strip does. They subscribe HERE rather than opening their own EventSource: this page
// already holds /api/voice-stream open, and a second one on the same endpoint is the duplication
// tv.js was split out to stop (a phone paying for two sockets and two backfills for the life of the
// page). The callback gets each new row, and `null` meaning RESYNC — a reconnect, or the tab coming
// back to the foreground, where a suspended stream has already missed whatever arrived.
export function onThread(fn) { threadSubs.push(fn); fn(null); }

// THE ANSWER BEING LOOKED AT. While an answer from the inbox is open on its own (inbox.js), every
// command sent from this page — the mic or typed — is about it: it rides as `about`, and the worker
// hands the model that question and answer with the words (docs/WATCH.md § The inbox).
// Taken when the clip is QUEUED, not when it uploads, so a clip that waits in the outbox stays about
// what was on screen when it was said.
let aboutAnswer = null;
export function setAbout(id) { aboutAnswer = id || null; }

// ---- the command that has been HEARD but is not in the thread yet ---------
//
// The worker writes the user bubble only once the run is over — deliberately, so a wake-word false
// positive never lands in the thread — which means a thread view shows nothing at all between speaking
// and the reply, and then both lines at once. The conversation CARD covers that with its own optimistic
// bubble; this is the same thing for every OTHER view of the thread (the phone home page's box).
//
// Two sources, and both are needed. `transcribing` and the transcript that comes back from the upload
// are LOCAL — only the device that recorded knows a clip is in the air. The worker's `working` activity
// carries the transcript to every device, which is what makes a command spoken at the ESP or the Mac
// appear here too; it arrives second on the recording device and says the same thing.
const pendingSubs = [];
export function onPending(fn) { pendingSubs.push(fn); }
function pushPending(p) { for (const f of pendingSubs) { try { f(p); } catch (_) {} } }

// ---- what the run is DOING, frame by frame -------------------------------
//
// The same frames the activity bar draws, handed to any other view that wants them: a tool call, a
// thought between tool calls, and the `done` / `error` that ends the run. The
// bar is a popup over the page and the phone's home page hides it outright, so a surface that wants
// this inside its own conversation subscribes here rather than re-styling the bar. Hub focus only —
// a session's frames run on /api/session-stream, which cards/repos.js holds.
const activitySubs = [];
export function onActivity(fn) { activitySubs.push(fn); }
function pushActivity(a) { for (const f of activitySubs) { try { f(a); } catch (_) {} } }

// ONE microphone, OPEN ONLY WHILE SOMETHING IS RECORDING.
//
// A recorder claims it when a recording starts (a tap, or the always-on listener being engaged) and
// lets go when it ends; the device closes when nothing holds it. An open capture keeps the phone's
// audio session in `.playAndRecord`, which takes it out from under anything playing — the alarm's
// `.playback` claim included, which reduced a ring to its first moment. So the page does not hold the
// mic just because it is on screen.
//
// The cost is the acquisition on every tap: iOS takes up to two seconds to hand over a capture device
// (measured at 2,017ms from tap to first frame). The button shows the tap at once (`arming`), so the
// wait reads as the mic opening rather than as a dropped press.
//
// Released the moment the page is hidden too: iOS interrupts a backgrounded capture anyway, and the
// recording indicator has no business staying lit over another app. A track can also end under us
// (another app takes the mic, the OS interrupts) — hence the readyState check rather than trusting
// the reference.
// (`micStream`/`micPending`/`micUsers` are declared at the top of the file with the rest of boot()'s
// state — boot() runs above this point, and a `let` it touches would still be in the temporal dead
// zone here.)
// A TRACK THAT WENT SILENT STILL SAYS IT IS LIVE. An audio interruption on iOS — anything else on
// the page or the phone taking the audio session — leaves a capture track producing zeros with
// `readyState` unchanged at 'live'. Reusing it then is permanent: every recording afterwards is
// silence. Measured 2026-09-19, after the page started playing alarm tones.
//
// `micDirty` is set by anything that could have taken the session, and by an empty transcript from a
// clip with bytes in it (deliverVoice), which is the one signal that means "we just recorded silence"
// whatever the cause.
let micDirty = false;
export function dirtyMic() { micDirty = true; }
function micLive() {
  if (micDirty) return false;
  return micStream && micStream.getTracks().some((t) => t.readyState === 'live');
}
// THE DEVICE'S OWN MICROPHONE, NEVER AIRPODS. Connected AirPods become the default input, and
// opening their mic drops the whole link into the hands-free profile: call-quality audio for the
// transcriber, a second of switching that clips the first words, and degraded playback while it is
// held. So the built-in mic is asked for by id and the AirPods stay output only. Labels are empty
// until permission is granted, which is why the first capture may come back on the default and be
// swapped. The labels are the platforms' own names for the built-in device: "iPhone Microphone" in
// WebKit on iOS, "MacBook Air Microphone (Built-in)" in Chrome.
const BUILT_IN = /built-in|^(iphone|ipad) microphone$|^macbook.* microphone$/i;
async function builtInMicId() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const d = all.find((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'
      && d.deviceId !== 'communications' && BUILT_IN.test(d.label));
    return d ? d.deviceId : null;
  } catch (_) { return null; }
}
async function acquireBuiltIn() {
  const gum = (c) => navigator.mediaDevices.getUserMedia({ audio: c });
  let id = await builtInMicId();
  if (id) { try { return await gum({ deviceId: { exact: id } }); } catch (_) {} }
  const s = await gum(true);
  const label = s.getAudioTracks()[0]?.label || '';
  if (id || BUILT_IN.test(label) || !(id = await builtInMicId())) return s;
  try {
    const pinned = await gum({ deviceId: { exact: id } });
    s.getTracks().forEach((t) => t.stop());
    return pinned;
  } catch (_) { return s; }
}
function mic() {
  if (micLive()) return Promise.resolve(micStream);
  // Let go of the old tracks before asking for new ones: a silent-but-live track still holds the
  // device, and a fresh getUserMedia can hand back the same dead capture rather than a new one.
  if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
  micStream = null; micDirty = false;
  if (!micPending) {
    micPending = acquireBuiltIn()
      .then((s) => {
        micStream = s;
        clientLog({ ev: 'mic-device', label: s.getAudioTracks()[0]?.label || '' });
        // The loud way a capture dies: the track ends and says so. Marking it here means the next
        // caller re-acquires instead of building a MediaRecorder over a finished device. (The quiet
        // way — still 'live', producing zeros — is caught by the empty transcript in deliverVoice.)
        for (const t of s.getTracks()) t.addEventListener('ended', () => { micDirty = true; });
        return s;
      })
      .finally(() => { micPending = null; });
  }
  return micPending;
}
function releaseMic() {
  const s = micStream; micStream = null;
  if (s) s.getTracks().forEach((t) => t.stop());
  if (micPending) micPending.then((p) => p.getTracks().forEach((t) => t.stop())).catch(() => {});
}
async function claimMic() {
  micUsers++;
  try { return await mic(); } catch (e) { unclaimMic(); throw e; }
}
function unclaimMic() {
  micUsers = Math.max(0, micUsers - 1);
  if (!micUsers) releaseMic();
}
// Called by every surface that can record (the hub's boot, and the /mic web-clip). Opens nothing: it
// only wires the events that make a held capture suspect or unwanted.
export function watchMic() {
  // Anything on this page that PLAYS audio may have taken the session with it — the alarm, a tone
  // preview in Settings, the sound bench. They say so rather than this trying to detect it
  // (`hub:audioplaying` as the sound starts, `hub:audioplayed` once it is over), and a capture held
  // across either is re-acquired by the next claim.
  document.addEventListener('hub:audioplaying', dirtyMic);
  document.addEventListener('hub:audioplayed', dirtyMic);
  // Hidden closes the device whoever holds it, and forgets the holders: each recorder's own release
  // afterwards finds nothing left to close.
  const drop = () => { micUsers = 0; releaseMic(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) drop(); });
  window.addEventListener('pagehide', drop);
  // A device arriving or leaving (AirPods, a car) re-routes a held capture, which makes it the first
  // suspect for a damaged one (see captureDamaged). Logged rather than acted on: re-acquiring here would
  // cut off a recording in progress and cost the next tap a cold start, on no evidence yet that a route
  // change is what breaks it. `mic-devicechange` beside `mic-damaged` in the hub log settles that.
  try {
    navigator.mediaDevices.addEventListener('devicechange', () =>
      audioDevices().then((devices) => clientLog({ ev: 'mic-devicechange', devices, visible: !document.hidden })));
  } catch (_) {}
}

// TEMPORARY. Every pointer event and every recorder state change, reported to the hub's log, because
// the stop tap misbehaves only on the user's phone and nothing here can see that. `fly logs | grep tap`.
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

// **A mic button: tap to start, tap to send, press and hold to throw the recording away** — the same
// press and hold (0.6s) as the watch (docs/WATCH.md). A press on a button that is NOT recording starts
// on pointerdown, as every tap here does (bindTap). A press on one that IS recording cannot be judged
// until the finger lifts or the hold runs out, so the send waits for pointerup: sending on pointerdown
// would send every hold before it could become a cancel. A clip already on its way up is never thrown
// away. A pointercancel (the touch became a scroll) does neither, and the recording carries on.
// touch-action and the callout are switched off on the button, or iOS takes a held finger for a scroll
// or a long-press menu and cancels the pointer before the hold completes.
const HOLD_MS = 600;
export function bindMic(el, rec) {
  let timer = null, fromPointer = false;
  const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.style.touchAction = 'none';
  el.style.webkitTouchCallout = 'none';
  el.style.webkitUserSelect = 'none';
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    trace('pointerdown', { type: e.pointerType, id: e.pointerId, primary: e.isPrimary, live: rec.live });
    e.preventDefault(); fromPointer = true;
    disarm();
    if (!rec.live) { rec.toggle(); return; }
    timer = setTimeout(() => { timer = null; trace('hold:cancel'); rec.cancel(); }, HOLD_MS);
  });
  el.addEventListener('pointerup', () => { if (timer) { disarm(); rec.toggle(); } });
  el.addEventListener('pointercancel', () => { trace('pointercancel'); disarm(); });
  el.addEventListener('click', (e) => {
    trace('click', { detail: e.detail, fromPointer });
    if (fromPointer || e.detail !== 0) { fromPointer = false; return; }
    rec.toggle();
  });
}

// Speech needs a few tens of kbps. Left to itself iOS Safari's recorder has produced ~1.5 Mbps, which
// put a two-minute command over the transcription service's upload cap. The server now takes a clip of
// any size (lib/transcribe.js), but every byte still has to go up over the phone's connection first.
// WebKit picks the audio bandwidth from this number. Measured on desktop WebKit with a 146-second read:
// 32k drops to narrowband (~4 kHz) and cost Whisper seven misheard words; 48k is super-wideband and the
// lowest that transcribed cleanly; 64k reaches fullband, the same as the unconstrained default (192k).
// 96k is deliberate headroom over that cliff, since the phone's WebKit may place its steps elsewhere —
// with no size cap on the server, the extra bytes only cost upload time.
// Global mute: a phone microphone that is capturing is an explicit, hard-coded-route input — while it
// is open, every always-on auto-routing listener (Mac wake-word, wake-free, ESP) must go deaf. Same
// shared voice_muted flag the push-to-talk dictation uses; the listeners react to it via realtime.
//
// MODULE SCOPE, because both microphones need it. It lived inside makeRecorder, so makeListener's
// call to it threw a ReferenceError — which left the always-on button stuck on, since the throw
// happened before the state reset. A bare identifier is assumed global, so nothing catches this at
// build time.
function muteOthers(on) {
  // The phone HOLDS the mute rather than setting the flag: every mic is deaf while ANY source holds
  // one, so a phone finishing cannot wake the room while the Mac is still dictating (/api/voice-mute).
  fetch('/api/voice-mute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder: 'phone', on: !!on }) }).catch(() => {});
}

const VOICE_BPS = 96000;

// A self-contained recorder: getUserMedia → MediaRecorder → upload to /api/voice-command.
// quick=true marks a one-off quick-add (the FAB) so the server tags it for a terse reply.
// dryWhen (optional): checked at upload time — when true, the server only transcribes (?dry=1) and the
// text goes to onTranscript instead of enqueueing. The chat composer uses this while photos are pending,
// so a dictated command joins the text box and sends WITH the photos, not ahead of them.
// Exported so the wall-mode push-to-talk button (wall.js) can reuse the exact same pipeline.
// onState reports the button's one visual state: 'armed' (tapped — the mic is opening, or the clip is
// on its way up), 'rec' (actually capturing) or 'idle'. Callers paint it; nothing else infers it.
//
// AN INTERRUPTION PAUSES A COMMAND; IT NEVER SENDS IT AND NEVER THROWS IT AWAY. A timer or alarm going
// off, Siri, a call, the page being hidden, or the capture dying under it ends the MediaRecorder; the
// audio so far is HELD (`held`) and the button reads 'armed'. The user carries on with a tap, or it carries on
// by itself when the interruption ends (the app's `hub:audiointerrupt`) or the page is shown again.
// MediaRecorder files from two recordings cannot be joined, so each held part goes up on its own as a
// dry transcription and its words are handed to the hub as the last part's prefix (deliverVoice), which
// enqueues one command. Its `dur` is the last part's alone: the hub checks the clip against it.
//
// PRESS TO START, PRESS TO SEND, and nothing else ends a recording or decides whether it is sent. DO
// NOT ADD A VAD HERE: one ends a recording at a pause and discards a clip it judges silent without a
// word, and on the user's phone it judges whole spoken commands silent — the button records, throws the
// words away and shows nothing. A pressed button has already said the user is talking; the always-on
// listener (makeListener) is where a machine decides.
export function makeRecorder({ onStatus = () => {}, onState: paint = () => {}, quick, dryWhen, onTranscript }) {
  // Every path through a recording ends in 'idle', so the state is what holds a reload off: anything
  // else — arming, capturing, the clip on its way up — is a recording a reload would destroy.
  let holding = false;
  const onState = (st) => {
    const busy = st !== 'idle';
    if (busy !== holding) { holding = busy; holdReload(busy); }
    paint(st);
  };
  let recording = false, rec = null, chunks = [], stream = null, startedAt = 0;
  let arming = false;                 // tapped, mic not open yet — see start()
  let claimed = false;                // holds one of the page's mic claims — see claimMic()
  let sending = false;                // stopped, clip still on its way up — see stop()
  let discard = false;                // cancel(): this recording ends without being sent
  let held = [];                      // parts recorded before an interruption, waiting for the rest
  let paused = false;                 // interrupted: `held` is waiting for the user to carry on
  let pausing = false;                // pause(): the recorder is stopping to be held, not sent
  const pickMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'])
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  };
  // A tap has to LOOK live from the instant it lands. getUserMedia takes a beat on a phone — longer
  // after the page has been backgrounded — and `recording` only flipped once it resolved, so the button
  // sat unchanged through that window, the press read as dropped, and the retap started a SECOND capture
  // on top of the first. Both then shared one `chunks`, and the orphaned stream held the mic open, so
  // what reached Groq was an empty clip — which it transcribes as "Thank you." rather than as nothing.
  // `arming` is set synchronously, before the await, so a second tap can only ever be a stop.
  async function start() {
    if (recording || arming || sending) return;
    const resuming = paused;
    paused = false;
    arming = true; onState('armed');          // the tap is acknowledged here, not when the mic opens
    trace(resuming ? 'resume:arming' : 'start:arming');
    let s;
    try { s = await claimMic(); }
    catch (_) {
      arming = false;
      // A resume the system refuses (the alarm still has the session) stays paused for the next try.
      if (resuming) { paused = true; trace('resume:refused'); return; }
      onState('idle'); onStatus('Mic permission denied', 'err'); return;
    }
    claimed = true;
    if (!arming) { release(); return; }   // tapped again while arming → cancelled, and the mic closes
    arming = false; stream = s;
    const mime = pickMime();
    chunks = [];
    rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: VOICE_BPS });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    // A recording can end WITHOUT stop(): hiding the page closes the mic under it, and so does a
    // capture reset or an interruption. That is a PAUSE (hold): the state has to follow, or `recording`
    // stays true over a dead recorder and the next tap is spent stopping it.
    rec.onstop = () => {
      if (pausing || recording) { pausing = false; recording = false; hold(mime); return; }
      upload(mime);
    };
    // The capture going quiet under the recording is the other face of an interruption.
    for (const t of stream.getAudioTracks()) t.onmute = () => pause('track-muted');
    rec.start(); recording = true; startedAt = performance.now(); onState('rec');   // capturing for real now — full fill
    trace('start:recording', { mime });
    muteOthers(true);   // mute every other listener (Mac + ESP) while this explicit command records
    onStatus('Listening… tap to send', 'rec');
    // No duration cap: a recording ends when the user taps again, never on a clock. A wall-clock cap cut
    // long instructions off mid-sentence.
  }
  function stop() {
    // Tapped again before the mic ever opened: cancel the arming rather than fall through as a no-op.
    if (arming) {
      arming = false;
      if (held.length) { paused = true; onState('armed'); return; }   // still paused: what was held stays
      onState('idle'); onStatus('', 'clear'); return;
    }
    if (!recording) return;
    recording = false;
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
  // Stops the recorder to HOLD what it has (see onstop). Only while capturing: an arming tap has
  // nothing to keep.
  function pause(why) {
    if (!recording || !rec || rec.state === 'inactive') return;
    pausing = true;
    trace('pause', { why });
    try { rec.stop(); } catch (_) { pausing = false; }
  }
  function hold(mime) {
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    if (blob.size) held.push(blob);
    for (const t of (stream ? stream.getAudioTracks() : [])) t.onmute = null;
    release();
    dirtyMic();          // whatever capture survives the interruption is suspect: the next claim reopens
    muteOthers(false);   // nobody knows how long the alarm rings: the room mics are not held deaf
    paused = true; onState('armed');
    trace('paused', { parts: held.length });
  }
  // Carries a paused command on, from anything that says the microphone is the user's again.
  const carryOn = (why) => { if (paused && !sending) { trace('resume', { why }); start(); } };
  document.addEventListener('hub:audiointerrupt', (e) => {
    if (e.detail && e.detail.began) pause('interrupted'); else carryOn('interruption-ended');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) carryOn('shown'); });
  // A finished recording lets go of the microphone, which closes it unless another recorder holds it.
  function release() {
    stream = null;
    if (claimed) { claimed = false; unclaimMic(); }
  }
  async function upload(mime) {
    trace('upload:begin');
    try { await send(mime); } finally { sending = false; onState('idle'); trace('upload:end'); }
  }
  async function send(mime) {
    release();
    muteOthers(false);   // FAB done with the mic → the other listeners resume
    const dry = typeof dryWhen === 'function' && dryWhen();
    let blob = new Blob(chunks, { type: mime || 'audio/webm' });
    let dur = (performance.now() - startedAt) / 1000;
    let prefixParts = held;
    chunks = []; held = [];
    if (discard) { discard = false; onStatus('', 'clear'); return; }
    // No bytes at all: nothing to send. A dictation caller is told, so it can leave its own state.
    // A clip WITH bytes always goes up — the hub's transcript is the judge of whether it held words.
    // A last part with nothing in it still sends the parts held before it.
    if (!blob.size && !prefixParts.length) {
      if (dry && typeof onTranscript === 'function') onTranscript('');
      onStatus('', 'clear');
      return;
    }
    if (!blob.size) { blob = prefixParts[prefixParts.length - 1]; prefixParts = prefixParts.slice(0, -1); dur = 0; }
    // Durable from here: the clip stays on the phone until the server confirms it (the voice outbox).
    await sendVoice({ blob, dry, quick: !!quick, dur,
                      ...(prefixParts.length ? { prefixParts } : {}) }, { onStatus, onTranscript });
  }
  return {
    toggle() {
      trace('toggle', { recording, arming, sending, paused, recState: rec ? rec.state : null });
      if (sending) return;
      // A paused command is carried on, never sent half-said: the press after the user finishes sends it.
      (recording || arming) ? stop() : start();
    },
    // Ends the recording WITHOUT sending it — for a caller whose recording has lost its purpose (the user
    // navigated away from what it was for). stop() always sends; that is what a stop tap means.
    cancel() {
      if (paused) { paused = false; held = []; onState('idle'); onStatus('', 'clear'); return; }
      if (recording) discard = true;
      stop();
    },
    // Recording, or tapped and waiting for the mic: what a press and hold can still throw away.
    get live() { return recording || arming; },
    start, stop };
}

// ---- always-on listening, on the phone -----------------------------------
// THE OTHER SHAPE OF MICROPHONE. The FAB above is press/press: it records exactly what the user chose to
// record and ends when the user says so, with nothing deciding on the user's behalf. This is what the Mac and the
// ESP already do — the mic stays open, each utterance is cut at the silence after it and sent on its
// own, and it keeps going until the user turns it off.
//
// THE RECORDER RUNS THE WHOLE TIME, and utterances are cut out of it rather than started by speech.
// Starting a MediaRecorder when the VAD first hears something loses the onset of the word that
// triggered it — the failure the Mac spent a long time on — so instead a segment is already running
// before the user speaks, ends at the silence, and the next one starts in the same tick. The silence
// carried at the front of a clip costs nothing; a missing first syllable costs the command.
//
// Silence alone is never uploaded: a segment that never crossed the threshold is dropped, because
// Whisper does not return an empty string for silence, it invents a plausible sentence.
const LISTENER_SOURCE = 'phone';   // its name among the listeners; see docs/LISTENERS.md
export function makeListener({ onStatus = () => {}, onState = () => {} } = {}) {
  const HANG_MS = phoneHangMs;          // phone_silence_s
  const IDLE_CYCLE_MS = 30000;          // recycle an unspoken segment rather than buffer forever
  let on = false, actx = null, vadT = null, rec = null, chunks = [], mime = '';
  let claimed = false;                // holds one of the page's mic claims while engaged
  let heard = false, segStart = 0, stream = null, spokeAt = 0;

  // MediaRecorder delivers its final chunk to ondataavailable AFTER stop() resolves, so a segment can
  // only be assembled in onstop. Each segment therefore carries its own decision — send or discard —
  // rather than the caller trying to read `chunks` at the moment it asks for the cut.
  //
  // AND EACH RECORDER FILLS ITS OWN ARRAY. That late final chunk is most of the segment (there is no
  // timeslice, so it is usually all of it), and it arrives after the next segment has started. Pushed
  // into a shared `chunks`, it landed in the NEXT clip: one upload came up holding 48% of its segment
  // and the next 258%, the second being two recordings glued together.
  function cut(send) {
    if (!rec || rec.state === 'inactive') return;
    const take = send && heard;
    const dur = (performance.now() - segStart) / 1000;
    const bucket = chunks, type = mime || 'audio/webm';
    const from = spokeAt ? new Date(spokeAt).toISOString() : null;
    const to = new Date().toISOString();
    rec.onstop = () => {
      const blob = new Blob(bucket, { type });
      if (take && blob.size) {
        // The button follows the CLIP, not a timer: 'busy' while it is going up and being
        // transcribed, then back to listening the moment that settles. Anything else would be the
        // button claiming a state it does not know.
        const relay = (t, kind) => {
          onStatus(t, kind);
          if (kind === 'busy') onState('sending');
          else if (on) onState('listening');
        };
        onState('sending');
        sendVoice({ blob, dry: false, quick: true, dur, source: LISTENER_SOURCE,
                    ...(from ? { capture_start: from, capture_end: to } : {}) }, { onStatus: relay });
      }
    };
    try { rec.stop(); } catch (_) {}
    rec = null;
  }

  function startSegment() {
    if (!stream) return;
    const own = [];
    chunks = own; heard = false; spokeAt = 0; segStart = performance.now();
    try {
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: VOICE_BPS });
    } catch (_) { rec = null; return; }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) own.push(e.data); };
    try { rec.start(); } catch (_) {}
  }

  async function engage() {
    if (on) return;
    on = true; onState('listening'); onStatus('Listening…', 'rec');
    let s;
    try { s = await claimMic(); }
    catch (_) { on = false; onState('idle'); onStatus('Mic permission denied', 'err'); return; }
    if (!on) { unclaimMic(); return; }    // turned off while the mic was opening
    claimed = true; stream = s;
    mime = pickListenMime();
    // IT DOES NOT MUTE ANYTHING. The Mac and the ESP already listen at the same time and the worker
    // collapses whichever of them heard the same utterance, so a third always-on mic is a peer under
    // that same rule rather than something the others have to stand down for. The deliberate button
    // still mutes, because a hard-routed command is not a listener.
    startSegment();
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.resume) actx.resume();
      const an = actx.createAnalyser(); an.fftSize = 1024;
      actx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let floor = Infinity, silence = 0;
      vadT = setInterval(() => {
        if (!on) return;
        an.getByteTimeDomainData(buf);
        let acc = 0; for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; acc += d * d; }
        const rms = Math.sqrt(acc / buf.length), now = performance.now();
        if (rms < floor) floor = rms;     // quietest frame so far — the gaps between words sit near it
        const thr = Math.max(floor * 2.5, 0.02);
        // The window is the UTTERANCE, not the segment. A segment starts before the user speaks (that is how
        // the onset is kept), so its own start would overlap the previous one and collapse two real
        // commands into one.
        if (rms >= thr) { if (!heard) { spokeAt = Date.now(); onState('hearing'); } heard = true; silence = 0; onStatus('Hearing you…', 'rec'); return; }
        if (heard) {
          if (!silence) silence = now;
          else if (now - silence >= HANG_MS) {       // utterance over → send it, keep listening
            silence = 0;
            cut(true); startSegment();
            onState('listening'); onStatus('Listening…', 'rec');
          }
          return;
        }
        // Nothing said for a while: recycle the segment so an idle hour is not one enormous blob.
        if (now - segStart > IDLE_CYCLE_MS) { cut(false); startSegment(); }
      }, 60);
    } catch (_) { /* no Web Audio: the mode cannot segment, so it stays a plain open mic */ }
  }

  // The state reset is in a `finally` on purpose. Anything in the teardown throwing used to leave the
  // button lit with the mode already off — a control that will not turn off is worse than one that
  // fails loudly, because there is nothing left to press.
  function disengage(send = true) {
    if (!on) return;
    on = false;
    try {
      if (vadT) { clearInterval(vadT); vadT = null; }
      if (actx) { try { actx.close(); } catch (_) {} actx = null; }
      cut(send);                          // whatever the user was mid-way through still counts
      stream = null;
      if (claimed) { claimed = false; unclaimMic(); }   // this mode was holding it; let it close
    } finally {
      onState('idle'); onStatus('', 'clear');
    }
  }
  // A capture the hub found damaged is replaced under every recorder at once (captureDamaged). This
  // mode holds its stream for as long as it is on, so it re-engages onto the new one — dropping the
  // segment in progress, which was recorded on the damaged capture.
  document.addEventListener('hub:micreset', () => { if (on) { disengage(false); engage(); } });

  return { engage, disengage, toggle() { on ? disengage() : engage(); }, get on() { return on; } };
}
function pickListenMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
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
  }
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
  const item = { id: uid(), createdAt: Date.now(), client_now: localNowNaive(), type: clip.blob.type || 'audio/webm',
    ...(aboutAnswer && !clip.dry ? { about: aboutAnswer } : {}), ...clip };
  try { await voiceBox.put(item); }
  catch (_) {                                          // no IndexedDB (a private window) — memory is the only copy there is
    try { await deliverVoice(item, owner.onStatus, owner); } catch (e) { voiceFailed(e, item, owner.onStatus); }
    if (reloadForCapture) location.reload();
    return;
  }
  voiceOwners.set(item.id, owner);
  await runVoiceOutbox();
}

// Where this device is, for "near me" and a pickup point. A fix up to two minutes old is reused so a
// command does not wait on the GPS; no permission, no fix in time, or no API at all just means the
// command goes without one.
function hereNow() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let timer = null;
    const done = (v) => { clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => resolve(null), 2000);
    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      () => done(null), { maximumAge: 120000, timeout: 2000 });
  });
}

// Upload one clip and act on the answer. Throws if the server did not take it; `refused` marks an
// answer from the server, as opposed to never reaching it.
async function deliverVoice(item, onStatus, owner) {
  onStatus('Transcribing…', 'busy');
  // A dictation goes into a text box, not into the conversation, so it is nobody else's business.
  if (!item.dry) pushPending({ state: 'transcribing' });
  const qp = new URLSearchParams();
  if (item.dry) qp.set('dry', '1');
  if (item.quick) qp.set('quick', '1');
  qp.set('client_now', item.client_now);               // this device's own wall clock, wherever it is
  qp.set('client_msg_id', item.id);
  if (item.dur > 0) qp.set('dur', item.dur.toFixed(1));
  // The capture window, when the caller knows it. This is what lets a listener be collapsed against
  // the other mics that heard the same words — see docs/LISTENERS.md. A clip uploads after it was
  // recorded, sometimes much later out of the outbox, so arrival time says nothing about when it was
  // spoken and only these two do.
  if (item.capture_start) qp.set('capture_start', item.capture_start);
  if (item.capture_end) qp.set('capture_end', item.capture_end);
  if (item.source) qp.set('source', item.source);
  if (item.about) qp.set('about', item.about);
  // The parts recorded before an interruption (makeRecorder): each is transcribed on its own and the
  // words ride the last part as its prefix, so the hub enqueues the whole command once. A part that
  // fails throws, and the outbox retries the whole item.
  const prefix = [];
  for (const part of item.prefixParts || []) {
    const pr = await fetch('/api/voice-command?dry=1', { method: 'POST', headers: { 'Content-Type': part.type || item.type }, body: part,
      ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(VOICE_SEND_MS) } : {}) });
    const pj = await pr.json().catch(() => ({}));
    if (!pr.ok || pj.error) throw Object.assign(new Error(pj.error || 'Send failed'), { refused: true });
    if (pj.transcript) prefix.push(pj.transcript.trim());
  }
  const where = item.dry ? null : await hereNow();      // a dictation into the text box goes nowhere yet
  if (where) for (const k of ['lat', 'lon', 'acc']) qp.set(k, String(where[k]));
  // BOUNDED. Every clip on the page goes through one serial outbox, so a request that never answers
  // (a phone between networks) would hold every mic button in its sending state indefinitely. On
  // timeout it is a network failure: the clip stays in the box and the button is free again.
  const headers = { 'Content-Type': item.type };
  if (prefix.length) headers['X-Voice-Prefix'] = encodeURIComponent(prefix.join(' '));
  const r = await fetch('/api/voice-command?' + qp, {
    method: 'POST', headers, body: item.blob,
    ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(VOICE_SEND_MS) } : {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || 'Send failed'), { refused: true });
  if (j.duplicate) { onStatus('', 'clear'); pushPending({ state: 'clear' }); }  // an earlier attempt already enqueued it
  else if (j.capture === 'damaged') {
    captureDamaged(item, j);
    onStatus('Didn’t catch that — try again', 'err');
    if (!item.dry) pushPending({ state: 'clear' });
  }
  else if (!j.transcript) {
    // NOTHING CAME BACK FROM A CLIP THAT HAD AUDIO IN IT. Whisper returns empty for silence, so this
    // is the evidence EVERY recorder produces that the microphone handed us zeros — and the stream
    // it came from stays `readyState: 'live'` while doing it, so nothing else will ever notice.
    //
    // Here rather than in any recorder, because every recorder produces this and none of them judges
    // silence itself.
    //
    // Bytes are the qualifier: a clip too short to contain anything is not evidence of a dead mic.
    if ((item.blob ? item.blob.size : 0) > 2048) {
      dirtyMic();
      clientLog({ ev: 'mic-empty-transcript', bytes: item.blob.size, dur: item.dur, dry: !!item.dry });
    }
    onStatus('Didn’t catch that — try again', 'err');
    if (!item.dry) pushPending({ state: 'clear' });
  }
  else if (item.dry) { captureResetAt = 0; owner.onTranscript(j.transcript); onStatus('', 'clear'); }   // compose mode: into the text box
  else {                                                                     // show what was heard, then stream the run
    captureResetAt = 0;
    if (_card) _card.optimistic({ text: j.transcript, kind: 'text' });       // the spoken command as its own live user bubble
    pushPending({ state: 'prompt', text: j.transcript });                    // and in every other view of the thread
    onStatus(j.transcript, 'prompt'); onStatus('Thinking…', 'busy');
  }
}

// ---- a capture that drops frames ------------------------------------------------------------------
// THE HUB MEASURES EVERY CLIP against how long it was recorded and answers `capture: 'damaged'` when
// most of it is missing (/api/voice-command). The phone's capture can keep one frame in about nine —
// 36.7s of talking arriving as 4.2s of fragments, an effective 5.5kHz, which is a sample-rate
// mismatch somewhere beneath the page — while its track still reports live and unmuted. Nothing on the
// page can see it; only the clip shows it.
//
// Recovery escalates. First a fresh capture: every track stopped and the device asked for again, under
// every recorder at once. If a clip recorded on that fresh capture is damaged too, the fault is below
// the stream, and the page reloads — the one thing that throws away everything a page owns that
// touches audio (both AudioContexts, every media element, WebKit's capture for this page) together.
// The reload waits until the outbox has let go of the clip: resent on load, it would be refused and
// reload again.
let captureResetAt = 0, reloadForCapture = false;
function captureDamaged(item, j) {
  const escalate = captureResetAt > 0 && item.createdAt > captureResetAt;
  diagnoseCapture({ held_s: j.held_s, dur: j.dur, bytes: item.blob ? item.blob.size : 0,
    source: item.source || (item.dry ? 'dry' : 'fab'), action: escalate ? 'reload' : 'reacquire' });
  if (escalate) { reloadForCapture = true; return; }
  captureResetAt = Date.now();
  releaseMic();
  document.dispatchEvent(new CustomEvent('hub:micreset'));
}
// Everything the page can say about the capture, taken BEFORE it is released: which device, at what
// rate, and what else was plugged in. This is how the cause gets found the next time it happens.
function diagnoseCapture(fields) {
  const t = micStream && micStream.getAudioTracks()[0];
  const track = t ? { state: t.readyState, muted: t.muted, label: t.label, ...(t.getSettings ? t.getSettings() : {}) } : null;
  audioDevices().then((devices) => clientLog({ ev: 'mic-damaged', ...fields, track, devices,
    page_s: Math.round(performance.now() / 1000), guided: window.__guidedAccess }));
}
function audioDevices() {
  try {
    return navigator.mediaDevices.enumerateDevices()
      .then((ds) => ds.filter((d) => d.kind.startsWith('audio')).map((d) => `${d.kind}:${d.label}`))
      .catch(() => null);
  } catch (_) { return Promise.resolve(null); }
}

function voiceFailed(err, item, onStatus) {
  onStatus(err && err.refused ? err.message : 'Send failed', 'err');
  if (!item.dry) pushPending({ state: 'clear' });   // nothing is coming — take the placeholder down
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
    if (reloadForCapture) { location.reload(); return; }   // only now that the damaged clip is out of the box
  }
}

export function activityBar() { return (_activityBar = _activityBar || initActivityBar()); }
export function initActivityBar() {
  const bar = document.createElement('div');
  bar.className = 'ai-act';
  // A quoted "what you said" line (filled after transcription) stacked above the live status row.
  bar.innerHTML =
    '<div class="ai-act-prompt"></div>' +
    '<div class="ai-act-row"><span class="ai-act-dot"></span><span class="ai-act-txt"></span></div>';
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
  const STATES = ['ai-act-rec', 'ai-act-busy', 'ai-act-tool', 'ai-act-done', 'ai-act-err'];
  let hideT = null;
  let hideAt = 0;             // when the pending hide is due (0 = none) — see the visibilitychange below
  function hide() { clearTimeout(hideT); hideAt = 0; bar.classList.remove('show'); setPrompt(''); }
  // A backgrounded page's timers are suspended with it, so a hide that fell due while the phone was
  // locked would otherwise wait out its remaining delay again after the page comes back.
  if (!KIOSK) document.addEventListener('visibilitychange', () => {
    if (!document.hidden && hideAt && Date.now() >= hideAt) hide();
  });
  function setPrompt(text) {
    const t = (text || '').trim();
    prm.textContent = t ? '“' + t + '”' : '';
    bar.classList.toggle('has-prompt', !!t);     // persists across status changes; cleared on hide/reset
  }
  function show(text, kind, sticky) {
    txt.textContent = text || '';
    bar.classList.remove(...STATES);
    bar.classList.add('show', 'ai-act-' + (kind || 'busy'));
    clearTimeout(hideT); hideAt = 0;
    const ms = !sticky ? (KIOSK ? activityHoldMs : phoneHoldMs)
      : (KIOSK || kind === 'rec') ? 0 : PHONE_STALE_MS;
    if (ms) { hideAt = Date.now() + ms; hideT = setTimeout(hide, ms); }
  }
  return {
    prompt(t) { setPrompt(t); },                  // the transcribed command; stays up for the whole run
    rec(t) { setPrompt(''); show(t || 'Listening…', 'rec', true); },
    busy(t) { show(t, 'busy', true); },          // Transcribing… / Thinking…
    tool(t) { show('⚙ ' + (t || 'tool'), 'tool', true); },
    thought(t) { show(t, 'busy', true); },          // what the model said between tool calls
    done(t) { show(t ? '✓ ' + t : 'Done ✓', 'done', false); },
    err(t) { show(t, 'err', false); },
    clear: hide,
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
  const scrollEnd = () => { log.scrollTop = log.scrollHeight; };
  // NOTHING MOVES THE THREAD WHILE IT IS BEING LOOKED AT — not the user's own words, not a transcript, not
  // a reply, not even with the view already at the bottom. A new line lands below and waits to be scrolled
  // to. The thread lands on its newest line only on ARRIVAL: the first load, coming back to the page after
  // it was hidden (`owed`), and opening the chat sheet (navbar.js).
  let owed = true;
  document.addEventListener('visibilitychange', () => { if (document.hidden) owed = true; });
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
    // A reply is markdown (`md`); the user's own words are shown as typed.
    if (t) inner += '<div class=ai-msg-text>' + (side === 'assistant' ? md(t) : esc(t).replace(/\n/g, '<br>')) + '</div>';
    else if (!local.length && !atts.length) inner += '<div class=ai-msg-text><span class=ai-caret>▍</span></div>';
    // Which worker answered (mac/pi/fly) — dimmed for the expected mac, so a fallback visually pops.
    if (side === 'assistant' && row.worker) {
      const w = esc(String(row.worker));
      inner += '<span class="ai-worker ai-worker-' + w + '">' + w + '</span>';
    }
    // A session's reply relayed into the thread: tinted, and named by the session it came from.
    const session = side === 'assistant' && row.session_id;
    if (session && row.session_label) inner += '<span class=ai-session>' + esc(String(row.session_label)) + '</span>';
    // A reply a fallback engine wrote (voice_messages.engine: 'credits' or 'codex') is coloured by it.
    const engine = side === 'assistant' && /^(credits|codex)$/.test(row.engine || '') ? ' ai-engine-' + row.engine : '';
    // `data-sess` makes it a way into that session (cards/repos.js opens it on a tap).
    const sessAttr = session ? ' data-sess="' + esc(String(row.session_id)) + '"' : '';
    return '<div' + sessAttr + ' class="ai-msg ai-msg-' + side + (session ? ' ai-msg-session' : '') + engine + (row.pending ? ' ai-msg-pending' : '') + '">' + inner + '</div>';
  }
  // A divider where one conversation context ends and the next begins; never two in a row.
  function rule() {
    const last = log.lastElementChild;
    if (!last || last.classList.contains('ai-ctx-rule')) return;
    const hr = document.createElement('div');
    hr.className = 'ai-ctx-rule';
    log.appendChild(hr);
  }
  function upsert(row) {
    if (!row || (row.focus || 'hub') !== 'hub') return;
    if (row.role === 'tool') return;        // tool calls live in the activity bar, not the thread
    reconcile(row);                         // a real row for a locally-sent message replaces its optimistic bubble
    // The server flags the first row of each new context (an idle gap or a manual reset). The older
    // context stays in the thread behind a divider rather than being wiped.
    const fresh = !seen.has(row.id);
    if (fresh && row.ctx_break) rule();
    const tmp = document.createElement('div'); tmp.innerHTML = bubbleHtml(row);
    const el = tmp.firstElementChild, existing = seen.get(row.id);
    if (existing) existing.replaceWith(el); else log.appendChild(el);
    seen.set(row.id, el);
    while (log.childElementCount > MAX_MSGS) {
      const o = log.firstElementChild;
      for (const [id, e] of seen) { if (e === o) { seen.delete(id); break; } }
      o.remove();
    }
  }
  function dropPending(cid) {
    const p = pending.get(cid); if (!p) return;
    p.el.remove();
    (p.localImages || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
    pending.delete(cid);
  }
  function clear() { log.innerHTML = ''; seen.clear(); for (const cid of [...pending.keys()]) dropPending(cid); }
  // Optimistic send: render the user's own message/photo the instant they send it, before the worker has
  // processed anything. The matching server row (via SSE or backfill) replaces it later — see reconcile().
  function optimistic(o) {
    const cid = o.clientId || ('c-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
    const holder = document.createElement('div');
    holder.innerHTML = bubbleHtml({ role: 'user', text: o.text || '', localImages: o.localImages || [], pending: true });
    const el = holder.firstElementChild;
    log.appendChild(el);
    pending.set(cid, { el, paths: (o.paths || []).filter(Boolean), text: (o.text || '').trim(),
      kind: o.kind || (o.localImages && o.localImages.length ? 'photo' : (o.text ? 'text' : 'voice')),
      localImages: o.localImages || [], at: Date.now() });
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
      const r = await fetch('/api/voice-messages?focus=hub&mode=' + activeMode + '&limit=200&history=1');   // the active mode's thread, older contexts included and flagged where each begins
      if (!r.ok) return;
      const rows = await r.json();
      const now = Date.now();
      const keep = log.scrollTop;            // a rebuild while being read puts the reader back where they were
      log.innerHTML = ''; seen.clear();      // detaches server + optimistic els; the pending map still holds the optimistic ones
      for (const row of rows) upsert(row);               // reconcile() drops any pending the server thread now contains
      for (const cid of [...pending.keys()]) {           // re-append still-unmatched optimistic bubbles at the bottom
        const p = pending.get(cid);
        if (now - p.at > PENDING_TTL) dropPending(cid);  // never matched in time → it landed under a different key; stop showing it
        else log.appendChild(p.el);
      }
      if (owed && !document.hidden) { scrollEnd(); owed = false; } else log.scrollTop = keep;
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
    try {
      await Promise.all(items.map((i) => i.promise));
      const attachments = items.map((i) => i.path).filter(Boolean);
      if (attachments.length !== items.length) {   // a photo never made it up — don't send half a thought
        setStatus('A photo failed to upload — remove it (✕) and send again');
        textEl.value = text; dropPending(cid);
        return;
      }
      setPendingPath(cid, attachments);            // let the eventual server row reconcile against the uploaded object
      const where = await hereNow();
      const r = await fetch('/api/voice-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, client_now: localNowNaive(), ...(attachments.length ? { attachments } : {}),
                               ...(aboutAnswer ? { about: aboutAnswer } : {}),
                               ...(where ? { location: where } : {}) }) });
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
    // Only failures and clears reach the line. The red mic already says it is listening, and the
    // thread's pending bubble (dots, then the transcript) already says it was heard and is being worked
    // on — a progress line under the composer repeats both and jumps the layout as it comes and goes.
    onStatus: (t, kind) => { if (kind === 'err' || kind === 'clear') setStatus(t); },
    onState: (s) => { micBtn.classList.toggle('ai-rec', s === 'rec');
                      micBtn.classList.toggle('ai-armed', s === 'armed'); },
    dryWhen: () => attItems.length > 0,
    onTranscript: (t) => { textEl.value = (textEl.value.trim() ? textEl.value.trim() + ' ' : '') + t; },
  });
  bindMic(micBtn, cardRec);

  return { upsert, clear, rule, backfill, optimistic, setPendingPath, dropPending };
}

