// The live microphone's phone half: the Stream button at the top of Utilities. The capture itself is
// native (`LiveMic` in apps/Sources/LiveMic.swift), because a web page's microphone stops the moment
// the phone locks; this card only asks the app to start or stop and paints what the app reports.
// docs/LIVE-MIC.md is the whole path.
//
// The app reports on `hub:livemic` ({ state: 'off'|'connecting'|'live'|'denied', listeners }). In a
// plain browser there is no app to ask, so the card takes itself off the page.

const LABEL = { off: 'Off', connecting: 'Connecting', live: 'Live', denied: 'Mic denied' };
const COLOR = { off: '#8b96a5', connecting: '#eab308', live: '#22c55e', denied: '#ef4444' };

let now = { state: 'off', listeners: 0 };

function native() {
  return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.liveMic;
}

function paint() {
  const el = document.getElementById('livemic');
  if (!el) return;
  const on = now.state === 'connecting' || now.state === 'live';
  const chip = (label, val, col) => '<span class=devchip><span class=dc-l>' + label + '</span>' +
    '<span class=dc-v style="color:' + (col || '#e6eaf0') + '">' + val + '</span></span>';
  el.innerHTML =
    '<h2>Live Mic</h2>' +
    '<div class=devstrip><div class=devchips>' +
      chip('Mic', '<span class=dot style="background:' + COLOR[now.state] + '"></span>' + LABEL[now.state]) +
      (on ? chip('Listening', String(now.listeners)) : '') +
    '</div></div>' +
    '<button type=button class="feed-btn lm-btn' + (on ? ' lm-on' : '') + '">' + (on ? 'Stop' : 'Stream') + '</button>';
}

function mount() {
  const el = document.getElementById('livemic');
  if (!el) return;
  const h = native();
  if (!h) { (el.closest('.card') || el).remove(); return; }
  el.addEventListener('click', (ev) => {
    if (!ev.target.closest('.lm-btn')) return;
    const on = now.state === 'connecting' || now.state === 'live';
    h.postMessage({ on: !on });
  });
  window.addEventListener('hub:livemic', (ev) => { now = ev.detail || now; paint(); });
  paint();
  h.postMessage({ sync: true });   // a reload mid-stream: the app says where it is
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
