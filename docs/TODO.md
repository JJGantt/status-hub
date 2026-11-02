# Open work — notifications, reminders, surfaces

Running list so nothing gets lost between sessions. Newest context at the top of each item.
Companion to [ARCHITECTURE.md](../ARCHITECTURE.md) and [HUB-INTERNALS.md](HUB-INTERNALS.md).

---

## Blocked on Jared

### Xcode developer-account login is rejected
`Unable to log in with account 'jaredgantt@gmail.com'` on any build that needs a **new or updated
provisioning profile**. Existing profiles still work from cache, so ordinary builds succeed — this
only bites when an entitlement changes. A new bundle id does not need it: register it with
`apps/tools/asc.mjs bundle-id` and the CI archive makes its profiles.

**Fix:** Xcode → Settings → Accounts → sign in again.

**What it's gating:**
- **Time Sensitive Notifications** — the only way a normal push breaks through a Focus. The
  capability is *not* available in the App Store Connect API (verified: 28 valid `capabilityType`
  values, none of them this), so it must come from the portal or Xcode. The server **already sends**
  `interruption-level: time-sensitive` on every reminder; iOS ignores it without the entitlement, so
  it starts working the moment the capability exists — no code change. The entitlement line sits in
  `apps/project.yml` as a TODO.

---

## Retire the transitional credentials

- **`?token=` on API calls.** Every client this repo and its neighbours control sends `X-Hub-Token`
  now; the hub still accepts the device token in the query string and logs `[auth] ?token= on <path>`
  once per boot per path (`fly logs -a jared-status-hub | grep '\[auth\] ?token'`). When a day passes
  with none, delete that branch of `hubGate` and the query half of `auth.deviceRequest`. The kiosk's
  page-load exchange (`/tv?token=` → cookie → redirect) stays: a browser can only be given a URL.
- **`X-Owner-Key` on `/api/cg/*`.** The Menu app should send `X-Owner-Token` instead (the change is
  described in HUB-INTERNALS § Auth, the cg paragraph). Once no build in use sends the Anthropic key,
  delete `CG_OWNER_KEY_SHA256` and the `x-owner-key` half of `cgOwner` in `routes/public.js`.

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

### Sleep: prove it on the phone, then use it (built 2026-10-30, builds 139/140)
`docs/SLEEP.md`. Nothing has run on the device yet. After installing: allow Sleep on the Health sheet,
then check `sleep_samples` fills (the first run backfills the whole history in 500-sample pages) and
that a new night arrives the morning after via background delivery, with no app open. The endpoint
has never taken a real post. Then the uses he named: history, trends, a morning summary. A live
"fell asleep" signal is dropped (see Dropped).

### Watch speak mode: first real test (built 2026-10-30, build 140)
`docs/WATCH.md` § Speak mode. Untested on the wrist. Check: the hold toggles with the haptic and the
white glyph; a reply is read wrist-down with the screen off; a reply to a session sent from the watch
is read while another page is showing; the `<speak-mode>` note never shows on the phone, wall or
watch; replies actually come back shorter; and how fast the battery goes with it on.

### Unread answers and their push: first real test (built 2026-10-29, build 138)
`docs/WATCH.md` § Unread answers. Nothing has run on the devices yet; the first flagged answer is the
test. Check: the push arrives titled with his question; it is dropped unshown on the watch with home in
front and the wrist up (`answer-push` in the watch log), which is unproven for a notification the phone
forwards; a swipe on the watch reaches the app through `customDismissAction` and clears the amber dot;
a tap lands home on the answer. Reading an answer on the watch leaves its notification in Notification
Center; nothing removes it yet.

### Live mic: two-way audio (on hold, Jared's call)

Watch to phone as well, with a switch per direction on both devices. Both microphones are already on
during a stream, so the hub would gate what it forwards rather than either device starting the other's
mic. Open questions before building: echo when both directions play (needs voice processing on the
phone, which also thins the room sound), and whether a streamed upload from the watch works or it has to
post a chunk every quarter second.

### Live mic: hear what voice processing cuts

Jared wants to hear exactly what Apple's voice processing removes before deciding whether the live mic
gets a Voice mode beside Room (docs/LIVE-MIC.md § Room, not voice). Record the same scene both ways
(`.default` vs `.voiceChat` / `setVoiceProcessingEnabled(true)` on the input node) on the phone and on
the watch, and play them side by side. Check first whether the input node's voice processing is
available on watchOS at all.

### Capture the surf forecast more often, and keep one capture a day old

Both come out of the backtest in `docs/ALARMS.md` that rejected the wind-upgrade rule, and both matter
whatever is built on top of the forecast.

Captures are a median **8 hours** apart (p90 16 h, max 45.7 h), so the forecast the alarm decides on at
5am is a median **14.5 hours old in June-August** — from the previous afternoon. Nothing clever
downstream recovers that; capturing on a tighter cadence is the largest single improvement available to
the alarm.

Separately, nothing here ever scores a morning against a SETTLED rating. The last capture covering an
hour lands a median 7.5 hours after it, and 26% of hours whose last capture says Fair did not say Fair
in the one before — so "Surfline revised it to Fair" can be a flip that flips back. Keeping a capture
at least 24 hours after each hour would give a stable label to measure any future rule against; today
there is exactly one such hour in 2520.

`surf-report` owns the capture schedule.

### Confirm the iPhone honours the recorder's bitrate

The phone clip that overflowed Groq's cap arrived at ~1,500 kbps; desktop WebKit records the same
setup at ~224 kbps, so something about the iPhone's recorder is different and it has not been
measured. The recorder now asks for 96 kbps (`VOICE_BPS`). Read the next phone clip's line in
`fly logs -a jared-status-hub | grep voice-command`: roughly 100-120 kbps means the setting is
honoured; ~1,500 means Safari ignores it and only the server's re-encode (`lib/transcribe.js`) is
keeping long commands working — then the cause on the phone is still open.

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
- **`important` is score-only.** It does not change the push. Deliberate for now.
- **There is no "important appointment".** `priority` is one axis carrying important / normal /
  exempt, because it is one choice made once at scheduling time. Wanting both would mean a second
  column, not a fourth value.
- **The day timeline's spine always spans at least 7a-10p** on the calendar wall and the phone
  (`routes/lists.js`, the `loT`/`hiT` bounds; it widens for earlier or later items, and the home wall's dial
  uses a rolling window around now instead), so a day whose items span 1p-5p spends twelve rows on
  nothing. Fitting the window to the content (plus padding around now) would give every hour more
  room, but it changes what the column means and should be its own decision.
- **Completed items are kept forever.** Only deleted ones are purged (30 days). If the calendar ever
  gets heavy, the fix is to bound what the calendar QUERIES, not to start deleting history.
- **Series editing is all-or-nothing.** `remove_from_list` with `series` clears what is left; there
  is no "make it every other day instead" short of clearing and re-adding.
- **Nothing tops a series up.** A month-long daily item simply runs out, which is a re-up prompt
  rather than a failure — but if it turns out to be annoying, the fix is a horizon reminder, not a
  background job that quietly extends lists forever.

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

### Sounds for the other notification kinds
Only the reminder bell (`apps/Sounds/reminder.caf`) was auditioned and chosen. Weight reminders and
voice acks still use the system default. `NOTIFY_STYLE` in `server/routes/notify.js` is where a kind's sound
is declared; the file must be bundled in the app or iOS silently falls back.

### Prune dead APNs tokens
Nothing removes a row from `device_tokens` when APNs answers `410 Unregistered`, so a token from a
build that is no longer installed keeps being sent to. Delete a token when APNs answers 410.

---

## Dropped (deliberately, not forgotten)

- **Live "fell asleep" signal from the watch** (2026-10-30) — Jared's call. Apple writes a night's
  sleep stages only after he wakes, and the only live route is the watch app in workout mode reading
  heart rate all evening plus a Sleep Focus automation to start it. He wants it only if Apple hands it
  over cleanly; it does not, so nothing auto-turns the TV off at sleep onset.
- **Sub-minute look-ahead scheduler** — Jared's call. The alarm ringers hold their own timers to the
  second, and for plain push reminders a 60s scan is fine.
- **Live Activities** — "not that important" for now. Worth knowing if it comes back: 8h hard cap
  (~12h with the stale period), so it can never be a permanent display; and the **iPhone 12 Pro Max
  has no Dynamic Island**, so it would be Lock Screen only. Best fit is a countdown *timer*; second
  best is a single "N overdue" card. Needs push-to-start since reminders fire with the app closed.
