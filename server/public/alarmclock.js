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

let items = [], fireT = null, ringT = null, actx = null, lock = null;
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
  unlock();
  const d = new Date(it.at);
  const when = `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`;
  overlay(it.title, when).classList.add('on');
  document.body.classList.add('alarming');
  burst();
  ringT = setInterval(burst, BEEP_MS);
  try { if (navigator.vibrate) navigator.vibrate([600, 300, 600, 300, 600]); } catch (_) {}
}
function stopRing() {
  clearInterval(ringT); ringT = null;
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

// ---- wiring -----------------------------------------------------------------------------------
// The first touch anywhere is what authorises sound and takes the lock. There is no button to press:
// a page that needs arming and does not say so is the failure this is here to prevent, so it arms
// itself off any interaction the page was already going to get.
['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
  document.addEventListener(ev, () => { unlock(); keepAwake(); }, { passive: true }));
document.addEventListener('visibilitychange', () => { keepAwake(); schedule(); });
// `hub:stream` rides core.js's existing EventSource — a second one on this page is what put two
// streams on a phone once already.
document.addEventListener('hub:stream', load);
setInterval(load, RELOAD_MS);
keepAwake();
load();
