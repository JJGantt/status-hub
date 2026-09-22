'use strict';
// THE LIVE WIND — what the wind is doing at the break right now, measured rather than forecast.
//
// Every other wind number in the system is Surfline's model output, and the forecast a morning alarm
// decides on was run at 8pm the night before (docs/ALARMS.md). The Mayport Bar Pilots dock, 2.2 miles
// from the Poles, measures the wind every six minutes — each reading a two-minute average speed and
// direction, and the peak gust of a few seconds inside it.
//
// READ FROM NOAA's TIDES-AND-CURRENTS API (CO-OPS station 8720218), NOT NDBC. It is one station under
// two ids — NDBC calls it MYPF1, which is the id the rows are kept under — but NDBC rewrites its file
// about once an hour, near :30, with the newest reading already half an hour old, so a reading there
// is 30 to 90 minutes stale. CO-OPS serves each reading about six minutes after it is taken.
//
// A TIMER, and the only way: the API answers requests and pushes nothing, so nothing can tell the hub
// that a reading arrived. FIVE minutes, against a station that reports every six: shorter than its
// cadence, so the hub is never more than one reading behind it. A failed fetch waits for the next
// tick; nothing retries.

const STATION = 'MYPF1';
// SIX hours, not two: the window is what the API has to find something in, and the station goes quiet
// for hours at a time (17:36Z to at least 19:54Z on 2026-09-22, both NOAA sources agreeing). Asked for
// two, a gap answers "No data was found" and the hub holds a reading it cannot date against anything.
const FEED = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8720218&product=wind' +
             '&range=6&units=english&time_zone=gmt&format=json&application=status-hub';
const TICK_MS = 5 * 60 * 1000;
const KEEP_MS = 3 * 3600 * 1000;       // readings held in memory, for the averages and the endpoint

// THE SHORE, in the terms Surfline labels this spot's wind with: FROM within 67.5 degrees of 97.5
// is onshore, the opposite sector offshore, the two between cross-shore. Read off Surfline's own
// labels for Mayport Poles (onshore 30-165, offshore 210-345, cross the rest), so an observed wind is
// classed exactly as the forecast beside it is.
const ONSHORE_FROM = 97.5;
const HALF = 67.5;
const apart = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
function windType(dir) {
  if (dir == null) return null;
  if (apart(dir, ONSHORE_FROM) < HALF) return 'Onshore';
  if (apart(dir, ONSHORE_FROM + 180) < HALF) return 'Offshore';
  return 'Cross-shore';
}
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (dir) => (dir == null ? null : POINTS[Math.round(dir / 22.5) % 16]);
const r1 = (v) => Math.round(v * 10) / 10;

// CO-OPS wind JSON: `data` is oldest-first, each { t: 'YYYY-MM-DD HH:MM' in GMT, s: speed, d: degrees
// true the wind blows FROM, g: gust }. `units=english` is KNOTS for wind, which is what surf_hours
// keeps. Every field is range-checked; a missing one is an empty string.
function parse(json) {
  const out = [];
  for (const r of (json && json.data) || []) {
    const ts = new Date(String(r.t).replace(' ', 'T') + ':00Z');
    const n = (v, lo, hi) => { const x = Number(v); return v !== '' && Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
    const kts = n(r.s, 0, 120);
    if (Number.isNaN(ts.getTime()) || kts == null) continue;
    // No direction beside a zero speed is calm air, not a dropout: the vane has no flow to point into.
    out.push({ ts: ts.toISOString(), kts: r1(kts), gust: n(r.g, 0, 160) == null ? null : r1(Number(r.g)),
               dir: kts > 0 ? n(r.d, 0, 360) : null });
  }
  return out;
}

// Mean speed and CIRCULAR mean direction over readings — the arithmetic mean of 350 and 10 is 180.
function average(rs) {
  const w = rs.filter((r) => r.kts != null);
  if (!w.length) return null;
  const kts = w.reduce((a, r) => a + r.kts, 0) / w.length;
  const d = w.filter((r) => r.dir != null);
  let dir = null;
  if (d.length) {
    const x = d.reduce((a, r) => a + Math.cos(r.dir * Math.PI / 180), 0);
    const y = d.reduce((a, r) => a + Math.sin(r.dir * Math.PI / 180), 0);
    dir = Math.round(((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360);
  }
  return { kts: r1(kts), dir, type: windType(dir), compass: compass(dir), n: w.length };
}

/**
 * `store(rows)` persists new readings (water_readings); `onReading()` is told whenever one arrives.
 */
function createLiveWind({ store, onReading = () => {}, log = () => {} }) {
  let readings = [];          // newest first, the last KEEP_MS
  let lastTs = null;
  let failing = false;

  async function tick() {
    let json;
    try {
      const r = await fetch(FEED);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      json = await r.json();
      if (json.error) throw new Error(json.error.message || 'api error');
    } catch (e) {
      if (!failing) log(`[live-wind] fetch failed: ${e.message}`);
      failing = true;
      return;
    }
    if (failing) log('[live-wind] fetching again');
    failing = false;
    const fresh = parse(json).filter((r) => !lastTs || r.ts > lastTs);
    if (!fresh.length) return;
    lastTs = fresh.reduce((a, r) => (r.ts > a ? r.ts : a), lastTs || '');
    const cut = new Date(Date.now() - KEEP_MS).toISOString();
    readings = [...fresh, ...readings].sort((a, b) => (a.ts < b.ts ? 1 : -1)).filter((r) => r.ts >= cut);
    // Wind only: the water temperature on these rows is the Pi's hourly NDBC collector's, and a
    // merge upsert leaves a column it is not given alone.
    try { await store(fresh.map((r) => ({ station: STATION, ts: r.ts, wind_kts: r.kts, wind_dir_deg: r.dir, gust_kts: r.gust }))); }
    catch (e) { log(`[live-wind] store failed: ${e.message}`); }
    onReading();
  }

  /** The newest reading and the last half-hour's average, or null when nothing recent is held. */
  function current() {
    const newest = readings[0];
    if (!newest) return null;
    const age = Math.round((Date.now() - Date.parse(newest.ts)) / 60000);
    const since = new Date(Date.parse(newest.ts) - 30 * 60000).toISOString();
    return {
      station: STATION,
      at: newest.ts, age_min: age,
      kts: newest.kts, gust: newest.gust, dir: newest.dir,
      type: windType(newest.dir), compass: compass(newest.dir),
      // What a decision should act on: one six-minute reading is a gust as often as a trend.
      avg30: average(readings.filter((r) => r.ts >= since)),
    };
  }

  /**
   * The status frame's `wind`: the measurement, and beside it what the forecast said for this hour,
   * so a surface can show the two against each other without deriving anything.
   */
  function view(snapshotRow) {
    const c = current();
    if (!c) return null;
    let forecast = null;
    const rows = snapshotRow && Array.isArray(snapshotRow.rows) ? snapshotRow.rows : null;
    if (rows && rows.length) {
      const now = Date.now() / 1000;
      const f = rows.reduce((a, b) => (Math.abs(b.ts - now) < Math.abs(a.ts - now) ? b : a), rows[0]);
      if (f && f.wSpd != null) {
        forecast = { kts: r1(f.wSpd), dir: f.wDir == null ? null : Math.round(f.wDir),
                     type: f.wType || windType(f.wDir), compass: compass(f.wDir), rating: f.rk || null };
      }
    }
    return { ...c, forecast, delta_kts: forecast && c.avg30 ? r1(c.avg30.kts - forecast.kts) : null };
  }

  function start() {
    tick();
    setInterval(tick, TICK_MS);
  }

  return { start, tick, current, view, readings: () => readings.slice() };
}

module.exports = { createLiveWind, windType, parse, average };
