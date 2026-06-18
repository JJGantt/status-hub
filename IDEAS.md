# Status Hub — Ideas & Roadmap

Running backlog for the Status Hub product (web hub + iOS app + macOS app, all over the
one `/api/status` contract). Raw ideas go in the **Inbox**; once shaped, they move into a
section below. Architecture principle: **server computes, clients render** — logic and
derived display values (colors, labels, formatted strings, pace state) live in the hub
payload; the clients only paint.

---

## Inbox (unsorted — drop raw ideas here)

-

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
- **wake / bed are adjustable fields** (default e.g. 7a–11p).
- **No "about to drop off" for food** — that's workout-only. Food ticks down smoothly, resets
  each morning. Nutrition = within-today pace; Workouts = 7-day rolling volume (different time
  logic, intentional).
- Daily goals already persisted (dated `nutrition_targets` rows) for look-back; linear bar only
  needs today's goal + wake/bed + clock.

---

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

## Workouts — Gamified Volume (sets per muscle)  *(planned — big edit)*

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
- **Starting targets** (editable per muscle, tune by recovery/response):
  side_delts 18, rear_delts 14, front_delts 8, lats 16, mid_back 14, upper_traps 8,
  upper_chest 12, lower_chest 10, biceps 14, triceps_long 10, triceps_lateral 10, forearms 8,
  quads 14, hamstrings 12, glutes 12, gastrocnemius 14, abs 12, obliques 8.
- **Hard 7-day rolling window, no decay** — set counts fully for 7 days then drops off; this is
  what enables the "about to expire tomorrow" gray preview. (Not recency-weighted — goal is fixed.)

## Body Heatmap — anatomical muscle visualization  *(planned — ambitious, feasible)*

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

## Notifications  *(designed, not built — needs APNs key + always-on sender)*

Real APNs push (works with app closed). Prereq: a one-time APNs Auth Key (.p8) from the
Apple Developer portal. Sender lives in an always-on service (litter watcher already is;
hub would need to not auto-suspend for nutrition nudges).

- **Waste drawer full** → push.
- **Litter level ≤ 75%** → push.
- **Nutrition pace nudge** — e.g. nothing logged by noon, or significantly behind pace.
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
