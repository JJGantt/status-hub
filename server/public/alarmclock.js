// THE PAGE IS THE ALARM CLOCK.
//
// Neither half of the device alarm path can be relied on here, and both were measured failing
// silently on the same night: AlarmKit acked an alarm (`held:2`) that it then never presented, and
// four silent pushes carrying a new alarm to a sleeping phone were refused outright. A page that is
// already open has neither dependency — it holds its own timer to the moment and owns a speaker, so
// nothing has to be delivered at the moment itself.
//
// It lives on the hub's own phone page rather than a page of its own, because the phone is already
// showing this one: the iOS app loads `/`, and asking someone to park a second URL somewhere is a
// step that can be forgotten on exactly the night it matters.
//
// Silent until it fires. Everything below is either idle or a timer.
import { esc } from './shared.js';

const FEED = '/api/due-widget';
const RELOAD_MS = 120000;     // backstop only; the stream is what makes a 4am change land
const BEEP_MS = 1400;

// HOW LONG IT RINGS. Left unbounded it rang for 53 minutes into an empty room, because STOP was the
// only thing that ended it. Matched to ALARM_NAG_MIN on the server so the loud layer and the quiet
// one give up together — two layers that stop at different times is two behaviours to remember.
const RING_MAX_MS = 10 * 60 * 1000;

let items = [], fireT = null, ringT = null, ringEndT = null, ringing = null, actx = null, lock = null;
const fired = new Set();
const keyOf = (it) => `${it.id}:${it.when}`;

// ---- sound ------------------------------------------------------------------------------------
// Web Audio, not an <audio> file: nothing to fetch at 4am and the gain is ours. iOS will not let a
// page make noise until a gesture has authorised the AudioContext, so the context is built on the
// first touch this page receives and kept for the night. Without that the page looks fine and is
// silent at the only moment it matters.
function unlock() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (_) { actx = null; }
}
function beep(at, freq) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(1, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
  o.connect(g); g.connect(actx.destination);
  o.start(at); o.stop(at + 0.36);
}
// A RUNNING AUDIOCONTEXT IS NOT AUDIBLE SOUND, which is the whole reason this exists. An alarm has
// been seen flashing on screen with `actx.state === 'running'`, its oscillators scheduled, and
// nothing coming out of the phone — WKWebView audio plays under the app's audio session, and an app
// that sets none runs ambient, which the ring/silent switch silences. The native side swaps to
// `.playback` for the duration (see "alarmAudio" in StatusHubApp.swift). No-ops in a browser, which
// has no such session to claim.
function nativeAudio(on) {
  try { window.webkit.messageHandlers.alarmAudio.postMessage(on); } catch (_) {}
}
function burst() {
  try {
    if (!actx || actx.state !== 'running') return;
    const t = actx.currentTime;
    beep(t, 880); beep(t + 0.42, 880); beep(t + 0.84, 1175);
  } catch (_) {}
}

// ---- the overlay ------------------------------------------------------------------------------
// Built on demand: until something rings there is nothing of this in the document at all.
function overlay(title, at) {
  let el = document.getElementById('alarmfire');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'alarmfire';
  el.innerHTML = `<div class="af-when">${esc(at)}</div>`
    + `<div class="af-what">${esc(title || '')}</div>`
    + `<button class="af-stop" type="button">STOP</button>`;
  el.querySelector('.af-stop').addEventListener('click', stopRing);
  document.body.appendChild(el);
  return el;
}
function startRing(it) {
  if (ringT) return;
  nativeAudio(true);   // BEFORE unlock(): the session has to be ours before the context makes noise
  unlock();
  ringing = it;
  const d = new Date(it.at);
  const when = `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`;
  overlay(it.title, when).classList.add('on');
  document.body.classList.add('alarming');
  burst();
  ringT = setInterval(burst, BEEP_MS);
  ringEndT = setTimeout(stopRing, RING_MAX_MS);
  try { if (navigator.vibrate) navigator.vibrate([600, 300, 600, 300, 600]); } catch (_) {}
}
function stopRing() {
  clearInterval(ringT); ringT = null;
  nativeAudio(false);   // give the microphone back; .playback cannot record
  clearTimeout(ringEndT); ringEndT = null;
  ringing = null;
  document.body.classList.remove('alarming');
  const el = document.getElementById('alarmfire');
  if (el) el.remove();
  schedule();
}

// ---- the schedule -----------------------------------------------------------------------------
// A LOCAL TIMER TO THE MOMENT, never a poll asking whether it has arrived. Nothing changes anywhere
// when 8:30 happens, so the only thing that can notice is something already awake — which this is.
function nextItem() {
  const now = Date.now();
  return items
    .map((x) => ({ ...x, at: new Date(x.when).getTime() }))
    .filter((x) => Number.isFinite(x.at) && x.at > now - 60000 && !fired.has(keyOf(x)))
    .sort((a, b) => a.at - b.at)[0] || null;
}
function schedule() {
  clearTimeout(fireT); fireT = null;
  const n = nextItem();
  if (!n) return;
  // setTimeout is capped and drifts over hours, so re-arm in steps and let only the final short hop
  // be the real one. A phone that dozed through part of the gap still lands on the right minute.
  const ms = n.at - Date.now();
  if (ms > 60000) { fireT = setTimeout(schedule, Math.min(ms - 30000, 900000)); return; }
  fireT = setTimeout(() => { fired.add(keyOf(n)); startRing(n); }, Math.max(ms, 0));
}
async function load() {
  try {
    const d = await (await fetch(FEED, { cache: 'no-store' })).json();
    items = (d.items || []).filter((x) => x.alarm && x.when);
    // DEALT WITH ELSEWHERE IS STILL DEALT WITH. Clearing the item on the watch or another phone drops
    // it from this feed, and a page still beeping about something already handled is noise nobody can
    // trace back to a cause. The feed is the state; STOP is only one way of changing it.
    if (ringing && !items.some((x) => x.id === ringing.id)) return stopRing();
    schedule();
  } catch (_) { /* keep the schedule already held rather than losing it to a blip */ }
}

// ---- keeping the screen lit -------------------------------------------------------------------
// The page is only an alarm while it is running, and a locked phone does not run timers on any
// schedule worth betting a morning on. iOS drops the lock on every visibility change, so it is
// re-taken rather than taken once.
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch (_) { lock = null; }
}

// ---- saying whether it is actually armed --------------------------------------------------------
// A CLOCK NOBODY CAN CHECK IS THE WHOLE PROBLEM AGAIN. AlarmKit reported holding an alarm it never
// rang; the way not to repeat that is for this to report what it can actually do, not that it
// loaded. `audio` is the one that matters — a suspended context means the beeps are silent — and it
// rides /api/clientlog into the hub log, where it can be read from anywhere.
function beacon() {
  const n = nextItem();
  const body = {
    ev: 'alarmclock',
    audio: actx ? actx.state : 'none',
    lock: !!lock,
    visible: document.visibilityState === 'visible',
    next: n ? new Date(n.at).toISOString() : null,
    in_s: n ? Math.round((n.at - Date.now()) / 1000) : null,
    armed: !!fireT,
    ringing: !!ringT,
  };
  try { navigator.sendBeacon('/api/clientlog', new Blob([JSON.stringify(body)], { type: 'application/json' })); } catch (_) {}
}

// ---- wiring -----------------------------------------------------------------------------------
// The app's WebView sets mediaTypesRequiringUserActionForPlayback = [], so inside StatusHub the
// context starts without a gesture and the page is armed the moment it loads. In a plain browser it
// starts suspended and the first touch promotes it — hence both paths, and hence the beacon, which
// is what distinguishes the two from outside.
['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
  document.addEventListener(ev, () => { unlock(); keepAwake(); }, { passive: true }));
document.addEventListener('visibilitychange', () => { keepAwake(); schedule(); });
// `hub:stream` rides core.js's existing EventSource — a second one on this page is what put two
// streams on a phone once already.
document.addEventListener('hub:stream', load);
setInterval(load, RELOAD_MS);
// A HEARTBEAT, which is the one shape of timer that cannot be replaced by an event: a page that has
// been closed, reloaded away or silently suspended sends nothing, so its liveness can only be read
// from the silence.
setInterval(beacon, 60000);
unlock();          // succeeds immediately inside the app; stays suspended in a browser until touched
keepAwake();
load();
setTimeout(beacon, 2000);
