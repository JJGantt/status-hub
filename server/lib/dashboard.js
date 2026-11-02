'use strict';
// The dashboard: every derived value the cards paint, built from cached source rows (lib/rowcache.js)
// and pushed to every /api/stream client. One instance, made in server.js.
const { estimateMaintenance, estimateHistory, macroTargets } = require('./maintenance');
const pace = require('./pace');
const { computeVolume } = require('./volume');
const { getTZ, localDate, nutritionWindow, lastNTrainingDays, dayBucketOf } = require('./dates');
const { buildWorkoutHeatmap } = require('./heatmap');
const { buildWeightPlot } = require('./weightplot');
const { getWeather } = require('./weather');
const { buildNutritionLog, buildGoalResolver } = require('./nutritionlog');
const { computeScore } = require('./score');
const { buildVariants } = require('./variants');
const { buildLitter } = require('./litter');

// Weeks of heat map the HOME wall shows, against the health wall's 20. Trimming is what makes the two
// maps NARROWER at an unchanged cell size, and that freed width is the muscle column beside them --
// the point is never to show less, it is to not widen the column (which oversizes surf under it and
// robs the sessions column). Cells are fluid, so a trim only helps if the stack keeps its cell size.
const HOME_HEAT_WEEKS = 15;
// The PHONE's home page trims no heat map: its maps SCROLL, so what is visible is decided by the box
// they sit in and everything either side of that is one drag away. Its weigh-in plot scrolls with
// them, which is why it is built on the frame's own window rather than a shorter one — it needs a
// point over every column the food map has, not just the ones on screen.
// Weeks of heat grid carried in the status frame. The frame is re-pushed on every realtime event,
// so this window is fixed; everything older is served on demand by /api/heat-history, which splits
// its prefix at exactly this boundary.
const HEAT_WEEKS = 20;
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function createDashboard(ctx) {
  const {
    buildSurf, claudeUsageRow, buildUsage, etNowString, fetchDeskFocus, groupRows, liveBuoy, liveWind,
    maintenanceMinDays, maintenancePhase, produceTargets, routingConfig, sb, sbRange, sbWrite, sseClients,
    statusEpoch, surplusCal,
  } = ctx;

  // Keep the stored nutrition_targets row in sync with the hub's live dynamic goal so the
  // MCP (which reads that row) and the hub always agree. Writes only when the value changes;
  // one row per day (updates today's row, else inserts). Fire-and-forget from buildStatus.
  let lastSyncedTarget = null;
  async function syncStoredTarget(m, today) {
    if (!m) return;
    const key = `${m.calories}/${m.protein_g}/${m.carbs_g}/${m.fat_g}`;
    if (key === lastSyncedTarget) return;
    const rows = await sb(`nutrition_targets?date=eq.${today}&select=id,calories,protein_g,carbs_g,fat_g`);
    const vals = { calories: m.calories, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g };
    const existing = (rows || [])[0];
    if (existing && existing.calories === vals.calories && existing.protein_g === vals.protein_g
        && existing.carbs_g === vals.carbs_g && existing.fat_g === vals.fat_g) { lastSyncedTarget = key; return; }
    const logged_at = new Date().toISOString();
    if (existing) await sbWrite(`nutrition_targets?id=eq.${existing.id}`, 'PATCH', { ...vals, logged_at });
    else await sbWrite('nutrition_targets', 'POST', { ...vals, date: today, logged_at });
    lastSyncedTarget = key;
  }


  // Current time as minutes into the 4am-origin day, in the display timezone.
  function nowOffsetTZ() {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: getTZ(), hour12: false, hour: '2-digit', minute: '2-digit' });
    const parts = f.formatToParts(new Date());
    const hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const mm = Number(parts.find((p) => p.type === 'minute').value);
    return pace.offsetFromHM(hh, mm);
  }

  // The date windows the status queries are cut to. Every one is derived from the clock, so each is
  // also part of its group's cache key: a window rolling over is a refetch.
  function statusWindows() {
    const win = nutritionWindow();
    return {
      win, today: win.day,
      week: lastNTrainingDays(7),
      // Intake history for the maintenance trend + per-day replay (viz paging).
      histStart: localDate(new Date(Date.now() - 210 * 86400000)),
      // The frame's workout heatmap window.
      heatStart: localDate(new Date(Date.now() - HEAT_WEEKS * 7 * 86400000)),
      // The food map's rows must reach back as far as its grid does — HEAT_WEEKS columns, the first
      // starting on a Sunday up to six days before that. A fixed day count here outlives the grid it was
      // sized for, and every day it falls short draws as an empty cell, which reads exactly like deleted
      // entries.
      nutLogStart: localDate(new Date(Date.now() - (HEAT_WEEKS * 7 + 7) * 86400000)),
      taskWindowStart: localDate(new Date(Date.now() - 8 * 86400000)),  // an effect is gone at 7 days; a day's slack costs nothing
    };
  }

  const rowsOf = {
    nut: (w) => groupRows('nut', [w.win.start, w.win.end, w.histStart, w.nutLogStart].join('|'), async () => {
      const [entries, stagedEntries, histRows, nutLogRows] = await Promise.all([
        sb(`nutrition_entries?occurred_at=gte.${w.win.start}&occurred_at=lt.${w.win.end}&staged=eq.false&select=calories,protein_g,carbs_g,fat_g,veg_g,dark_green_g,fruit_g`),
        // Staged meals carry no day: they are pending until committed, so there is no window to filter on
        // and every staged row belongs to whatever day it is eaten on. Sum them all.
        sb('nutrition_entries?staged=eq.true&select=calories,protein_g,carbs_g,fat_g'),
        sbRange(`nutrition_entries?occurred_at=gte.${w.histStart}T00:00:00&staged=eq.false&select=occurred_at,calories&order=occurred_at`),
        sbRange(`nutrition_entries?occurred_at=gte.${w.nutLogStart}T00:00:00&staged=eq.false&select=occurred_at,calories,protein_g,fat_g&order=occurred_at`),
      ]);
      return { entries, stagedEntries, histRows, nutLogRows };
    }),
    weight: () => groupRows('weight', '', async () => ({ weightRows: await sb('weight_log?select=date,weight_lbs&order=date.asc') })),
    targets: () => groupRows('targets', '', async () => ({ targetRows: await sb('nutrition_targets?select=date,calories&order=date.asc') })),
    train: (w) => groupRows('train', [w.week[0], w.heatStart].join('|'), async () => {
      // The week's muscle volume comes computed: muscle_volume() is its one definition (lib/volume.js).
      const [volRows, heatRows] = await Promise.all([
        sb('rpc/muscle_volume?p_days=7'),
        sbRange(`sets?occurred_at=gte.${w.heatStart}T00:00:00&select=occurred_at&order=occurred_at`),
      ]);
      return { volRows, heatRows };
    }),
    catalog: () => groupRows('catalog', '', async () => {
      const [muscleRows, catalogRows] = await Promise.all([
        sb('exercise_muscles?select=name,muscle,contribution'),
        sb('exercise_catalog?select=name,equipment'),
      ]);
      return { muscleRows, catalogRows };
    }),
    surf: () => groupRows('surf', '', async () => ({ surfRows: await sb('surf_snapshots?select=slug,captured_at,rows&order=captured_at.desc&limit=1') })),
    // The gold band's two inputs, both ordinary `list_items` rows. A completed item persists — it still
    // draws on the calendar — so it is its own record and there is no separate ledger. The drain is
    // derived live from whatever is still outstanding, so there is no stored penalty to fall out of step
    // with the list.
    tasks: (w) => groupRows('tasks', w.taskWindowStart, async () => {
      const [taskEventRows, openTaskRows] = await Promise.all([
        sb(`list_items?deleted=eq.false&completed_at=gte.${w.taskWindowStart}T00:00:00&due=not.is.null&select=scheduled_at,due,completed_at,priority`),
        sb('list_items?deleted=eq.false&completed_at=is.null&due=not.is.null&select=scheduled_at,due,priority'),
      ]);
      return { taskEventRows, openTaskRows };
    }),
  };

  // Recompute only when an input changed. Inputs are compared by IDENTITY, which is what a cached row
  // group hands out: the same array until that group is refetched. So a derived value lives exactly as
  // long as the rows it was derived from, with no invalidation of its own to forget.
  function memo(fn) {
    let deps = null, val;
    return (...args) => {
      if (deps && deps.length === args.length && deps.every((d, i) => d === args[i])) return val;
      val = fn(...args); deps = args;
      return val;
    };
  }

  // ---- the dashboard, in PIECES ------------------------------------------------------------------
  // buildStatus() is every card on every wall, and a surface that draws one card must not pay for the
  // rest: the watch's rings used to cost a whole dashboard — 210 days of maintenance replayed day by
  // day, both heat maps, the devices, the mics, the session focus — to send four arcs. Each endpoint
  // below asks for the pieces it draws, and buildStatus is those same pieces put together, so a number
  // cannot come out one way on the wall and another on the wrist.

  // Maintenance and the eating window: a function of the intake history, the weigh-ins and the goal
  // settings, so recomputed only when one of them moves. NOT the per-day replay (`historyOf`), which is
  // most of the cost and which only the weight views draw.
  const maintenanceOf = memo((weightRows, histRows, today, surplus, minAlignedDays, phaseKey) => {
    const intakeTotals = {};
    for (const e of histRows || []) {
      const d = dayBucketOf(e.occurred_at);
      if (d === today) continue; // exclude the in-progress day (partial intake biases low)
      intakeTotals[d] = (intakeTotals[d] || 0) + (Number(e.calories) || 0);
    }
    const intakeByDay = Object.entries(intakeTotals).map(([date, calories]) => ({ date, calories }));
    const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
    const phase = JSON.parse(phaseKey);   // caps the live window at the current goal phase
    const maintenance = estimateMaintenance({ weights, intakeByDay, today, surplus, minAlignedDays, phase });
    const eatWindow = pace.deriveWindow((histRows || []).map((r) => r.occurred_at));
    return { weights, intakeByDay, maintenance, eatWindow };
  });

  // What every nutrition surface starts from: the day's rows, the goal settings and maintenance.
  async function nutritionCore() {
    const w = statusWindows();
    const [nut, { weightRows }, { targetRows }, surplus, minAlignedDays, phase, produceGoal] = await Promise.all([
      rowsOf.nut(w), rowsOf.weight(), rowsOf.targets(),
      surplusCal(), maintenanceMinDays(), maintenancePhase(), produceTargets(),
    ]);
    const m = maintenanceOf(weightRows, nut.histRows, w.today, surplus, minAlignedDays, JSON.stringify(phase ?? null));
    return { w, today: w.today, ...nut, weightRows, targetRows, surplus, minAlignedDays, produceGoal, ...m };
  }

  // The day's totals and the pace rings at THIS instant — the one piece that moves with the clock, so
  // it is computed per call; it is a few arithmetic passes.
  function paceOf(core) {
    const sum = (k) => (core.entries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0);
    const nutrition = {
      calories: Math.round(sum('calories')),
      protein_g: Math.round(sum('protein_g')),
      carbs_g: Math.round(sum('carbs_g')),
      fat_g: Math.round(sum('fat_g')),
      // Produce grams. veg_g ALREADY includes dark_green_g — the data layer rolls dark greens into both, so these
      // are summed straight across and must never be added together.
      veg_g: Math.round(sum('veg_g')),
      dark_green_g: Math.round(sum('dark_green_g')),
      fruit_g: Math.round(sum('fruit_g')),
      target: core.maintenance.target_macros, // the macro goal is the live dynamic target
    };
    // ---- gamified intake pacing (drain bars) ----
    // What is staged but not eaten. Kept OUT of `nutrition` and out of `consumed` — it is what the day
    // would become, never what it is — and handed to the pace math separately so the rings can draw it
    // as a piece past the real arc.
    const stagedSum = (k) => Math.round((core.stagedEntries || []).reduce((a, e) => a + (Number(e[k]) || 0), 0));
    const stagedMacros = { calories: stagedSum('calories'), protein_g: stagedSum('protein_g'),
                           carbs_g: stagedSum('carbs_g'), fat_g: stagedSum('fat_g') };
    const paceData = pace.computePace({
      consumed: { calories: nutrition.calories, protein_g: nutrition.protein_g, carbs_g: nutrition.carbs_g, fat_g: nutrition.fat_g },
      goal: core.maintenance.target_macros,
      staged: stagedMacros,
      window: core.eatWindow,
      nowOff: nowOffsetTZ(),
    });
    paceData.window_label = pace.windowLabel(core.eatWindow);
    // Produce rings are NOT paced. The macro rings are drain gauges (full = on-pace, draining with the
    // clock); produce starts EMPTY each day and simply fills toward a fixed goal. No window, no marker,
    // no time term at all — so it goes through computeFill(), never computePace().
    paceData.produce = pace.computeFill(
      { veg_g: nutrition.veg_g, dark_green_g: nutrition.dark_green_g, fruit_g: nutrition.fruit_g }, core.produceGoal);
    return { nutrition, paceData };
  }

  // The per-day replay of maintenance and target, for the surfaces that draw the weight page.
  const historyOf = memo((weights, intakeByDay, today, surplus, minAlignedDays) =>
    // Phase-less, so past goals are never backfilled.
    estimateHistory({ weights, intakeByDay, today, surplus, minAlignedDays }));
  function maintenanceWithHistory(core) {
    const m = core.maintenance;
    if (!m.viz) return m;
    let series = historyOf(core.weights, core.intakeByDay, core.today, core.surplus, core.minAlignedDays);
    // ...but the replay's FINAL point still reflects the old straddled calc, so override ONLY today's point
    // with the live phase-aware number — the on-plot curve + its labels then agree with the header/math,
    // while every prior day stays frozen (no backfill). On a copy: the replay is cached.
    const last = series && series[series.length - 1];
    if (last && last.date === core.today && m.source !== 'calibrating') {
      series = series.slice(0, -1).concat({ ...last, avg: m.avg_intake, maintenance: m.maintenance, target: m.target });
    }
    return { ...m, viz: { ...m.viz, series } };
  }

  const volumeOf = memo((volRows, muscleRows, catalogRows) => {
    // ---- weekly per-muscle volume gauges ----
    const volume = computeVolume(volRows, muscleRows || []);
    volume.exercise_variants = buildVariants(catalogRows || []); // exercise → equipment variants + YouTube how-to links
    return volume;
  });
  const setClocksOf = memo((heatRows, today) => {
    const last_set_at = (heatRows && heatRows.length) ? heatRows[heatRows.length - 1].occurred_at : null;
    // Sets logged so far in the current 4am-origin day — the same figure the day-detail panel heads
    // its list with, carried on the payload so the rest-timer block can show it without a second read.
    const sets_today = (heatRows || []).reduce((n, r) => n + (dayBucketOf(r.occurred_at) === today ? 1 : 0), 0);
    // session_start_at: the first set of the trailing run where consecutive sets are <=20min apart. The
    // client shows (now - session_start) as the session clock while the last set is <20min old, and lets
    // it reset to zero once a 20min gap opens (the session ended). A >20min gap breaks the run, so a new
    // workout's first set becomes the new session start.
    const SESSION_GAP_MS = 20 * 60 * 1000;
    let session_start_at = last_set_at;
    if (heatRows && heatRows.length) {
      for (let i = heatRows.length - 1; i > 0; i--) {
        const gap = new Date(heatRows[i].occurred_at).getTime() - new Date(heatRows[i - 1].occurred_at).getTime();
        if (gap <= SESSION_GAP_MS) session_start_at = heatRows[i - 1].occurred_at;
        else break;
      }
    }
    return { last_set_at, session_start_at, sets_today };
  });

  // The week's training: the muscle gauges and the set clocks.
  async function trainingCore() {
    const w = statusWindows();
    const [{ volRows, heatRows }, { muscleRows, catalogRows }] = await Promise.all([rowsOf.train(w), rowsOf.catalog()]);
    return { w, today: w.today, heatRows,
      volume: volumeOf(volRows, muscleRows, catalogRows),
      ...setClocksOf(heatRows, w.today) };
  }

  const goalResolverOf = memo((nutLogRows, weights, targetRows, today, surplus, fallbackMaint) =>
    buildGoalResolver({ rows: nutLogRows || [], weights, targets: targetRows || [], today, surplus, fallbackMaint }));

  // ---- overall score (training, nutrition and tasks over the rolling week) ----
  async function scoreOf(core, paceData, train) {
    const { taskEventRows, openTaskRows } = await rowsOf.tasks(core.w);
    const { goalForDay } = goalResolverOf(core.nutLogRows, core.weights, core.targetRows, core.today, core.surplus,
      core.maintenance.maintenance);
    const dayCPF = {};   // 4am-day bucket -> {cal, protein, fat} actuals
    for (const e of core.nutLogRows || []) {
      const d = dayBucketOf(e.occurred_at);
      const x = (dayCPF[d] = dayCPF[d] || { cal: 0, protein: 0, fat: 0 });
      x.cal += Number(e.calories) || 0; x.protein += Number(e.protein_g) || 0; x.fat += Number(e.fat_g) || 0;
    }
    const weights = core.weights;
    const wForDay = (ds) => { let w = null; for (const x of weights) { if (x.date <= ds) w = x.weight; else break; } return w; };  // weights are date-asc
    const scoreDays = core.w.week.map((d) => {
      const a = dayCPF[d] || { cal: 0, protein: 0, fat: 0 };
      const calGoal = goalForDay(d);
      const mt = macroTargets(calGoal, wForDay(d));
      return { date: d, isToday: d === core.today, fraction: paceData.fraction, cal: a.cal, protein: a.protein, fat: a.fat,
               calGoal, proteinFloor: mt.protein_g, fatTarget: mt.fat_g };
    });
    // surplus signs the goal-aware calorie scoring; the task inputs are the gold band's ledger and the
    // still-open dated items it drains from.
    return computeScore({
      volume: train.volume, days: scoreDays, surplus: core.surplus,
      taskEvents: taskEventRows || [], openTasks: openTaskRows || [], nowLocal: etNowString(),
    });
  }

  // The whole dashboard. Requests that arrive while one is being built share it, unless something it
  // reads was invalidated after it began; the broadcast always builds its own (`composeStatus`), because
  // a device_status change reaches it without invalidating any cache and must not be answered with a
  // build that started before it.
  let statusBuild = null;
  function buildStatus() {
    if (statusBuild && statusBuild.epoch === statusEpoch()) return statusBuild.promise;
    const build = { epoch: statusEpoch(), promise: null };
    build.promise = composeStatus().finally(() => { if (statusBuild === build) statusBuild = null; });
    statusBuild = build;
    return build.promise;
  }

  async function composeStatus() {
    const [core, train, { surfRows }, deviceRows, presenceRows, workerRows, watcherRows, usageRow] = await Promise.all([
      nutritionCore(), trainingCore(), rowsOf.surf(),
      sb('device_status?select=*'),
      sb('voice_presence?select=source,alive_at'),
      sb('worker_presence?select=worker,last_seen,info'),
      // Alongside the other live reads rather than after the build: it is one more round trip, and
      // serially it was the frame's second.
      sb('set_watcher?id=eq.1&select=exercise,weight_lbs,armed_at,last_set_at').catch(() => []),
      claudeUsageRow().catch((e) => { console.error('[usage] read failed:', e.message); return null; }),
    ]);
    const { today } = core;

    const litter = buildLitter((deviceRows || []).find((d) => d.device !== 'cat-feeder') || null);
    const feeder = (deviceRows || []).find((d) => d.device === 'cat-feeder') || null;
    const surf = buildSurf((surfRows || [])[0]);

    const routing = await routingConfig();   // agent model / thinking / runner / wake (TV routing panel)

    // The session a spoken follow-up would land in — shown on the TV strip so the answer is ambient
    // rather than something you have to open a pane to learn.
    let deskFocus = null;
    try { deskFocus = await fetchDeskFocus(); } catch (_) { /* the strip simply shows nothing rather than failing the whole payload */ }

    // ---- mic / worker liveness ----
    // Mics beacon voice_presence.alive_at every 30s WHILE audio frames are flowing (not merely while the
    // process exists); workers heartbeat worker_presence.last_seen every 10s. Stale = down. The Mac mic is
    // keyed on whichever process OWNS the mic: wakefree.py when always-on voice is on, the wake-word
    // listener otherwise — so a dead owner can't hide behind its healthy sibling.
    const LIVENESS_STALE_S = 90;   // 3 missed 30s beacons
    const freshFor = (ts) => !!ts && (Date.now() - new Date(ts).getTime()) / 1000 <= LIVENESS_STALE_S;
    const aliveBy = Object.fromEntries((presenceRows || []).map((r) => [r.source, r.alive_at]));
    const beatBy = Object.fromEntries((workerRows || []).map((r) => [r.worker, r.last_seen]));
    const mics = {
      esp: freshFor(aliveBy.esp),
      mac: freshFor(aliveBy[routing.wake ? 'mac-wakefree' : 'mac-listener']),
      workers: { mac: freshFor(beatBy.mac), pi: freshFor(beatBy.pi), fly: freshFor(beatBy.fly) },
      // The Pi's own resources, as pi-desk sees them (it publishes them on its 30s heartbeat). On the
      // wall so the machine is not invisible until it falls over: it OOM-killed sessions daily for days
      // while every indicator up here stayed green, because none of them was about the machine.
      // Thresholds live here rather than in the card, so the colour cannot disagree between surfaces —
      // swap's amber is deliberately well under pi-desk's own 70% refuse-to-launch ceiling.
      host: (() => {
        const row = (workerRows || []).find((r) => r.worker === 'pi-desk');
        const i = (row && row.info) || {};
        if (!freshFor(row && row.last_seen) || i.mem_pct == null) return null;
        const band = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');
        return {
          mem: i.mem_pct, mem_state: band(i.mem_pct, 80, 92),
          swap: i.swap_pct ?? null, swap_state: i.swap_pct == null ? 'ok' : band(i.swap_pct, 40, 70),
          sessions: i.sessions ?? null,
        };
      })(),
    };
    const maintenance = maintenanceWithHistory(core);
    syncStoredTarget(maintenance.target_macros, today).catch((e) => console.error('target sync:', e.message));
    const { nutrition, paceData } = paceOf(core);
    const { volume } = train;
    const { weights, surplus } = core;

    // ---- workout volume heatmap (GitHub-contribution style) ----
    const heatmap = buildWorkoutHeatmap(train.heatRows, HEAT_WEEKS, today); // 4am `today`, matching the nutrition heatmap

    // ---- nutrition log: calorie-adherence calendar (per-day historical targets) + calorie/weight trend ----
    const nutrition_log = buildNutritionLog(core.nutLogRows || [], weights, maintenance.target, maintenance.maintenance, today, core.targetRows || [], HEAT_WEEKS, surplus, 150, paceData.fraction);


    // `months` is parallel to `weeks` and labels a column only where the month changes, so a slice can
    // begin on an unlabelled column; the first is relabelled from its own first day.
    const trimHeat = (h, n) => {
      const weeks = h.weeks.slice(-n);
      const months = h.months.slice(-n);
      if (weeks.length && !months[0]) months[0] = MON_ABBR[Number(weeks[0][0].date.slice(5, 7)) - 1];
      return { weeks, months };          // only what differs — the card spreads it over the full object
    };
    const heatmap_home = trimHeat(heatmap, HOME_HEAT_WEEKS);
    const nutrition_log_home = trimHeat(nutrition_log, HOME_HEAT_WEEKS);
    // Built at the HOME window because the home wall is the only surface that draws it: the plot is
    // meaningless away from the columns it is aligned to, so there is no full-window version to trim.
    const weight_plot = buildWeightPlot(weights, HOME_HEAT_WEEKS, today);
    // The phone's plot spans the map's WHOLE window, not the part of it on screen: there it scrolls
    // with the map under it, so it has to have a point over every column the map has.
    const weight_plot_phone = buildWeightPlot(weights, HEAT_WEEKS, today);


    const score = await scoreOf(core, paceData, train);

    // The rep watcher: what the Apple Watch app's counted sets are currently being
    // logged as. Shown under the rest clock so it is visible at a glance whether a set
    // about to be performed will actually be recorded — knowing that BEFORE the set is
    // the only time it helps. Ten minutes with no set clears it, mirrored from the SQL
    // so the UI and the trigger agree on what "live" means.
    // The watcher is a nicety; a failed read is no watcher, never a failed dashboard.
    let rep_watcher = null;
    const rw = (watcherRows || [])[0];
    if (rw && rw.exercise) {
      const stamp = rw.last_set_at || rw.armed_at;
      if (stamp && Date.now() - new Date(stamp).getTime() < 10 * 60 * 1000) {
        rep_watcher = { exercise: rw.exercise, weight_lbs: rw.weight_lbs };
      }
    }

    const { last_set_at, session_start_at, sets_today } = train;
    return { today, litter, feeder, surf, wind: liveWind.view((surfRows || [])[0]), buoys: liveBuoy.view(), weather: getWeather(), nutrition, maintenance, pace: paceData, volume, heatmap, nutrition_log,
      heatmap_home, nutrition_log_home, weight_plot, weight_plot_phone,
      last_set_at, session_start_at, sets_today, rep_watcher, routing, mics, score, desk_focus: deskFocus,
      claude_usage: buildUsage(usageRow),
      // THE BUILD THIS FRAME CAME FROM. A page that has been open for hours never re-requests its own
      // bundle, so a deploy reaches the server and not the screen — which is how a phone spends an
      // afternoon running code that was replaced. Every client remembers the first commit it sees and
      // reloads when it changes. Push, not a version check on a timer: a deploy restarts the server,
      // every stream reconnects, and the next frame carries the new one.
      commit: process.env.COMMIT || 'dev',
      generated_at: new Date().toISOString() };
  }

  // ---- realtime push: recompute + push to all connected browsers on any DB change ----
  let frameSeq = 0, frameSent = 0;
  // A build re-runs every 30s and on every write, so one Supabase blip (`fetch failed`, a gateway 502)
  // heals itself by the next frame. It warns; only a streak of failures lasting 5 minutes is an error,
  // raised once per streak, so the responder hears about an outage and not about a hiccup.
  let buildFailingSince = 0, buildFailReported = false;
  async function broadcast() {
    const seq = ++frameSeq;
    let frame;
    const t0 = Date.now();
    try { frame = 'data: ' + JSON.stringify(await composeStatus()) + '\n\n'; }
    catch (e) {
      if (!buildFailingSince) buildFailingSince = Date.now();
      if (!buildFailReported && Date.now() - buildFailingSince >= 5 * 60 * 1000) {
        buildFailReported = true;
        console.error(`broadcast build failing since ${new Date(buildFailingSince).toISOString()}:`, e.message);
      } else console.warn('broadcast build failed (will retry):', e.message);
      return;
    }
    buildFailingSince = 0; buildFailReported = false;
    // Only a slow one: this runs every 30s and on every write, and a line per build is noise.
    if (Date.now() - t0 > 500) console.log(`[timing] broadcast build ${Date.now() - t0}ms`);
    if (seq < frameSent) { console.log('[broadcast] dropped a frame a later build already sent'); return; }
    frameSent = seq;
    for (const res of sseClients) { try { res.write(frame); } catch {} }
  }

  return { HEAT_WEEKS, broadcast, buildStatus, maintenanceWithHistory, nutritionCore, paceOf, scoreOf, trainingCore };
}

module.exports = { createDashboard };
