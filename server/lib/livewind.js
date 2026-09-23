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
// THE FALLBACK, for when the dock goes quiet — it did for 27 hours on 17 July and five on 22
// September, and 2% of the last 96 days sits inside a gap. KNRB is the naval air station at the
// jetties, a mile from the break, reporting hourly through the National Weather Service. Hourly is
// poor next to six minutes, which is why it is only ever consulted once the dock's newest reading is
// older than that anyway.
// From AVIATION WEATHER, not api.weather.gov: the same METARs, but the weather service's own feed runs
// an hour behind — measured at 22:56Z with 21:52Z as its newest while this one already had 22:52Z.
// The hourly report is issued at :52 and lands here a few minutes later, so the fallback is at worst an
// hour old just before the next one, and it speaks knots already.
const FALLBACK_STATION = 'KNRB';
const FALLBACK = 'https://aviationweather.gov/api/data/metar?ids=KNRB&format=json&hours=3';
const FALLBACK_AFTER_MIN = 40;
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

// Aviation Weather's METAR list: `obsTime` in epoch seconds, `wspd`/`wgst` in knots, `wdir` in degrees
// true — or the string `VRB` when the wind is too light to have a direction, which is a null here.
function parseFallback(json) {
  const out = [];
  for (const m of Array.isArray(json) ? json : []) {
    if (!m || !m.obsTime || m.wspd == null) continue;
    const dir = typeof m.wdir === 'number' ? m.wdir : null;
    out.push({ ts: new Date(m.obsTime * 1000).toISOString(), kts: r1(m.wspd),
               gust: m.wgst == null ? null : r1(m.wgst),
               dir: m.wspd > 0 ? dir : null });
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/**
 * `store(rows)` persists new readings (water_readings); `onReading()` is told whenever one arrives.
 */
function createLiveWind({ store, onReading = () => {}, log = () => {} }) {
  let readings = [];          // newest first, the last KEEP_MS
  let fallback = [];          // the same, from KNRB, only while the dock is quiet
  let lastTs = null;
  let lastFallbackTs = null;
  let failing = false;

  async function tick() {
    let json = null;
    try {
      const r = await fetch(FEED);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      json = await r.json();
      if (json.error) throw new Error(json.error.message || 'api error');
      if (failing) log('[live-wind] fetching again');
      failing = false;
    } catch (e) {
      // NO EARLY RETURN HERE. The dock going quiet reads as an API ERROR ("No data was found. This
      // product may not be offered at this station at the requested time.") at least as often as it
      // reads as stale readings, so returning on a failed fetch skips the fallback in precisely the
      // case the fallback exists for — and the wind then sits hours old with a current KNRB report
      // available the whole time.
      if (!failing) log(`[live-wind] fetch failed: ${e.message}`);
      failing = true;
    }
    const fresh = json ? parse(json).filter((r) => !lastTs || r.ts > lastTs) : [];
    if (fresh.length) {
      lastTs = fresh.reduce((a, r) => (r.ts > a ? r.ts : a), lastTs || '');
      const cut = new Date(Date.now() - KEEP_MS).toISOString();
      const all = [...fresh, ...readings].sort((a, b) => (a.ts < b.ts ? 1 : -1));
      // KEEP_MS bounds the averages, not the memory: a station that has been quiet for five hours
      // still has a last reading, and dropping it leaves the hub with no wind at all rather than an
      // old one with its age on it.
      readings = all.filter((r) => r.ts >= cut);
      if (!readings.length && all.length) readings = [all[0]];
    }
    // Always: it no-ops unless the dock's newest reading is already too old to be the answer.
    await tickFallback();
    if (!fresh.length) return;
    // Wind only: the water temperature on these rows is the Pi's hourly NDBC collector's, and a
    // merge upsert leaves a column it is not given alone.
    try { await store(fresh.map((r) => ({ station: STATION, ts: r.ts, wind_kts: r.kts, wind_dir_deg: r.dir, gust_kts: r.gust }))); }
    catch (e) { log(`[live-wind] store failed: ${e.message}`); }
    onReading();
  }

  /// Only when the dock has nothing recent: one hourly observation from the naval station, kept apart
  /// from the dock's own readings so the archive stays one instrument.
  async function tickFallback() {
    const dock = readings[0];
    if (dock && Date.now() - Date.parse(dock.ts) < FALLBACK_AFTER_MIN * 60000) return;
    let rows = [];
    try {
      const r = await fetch(FALLBACK, { headers: { 'User-Agent': 'gnarcast (status-hub)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      rows = parseFallback(await r.json());
    } catch (e) { return log(`[live-wind] fallback failed: ${e.message}`); }
    if (!rows.length) return;
    const added = rows.filter((r) => !lastFallbackTs || r.ts > lastFallbackTs);
    fallback = rows.slice(0, 12);
    if (!added.length) return;
    lastFallbackTs = rows[0].ts;
    try { await store(added.map((r) => ({ station: FALLBACK_STATION, ts: r.ts, wind_kts: r.kts, wind_dir_deg: r.dir, gust_kts: r.gust }))); }
    catch (e) { log(`[live-wind] fallback store failed: ${e.message}`); }
    log(`[live-wind] dock quiet — using ${FALLBACK_STATION}, newest ${rows[0].ts}`);
    onReading();
  }

  /** The newest reading and the last half-hour's average, or null when nothing recent is held. */
  function current() {
    // Whichever instrument has the newer reading: the dock at six minutes, or the naval station when
    // the dock has stopped. `station` says which, because a wind from a mile inland is not the same
    // measurement and a surface should be able to say so.
    const best = fallback[0] && (!readings[0] || fallback[0].ts > readings[0].ts) ? fallback : readings;
    const newest = best[0];
    if (!newest) return null;
    const age = Math.round((Date.now() - Date.parse(newest.ts)) / 60000);
    const since = new Date(Date.parse(newest.ts) - 30 * 60000).toISOString();
    return {
      station: best === fallback ? FALLBACK_STATION : STATION,
      at: newest.ts, age_min: age,
      kts: newest.kts, gust: newest.gust, dir: newest.dir,
      // Where it BLOWS, not where it comes from: the direction an arrow points. A compass point has to
      // be turned around in your head before it means anything.
      dir_to: newest.dir == null ? null : (newest.dir + 180) % 360,
      type: windType(newest.dir), compass: compass(newest.dir),
      // What a decision should act on: one six-minute reading is a gust as often as a trend.
      avg30: average(best.filter((r) => r.ts >= since)),
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

  /// Readings already stored, handed in at boot. A deploy empties this module's memory, and the
  /// station goes quiet for hours at a time — without this the hub would have no wind at all until it
  /// reports again, which is exactly when knowing the last reading and its age matters most.
  function seed(rows) {
    if (readings.length || !rows || !rows.length) return;
    readings = rows.map((r) => ({ ts: new Date(r.ts).toISOString(), kts: r.wind_kts, gust: r.gust_kts, dir: r.wind_dir_deg }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    lastTs = readings[0].ts;
  }

  function start() {
    tick();
    setInterval(tick, TICK_MS);
  }

  return { start, tick, current, view, seed, readings: () => readings.slice() };
}

module.exports = { createLiveWind, windType, parse, average };
