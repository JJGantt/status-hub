// HUB LIVE — the browser half of the live Chrome tab (status-hub docs/SESSION-TABS.md § Live Chrome).
//
// One socket, outbound, to the hub (server/routes/tabs.js → lib/liverelay.js); nothing listens on this
// machine. The hub tells it which of this browser's tabs belong to a session (`tabs`), and which of
// those someone is looking at right now (`watch` / `unwatch`). For a watched tab it attaches with
// chrome.debugger and screencasts it; his taps and typing come back as `input` and are dispatched into
// that tab through the same debugger session. It never moves the real mouse and never brings a tab to
// the front.
//
// A BACKGROUND TAB PAINTS NOTHING, so a screencast of one sends no frames at all — measured, Chrome
// 158. Emulation.setFocusEmulationEnabled makes the page believe it is visible and focused, and it then
// streams at full rate, behind other tabs and in a minimized window alike, while the tab really in front
// keeps its own focus. It is turned off again on unwatch, so the session's tab is only "visible" while
// someone is watching it.
//
// While attached, Chrome shows "Hub Live started debugging this browser" across the top of every
// window. Attaching only while watched is what keeps that bar away the rest of the time. Pressing its
// Cancel detaches, and the viewer is told.
import config from './config.js';

const MAX_FPS = 10;                 // a phone does not need more, and every frame is bytes through Fly
const MAX_WIDTH = 1280;             // past a phone's 3x width; the frame is scaled down to this
const QUALITY = 60;
const BACKED_UP = 1024 * 1024;      // skip a frame rather than queue it behind a slow uplink

let ws = null;
let backoff = 0;
let refused = false;                // the hub turned the hello away: wrong token, so retrying cannot help
const sentMeta = new Map();         // tab id -> 'title url' last sent, so a page retitling itself is one message
let claimed = new Set();            // tab ids (strings) a session owns, per the hub
const watching = new Map();         // tab id -> { w, h, lastAck }

const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const report = (message, target) => {
  console.error('[hub-live]', message);
  send({ op: 'error', message: String(message).slice(0, 500), ...(target != null ? { target: String(target) } : {}) });
};

function connect() {
  if (refused) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const s = new WebSocket(`${config.hub.replace(/^http/, 'ws')}/api/live/agent`);
  s.binaryType = 'arraybuffer';
  ws = s;
  s.onopen = () => s.send(JSON.stringify({ op: 'hello', machine: config.machine, token: config.token }));
  // The backoff resets only once the hub has accepted the hello (its first message is `tabs`), so a
  // connection that opens and is refused keeps backing off instead of retrying every second.
  s.onmessage = (e) => { backoff = 0; let m; try { m = JSON.parse(e.data); } catch (_) { return; } handle(m).catch((err) => report(err.message || err, m.target)); };
  s.onclose = (e) => {
    if (ws !== s) return;
    ws = null;
    for (const t of [...watching.keys()]) unwatch(t);
    sentMeta.clear();
    // 4001: the hello was refused. Every retry would be refused too, and each one is an incident on the hub;
    // the token is fixed by rewriting config.js (bin/chrome-live-config), which needs a reload anyway.
    if (e.code === 4001) { refused = true; console.error('[hub-live] the hub refused this extension\'s token; run bin/chrome-live-config and reload it'); return; }
    setTimeout(connect, Math.min(1000 * 2 ** backoff++, 60000));
  };
  s.onerror = () => {};
}

async function handle(m) {
  if (m.op === 'tabs') {
    claimed = new Set(m.targets || []);
    for (const t of [...watching.keys()]) if (!claimed.has(t)) unwatch(t);
    for (const t of claimed) {
      // A tab closed while this was not connected (or a browser restart, which renumbers every tab).
      try { const tab = await chrome.tabs.get(Number(t)); meta(t, tab); }
      catch (_) { send({ op: 'gone', target: t }); }
    }
  } else if (m.op === 'watch') await watch(String(m.target));
  else if (m.op === 'unwatch') await unwatch(String(m.target));
  else if (m.op === 'input') await input(String(m.target), m.ev || {});
}

const cmd = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function watch(target) {
  if (watching.has(target)) return;
  const tabId = Number(target);
  const st = { w: 0, h: 0, lastAck: 0 };
  watching.set(target, st);
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Still attached from before this worker restarted: carry on with that attachment.
    if (!/already attached/i.test(e.message)) { watching.delete(target); return report(`attach to tab ${target}: ${e.message}`, target); }
  }
  try {
    await cmd(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await cmd(tabId, 'Page.enable');
    const { cssVisualViewport: vv } = await cmd(tabId, 'Page.getLayoutMetrics');
    st.w = vv.clientWidth; st.h = vv.clientHeight;
    // A screencast sends only when the page paints, so a still page would show nothing: one screenshot first.
    const scale = Math.min(1, MAX_WIDTH / vv.clientWidth);
    const shot = await cmd(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: QUALITY,
      clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale } });
    sendFrame(target, st, shot.data);
    await cmd(tabId, 'Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAX_WIDTH, maxHeight: 4000 });
  } catch (e) {
    report(`start streaming tab ${target}: ${e.message}`, target);
  }
}

async function unwatch(target) {
  if (!watching.delete(target)) return;
  const tabId = Number(target);
  try { await cmd(tabId, 'Page.stopScreencast'); } catch (_) {}
  try { await cmd(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }); } catch (_) {}
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

function sendFrame(target, st, b64) {
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > BACKED_UP) return;
  const head = new TextEncoder().encode(JSON.stringify({ target, w: st.w, h: st.h }));
  const bin = atob(b64);
  const out = new Uint8Array(4 + head.length + bin.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  for (let i = 0; i < bin.length; i++) out[4 + head.length + i] = bin.charCodeAt(i);
  ws.send(out.buffer);
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method !== 'Page.screencastFrame') return;
  const target = String(src.tabId);
  const st = watching.get(target);
  if (!st) return;
  st.w = params.metadata.deviceWidth; st.h = params.metadata.deviceHeight;
  sendFrame(target, st, params.data);
  // Chrome sends the next frame only once this one is acknowledged: holding the ack is the frame-rate cap.
  const wait = Math.max(0, st.lastAck + 1000 / MAX_FPS - Date.now());
  setTimeout(() => {
    st.lastAck = Date.now();
    chrome.debugger.sendCommand(src, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  }, wait);
});

chrome.debugger.onDetach.addListener((src, reason) => {
  const target = String(src.tabId);
  if (!watching.delete(target)) return;
  // `canceled_by_user` is the Cancel on Chrome's debugging bar; `target_closed` the tab going away.
  if (reason !== 'target_closed') report(`detached from tab ${target}: ${reason}`, target);
});

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};

async function input(target, ev) {
  const st = watching.get(target);
  const tabId = Number(target);
  if (ev.t === 'back') return chrome.tabs.goBack(tabId);
  if (ev.t === 'reload') return chrome.tabs.reload(tabId);
  if (!st) return;
  const x = Number(ev.x) * st.w, y = Number(ev.y) * st.h;
  if (ev.t === 'tap') {
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } else if (ev.t === 'press') {
    // Held until `release`: a press-and-hold bot check needs the button down for seconds.
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  } else if (ev.t === 'release') {
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } else if (ev.t === 'wheel') {
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(ev.dy) || 0 });
  } else if (ev.t === 'text' && ev.text) {
    await cmd(tabId, 'Input.insertText', { text: String(ev.text).slice(0, 2000) });
  } else if (ev.t === 'key' && KEYS[ev.key]) {
    const k = KEYS[ev.key];
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text } : {}) });
    await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const t = String(tabId);
  if (claimed.has(t)) send({ op: 'gone', target: t });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const t = String(tabId);
  if (claimed.has(t) && (change.title || change.url)) meta(t, tab);
});
chrome.tabs.onRemoved.addListener((tabId) => sentMeta.delete(String(tabId)));

function meta(t, tab) {
  const k = `${tab.title} ${tab.url}`;
  if (sentMeta.get(t) === k) return;
  sentMeta.set(t, k);
  send({ op: 'meta', target: t, title: tab.title, url: tab.url });
}

// The socket is what keeps this worker alive (the hub messages it every 20s). The alarm is the net under
// that: a worker Chrome stopped anyway is started again by it, and reconnects.
chrome.alarms.create('hub-live', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
