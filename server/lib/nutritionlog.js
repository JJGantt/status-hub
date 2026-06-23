'use strict';
// Nutrition log: calorie-adherence calendar (diverging color by intake/target) + calorie/weight trend.
const { MON, dayBucketOf } = require('./dates');
const { estimateMaintenance } = require('./maintenance');

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
const proteinColor = (ratio) => hslToHex(120 * Math.max(0, Math.min(1, ratio)), 0.62, 0.45); // red(0) → green(≥1)
// Diverging calorie color by intake/target ratio: under (ratio<1) green→blue (colder the lower),
// on-target (~1) green, over (ratio>1) green→yellow→red (deep red ≥1.3). Symmetric ±30% around 1.
function calorieColor(ratio) {
  if (!(ratio > 0)) return null;
  if (ratio <= 1) {
    // 1.0 → green (h=120), 0.7 → blue (h=220). Clamp at 0.7.
    const t = Math.max(0, Math.min(1, (1 - ratio) / 0.3)); // 0 at target, 1 at ≤0.7
    return hslToHex(120 + 100 * t, 0.6, 0.46);
  }
  // 1.0 → green (h=120) through yellow (h=60) to red (h=0). Clamp at 1.3.
  const t = Math.max(0, Math.min(1, (ratio - 1) / 0.3)); // 0 at target, 1 at ≥1.3
  return hslToHex(120 * (1 - t), 0.66, 0.46);
}

// targetsByDate: sorted-ascending [{date, calories}] historical target snapshots; for each day we
// pick the most-recent snapshot with date <= that day (fallback to fallbackCal if none precedes it).
function targetCalFor(ds, targets, fallbackCal) {
  let best = null;
  for (const t of targets) { if (t.date <= ds) best = t; else break; }
  return best && best.calories > 0 ? best.calories : fallbackCal;
}

// Resolve each day's GOAL = its maintenance + intent. Shared by the calendar/heatmap, the trend
// plot, and the single-day detail so they never disagree. Tracking history splits into clusters (a
// >4-day intake gap starts a new one): the most-recent cluster is the active run (stored daily
// targets, else maintenance + surplus); an OLDER tracked cluster is assumed to have been a cut, so
// its goal is maintenance − deficit; untracked days are neutral maintenance. Maintenance is the
// formula "as of" each day, cached. surplus/deficit are signed knobs (the surplus setting).
function buildGoalResolver({ rows = [], weights = [], targets = [], today, surplus = 150, deficit = 150, fallbackMaint = null }) {
  const cal = {};
  for (const r of rows) { const d = dayBucketOf(r.occurred_at); cal[d] = (cal[d] || 0) + (Number(r.calories) || 0); }
  const tgs = (targets || []).map((t) => ({ date: String(t.date).slice(0, 10), calories: Number(t.calories) || 0 }))
    .filter((t) => t.calories > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const intakeByDay = Object.entries(cal).map(([date, calories]) => ({ date, calories }));
  const dms = (d) => Date.parse(d + 'T12:00:00Z');
  const trackedDays = Object.keys(cal).filter((d) => cal[d] > 0 && d <= today).sort();
  const clusters = []; let curC = [];
  for (const d of trackedDays) { if (curC.length && (dms(d) - dms(curC[curC.length - 1])) / 86400000 > 4) { clusters.push(curC); curC = []; } curC.push(d); }
  if (curC.length) clusters.push(curC);
  const spans = clusters.map((c) => ({ start: c[0], end: c[c.length - 1] }));
  const recentSpan = spans.length ? spans[spans.length - 1] : null;
  const olderSpans = spans.slice(0, -1);
  const inSpan = (ds, sp) => sp && ds >= sp.start && ds <= sp.end; // whole period, incl. un-logged days
  const maintCache = {};
  const maintFor = (ds) => {
    if (ds in maintCache) return maintCache[ds];
    if (ds > today && fallbackMaint != null) return (maintCache[ds] = fallbackMaint);
    const wUpTo = weights.filter((w) => w.date <= ds);
    const iUpTo = intakeByDay.filter((x) => x.date <= ds);
    return (maintCache[ds] = estimateMaintenance({ weights: wUpTo, intakeByDay: iUpTo, today: ds }).maintenance);
  };
  const goalForDay = (ds) => {
    const m = maintFor(ds);
    if (inSpan(ds, recentSpan)) return Math.round(targetCalFor(ds, tgs, m + surplus));
    if (olderSpans.some((sp) => inSpan(ds, sp))) return Math.round(m - deficit);
    return Math.round(m);
  };
  return { goalForDay, maintFor };
}

function buildNutritionLog(rows, weights, goalCal, maintenanceEst, today, calTargets = [], weeks = 12, surplus = 150, deficit = 150) {
  const cal = {};
  for (const r of rows || []) { const d = dayBucketOf(r.occurred_at); cal[d] = (cal[d] || 0) + (Number(r.calories) || 0); }
  const anchor = new Date(today + 'T12:00:00Z'), dow = anchor.getUTCDay();
  const startMs = anchor.getTime() - dow * 86400000 - (weeks - 1) * 7 * 86400000;
  const allDates = []; for (let i = 0; i < weeks * 7; i++) allDates.push(new Date(startMs + i * 86400000).toISOString().slice(0, 10));
  const { goalForDay, maintFor } = buildGoalResolver({ rows, weights, targets: calTargets, today, surplus, deficit, fallbackMaint: maintenanceEst });
  // calorie calendar (week columns, like the workout heatmap) — diverging color by intake/goal ratio
  const cols = [], months = []; let prevMon = -1;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const ds = allDates[w * 7 + d];
      const has = Object.prototype.hasOwnProperty.call(cal, ds), future = ds > today;
      const tgt = goalForDay(ds);
      const ratio = has && tgt > 0 ? cal[ds] / tgt : 0;
      col.push({ date: ds, has: has && !future, ratio: Math.round(ratio * 100) / 100, color: (has && !future) ? calorieColor(ratio) : null, today: ds === today });
    }
    const m = Number(col[0].date.slice(5, 7)) - 1; months.push(m !== prevMon ? MON[m] : ''); prevMon = m; cols.push(col);
  }
  // calorie 7-day rolling average per completed day (the honest calorie signal)
  const calSeries = [];
  for (let i = 0; i < allDates.length; i++) {
    if (allDates[i] >= today) break; // exclude the in-progress day (partial)
    let s = 0, n = 0;
    for (let k = Math.max(0, i - 6); k <= i; k++) { const v = cal[allDates[k]]; if (v > 0) { s += v; n++; } }
    if (n) calSeries.push({ date: allDates[i], avg: Math.round(s / n) });
  }
  const cal_avg7 = calSeries.length ? calSeries[calSeries.length - 1].avg : null;
  // weight series over the window + recent slope (lb/week)
  const wIn = (weights || []).filter((p) => p.date >= allDates[0] && p.date <= today && isFinite(p.weight));
  const weight_series = wIn.map((p) => ({ date: p.date, w: p.weight }));
  let weight_slope_wk = null;
  const recent = wIn.slice(-21);
  if (recent.length >= 2) {
    const t0 = new Date(recent[0].date + 'T12:00:00Z').getTime();
    const xs = recent.map((p) => (new Date(p.date + 'T12:00:00Z').getTime() - t0) / 86400000), ys = recent.map((p) => p.weight);
    const n = xs.length, sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0);
    const sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
    const denom = n * sxx - sx * sx;
    if (denom) weight_slope_wk = Math.round(((n * sxy - sx * sy) / denom) * 7 * 10) / 10;
  }
  // Trend-plot curves, from the same per-day maintenance + cluster-aware goal the heatmap uses.
  const firstData = (calSeries[0] && calSeries[0].date) || (weight_series[0] && weight_series[0].date) || today;
  const maint_series = [], goal_series = [];
  for (const ds of allDates) {
    if (ds > today || ds < firstData) continue;
    maint_series.push({ date: ds, v: Math.round(maintFor(ds)) });
    goal_series.push({ date: ds, v: goalForDay(ds) });
  }
  return {
    weeks: cols, months,
    cal_avg7, maintenance: maintenanceEst, goal: goalCal, cal_series: calSeries, weight_series,
    maint_series, goal_series,
    weight_now: wIn.length ? wIn[wIn.length - 1].weight : null, weight_slope_wk,
  };
}

module.exports = { buildNutritionLog, buildGoalResolver, hslToHex, proteinColor, calorieColor, targetCalFor };
