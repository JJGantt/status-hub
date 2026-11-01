'use strict';
// RAIN CHANCE at home, as a 7-day x 24-hour grid the wall paints beside the surf plots.
//
// Source is the National Weather Service gridpoint covering home, set by NWS_GRIDPOINT (office/x,y,
// e.g. "TOP/31,80"; look it up with https://api.weather.gov/points/<lat>,<lon>). Deliberately NOT the
// surf spot's cell: summer rain on this coast is sea-breeze convection that fires along the
// convergence line inland while the beach stays dry, and the two cells disagree by twenty points on
// a September afternoon.
//
// NWS RATHER THAN A MODEL API, because it publishes the number and the forecast it belongs to from
// one grid. Open-Meteo's daily weather_code comes from a single deterministic run while its
// probability comes from a separate ensemble product, so a day can read 72% under a plain cloud —
// the run that drew the icon stayed dry. Nothing here needs the icon today, but the same coherence
// is why the numbers are trusted: NWS also runs finer (2.5km against ~13km) and put this week's
// highs at 86-88F where the global best-match claimed 95-98F.
//
// RESOLUTION DECAYS AND IS NOT SMOOTHED. probabilityOfPrecipitation arrives as intervals, not hours:
// PT1H for today and tomorrow, PT2H/PT4H later in that span, then PT6H from the third day out —
// because the ensembles behind the number do not run at an hourly step past about 48 hours. Each
// value is repeated across its own interval rather than interpolated between neighbours. Six
// identical hours are what the forecast actually claims; a curve through them would be this file
// inventing detail the source does not have.
const { getTZ } = require('./dates');

const GRIDPOINT = process.env.NWS_GRIDPOINT
  ? `https://api.weather.gov/gridpoints/${process.env.NWS_GRIDPOINT}` : null;
if (!GRIDPOINT) console.error('[weather] NWS_GRIDPOINT is not set: the rain grid stays empty.');
// NWS asks for a contactable agent and answers 403 to the default fetch one.
const UA = 'jared-status-hub (jared.gantt@gmail.com)';

const DAYS = 7;
// The hours the grid draws. The night is always empty here and was taking a third of the box; 5a-10p
// covers anything he would be outside for and makes the remaining rows almost half again as tall.
const WINDOW = [5, 22];

// 5-point buckets, so one base36 char carries an hour and the client indexes the ramp with it —
// the same encoding cards/surf.js reads for its rating and size grids.
const STEPS = 21;
const RAMP = [[0, [11, 15, 19]], [10, [14, 62, 78]], [30, [23, 148, 171]],
              [60, [82, 211, 216]], [100, [217, 246, 255]]];
// Cyan, not the blue a rain map would normally take: the surf SIZE grid sits immediately left of
// this one and is drawn in blues, and two blue grids side by side read as one picture.
function rampColor(pct) {
  if (pct <= RAMP[0][0]) return rgb(RAMP[0][1]);
  for (let i = 1; i < RAMP.length; i++) {
    if (pct <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], f = (pct - a) / (b - a);
      return rgb(ca.map((v, k) => Math.round(v + (cb[k] - v) * f)));
    }
  }
  return rgb(RAMP[RAMP.length - 1][1]);
}
const rgb = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
// ABSOLUTE, never normalised to the week on screen. A quiet week has to look quiet: rescaling so its
// peak reached full brightness would make an 8% week glow exactly like a 90% one, and the colour
// would stop meaning anything on its own.
const COLORS = Array.from({ length: STEPS }, (_, i) => rampColor((i / (STEPS - 1)) * 100));

const localParts = (d) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: getTZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
};

const ISO_DUR = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/;
function durationHours(validTime) {
  const m = ISO_DUR.exec(String(validTime).split('/')[1] || '');
  return m ? (+(m[1] || 0)) * 24 + (+(m[2] || 0)) : 1;
}

// Grid of DAYS columns from today, each 24 hours, in the display zone.
function shape(values, updateTime) {
  const byHour = new Map();
  for (const v of values || []) {
    if (v.value == null) continue;
    const start = Date.parse(String(v.validTime).split('/')[0]);
    if (!Number.isFinite(start)) continue;
    for (let i = 0; i < durationHours(v.validTime); i++) {
      const { date, hour } = localParts(new Date(start + i * 3600000));
      byHour.set(`${date}T${hour}`, v.value);
    }
  }

  const today = localParts(new Date()).date;
  const cols = Array.from({ length: DAYS }, (_, i) =>
    localParts(new Date(Date.parse(today + 'T12:00:00Z') + i * 86400000)).date);

  let pop = '', peak = null;
  cols.forEach((date, col) => {
    for (let h = 0; h < 24; h++) {
      const v = byHour.has(`${date}T${h}`) ? byHour.get(`${date}T${h}`) : null;
      pop += v == null ? '.' : Math.round((v / 100) * (STEPS - 1)).toString(36);
      // The label names the brightest cell ON SCREEN, so the peak is taken over the drawn window
      // only — a 3am spike the grid does not show must not put a number under a dark column.
      if (v != null && h >= WINDOW[0] && h < WINDOW[1] && (!peak || v > peak.v)) peak = { v, col, h0: h, h1: h + 1 };
    }
  });
  // Widen the peak to the run of hours holding the same value, so a client drawing the label inside
  // the block centres it on the block rather than on one hour of a six-hour claim.
  if (peak) {
    const at = (h) => byHour.get(`${cols[peak.col]}T${h}`);
    while (peak.h0 > WINDOW[0] && at(peak.h0 - 1) === peak.v) peak.h0--;
    while (peak.h1 < WINDOW[1] && at(peak.h1) === peak.v) peak.h1++;
  }

  return { cols, pop, window: WINDOW, peak, colors: COLORS, at: updateTime || null };
}

// The frame is broadcast every 30s and NWS republishes about hourly, so the fetch is cached and the
// broadcast NEVER waits on it: getWeather returns what it has and refreshes behind the caller. A
// slow or hanging NWS request would otherwise stall the whole status frame for every client.
const TTL_MS = 15 * 60 * 1000;
let cache = null, at = 0, pending = false;

async function refresh() {
  if (pending) return;
  pending = true;
  try {
    const r = await fetch(GRIDPOINT, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
    if (!r.ok) throw new Error('nws ' + r.status);
    const j = await r.json();
    const built = shape((j.properties || {}).probabilityOfPrecipitation?.values, (j.properties || {}).updateTime);
    if (built.pop.replace(/\./g, '')) { cache = built; at = Date.now(); }
  } catch (e) {
    // Keep the last good copy. A gridpoint that 500s for an hour is normal for this API, and a stale
    // grid is worth far more than an empty one — `at` is left alone so the next tick retries.
    console.error('[weather] refresh failed:', e.message);
  } finally { pending = false; }
}

function getWeather() {
  if (!GRIDPOINT) return null;
  if (Date.now() - at > TTL_MS) refresh();
  return cache;
}

module.exports = { getWeather };
