'use strict';
const { buildNutritionLog } = require('../lib/nutritionlog');
const { buildWeightPlot } = require('../lib/weightplot');
const { buildWorkoutHeatmap } = require('../lib/heatmap');
const { nutritionWindow, dayBucketOf } = require('../lib/dates');

module.exports = function (ctx) {
  const {
    HEAT_WEEKS, gated, maintenanceWithHistory, nutritionCore, paceOf, sb, sbRange, timed,
  } = ctx;

  // ---- heat-grid history, for the phone's expanded sheet ----
  // The status frame carries a fixed HEAT_WEEKS window because it is re-pushed on every realtime
  // event, and history only grows — so everything older is fetched once, on demand, by the one surface
  // that can scroll back through it.
  //
  // This returns the older PREFIX, not the whole grid: the client draws it in front of the live window
  // it already has, which keeps that window authoritative. Today's cell and any edit still arrive on
  // the frame as they always did, with no cell-by-cell merging to get wrong.
  //
  // `join_month` is the label the live window's FIRST column takes once a prefix sits in front of it.
  // It is only ever different from the one on the frame: months label a column when the month changes
  // from the column to its left, and on the frame that column has nothing to its left.
  const heatHistCache = { body: null, at: 0 };
  const HEATHIST_BACKSTOP_MS = 15 * 60 * 1000;
  const dirtyHeatHistory = () => { heatHistCache.body = null; };

  // Week columns from the one containing `first` through the one containing `today`, Sunday-aligned
  // exactly as the builders align them.
  function weeksSpanning(first, today) {
    if (!first || first > today) return 0;
    const sunday = (ds) => { const d = new Date(ds + 'T12:00:00Z'); return d.getTime() - d.getUTCDay() * 86400000; };
    return Math.round((sunday(today) - sunday(first)) / (7 * 86400000)) + 1;
  }
  // Split a full-span grid into what the frame does NOT carry. Empty when the whole history already
  // fits inside the window, which is the nutrition calendar's case today.
  function heatPrefix(full) {
    const extra = full.weeks.length - HEAT_WEEKS;
    if (extra <= 0) return { weeks: [], months: [], join_month: null };
    return { weeks: full.weeks.slice(0, extra), months: full.months.slice(0, extra), join_month: full.months[extra] };
  }

  // The watch's nutrition history behind its rings: the intake calendar and the weigh-in plot over the
  // SAME weeks, so a column is the same week in both — the alignment is the whole point of drawing them
  // together (HUB-INTERNALS, the home wall's plot). Its own endpoint because /api/status is the entire
  // dashboard and this is two small arrays; `weeks` keeps it to what a wrist can show.
  const NUT_HISTORY_MS = 10 * 60 * 1000;
  const daysBefore = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const nutHistoryCache = new Map();
  gated.get('/api/nut-history', timed(async (req, res) => {
    try {
      // `all=1` is the whole history, back to the first meal or set logged (the watch's history view,
      // which scrolls); otherwise the last `weeks`, at most 30 (the health page at rest).
      const all = String(req.query.all || '') === '1';
      let weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 10, 2), 30);
      if (all) {
        const [firstSet, firstNut] = await Promise.all([
          sb('sets?select=occurred_at&order=occurred_at.asc&limit=1'),
          sb('nutrition_entries?staged=eq.false&select=occurred_at&order=occurred_at.asc&limit=1'),
        ]);
        const today0 = nutritionWindow().day;
        weeks = Math.max(2, weeksSpanning(firstSet[0] && dayBucketOf(firstSet[0].occurred_at), today0),
          weeksSpanning(firstNut[0] && dayBucketOf(firstNut[0].occurred_at), today0));
      }
      const hit = nutHistoryCache.get(weeks);
      if (hit && Date.now() - hit.at < NUT_HISTORY_MS) return res.json(hit.body);
      const core = await nutritionCore();
      const { fraction } = paceOf(core).paceData;
      const today = core.today;
      const [nutRows, weightRows, targetRows, setRows] = await Promise.all([
        sbRange(`nutrition_entries?occurred_at=gte.${daysBefore(today, weeks * 7 + 7)}T00:00:00&staged=eq.false` +
          '&select=occurred_at,calories,protein_g,fat_g&order=occurred_at'),
        sb('weight_log?select=date,weight_lbs&order=date.asc'),
        sb('nutrition_targets?select=date,calories,override&order=date.asc'),
        sbRange(`sets?occurred_at=gte.${daysBefore(today, weeks * 7 + 7)}T00:00:00&select=occurred_at&order=occurred_at`),
      ]);
      const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
      const log = buildNutritionLog(nutRows || [], weights, core.maintenance.target, core.maintenance.maintenance,
        today, targetRows || [], weeks, core.surplus, 150, fraction);
      // Only what a cell needs: the colour, whether it is today, and its date (`d`), which is what a tap
      // on the watch's history view asks the day's log for. The other fields nothing on the wrist reads.
      // The training map comes back in the SAME shape as the food one — a colour and a today flag per
      // cell — so a client draws both with one routine instead of carrying the level ramp itself. The
      // ramp is cards/workouts.js's, one step per level from lib/heatmap.js.
      const SETS_RAMP = ['#000', '#0e4429', '#006d32', '#158c3a', '#26a641', '#39d353', '#43f461', '#8cfc94'];
      const body = {
        weeks: (log.weeks || []).map((w) => w.map((d) => ({ c: d.color, t: d.today ? 1 : 0, d: d.date }))),
        sets: (buildWorkoutHeatmap(setRows || [], weeks, today).weeks || [])
          .map((w) => w.map((d) => ({ c: d.level < 0 ? null : SETS_RAMP[d.level], t: d.today ? 1 : 0, d: d.date }))),
        weight: buildWeightPlot(weights, weeks, today),
      };
      nutHistoryCache.set(weeks, { body, at: Date.now() });
      res.json(body);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  }));

  // The weight view (the phone's cards/maintviz.js), for the watch: the weigh-ins, each day's intake, the
  // maintenance and target curves replayed per day, and the fitted trend over the window. All computed
  // for the phone's card already; this builds only that piece, not the whole dashboard.
  gated.get('/api/weight-view', timed(async (req, res) => {
    try {
      const core = await nutritionCore();
      const m = maintenanceWithHistory(core), v = m.viz || {};
      res.json({
        today: core.today, window_start: m.window_start || null, window_end: m.window_end || null,
        weighins: (v.weighins || []).map((w) => ({ date: w.date, weight: w.weight, inwin: !!w.inwin })),
        intake: (v.intake || []).map((d) => ({ date: d.date, calories: d.calories, kept: d.kept != null })),
        series: (v.series || []).map((r) => ({ date: r.date, maintenance: r.maintenance ?? null, target: r.target ?? null })),
        slope_lb_day: v.slope_lb_day ?? null, weight_at_end: v.weight_at_end ?? null,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  }));

  gated.get('/api/heat-history', timed(async (req, res) => {
    try {
      if (heatHistCache.body && Date.now() - heatHistCache.at < HEATHIST_BACKSTOP_MS) return res.json(heatHistCache.body);
      const today = nutritionWindow().day;
      const [firstSet, firstNut] = await Promise.all([
        sb('sets?select=occurred_at&order=occurred_at.asc&limit=1'),
        sb('nutrition_entries?staged=eq.false&select=occurred_at&order=occurred_at.asc&limit=1'),
      ]);
      const setWeeks = weeksSpanning(firstSet[0] && dayBucketOf(firstSet[0].occurred_at), today);
      const nutWeeks = weeksSpanning(firstNut[0] && dayBucketOf(firstNut[0].occurred_at), today);

      // BOTH MAPS GET THE SAME SPAN, which is the longer of the two. They are read together — a surface
      // can scroll them as one axis — and that is only possible if a given week is the same column in
      // each. Built to their own lengths they simply stop at different places: the food map's archive
      // starts later (intake logging began after the training log did), so dragging back ran it out of
      // columns while the training map carried on, and the two ended up showing different months.
      // A week before the logging started is an empty column, which is what the map draws for a day
      // with nothing on it anyway.
      const span = Math.max(setWeeks, nutWeeks);
      // Nothing older than the window on either map — say so without reading a row of history.
      const empty = { weeks: [], months: [], join_month: null };
      if (span <= HEAT_WEEKS) {
        const body = { today, window_weeks: HEAT_WEEKS, heatmap: empty, nutrition_log: empty, weight_plot: null };
        heatHistCache.body = body; heatHistCache.at = Date.now();
        return res.json(body);
      }

      // The nutrition calendar's colour is intake against that day's GOAL, which is maintenance-derived
      // and phase-aware. Those numbers come off the same piece the frame is built from (nutritionCore),
      // so a day cannot be one colour on the card and another in the expanded view.
      const core = await nutritionCore();
      const { fraction } = paceOf(core).paceData;
      const [setRows, nutRows, weightRows, targetRows] = await Promise.all([
        sbRange('sets?select=occurred_at&order=occurred_at'),
        sbRange('nutrition_entries?staged=eq.false&select=occurred_at,calories,protein_g,fat_g&order=occurred_at'),
        sb('weight_log?select=date,weight_lbs&order=date.asc'),
        sb('nutrition_targets?select=date,calories,override&order=date.asc'),
      ]);

      const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
      const heatmap = heatPrefix(buildWorkoutHeatmap(setRows, span, today));
      const nutrition_log = heatPrefix(buildNutritionLog(nutRows, weights, core.maintenance.target, core.maintenance.maintenance,
        today, targetRows || [], span, core.surplus, 150, fraction));
      // The weigh-in plot over that same span, for the surfaces that scroll it with the maps — it has
      // to have a point over every column they have, not just the ones the status frame carries.
      const weight_plot = buildWeightPlot(weights, span, today);
      const body = { today, window_weeks: HEAT_WEEKS, heatmap, nutrition_log, weight_plot };
      heatHistCache.body = body; heatHistCache.at = Date.now();
      res.json(body);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  }));

  return { dirtyHeatHistory };
};
