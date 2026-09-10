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

## Deployed on purpose, and meant to come out

### `/api/tapdebug` — the voice button's tap tracer

`server.js` has a route that logs whatever the client posts to it, and `voiceagent.js` posts every
pointer event and recorder state change to it. It exists because the button's behaviour was only
reproducible on Jared's phone, and reading `fly logs -a jared-status-hub | grep tap` is the only way
to see what that device actually did.

It has already earned its keep — it is what showed the freeze was in the page, not the recorder. The
one use left is confirming the Lock Screen / Control Center Record control reaches the web recorder in
the build installed on his phone: that control fires `window.__startVoiceCommand()` rather than a
touch, so it logs `start:arming` with **no `pointerdown` in front of it**. Once that is seen, delete
the route and the `trace()` calls.

## Not started

### Countdown on the red always-on border

The footer's red border (`cards/routing.js`, from `wake` in `routingConfig()`) means only "always-on
is off". It cannot tell the auto-brake from a manual off, and it says nothing about when the brake
releases. Jared wants the time remaining shown on it.

Once the worker persists its release time (voice-pipeline `docs/TODO.md`, "Countdown on the red
blocked state"), `routingConfig()` ships `braked` plus that time. The settings refresh already
delivers it, and `routing.js` paints the countdown. Do not compute it here from `voice_presence`:
the thresholds would drift from the worker's, and realtime on that table fires on every voice match.
Any wording beyond the bare time is Jared's.

### Surf grid guides vanish over the white 0-1 ft band

The noon, 6a/6p and now lines are white, so they disappear over a white 0-1 ft cell and are faint
over the pale 1-2 ft blue. The size ramp was just rebuilt (white, then OKLCH-even blues); the guide
ink over the light end has not been decided.

### Task band — tuning, and the surfaces it has not reached

The scoring itself is built and live (`lib/score.js`, data-layer `00085`-`00087`; how it works is in
[HUB-INTERNALS.md](HUB-INTERNALS.md) §4 and §6). What is left:

- **The constants have had their week of real use, once.** `TASK_RATE` went 8 → 2.5 → 4: 8 was
  unreachable (the band sat under 15% on days that had gone fine), and 2.5 turned out to be *under*
  the real rate of 2.1-2.7 units/day, so the band parked itself near full. 4 is set from that
  measurement and wants the same check after a week. The late-completion curve and the drain rate
  are in the same block and have not been re-measured against real days at all.
- **What happens below empty is undecided.** The level floors at zero today, so a badly neglected
  week and a catastrophically neglected one look the same once the band is drained. Whether that
  should carry a further consequence — bleeding into the other bands, or a separate marker — is
  deliberately open, not overlooked.
- **The phone's todo pane has no health bar at all**, so there is no gold on it. Jared's call
  whether that pane should grow one — it is a new surface there, not a colour change.
- **`important` is score-only.** It does not change the push. Deliberate for now.
- **There is no "important appointment".** `priority` is one axis carrying important / normal /
  exempt, because it is one choice made once at scheduling time. Wanting both would mean a second
  column, not a fourth value.
- **The day timeline's spine is hardcoded 7a-10p**, so a day whose items span 1p-5p spends twelve
  rows on nothing. Fitting the window to the content (plus padding around now) would give every hour
  more room, but it changes what the column means and should be its own decision.
- **Completed items are kept forever.** Only deleted ones are purged (30 days). If the calendar ever
  gets heavy, the fix is to bound what the calendar QUERIES, not to start deleting history.
- **Series editing is all-or-nothing.** `remove_from_list` with `series` clears what is left; there
  is no "make it every other day instead" short of clearing and re-adding.
- **Nothing tops a series up.** A month-long daily item simply runs out, which is a re-up prompt
  rather than a failure — but if it turns out to be annoying, the fix is a horizon reminder, not a
  background job that quietly extends lists forever.

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

Undated items now include his NOTES (data-layer 00092): list items whose `text` is a paragraph
rather than a line. So this is not a wall of one-liners, and whatever draws it has to decide what a
long body does at TV distance.

Also queued from the same conversation (2026-09-01): condense the standard wall into a denser
default that includes calendar components, and slim the rings/health bar on the non-standard walls —
they stay on every wall, but smaller.

### The dial's date header sits on top of the oldest hours
`.cw-dayhead` on the home wall is absolutely positioned over the top-left of the day column, because
putting it in the flow moves the axis off the middle of the box and the now-line stops being centred
(the reasoning is in `tv-home.css` where the rule is). It covers about 34px, which is always the four
oldest hours in the window, and the fourth of those is tall enough to hold an item — so a completed
10a chip, already flattened to a colour bar at that distance, showed through "Tue, Sep 8" as a stray
fragment of colour and read as a rendering fault (2026-09-08).

Giving the header a background is not the fix: that hides the item outright, which is worse than
clipping it. Something that keeps the axis centred is: the date in the empty hour gutter, a smaller
header, or reserving the same height at the bottom of the box so the middle stays the middle.
Jared's call which.

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
