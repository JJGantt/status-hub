# Status Hub — Ideas & Roadmap

Raw ideas, unfiltered: drop them in the **Inbox**, and move them into a section below once
shaped. Nothing here is a commitment or a status — an item may already be built, dropped, or
overtaken. **[docs/TODO.md](docs/TODO.md) is the tracked open work**; this file is upstream of it.

Architecture principle, since it constrains what any of these can look like: **server computes,
clients render** — logic and derived display values (colors, labels, formatted strings, pace state)
live in the hub payload; the clients only paint.

---

## Inbox (unsorted — drop raw ideas here)

- **AI feature buttons (per-tab one-off voice commands).** Each tab (nutrition, workout, …) gets a
  button → voice → a command run with a **feature-specific system prompt**, so the user gives only the
  payload, not instructions. Nutrition: press → say "banana" → prompt knows it's a food to log
  (estimate macros, log it). Workout: press → say "dumbbell press 10 times 8" → prompt knows it's a
  set + the shorthand convention. Rides the existing `voice_requests` queue and workers.
  OPEN: **define the workout shorthand** ("10 times 8" = ? reps × ? lbs — needs the exact
  convention defined).

- **One-tap undo** (built on the `nutrition_audit` before/after log): a
  "Undo last action" affordance that reverses the most recent hub write — re-insert a deleted row from
  `before`, revert an edit to `before`, delete an add via `after.id`. Until built, reversal is manual
  (read the audit log, reverse the action). Could generalize to other tables later.

- **General-purpose life calendar**: one calendar that incorporates everything — food + workouts +
  weight + whatever — rather than a separate heat map per domain. The `/calendar` month view carries
  only dated list items.

- **A focused Claude Code session on the wall, live.** The sessions wall shows a session's
  conversation; this would instead put the real session in a web terminal (xterm.js, PTY over a
  websocket to the Mac running `claude --resume <id>`), with the desk's Terminal tab closed first so
  exactly one process writes the session (two `--resume` on one id interleave and corrupt it).
  Switching back reopens a Terminal tab on the same id. OPEN: PTY-over-websocket choice (ttyd /
  wetty / custom).

---

## Nutrition: AI meal/snack suggestion to close the macro gap  *(idea)*

A headless Claude call (refreshed ~every 30 min, displayed in the nutrition area) that, given the
macros currently *down* vs target (from the pace rings), suggests a specific meal/snack **with
portions** that would bring the macros closest to perfect *right now*. Inputs:
- The current macro deficits (which of cal/protein/carbs/fat are behind, by how much).
- The **nutrition log history** → infer ingredients likely on hand. Build an "ingredient heatmap"
  (most-frequently-logged ingredients = most likely available) and tell Claude to **prioritize
  those** ingredients so the suggestion is actually makeable.
Output: a concrete food + portion sizes optimized to fill the remaining macro gap. Cheap headless
call, low frequency. (Surfaces the suggestion; no auto-logging.)

## Nutrition: predictive quick-log (one-press repeat logging)  *(idea)*

Take the LLM **out of the loop** for routine/repeat entries. An entry identical to
yesterday's (e.g. the same breakfast every morning) should need no speech or description — just a tap.

- **Predict from time-of-day + history:** cluster past entries by (time-of-day window, item/macro
  signature). When the current time matches a frequent pattern, surface that entry as a **one-press
  quick-add**, pre-filled with the usual macros. E.g. ~morning → a "Overnight oats" button already
  loaded with the exact macros from the recurring entry.
- Show the top 1–3 likely items for the current window; tap = logged, no LLM call.
- Pure quick-add of a *known* entry. The LLM stays only for genuinely novel foods.
- Complements the AI meal suggestion (that's "what *should* I eat to fill the gap"; this is
  "you're about to log the thing you always log — here's the button").
- **Powered by the add-at-now repeat counts (BUILT add feature feeds this).** Now that re-adding an
  item logs the exact same food, we accumulate per-item frequency + the median time-of-day it's
  logged. That history is the prediction signal: "this item is logged ~9am almost every day."
- **Proactive forgot-to-log prompt:** at the predicted time, surface "Want to add Overnight oats?"
  — in-app, and as a **push notification** so a forgotten morning log gets
  caught even if the app isn't open. One tap logs it. This is the catch-net for forgetting, distinct
  from the "you're behind pace" nudge (that says *eat/log something*; this says *add THIS specific
  thing you always have now*).

## Nutrition: combined calorie+weight plot  *(idea)*

ONE plot, shared time x-axis, **dual y-axis** (calories left / weight right, each auto-scaled),
dashed **maintenance** reference on the cal axis, labeled axis ticks + legend + current-value
annotations. Same footprint, readable. Purpose: *see the energy-balance loop* (cal-avg above
maintenance → weight rises). Each point = trailing-7-day avg ending that day. CONFIRMED behaviors:
today excluded (finalized days only, by date); averages only LOGGED days (skips no-log days, doesn't
zero them); **NO outlier rejection** in the display (the weekly avg must include real highs/lows —
outlier rejection lives only in the TDEE/maintenance estimate). Weight line: RAW daily weigh-ins
(the bumps/variance are wanted), plotted against the smoothed 7-day calorie average.

## Per-exercise progression view  *(idea)*

Tonnage/load is only meaningful **per-exercise** (like-for-like), not aggregated. Filter to one
exercise → chart over time:
- **Tonnage** (Σ lbs×reps per session), **top-set weight**, and/or **estimated 1RM** — the
  progressive-overload signal. Clean because you compare the movement to itself.
- Bodyweight lifts (weight_lbs=0): track reps (and any added load) instead of pounds.
- Hangs off the drill-down: muscle → exercise → this progression chart (next to the variant links).

**Workout heatmap stays on set-count (decided).** A mode toggle to color the aggregate heatmap by
*tonnage* was considered and **rejected**: aggregate tonnage is dominated by heavy compounds (one
RDL set dwarfs many lateral-raise sets), reads bodyweight lifts as zero work (weight_lbs=0), and
sums non-comparable pounds into a physiologically meaningless number. Sets are roughly commensurable
across exercises — which is why set-count is the standard weekly-volume metric and the right heatmap
coloring. Tonnage's home is the per-exercise view above.

## Notifications  *(idea)*

Push kinds not built yet (APNs push from the hub and the litter watcher's alerts already exist):

- **Litter level ≤ 75%** → push.
- **Nutrition pace nudge — "bars too low."** When the pace rings drain too far behind (e.g. nothing
  logged by noon, or significantly behind pace), push a nudge. The signal is dual-purpose: it means
  either something was **forgotten in the log** something or a meal is genuinely **due** — either way, act.
- **Predictive "want to add X?" push** (see Predictive quick-log) — at the median time a recurring item
  is usually logged, push "Add Overnight oats?" so a forgotten routine log is caught even with the app
  closed; one tap logs it. Catch-net for forgetting, distinct from the behind-pace nudge.
- Quiet hours so it never nudges overnight.

Open decisions:
- Notification intensity: gentle (noon check + litter only) vs active (pace pokes through day).

---

## Infrastructure / Architecture

- **Old workout tables** — `workout_sessions`, `exercises`, `exercise_sets` are still in Supabase
  alongside `sets`, which everything reads and writes. Drop them only with the owner's explicit OK.
