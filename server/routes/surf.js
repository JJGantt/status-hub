'use strict';
const { createLiveBuoy } = require('../lib/livebuoy');
const { createLiveWind, windType } = require('../lib/livewind');
const { createSurfAlarms } = require('../lib/surfalarm');
const crypto = require('crypto');
const { getTZ, localDate, nowNaiveLocal } = require('../lib/dates');
const { getWeather } = require('../lib/weather');

module.exports = function (ctx) {
  const {
    PING, SUPABASE_KEY, SUPABASE_URL, SURF_HTML, alarmLog, buildSurf, etNowString, etStringAt, gated,
    pub, ratingLabel, sb, sbRange, sbWrite, settingsAll,
  } = ctx;

  // ---- surf history: rating, size and water for the card's grids ----
  // surf_hours grows by 24 rows a day. This is deliberately NOT in the 30s broadcast payload: that
  // frame goes to every connected surface on every tick, and this would multiply it by an order of
  // magnitude to redraw grids that change twice a day.
  //
  // Window: twice as much history as forecast, matching the near view in surf-report/plots.py. The
  // whole archive would be a couple of pixels per column on a phone.
  //
  // Rating and size travel as strings, one character per hour from t0 — a band index, or '.' for an
  // hour with no reading. That keeps ~700 hours near 1KB rather than tens of KB of JSON objects.
  //
  // Rating bands are a judgment, not a magnitude: red at or below Poor, yellow Poor-Fair, green Fair,
  // blue Good, purple Epic. Everything at or below Poor is one band because the difference between
  // Very Poor and Poor never changes whether it is worth going. Size stays a sequential ramp because
  // it really is a magnitude: white for 0-1 ft, then blues from light to the darkest navy that still
  // reads as blue, so every band above flat gets the whole blue range to itself.
  const SURF_RATING_SCALE = ['FLAT','VERY_POOR','POOR','POOR_TO_FAIR','FAIR','FAIR_TO_GOOD','GOOD','EPIC'];
  const SURF_BAND_COLORS  = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#af52de'];
  const SURF_BAND_LABELS  = ['Poor or below', 'Poor\u2013Fair', 'Fair', 'Good', 'Epic'];
  // Size bands are derived from the data, not fixed. Surfline's bands are not uniform one-foot steps
  // (4-5 and 4-6 both exist) and `plus` adds a half-step inside a band, so a hardcoded ladder drops
  // anything outside the range one spot happens to produce.
  const SURF_SIZE_FLAT = '#ffffff';     // every band topping out at 1 ft
  const SURF_SIZE_FLAT_MAX = 1;
  // The blues are spaced evenly in OKLCH lightness, not blended in RGB between fixed stops: RGB stops
  // bunched the middle bands together, which is what made adjacent sizes hard to tell apart. Hue drifts
  // toward pure blue as it darkens because a fixed hue goes grey-navy at the dark end. Chroma is the
  // most sRGB can hold at each lightness, capped so the mid blues don't go neon.
  const SURF_SIZE_L = [0.86, 0.20], SURF_SIZE_H = [252, 264], SURF_SIZE_CMAX = 0.17;

  function oklchHex(L, C, h) {
    const hr = h * Math.PI / 180;
    const rgb = (c) => {
      const a = c * Math.cos(hr), b = c * Math.sin(hr);
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
      return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    };
    let lo = 0, hi = C;   // bisect for the largest chroma still inside sRGB
    for (let i = 0; i < 30; i++) {
      const c = (lo + hi) / 2;
      if (rgb(c).every((v) => v >= -1e-4 && v <= 1 + 1e-4)) lo = c; else hi = c;
    }
    const enc = (x) => x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return '#' + rgb(lo).map((v) =>
      Math.round(Math.min(1, Math.max(0, enc(v))) * 255).toString(16).padStart(2, '0')).join('');
  }

  function sizeRamp(n) {
    return Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      return oklchHex(SURF_SIZE_L[0] + (SURF_SIZE_L[1] - SURF_SIZE_L[0]) * t, SURF_SIZE_CMAX,
                      SURF_SIZE_H[0] + (SURF_SIZE_H[1] - SURF_SIZE_H[0]) * t);
    });
  }

  // An unknown key is dropped, never guessed.
  function surfBand(rk) {
    const i = SURF_RATING_SCALE.indexOf(rk);
    if (i < 0) return null;
    if (i <= SURF_RATING_SCALE.indexOf('POOR')) return 0;
    if (i === SURF_RATING_SCALE.indexOf('POOR_TO_FAIR')) return 1;
    if (i <= SURF_RATING_SCALE.indexOf('FAIR_TO_GOOD')) return 2;
    if (i === SURF_RATING_SCALE.indexOf('GOOD')) return 3;
    return 4;
  }

  // Realtime is the fast path; this is the floor under it. A `surf_snapshots` event is a SINGLE
  // delivery, and the socket drops them — CHANNEL_ERROR and half-open silence are both routine
  // (`REALTIME_SILENCE_LIMIT_MS` exists for exactly that). Without an age check one missed event froze
  // the whole surf history at whatever the process built on boot, with no way back but a redeploy: on
  // 2026-09-07 the card served a 16-hour-old body and the measured water trace simply stopped at the
  // previous evening. Every other cache here already reconciles on a backstop; this was the only one
  // that could not.
  const SURFHIST_BACKSTOP_MS = 15 * 60 * 1000;
  const surfHistCache = { at: 0, body: null };
  const dirtySurfHist = () => { Object.assign(surfHistCache, { at: 0, body: null }); };

  // The surf alarm (lib/surfalarm.js, docs/ALARMS.md): the conditions live in `surf_alarms`, and the
  // hub re-decides on every new snapshot and every rule change, both of which arrive over realtime.
  // The 15-minute tick is the backstop behind that subscription, not the mechanism: it asks only for
  // the newest snapshot's timestamp, and reads nothing at all when no alarm is set.
  const surfAlarms = createSurfAlarms({
    sb, sbWrite, uuid: () => crypto.randomUUID(),
    nowLocal: nowNaiveLocal, today: () => localDate(), tz: getTZ,
    log: (m) => console.log(m),
    record: (ev, detail) => alarmLog('hub', ev, detail),
    veto: surfVeto,
  });
  const SURF_ALARM_BACKSTOP_MS = 15 * 60 * 1000;
  setInterval(() => surfAlarms.tick('backstop'), SURF_ALARM_BACKSTOP_MS);

  // THE LIVE WIND (lib/livewind.js): the dock's measured wind, read every ten minutes. Each new reading
  // is kept in water_readings beside the Pi's hourly NDBC collector — the same station under its NDBC
  // id, the same (station, ts) key, so the two write the same rows — rides the status frame as `wind`, and re-runs the surf alarm,
  // because a reading can bring the wind veto on or lift it.
  const liveWind = createLiveWind({
    store: async (rows) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/water_readings?on_conflict=station,ts`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                   'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      });
      if (!r.ok) throw new Error(`water_readings upsert -> ${r.status} ${(await r.text()).slice(0, 120)}`);
    },
    onReading: () => { surfAlarms.tick('wind'); pushSurfLive(); },
    log: (m) => console.log(m),
  });
  liveWind.start();

  // THE LIVE SWELL (lib/livebuoy.js): the two wave buoys either side of Mayport, read every ten
  // minutes, kept in wave_readings, carried in the status frame as `buoys` and in the surf feed.
  async function upsertRows(table, conflict, rows) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`${table} upsert -> ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  const liveBuoy = createLiveBuoy({
    store: (rows) => upsertRows('wave_readings', 'station,ts', rows),
    onReading: () => pushSurfLive(),
    log: (m) => console.log(m),
  });
  liveBuoy.start();

  // Seed both from what is already stored, so a deploy does not blank the live readings until the next
  // report — and a station that has gone quiet still shows its last reading, with its age.
  (async () => {
    // TWELVE hours, not three: the point of seeding is the case where the station has been quiet for a
    // while, and a three-hour window missed a gap that was already three and a half hours old.
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    try {
      const rows = await sb(`water_readings?station=eq.MYPF1&wind_kts=not.is.null&ts=gte.${encodeURIComponent(since)}`
        + '&select=ts,wind_kts,wind_dir_deg,gust_kts&order=ts.desc&limit=40');
      liveWind.seed(rows);
    } catch (e) { console.error('[live-wind] seed failed:', e.message); }
    try {
      const rows = await sb(`wave_readings?ts=gte.${encodeURIComponent(since)}&select=*&order=ts.desc&limit=40`);
      liveBuoy.seed(rows);
    } catch (e) { console.error('[live-buoy] seed failed:', e.message); }
  })();

  // ---- the surf feed: what the surf app (surf-app repo, Gnarcast) reads ------------------------------
  // One payload: the surf card's own data, the live wind against the forecast, the buoys, and the
  // forecast's next twelve hours ready to paint. Served at /api/surf/live and PUSHED on
  // /api/surf/stream whenever a wind reading, a buoy reading or a forecast arrives — the app page rides
  // that instead of the whole status stream.
  let surfSnap = null;                    // the newest surf_snapshots row, refetched only when it changes
  async function latestSurfSnap() {
    try {
      const [head] = await sb('surf_snapshots?slug=eq.mayport-poles&select=captured_at&order=captured_at.desc&limit=1');
      if (head && (!surfSnap || surfSnap.captured_at !== head.captured_at)) {
        const [full] = await sb(`surf_snapshots?slug=eq.mayport-poles&captured_at=eq.${encodeURIComponent(head.captured_at)}&select=slug,captured_at,rows`);
        if (full) surfSnap = full;
      }
    } catch (_) { /* keep the copy already held */ }
    return surfSnap;
  }
  // The SEA-TEMPERATURE forecast (Open-Meteo's marine model, kept as station `open-meteo` in
  // water_readings by surf-report's collector). Hourly and slow-moving, so it is read once every half
  // hour rather than on every push.
  let sstCache = { at: 0, rows: [] };
  async function sstAhead() {
    if (Date.now() - sstCache.at < 30 * 60 * 1000) return sstCache.rows;
    try {
      const from = new Date(Date.now() - 3600 * 1000).toISOString();
      const rows = await sb('water_readings?station=eq.open-meteo&lead_hours=not.is.null'
        + `&ts=gte.${encodeURIComponent(from)}&select=ts,water_f&order=ts.asc&limit=400`);
      sstCache = { at: Date.now(), rows: rows || [] };
    } catch (_) { /* keep what is held */ }
    return sstCache.rows;
  }

  // The wind's DIRECTION is the colour it is written in — green offshore, amber cross-shore, red onshore
  // — so the number itself is bare. A sign as well would say the same thing twice.
  const TYPE_COLORS = { Offshore: '#34c759', 'Cross-shore': '#ffcc00', Onshore: '#ff3b30' };

  // WATER TEMPERATURE AS A COLOUR, cold blue to warm orange, spread across the range MAYPORT ITSELF
  // RUNS: 51F in February to 88F in July, measured (station MYPF1 in `water_readings`). A generic
  // wetsuit chart is the wrong scale here even though its thresholds are real — it spends most of its
  // range below 70F, which is January and February on this coast, and saturates by the mid 80s, so
  // May through September, the whole surf season, comes out one flat colour. Anchored
  // on the local span instead, half the ramp falls in the 70s and 80s and a few degrees there show.
  //
  // Interpolated between the stops rather than stepped. NO GREEN anywhere in it and nothing that
  // reaches red — those two already mean offshore and onshore wind on the same screens.
  const WATER_STOPS = [[51, '#2f6fd0'], [60, '#4f9fe0'], [66, '#8fc6e6'], [72, '#dfe0d8'],
                       [78, '#ffd066'], [83, '#ffab4a'], [88, '#ff7a3c']];
  function waterColor(f) {
    if (f == null || !Number.isFinite(f)) return null;
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    if (f <= WATER_STOPS[0][0]) return WATER_STOPS[0][1];
    for (let i = 1; i < WATER_STOPS.length; i++) {
      const [t1, c1] = WATER_STOPS[i];
      if (f > t1) continue;
      const [t0, c0] = WATER_STOPS[i - 1];
      const k = (f - t0) / (t1 - t0);
      return hex(rgb(c0).map((v, j) => v + (rgb(c1)[j] - v) * k));
    }
    return WATER_STOPS[WATER_STOPS.length - 1][1];
  }

  // THE HEAT MAP'S SIZE COLOURS, for a snapshot's own rows. `/api/surf/history` builds the same ramp
  // over the bands present in ITS window — flat white up to a foot, then the blue ramp by height — and
  // this repeats that over the forecast's, so a colour means the same size wherever the app draws it.
  // They differ only if the archive holds a band the next ten days do not.
  function snapshotSizeColors(rows) {
    const combos = new Map();
    for (const r of rows || []) {
      if (r.sMax == null) continue;
      const key = `${r.sMin}|${r.sMax}|${r.sPlus ? 1 : 0}`;
      if (!combos.has(key)) combos.set(key, { min: r.sMin, max: r.sMax, plus: !!r.sPlus });
    }
    const order = [...combos.entries()].sort((a, b) =>
      (a[1].max - b[1].max) || ((a[1].plus ? 1 : 0) - (b[1].plus ? 1 : 0)) || (a[1].min - b[1].min));
    const nFlat = order.filter(([, v]) => v.max <= SURF_SIZE_FLAT_MAX).length;
    const colors = Array(nFlat).fill(SURF_SIZE_FLAT).concat(sizeRamp(Math.max(0, order.length - nFlat)));
    const byKey = new Map(order.map(([k], i) => [k, colors[i]]));
    return (r) => (r && r.sMax != null ? byKey.get(`${r.sMin}|${r.sMax}|${r.sPlus ? 1 : 0}`) || null : null);
  }

  // THE FORWARD CORRECTION. When the measured wind has diverged from what was forecast for this hour,
  // the same error is carried into the hours AHEAD with a decaying weight, and those hours get a
  // corrected wind beside the forecast one. Only today, and only hours still to come.
  //
  // THE WEIGHTS ARE FITTED, NOT CHOSEN. `w(k)` is the regression slope of the error at hour T+k on the
  // error at T through the origin — which IS the optimal multiplier — measured over 2026-06-19 to
  // 2026-09-23, both errors taken from the SAME capture because that is how this runs: one forecast in
  // hand, its error watched as it evolves. Correcting with these cuts speed error by 30% at k=1, 14% at
  // k=2 and 9% at k=3; past k=6 the gain is under a percent and the interval includes zero, which is why
  // it stops rather than tapering to something small.
  //
  // FITTED AT SHORT LEAD ONLY, and that is the whole reason the numbers look modest. Slopes pooled over
  // every lead time come out far higher (0.78 at k=1 against 0.66) because at five days out the "error"
  // is the run having the synoptic pattern wrong — a multi-day offset that barely decays. Production
  // never sees that: the capture in hand is a median 8 hours old. Applying the pooled weights here
  // measurably INCREASES error past k=6, so they are the answer to the question as posed and the wrong
  // answer for this code.
  //
  // SPEED AND DIRECTION DECAY DIFFERENTLY and cannot share a table — direction is worth nothing past
  // three hours, where speed still carries at six.
  //
  // One season only: late June to late September, about fourteen independent weather blocks. The sea
  // breeze dominates that, so these are summer constants and want re-fitting after a winter.
  const DECAY_KTS = [0, 0.65, 0.45, 0.37, 0.27, 0.20, 0.13];
  const DECAY_DIR = [0, 0.40, 0.22, 0.12];
  const decay = (table, k) => (k >= 1 && k < table.length ? table[k] : 0);

  function applyCorrection(days, wind, nowHour) {
    if (!wind || !wind.diverged || !wind.forecast || !days.length || !days[0].today) return;
    const dKts = wind.delta_kts;
    const m = wind.avg30 || wind;
    const dDir = m.dir != null && wind.forecast.dir != null
      ? ((m.dir - wind.forecast.dir + 540) % 360) - 180 : null;
    for (const h of days[0].hours) {
      const k = h.h - nowHour;
      if (k <= 0) continue;
      const wS = decay(DECAY_KTS, k), wD = decay(DECAY_DIR, k);
      if (!wS && !wD) continue;
      h.adj = Math.round(Math.max(wS, wD) * 100) / 100;
      if (wS && dKts != null && h.wind_kts != null) {
        h.wind_kts_adj = Math.max(0, Math.round(h.wind_kts + dKts * wS));
      }
      if (wD && dDir != null && h.wind_type) {
        const base = wind.forecast.dir;
        if (base != null) {
          const t = windType((360 + Math.round(base + dDir * wD)) % 360);
          h.wind_type_adj = t;
          h.wind_color_adj = TYPE_COLORS[t] || '#8b96a5';
        }
      }
    }
  }

  async function surfLive() {
    const snap = await latestSurfSnap();
    const now = Date.now() / 1000;
    const hours = ((snap && snap.rows) || [])
      .filter((r) => r.ts >= now - 3600 && r.ts < now + 12 * 3600)
      .map((r) => ({
        // Both forms: the label a strip prints, and the hour itself, which is where a clock dial puts it.
        t: (() => { const h = +etStringAt(new Date(r.ts * 1000)).slice(11, 13); return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`; })(),
        h: +etStringAt(new Date(r.ts * 1000)).slice(11, 13),
        rating: ratingLabel(r.rk), color: SURF_BAND_COLORS[surfBand(r.rk)] || '#8b96a5',
        ft: r.sMin == null ? null : `${r.sMin}-${r.sMax}`,
        wind_kts: r.wSpd == null ? null : Math.round(r.wSpd), wind_type: r.wType || null,
      }));
    // Wind TYPE wears one colour everywhere the app draws it (TYPE_COLORS above): offshore is what
    // grooms a wave, onshore what breaks one up.
    const wind = liveWind.view(snap);
    if (wind) {
      wind.type_color = TYPE_COLORS[wind.type] || '#8b96a5';
      if (wind.forecast) wind.forecast.type_color = TYPE_COLORS[wind.forecast.type] || '#8b96a5';
    }
    for (const h of hours) h.wind_color = TYPE_COLORS[h.wind_type] || '#8b96a5';
    // EVERY DAY THE WATCH CAN TURN TO: 6am to 6pm, the twelve hours worth surfing, one entry per day
    // from today to the end of the forecast. The watch draws one of them round its edge and the crown
    // picks which; its other pane lays all of them out as a grid, so the same array is the ring and the
    // heat map and the two cannot disagree about a day.
    const nowLocal = etNowString();
    const sizeColor = snapshotSizeColors((snap && snap.rows) || []);
    const dayRows = new Map();
    // AIR TEMPERATURE over the WHOLE local day, not just the drawn hours: the day's low is a pre-dawn
    // number and taking it from 6am onward would report the morning's low as the day's.
    const air = new Map();
    for (const r of (snap && snap.rows) || []) {
      const local = etStringAt(new Date(r.ts * 1000));
      const h = +local.slice(11, 13);
      if (r.aT != null) {
        const d = local.slice(0, 10);
        const cur = air.get(d);
        if (!cur) air.set(d, { lo: r.aT, hi: r.aT });
        else { cur.lo = Math.min(cur.lo, r.aT); cur.hi = Math.max(cur.hi, r.aT); }
      }
      // TWELVE HOURS, 6am through 5pm, and twelve is not negotiable: the watch lays them round its edge
      // as a CLOCK FACE — 6 at the bottom, 9 at the left, 12 at the top, 3 at the right — so an hour has
      // to be a twelfth of the ring or the positions stop meaning the time. Each one owns the block from
      // its own mark to the next, so the twelfth block runs 5pm to 6pm and the ring covers 6am to 6pm
      // without 6pm needing a mark of its own. It already has one: it is the same place as 6am.
      if (h < 6 || h >= 18) continue;
      const d = local.slice(0, 10);
      if (!dayRows.has(d)) dayRows.set(d, []);
      dayRows.get(d).push({ local, r });
    }
    const hourOf = ({ local, r }) => ({
        h: +local.slice(11, 13),
        t: (() => { const h = +local.slice(11, 13); return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`; })(),
        rating: ratingLabel(r.rk), color: SURF_BAND_COLORS[surfBand(r.rk)] || '#8b96a5',
        ft: r.sMin == null ? null : `${r.sMin}-${r.sMax}${r.sPlus ? '+' : ''}`,
        // The exact height as well as the band: Surfline's own range is coarse (1-2, 2-3), so a whole
        // morning reads as one bucket while the raw numbers climb through it. The midpoint of the raw
        // pair to one decimal is the aggregate — every swell train, transformed to what breaks here.
        ft_exact: r.sRawMin == null || r.sRawMax == null ? null
          : Math.round(((r.sRawMin + r.sRawMax) / 2) * 10) / 10,
        size_color: sizeColor(r),
        swp_s: r.swP == null ? null : Math.round(r.swP),
        swh_ft: r.swH == null ? null : Math.round(r.swH * 10) / 10,
        wind_kts: r.wSpd == null ? null : Math.round(r.wSpd), wind_type: r.wType || null,
        wind_color: TYPE_COLORS[r.wType] || '#8b96a5',
    });

    // WATER: measured by the buoys right now, and the marine model's next day beside it, at the hours
    // worth naming rather than all 24 of them.
    const sea = liveBuoy.blend();
    const sst = await sstAhead();
    const at = (h) => {
      const want = Date.now() + h * 3600 * 1000;
      const r = sst.reduce((a, b) => (Math.abs(Date.parse(b.ts) - want) < Math.abs(Date.parse(a.ts) - want) ? b : a), sst[0]);
      return r && Math.abs(Date.parse(r.ts) - want) < 2 * 3600 * 1000
        ? { t: etStringAt(new Date(r.ts)).slice(11, 13), f: r.water_f } : null;
    };
    if (sea) sea.water_color = waterColor(sea.water_f);
    // LONGSHORE DRIFT — how hard the water pushes ALONG the beach, and which way, from what the buoys
    // are reading right now rather than from the forecast. Waves arriving at an angle shove water
    // sideways; the standard form is sqrt(height) x sin(2 x angle), which peaks at 45 degrees and goes
    // to zero when they come in straight on. The angle is measured off the same shore normal the wind
    // labels use, so a drift and a wind type cannot disagree about where the beach faces.
    //
    // LEFT AND RIGHT ARE FROM THE WATER'S EDGE LOOKING OUT: facing the ocean, north is to your left.
    // So a push north reads `left` and a push south reads `right` — the words a person standing there
    // would use, rather than a compass point to convert in your head.
    //
    // It is a NUMBER, not a rating against a normal day. Roughly: a quarter of hours sit under 0.6, a
    // half between 0.6 and 1.6, a quarter above — measured over the forecast archive, since the buoys'
    // own record only began this week.
    if (sea && sea.wvht_ft != null && sea.mwd_deg != null) {
      const a = ((sea.mwd_deg - 97.5 + 540) % 360) - 180;
      const v = Math.sqrt(Math.max(0, sea.wvht_ft)) * Math.sin(2 * a * Math.PI / 180);
      sea.drift = Math.round(Math.abs(v) * 10) / 10;
      sea.drift_dir = v > 0 ? 'left' : 'right';
    }
    const water = { now_f: sea ? sea.water_f : null, now_color: sea ? sea.water_color : null,
                    next: sst.length ? [6, 12, 24].map(at).filter(Boolean) : [] };

    // EACH DAY ALSO CARRIES ITS WATER, taken at local noon, because the watch plots it as a line under
    // the grid and a plot has to have one value per column. The marine model runs about a week where
    // the surf forecast runs ten days, so the last days come back null and the line simply stops —
    // which is honest, and better than carrying the last value forward as though it were forecast.
    const today = nowLocal.slice(0, 10);
    const noonWater = (date) => {
      const want = Date.parse(`${date}T12:00:00-04:00`);
      let best = null, bestGap = Infinity;
      for (const r of sst) {
        const gap = Math.abs(Date.parse(r.ts) - want);
        if (gap < bestGap) { bestGap = gap; best = r; }
      }
      return best && bestGap < 6 * 3600 * 1000 ? Math.round(best.water_f * 10) / 10 : null;
    };
    const days = [...dayRows.keys()].filter((d) => d >= today).sort()
      .map((date) => {
        const f = date === today && water.now_f != null ? water.now_f : noonWater(date);
        const a = air.get(date);
        return { date, today: date === today, hours: dayRows.get(date).map(hourOf),
                 water_f: f, water_color: waterColor(f),
                 air_hi: a ? Math.round(a.hi) : null, air_lo: a ? Math.round(a.lo) : null };
      });
    // WHERE NOW IS, from the BREAK's clock and not the watch's: the watch can be in another timezone
    // and its `Calendar.current` is the phone's, so a spoke placed there lands on the wrong hour the
    // moment the user travels. The watch always opens on days[0], which is today.
    const nowH = +nowLocal.slice(11, 13) + +nowLocal.slice(14, 16) / 60;
    applyCorrection(days, wind, Math.floor(nowH));
    return { surf: buildSurf(snap), wind, sea, buoys: liveBuoy.view(), hours, water, days,
             now_hour: Math.round(nowH * 100) / 100,
             weather: getWeather(), generated_at: new Date().toISOString() };
  }
  const surfClients = new Set();
  async function pushSurfLive() {
    if (!surfClients.size) return;
    let frame;
    try { frame = 'event: surf\ndata: ' + JSON.stringify(await surfLive()) + '\n\n'; } catch (_) { return; }
    for (const res of surfClients) { try { res.write(frame); } catch {} }
  }

  // The veto LEANS LENIENT — it takes an unambiguously blown-out morning to suppress an alarm, not a
  // marginal one. Measured across the archive, no hour at onshore 8 kt or more has ever been rated Fair
  // (0 of 351), and in the 6-11am window the strongest onshore wind on a Fair hour is 5.1 kt — so 12
  // sits three bands clear of anything that has ever been surfable and still only fires on wind that has
  // plainly ruined the morning. The asymmetry is the argument: suppressing a real alarm costs the
  // session, and letting one through costs a look at the window.
  const VETO_DEFAULT_KTS = 12;

  // THE WIND VETO (docs/ALARMS.md): measured ONSHORE wind at or over `surf_veto_kts` (default 12) rules
  // the rest of today's hours out of a surf alarm, whatever the forecast said. The half-hour average,
  // not one reading — a six-minute reading is a gust as often as a trend — and only while it is fresh:
  // a reading reaches the API about six minutes after it is taken and is fetched every ten, so 30
  // minutes allows one missed fetch. 0 turns it off.
  async function surfVeto() {
    let threshold = VETO_DEFAULT_KTS;
    try { const v = parseFloat((await settingsAll()).surf_veto_kts); if (Number.isFinite(v)) threshold = v; } catch (_) {}
    if (!(threshold > 0)) return null;
    const c = liveWind.current();
    if (!c || c.age_min > 30 || !c.avg30) return null;
    const a = c.avg30;
    return a.type === 'Onshore' && a.kts >= threshold ? { kts: a.kts, dir: a.dir, type: a.type, threshold } : null;
  }


  // Public, with the rest of the surf app's feeds (THE SURF APP'S PAGE AND FEEDS ARE PUBLIC, above).
  pub.get('/api/surf/history', async (req, res) => {
    try {
      if (surfHistCache.body && Date.now() - surfHistCache.at < SURFHIST_BACKSTOP_MS)
        return res.json(surfHistCache.body);
      const rows = await sbRange('surf_hours?select=ts,rk,s_min,s_max,s_plus,s_raw_max&order=ts.asc');
      if (!rows.length) return res.json({ t0: null, hours: 0 });

      const nowH = Math.floor(Date.now() / 3600000) * 3600;
      const ahead = Math.max(0, rows[rows.length - 1].ts - nowH);
      const etHour = (ts) => +new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date(ts * 1000)) % 24;
      // The whole archive, because the card scrolls back through it. Both ends of a window have to
      // land on local midnight: the client buckets hours into day columns by local date, so a start
      // part-way through a day renders as a stub column. Forward at the archive's start (snapping
      // back would invent empty hours before the first reading), back at the default view's.
      const first = rows[0].ts, fh = etHour(first);
      const from = fh === 0 ? first : first + (24 - fh) * 3600;
      const win = rows.filter((r) => r.ts >= from);
      if (!win.length) return res.json({ t0: null, hours: 0 });
      // Where the card sits before anyone scrolls. Twelve days back plus whatever Surfline forecasts
      // ahead (about nine) is three weeks, which is what fills the wall's grid box at ~18px per day
      // now that weather has taken the right-hand third of the card. Widen this and the columns get
      // narrower rather than the card getting wider; the day is the unit that has to stay readable.
      const rough = nowH - 12 * 86400;
      const defaultT0 = Math.max(from, rough - etHour(rough) * 3600);

      const t0 = win[0].ts, tN = win[win.length - 1].ts;
      const hours = Math.floor((tN - t0) / 3600) + 1;
      const by = new Map(win.map((r) => [r.ts, r]));

      // Both water series come from `water_readings`, read at request time. The measured trace used to
      // ride on `surf_hours.water_f`, which surf-report's materialize step fills — so it could only
      // advance when a Surfline capture ran, every 3h, and the top of that hour races the buoy pull
      // that feeds it. The reading itself is half-hourly and owes nothing to Surfline, so tying its
      // freshness to a forecast scrape put the card hours behind a source that was already current.
      const sinceT0 = `&ts=gte.${new Date(t0 * 1000).toISOString()}&order=ts.asc`;
      let meas = [], fc = [];
      try {
        // Forecast water is a different claim from a measurement, so it stays a separate series rather
        // than being backfilled into the gap after now.
        [meas, fc] = await Promise.all([
          sbRange(`water_readings?select=ts,water_f&station=eq.41112${sinceT0}`),
          sbRange(`water_readings?select=ts,water_f&station=eq.open-meteo${sinceT0}`),
        ]);
      } catch (_) { /* the grids are still worth drawing without it */ }
      // Mean of every reading inside the hour, matching how plots.py draws the same buoy.
      const hourOfTs = (r) => Math.floor(Date.parse(r.ts) / 3600000) * 3600;
      const measAcc = new Map();
      for (const r of meas) {
        if (r.water_f == null) continue;
        const a = measAcc.get(hourOfTs(r)) || [0, 0];
        a[0] += r.water_f; a[1]++;
        measAcc.set(hourOfTs(r), a);
      }
      const fcBy = new Map(fc.map((r) => [hourOfTs(r), r.water_f]));

      // Distinct size bands present in this window, ordered by real height where we have it and by
      // the label for rows predating 00083.
      const combos = new Map();
      for (const r of win) {
        if (r.s_max == null) continue;
        const key = `${r.s_min}|${r.s_max}|${r.s_plus ? 1 : 0}`;
        const mag = r.s_raw_max == null ? null : r.s_raw_max;
        const prev = combos.get(key);
        if (!prev) combos.set(key, { min: r.s_min, max: r.s_max, plus: !!r.s_plus, mag });
        else if (mag != null) prev.mag = prev.mag == null ? mag : Math.max(prev.mag, mag);
      }
      const order = [...combos.entries()].sort((a, b) => {
        const ka = a[1].mag ?? (a[1].max + (a[1].plus ? .5 : 0));
        const kb = b[1].mag ?? (b[1].max + (b[1].plus ? .5 : 0));
        return ka - kb || a[1].max - b[1].max || (a[1].plus ? 1 : 0) - (b[1].plus ? 1 : 0);
      });
      const sizeIdx = new Map(order.map(([k], i) => [k, i]));
      const nFlat = order.filter(([, v]) => v.max <= SURF_SIZE_FLAT_MAX).length;  // sorted, so a prefix
      const sizeColors = Array(nFlat).fill(SURF_SIZE_FLAT).concat(sizeRamp(order.length - nFlat));
      const sizeLabels = order.map(([, v]) => `${v.min}\u2013${v.max}${v.plus ? '+' : ''} ft`);

      let rating = '', size = '';
      const water = [], waterFc = [];
      for (let t = t0, i = 0; i < hours; t += 3600, i++) {
        const r = by.get(t);
        const b = r ? surfBand(r.rk) : null;
        rating += b == null ? '.' : String(b);
        const sk = r && r.s_max != null ? sizeIdx.get(`${r.s_min}|${r.s_max}|${r.s_plus ? 1 : 0}`) : undefined;
        size += sk == null ? '.' : sk.toString(36);      // base36 so more than ten bands still fit one char
        const m = measAcc.get(t);
        water.push(m ? Math.round((m[0] / m[1]) * 10) / 10 : null);
        const f = fcBy.get(t);
        waterFc.push(f == null ? null : Math.round(f * 10) / 10);
      }

      const body = { t0, hours, defaultT0, rating, size, water, waterFc,
                     bandColors: SURF_BAND_COLORS, bandLabels: SURF_BAND_LABELS,
                     sizeColors, sizeLabels };
      Object.assign(surfHistCache, { at: Date.now(), body });
      res.json(body);
    } catch (_) {
      res.status(502).json({ error: 'could not read surf history' });
    }
  });

  pub.get('/api/surf/live', async (req, res) => {
    try {
      const out = await surfLive();
      // DEV ONLY: force a divergence, to see what the correction looks like when the wind happens to
      // agree with the model. `?div_kts=8&div_dir=50` — nothing reads these but a person testing.
      const k = parseFloat(req.query.div_kts), d = parseFloat(req.query.div_dir);
      const nowOverride = parseFloat(req.query.div_now);   // pretend it is this hour
      if (Number.isFinite(nowOverride)) out.now_hour = nowOverride;
      if (out.wind && out.wind.forecast && (Number.isFinite(k) || Number.isFinite(d))) {
        out.wind.diverged = true;
        if (Number.isFinite(k)) out.wind.delta_kts = k;
        if (Number.isFinite(d) && out.wind.forecast.dir != null) {
          const nd = (out.wind.forecast.dir + d + 360) % 360;
          out.wind.dir = nd; out.wind.dir_to = (nd + 180) % 360;
          out.wind.avg30 = { ...(out.wind.avg30 || {}), dir: nd };
          out.wind.delta_dir = Math.abs(d);
        }
        applyCorrection(out.days, out.wind, Math.floor(out.now_hour || 12));
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  pub.get('/api/surf/stream', async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
              Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    surfClients.add(res);
    try { res.write('event: surf\ndata: ' + JSON.stringify(await surfLive()) + '\n\n'); } catch (_) {}
    const ka = setInterval(() => { try { res.write(PING); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); surfClients.delete(res); });
  });
  // The surf app's page (surf-app repo): the live readings and the surf heat map, full screen.
  pub.get('/surf', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(SURF_HTML);
  });

  // The live wind and the readings behind it (lib/livewind.js) — the same `wind` the status frame
  // carries, plus the last few hours of six-minute readings for a surface that wants to draw them.
  gated.get('/api/wind', async (req, res) => {
    let snap = null;
    try { [snap] = await sb('surf_snapshots?slug=eq.mayport-poles&select=captured_at,rows&order=captured_at.desc&limit=1'); } catch (_) {}
    res.json({ now: liveWind.view(snap), readings: liveWind.readings() });
  });

  return {
    SURF_BAND_COLORS, dirtySurfHist, liveBuoy, liveWind, pushSurfLive, surfAlarms, surfBand,
  };
};
