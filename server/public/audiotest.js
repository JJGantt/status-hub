// WHICH AUDIO PATH ACTUALLY MAKES NOISE — a bench, not a feature.
//
// An alarm fired with its AudioContext reporting `running`, its oscillators scheduled and its
// overlay flashing, and the phone stayed silent; opening the app normally a few minutes later, the
// same page was audible. The ringer was on throughout, so the mute switch does not explain it and
// Guided Access is the remaining suspect. Guessing which layer is at fault has been wrong twice, so
// this presses each one separately and reports what it saw.
//
// Every press also beacons, because the whole point is to run this inside Guided Access — where the
// phone cannot be used to tell anyone what happened.
const OUT = 'audiotest';

function say(line) {
  const el = document.getElementById('audiotest-out');
  if (el) el.textContent = line;
}
function beacon(fields) {
  try {
    navigator.sendBeacon('/api/clientlog',
      new Blob([JSON.stringify({ ev: OUT, ...fields })], { type: 'application/json' }));
  } catch (_) {}
}
// The bench plays audio too, so it owes the same notice as anything else here: `hub:audioplaying` as
// a sound starts and `hub:audioplayed` once it is over, which is when the mic may re-acquire.
function notice(ev) { try { document.dispatchEvent(new CustomEvent(ev)); } catch (_) {} }
function nativeAudio(on) {
  try { window.webkit.messageHandlers.alarmAudio.postMessage(on); return true; } catch (_) { return false; }
}

let actx = null;
function ctx() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; } }
  if (actx.state === 'suspended') actx.resume().catch(() => {});   // a refusal shows as state= in the result
  return actx;
}
function osc(label, extra) {
  const c = ctx();
  if (!c) return done(label, { error: 'no AudioContext' });
  notice('hub:audioplaying');
  setTimeout(() => notice('hub:audioplayed'), 1300);   // the last beep ends 1.2s in
  const t = c.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square';
    o.frequency.value = i === 2 ? 1175 : 880;
    g.gain.setValueAtTime(0.0001, t + i * 0.42);
    g.gain.exponentialRampToValueAtTime(1, t + i * 0.42 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.42 + 0.32);
    o.connect(g); g.connect(c.destination);
    o.start(t + i * 0.42); o.stop(t + i * 0.42 + 0.36);
  }
  done(label, { state: c.state, ...(extra || {}) });
}
function done(label, info) {
  const bits = Object.entries(info).map(([k, v]) => `${k}=${v}`).join(' ');
  say(`${label} · ${bits}`);
  beacon({ test: label, ...info });
}

const TESTS = [
  // The alarm's own path, untouched. If this is silent and the file below is not, the fault is Web
  // Audio specifically rather than the app's output.
  ['OSC', () => osc('OSC', { native: false })],
  // A plain media element — the path Guided Access allows, and now the alarm's primary. Plays the
  // real tone so what is heard here is what will be heard at 7am.
  ['FILE', () => {
    const a = new Audio('/alarm.m4a');   // the real alarm tone, not the UI blip
    ['pause', 'ended', 'error'].forEach((ev) => a.addEventListener(ev, () => notice('hub:audioplayed'), { once: true }));
    notice('hub:audioplaying');
    a.play().then(() => done('FILE', { played: true }))
      .catch((e) => done('FILE', { played: false, error: String(e.name || e) }));
  }],
  // With a .playback session claimed first. Needs the native half installed; `sent=false` means this
  // build of the app does not have the handler and the result says nothing.
  ['OSC+SESSION', () => { const sent = nativeAudio(true); setTimeout(() => osc('OSC+SESSION', { native: sent }), 120); }],
  // Not audio at all. Proves the press arrived and the page is live even when everything is silent.
  ['VIBRATE', () => { let ok = false; try { ok = !!(navigator.vibrate && navigator.vibrate([400, 200, 400])); } catch (_) {} done('VIBRATE', { vibrate: ok }); }],
  // Hands the session back, so the microphone works again after OSC+SESSION.
  ['RELEASE', () => { const native = nativeAudio(false); notice('hub:audioplayed'); done('RELEASE', { native }); }],
];

export function mount() {
  const host = document.getElementById('audiotest');
  if (!host || host.dataset.on) return;
  host.dataset.on = '1';
  const row = document.createElement('div');
  row.className = 'audiotest-row';
  for (const [label, fn] of TESTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { try { fn(); } catch (e) { done(label, { error: String(e.message || e) }); } });
    row.appendChild(b);
  }
  const out = document.createElement('div');
  out.id = 'audiotest-out';
  out.textContent = 'ready';
  host.appendChild(row);
  host.appendChild(out);
  beacon({ test: 'mounted', ua_webkit: !!(window.webkit && window.webkit.messageHandlers) });
}
mount();
