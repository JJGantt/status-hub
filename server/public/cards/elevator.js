// Elevator pane — the phone's elevator unlock while it is being tested (docs/DOOR.md § Elevator unlock).
// Live state comes from the iOS app itself (Sources/ElevatorUnlock.swift dispatches `hub:elevator` on
// every sensor reading while the app is in front; posting to the `elevator` message handler asks for it
// now). The stored rides, the Wi-Fi joins heard by the Mac, the devices those joins are matched against
// (app_settings.presence_devices) and the unlock-mode switches come from the hub.
// In a browser there is no live state; the rest still renders. Bare labels only.
import { esc } from '../shared.js';

let mounted = false;
let live = null;

const n1 = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—');
const clock = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }); };
const row = (k, v) => `<div class="el-row"><span class="el-k">${esc(k)}</span><span class="el-v">${v}</span></div>`;

function phase(st) {
  if (!st) return '—';
  switch (st.phase) {
    case 'riding': return `riding · +${n1(st.rise, 2)} m · ${st.steps_in_ride} steps · ${n1(st.since, 0)} s`;
    case 'stopped': return `stopped · +${n1(st.rise, 2)} m · steps ${st.steps_after}/${st.steps_needed} · ${n1(st.left_s, 0)} s left`;
    case 'falling': return `falling · −${n1(st.drop, 2)} m`;
    default: return 'idle';
  }
}

function fields(e) {
  if (e.what === 'step') return `${e.n}/${e.of}`;
  return Object.entries(e).filter(([k]) => k !== 'what' && k !== 'at')
    .map(([k, v]) => `${k} ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`).join(' · ');
}

function liveHtml() {
  if (!live) return `<h3>Live</h3>${row('Live', 'app only')}`;
  const f = live.fix;
  const th = live.thresholds;
  return '<h3>Live</h3>' +
    row('Watching', live.watching ? `on · ${clock(live.since)}` : 'off') +
    row('Area', `${esc(live.region)}${live.radius ? ` · ${Math.round(live.radius)} m` : ''}`) +
    row('Location', f ? `${n1(f.lat, 5)}, ${n1(f.lon, 5)} ±${Math.round(f.acc)} m · ${clock(f.at)}` : '—') +
    row('Home', f && typeof f.home_m === 'number' ? `${Math.round(f.home_m)} m` : '—') +
    row('Altitude', typeof live.alt === 'number' ? `${n1(live.alt, 2)} m` : '—') +
    row('Steps', String(live.steps ?? '—')) +
    row('Phase', esc(phase(live.detector))) +
    (th ? row('Thresholds', esc(`rise ${th.minRise} m / ${th.rideWindow} s · ≤${th.maxRideSteps} steps · still <${th.stillRise} m / ${th.stillFor} s · ${th.exitSteps} steps / ${th.exitWithin} s`)) : '') +
    '<h3>Log</h3>' +
    ((live.events || []).slice().reverse().map((e) =>
      `<div class="el-ev"><span class="el-t">${clock(e.at)}</span><span class="el-w">${esc(e.what)}</span><span class="el-f">${esc(fields(e))}</span></div>`).join('') || row('—', ''));
}

function ridesHtml(rides) {
  return '<h3>Rides</h3>' + (rides.length ? rides.map((r) =>
    `<div class="el-ev"><span class="el-t">${day(r.at)} ${clock(r.started_at || r.at)}</span><span class="el-w">${esc(r.outcome)}</span>` +
    `<span class="el-f">${esc([r.rise_m != null ? `${n1(r.rise_m, 2)} m` : '', r.steps_after != null ? `${r.steps_after} steps` : '',
      r.unlock_ms != null ? `${r.unlock_ms} ms` : '', r.error || ''].filter(Boolean).join(' · '))}</span></div>`).join('') : row('—', ''));
}

function joinsHtml(joins) {
  return '<h3>Wi-Fi joins</h3>' + (joins.length ? joins.map((j) =>
    `<div class="el-ev"><span class="el-t">${day(j.at)} ${clock(j.at)}</span><span class="el-w">${esc(j.hostname || j.mac || '')}</span>` +
    `<span class="el-f">${esc([j.hostname ? j.mac : '', j.message].filter(Boolean).join(' · '))}</span></div>`).join('') : row('—', ''));
}

function bleHtml(evs) {
  return '<h3>Bluetooth</h3>' + (evs.length ? evs.map((e) =>
    `<div class="el-ev"><span class="el-t">${day(e.at)} ${clock(e.at)}</span><span class="el-w">${esc(`${e.device} ${e.event}`)}</span>` +
    `<span class="el-f">${esc([e.rssi != null ? `${e.rssi} dBm` : '', e.away_s != null ? `away ${e.away_s}s` : '', e.machine].filter(Boolean).join(' · '))}</span></div>`).join('') : row('—', ''));
}

function modesHtml(m) {
  const t = (key, label) => `<button type="button" class="el-mode${m && m[key] ? ' on' : ''}" data-mode="${key}"${m ? '' : ' disabled'}>${label}</button>`;
  return `<h3>Unlock by</h3><div class="el-modes">${t('elevator', 'Elevator')}${t('wifi', 'Wi-Fi')}${t('bluetooth', 'Bluetooth')}${t('relock', 'Relock')}</div>`;
}

function devicesHtml(d) {
  const list = Object.entries(d || {});
  return '<h3>Devices</h3>' + (list.length ? list.map(([mac, who]) => row(who, esc(mac))).join('') : row('—', ''));
}

let modes = null, rides = [], joins = [], devices = {}, bleEvents = [];

function paint() {
  const el = document.getElementById('elevatorpane');
  if (!el) return;
  el.querySelector('.el-modes-wrap').innerHTML = modesHtml(modes);
  el.querySelector('.el-live').innerHTML = liveHtml();
  el.querySelector('.el-rides').innerHTML = ridesHtml(rides);
  el.querySelector('.el-joins').innerHTML = joinsHtml(joins);
  el.querySelector('.el-ble').innerHTML = bleHtml(bleEvents);
  el.querySelector('.el-devices').innerHTML = devicesHtml(devices);
}

async function getJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (_) { return null; }
}

async function load() {
  const [m, r, j, st, b] = await Promise.all([getJson('/api/door/modes'), getJson('/api/elevator/rides?limit=10'),
    getJson('/api/presence/joins'), getJson('/api/settings'), getJson('/api/presence/events')]);
  bleEvents = Array.isArray(b) ? b : [];
  // presence_devices ({"<mac>": "phone" | "watch"}): which Wi-Fi joins are his.
  try { devices = st && st.presence_devices ? (typeof st.presence_devices === 'string' ? JSON.parse(st.presence_devices) : st.presence_devices) : {}; } catch (_) { devices = {}; }
  modes = m && typeof m === 'object' && 'elevator' in m ? m : null;
  rides = (r && r.rides) || [];
  joins = (j && (j.joins || (Array.isArray(j) ? j : []))) || [];
  paint();
}

async function toggle(key) {
  if (!modes) return;
  const want = !modes[key];
  modes = { ...modes, [key]: want };
  paint();
  try {
    const r = await fetch('/api/door/modes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: want }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    modes = await r.json();
  } catch (e) { console.error('[elevator] mode', e); modes = { ...modes, [key]: !want }; }
  paint();
  askNative();
}

function askNative() {
  try { window.webkit?.messageHandlers?.elevator?.postMessage(1); } catch (_) {}
}

const RIDE_END = new Set(['unlocked', 'unlock_failed', 'no exit', 'down', 'unlock skipped: elevator off']);
let lastEvent = '';

export function render() {
  if (mounted) return;
  const el = document.getElementById('elevatorpane');
  if (!el) return;
  mounted = true;
  el.innerHTML = '<div class="el-modes-wrap"></div><div class="el-live"></div><div class="el-rides"></div><div class="el-joins"></div><div class="el-ble"></div><div class="el-devices"></div>';
  el.addEventListener('click', (e) => { const b = e.target.closest('.el-mode'); if (b) toggle(b.dataset.mode); });
  window.addEventListener('hub:elevator', (e) => {
    live = e.detail || null;
    const last = live && live.events && live.events[live.events.length - 1];
    const key = last ? last.at + last.what : '';
    // A ride is stored a minute after it ends; read the list again once it has landed.
    if (key && key !== lastEvent && RIDE_END.has(last.what)) setTimeout(load, 65e3);
    lastEvent = key;
    el.querySelector('.el-live').innerHTML = liveHtml();
    el.querySelector('.el-modes-wrap').innerHTML = modesHtml(modes);
  });
  window.addEventListener('focus', () => { load(); askNative(); });
  paint();
  load();
  askNative();
}
