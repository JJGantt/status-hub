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
// ONE WINDOW, BOTH TERMS. The equation above is an identity over a PERIOD:
//
//   (mean intake - maintenance) * N  =  weight change over those same N days * kcal-per-lb
//
// so solving it for maintenance is only valid if both sides describe the same days. This used to
// exponentially weight each side by recency (21-day half-life) instead of windowing them, which
// looked symmetric but wasn't: a weighted MEAN is driven by where the weight sits (its centre of
// mass landed ~12 days back), while a weighted regression SLOPE is driven by where the LEVERAGE
// sits — distance from centre, squared, so out at the edges (~17.5 days back, measuring across a
// 29-day span). Same half-life in both places, two different periods, and the algebra silently
// stopped holding. Worst at a bulk<->cut flip, where the two periods stop overlapping at all.
//
// So: a fixed WINDOW_DAYS window, no weighting inside it. The window IS the recency control, and
// once you have one, weighting is not merely unnecessary but wrong — any weighting of the intake
// mean would have to be mirrored on the weight side, and a change between two endpoints has no
// middle to weight. Every day in the window counts equally because that is what happened: a
// calorie eaten 18 days ago moved the measured weight change exactly as much as one eaten
// yesterday.
//
// Window length is not a free choice either. Endpoint noise (~1.1 lb SD per weigh-in) does NOT
// shrink with a longer window — it is always two endpoints — while the signal grows linearly, so
// short windows are all noise: at 7 days the smallest rate distinguishable from zero is ~1.6
// lb/wk, which cannot tell "holding" from "gaining a pound a week". Push the other way and real
// TDEE drift (BMR rises ~10 kcal/day per pound gained) turns a long window into an average of a
// moving target. Those two cross around 3-4 weeks.
//
// Until there is enough data to fill a window, we fall back to a cold-start anchor instead of
// reporting a confident-but-fake number. The switch is gated on data sufficiency, not a clock.

const KCAL_PER_LB_LOSS = 3500;   // energy in ~1 lb lost (mostly body fat); only scales the small slope term
const KCAL_PER_LB_GAIN = 2500;   // effective energy in ~1 lb gained on a lean bulk (muscle/glycogen/water/fat blend)
const SURPLUS = 150;             // lean-bulk surplus over maintenance (~0.25 lb/week)
const WINDOW_DAYS = 21;          // analysis window, both terms (see the note above on why 3-4 weeks)
const LEVEL_HALF_DAYS = 3;       // an endpoint "level" averages every weigh-in within +/- this many days
const ANCHOR_MAINTENANCE = 2500; // cold start: Mar–Apr empirical (~2470) ≈ age-40 Mifflin×1.4 (~2480)

// Macro rules — protein & fat are anchored to BODYWEIGHT (they scale as you grow), carbs
// absorb the dynamic calorie changes (training fuel — the macro with no physiological anchor).
const PROTEIN_PER_LB = 1.0;    // top of the evidence-based range (Morton 2018); no hypertrophy benefit above this on a bulk
const FAT_PER_LB = 0.4;        // floor in g/lb — comfortably above the hormonal minimum
const FAT_MIN_PCT_CAL = 0.20;  // hard guard: fat never below 20% of calories (hormonal floor)
const FALLBACK_WEIGHT = 171;   // used only if there are zero weigh-ins on record
const roundG = (x) => Math.round(x); // macro grams to the nearest 1 (nearest-5 is too coarse at low fat)

// NOTE: there is deliberately NO automatic outlier/under-report rejection on daily intake. Every day
// that has logged entries is real data and counts toward the intake average. Rejecting a day and
// re-averaging the rest silently imputes the mean for it, which corrupts the energy balance (the weight
// trend already reflects that day's calories). Genuinely unlogged days are absent by construction (no
// rows → no entry); an incompletely-logged day can only be excluded MANUALLY (it's indistinguishable
// from a real light day by calories alone).

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
const MIN_LEVEL_READS = 2;       // weigh-ins each ENDPOINT level must average; one reading is a coin flip, not a level
const MIN_INTAKE_DAYS = 10;      // distinct intake-logged days needed within the window

function dayIndex(dateStr, todayStr) {
  const a = Date.parse(dateStr + 'T12:00:00Z');
  const b = Date.parse(todayStr + 'T12:00:00Z');
  return Math.round((a - b) / 86400000); // <= 0 for past dates, 0 = today
}

// 'YYYY-MM-DD' shifted by n days, staying in the same date-only space as dayIndex.
function addDaysStr(dateStr, n) {
  const t = Date.parse(dateStr + 'T12:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// The weight LEVEL on a given day: the mean of every weigh-in within +/- LEVEL_HALF_DAYS of it.
// A single reading carries ~1.1 lb of water/gut noise, which would swamp the few pounds a real
// window is trying to measure, so neither endpoint is ever one number off the scale. Averaging
// around a date is not recency weighting — it is how you turn a coin flip into a measurement.
//
// Peeking a few days either side of the window's start is deliberate and safe: this estimates the
// level AT that boundary, and weight is continuous across a phase flip even though the slope isn't.
// Widens if a sparse stretch of weigh-ins leaves the boundary short of MIN_LEVEL_READS: a slightly
// blurrier endpoint still beats dropping the whole estimate back to the cold-start anchor, which is
// what a hard +/-3 would do after any week you didn't step on the scale much. `half` is reported so
// callers can see how blurred it had to get.
function levelAt(weighDays, dateStr) {
  for (const half of [LEVEL_HALF_DAYS, 5, 7]) {
    const near = weighDays.filter((w) => Math.abs(dayIndex(w.date, dateStr)) <= half);
    if (near.length >= MIN_LEVEL_READS) {
      return { weight: near.reduce((s, w) => s + w.weight, 0) / near.length, n: near.length, half };
    }
  }
  return null;
}

// Plain arithmetic mean — every logged day in the window counts the same. See the header.
function plainAvg(days) {
  if (!days.length) return null;
  return days.reduce((s, d) => s + d.calories, 0) / days.length;
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

// phase (optional): { start:'YYYY-MM-DD', seed:Number|null, hold:Bool } — the current goal phase. A phase
// begins when the goal (surplus_cal) flips sign (bulk↔cut); its start caps the analysis window so the
// opposite-regime tail isn't averaged into the trend, and `seed` holds the robust maintenance measured up
// to the flip until the new phase has its own trustworthy data (TDEE doesn't jump at a goal change).
function estimateMaintenance({ weights = [], intakeByDay = [], today, surplus = SURPLUS, minAlignedDays = MIN_ALIGNED_DAYS, phase = null, _viz = true }) {
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
  // Phase boundary: cap the window at the current phase's start so a cut→bulk (or bulk→cut) regime
  // change isn't averaged into the current trend. Only applies when the phase began on/before `today`,
  // so the per-day history replay (which passes NO phase) is never retroactively changed — past goals
  // stay frozen, not backfilled.
  const phaseActive = phase && phase.start && Date.parse(phase.start) <= Date.parse(today);
  if (phaseActive && t0 != null && phase.start > t0) t0 = phase.start;
  // Cap the window at WINDOW_DAYS. The streak may reach back months; beyond ~4 weeks the estimate
  // is averaging a TDEE that has genuinely moved (see the header), so take the most recent slice.
  if (t0 != null) {
    const capStart = addDaysStr(B, -WINDOW_DAYS);
    if (capStart > t0) t0 = capStart;
  }
  // A is the window's START DATE, not the first weigh-in inside it: levelAt() estimates the weight
  // on whatever date you hand it, so the boundary no longer has to land on a weigh-in day. That
  // also makes the window exactly WINDOW_DAYS long whenever the data allows, which is what keeps
  // it congruent with the intake mean taken over the same span.
  const A = t0;
  const winW = A != null ? weighDays.filter((w) => dayIndex(w.date, B) <= 0 && dayIndex(w.date, A) >= 0) : [];
  // Every logged day in the aligned window counts — no outlier rejection (see the note at the top).
  const winI = A != null ? intakeByDay.filter((d) => dayIndex(d.date, A) >= 0 && dayIndex(d.date, B) < 0) : [];

  const windowLen = A != null ? -dayIndex(A, B) : 0;                  // days from A to B
  // Live requires: a window long enough for a trustworthy slope, enough weigh-in days, enough valid
  // intake. NO freshness-vs-today gate — the estimate stays live on the last aligned window until a
  // new weigh-in extends it (empirical beats the generic anchor at any age).
  const enoughWindow = windowLen >= minAlignedDays;
  const enoughW = winW.length >= MIN_WEIGHIN_DAYS;
  const enoughI = winI.length >= MIN_INTAKE_DAYS;

  let maintenance = null, slope = null, currentWeight = null, source = 'calibrating', avgIntake = null;
  if (enoughWindow && enoughW && enoughI) {
    // Both terms over [A..B] and nothing else. The rate is level-to-level across the window, so it
    // answers "how much weight did these exact days add", which is the only question the intake
    // mean over those same days can be divided by.
    const lvlA = levelAt(weighDays, A);
    const lvlB = levelAt(weighDays, B);
    const avg = plainAvg(winI);
    const solidEnds = lvlA && lvlB && lvlA.n >= MIN_LEVEL_READS && lvlB.n >= MIN_LEVEL_READS;
    if (solidEnds && avg != null) {
      avgIntake = avg;
      currentWeight = lvlB.weight;                      // the level at B, not one morning's reading
      slope = (lvlB.weight - lvlA.weight) / windowLen;   // lb/day across the window
      // Energy balance: intake - maintenance = stored-energy change (slope * kcal-per-lb).
      // So maintenance = intake - slope*kcalPerLb. Gaining (slope>0) => maintenance below intake;
      // losing (slope<0) => the double-negative pushes maintenance above intake.
      // Direction-aware density: losses burn mostly fat (3500); gains store mixed tissue (2500).
      const kcalPerLb = slope > 0 ? KCAL_PER_LB_GAIN : KCAL_PER_LB_LOSS;
      maintenance = avg - slope * kcalPerLb;
      source = 'live';
    }
  }
  // Seed & hold across a phase flip: TDEE doesn't jump when the goal sign changes, so until the new
  // phase has its own trustworthy in-phase data, hold the robust maintenance measured up to the flip
  // (the seed) rather than reverting to the generic anchor. `hold` forces the seed even past the data
  // gate — used to ride out the post-cut water/glycogen bounce, which transiently depresses the
  // energy-balance estimate. The trend + current-weight (viz) still come from the in-phase window above.
  if (phaseActive && phase.seed != null && (phase.hold || source !== 'live')) {
    maintenance = phase.seed;
    source = 'seeded';
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
    avg_intake: avgIntake != null ? Math.round(avgIntake) : null,
    // Per-day detail for the "what is this number based on" visualization (phone-wall maintenance pane).
    // Everything the chart draws, straight from the estimator's own intermediates — never recomputed
    // client-side, so the display can't drift from the calc. Ships ALL weigh-ins and logged days (not
    // just the current window) so the client can page back through history; `kept` is the outlier flag
    // within the current window, null outside it. Skipped for the per-day history replay (_viz=false).
    viz: (!_viz || B == null) ? null : {
      // `inwin` replaced a per-point recency weight when the estimator stopped having one. A point
      // is now simply in the window or out of it, and the chart says so rather than implying a
      // gradient that no longer exists.
      weighins: weighDays.map((w) => ({ date: w.date, weight: w.weight,
                                        inwin: A != null && w.date >= A && w.date <= B })),
      intake: intakeByDay.filter((d) => dayIndex(d.date, today) <= 0)
        .map((d) => ({ date: d.date, calories: d.calories,
                       kept: winI.includes(d) ? true : null })),   // in the current aligned window?
      slope_lb_day: slope,
      weight_at_end: currentWeight != null ? Math.round(currentWeight * 10) / 10 : null,
    },
    coverage: {
      window_days: windowLen, need_window_days: minAlignedDays,
      weighin_days: winW.length, need_weighin_days: MIN_WEIGHIN_DAYS,
      intake_days: winI.length, need_intake_days: MIN_INTAKE_DAYS,
      // informational only (relative to the request clock) — freshness never gates the estimate
      last_weighin_days_ago: B != null ? -dayIndex(B, today) : null,
      last_intake_days_ago: (() => { const ds = intakeByDay.filter((d) => dayIndex(d.date, today) <= 0); return ds.length ? Math.min(...ds.map((d) => -dayIndex(d.date, today))) : null; })(),
    },
  };
}

// Per-day history replay: what the estimator says AS-OF each day (weights ≤ D, intake < D), from the
// first weigh-in to today. This is the source for the historical avg/maintenance/target curves in the
// viz pane — computed by the same code as the live number, so the curves step exactly where weigh-ins
// land and hold flat between them (the freeze made visible). Days before the first valid window yield
// nulls (calibrating), which the client renders as gaps.
function estimateHistory({ weights = [], intakeByDay = [], today, surplus = SURPLUS, minAlignedDays = MIN_ALIGNED_DAYS }) {
  if (!weights.length) return [];
  const first = weights.map((w) => w.date).sort()[0];
  const out = [];
  for (let t = Date.parse(first + 'T12:00:00Z'); ; t += 86400000) {
    const D = new Date(t).toISOString().slice(0, 10);
    if (dayIndex(D, today) > 0) break;
    const e = estimateMaintenance({
      weights: weights.filter((w) => w.date <= D),
      intakeByDay: intakeByDay.filter((d) => d.date < D),
      today: D, surplus, minAlignedDays, _viz: false,
    });
    out.push(e.source === 'live'
      ? { date: D, avg: e.avg_intake, maintenance: e.maintenance, target: e.target }
      : { date: D, avg: null, maintenance: null, target: null });
  }
  return out;
}

module.exports = { estimateMaintenance, estimateHistory, macroTargets, ANCHOR_MAINTENANCE, SURPLUS, WINDOW_DAYS, KCAL_PER_LB_LOSS, KCAL_PER_LB_GAIN, MIN_ALIGNED_DAYS };
