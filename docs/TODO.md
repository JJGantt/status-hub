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

## Failed dispatches have no surface yet

The plumbing is done: anything that could not run is kept whole in `desk_dead_letters`, and
`GET /api/failures` + `POST /api/failures/:id/{retry,dismiss}` are live. Nothing renders it — a
saved prompt is currently only visible by asking the API.

What it needs: a row in the sessions pane when the list is non-empty (count + the label or first
words of each), a retry button per entry, and a dismiss. Retry re-dispatches the payload unchanged
and points follow-ups at the new session; it refuses while the machine is still down.

Worth adding at the same time: a push when one is recorded. Failing "loudly" currently means the
spoken reply says so at that moment — which is enough when Jared is listening and nothing at all
when the failure comes from a machine dying later.

## Timezone — reminders still assume Eastern

**Logging is already correct** and needs nothing: commit `7672ce4` (data-layer, Jul 4) removed the
hardcoded zone from `now()`/`toEastern()`, and `voice_requests.client_now` threads the requesting
device's own wall clock through. Workouts and nutrition stamp in real local time.

**Reminders are not.** `server/lib/dates.js` has `let TZ = process.env.TZ_DISPLAY || 'America/New_York'`
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

### Task scoring — a third band on the health bar

Designed, agreed, not built. The health bar becomes thirds: nutrition, training, and **tasks**
(gold, `#e6b93d`), where the task band is earned by completing dated list items and drained by
neglecting them. Its purpose is to make scheduling something and then doing it feel like it paid.

**The band starts empty and is earned.** Not a percentage of tasks completed, and no neutral
baseline — with nothing scheduled the gold is simply absent. A baseline would remove the only
incentive the band exists to create, which is putting things on the list in the first place.

Completing on time is worth full value; completing progressively later is worth less and eventually
negative; anything past due and untouched drains continuously with no action needed. Every effect
fades linearly to nothing over seven days, matching the rolling week the nutrition and training
bands already look back over — so a hit's size, not a separate rule, decides how long it is felt.
An item marked important counts more in both directions and changes nothing else (not the push).

**Untimed vs timed.** A date-only `due` is on time any moment before the day ends (the 4am
boundary); a timed one is on time until its moment plus a short grace. Date-only items already
*fire* at 9am (`dueMoment`) — the firing time and the deadline are different questions about the
same value, and that is deliberate.

#### There is exactly one way to remove an item, and the clock decides what it means

Removing an item that is **not yet due** scores nothing. Removing one that is **already past due**
scores it. That single rule is what makes one verb sufficient.

The attractive alternative — a `complete` verb beside a `cancel`/`delete` verb — does not survive
contact with speech. "Remove", "delete", "clear", "check off", "done" and "scratch that" are not
separable in how a request actually arrives, so a model choosing between two tools will mis-route
them indefinitely, and the mis-route silently awards or withholds points. Making the *timing* carry
the meaning removes the choice entirely: nothing has to be disambiguated because nothing is
ambiguous. It also answers the case that motivated wanting a second verb — putting something on the
list, learning it is moot, and taking it off — which is free, because it was never overdue.

Do not reintroduce a second removal verb without solving that routing problem first.

#### Recurrence is materialised, not a repeating row

`repeat_every` goes away. "Every day for the next month" is a scheduling instruction executed once,
producing thirty independent dated items; nothing downstream knows they share an origin except a
series id carried on the rows.

This is what makes scoring tractable. A repeating row's `due` marches into the future the instant it
fires, so "which occurrence was just completed" has no answer without an occurrence ledger, and its
`scheduled_at` sits permanently in the past, so a naive drain would bleed forever from an item that
is working correctly. Materialised occurrences have neither problem — every item is a one-shot.

Consequences that are deliberate, not oversights:

- **A missed series compounds.** Seven skipped days is seven separate drains, not one. They are
  separate events and behave separately.
- **The instruction must carry a horizon.** "Every day" alone has no stopping point, and a
  background job quietly topping the list up forever is the kind of thing that breaks silently.
  Absent a horizon it takes a default month, and the items are visible so the commitment is too.
  Running out is a re-up prompt, not a failure.
- **The list gains bulk.** The todo pane needs a near horizon by default rather than every
  materialised row, and the series id is what lets the pane collapse a series and lets the whole
  thing be killed in one go. It is also what keeps item resolution exact: the model reads a due list
  scoped to today and overdue and passes an id, rather than matching on a title.

The existing `repeat_every` users (`AFF`, `TOLLS`) get materialised once and the column dropped.
Leaving both mechanisms running is how two ways of expressing recurrence end up disagreeing.

#### Storage

Completions need a ledger of their own. Cleared items are hard-purged after 30 days
(`purgeCleared`), so a score read off the item row would silently shift when the purge ran. The
drain is the opposite — it is derived live from open dated items and never stored.

#### Surfaces

The bar renders in three places and all three need the third band: the TV wall (vertical), the
portrait phone-wall (horizontal, a **separate** CSS layout in `app.css`), and the iOS widget
(`Controls/RingsView.swift`, which caps at two-thirds until it is updated). `cards/score.js` already
floats a delta pill whenever the overall moves, so the reward animation needs nothing new.

The phone's todo pane has no health bar at all; adding one there is a separate decision.

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
Partly landed as two of the walls: the sessions wall (`/tv-session-focus`) is where a long answer
can actually be read, and the calendar wall (`/tv-calendar`) puts every dated item on the TV. Still
open from the original request: *undated* lists and general text on a wall, and the **automatic**
mode entry — switching when a turn used only read tools and no write tools ("this was a question,
not an action"). Today switching is explicit voice only (`set_wall`).

Also queued from the same conversation (2026-09-01): condense the standard wall into a denser
default that includes calendar components, and slim the rings/health bar on the non-standard walls —
they stay on every wall, but smaller.

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
