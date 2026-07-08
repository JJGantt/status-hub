'use strict';
// Adaptive maintenance (TDEE) estimate via energy balance:
//
//   maintenance = (avg daily intake) - (weight-trend slope in lb/day) * kcal-per-lb
//
// The kcal-per-lb energy density is direction-aware: weight LOST is mostly fat (~3500 kcal/lb),
// while weight GAINED on a lean bulk is a blend of muscle, glycogen, water, and some fat
// (~2500 kcal/lb effective). Using 3500 for gains would overcharge each gained pound and
// underestimate maintenance during a bulk.
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

const KCAL_PER_LB_LOSS = 3500;   // energy in ~1 lb lost (mostly body fat); only scales the small slope term
const KCAL_PER_LB_GAIN = 2500;   // effective energy in ~1 lb gained on a lean bulk (muscle/glycogen/water/fat blend)
const SURPLUS = 150;             // lean-bulk surplus over maintenance (~0.25 lb/week)
const HALF_LIFE_DAYS = 21;       // older data is down-weighted on this half-life
const ANCHOR_MAINTENANCE = 2500; // cold start: Mar–Apr empirical (~2470) ≈ age-40 Mifflin×1.4 (~2480)

// Macro rules — protein & fat are anchored to BODYWEIGHT (they scale as you grow), carbs
// absorb the dynamic calorie changes (training fuel — the macro with no physiological anchor).
const PROTEIN_PER_LB = 1.0;    // top of the evidence-based range (Morton 2018); no hypertrophy benefit above this on a bulk
const FAT_PER_LB = 0.4;        // floor in g/lb — comfortably above the hormonal minimum
const FAT_MIN_PCT_CAL = 0.20;  // hard guard: fat never below 20% of calories (hormonal floor)
const FALLBACK_WEIGHT = 171;   // used only if there are zero weigh-ins on record
const roundG = (x) => Math.round(x); // macro grams to the nearest 1 (nearest-5 is too coarse at low fat)

// Under-report / outlier rejection on daily intake totals:
const ABS_FLOOR_CAL = 1000;      // a logged day below this is treated as incomplete, not a real low day
const LOW_K = 2.0;               // drop days below median - LOW_K*sigma (robust, MAD-based)
const HIGH_K = 3.0;              // drop absurd-high days (double-logs) above median + HIGH_K*sigma

// Data-sufficiency gate (cold-start -> live). The analysis window is bookended by WEIGH-INS:
// it runs [first weigh-in .. last weigh-in] of the current continuous intake-logging streak, and
// intake is averaged over [first weigh-in .. last weigh-in - 1]. The one-day offset is the morning
// weigh-in convention: a fasted AM reading on day B reflects intake through day B-1's dinner, and
// the day-A reading is the baseline (intake before A is already baked into it). Weight and calories
// therefore cover the SAME physical period — energy balance is invalid otherwise. Between weigh-ins
// the estimate is FROZEN (recency weights anchor to the window end, not the clock): empirical data
// keeps its authority until new data arrives. There is deliberately NO staleness timeout — an aging
// weigh-in never reverts the estimate to the generic anchor (that would replace a personalized,
// empirically-derived number with a worse one on zero evidence).
const MIN_ALIGNED_DAYS = 14;     // default min length of the aligned window for a live estimate (a hub setting)
const STREAK_MAX_GAP = 3;        // a gap longer than this (days) between logged days breaks the tracking streak
const MIN_WEIGHIN_DAYS = 4;      // distinct weigh-in DAYS needed within the aligned window (same-day reads collapse to 1)
const MIN_INTAKE_DAYS = 10;      // distinct VALID intake-logged days needed within the window

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((p, q) => p - q), n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// Reject under-reported (and absurd-high) days. Returns the kept days + how many were dropped.
function rejectOutliers(days) {
  if (days.length < 4) { // too few to model a distribution — apply only the absolute floor
    const kept = days.filter((d) => d.calories >= ABS_FLOOR_CAL);
    return { kept, excluded: days.length - kept.length };
  }
  const cals = days.map((d) => d.calories);
  const med = median(cals);
  const sigma = 1.4826 * median(cals.map((c) => Math.abs(c - med))); // MAD -> robust sigma
  // sigma==0 (near-identical days) degenerates the band, so fall back to proportional bounds.
  const lo = sigma > 0 ? Math.max(ABS_FLOOR_CAL, med - LOW_K * sigma) : Math.max(ABS_FLOOR_CAL, med * 0.5);
  const hi = sigma > 0 ? med + HIGH_K * sigma : med * 1.75;
  const kept = days.filter((d) => d.calories >= lo && d.calories <= hi);
  return { kept, excluded: days.length - kept.length };
}

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
// Macro targets for a given calorie goal + bodyweight. Protein & fat anchor to bodyweight
// (they scale as you grow); carbs absorb whatever calories remain. Pure function so it can
// derive the goal for the live day OR any historical day (from that day's weight + cal target).
function macroTargets(calories, bodyweight) {
  const bw = bodyweight || FALLBACK_WEIGHT;
  const protein_g = roundG(PROTEIN_PER_LB * bw);
  const fat_g = roundG(Math.max(FAT_PER_LB * bw, (FAT_MIN_PCT_CAL * calories) / 9));
  const carbs_g = Math.max(0, roundG((calories - protein_g * 4 - fat_g * 9) / 4));
  return { protein_g, carbs_g, fat_g };
}

function estimateMaintenance({ weights = [], intakeByDay = [], today, surplus = SURPLUS, minAlignedDays = MIN_ALIGNED_DAYS }) {
  // Collapse same-day weigh-ins to one averaged point (multiple readings in a day must not over-count
  // toward the gate or skew the trend).
  const wByDay = {};
  for (const w of weights) (wByDay[w.date] = wByDay[w.date] || []).push(w.weight);
  const weighDays = Object.entries(wByDay).map(([date, ws]) => ({ date, weight: ws.reduce((a, b) => a + b, 0) / ws.length }));

  // Aligned analysis window, bookended by weigh-ins. B = the most recent weigh-in — the window's END
  // and the recency anchor (NOT today: recomputing between weigh-ins must yield the identical number,
  // so intake logged after B can never move the estimate — that was a feedback loop where accidental
  // surplus raised tomorrow's target with zero weight evidence). Walk the intake-logging streak back
  // from B-1 (gaps <= STREAK_MAX_GAP keep it alive; the streak must also reach to within the same gap
  // of B-1, else intake doesn't cover the period the scale measured). A = the earliest weigh-in inside
  // the streak — the window's START (the day-A morning reading is the baseline; intake before it is
  // already baked in). Weight spans [A..B]; intake spans [A..B-1] (morning-weigh-in convention).
  const B = weighDays.length ? weighDays.map((w) => w.date).sort().pop() : null;
  let t0 = null;
  if (B != null) {
    const loggedDays = [...new Set(intakeByDay.map((d) => d.date))]
      .filter((d) => dayIndex(d, B) < 0).sort();   // strictly before B (intake window ends at B-1)
    if (loggedDays.length && dayIndex(loggedDays[loggedDays.length - 1], B) >= -1 - STREAK_MAX_GAP) {
      t0 = loggedDays[loggedDays.length - 1];
      for (let i = loggedDays.length - 1; i > 0; i--) {
        if (dayIndex(loggedDays[i], B) - dayIndex(loggedDays[i - 1], B) <= STREAK_MAX_GAP) t0 = loggedDays[i - 1];
        else break;
      }
    }
  }
  const winWAll = t0 != null ? weighDays.filter((w) => dayIndex(w.date, B) <= 0 && dayIndex(w.date, t0) >= 0) : [];
  const A = winWAll.length ? winWAll.map((w) => w.date).sort()[0] : null;
  const winW = A != null ? winWAll.filter((w) => dayIndex(w.date, A) >= 0) : [];
  const { kept: winI, excluded: intakeExcluded } = rejectOutliers(
    A != null ? intakeByDay.filter((d) => dayIndex(d.date, A) >= 0 && dayIndex(d.date, B) < 0) : []);

  const windowLen = A != null ? -dayIndex(A, B) : 0;                  // days from A to B
  // Live requires: a window long enough for a trustworthy slope, enough weigh-in days, enough valid
  // intake. NO freshness-vs-today gate — the estimate stays live on the last aligned window until a
  // new weigh-in extends it (empirical beats the generic anchor at any age).
  const enoughWindow = windowLen >= minAlignedDays;
  const enoughW = winW.length >= MIN_WEIGHIN_DAYS;
  const enoughI = winI.length >= MIN_INTAKE_DAYS;

  let maintenance = null, slope = null, currentWeight = null, source = 'calibrating';
  if (enoughWindow && enoughW && enoughI) {
    const tr = weightedTrend(winW, B);   // recency anchored at B → frozen between weigh-ins
    const avg = weightedAvg(winI, B);
    if (tr && avg != null) {
      slope = tr.slope; currentWeight = tr.current;   // trend intercept = weight at B
      // Energy balance: intake - maintenance = stored-energy change (slope * kcal-per-lb).
      // So maintenance = intake - slope*kcalPerLb. Gaining (slope>0) => maintenance below intake;
      // losing (slope<0) => the double-negative pushes maintenance above intake.
      // Direction-aware density: losses burn mostly fat (3500); gains store mixed tissue (2500).
      const kcalPerLb = slope > 0 ? KCAL_PER_LB_GAIN : KCAL_PER_LB_LOSS;
      maintenance = avg - slope * kcalPerLb;
      source = 'live';
    }
  }
  if (maintenance == null) maintenance = ANCHOR_MAINTENANCE;

  // Dynamic goal: calories track maintenance + surplus. Protein/fat scale with measured
  // bodyweight (latest weigh-in, or the trend's current-weight estimate when live); carbs flex.
  const sortedW = [...weighDays].sort((a, b) => (a.date < b.date ? -1 : 1));
  const bodyweight = (currentWeight != null ? currentWeight
    : (sortedW.length ? sortedW[sortedW.length - 1].weight : null)) || FALLBACK_WEIGHT;
  const calories = Math.round((maintenance + surplus) / 10) * 10;
  const { protein_g, carbs_g, fat_g } = macroTargets(calories, bodyweight);

  return {
    source,                                   // 'live' | 'calibrating'
    maintenance: Math.round(maintenance),
    target: calories,
    target_macros: { calories, protein_g, carbs_g, fat_g },
    surplus,
    trend_lb_per_week: slope != null ? Math.round(slope * 7 * 100) / 100 : null,
    current_weight: currentWeight != null ? Math.round(currentWeight * 10) / 10 : null,
    window_start: A,
    window_end: B,
    coverage: {
      window_days: windowLen, need_window_days: minAlignedDays,
      weighin_days: winW.length, need_weighin_days: MIN_WEIGHIN_DAYS,
      intake_days: winI.length, need_intake_days: MIN_INTAKE_DAYS,
      intake_days_excluded: intakeExcluded,
      // informational only (relative to the request clock) — freshness never gates the estimate
      last_weighin_days_ago: B != null ? -dayIndex(B, today) : null,
      last_intake_days_ago: (() => { const ds = intakeByDay.filter((d) => dayIndex(d.date, today) <= 0); return ds.length ? Math.min(...ds.map((d) => -dayIndex(d.date, today))) : null; })(),
    },
  };
}

module.exports = { estimateMaintenance, macroTargets, ANCHOR_MAINTENANCE, SURPLUS, HALF_LIFE_DAYS, KCAL_PER_LB_LOSS, KCAL_PER_LB_GAIN, MIN_ALIGNED_DAYS };
