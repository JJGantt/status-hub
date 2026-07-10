'use strict';
// Overall weekly score = 0.5·Training + 0.5·Nutrition.
//
// TRAINING% = Σ[ min(s,14) + 0.5·max(0,s−14) ] / (14·N muscles) over the rolling-week clipped per-muscle
//   sets. Under-target drags 1:1, over rewards at ½, 14 everywhere = 100%, all-over > 100%.
//
// NUTRITION% — three components per day (carbs are DERIVED from calories, so not scored separately):
//   Day% = 0.35·protein + 0.35·calories + 0.30·fat        (no gate — a single bad macro just costs its
//          own weight; multiple bad macros compound naturally through the weighted sum.)
//   Every macro is scored on the ABSOLUTE gap from PACE (target prorated to the eating-window fraction),
//   NOT the proportional gap. Being 10g/200kcal off pace is the same hit at any time of day — the gram/
//   kcal deficit is what's scored, not deficit÷target. Each is a quadratic falloff to 0 at a fixed
//   absolute tolerance (small misses barely register, big ones bite). Because pace is small early, the
//   absolute gap you can have early is small too, so an unfinished morning never craters to 0.
//     protein  — FLOOR: only being UNDER pace is penalized (overage free). 0 at 50g behind pace.
//     calories — TWO-SIDED. 0 at 750 kcal off pace. (No goal-aware asymmetry: the calorie goal already
//                sitting above maintenance accounts for that.)
//     fat      — TWO-SIDED. 0 at 25g off pace.
//   The two-sided overage is split at the DAY TARGET, because front-loading is not overshooting: the
//   part that merely runs ahead of pace while still under the day's target counts at EARLY_WEIGHT, and
//   only the part past the target costs full. Behind pace always costs full. No today/past branch is
//   needed — a completed day has fraction=1, so pace == target, the early part is 0, and the split
//   collapses back to a plain symmetric deviation.
//   Past completed days use the full target as pace (fraction = 1); an unlogged day = 0. TODAY's pace is
//   prorated to the elapsed eating-window fraction. Nutrition% = 0.5·today + 0.5·past6avg.

const TARGET = 14;
const W_PRO = 0.35, W_CAL = 0.35, W_FAT = 0.30;     // nutrition macro weights (sum 1); carbs derived, not scored
const PRO_TOL = 50;     // protein: grams BEHIND pace at which the score hits 0 (under only; over is free)
const CAL_TOL = 750;    // calories: kcal off pace (either direction) at which the score hits 0
const FAT_TOL = 25;     // fat: grams off pace (either direction) at which the score hits 0
const EARLY_WEIGHT = 0.5; // ahead-of-pace-but-under-target overage counts at half
const W_TODAY = 0.5;                                 // today's weight within nutrition
const W_TRAIN = 0.5;                                 // training's weight in the overall blend

// Quadratic falloff on an ABSOLUTE deviation: 1 at dev 0, 0 once |dev| >= tol. Small misses barely
// register; big ones bite (3× the deviation ≈ 9× the penalty).
const quadAbs = (dev, tol) => (tol > 0 ? Math.max(0, 1 - (dev / tol) ** 2) : (dev <= 0 ? 1 : 0));

// Protein is a floor: only a shortfall vs pace costs anything; being at/over pace scores 1.
const proteinScore = (actual, pace) => quadAbs(Math.max(0, pace - actual), PRO_TOL);
// Two-sided deviation, discounted for front-loading. Behind pace costs full. Ahead of pace splits at
// the day target: the under-target part is only early (EARLY_WEIGHT), the part past target costs full.
function twoSidedDev(actual, pace, target) {
  if (actual <= pace) return pace - actual;
  const excess = Math.max(0, actual - target);       // genuinely overshot the day
  const early = actual - pace - excess;              // merely ahead of schedule
  return EARLY_WEIGHT * early + excess;
}
const calorieScore = (actual, pace, target) => quadAbs(twoSidedDev(actual, pace, target), CAL_TOL);
const fatScore = (actual, pace, target) => quadAbs(twoSidedDev(actual, pace, target), FAT_TOL);
const pct = (x) => Math.round(x * 1000) / 10;

function trainingScore(volume) {
  const muscles = (volume && volume.groups || []).flatMap((g) => g.muscles);
  const points = muscles.reduce((sum, m) => sum + Math.min(m.sets, TARGET) + 0.5 * Math.max(0, m.sets - TARGET), 0);
  const target = TARGET * muscles.length;
  return { pct: target > 0 ? points / target : 0, points: Math.round(points * 10) / 10, target };
}

// days: [{ date, isToday, fraction, cal, protein, fat, calGoal, proteinFloor, fatTarget }].
function nutritionScore(days) {
  const scored = days.map((d) => {
    const f = d.isToday ? d.fraction : 1;          // today's pace is prorated to the elapsed window fraction
    const calPace = d.calGoal * f, proPace = d.proteinFloor * f, fatPace = d.fatTarget * f;
    const cal = calorieScore(d.cal, calPace, d.calGoal);
    const pro = proteinScore(d.protein, proPace);
    const fat = fatScore(d.fat, fatPace, d.fatTarget);
    const dayPct = W_PRO * pro + W_CAL * cal + W_FAT * fat;
    return { ...d, f, calPace, proPace, fatPace, calScore: cal, proScore: pro, fatScore: fat, dayPct };
  });
  const todayEntry = scored.find((d) => d.isToday);
  const past = scored.filter((d) => !d.isToday);
  const pastAvg = past.length ? past.reduce((s, d) => s + d.dayPct, 0) / past.length : 0;
  const todayPct = todayEntry ? todayEntry.dayPct : pastAvg;
  let p;
  if (todayEntry && past.length) p = W_TODAY * todayPct + (1 - W_TODAY) * pastAvg;
  else if (todayEntry) p = todayPct;
  else p = pastAvg;
  return { pct: p, today: todayPct, pastAvg, days: scored };
}

function computeScore({ volume, days = [], surplus = 0 }) {
  const t = trainingScore(volume);
  const n = nutritionScore(days);
  const overall = W_TRAIN * t.pct + (1 - W_TRAIN) * n.pct;
  return {
    overall: pct(overall),
    training: { pct: pct(t.pct), points: t.points, target: t.target },
    nutrition: {
      pct: pct(n.pct), today: pct(n.today), past_avg: pct(n.pastAvg),
      goal_mode: surplus > 0 ? 'surplus' : surplus < 0 ? 'deficit' : 'maintenance',
      days: n.days.map((d) => ({
        date: d.date, is_today: !!d.isToday, day_pct: pct(d.dayPct),
        cal: { actual: Math.round(d.cal), goal: Math.round(d.calPace), score: pct(d.calScore) },
        protein: { actual: Math.round(d.protein), floor: Math.round(d.proPace), score: pct(d.proScore) },
        fat: { actual: Math.round(d.fat), target: Math.round(d.fatPace), score: pct(d.fatScore) },
      })),
    },
  };
}

module.exports = { computeScore };
