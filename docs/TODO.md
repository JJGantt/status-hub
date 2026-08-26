# Open work — notifications, reminders, surfaces

Running list so nothing gets lost between sessions. Newest context at the top of each item.
Companion to [ARCHITECTURE.md](../ARCHITECTURE.md) and [HUB-INTERNALS.md](HUB-INTERNALS.md).

---

## Blocked on Jared

### Xcode developer-account login is rejected
`Unable to log in with account 'jaredgantt@gmail.com'` on any build that needs a **new or updated
provisioning profile**. Existing profiles still work from cache, so ordinary builds succeed — this
only bites when an entitlement or bundle id changes.

**Fix:** Xcode → Settings → Accounts → sign in again.

**What it's gating:**
- **Time Sensitive Notifications** — the only way a normal push breaks through a Focus. The
  capability is *not* available in the App Store Connect API (verified: 28 valid `capabilityType`
  values, none of them this), so it must come from the portal or Xcode. The server **already sends**
  `interruption-level: time-sensitive` on every reminder; iOS ignores it without the entitlement, so
  it starts working the moment the capability exists — no code change. The entitlement line sits in
  `apps/project.yml` as a TODO.
- Any **new extension target** (a new bundle id needs a new profile).

---

## Timezone — reminders still assume Eastern

**Logging is already correct** and needs nothing: commit `7672ce4` (data-layer, Jul 4) removed the
hardcoded zone from `now()`/`toEastern()`, and `voice_requests.client_now` threads the requesting
device's own wall clock through. Workouts and nutrition stamp in real local time.

**Reminders are not.** `server/server.js` has `const TZ = process.env.TZ_DISPLAY || 'America/New_York'`
and `TZ_DISPLAY` is unset on Fly, so it is hardcoded Eastern. That single constant drives:
- `etStringAt()` / `etNowString()` → reminder firing and the badge overdue check
- `lib/weightReminder.js` → the daily weigh-in time
- the 4am eating-day boundary

Consequence: travel and a 4pm reminder fires at 4pm **Eastern**, not 4pm where you are.

**Wanted semantics** (Jared, explicit): wall-clock. A reminder set for 4pm should fire at 4pm
*wherever he is*, not at the original absolute instant.

**Approach:** same shape as `client_now` — have the phone report its IANA timezone, persist it
(`app_settings`, or alongside `device_tokens`), and have the hub compare against that instead of the
constant. Falls back to Eastern when unknown.

---

## Not started

### Voice → "go build this" (Jared's, 2026-08-25 — the shape he wants)

**The goal in one line:** one spoken command sends a feature off to be built on a repo, autonomously,
and he can walk away from it.

The always-on voice pipeline already transcribes and routes. The missing piece is a **data-layer MCP
tool** — `start_session(repo, prompt)` — that the router can call. It enqueues a `desk_commands` row
exactly like the hub's repo picker does, and `pi-desk` picks it up.

- **The router can stay Sonnet.** It is doing traffic direction, not the work. It only has to spot
  "in my status-hub repo, do the following…", pull out the repo name, and pass the rest through.
- **Send the transcript verbatim.** Strip the addressing preamble ("hey, in my X repo, send this
  prompt"), then forward what he actually said, unsummarised. The session on the other end is a
  capable model; it does not need the request pre-digested, and summarising is where intent is lost.
- **Default to the Pi, always — even when the Mac is awake.** This is the deliberate inversion of the
  current fallback rule, and the reason is the point of the whole feature: work started by voice is
  long-running, and closing the laptop must not kill it. The Mac stays preferred only for iOS, where
  the local compile loop is worth having (see the Pi's own CLAUDE.md).

**Open: how to surface that something is running.** He wants a subtle, ambient indicator — that
background work is in flight, and on which repo. Remote Control is the way to *look inside* a session;
this is the lighter question of knowing one exists at all. Candidates, unresolved:
- a strip on the phone wall / TV wall listing live sessions and their repos
- the Projects widget marking a repo that has a session running
- `worker_presence`-style rows per live session, so any surface can read them

`pi-desk` already names its tmux sessions `hub-<repo>-<id>`, so the live set is enumerable on the Pi
(`tmux ls`) without inventing new bookkeeping — that is probably the cheapest source of truth.



### AlarmKit — the real alarm
Breaks silent mode **and** Focus, full-screen stop/snooze UI, Lock Screen + Watch. iOS 26+ only;
device confirmed on **26.6**, so it's available. One-time permission prompt, no Apple approval
(unlike critical alerts).

Architectural consequence: AlarmKit alarms are scheduled **on-device**, not pushed. So the Fly
watcher's job changes from "push at due time" to "wake the app when a reminder is created, app
schedules the alarm locally." Upside: once set it fires exactly on time with no dependence on
network or server.

Open design question: which items are alarm-grade vs plain push. Likely a flag on `list_items` set
from Jared's wording ("timer", "alarm", urgency). A soup timer should ring through Focus; "pick up
dry cleaning" at 2am should not.

**Where it plugs in:** `DUE_HANDLERS` in `server.js` (added with the reminders merge) is the seam —
`dueTick` finds due items and dispatches to a named handler instead of calling `pushAll` directly.
AlarmKit becomes an entry there rather than surgery on the loop. Note the architectural wrinkle still
stands: AlarmKit schedules on-device, so its "handler" is really "wake the app so it can schedule
locally", not "deliver now".

Unverified: whether AlarmKit can schedule from a **background** wake (vs only with the app open).
Not documented either way — needs an on-device test.

### The Pi / TV wall second mode
**Jared's original request, still untouched.** Everything built so far has been the phone half.

Wanted: reserve space on the wall for reminders, lists, and general text — including a place to
actually *read* a response when he asks a question ("what did I do last for chest press?"). Today
that answer flashes at the bottom of the wall and disappears.

Shape discussed: keep the current nutrition/workout display as the default, add a **second mode**
that makes room for a text pane. Entered either by explicit voice command ("show me this on the
display") or **automatically when a turn used only read tools and no write tools** — Jared's own
proposed heuristic for "this was a question, not an action."

### Sounds for the other notification kinds
Only the reminder bell (`apps/Sounds/reminder.caf`) was auditioned and chosen. Weight reminders and
voice acks still use the system default. `NOTIFY_STYLE` in `server/server.js` is where a kind's sound
is declared; the file must be bundled in the app or iOS silently falls back.

### Prune dead APNs tokens
`device_tokens` still holds the June Ad Hoc token (`8d7df828…`, production, last seen Jul 4). APNs
returns `410 Unregistered` for it on every send, so every push logs a half-failure. Delete a token
when APNs answers 410.

### TestFlight migration
The build on the phone is an Xcode/**sandbox** build, signed with the team development profile
(`aps-environment: development`). It expires around **June 2027**, and push dies with it. Already
flagged in ARCHITECTURE.md §9; the App Store `.ipa` and production entitlement are prepared.

---

## Dropped (deliberately, not forgotten)

- **Sub-minute look-ahead scheduler** — Jared's call. If AlarmKit schedules on-device the precision
  is already there, and for plain push reminders a 60s scan is fine.
- **Live Activities** — "not that important" for now. Worth knowing if it comes back: 8h hard cap
  (~12h with the stale period), so it can never be a permanent display; and the **iPhone 12 Pro Max
  has no Dynamic Island**, so it would be Lock Screen only. Best fit is a countdown *timer*; second
  best is a single "N overdue" card. Needs push-to-start since reminders fire with the app closed.
