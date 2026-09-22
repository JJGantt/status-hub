'use strict';
// THE LIVE WIND — what the wind is doing at the break right now, measured rather than forecast.
//
// Every other wind number in the system is Surfline's model output, and the forecast a morning alarm
// decides on was run at 8pm the night before (docs/ALARMS.md). MYPF1, the Mayport Bar Pilots dock
// 2.2 miles from the Poles, measures the wind every six minutes. This reads the HEAD of that
// station's realtime file — about the newest hour — and hands on each reading it has not seen.
//
// A TIMER, and the only way: NDBC publishes files, not events, so nothing can tell the hub that a
// reading arrived. Ten minutes, against a station that reports every six and reaches the site about
// 35 minutes late, so a tick is rarely more than one reading behind. A failed fetch waits for the
// next tick; nothing retries.

const STATION = 'MYPF1';
const FEED = `https://www.ndbc.noaa.gov/data/realtime2/${STATION}.txt`;
// NDBC answers 403 to a request without a browser user agent (surf-report/ndbc.mjs).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// The file is ~1MB newest-first; its first 2KB is the newest dozen readings.
const HEAD_BYTES = 2048;
const TICK_MS = 10 * 60 * 1000;
const KEEP_MS = 3 * 3600 * 1000;       // readings held in memory, for the averages and the endpoint
const MS_TO_KTS = 1.943844;

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

// NDBC standard meteorological format, columns looked up by NAME from the header (see
// surf-report/ndbc.mjs, which this mirrors). Missing is `MM`; every field is range-checked against
// what the instrument can report. The last line of a byte range is usually cut short and is dropped.
function parse(text) {
  const lines = text.split('\n');
  const head = (lines.find((l) => l.startsWith('#YY')) || '').replace(/^#/, '').trim().split(/\s+/);
  const col = (n) => head.indexOf(n);
  const num = (f, n, lo, hi) => {
    const i = col(n);
    if (i < 0 || i >= f.length || f[i] === 'MM') return null;
    const v = Number(f[i]);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
  };
  const out = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < head.length) continue;
    const ts = new Date(Date.UTC(+f[0], +f[1] - 1, +f[2], +f[3], +f[4]));
    if (Number.isNaN(ts.getTime())) continue;
    const spd = num(f, 'WSPD', 0, 60), gst = num(f, 'GST', 0, 80);
    const wtmp = num(f, 'WTMP', -2, 40);
    // No direction beside a real speed is calm air, not a dropout: the vane has no flow to point into.
    const dir = spd != null && spd > 0 ? num(f, 'WDIR', 0, 360) : null;
    if (spd == null && wtmp == null) continue;
    out.push({ ts: ts.toISOString(), kts: spd == null ? null : r1(spd * MS_TO_KTS),
               gust: gst == null ? null : r1(gst * MS_TO_KTS), dir,
               water_f: wtmp == null ? null : r1(wtmp * 9 / 5 + 32) });
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
    let text;
    try {
      const r = await fetch(FEED, { headers: { 'User-Agent': UA, Range: `bytes=0-${HEAD_BYTES - 1}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = await r.text();
    } catch (e) {
      if (!failing) log(`[live-wind] fetch failed: ${e.message}`);
      failing = true;
      return;
    }
    if (failing) log('[live-wind] fetching again');
    failing = false;
    const fresh = parse(text).filter((r) => !lastTs || r.ts > lastTs);
    if (!fresh.length) return;
    lastTs = fresh.reduce((a, r) => (r.ts > a ? r.ts : a), lastTs || '');
    const cut = new Date(Date.now() - KEEP_MS).toISOString();
    readings = [...fresh, ...readings].sort((a, b) => (a.ts < b.ts ? 1 : -1)).filter((r) => r.ts >= cut);
    try { await store(fresh.map((r) => ({ station: STATION, ts: r.ts, wind_kts: r.kts, wind_dir_deg: r.dir, gust_kts: r.gust, water_f: r.water_f }))); }
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
