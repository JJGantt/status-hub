'use strict';
// Weekly per-muscle training volume for the gamified workout gauges.
//
// Volume = Σ (set × contribution) over a trailing 7 calendar days, per muscle. Target is a
// uniform 14 effective sets/week (research-honest; no per-muscle spread — see IDEAS), each
// independently adjustable later. We also surface "about to drop off tomorrow": the volume on
// the oldest day in the window, which leaves when the 7-day window slides forward.
//
// Server computes everything (sets, target, fill, drop-off, color); clients only render.

const TARGET_DEFAULT = 14;

const GROUPS = [
  { group: 'Legs', muscles: [['quads', 'Quads'], ['hamstrings', 'Hamstrings'], ['glutes', 'Glutes'], ['gastrocnemius', 'Calves']] },
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
  return hslToHex(120 + (220 - 120) * t, 0.62, 0.55);              // green(120) → blue(220)
}

// setRows: [{occurred_at, exercise, muscles_override}]; muscleRows: [{name, muscle, contribution}];
// window: [oldestDay ... today] date strings (oldest = the day that drops off tomorrow).
function computeVolume(setRows, muscleRows, window, targets) {
  const dropDay = window[0];
  const musByName = new Map();
  for (const m of muscleRows || []) {
    const k = String(m.name).toLowerCase();
    if (!musByName.has(k)) musByName.set(k, []);
    musByName.get(k).push({ muscle: m.muscle, contribution: m.contribution });
  }
  const total = {}, drop = {};
  for (const s of setRows || []) {
    const day = String(s.occurred_at).slice(0, 10);
    const map = s.muscles_override
      ? Object.entries(s.muscles_override).map(([muscle, contribution]) => ({ muscle, contribution }))
      : (musByName.get(String(s.exercise).toLowerCase()) || []);
    for (const mm of map) {
      total[mm.muscle] = (total[mm.muscle] || 0) + mm.contribution;
      if (day === dropDay) drop[mm.muscle] = (drop[mm.muscle] || 0) + mm.contribution;
    }
  }
  const groups = GROUPS.map(g => ({
    group: g.group,
    muscles: g.muscles.map(([slug, label]) => {
      const sets = Math.round((total[slug] || 0) * 10) / 10;
      const dropping = Math.round((drop[slug] || 0) * 10) / 10;
      const target = (targets && targets[slug]) || TARGET_DEFAULT;
      const ratio = target > 0 ? sets / target : 0;
      return {
        muscle: slug, label, sets, dropping, target,
        fill: Math.max(0, Math.min(1, ratio)),                       // total fill vs target (capped)
        stable_fill: target > 0 ? Math.max(0, Math.min(1, (sets - dropping) / target)) : 0, // survives tomorrow
        drop_fill: target > 0 ? Math.min(1, dropping / target) : 0,  // the grayed "expires tomorrow" slice
        color: volColor(ratio),
      };
    }),
  }));
  // Per-muscle color for the body map (each fine SVG region maps to exactly one of these,
  // so no aggregation needed — every muscle shows its own true color).
  const muscle_colors = {};
  for (const g of GROUPS) for (const [slug] of g.muscles) {
    const target = (targets && targets[slug]) || TARGET_DEFAULT;
    muscle_colors[slug] = volColor(target > 0 ? (total[slug] || 0) / target : 0);
  }

  return { target_default: TARGET_DEFAULT, drop_day: dropDay, groups, muscle_colors };
}

module.exports = { computeVolume };
