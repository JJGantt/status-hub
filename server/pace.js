'use strict';
// Within-day intake pacing for the gamified nutrition bars.
//
// Expected intake rises LINEARLY across the eating window (aspirational-even — this is the
// behavior we want to shape, since even protein distribution is optimal). Each macro bar
// reflects how on-pace you are: full when consumed >= expected-by-now, draining toward empty
// (and green -> red) as the clock advances without logging, refilling when you log. The bar is
// a PACE gauge; the consumed/goal numbers carry absolute progress.
//
// Server computes everything (values, fill, color); clients only render.

const DAY_START_HOUR = 4; // must match server.js day window

// Minutes into the 4am-origin day: 0 = 4:00am, 1439 = 3:59am next day. This makes a 1am
// snack read as "late" (near the end of the day) rather than "early morning".
function offsetFromHM(h, m) { return ((h - DAY_START_HOUR) * 60 + m + 1440) % 1440; }
function offsetFromTs(ts) {
  const m = String(ts).match(/T(\d{2}):(\d{2})/);
  return m ? offsetFromHM(+m[1], +m[2]) : null;
}
function dayKey(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(ts).slice(0, 10);
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4] - DAY_START_HOUR, +m[5]);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

const DEFAULT_START = offsetFromHM(8, 0);   // 8:00am
const DEFAULT_END = offsetFromHM(22, 0);    // 10:00pm
const MIN_DAYS_FOR_WINDOW = 7;

// Eating window from history: median first-entry offset and median last-entry offset per day.
function deriveWindow(occurredList) {
  const byDay = {};
  for (const ts of occurredList || []) {
    const k = dayKey(ts), off = offsetFromTs(ts);
    if (off == null) continue;
    (byDay[k] = byDay[k] || []).push(off);
  }
  const firsts = [], lasts = [];
  for (const k in byDay) { firsts.push(Math.min(...byDay[k])); lasts.push(Math.max(...byDay[k])); }
  if (firsts.length < MIN_DAYS_FOR_WINDOW) return { startMin: DEFAULT_START, endMin: DEFAULT_END, source: 'default' };
  let s = Math.round(median(firsts)), e = Math.round(median(lasts));
  if (e - s < 360) e = s + 360; // enforce a sane minimum 6h window
  return { startMin: s, endMin: e, source: 'derived' };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
// Deviation is normalized by the FIXED daily goal (not by expected), so a given amount of
// food moves the gauge the same regardless of time of day. devNorm = (consumed - expected)/goal.
const COLOR_SCALE = 0.4; // devNorm magnitude that saturates the color
function underColor(devNorm) { // devNorm <= 0: green (on pace) -> red (behind)
  const t = Math.max(0, Math.min(1, -devNorm / COLOR_SCALE));
  return hslToHex(120 * (1 - t), 0.75, 0.5);
}
function overColor(devNorm) {  // devNorm > 0: amber -> orange (over pace = trending to overshoot)
  const t = Math.max(0, Math.min(1, devNorm / COLOR_SCALE));
  return hslToHex(45 - 20 * t, 0.9, 0.5);
}

function macroPace(consumed, goal, frac) {
  const expected = goal * frac;
  const dev = consumed - expected;                 // grams off the pace line (signed)
  const devNorm = goal > 0 ? dev / goal : 0;        // normalized by goal -> consistent all day
  return {
    consumed: Math.round(consumed),
    goal: Math.round(goal),
    expected: Math.round(expected),
    dev_g: Math.round(dev),                          // signed grams off pace -> center number
    progress: goal > 0 ? Math.round((consumed / goal) * 1000) / 1000 : 0, // absolute, for the bars
    ring_base: Math.round(Math.max(0, Math.min(1, 1 + devNorm)) * 1000) / 1000, // main arc: full=on-pace, drains
    ring_over: Math.round(Math.max(0, Math.min(1, devNorm)) * 1000) / 1000,     // overflow arc (one wrap max visual)
    base_color: devNorm <= 0 ? underColor(devNorm) : '#22c55e',
    over_color: devNorm > 0 ? overColor(devNorm) : null,
  };
}

function computePace({ consumed, goal, window, nowOff }) {
  let frac;
  if (nowOff <= window.startMin) frac = 0;
  else if (nowOff >= window.endMin) frac = 1;
  else frac = (nowOff - window.startMin) / (window.endMin - window.startMin);
  const macros = {};
  for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) {
    macros[k] = macroPace((consumed || {})[k] || 0, (goal || {})[k] || 0, frac);
  }
  return { window, nowOff, fraction: Math.round(frac * 100) / 100, macros };
}

// "8:00a–10:00p" style label from the offsets.
function windowLabel(window) {
  const fmt = (off) => {
    let total = (off + DAY_START_HOUR * 60) % 1440;
    let h = Math.floor(total / 60), m = total % 60;
    const ap = h < 12 ? 'a' : 'p';
    let h12 = h % 12; if (h12 === 0) h12 = 12;
    return m === 0 ? `${h12}${ap}` : `${h12}:${String(m).padStart(2, '0')}${ap}`;
  };
  return `${fmt(window.startMin)}–${fmt(window.endMin)}`;
}

module.exports = { deriveWindow, computePace, offsetFromHM, windowLabel };
