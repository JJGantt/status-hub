'use strict';
const { dayBucketOf } = require('./dates');
// Weekly per-muscle training volume for the gamified workout gauges.
//
// Volume = Σ (set × contribution) over a trailing 7 training days (bucketed on the DAY_START_HOUR
// 4am boundary, same as nutrition — so the day rolls over at 4am, not midnight), per muscle. Target is a
// uniform 14 effective sets/week (research-honest; no per-muscle spread — see IDEAS), each
// independently adjustable later. We also surface "about to drop off", in two urgency tiers.
// Because the window is a fixed set of day-buckets that only slides at the 4am rollover, nothing
// drops DURING today — the soonest a bucket can leave is the next rollover. So the tiers are:
//   • drop_tomorrow  — volume on the OLDEST bucket (window[0]); leaves at the next 4am → gone TOMORROW (urgent).
//   • drop_day_after — volume on the 2nd-oldest bucket (window[1]); leaves the rollover after → gone the DAY AFTER.
// Two days of forewarning: a slice escalates from "day after" to "tomorrow" at the 4am rollover
// instead of silently vanishing, so the bar always warns before volume is actually lost.
//
// Server computes everything (sets, target, fill, drop-off, color); clients only render.

const TARGET_DEFAULT = 14;

const GROUPS = [
  { group: 'Legs', muscles: [['quads', 'Quads'], ['hamstrings', 'Hamstrings'], ['glutes', 'Glutes'], ['adductors', 'Adductors'], ['hip_flexors', 'Hip flexors'], ['gastrocnemius', 'Calves']] },
  { group: 'Push', muscles: [['upper_chest', 'Upper chest'], ['lower_chest', 'Lower chest'], ['front_delts', 'Front delts'], ['side_delts', 'Side delts'], ['triceps_long', 'Triceps (long)'], ['triceps_lateral', 'Triceps (lat)']] },
  { group: 'Pull', muscles: [['lats', 'Lats'], ['upper_traps', 'Upper traps'], ['mid_back', 'Mid-back'], ['rear_delts', 'Rear delts'], ['biceps', 'Biceps'], ['forearms', 'Forearms']] },
  { group: 'Core', muscles: [['abs', 'Abs'], ['obliques', 'Obliques'], ['erectors', 'Lower back']] },
];

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
// none → grey; under target → red→green by ratio; at target → green; OVER → green→blue
// (continuous, capped at ~2x target = full blue) so overage is visible, not hidden at "full".
function volColor(ratio) {
  if (ratio <= 0) return hslToHex(0, 0.55, 0.32);                  // dark red = tracked but ZERO this week (a gap)
  if (ratio < 1) return hslToHex(120 * ratio, 0.7, 0.5);            // red(0) → green(120)
  const t = Math.max(0, Math.min(1, ratio - 1));                    // 1x→0, 2x→1 (capped)
  return hslToHex(120 + 110 * t, 0.6, 0.5 - 0.2 * t);              // solid green at target → DARKER blue as it overfills
}

// setRows: [{occurred_at, exercise, muscles_override}]; muscleRows: [{name, muscle, contribution}];
// window: [oldestTrainingDay ... currentTrainingDay] 4am-day strings (oldest = the day that drops at the next 4am).
function computeVolume(setRows, muscleRows, window, targets) {
  const dropDay = window[0];        // oldest bucket — leaves at the next 4am rollover → "drops tomorrow" (urgent)
  const dropDay2 = window[1];       // 2nd-oldest — leaves the rollover after → "drops the day after"
  const musByName = new Map();
  for (const m of muscleRows || []) {
    const k = String(m.name).toLowerCase();
    if (!musByName.has(k)) musByName.set(k, []);
    musByName.get(k).push({ muscle: m.muscle, contribution: m.contribution });
  }
  const total = {}, dropTmrw = {}, dropAfter = {};   // dropTmrw = gone tomorrow; dropAfter = gone the day after
  for (const s of setRows || []) {
    const day = dayBucketOf(s.occurred_at);    // 4am-day bucket, matches the window dates above
    const map = s.muscles_override
      ? Object.entries(s.muscles_override).map(([muscle, contribution]) => ({ muscle, contribution }))
      : (musByName.get(String(s.exercise).toLowerCase()) || []);
    for (const mm of map) {
      total[mm.muscle] = (total[mm.muscle] || 0) + mm.contribution;
      if (day === dropDay) dropTmrw[mm.muscle] = (dropTmrw[mm.muscle] || 0) + mm.contribution;
      else if (day === dropDay2) dropAfter[mm.muscle] = (dropAfter[mm.muscle] || 0) + mm.contribution;
    }
  }
  const groups = GROUPS.map(g => ({
    group: g.group,
    muscles: g.muscles.map(([slug, label]) => {
      const sets = Math.round((total[slug] || 0) * 10) / 10;
      const drop_tomorrow = Math.round((dropTmrw[slug] || 0) * 10) / 10;   // oldest bucket, gone tomorrow (urgent)
      const drop_day_after = Math.round((dropAfter[slug] || 0) * 10) / 10; // 2nd-oldest, gone the day after
      const dropping = Math.round((drop_tomorrow + drop_day_after) * 10) / 10; // combined at-risk volume
      const target = (targets && targets[slug]) || TARGET_DEFAULT;
      const ratio = target > 0 ? sets / target : 0;
      return {
        muscle: slug, label, sets, dropping, drop_tomorrow, drop_day_after, target,
        fill: Math.max(0, Math.min(1, ratio)),                       // total fill vs target (capped)
        stable_fill: target > 0 ? Math.max(0, Math.min(1, (sets - dropping) / target)) : 0, // survives both rollovers
        drop_tomorrow_fill: target > 0 ? Math.min(1, drop_tomorrow / target) : 0,     // urgent (bright stripes)
        drop_day_after_fill: target > 0 ? Math.min(1, drop_day_after / target) : 0,   // soon (faint stripes)
        color: volColor(ratio),
      };
    }),
  }));
  // Per-muscle colors for the (granular vulovix) body map: each region maps to one muscle.
  const muscle_colors = {};
  for (const g of GROUPS) for (const [slug] of g.muscles) {
    const target = (targets && targets[slug]) || TARGET_DEFAULT;
    muscle_colors[slug] = volColor(target > 0 ? (total[slug] || 0) / target : 0);
  }

  // Reverse map: muscle slug → exercises that train it (for the body-map hover/click panel).
  const muscle_exercises = {};
  for (const m of muscleRows || []) {
    const slug = m.muscle;
    if (!slug) continue;
    if (!muscle_exercises[slug]) muscle_exercises[slug] = [];
    if (!muscle_exercises[slug].some(e => e.name === m.name))
      muscle_exercises[slug].push({ name: m.name, contribution: m.contribution });
  }
  for (const slug of Object.keys(muscle_exercises))
    muscle_exercises[slug].sort((a, b) => b.contribution - a.contribution || a.name.localeCompare(b.name));

  // Forward map: exercise name → muscles it trains (for clicking an exercise → highlight its muscles).
  const exercise_muscles = {};
  for (const m of muscleRows || []) {
    if (!m.name || !m.muscle) continue;
    if (!exercise_muscles[m.name]) exercise_muscles[m.name] = [];
    if (!exercise_muscles[m.name].some(e => e.muscle === m.muscle))
      exercise_muscles[m.name].push({ muscle: m.muscle, contribution: m.contribution });
  }
  for (const name of Object.keys(exercise_muscles))
    exercise_muscles[name].sort((a, b) => b.contribution - a.contribution);

  return { target_default: TARGET_DEFAULT, drop_day: dropDay, groups, muscle_colors, muscle_exercises, exercise_muscles };
}

module.exports = { computeVolume };
