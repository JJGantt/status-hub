'use strict';
// The Apple Watch's battery, for the hairline along the bottom of the walls (cards/watchbattery.js).
//
// The watch has no way to be asked, and watchOS gives an app no battery-change event, so the reading
// RIDES THE WATCH'S LOG BATCHES (`battery` beside `lines` on /api/clientlog, apps/Watch/Hub.swift): the
// app sends one whenever it does anything, and that is the only time it is awake to read the level.
// So the figure is as fresh as the last time the app ran, which `at` says.
//
// Stored as device_status row `watch` (data: {level, charging}), which is already in the realtime
// publication, so a new reading reaches every wall as a frame. CHANGE-GATED: a batch arrives every few
// seconds while the app is open, and only a different whole percent or a charging flip is written.

const DEVICE = 'watch';

function createWatchBattery({ sbUpsert }) {
  let last = null;   // what was last written, `${pct}:${charging}`; null after a restart writes once

  async function ingest(b) {
    if (!b || typeof b !== 'object') return;
    const level = Number(b.level);
    if (!(level >= 0 && level <= 1)) return;   // -1 is watchOS saying monitoring is off
    const pct = Math.round(level * 100);
    const charging = !!b.charging;
    const key = `${pct}:${charging}`;
    if (key === last) return;
    last = key;
    try {
      await sbUpsert('device_status', 'device', { device: DEVICE, name: 'Apple Watch',
        data: { level: pct / 100, charging }, updated_at: new Date().toISOString() });
    } catch (e) { last = null; console.error('[watch-battery] not stored:', e.message || e); }
  }

  return { ingest };
}

// The bar's fill and colour: red at empty through amber to green at full, by hue.
function buildWatchBattery(row) {
  const d = row && row.data;
  if (!d || !(Number(d.level) >= 0)) return null;
  const pct = Math.max(0, Math.min(100, Math.round(Number(d.level) * 100)));
  return { pct, charging: !!d.charging, color: batteryColor(pct), at: row.updated_at || null };
}

function batteryColor(pct) {
  return `hsl(${Math.round(pct * 1.2)}, 80%, 45%)`;
}

module.exports = { createWatchBattery, buildWatchBattery, batteryColor, WATCH_DEVICE: DEVICE };
