'use strict';
// Overall weekly score = (Training + Nutrition + Tasks) / 3.
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

//
// TASKS% — the gold band. Starts EMPTY and is earned by completing dated list items; there is no
//   neutral baseline, because a baseline would remove the only incentive the band exists to create,
//   which is putting things on the list in the first place. Completing on time earns full value,
//   completing progressively later earns less and eventually costs, and anything left sitting
//   overdue drains continuously for as long as it sits. Every effect fades linearly to nothing over
//   the same seven days the other two bands look back over, so a hit's SIZE decides how long it is
//   felt — no separate recovery rule.
//
//   Only COMPLETING scores. Deleting an item is worth nothing in either direction — it is a thing he
//   decided not to do, not a thing he failed at — so calling off a whole series costs nothing and
//   needs no special case. The two are different verbs precisely so that neither has to be guessed
//   at from the clock.
//
//   The drain on an open item is UNBOUNDED, deliberately. Ignoring something for a week is not the
//   same as ignoring it for a day, and a floor would say it was. It always has a bounded exit, since
//   completing the item replaces the whole accumulated drain with one floored late completion.

const TARGET = 14;
const W_PRO = 0.35, W_CAL = 0.35, W_FAT = 0.30;     // nutrition macro weights (sum 1); carbs derived, not scored
const PRO_TOL = 50;     // protein: grams BEHIND pace at which the score hits 0 (under only; over is free)
const CAL_TOL = 750;    // calories: kcal off pace (either direction) at which the score hits 0
const FAT_TOL = 25;     // fat: grams off pace (either direction) at which the score hits 0
const EARLY_WEIGHT = 0.5; // ahead-of-pace-but-under-target overage counts at half
const W_TODAY = 0.5;                                 // today's weight within nutrition

// ---- task band tuning. Everything adjustable about the gold band is in this block. ----
const TASK_RATE = 2;          // on-time completions/day that HOLDS the band full once it is there
const TASK_DECAY_DAYS = 7;    // a completion's effect fades linearly to nothing over this
const TASK_GRACE_MIN = 30;    // still "on time" this long past the deadline
const TASK_LATE_ZERO_H = 4;   // lateness at which a completion is worth nothing
const TASK_LATE_FLOOR_H = 24; // lateness at which a completion is worth its full negative
const TASK_DRAIN_FULL_H = 24; // overdue hours per unit of drain — the drain does NOT stop there
const DAY_START_HOUR = 4;     // the display day's 4am origin, shared with lib/dates.js

// With a linear decay a steady R completions/day settles at R·DECAY/2 weighted units, so that is
// what "full" has to mean for the band to be reachable and holdable at the intended rate.
const TASK_FULL_UNITS = TASK_RATE * TASK_DECAY_DAYS / 2;

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

// ---- tasks ----
//
// Naive local wall-clock strings throughout ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM[:SS]'), parsed as if
// UTC so differences are exact wall-clock arithmetic with no DST step. What matters here is how late
// the CLOCK said something was, which is what he experienced.
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
function naive(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
const isTimed = (s) => /T\d/.test(String(s || ''));

// An untimed item is on time any moment before its day ends, so its deadline is the NEXT day's 4am
// origin. A timed one is its own moment. (Untimed items still FIRE at 9am — when it notifies and
// when it is late are different questions about the same value.)
function taskDeadline(occurrence) {
  const at = naive(occurrence);
  if (at == null) return null;
  return isTimed(occurrence) ? at : at + DAY + DAY_START_HOUR * HOUR;
}
// +1 on time, sliding through 0 at LATE_ZERO and down to its floor at LATE_FLOOR.
function completionValue(lateMs) {
  const grace = TASK_GRACE_MIN * MIN, zero = TASK_LATE_ZERO_H * HOUR, floor = TASK_LATE_FLOOR_H * HOUR;
  if (lateMs <= grace) return 1;
  if (lateMs <= zero) return 1 - (lateMs - grace) / (zero - grace);
  if (lateMs >= floor) return -1;
  return -((lateMs - zero) / (floor - zero));
}

/**
 * events:    [{ scheduled_at|due, completed_at, priority }] — items marked DONE. These are ordinary
 *            `list_items` rows carrying a `completed_at`, not a separate ledger: a completed item
 *            persists (it still draws on the calendar), so it is its own record.
 * open:      [{ scheduled_at|due, priority }]               — dated items still outstanding.
 * nowLocal:  naive local wall-clock string.
 */
function tasksScore({ events = [], open = [], nowLocal }) {
  const now = naive(nowLocal);
  if (now == null) return { pct: 0, units: 0, earned: 0, drained: 0, overdue: 0, completed: 0 };
  let earned = 0, drained = 0, completed = 0, overdue = 0;

  for (const e of events) {
    const done = naive(e.completed_at), deadline = taskDeadline(e.scheduled_at || e.due);
    if (done == null || deadline == null) continue;
    const age = now - done;
    if (age > TASK_DECAY_DAYS * DAY) continue;                     // fallen out of the window
    const weight = Math.max(0, 1 - age / (TASK_DECAY_DAYS * DAY));
    earned += weight * completionValue(done - deadline) * (1 + (Number(e.priority) || 0));
    completed++;
  }

  for (const o of open) {
    const deadline = taskDeadline(o.scheduled_at || o.due);
    if (deadline == null) continue;
    const late = now - deadline - TASK_GRACE_MIN * MIN;
    if (late <= 0) continue;                                       // not overdue: costs nothing yet
    // No floor. A thing ignored for a week is not a thing ignored for a day, and clamping would say
    // it was. Dealing with it is always the bounded way out.
    drained += -(late / (TASK_DRAIN_FULL_H * HOUR)) * (1 + (Number(o.priority) || 0));
    overdue++;
  }

  const units = earned + drained;
  return {
    pct: Math.max(0, Math.min(1, units / TASK_FULL_UNITS)),
    units, earned, drained, overdue, completed,
  };
}

function computeScore({ volume, days = [], surplus = 0, taskEvents = [], openTasks = [], nowLocal = null }) {
  const t = trainingScore(volume);
  const n = nutritionScore(days);
  const k = tasksScore({ events: taskEvents, open: openTasks, nowLocal });
  const overall = (t.pct + n.pct + k.pct) / 3;
  return {
    overall: pct(overall),
    tasks: {
      pct: pct(k.pct), units: Math.round(k.units * 100) / 100,
      earned: Math.round(k.earned * 100) / 100, drained: Math.round(k.drained * 100) / 100,
      overdue: k.overdue, completed: k.completed,
    },
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

module.exports = { computeScore, tasksScore, taskDeadline, completionValue };
