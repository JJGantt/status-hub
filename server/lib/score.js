'use strict';
// Overall weekly score = 0.5·Training + 0.5·Nutrition.
//
// TRAINING% = Σ[ min(s,14) + 0.5·max(0,s−14) ] / (14·N muscles) over the rolling-week clipped per-muscle
//   sets. Under-target drags 1:1, over rewards at ½, 14 everywhere = 100%, all-over > 100%.
//
// NUTRITION% — three components per day (carbs are DERIVED from calories, so not scored separately):
//   Day% = 0.35·protein + 0.35·calories + 0.30·fat
//     protein  — FLOOR, linear: min(1, actual/floor). Under penalized; overage free. (A low-protein day
//                also pulls calories low → double-penalized, which is the worst case, as intended.)
//     calories — TWO-SIDED, GOAL-AWARE, QUADRATIC. The side that matches the goal direction (over on a
//                bulk, under on a cut) is lenient (wide band); the opposite side is strict (narrow band).
//                Squared so small misses barely register and big ones bite (3× the miss ≈ 9× the penalty).
//     fat      — TWO-SIDED, symmetric, quadratic. Want to land on target; over and under both penalized
//                (we'd rather a calorie overage come from carbs than fat, hence fat is charged separately).
//   Then a CATASTROPHE GATE: if the calorie score is badly low (a big against-goal miss) it multiplies the
//   whole day down, so a blown cut (e.g. 24% over) is a horrible day no matter how good the macros were.
//   The 6 completed days are averaged (unlogged day = 0). TODAY is pace-adjusted (goals prorated to the
//   eating-window fraction so it reads "on track right now"). Nutrition% = 0.5·today + 0.5·past6avg.

const TARGET = 14;
const W_PRO = 0.35, W_CAL = 0.35, W_FAT = 0.30;     // nutrition macro weights (sum 1); carbs derived, not scored
const CAL_LENIENT = 0.40, CAL_STRICT = 0.25;        // calorie quadratic bands: with-goal side vs against-goal side
const FAT_BAND = 0.40;                               // fat quadratic band (both directions)
const CAL_GATE = 0.5;   // catastrophe gate: when the calorie score drops below this (a big against-goal miss)
                        // it multiplicatively tanks the WHOLE day — nailing protein can't rescue a blown cut.
                        // Above it the gate is 1 (no effect), so normal days are untouched.
const W_TODAY = 0.5;                                 // today's weight within nutrition
const W_TRAIN = 0.5;                                 // training's weight in the overall blend

const proteinScore = (a, floor) => (floor > 0 ? Math.min(1, a / floor) : 1);
const quad = (relDev, band) => Math.max(0, 1 - (relDev / band) ** 2);   // quadratic falloff, 0 at dev == band
// Calories: lenient on the side matching the goal (bulk→over, cut→under), strict on the opposite. surplus>0
// bulk, <0 cut, 0 maintenance (symmetric). Quadratic so small misses are gentle and big ones bite.
function calorieScore(a, goal, surplus) {
  if (!(goal > 0)) return a <= 0 ? 1 : 0;
  const over = a > goal;
  const band = surplus > 0 ? (over ? CAL_LENIENT : CAL_STRICT)
             : surplus < 0 ? (over ? CAL_STRICT : CAL_LENIENT)
             : (CAL_LENIENT + CAL_STRICT) / 2;
  return quad(Math.abs(a - goal) / goal, band);
}
const fatScore = (a, t) => (t > 0 ? quad(Math.abs(a - t) / t, FAT_BAND) : (a <= 0 ? 1 : 0));
const pct = (x) => Math.round(x * 1000) / 10;

function trainingScore(volume) {
  const muscles = (volume && volume.groups || []).flatMap((g) => g.muscles);
  const points = muscles.reduce((sum, m) => sum + Math.min(m.sets, TARGET) + 0.5 * Math.max(0, m.sets - TARGET), 0);
  const target = TARGET * muscles.length;
  return { pct: target > 0 ? points / target : 0, points: Math.round(points * 10) / 10, target };
}

// days: [{ date, isToday, fraction, cal, protein, fat, calGoal, proteinFloor, fatTarget }]; surplus signs the goal direction.
function nutritionScore(days, surplus) {
  const scored = days.map((d) => {
    const f = d.isToday ? d.fraction : 1;          // today's goals are prorated to the eating-window fraction
    const cal = calorieScore(d.cal, d.calGoal * f, surplus);
    const pro = proteinScore(d.protein, d.proteinFloor * f);
    const fat = fatScore(d.fat, d.fatTarget * f);
    const base = W_PRO * pro + W_CAL * cal + W_FAT * fat;
    const gate = Math.min(1, cal / CAL_GATE);    // 1 unless calories are catastrophically off → then it tanks the day
    return { ...d, f, calScore: cal, proScore: pro, fatScore: fat, dayPct: base * gate };
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
  const n = nutritionScore(days, surplus);
  const overall = W_TRAIN * t.pct + (1 - W_TRAIN) * n.pct;
  return {
    overall: pct(overall),
    training: { pct: pct(t.pct), points: t.points, target: t.target },
    nutrition: {
      pct: pct(n.pct), today: pct(n.today), past_avg: pct(n.pastAvg), goal_mode: surplus > 0 ? 'surplus' : surplus < 0 ? 'deficit' : 'maintenance',
      days: n.days.map((d) => ({
        date: d.date, is_today: !!d.isToday, day_pct: pct(d.dayPct),
        cal: { actual: Math.round(d.cal), goal: Math.round(d.calGoal * d.f), score: pct(d.calScore) },
        protein: { actual: Math.round(d.protein), floor: Math.round(d.proteinFloor * d.f), score: pct(d.proScore) },
        fat: { actual: Math.round(d.fat), target: Math.round(d.fatTarget * d.f), score: pct(d.fatScore) },
      })),
    },
  };
}

module.exports = { computeScore };
