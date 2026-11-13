'use strict';
const { DAY_START_HOUR, localDate, nutritionWindow, dayBucketOf, nowNaiveLocal } = require('../lib/dates');
const { buildGoalResolver, calorieColor } = require('../lib/nutritionlog');
const crypto = require('crypto');
const express = require('express');
const { macroTargets } = require('../lib/maintenance');
const pace = require('../lib/pace');

module.exports = function (ctx) {
  const {
    dirtyWorkoutDay, gated, produceTargets, pushDay, sb, sbRange, sbWrite, surplusCal, timed,
  } = ctx;

  // Best-effort audit trail for every hub nutrition write (add/edit/delete). before/after are
  // full row snapshots (or null) — enough to fully reverse any action. NEVER throws into the
  // caller: a failed audit insert must not fail the user's action, so it logs and swallows.
  async function audit(action, entryId, before, after) {
    try {
      await sbWrite('nutrition_audit', 'POST', {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        action,
        entry_id: entryId,
        before: before || null,
        after: after || null,
      });
    } catch (e) { console.error('audit insert failed:', e.message); }
  }

  // A single 4am→4am nutrition day's food entries — for the nutrition-log day click-through.
  // Cached: the client re-fetches the open day on EVERY SSE status frame (its "live-refresh"), which
  // re-ran five Supabase queries — one of them a full-history scan — every ~30s all day. The response
  // only changes when nutrition data changes, and every path that changes it dirties this cache:
  // realtime events cover external writers (voice/MCP), and the hub's own write endpoints dirty it
  // synchronously so their immediate client re-fetch can't race the realtime round-trip.
  const nutDayCache = new Map();   // `${date}|${window day}` -> { body, at }
  const NUTDAY_BACKSTOP_MS = 15 * 60 * 1000;
  const dirtyNutDay = () => { nutDayCache.clear(); pushDay('nutrition'); };
  gated.get('/api/nutrition-day', timed(async (req, res) => {
    try {
      // date=today lets a client that has no 4am-origin day of its own (the watch) ask for the current one.
      const asked = String(req.query.date || '').slice(0, 10);
      const date = asked === 'today' ? nutritionWindow().day : asked;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
      const cacheKey = date + '|' + nutritionWindow().day;   // window day flips at 4am → isToday changes
      const hit = nutDayCache.get(cacheKey);
      if (hit && Date.now() - hit.at < NUTDAY_BACKSTOP_MS) return res.json(hit.body);
      const hh = String(DAY_START_HOUR).padStart(2, '0');
      const next = localDate(new Date(Date.parse(date + 'T12:00:00Z') + 86400000));
      const isToday = date === nutritionWindow().day;
      const SEL = 'id,occurred_at,name,calories,protein_g,carbs_g,fat_g,ingredients,staged,logged';
      const today = nutritionWindow().day;
      const [committed, stagedRows, targetRows, allIntake, weightRows, surplus] = await Promise.all([
        sbRange(`nutrition_entries?occurred_at=gte.${date}T${hh}:00:00&occurred_at=lt.${next}T${hh}:00:00&staged=eq.false&select=${SEL}&order=occurred_at`),
        // Staged meals (any day) always surface in the CURRENT day's list.
        isToday ? sbRange(`nutrition_entries?staged=eq.true&select=${SEL}&order=logged`) : Promise.resolve([]),
        sb('nutrition_targets?select=date,calories,override&order=date.asc'),
        sbRange('nutrition_entries?staged=eq.false&select=occurred_at,calories&order=occurred_at'), // full history → clusters + per-day maintenance
        sb('weight_log?select=date,weight_lbs&order=date.asc'),
        surplusCal(),
      ]);
      // Day total counts ONLY committed (eaten) entries — staged meals never count.
      let total_cal = 0, total_protein = 0, total_carbs = 0, total_fat = 0;
      for (const e of committed) {
        total_cal += Number(e.calories) || 0; total_protein += Number(e.protein_g) || 0;
        total_carbs += Number(e.carbs_g) || 0; total_fat += Number(e.fat_g) || 0;
      }
      total_cal = Math.round(total_cal);
      // Newest first: staged meals on top, then committed entries reverse-chronologically.
      const entries = (stagedRows || []).concat(committed.slice().reverse());
      // The most recent ADDITION to the log, staged or eaten — what the home wall's recent line shows.
      // Ordered by `logged` (when the row was written) rather than occurred_at: a staged meal's
      // occurred_at is the moment it was staged and means nothing about when it will be eaten, and a
      // meal logged now for this morning would otherwise never be the newest thing. Both columns are
      // naive-local strings in the same format, so they sort as text.
      const addedAt = (e) => String(e.logged || e.occurred_at || '').slice(0, 19);
      const recent = entries.length
        ? entries.reduce((a, e) => (addedAt(e) > addedAt(a) ? e : a))
        : null;
      // This day's GOAL via the SAME cluster-aware resolver the calendar + plot use, so the header
      // agrees with them: active run → maintenance+surplus (or stored target); an older cut →
      // maintenance−deficit; untracked → maintenance.
      const weights = (weightRows || []).map((r) => ({ date: String(r.date).slice(0, 10), weight: Number(r.weight_lbs) }));
      const { goalForDay } = buildGoalResolver({ rows: allIntake, weights, targets: targetRows, today, surplus });
      const target_cal = goalForDay(date);
      const target_override = (targetRows || []).some((r) => r.override && String(r.date).slice(0, 10) === date);
      const delta_color = target_cal > 0 ? calorieColor(total_cal / target_cal) : null;
      // Per-day macro GOALS = this day's calorie goal split by bodyweight as of this day.
      const wAsOf = weights.filter((w) => w.date <= date);
      const bw = wAsOf.length ? wAsOf[wAsOf.length - 1].weight : null;
      const target_macros = target_cal > 0 ? macroTargets(target_cal, bw) : null;
      // This day's produce, on the same fill gauges the rings draw for today. A surface that points the
      // rings at a selected day needs all SEVEN of them to move together — four macros from the totals
      // above and these three — or the mini rings would still be reporting today beside a day in July.
      // Committed entries only, exactly like the totals: a staged meal is never part of a day.
      const dayProduce = produceRoll(committed.flatMap((e) => (Array.isArray(e.ingredients) ? e.ingredients : [])));
      const produce = pace.computeFill(dayProduce, await produceTargets());
      const body = {
        date,
        total_cal, total_protein: Math.round(total_protein),
        total_carbs: Math.round(total_carbs), total_fat: Math.round(total_fat),
        target_cal, target_macros, target_override, delta_color, produce,
        entries, recent,
      };
      nutDayCache.set(cacheKey, { body, at: Date.now() });
      res.json(body);
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  }));


  // occurred_at is intentionally naive (no UTC offset) — a pure wall-clock reading, e.g.
  // "2026-07-04T10:43:14", with NO timezone concept attached at all. It should read whatever the
  // clock said on whatever device was actually doing the logging, wherever that was — never
  // converted to/from any zone. Browser writes (log-set, nutrition stage/commit) send their own
  // current wall clock as `client_now` (shared.js localNowNaive()); this only falls back to the
  // server's own naive-local reading when the client didn't supply one (e.g. an automated caller).
  const CLIENT_NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  function resolveNow(body) {
    const c = body && body.client_now;
    return typeof c === 'string' && CLIENT_NOW_RE.test(c) ? c : nowNaiveLocal();
  }

  // Repeat-a-set: log a new set for an exercise at the current time, reusing its weight and taking a
  // fresh rep count. Body: {exercise, weight_lbs, reps}. Realtime on `sets` re-pushes the dashboard,
  // so the heatmap, day detail, and rest timer all update live.
  gated.post('/api/log-set', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const exercise = typeof b.exercise === 'string' ? b.exercise.trim() : '';
      const reps = Number(b.reps);
      const weight_lbs = Number(b.weight_lbs);
      if (!exercise) return res.status(400).json({ error: 'exercise required' });
      if (!Number.isInteger(reps) || reps <= 0) return res.status(400).json({ error: 'reps must be a positive integer' });
      if (!isFinite(weight_lbs) || weight_lbs < 0) return res.status(400).json({ error: 'weight_lbs must be ≥ 0' });
      const occurred_at = resolveNow(b);
      await sbWrite('sets', 'POST', { occurred_at, exercise, weight_lbs, reps });
      dirtyWorkoutDay();   // synchronous — the client re-fetches the day immediately after this returns
      res.json({ ok: true, occurred_at });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Edit a single logged set's weight/reps by id. Body: {id, weight_lbs, reps}. Realtime on `sets`
  // re-pushes the dashboard (heatmap, day detail). Exercise/time are left untouched.
  gated.patch('/api/log-set', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const id = Number(b.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });
      const reps = Number(b.reps);
      const weight_lbs = Number(b.weight_lbs);
      if (!Number.isInteger(reps) || reps <= 0) return res.status(400).json({ error: 'reps must be a positive integer' });
      if (!isFinite(weight_lbs) || weight_lbs < 0) return res.status(400).json({ error: 'weight_lbs must be ≥ 0' });
      await sbWrite(`sets?id=eq.${id}`, 'PATCH', { weight_lbs, reps });
      dirtyWorkoutDay();   // synchronous — the client re-fetches the day immediately after this returns
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Nutrition invariant (mirrors the data-layer): every entry stores ≥1 ingredient and its totals are
  // the SUM of those ingredients. Each ingredient's calories = stated, else Atwater (4/4/9) from its
  // macros. A simple food collapses to one name-only ingredient. Enforced server-side so the stored
  // row can never drift from its breakdown, regardless of what a client sends.
  function atwaterCals(p, c, f) { return Math.round(((p || 0) * 4) + ((c || 0) * 4) + ((f || 0) * 9)); }
  function rollEntry(macros, rawIngredients, name) {
    const r10 = (v) => Math.round((Number(v) || 0) * 10) / 10;
    const norm = (g) => {
      const p = r10(g.protein_g), c = r10(g.carbs_g), f = r10(g.fat_g);
      const cal = (g.calories === null || g.calories === undefined || g.calories === '') ? atwaterCals(p, c, f) : Math.round(Number(g.calories) || 0);
      const o = { name: String(g.name || g.ingredient || name || ''), calories: cal, protein_g: p, carbs_g: c, fat_g: f };
      if (g.food != null) o.food = String(g.food);
      if (g.unit != null) o.unit = String(g.unit);
      if (g.amount != null && isFinite(Number(g.amount))) o.amount = Math.round(Number(g.amount) * 1000) / 1000;
      // Produce classification rides along with the ingredient. Both fields travel together or neither
      // does — a half-set pair would silently drop grams out of the day's produce total.
      if (PRODUCE_TYPES.includes(g.produce_type) && isFinite(Number(g.produce_g)) && Number(g.produce_g) >= 0) {
        o.produce_type = g.produce_type;
        o.produce_g = r10(g.produce_g);
      }
      return o;
    };
    const ings = (Array.isArray(rawIngredients) && rawIngredients.length)
      ? rawIngredients.map(norm)
      : [norm({ name, ...macros })];
    const t = ings.reduce((a, g) => ({
      calories: a.calories + g.calories, protein_g: a.protein_g + g.protein_g,
      carbs_g: a.carbs_g + g.carbs_g, fat_g: a.fat_g + g.fat_g,
    }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
    return { calories: Math.round(t.calories), protein_g: r10(t.protein_g), carbs_g: r10(t.carbs_g), fat_g: r10(t.fat_g), ...produceRoll(ings), ingredients: ings };
  }

  // Produce rollup — mirrors data-layer's produceRollup() exactly. Leafy greens count toward BOTH
  // dark_green_g and veg_g (dark green is a floor WITHIN the vegetable goal, not a separate bucket), so the
  // two are never summed together downstream.
  const PRODUCE_TYPES = ['dark_green_vegetable', 'other_vegetable', 'fruit'];
  function produceRoll(ings) {
    const r10 = (v) => Math.round((Number(v) || 0) * 10) / 10;
    const t = { veg_g: 0, dark_green_g: 0, fruit_g: 0 };
    for (const g of ings) {
      const grams = Number(g.produce_g) || 0;
      if (!grams || !g.produce_type) continue;
      if (g.produce_type === 'dark_green_vegetable') { t.dark_green_g += grams; t.veg_g += grams; }
      else if (g.produce_type === 'other_vegetable') t.veg_g += grams;
      else if (g.produce_type === 'fruit') t.fruit_g += grams;
    }
    return { veg_g: r10(t.veg_g), dark_green_g: r10(t.dark_green_g), fruit_g: r10(t.fruit_g) };
  }

  // Re-log a past food at the current wall-clock time — the hub's first write action.
  // Body: {name, calories, protein_g, carbs_g, fat_g, ingredients?} with macros already
  // scaled by the portion multiplier client-side. Stores occurred_at/logged as naive-local
  // "now" in the display TZ and date = the 4am-bucket day for now (so a 1–4am add lands on
  // the prior day, matching the rest of the hub).
  gated.post('/api/log-entry', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
      const calories = num(b.calories), protein_g = num(b.protein_g), carbs_g = num(b.carbs_g), fat_g = num(b.fat_g);
      if (!name) return res.status(400).json({ error: 'name required' });
      if ([calories, protein_g, carbs_g, fat_g].some((v) => v === null)) {
        return res.status(400).json({ error: 'calories/protein_g/carbs_g/fat_g must be numeric' });
      }
      const occurred_at = resolveNow(b); // this device's own wall clock, wherever it is
      const row = {
        id: crypto.randomUUID(),
        date: dayBucketOf(occurred_at),
        occurred_at,
        logged: occurred_at,
        name,
        quantity: 1,
      };
      // Totals = SUM of the ingredients; a simple food becomes one name-only ingredient.
      const rolled = rollEntry({ calories, protein_g, carbs_g, fat_g }, b.ingredients, name);
      row.calories = rolled.calories; row.protein_g = rolled.protein_g;
      row.carbs_g = rolled.carbs_g; row.fat_g = rolled.fat_g;
      row.veg_g = rolled.veg_g; row.dark_green_g = rolled.dark_green_g; row.fruit_g = rolled.fruit_g;
      row.ingredients = rolled.ingredients;
      await sbWrite('nutrition_entries', 'POST', row);
      dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
      await audit('add', row.id, null, row); // `row` is the full inserted snapshot (id known client-side)
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Edit an entry in place: PATCH {id, name?, calories, protein_g, carbs_g, fat_g, ingredients?}.
  // Absolute values, computed client-side (the popup recovers the original 1× and re-scales), so the
  // stored row and its name's "(N×)" suffix always reflect the real multiplier — never compounded.
  gated.patch('/api/log-entry', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const id = typeof b.id === 'string' ? b.id : '';
      if (!id) return res.status(400).json({ error: 'id required' });
      const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
      const calories = num(b.calories), protein_g = num(b.protein_g), carbs_g = num(b.carbs_g), fat_g = num(b.fat_g);
      if ([calories, protein_g, carbs_g, fat_g].some((v) => v === null)) {
        return res.status(400).json({ error: 'calories/protein_g/carbs_g/fat_g must be numeric' });
      }
      const rows = await sb(`nutrition_entries?id=eq.${id}&select=*`);
      const before = (rows || [])[0];
      if (!before) return res.status(404).json({ error: 'not found' });
      const newName = (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : before.name;
      // Totals = SUM of ingredients (the popup sends them; if absent, the macros become one ingredient).
      const rolled = rollEntry({ calories, protein_g, carbs_g, fat_g }, b.ingredients, newName);
      const patch = { calories: rolled.calories, protein_g: rolled.protein_g, carbs_g: rolled.carbs_g, fat_g: rolled.fat_g, veg_g: rolled.veg_g, dark_green_g: rolled.dark_green_g, fruit_g: rolled.fruit_g, ingredients: rolled.ingredients };
      if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
      await sbWrite(`nutrition_entries?id=eq.${id}`, 'PATCH', patch);
      dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
      await audit('edit', id, before, { ...before, ...patch });
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Delete an entry: DELETE ?id=<uuid>. Snapshots the full row first so the audit `before`
  // can fully re-insert it.
  gated.delete('/api/log-entry', async (req, res) => {
    try {
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await sb(`nutrition_entries?id=eq.${id}&select=*`);
      const before = (rows || [])[0];
      if (!before) return res.status(404).json({ error: 'not found' });
      await sbWrite(`nutrition_entries?id=eq.${id}`, 'DELETE', undefined);
      dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
      await audit('delete', id, before, null);
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Commit a staged meal from the UI: flip staged→false and stamp it "now" so it logs as eaten and
  // starts counting. Realtime on nutrition_entries re-pushes the dashboard.
  gated.post('/api/commit-staged', express.json(), async (req, res) => {
    try {
      const id = typeof (req.body && req.body.id) === 'string' ? req.body.id : '';
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await sb(`nutrition_entries?id=eq.${id}&staged=eq.true&select=*`);
      const before = (rows || [])[0];
      if (!before) return res.status(404).json({ error: 'staged meal not found' });
      const occurred_at = resolveNow(req.body);
      const patch = { staged: false, occurred_at, logged: occurred_at, date: dayBucketOf(occurred_at) };
      await sbWrite(`nutrition_entries?id=eq.${id}`, 'PATCH', patch);
      dirtyNutDay();   // synchronous — the client re-fetches the day immediately after this returns
      await audit('edit', id, before, { ...before, ...patch });
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Feed the cat feeder. The feeder is LAN-only and this server runs on Fly, so we can't dispense
  // directly — enqueue a command the Pi collector (on the LAN) claims and executes within seconds.
  gated.post('/api/feed', express.json(), async (req, res) => {
    try {
      let portions = parseInt(req.body && req.body.portions, 10);
      if (!Number.isFinite(portions) || portions < 1) portions = 1;
      portions = Math.min(12, portions);
      await sbWrite('feeder_commands', 'POST', { action: 'feed', portions, source: 'hub-web', status: 'pending' });
      res.status(202).json({ ok: true, portions });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return { CLIENT_NOW_RE, dirtyNutDay };
};
