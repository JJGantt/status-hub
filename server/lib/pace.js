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
const RECENCY_DAYS = 21;                    // only consider the last 21 days of history
// Breakfast share of daily calories. Research-grounded (~25% is a typical/recommended
// breakfast fraction). Used to shift the window start earlier so the expected curve has
// drained ~one breakfast's worth by the typical first-meal time.
const BREAKFAST_FRACTION = 0.25;

// Percentile via linear interpolation on a sorted ascending array (p in [0,1]).
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Eating window from history. Derives a typical first-meal time and last-meal time, then
// shifts the window START earlier (into sleep) by ~a breakfast's worth so that a normal
// breakfast at the typical first-meal time lands you on-pace rather than ahead.
function deriveWindow(occurredList) {
  // Group entries by 4am-origin day -> per-day first (min) and last (max) offset.
  const byDay = {};
  for (const ts of occurredList || []) {
    const k = dayKey(ts), off = offsetFromTs(ts);
    if (off == null) continue;
    (byDay[k] = byDay[k] || []).push(off);
  }
  const days = Object.keys(byDay);

  // Recency bias: only days within RECENCY_DAYS of the most recent day present.
  let firsts = [], lasts = [];
  if (days.length) {
    const maxDay = days.reduce((a, b) => (a > b ? a : b));
    const cutoff = new Date(maxDay + 'T00:00:00');
    cutoff.setDate(cutoff.getDate() - (RECENCY_DAYS - 1));
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    for (const k of days) {
      if (k < cutoffKey) continue;
      firsts.push(Math.min(...byDay[k]));
      lasts.push(Math.max(...byDay[k]));
    }
  }

  // IQR trimming is the ONLY thing gated on the 7-day threshold: Tukey fences need enough
  // points to be meaningful. With ≥7 valid days, do the one-sided directional trim; with
  // 1–6, use the days as-is. The start-shift below ALWAYS runs regardless of count.
  if (firsts.length >= MIN_DAYS_FOR_WINDOW) {
    // One-sided Tukey IQR trim (error modes are directional):
    //  - firsts: drop only UPPER outliers (forgot-to-log-breakfast days read late).
    //  - lasts:  drop only LOWER outliers (forgot-a-late-item days read early).
    const fSorted = [...firsts].sort((a, b) => a - b);
    const fQ1 = percentile(fSorted, 0.25), fQ3 = percentile(fSorted, 0.75);
    const fFence = fQ3 + 1.5 * (fQ3 - fQ1);
    firsts = firsts.filter((v) => v <= fFence);

    const lSorted = [...lasts].sort((a, b) => a - b);
    const lQ1 = percentile(lSorted, 0.25), lQ3 = percentile(lSorted, 0.75);
    const lFence = lQ1 - 1.5 * (lQ3 - lQ1);
    lasts = lasts.filter((v) => v >= lFence);
  }

  // Derive the base first-meal/end times from whatever valid days remain. With zero data,
  // fall back to the fixed 8a–10p base — but the shift below STILL applies to it.
  const haveData = firsts.length >= 1;
  const firstMeal = haveData ? median(firsts) : DEFAULT_START;
  let endMin = Math.round(haveData ? median(lasts) : DEFAULT_END);

  // ALWAYS shift start earlier so expected reaches BREAKFAST_FRACTION by the first-meal time:
  //   expected(firstMeal) = (firstMeal - startMin) / (endMin - startMin) = BF
  //   => startMin = (firstMeal - BF*endMin) / (1 - BF)
  let startMin = (firstMeal - BREAKFAST_FRACTION * endMin) / (1 - BREAKFAST_FRACTION);
  startMin = Math.round(Math.max(0, Math.min(startMin, firstMeal)));

  if (endMin - startMin < 360) endMin = startMin + 360; // enforce a sane minimum 6h window
  // firstMin = the derived typical first-meal time (minutes since 4am); startMin is shifted earlier
  // off it for the pace curve, so consumers wanting "when you actually eat" should use firstMin.
  return { startMin, endMin, firstMin: Math.round(firstMeal), source: haveData ? 'derived' : 'default' };
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

// Fill gauges for the produce rings (vegetables / leafy greens / fruit).
//
// Deliberately NOT paced. The macro rings above are drain gauges — full when you're on-pace, bleeding
// toward empty as the clock advances without logging — because calories/macros have a target you can
// overshoot. Produce is the opposite shape: there's no penalty for eating it all at dinner and no such
// thing as too much, so these start EMPTY every day and just fill toward a fixed goal. No window, no
// clock term, no marker, no overflow arc. `progress` is clamped at 1 so the ring can't wrap.
function computeFill(consumed, goals) {
  const out = {};
  for (const k of ['veg_g', 'leafy_g', 'fruit_g']) {
    const goal = (goals || {})[k] || 0;
    const got = (consumed || {})[k] || 0;
    out[k] = {
      consumed: Math.round(got),
      goal: Math.round(goal),
      progress: goal > 0 ? Math.round(Math.min(1, got / goal) * 1000) / 1000 : 0,
      met: goal > 0 && got >= goal,
    };
  }
  return out;
}

module.exports = { deriveWindow, computePace, computeFill, offsetFromHM, windowLabel };
