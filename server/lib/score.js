'use strict';
// Overall weekly score (see session design) = 0.5·Training + 0.5·Nutrition.
//
// TRAINING%  = Σ[ min(s,14) + 0.5·max(0, s−14) ] / (14 · N muscles)
//   over the rolling-week clipped per-muscle sets. Under-target drags 1:1, over rewards at ½, 14
//   everywhere = 100%, all-over > 100% (uncapped — over-training is rewarded).
//
// NUTRITION% — each day scored on its own (deviations never cancel across days), then blended:
//   Day% = 0.40·protein + 0.30·calorie + 0.15·carbs + 0.15·fat
//   All scoring is 1× PROPORTIONAL (gentle — penalty equals your actual deviation, no amplified band):
//     calorie / fat — TWO-SIDED: want to land on target, penalized over AND under, = max(0,1−|a−t|/t)
//     protein / carbs — FLOOR: want to clear the floor, penalized only when UNDER, overage free = min(1,a/floor)
//   The 6 completed days are averaged (unlogged day = 0). TODAY is scored pace-adjusted — each goal is
//   prorated to the eating-window fraction so it reads "on track right now" and climbs live as you log.
//   Nutrition% = 0.5·today + 0.5·past6avg (today weighed as much as the prior six combined).

const TARGET = 14;
const W_PRO = 0.40, W_CAL = 0.30, W_CARB = 0.15, W_FAT = 0.15;   // macro weights within a day (sum 1)
const W_TODAY = 0.5;                            // today's weight within nutrition
const W_TRAIN = 0.5;                            // training's weight in the overall blend

// two-sided (calories, fat): land ON target — 100% at target, falls to 0 at zero or 2× (linear, gentle).
const twoSided = (a, t) => (t > 0 ? Math.max(0, 1 - Math.abs(a - t) / t) : (a <= 0 ? 1 : 0));
// floor (protein, carbs): clear the floor — % of the way to it, capped at 100%; overage is free.
const floorScore = (a, floor) => (floor > 0 ? Math.min(1, a / floor) : 1);
const pct = (x) => Math.round(x * 1000) / 10;

function trainingScore(volume) {
  const muscles = (volume && volume.groups || []).flatMap((g) => g.muscles);
  const points = muscles.reduce((sum, m) => sum + Math.min(m.sets, TARGET) + 0.5 * Math.max(0, m.sets - TARGET), 0);
  const target = TARGET * muscles.length;
  return { pct: target > 0 ? points / target : 0, points: Math.round(points * 10) / 10, target };
}

// days: [{ date, isToday, fraction, cal, protein, carbs, fat, calGoal, proteinFloor, carbFloor, fatTarget }]
function nutritionScore(days) {
  const scored = days.map((d) => {
    const f = d.isToday ? d.fraction : 1;          // today's goals are prorated to the eating-window fraction
    const cal = twoSided(d.cal, d.calGoal * f);
    const pro = floorScore(d.protein, d.proteinFloor * f);
    const carb = floorScore(d.carbs, d.carbFloor * f);
    const fat = twoSided(d.fat, d.fatTarget * f);
    return { ...d, f, calScore: cal, proScore: pro, carbScore: carb, fatScore: fat,
             dayPct: W_PRO * pro + W_CAL * cal + W_CARB * carb + W_FAT * fat };
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

function computeScore({ volume, days = [] }) {
  const t = trainingScore(volume);
  const n = nutritionScore(days);
  const overall = W_TRAIN * t.pct + (1 - W_TRAIN) * n.pct;
  return {
    overall: pct(overall),
    training: { pct: pct(t.pct), points: t.points, target: t.target },
    nutrition: {
      pct: pct(n.pct), today: pct(n.today), past_avg: pct(n.pastAvg),
      days: n.days.map((d) => ({
        date: d.date, is_today: !!d.isToday, day_pct: pct(d.dayPct),
        cal: { actual: Math.round(d.cal), goal: Math.round(d.calGoal * d.f), score: pct(d.calScore) },
        protein: { actual: Math.round(d.protein), floor: Math.round(d.proteinFloor * d.f), score: pct(d.proScore) },
        carbs: { actual: Math.round(d.carbs), floor: Math.round(d.carbFloor * d.f), score: pct(d.carbScore) },
        fat: { actual: Math.round(d.fat), target: Math.round(d.fatTarget * d.f), score: pct(d.fatScore) },
      })),
    },
  };
}

module.exports = { computeScore };
