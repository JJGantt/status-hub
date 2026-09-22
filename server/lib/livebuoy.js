'use strict';
// THE LIVE SWELL — what the water is doing either side of Mayport, measured at two NDBC wave buoys:
// 41112 off Fernandina (~22 mi N) and 41117 off St. Augustine (~30 mi S). Each reports every 30
// minutes and reaches NDBC about 15 minutes later. Two files per station: `.txt` carries the whole
// sea (height, periods, mean direction) and the water temperature; `.spec` splits the same sea into
// SWELL and WIND WAVES, which is the difference between surf and chop. Only the HEAD of each file is
// read — the newest few hours — and each new reading is handed on and kept (wave_readings).
//
// A TIMER, and the only way: NDBC publishes files, not events. Ten minutes against a thirty-minute
// report. A failed fetch waits for the next tick; nothing retries.

const STATIONS = [
  { id: '41112', name: 'Fernandina', miles: 22, bearing: 'N' },
  { id: '41117', name: 'St. Augustine', miles: 30, bearing: 'S' },
];
// NDBC answers 403 to a request without a browser user agent (surf-report/ndbc.mjs).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEAD_BYTES = 1600;               // about a dozen readings: six hours at this cadence
const TICK_MS = 10 * 60 * 1000;
const M_TO_FT = 3.28084;
const r1 = (v) => Math.round(v * 10) / 10;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (dir) => (dir == null ? null : POINTS[Math.round(dir / 22.5) % 16]);

// NDBC's fixed-width text, columns looked up by NAME from the header (surf-report/ndbc.mjs does the
// same): `MM` is missing, and every number is range-checked against what the buoy can report. The
// last line of a byte range is usually cut short and is dropped by the field count.
function table(text) {
  const lines = text.split('\n');
  const head = (lines.find((l) => l.startsWith('#YY')) || '').replace(/^#/, '').trim().split(/\s+/);
  const rows = new Map();
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < head.length) continue;
    const ts = new Date(Date.UTC(+f[0], +f[1] - 1, +f[2], +f[3], +f[4]));
    if (Number.isNaN(ts.getTime())) continue;
    const at = {};
    head.forEach((h, i) => { at[h] = f[i]; });
    rows.set(ts.toISOString(), at);
  }
  return rows;
}
const num = (v, lo, hi) => {
  if (v == null || v === 'MM') return null;
  const x = Number(v);
  return Number.isFinite(x) && x >= lo && x <= hi ? x : null;
};
const point = (v) => (v && POINTS.includes(v) ? v : null);

// One reading per timestamp, the two files joined on it. A `.spec` row with no `.txt` twin (or the
// reverse) still stands: they are published separately and one can be a report ahead of the other.
function merge(txt, spec) {
  const out = [];
  for (const ts of new Set([...txt.keys(), ...spec.keys()])) {
    const t = txt.get(ts) || {}, s = spec.get(ts) || {};
    const wvhtM = num(t.WVHT ?? s.WVHT, 0, 30);
    const row = {
      ts,
      wvht_ft: wvhtM == null ? null : r1(wvhtM * M_TO_FT),
      dpd_s: num(t.DPD, 0, 40), apd_s: num(t.APD ?? s.APD, 0, 40),
      mwd_deg: num(t.MWD ?? s.MWD, 0, 360),
      swh_ft: num(s.SwH, 0, 30) == null ? null : r1(Number(s.SwH) * M_TO_FT),
      swp_s: num(s.SwP, 0, 40), swd: point(s.SwD),
      wwh_ft: num(s.WWH, 0, 30) == null ? null : r1(Number(s.WWH) * M_TO_FT),
      wwp_s: num(s.WWP, 0, 40), wwd: point(s.WWD),
      steepness: s.STEEPNESS && s.STEEPNESS !== 'MM' && s.STEEPNESS !== 'N/A' ? s.STEEPNESS : null,
      water_f: num(t.WTMP, -2, 40) == null ? null : r1(Number(t.WTMP) * 9 / 5 + 32),
    };
    if (row.wvht_ft != null || row.swh_ft != null || row.water_f != null) out.push(row);
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

async function head(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=0-${HEAD_BYTES - 1}` } });
  if (!r.ok) throw new Error(`${url.split('/').pop()} HTTP ${r.status}`);
  return r.text();
}

// The swell and wind-wave directions arrive as compass POINTS, not degrees, so the blend takes the
// heavier station's — averaging two labels means inventing a number they never gave.
function pickPoint(rs, field, w) {
  let best = null, bestW = -1;
  rs.forEach((r, i) => { if (r[field] && w[i] > bestW) { best = r[field]; bestW = w[i]; } });
  return best;
}

/**
 * `store(rows)` persists new readings (wave_readings); `onReading()` is told whenever one arrives.
 */
function createLiveBuoy({ store, onReading = () => {}, log = () => {} }) {
  const latest = new Map();            // station -> newest merged reading
  const lastTs = new Map();
  let failing = false;

  async function tick() {
    let fresh = [];
    try {
      for (const st of STATIONS) {
        const base = `https://www.ndbc.noaa.gov/data/realtime2/${st.id}`;
        const [txt, spec] = await Promise.all([head(`${base}.txt`), head(`${base}.spec`)]);
        const rows = merge(table(txt), table(spec));
        if (!rows.length) continue;
        // The newest row can be missing its `.spec` half for a few minutes; hold on to the fuller one.
        latest.set(st.id, rows[0]);
        const since = lastTs.get(st.id);
        const add = rows.filter((r) => !since || r.ts > since);
        if (add.length) { lastTs.set(st.id, rows[0].ts); fresh = fresh.concat(add.map((r) => ({ station: st.id, ...r }))); }
      }
    } catch (e) {
      if (!failing) log(`[live-buoy] fetch failed: ${e.message}`);
      failing = true;
      return;
    }
    if (failing) log('[live-buoy] fetching again');
    failing = false;
    if (!fresh.length) return;
    try { await store(fresh); } catch (e) { log(`[live-buoy] store failed: ${e.message}`); }
    onReading();
  }

  /** Each station's newest reading, for the status frame and the surf app. */
  function view() {
    const out = [];
    for (const st of STATIONS) {
      const r = latest.get(st.id);
      if (!r) continue;
      out.push({ station: st.id, name: st.name, miles: st.miles, bearing: st.bearing,
                 age_min: Math.round((Date.now() - Date.parse(r.ts)) / 60000),
                 mwd_compass: compass(r.mwd_deg), ...r });
    }
    return out;
  }

  // ONE SEA FOR MAYPORT, which sits between the two buoys. Measured over 45 days they barely differ —
  // 0.31 ft mean absolute difference in total height, 0.11 ft in swell, 0.6s in swell period — so the
  // blend is not resolving a disagreement, it is cancelling each buoy's noise and giving one number to
  // read. Weighted by INVERSE DISTANCE (22 mi N, 30 mi S → 0.58 / 0.42), and it falls back to whichever
  // station is reporting. Directions are averaged circularly; a compass point comes from the result.
  function blend() {
    const rs = view();
    if (!rs.length) return null;
    const w = rs.map((r) => 1 / r.miles);
    const total = w.reduce((a, b) => a + b, 0);
    const mix = (field) => {
      let sum = 0, weight = 0;
      rs.forEach((r, i) => { if (r[field] != null) { sum += r[field] * w[i]; weight += w[i]; } });
      return weight ? r1(sum / weight) : null;
    };
    const dir = (field) => {
      let x = 0, y = 0, weight = 0;
      rs.forEach((r, i) => {
        if (r[field] == null) return;
        x += Math.cos(r[field] * Math.PI / 180) * w[i]; y += Math.sin(r[field] * Math.PI / 180) * w[i]; weight += w[i];
      });
      return weight ? Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360) : null;
    };
    const mwd = dir('mwd_deg');
    return {
      from: rs.map((r) => r.station),
      weights: rs.map((r, i) => Math.round((w[i] / total) * 100) / 100),
      age_min: Math.min(...rs.map((r) => r.age_min)),
      wvht_ft: mix('wvht_ft'), dpd_s: mix('dpd_s'), apd_s: mix('apd_s'),
      mwd_deg: mwd, mwd_compass: compass(mwd),
      swh_ft: mix('swh_ft'), swp_s: mix('swp_s'), swd: pickPoint(rs, 'swd', w),
      wwh_ft: mix('wwh_ft'), wwp_s: mix('wwp_s'), wwd: pickPoint(rs, 'wwd', w),
      water_f: mix('water_f'),
    };
  }

  /// The newest reading per station, handed in at boot — see livewind's `seed`: a deploy must not
  /// leave the sea blank until the next half-hourly report.
  function seed(rows) {
    for (const r of rows || []) {
      const cur = latest.get(r.station);
      if (!cur || r.ts > cur.ts) latest.set(r.station, { ...r, ts: new Date(r.ts).toISOString() });
    }
    for (const [id, r] of latest) if (!lastTs.has(id)) lastTs.set(id, r.ts);
  }

  function start() {
    tick();
    setInterval(tick, TICK_MS);
  }

  return { start, tick, view, blend, seed };
}

module.exports = { createLiveBuoy, merge, table };
