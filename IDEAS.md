# Status Hub — Ideas & Roadmap

Running backlog for the Status Hub product (web hub + iOS app + macOS app, all over the
one `/api/status` contract). Raw ideas go in the **Inbox**; once shaped, they move into a
section below. Architecture principle: **server computes, clients render** — logic and
derived display values (colors, labels, formatted strings, pace state) live in the hub
payload; the clients only paint.

---

## Inbox (unsorted — drop raw ideas here)

- **★ PRIORITY — Pi-display Claude conversation viewer.** The Pi wall display (`/tv` kiosk) gets an
  area showing a live Claude conversation (at minimum the latest assistant response + last user
  prompt; scrolling transcript TBD). An **MCP tool sets the "active Pi-display session"** — e.g.
  "make this my active Pi display" → tool records which session to show. Source = the session's
  JSONL transcript (Claude Code writes one per session at `~/.claude/projects/<enc-cwd>/<id>.jsonl`,
  appended live). Two host cases: (a) **Mac-hosted** session → Pi reads the Mac's JSONL (Pi↔Mac SSH,
  or a tiny Mac server tails+streams it); (b) **Pi-hosted** session (Pi runs its own `claude` session)
  → read locally. Display is **non-interactive on the Pi**; the **phone app is the remote control**
  (start a Pi-hosted session, switch active session, etc.).
  OPEN DESIGN QUESTIONS: (1) the model can't reliably self-identify its own session ID → the
  "set active" tool should resolve "the current session" by **most-recently-active transcript**
  rather than needing an explicit ID. (2) **Data path**: local-only (Pi tails Mac JSONL via SSH /
  small Mac streamer) vs relayed through Fly/Supabase — lean LOCAL (keeps transcripts off the cloud;
  but note the Fly hub can't read the Mac filesystem, so the conversation is a separate local data
  path the Pi composes alongside the `/tv` page). (3) shared "active session" pointer could live in
  Supabase (both Mac+Pi can read) even if the transcript itself stays local.

- **AI feature buttons (per-tab one-off agent calls; mainly the phone app).** Each tab (nutrition,
  workout, …) gets a button → voice (or text) → a **one-off headless Claude call with a feature-
  specific system prompt** so the user gives only the payload, not instructions. Nutrition: press →
  say "banana" → prompt knows it's a food to log (estimate macros, log it). Workout: press → say
  "dumbbell press 10 times 8" → prompt knows it's a set + the shorthand convention. **Never-fail /
  offline-safe**: don't call Claude directly from the phone — **enqueue the request in Supabase**
  (`{feature, text, ts, status}`); a **worker on Mac and/or Pi (whichever is online) claims & runs**
  the headless Claude (with the data MCP) → logs → marks done. If no worker is up, it stays pending
  and runs when one comes online — a queued call is never lost.
  OPEN: (1) **define the workout shorthand** ("10 times 8" = ? reps × ? lbs — need Jared's exact
  convention). (2) **on-device iOS speech-to-text** (send text) vs server STT (send audio) — lean
  on-device (no audio upload, no server STT dependency). (3) needs the **native app updated** first.

- **Pi wall-display: dedicated `/tv` kiosk route** (after the layout redesign). Old TCL LCD on the wall,
  driven by the Raspberry Pi running **Chromium in kiosk mode** (`--kiosk --app=https://jared-status-hub.fly.dev/tv`;
  persistent profile so the auth cookie sticks). The Pi is just a thin display client — hub lives on
  Fly, so Pi flakiness only blanks the screen, never affects data. The `/tv` route **reuses the same
  `/api/status` data + card render functions**, but with a TV-tuned container + theme: **pure-black bg
  (#000)**, **16:9 fill, no scroll** (everything fits one frame, auto-scaled), **larger type** for
  across-the-room legibility, **passive** (no hover/click). Burn-in: TCL = LCD → non-issue; dark theme
  already helps; optional pixel-shift / nightly display-off (`vcgencmd display_power` or HDMI-CEC) if
  ever wanted. Build after the redesign so it reuses the new card/row structure rather than redoing it.

- **One-tap undo** (future; enabled by the `nutrition_audit` before/after log being built now): a
  "Undo last action" affordance that reverses the most recent hub write — re-insert a deleted row from
  `before`, revert an edit to `before`, delete an add via `after.id`. Until built, reversal is manual
  (read the audit log, reverse the action). Could generalize to other tables later.

- **Petlibro feeder integration** (wants to tackle soon): surface the automatic pet **food feeder**
  (Petlibro) status in the hub's top **home-status row** alongside the Litter-Robot — e.g. last feed
  time, portions dispensed, hopper/food level, errors. Needs API access: Petlibro runs on Tuya cloud;
  likely an unofficial API / Tuya IoT integration to investigate (no official public API). Companion to
  the litter watcher — both are "pet hardware status." Lives in the new thin status row (see layout).

- **General-purpose calendar** (future): the workout "last 7 days" strip was replaced with a
  GitHub-contribution-style volume heatmap (week columns, cell darkness = that day's set count).
  Later we may want a fuller calendar that incorporates everything — food + workouts + weight +
  whatever — a single general-purpose life calendar, not just workouts.
- Maintenance/Goal panel removed from the hub UI (the maintenance computation still runs and
  drives the dynamic nutrition target; just not displayed). Could re-add a compact version later.

- **Voice pipeline: speaker verification (reject the TV, only respond to me).** The ESP32 voice
  pipeline (`~/repos/voice-pipeline`, Fly app `jared-voice`: mic → wss → openWakeWord → Groq STT →
  transcript) currently endpoints on an **adaptive ambient-energy floor** (Option A) — works because
  my voice at the mic beats the TV across the room on loudness. It does NOT know *whose* voice it is,
  so a TV could (rarely) trip the wake word or a loud TV moment could muddy a capture. The robust fix
  is **speaker verification**: enroll a short sample of my voice → a voiceprint (embedding, e.g.
  resemblyzer / ECAPA-TDNN) → gate captured utterances on "is this Jared?" before acting. Solves both
  TV false-triggers AND distinguishing me from any other voice — by voice *characteristics*, not just
  loudness. Heavier, separate layer; only build if the TV actually starts tripping it. Pairs with the
  AI-feature-button / headless-Claude work since the transcript is the shared input.

---

## Pacing / Gamification HUD  *(designed, not built)*

A persistent "where I should be vs where I am" display for calories + macros, derived from
my own logging history. Survival-game metaphor: bars **drain** as the day advances past my
typical intake pace and **refill** when I log.

- **Expected-pace curve:** from history, cumulative % of daily total consumed by each hour
  (e.g. 15% by 9a, 40% by 1p, 70% by 6p, 100% by 10p), from `occurred_at` timestamps.
- **Bar = actual ÷ expected-by-now:** ~1.0 on pace (green/full), below pace drains
  (yellow→red), above pace = ahead. Logging refills instantly.
- **Self-reinforcing loop:** logging on time → cleaner timestamps → sharper curve → more
  trustworthy HUD → more reason to log on time. The drain is the nudge.
- **Deliberately fuzzy:** tolerance band, smoothed over weeks. A gauge, not a stopwatch.
  Handles pre-logging (fills early) and late logging (catches up retroactively).
- **Server-side:** hub computes each bar's level + color + behind/ahead state; clients render.

**RESOLVED:**
- **All four bars** (cal/protein/carbs/fat) — all matter.
- **Pace model = time-based linear, NOT historical curve.** `expected by now = goal ×
  (now − wake)/(bed − wake)`. Chosen over a historical-habit curve because the system should
  pull toward the *ideal* (even intake — protein distribution across ~4 feedings maximizes MPS),
  not enshrine current clumping. Smooth continuous decline, all four; bar sinks between meals,
  logging pops it up → encourages frequent even top-ups (the optimal pattern).
- **Eating window (not wake/bed), auto-derived from history:** the pace runs first-entry →
  last-entry (when you actually eat), which is more correct than wake/bed (no false "behind"
  every morning). Use **median** first/last entry over rolling ~30d (robust to outlier days),
  auto-updating, with a **manual override**. Window = data-derived; distribution within it =
  aspirational-linear (the window is a real constraint; the spread is the behavior we're shaping).
- **No "about to drop off" for food** — that's workout-only. Food ticks down smoothly, resets
  each morning. Nutrition = within-today pace; Workouts = 7-day rolling volume (different time
  logic, intentional).
- Daily goals already persisted (dated `nutrition_targets` rows) for look-back; linear bar only
  needs today's goal + wake/bed + clock.

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

Take the LLM **out of the loop** for routine/repeat entries. If I'm logging the same thing as
yesterday (e.g. overnight oats every morning), I shouldn't have to speak or describe it — just tap.

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
  logged. That history is the prediction signal: "you log overnight oats ~9am almost every day."
- **Proactive forgot-to-log prompt:** at the predicted time, surface "Want to add Overnight oats?"
  — in-app, and (when push is built) as a **push notification** so a forgotten morning log gets
  caught even if the app isn't open. One tap logs it. This is the catch-net for forgetting, distinct
  from the "you're behind pace" nudge (that says *eat/log something*; this says *add THIS specific
  thing you always have now*).

## Nutrition: log view (intake history)  *(idea)*

A general way to view the intake log over time — separate from the live pace HUD. Folds into the
Nutrition Row expand levels (Expand 1 = previous days, Expand 2 = individual entries).

- **A heatmap is probably NOT right here** (unlike workouts): I eat ~every day at ~similar amounts,
  so a density grid of "did I eat" carries little signal.
- **The macro-carryover science dictates the framing** (settled — don't relitigate):
  - **Calories = weekly-average game.** Body weight/fat tracks the *weekly* energy-balance average;
    daily swings wash out. Show calories as a rolling 7-day average, not a per-day pass/fail.
  - **Protein = daily game.** No protein storage; a surplus day does NOT bank for a deficit day
    (excess is oxidized/stored as fat, nitrogen excreted), and an under-protein day is a real miss.
    So surface **daily protein hit/miss consistency** (a streak/strip of "cleared protein target?").
  - **Carbs = in between.** Stored as glycogen (~400–500g muscle + ~100g liver) so a high day tops
    off tomorrow's training fuel; true excess beyond glycogen+energy → fat (DNL minor in normal
    eating). Daily for performance, weekly for body comp.
- **Likely shapes:** per-day protein hit/miss strip (the hero), rolling 7-day calorie-average line,
  tap a day → its entries (reuse the workout day-detail inline pattern).

### Nutrition Log v2 — refinements  *(v1 BUILT: trend sparklines + protein calendar + tap-day entries; these queued behind the hub refactor)*

- **Combined calorie+weight plot** (replaces the two separate sparklines): ONE plot, shared time
  x-axis, **dual y-axis** (calories left / weight right, each auto-scaled), dashed **maintenance**
  reference on the cal axis, labeled axis ticks + legend + current-value annotations. Same footprint,
  readable. Purpose: *see the energy-balance loop* (cal-avg above maintenance → weight rises). Each
  point = trailing-7-day avg ending that day. CONFIRMED behaviors: today excluded (finalized days
  only, by date); averages only LOGGED days (skips no-log days, doesn't zero them); **NO outlier
  rejection** in the display (the weekly avg must include real highs/lows — outlier rejection lives
  only in the TDEE/maintenance estimate). Weight line: RAW daily weigh-ins (Jared wants to see the bumps/variance), plotted against the
  smoothed 7-day calorie average.
- **Calendar coloring — DECIDED: calorie-based, diverging scale.** Color each day by calories vs that
  day's **historical** target (Jared's call over protein: he wants to spot stretches of consistently
  under/over, and it pairs with clicking a day to see the full calorie breakdown). Scale: **blue =
  under (cold) → green = on target → yellow → red = over (hot)**, diverging around green, with a
  distinct deep-red for far-over. Historical target: targets table is sparse (calories constant 2650
  so far) → use most-recent-prior snapshot per day; PLUS **persist a dated target row every day going
  forward** (the maintenance sync) so real per-day targets accumulate once intake data flows.
- **Muscle-map coloring — KEEP red-under→green→blue-over (not flipping).** Jared mused about making
  blue=under everywhere for consistency. Recommendation: don't — the metrics differ. Muscle volume is
  "fill toward a goal," where LOW is the alert state, so red-when-low (loud) is correct and blue-when-
  low would wrongly read as calm. Calories are symmetric deviation around a target, so blue↔red around
  green fits. Different color logic because different meaning. (Revisit only if Jared wants uniformity.)
- **Day detail: all macros.** Day total shows cal + P + C + F (not just protein+cal); each entry too.
- **Per-ingredient breakdown — DECIDED, BUILDING.** Added `ingredients` JSONB to `nutrition_entries`
  (migration 00014; shape `[{name, calories, protein_g, carbs_g, fat_g}]`, null for simple/historical
  entries). The logging LLM (MCP `log_nutrition`) populates it for composite foods **going forward**;
  old aggregate entries (omelet/oats) won't have it. The hub expands an entry → shows the breakdown
  when present. Each ingredient is itself addable as its own entry (see quick-add).
- **Add-at-now quick-add — DECIDED. First hub WRITE action.** Each entry gets an "add" button → a
  confirm popup that re-logs it at the **current wall-clock** time (NOT the viewed day). The popup:
  (a) a whole-entry **portion multiplier** (default 1; +/− or text box; fractional ok), AND (b) if the
  entry has an `ingredients` breakdown, the **editable ingredient list** — each ingredient's quantity
  adjustable and each with **its own add button** (add just that ingredient at now). Add/Cancel.
  INSERT new `nutrition_entries` row(s) with macros × factor at now. **Name is ANNOTATED** with the
  portion (e.g. "Overnight oats (½×)") so a half-portion is never mistaken for a full one. (`quantity`
  is always 1 today and macros are totals, so factor scales macros directly — Jared already does this
  by hand, e.g. the "half portion oats" entry.) Needs an auth'd write endpoint on the hub.

## Nutrition rings → pace rings (fill + sweeping marker)  *(proposed — pending confirm; queued hub build)*

Reconceive the P/C/F rings from the current *deviation-from-pace* gauges into Apple-Watch-style
**pace rings**: fill arc = **consumed ÷ daily goal** (full circle = goal), PLUS a **sweeping marker
line** showing where you should be by now. Marker = fraction of the **eating window** elapsed
(history-derived ~8a–10p, not the 24h clock), sweeping **clockwise from the top**, completing a full
circle at window-end (= your goal = "don't eat past this line"). Fill color: green at/ahead of the
marker, red as it falls behind, amber once past goal. Server adds per-macro consumed/goal fill +
a shared `pace_frac` (pace.js already computes the window fraction). Touches `lib/pace.js` +
`public/cards/nutrition.js`. OPEN: keep the consumed/goal **bars** (ring=glance, bar=exact) or drop
them as redundant — lean keep.

## Muscle drill-down: what hits each muscle  *(idea)*

- **Muscle Volume card:** make each muscle gauge **clickable/expandable** → reveals the exercises
  that contribute to it, ordered by contribution (1.0 primary movers first, then the 0.5
  secondaries), each labeled with its value. (Data already exists in `exercise_muscles`.)
- **Body map:** hover/tap a region → tooltip or panel naming the muscle + the same exercise list.
  Feasible — SVG `<path>`s can carry titles and click handlers (we already make heatmap cells
  clickable the same way).
- **BUILT:** muscle (map region or volume row) → its exercises (colloquial names, primary/secondary
  by dimness) → tap an exercise → its muscles + equipment **variants** → tap a variant → YouTube
  "how to" search. The remaining unbuilt piece of the drill-down is the **per-exercise progression
  view** below.

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

## UI Structure: Expandable Rows  *(planned — replaces the card grid)*

Move from little filling cards to **thick rows**, each progressively expandable. Applies to
web + iOS + macOS.

- **Collapsed row:** all the basic info currently on the card.
- **Expand 1:** historical look-back (default 1 week).
- **Expand 2:** granular detail (individual entries / per-muscle breakdown).
- Look-back applies to *everything*, expandable out to **all data + aggregations** (not just a week).

## Nutrition Row  *(planned)*

- **Collapsed:** calories consumed / goal, plus protein / carbs / fat consumed / goal — all in
  the one row.
- **Maintenance folded in** (no separate card): show the goal (e.g. 2650) and indicate inline
  that it's a **+150 surplus**, so maintenance is derivable in-head.
- **Editable surplus** — tapping the surplus lets me change it (this is the first *write*
  interaction; see Infrastructure note).
- **Expand 1:** previous days — calories + macros hit each day.
- **Expand 2:** individual entries — exactly what I ate and when.

## Workouts — Gamified Volume (sets per muscle)  *(gauges DONE; heatmap pending)*

**Status:** per-muscle volume gauges live on the hub (server/volume.js) — weekly Σ(set×contribution)
vs uniform 14 target, grouped Legs/Push/Pull/Core, color by ratio, with a striped "drops off
tomorrow" segment. Real-time refresh locked in (30s server re-push when clients connected, so the
pace drain + volume drop-off update live, not just on DB edits). Body heatmap = next, derived from
this same volume data.

Gamify weekly training volume **by sets per muscle**, using the existing
`exercise_muscles(name, muscle, contribution)` map (24 exercises → 18 muscles; contribution =
per-set value, e.g. Curls→biceps 1.0, Rows→biceps 0.5).

- **Weekly volume per muscle** = Σ (sets × contribution) over a 7-day look-back.
- **Target ≈ 20 sets/muscle/week** (TBD — discuss the right number; may vary by muscle).
- **Progress bar per muscle**: 10/20 → 50%. Doing sets fills it; as days age out of the 7-day
  window, volume drops back off.
- **Forthcoming-decrease indicator**: a grayed portion of the bar showing sets about to expire
  *tomorrow* (because they fall out of the look-back). Lets me decide to refill tomorrow or
  **overfill today** to keep the muscle steady.
- **Goal = keep every muscle steadily hit** near target, not spiky.
- Expandable per muscle (which exercises contributed, when).
- 18 muscles tracked: abs, biceps, forearms, front_delts, gastrocnemius, glutes, hamstrings,
  lats, lower_chest, mid_back, obliques, quads, rear_delts, side_delts, triceps_lateral,
  triceps_long, upper_chest, upper_traps.

**RESOLVED:**
- **Per-muscle targets, not a flat 20** (goal = pure hypertrophy). Evidence: 10–20 sets/wk/muscle
  is the responsive range; more helps with diminishing returns (Pelland 2024/25 meta); frequency
  ~irrelevant when volume equated; lagging/indirect-starved muscles want more, recovery-limited or
  indirect-heavy ones want less. Age 40 + surfing (delt/lat/leg fatigue) + lean-bulk surplus →
  aim MAV (productive middle), not MRV. Targets are in *effective sets* (Σ sets × contribution),
  which already folds in indirect work.
- **Uniform target (~14 effective sets/wk for ALL muscles), NOT a hand-tuned per-muscle spread.**
  Research establishes the *range* (10–20) but NOT precise per-muscle optima — those come from
  practitioner heuristics (RP landmarks), not RCTs. An earlier per-muscle table was retracted:
  it (a) inflated upper_chest circularly ("it lags") and (b) double-counted by lowering targets
  for indirect-heavy muscles — wrong, because the contribution model already puts indirect work in
  the COUNT. With a uniform target, indirect-heavy muscles (front_delts, traps) auto-hit target
  from compound work = the system tells you they need no direct work; under-supported muscles
  (side/rear delts, calves) sit low until trained directly. No guessing.
- **NO output/growth feedback loop (unlike nutrition).** Nutrition closes a loop because we
  measure the output (weight); the workout system measures only the INPUT (sets logged) — we
  do not measure muscle growth, so targets canNOT self-correct from response. Earlier claim
  that "the gamified loop tunes the targets" was wrong (imported nutrition logic). Consequence:
  the target must be a **fixed research-based prior**, and research doesn't support a per-muscle
  spread → **uniform ~14**. A spread would encode guesses, not evidence.
- **What the gamified loop actually does:** adherence + coverage — ensures you accumulate target
  volume on every muscle and nothing drifts undertrained/lopsided. NOT target discovery.
- **Targets editable, but tuning is manual/subjective** (mirror, perceived development, per-lift
  strength trend as weak proxy) — not data-driven. Real per-muscle feedback would require a new
  output signal (girth measurements, progress photos, strength-trend proxy) — possible future, not now.
- **LOCKED: default 14 effective sets/week for every muscle, each independently adjustable.**
  Implementation: per-muscle target config (Supabase, defaults to 14); adjusting a muscle is a
  write action (same pattern as the editable surplus).
- **Hard 7-day rolling window, no decay** — set counts fully for 7 days then drops off; this is
  what enables the "about to expire tomorrow" gray preview. (Not recency-weighted — goal is fixed.)

## Body Heatmap — anatomical muscle visualization  *(DONE — coarse asset; granular parked)*

**CURRENT (live):** react-muscle-highlighter (soroojshehryar, **MIT**, NOTICE credits it).
Coarse front+back SVG, `bodymap.js` (viewBox `0 0 1448 1448`, 154 paths, slug per region).
Anatomically CORRECT: abs central, obliques on the sides, adductors + lower-back distinct.
Coloring = `volume.js` `REGION_MAP` worst-of (region inherits lowest-ratio of its muscles).
Folds (accepted tradeoff): deltoids = front+side+rear heads; upper-back = lats+mid_back;
chest = upper+lower; triceps = both heads; tibialis shows calf color; hip_flexors has no
region (gauge-only). Client paints `path[data-r=slug]` from `volume.regions`.

**PARKED ALTERNATIVE — vulovix/body-muscles (Apache-2.0), if we want max granularity back:**
- 89-region front+back SVG, viewBox `0 0 72 93`, format `{id,name,path}` in
  `src/data/muscles.front.ts` / `.back.ts`. Separates EVERY muscle distinctly: side delts
  (`shoulder-side-*`), front (`shoulder-front-*`), rear (`deltoid-rear-*`), lats
  (`lats-upper/mid/lower-*`), upper/lower chest, both triceps heads.
- **Why we left it:** (1) it MISLABELS the upper six-pack as `obliques` and tags only the lower
  belly `abs`; (2) NO true side-waist oblique region exists; (3) fiddly. Verified by rendering.
- **To switch back:** it's in git history (commit "Swap body heatmap to vulovix..."). Regenerate
  `bodymap.js` from its muscles.front/back.ts; restore the client `muscleForId()` (prefix map:
  shoulder-side→side_delts, lats-*→lats, chest-upper→upper_chest, triceps-long→triceps_long,
  gluteus→glutes, calves|tibialis→gastrocnemius, lower-back→erectors, adductors→adductors,
  hip-flexor→hip_flexors, AND `obliques`→`abs` to fix the mislabel); have `volume.js` emit
  per-muscle `muscle_colors` (keyed by our slug) instead of region worst-of.
- **Rendering check tip:** headless Chrome screenshots the SVG faithfully (qlmanage/librsvg don't):
  `Chrome --headless --screenshot=out.png --window-size=W,H file.html` with the svg inlined.

(original design notes below)
## Body Heatmap — design notes

A front/back anatomical diagram of the muscular system where each muscle is colored by its
weekly volume ratio. Glance to see what's under-hit ("oh fuck, that's deep red"). Becomes the
hero of the workouts row.

- **Mechanism:** SVG with one path per muscle, `id` = our muscle name. Hub computes a color per
  muscle (server-computes principle); the diagram paints by id. Front + back views cover all 18.
- **Color scale (diverging):** under-target → red, on-target → green, well-over → cool tint
  (blue/violet) so over-hit reads differently. Opacity/dimming for barely-touched. Color, not
  partial-fill (fill-height looks gimmicky).
- **Asset is the real work (one-time):** need an SVG detailed/labeled to our muscles. Our list is
  fine-grained (triceps_lateral/long, upper/lower chest, front/side/rear delts); stock body-maps
  are coarser → likely **aggregate for the visual** (color "triceps" by long+lateral combined)
  while the fine data stays in the expandable detail. Source from open-licensed SVG + hand-label.
- **Rendering:** web = inline SVG (trivial). iOS/macOS = SVGView (MIT, native) preferred, or a
  contained WebView of the same SVG as fallback.
- **Interaction:** collapsed = worst-off muscle; expand = full body; tap a muscle = its history.

## Workout data-model migration: flat timestamped sets  *(DONE — old tables pending drop)*

**Status:** migrated & deployed. `sets` table live with all 1159 historical sets; workouts.ts +
MCP tools + hub card + legacy HTTP all on the new model; volume verified. **Old tables
(workout_sessions, exercises, exercise_sets) intentionally left intact — drop only on explicit OK.**
**MCP tools update next session restart** (running process still has the old session tools; don't
log workouts via them post-migration or data lands in the old tables — log via the `sets` model).

Abandon the session structure. Session grouping was only for push/pull/legs classification,
which is now derived from exercises' muscles, so the session table is dead weight.

- **New `sets` table** (flat, append-only): `occurred_at` (naive-local timestamp, like nutrition),
  `exercise`, `weight_lbs`, `reps`. Drop `set_num` (derive order from timestamps). Optional
  `muscles_override` only as a one-off escape hatch.
- **Keep catalog normalized** (`exercise_catalog`, `exercise_muscles`) — muscles join at read
  time, NOT baked per-set (the mapping is a model we'll refine; baking would freeze stale values).
  Unknown exercises get a catalog entry created on the fly.
- **Migrate history**: flatten sessions→exercises→exercise_sets into `sets`; past sets get
  date-only timestamps (no intraday time / no rest-timer for history). Keep old tables until
  verified, then drop ONLY with explicit OK.
- **Rewrite `workouts.ts`**: volume = Σ(sets × contribution) over trailing window via join.
- **MCP**: `log_set` (one/many, stamps now), catalog create/edit tools, rework list/get, retire
  session tools, UPDATE tool descriptions for the new flow.
- **Hub workout card** (server.js) must move to the new model too.
- **Unlocks:** rest timer (time since last set) + workout-time signal for the nutrition curves.

## Notifications  *(designed, not built — needs APNs key + always-on sender)*

Real APNs push (works with app closed). Prereq: a one-time APNs Auth Key (.p8) from the
Apple Developer portal. Sender lives in an always-on service (litter watcher already is;
hub would need to not auto-suspend for nutrition nudges).

- **Waste drawer full** → push.
- **Litter level ≤ 75%** → push.
- **Nutrition pace nudge — "bars too low."** When the pace rings drain too far behind (e.g. nothing
  logged by noon, or significantly behind pace), push a nudge. The signal is dual-purpose: it tells me
  I either **forgot to log** something or genuinely **need to eat** — either way, act.
- **Predictive "want to add X?" push** (see Predictive quick-log) — at the median time I usually log a
  recurring item, push "Add Overnight oats?" so a forgotten routine log is caught even with the app
  closed; one tap logs it. Catch-net for forgetting, distinct from the behind-pace nudge.
- NOT litter-stuck (happens every cycle — too noisy).
- Quiet hours so it never nudges overnight.

Open decisions:
- Notification intensity: gentle (noon check + litter only) vs active (pace pokes through day).

---

## Infrastructure / Architecture

- **Lift color/label rules into the API payload** (currently duplicated in `Theme.swift` and
  the web JS). Hub sends computed hex + labels; clients render. Do as part of HUD work.
- **Monorepo consolidation** (proposed): fold `status-hub-ios` into `status-hub/apps/`, move
  server to `status-hub/server/`, repoint Fly deploy. One repo, atomic cross-cutting changes.
- **App icon** — both apps still use the default placeholder.
- **Hub/MCP day-boundary inconsistency** — the hub buckets nutrition by the 4am rule (read-time);
  the MCP's `get_nutrition` groups by the stored midnight `date` column. So an entry logged
  12am–4am shows on different days across the two surfaces. Fix: apply the same 4am read-time
  bucketing in the data-layer's `getNutrition` (don't change storage). Reconciles the surfaces.
- **Write actions** — the editable surplus is the first *write* from the clients. Today the
  hub is read-only display. Need: a settings store (Supabase, e.g. `surplus`), a write endpoint
  on the hub (auth'd via the same token), and `maintenance.js` reading surplus from there
  instead of the hardcoded const. Opens the door to other in-app edits later.

---

## Done

- Web hub: litter, nutrition (4am-day window), adaptive maintenance, last-7 workouts; SSE live.
- Adaptive maintenance (energy balance, recency-weighted, outlier rejection, cold-start gate).
- Dynamic macro goal: protein 1.0 g/lb, fat 0.4 g/lb (≥20% cal floor), carbs flex; synced to MCP.
- Native SwiftUI iOS app + native macOS app (shared sources), SSE live, Keychain auth.
- Header-token auth on the hub for the native apps.

---

# ★ Voice → Claude → Pi-wall system  (spec — designed 2026-06-19, not yet built)

A hands-free voice assistant displayed on the Pi/TV hub. Voice → text → a Claude that runs
MCP actions (and can drive real Mac coding sessions on the wall). Designed end-to-end below;
build is phased (MVP = Phase 1).

## Pieces that already exist
- `jared-voice` (Fly): ESP32 I2S mic → `wss://jared-voice.fly.dev/ws/audio` → openWakeWord →
  Groq whisper → `handle_transcript(text)` (currently POSTs `{transcript,ts}` to optional WEBHOOK_URL).
  **The ws endpoint is currently UNAUTHENTICATED** (binds 0.0.0.0, no token) — must fix.
- Mac has whisper.cpp + ggml-small/medium models (used by Hammerspoon voice) → local STT is free.
- Hub web app (SSE + Supabase realtime), Pi kiosk planned (/tv). Native macOS app exists but is STALE.

## Core decisions (locked)
- **Two target modes for the display:**
  - **Default "hub session"** — lightweight Claude that does MCP actions (log food, lists, etc.),
    rendered as a CONVERSATION PANEL inside the web hub UI (always visible with the HUD).
  - **Focused Mac session** — a real Claude Code session shown in a web terminal (xterm.js).
- **Worker priority: Mac → Fly → Pi.** Pi is flaky (optional tertiary). Mac primary = filesystem access.
- **STT routing:** ESP prefers the **Mac over Tailscale/LAN when up** (audio stays local + the
  file-capable path never touches the cloud); falls back to `jared-voice` (Fly) only when Mac is down.
- **Queue, not webhook:** `handle_transcript` INSERTs into Supabase `voice_requests`; workers claim.
  Producer reads `worker_presence` heartbeats and stamps `assigned_to` = first alive of Mac→Fly→Pi
  (deterministic, gated on presence; reassign on claim-timeout for failure recovery).
- **Hub-session context (RESOLVED — no paid API):** Agent SDK needs `ANTHROPIC_API_KEY` → rejected.
  Worker = headless **`claude -p` on the subscription** (NOT `--bare`, which forces an API key); MCP via
  `--mcp-config` + `--strict-mcp-config`; `--output-format stream-json`.
  Context = **`--resume <hub_session_id>`** for the default session — small MCP calls keep a full day of
  turns well under compaction, and day-long context is the point ("that thing from earlier, do X").
  **Reset to a fresh session on inactivity (~2h gap) or a new day.** Per-machine session id (Mac's session
  can't resume on Fly → failover starts fresh, accepted). **Serialize hub turns** (one at a time) because
  there is NO session lock — concurrent `--resume` on one id interleaves/corrupts. Write each turn to
  `voice_messages` for the /tv panel. Focused Mac sessions also use `--resume` (your real sessions, full context).
- **set_focus MCP tool** — available to every Claude session (hub worker + Mac sessions). Flips a
  `voice_focus` row; the dispatcher routes the next transcript and the `/tv` view renders accordingly.
- **Focusable list = 5 most recent Mac sessions, NO filtering** (even 1-turn sessions count — a big
  one-shot prompt is a resume candidate). Auto-named, no rename ever required.
- **Session name = the `aiTitle` field** (record type `ai-title`) in each session `.jsonl`
  (`~/.claude/projects/<proj>/<id>.jsonl`); recency = file mtime. Voice addressing is FUZZY
  (match utterance against the 5 recent by keywords/project/position, not exact title).

## Mac-session handoff (the hard part — solved)
- **One live writer per session `.jsonl`.** No tmux (rejected — won't wrap all desk sessions).
  Handoff RELOCATES the single instance; it does not mirror two.
- **macOS app = orchestrator** (reason to finally update it):
  - **Watches `~/.claude`** → auto-registry of sessions (id, cwd, `aiTitle`, mtime). You open sessions
    however you like; they register automatically. No launching-through-the-app required.
  - **Switch focus → wall:** find the desk tab via `lsof <session>.jsonl` → pid → tty → match the
    **Terminal.app** tab with that tty (AppleScript exposes tab tty) → **close that tab** → wall web
    terminal connects to a Mac PTY running `claude --resume <id>` (now sole writer). Voice → PTY socket.
  - **Switch back → desk:** close the wall PTY instance → app opens a **new Terminal tab** (Cmd-T via
    System Events into the existing front window; new window only if none open) running `claude --resume <id>`
    in the session's cwd — "right back where it was."
  - Single writer always; fully hands-free (no "go close it at your desk").

## Pi display
- Split happens INSIDE the browser: the "Claude area" swaps between the **default-session panel**
  and an **xterm.js web terminal** (PTY-over-websocket to the Mac, runs `claude --resume`). HUD always
  visible; no native-window tiling, no toggling away from the HUD. Voice into the terminal = write bytes
  to the PTY socket (no xdotool/tmux), with an explicit "send/run that" to press Enter.

## Security
- **Auth the ESP→Fly ws** (device token; drop unauthed connects) — currently open = anyone can inject commands.
- **Least-privilege key** on the Fly box (insert-only into `voice_requests` via RLS) — never the service_role key.
- Mac PTY service = LAN/Tailscale-only + token. Audit all writes. Mac/Pi workers are pull-only (not exposed).
- High-privilege (file-editing) path is Mac-local only; Fly fallback is data-MCP-only (degraded).

## Open unknowns
- RESOLVED (Phase 0): Agent SDK is **API-key only** → use `claude -p` on the subscription. CLI confirmed to
  support `--mcp-config`/`--strict-mcp-config`/`--output-format stream-json`/`--resume`/`--continue`/
  `--append-system-prompt`. Auto-compact only near the limit; **no** sliding-window flag → manual recent-turns
  preamble. **No session lock** — two `--resume` on one id interleave/corrupt → orchestrator MUST guarantee
  one live process per session (close desk tab before wall resume = mandatory, not optional).
- STILL OPEN: Terminal.app AppleScript — new-tab-in-existing-window + reading each tab's `tty` (lsof→tty match).
- STILL OPEN: PTY-over-websocket choice for the web terminal (ttyd / wetty / custom).
- STILL OPEN: where a `rename` writes (overrides `aiTitle`? separate field?) so the watcher reads the right title.

## Build phases
- **Phase 0 — verify** the unknowns above (cheap probes; no commitment).
- **Phase 1 — MVP voice assistant (no focus/terminal):** Supabase schema (`voice_requests`,
  `voice_messages`, `worker_presence`, `voice_focus`); auth + enqueue in `jared-voice` (least-priv key);
  Mac-local STT (ESP→Mac whisper) + Mac worker (`claude -p` subscription + data MCP + recent-turns preamble) → `voice_messages`;
  hub `/tv` default-session panel + Pi kiosk; `jared-claude` Fly fallback container.
- **Phase 2 — focus + Mac sessions on the wall:** `set_focus` MCP tool + `voice_focus`; macOS app
  orchestrator (watch `~/.claude`, lsof→tty close, reopen tab); xterm.js web terminal → Mac PTY;
  HUD focusable list (5 recent) + in-browser view-switch; bring the macOS app up to date.
- **Phase 3 — polish:** ESP dual-endpoint (prefer Mac, fall back to Fly); Pi tertiary worker; tune the
  sliding-window size; "send/run that" voice grammar for the terminal.
