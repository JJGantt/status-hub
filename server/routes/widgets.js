'use strict';
const pace = require('../lib/pace');

module.exports = function (ctx) {
  const {
    WORKOUTDAY_BACKSTOP_MS, gated, nutritionCore, paceOf, sbRange, scoreOf, timed, trainingCore,
    workoutDayCache,
  } = ctx;

  // Compact feed for the iOS home/lock-screen widget and the watch's rings: the pace rings and the
  // health bar under them, built from those pieces alone — not the dashboard.
  // Per-minute frames put it around 37KB, once an hour — the frames dominate, and the alternative
  // (coarser steps) is what made the centre number look stuck.
  gated.get('/api/rings', timed(async (req, res) => {
    try {
      const [core, train] = await Promise.all([nutritionCore(), trainingCore()]);
      const P = paceOf(core).paceData;
      const m = P.macros || {};
      const KEYS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];
      const consumed = {}, goal = {}, staged = {};
      for (const k of KEYS) { consumed[k] = m[k]?.consumed ?? 0; goal[k] = m[k]?.goal ?? 0; staged[k] = m[k]?.staged ?? 0; }

      // A widget renders a STATIC snapshot — it can't tick a clock the way the hub card does. So the
      // server returns a series of future frames and WidgetKit steps through them on schedule. The
      // pace arcs drain and the marker advances without another network call, and, more importantly,
      // the pace maths stays here in lib/pace.js instead of being re-implemented in Swift where the
      // two copies would quietly drift apart.
      // Span is a straight trade: longer means the arcs keep moving without spending WidgetKit refresh
      // budget, but the CONSUMED figures stay frozen at fetch time for that whole window. 4 hours made
      // it look live while showing hours-old numbers. An hour keeps the movement and bounds how stale
      // the data can get on its own; the app also forces a reload whenever the data changes.
      //
      // STEP is what the deviation NUMBER moves on, and it was the visible flaw at 10 minutes: the
      // pace line advances goal/window per minute — about 3 cal/min — so the centre figure sat up to
      // ~31 cal behind the truth and read as stuck. On the arcs a tenth of a step is invisible; on a
      // number it isn't. Per-minute frames make it track continuously. WidgetKit pre-renders the whole
      // timeline and swaps entries at their dates, so 61 frames cost one fetch, not 61.
      const STEP_MIN = 1, SPAN_MIN = 60;
      const frames = [];
      for (let t = 0; t <= SPAN_MIN; t += STEP_MIN) {
        const f = pace.computePace({ consumed, goal, staged, window: P.window, nowOff: (P.nowOff ?? 0) + t });
        const macros = {};
        for (const k of KEYS) {
          const x = f.macros[k];
          macros[k] = {
            consumed: x.consumed, goal: x.goal, dev_g: x.dev_g,
            ring_base: x.ring_base, ring_over: x.ring_over,
            base_color: x.base_color, over_color: x.over_color,
            staged_mark: x.staged_mark,
            // Matches the card's own rule for the number under the glyph (cards/nutrition.js tickRings).
            dev_color: x.dev_g < 0 ? '#f87171' : x.dev_g > 0 ? (x.over_color || '#22c55e') : '#22c55e',
          };
        }
        frames.push({ t, frac: f.frac, macros });
      }
      // The health bar that sits with the rings on the wall (cards/score.js): one gauge split three
      // ways — nutrition, training, tasks — since overall = (n + t + k)/3, so each can fill at most a
      // third and together they reach the overall figure. Sent as the already-divided fills the bar
      // draws, rather than raw percentages, so the widget doesn't re-derive the weighting and drift
      // from the wall.
      const sc = await scoreOf(core, P, train);
      const third = (v) => Math.max(0, Math.min(100 / 3, (Number(v) || 0) / 3));
      res.json({
        step_min: STEP_MIN,
        // Constant for the day, so it rides once on the response rather than on all 61 frames.
        window_hours: P.window_hours, per_hour: P.per_hour,
        score: { nutrition: third(sc.nutrition?.pct), training: third(sc.training?.pct),
                 tasks: third(sc.tasks?.pct),
                 overall: Math.max(0, Math.min(100, Number(sc.overall) || 0)) },
        frames,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  }));

  async function workoutDay(date) {
      const hit = workoutDayCache.get(date);
      if (hit && Date.now() - hit.at < WORKOUTDAY_BACKSTOP_MS) return hit.body;
      const rows = await sbRange(`sets?occurred_at=gte.${date}T00:00:00&occurred_at=lte.${date}T23:59:59&select=id,occurred_at,exercise,weight_lbs,reps&order=occurred_at`);
      const order = [], byEx = {}, lastAt = {};
      for (const r of rows) {
        if (!byEx[r.exercise]) { byEx[r.exercise] = []; order.push(r.exercise); }
        byEx[r.exercise].push({ id: r.id, weight_lbs: r.weight_lbs, reps: r.reps });
        lastAt[r.exercise] = r.occurred_at;   // rows are in time order, so this ends on the exercise's last set
      }
      // Which exercise was logged LAST, by the clock — not the group that appears last, which is the
      // one whose FIRST set came latest. Going back to an earlier exercise for another set has to move
      // this, or the wall shows the wrong grouping for the set that just happened.
      const recent = rows.length ? rows[rows.length - 1].exercise : null;
      // NEWEST EXERCISE FIRST, like the food log's entries. `order` is the sequence each exercise was
      // FIRST logged in, which puts the thing he just did at the bottom of a scrolling list — the one
      // place he is least likely to look for it while he is still training. Sorted by the exercise's
      // LAST set, so going back to an earlier movement for another set moves it up, which is the same
      // rule `recent` above follows. Sets inside an exercise stay in the order they were done.
      const body = { date, total: rows.length, recent,
        exercises: order.map((n) => ({ name: n, sets: byEx[n], last_at: lastAt[n] }))
          .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))) };
      workoutDayCache.set(date, { body, at: Date.now() });
      return body;
  }
  gated.get('/api/workout-day', async (req, res) => {
    try {
      const date = String(req.query.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
      res.json(await workoutDay(date));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Compact feed for the watch's workout page: the inputs to the home wall's rest/session clocks and set
  // tally, and EVERY exercise logged today, each with its muscles' WEEKLY sets in that muscle's volume
  // colour (the wall's `data-recent` row, muscle.js exerciseVolumeChips). Newest first by each
  // exercise's last set, so the one a set just went onto is at the top and the rest scroll below it.
  // The watch draws the body-map artwork itself (its paths are compiled into the app from lib/bodymap.js),
  // so all it needs from here is a colour per region. Only regions that carry one are sent — everything
  // else draws in the artwork's base fill — and the region-to-muscle mapping is the shared one, so a
  // region is the same colour on the wrist as on the wall.
  const BODY_REGIONS = [...require('../lib/bodymap.js').matchAll(/data-r="([^"]+)"/g)].map((m) => m[1]);
  const { muscleForId } = require('../lib/musclemap');
  function bodyColours(muscleColours) {
    const out = {};
    for (const id of BODY_REGIONS) {
      const c = (muscleColours || {})[muscleForId(id)];
      if (c) out[id] = c;
    }
    return out;
  }

  gated.get('/api/workout-now', timed(async (req, res) => {
    try {
      const st = await trainingCore();
      const day = await workoutDay(st.today);
      const V = st.volume || {}, ix = {};
      for (const g of V.groups || []) for (const m of g.muscles) ix[m.muscle] = m;
      const muscles = (name) => ((V.exercise_muscles || {})[name] || []).filter((e) => ix[e.muscle]).map((e) => ({
        label: ix[e.muscle].label, sets: ix[e.muscle].sets, color: ix[e.muscle].color, primary: e.contribution >= 1,
      }));
      const exercises = (day.exercises || []).slice()
        .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))
        .map((ex) => ({ name: ex.name, sets: ex.sets.map((x) => ({ weight_lbs: x.weight_lbs, reps: x.reps })),
                        muscles: muscles(ex.name) }));
      // Every muscle's week against its goal, furthest behind first: the phone's Priority order
      // (cards/muscle.js renderVolume), decided here so the watch only draws it.
      const volume = Object.values(ix).map((m) => ({ label: m.label, sets: m.sets, target: m.target, color: m.color }))
        .sort((a, b) => (a.sets / a.target) - (b.sets / b.target) || a.sets - b.sets || a.label.localeCompare(b.label));
      res.json({
        last_set_at: st.last_set_at, session_start_at: st.session_start_at, sets_today: st.sets_today, exercises,
        body: bodyColours(V.muscle_colors), volume,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  }));
};
