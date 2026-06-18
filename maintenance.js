'use strict';
// Adaptive maintenance (TDEE) estimate via energy balance:
//
//   maintenance = (avg daily intake) - (weight-trend slope in lb/day) * KCAL_PER_LB
//
// The weight trend already reflects EVERYTHING you burn (BMR + NEAT + lifting + surfing),
// so workout calories are deliberately NOT added — that would double-count. Activity is
// captured by the scale, not estimated.
//
// Both the intake average and the weight slope are exponentially weighted by recency
// (HALF_LIFE_DAYS), so all available history contributes but recent data dominates — no
// hard cutoff window. Until there is enough *fresh* data to resolve the slow lean-bulk
// slope, we fall back to a cold-start anchor instead of reporting a confident-but-fake
// number. The switch is gated on data sufficiency, not a clock.

const KCAL_PER_LB = 3500;        // energy in ~1 lb of body fat; only scales the small slope term
const SURPLUS = 150;             // lean-bulk surplus over maintenance (~0.25 lb/week)
const HALF_LIFE_DAYS = 21;       // older data is down-weighted on this half-life
const ANCHOR_MAINTENANCE = 2500; // cold start: Mar–Apr empirical (~2470) ≈ age-40 Mifflin×1.4 (~2480)

// Data-sufficiency gate (cold-start -> live):
const SPAN_DAYS = 35;            // recent span the gate inspects
const MIN_WEIGHINS = 8;          // distinct weigh-ins needed within the span
const MIN_INTAKE_DAYS = 10;      // distinct completed intake-logged days needed within the span
const MAX_GAP_DAYS = 5;          // newest weigh-in and intake must be at least this fresh

function dayIndex(dateStr, todayStr) {
  const a = Date.parse(dateStr + 'T12:00:00Z');
  const b = Date.parse(todayStr + 'T12:00:00Z');
  return Math.round((a - b) / 86400000); // <= 0 for past dates, 0 = today
}
const recencyWeight = (idx) => Math.pow(2, idx / HALF_LIFE_DAYS); // idx<=0 -> (0,1]

// Recency-weighted least-squares slope of weight vs day-index. Returns lb/day + est. current weight.
function weightedTrend(points, todayStr) {
  if (points.length < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const p of points) {
    const x = dayIndex(p.date, todayStr), w = recencyWeight(x);
    sw += w; swx += w * x; swy += w * p.weight; swxx += w * x * x; swxy += w * x * p.weight;
  }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-9) return null; // all weigh-ins on one day
  const slope = (sw * swxy - swx * swy) / denom;
  const current = (swy - slope * swx) / sw; // intercept at x=0 (today)
  return { slope, current };
}

function weightedAvg(days, todayStr) {
  let sw = 0, swy = 0;
  for (const d of days) {
    const w = recencyWeight(dayIndex(d.date, todayStr));
    sw += w; swy += w * d.calories;
  }
  return sw > 0 ? swy / sw : null;
}

// weights: [{date:'YYYY-MM-DD', weight:Number}]  (full history, any order)
// intakeByDay: [{date:'YYYY-MM-DD', calories:Number}]  (completed days only — caller excludes today)
function estimateMaintenance({ weights = [], intakeByDay = [], today }) {
  const inSpan = (d) => dayIndex(d.date, today) >= -SPAN_DAYS;
  const recentW = weights.filter(inSpan);
  const recentI = intakeByDay.filter(inSpan);
  const daysAgo = (arr) => arr.length ? Math.min(...arr.map((d) => -dayIndex(d.date, today))) : Infinity;
  const lastW = daysAgo(recentW), lastI = daysAgo(recentI);

  const enoughW = recentW.length >= MIN_WEIGHINS && lastW <= MAX_GAP_DAYS;
  const enoughI = recentI.length >= MIN_INTAKE_DAYS && lastI <= MAX_GAP_DAYS;

  let maintenance = null, slope = null, currentWeight = null, source = 'calibrating';
  if (enoughW && enoughI) {
    const tr = weightedTrend(recentW, today);
    const avg = weightedAvg(recentI, today);
    if (tr && avg != null) {
      slope = tr.slope; currentWeight = tr.current;
      // Energy balance: intake - maintenance = stored-energy change (slope*KCAL_PER_LB).
      // So maintenance = intake - slope*KCAL_PER_LB. Gaining (slope>0) => maintenance below intake;
      // losing (slope<0) => the double-negative pushes maintenance above intake.
      maintenance = avg - slope * KCAL_PER_LB;
      source = 'live';
    }
  }
  if (maintenance == null) maintenance = ANCHOR_MAINTENANCE;

  return {
    source,                                   // 'live' | 'calibrating'
    maintenance: Math.round(maintenance),
    target: Math.round((maintenance + SURPLUS) / 10) * 10,
    surplus: SURPLUS,
    trend_lb_per_week: slope != null ? Math.round(slope * 7 * 100) / 100 : null,
    current_weight: currentWeight != null ? Math.round(currentWeight * 10) / 10 : null,
    coverage: {
      weighins: recentW.length, need_weighins: MIN_WEIGHINS,
      intake_days: recentI.length, need_intake_days: MIN_INTAKE_DAYS,
      span_days: SPAN_DAYS,
      last_weighin_days_ago: isFinite(lastW) ? lastW : null,
      last_intake_days_ago: isFinite(lastI) ? lastI : null,
    },
  };
}

module.exports = { estimateMaintenance, ANCHOR_MAINTENANCE, SURPLUS, HALF_LIFE_DAYS, KCAL_PER_LB };
