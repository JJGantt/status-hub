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

Open decisions:
- All four bars (cal/protein/carbs/fat) or just calories + protein?
- History window for the curve: rolling ~30 days (recommended) vs all-time weighted.

---

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

---

## Done

- Web hub: litter, nutrition (4am-day window), adaptive maintenance, last-7 workouts; SSE live.
- Adaptive maintenance (energy balance, recency-weighted, outlier rejection, cold-start gate).
- Dynamic macro goal: protein 1.0 g/lb, fat 0.4 g/lb (≥20% cal floor), carbs flex; synced to MCP.
- Native SwiftUI iOS app + native macOS app (shared sources), SSE live, Keychain auth.
- Header-token auth on the hub for the native apps.
