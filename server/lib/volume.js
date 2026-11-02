'use strict';

// Weekly per-muscle training volume for the gamified workout gauges.
//
// THE RULE IS NOT HERE. The window (7 training days on the 4am boundary), which muscles a set credits,
// the per-bout cap and the weekly targets are all `muscle_volume()` in Postgres (data-layer 00156), which
// data-layer's get_weekly_volume reads too, so the report and the gauges cannot disagree. This turns its
// answer into the gauges: totals, fills, colours, and the drop-off warning.
//
// We surface "about to drop off", in two urgency tiers. Because the window is a fixed set of day-buckets
// that only slides at the 4am rollover, nothing drops DURING today — the soonest a bucket can leave is
// the next rollover. So the tiers are:
//   • drop_tomorrow  — volume on the OLDEST bucket (window[0]); leaves at the next 4am → gone TOMORROW (urgent).
//   • drop_day_after — volume on the 2nd-oldest bucket (window[1]); leaves the rollover after → gone the DAY AFTER.
// Two days of forewarning: a slice escalates from "day after" to "tomorrow" at the 4am rollover
// instead of silently vanishing, so the bar always warns before volume is actually lost.
//
// Server computes everything (sets, target, fill, drop-off, color); clients only render.

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

// vol: muscle_volume()'s answer ({window, bouts, days, targets}); muscleRows: [{name, muscle, contribution}]
// for the exercise ↔ muscle maps the body-map panel uses.
function computeVolume(vol, muscleRows) {
  const window = (vol && vol.window) || [];
  const targets = (vol && vol.targets) || {};
  const TARGET_DEFAULT = Number(targets._default);
  const targetOf = (slug) => Number(targets[slug] ?? TARGET_DEFAULT);
  const dropDay = window[0];        // oldest bucket — leaves at the next 4am rollover → "drops tomorrow" (urgent)
  const dropDay2 = window[1];       // 2nd-oldest — leaves the rollover after → "drops the day after"
  const total = {}, dropTmrw = {}, dropAfter = {};   // dropTmrw = gone tomorrow; dropAfter = gone the day after
  for (const b of (vol && vol.bouts) || []) {
    const n = Number(b.sets);
    total[b.muscle] = (total[b.muscle] || 0) + n;
    if (b.day === dropDay) dropTmrw[b.muscle] = (dropTmrw[b.muscle] || 0) + n;
    else if (b.day === dropDay2) dropAfter[b.muscle] = (dropAfter[b.muscle] || 0) + n;
  }
  // The "+N" badge = TODAY's credited sets per muscle, uncapped. It persists for the whole day and resets
  // at the 4am rollover. Recovery tint: the most recent day a muscle got any credit — today / yesterday /
  // older, by day bucket rather than a rolling 48h clock.
  const todayBucket = window[window.length - 1];
  const ydayBucket = window.length >= 2 ? window[window.length - 2] : null;
  const todayRaw = {}, ydayRaw = {};
  for (const d of (vol && vol.days) || []) {
    if (d.day === todayBucket) todayRaw[d.muscle] = (todayRaw[d.muscle] || 0) + Number(d.raw);
    else if (d.day === ydayBucket) ydayRaw[d.muscle] = (ydayRaw[d.muscle] || 0) + Number(d.raw);
  }
  const groups = GROUPS.map(g => ({
    group: g.group,
    muscles: g.muscles.map(([slug, label]) => {
      const sets = Math.round((total[slug] || 0) * 10) / 10;
      const drop_tomorrow = Math.round((dropTmrw[slug] || 0) * 10) / 10;   // oldest bucket, gone tomorrow (urgent)
      const drop_day_after = Math.round((dropAfter[slug] || 0) * 10) / 10; // 2nd-oldest, gone the day after
      const target = targetOf(slug);
      const ratio = target > 0 ? sets / target : 0;
      const today = Math.round((todayRaw[slug] || 0) * 10) / 10;   // today's adjusted sets ("+N" badge, persists all day)
      const recency = (todayRaw[slug] || 0) > 0 ? "today"          // last day-bucket this muscle was worked
                    : (ydayRaw[slug] || 0) > 0 ? "yesterday" : "ready";
      // Bar slices are capped BANDS between the muscle's projected fill levels, so an overfilled bar
      // (sets > target) doesn't over-stripe: sets aging out of the OVERAGE above target burn cushion
      // that was never drawn as bar length, so they must not shrink the bar. Each stripe's LEFT edge =
      // exactly where the bar will sit after that rollover (bright starts at tomorrow's level, faint at
      // the day-after level); the three bands sum to the current capped fill, never past 100%.
      const cap = (n) => (target > 0 ? Math.max(0, Math.min(1, n / target)) : 0);
      const lvlNow = cap(sets);                                     // current fill, capped at target
      const lvlTmrw = cap(sets - drop_tomorrow);                    // fill after tomorrow's 4am rollover
      const lvl2day = cap(sets - drop_tomorrow - drop_day_after);   // fill after the rollover after that
      return {
        muscle: slug, label, sets, drop_tomorrow, drop_day_after, target, today, recency,
        fill: lvlNow,                                                // total fill vs target (capped)
        stable_fill: lvl2day,                                        // survives both rollovers
        drop_day_after_fill: lvlTmrw - lvl2day,                      // band: 2-day level → tomorrow level (faint stripes)
        drop_tomorrow_fill: lvlNow - lvlTmrw,                        // band: tomorrow level → now (bright stripes)
        color: volColor(ratio),
      };
    }),
  }));
  // Per-muscle colors for the (granular vulovix) body map: each region maps to one muscle.
  const muscle_colors = {};
  for (const g of GROUPS) for (const [slug] of g.muscles) {
    const target = targetOf(slug);
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
