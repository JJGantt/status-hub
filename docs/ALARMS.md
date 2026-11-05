# Alarms

Two ringers, one rule. An alarm-marked item rings on the **TV** (`tv-ring.service` on the Pi) and on
**any open hub page** (`alarmclock.js`), and each one holds its own timer to the moment, so nothing has
to be delivered at the moment itself.

| | **The TV** | **The hub page** | **The watch app** |
|---|---|---|---|
| Rings via | `tv-ring.py` playing the tone through HDMI with `ffmpeg` | `alarmclock.js` playing the tone as a media element | `Watch/Alarm.swift`, the notification haptic on a loop |
| Needs | the Pi up and the TV on | the app open, screen on | the app in front |
| Covers | every alarm, whether or not the phone is open | the phone, whenever the app is open | the wrist, whenever the app is opened |

Under all three, `dueTick` sends the item's notification once at its moment.

## Answering it: Stop and Snooze, from anywhere

An alarm rings until its ITEM changes, so every way of answering it is a write to the item and every
ringer follows:

- **Stop** completes the item. **Snooze** moves it nine minutes from now (`/api/todos/snooze` with
  `minutes`), and for an alarm that moves `scheduled_at` as well as `due`, because the ringers ring from
  `when` (scheduled_at, else due). A snoozed alarm is still in the feed with its moment in the future,
  which every ringer reads as not ringing, and it rings again when that moment arrives — notification
  included, since the dedupe key carries the due.
- **The notification** carries the `ALARM` category: Stop and Snooze buttons, background actions on the
  phone and on the watch alike, so neither opens.
- **The hub page** — the phone app and every wall — covers itself with the alarm while it rings: its
  time, its name, SNOOZE and STOP, and nothing under it reachable.
- **The watch app** does the same (`AlarmView`), whichever page was open. It follows `/api/list-stream`
  while the app is in front and drops it when the app leaves; wrist down, the notification is the
  watch's alarm.
- **Voice**, or checking it off any list, completes it like Stop.

So a swiped-away notification loses nothing: opening the app on the phone or the watch while the alarm
rings lands on the alarm.

The page and the watch reload on the LIST stream (`hub:lists` on a page), which is what a Stop or a
Snooze changes and what `tv-ring` follows. The status stream also reloads the page, but its frame can
take tens of seconds to build, and an overlay waiting on it outlasts the TV's sound by that much.

A surf alarm's item is the user's once its moment has passed: the `item` output records the moment it
set (`state.at`) and never moves or deletes the item after it, so a later forecast or the wind veto
cannot undo a snooze.

## Nothing registers an alarm on the phone

**A sleeping phone cannot be told about a new alarm.** A push is the only way to reach it, and iOS
rations the background kind hard: four in a row were refused overnight, and a passive alert push
carrying `content-available` was refused too. A push to an ACTIVE app is not rationed at all. So an
alarm decided or moved at 4am reaches the phone only if the app is in front — which is the page clock,
already holding the stream.

**That is why AlarmKit is not used**, though it is the obvious tool: an alarm registered on the device
goes stale the moment the hub moves it, and its Stop button completes nothing, so stopping it would
leave the TV ringing. A phone alarm that is not the app is the Clock app, set by hand.

## GUIDED ACCESS IS THE LOCK — this is the constraint everything else follows from

The programmatic path needs the app open and the screen lit all night. A phone sitting unlocked all
night is not acceptable, so **Guided Access is what makes that safe**: one app, Face ID to leave. It
is the security equivalent of a locked screen, not an optional extra.

**So anything Guided Access suppresses is unusable for this path**, and it suppresses more than it
looks like it does:

- **Web Audio is silenced. A media element is not.** Measured on the device with the ringer on: in a
  Guided Access session `<audio>` plays and an oscillator makes no sound at all. This is why the
  alarm is a FILE: an alarm built on oscillators flashes its overlay, reports `state: "running"`,
  schedules its beeps and makes no sound.

## The TV and the page are a mirror

**Ringing is a state of the feed, not an event anyone has to witness.** An alarm-marked item whose
moment has passed and which is still in `/api/due-widget` is ringing, and both ringers apply that one
rule whenever they look: `dueNow()` in `alarmclock.js`, `due_now()` in `tv-ring.py`. So:

- the TV rings whether or not the app is open, and a restart of `tv-ring` mid-ring resumes the ring;
- the page rings whenever it is open, in Guided Access or not;
- opening the app in the middle of the TV's ring joins it, STOP and all, however long it has been
  ringing;
- STOP anywhere completes the item, the item leaves the feed, and every ringer goes quiet; SNOOZE
  moves its moment on, which every ringer reads the same way.

STOP reaches the TV in under a second because the hub announces its own completion at once
(`announceListWrite` in `routes/lists.js`) instead of waiting for the realtime echo, which takes seconds —
long enough for STOP to look as if it had not reached the TV.

**The page cannot detect a Guided Access session** — there is no web API, and the giveaway (Web Audio
being silenced) is not measurable from inside the audio graph. `GuidedAccess` in `StatusHubApp.swift`
pushes `window.__guidedAccess` into the page on every load and on
`guidedAccessStatusDidChangeNotification`, and the page forwards it in its beacon (`guided`) at
once. Nothing acts on it; it is how the night-before setup is checked, from `alarm_log`.

## The tones

`server/tools/make-alarms.py` generates `public/alarm-<slug>.m4a`; Settings → Alarm sound picks one
(`app_settings.alarm_sound`) and previews it on change. Three read as alarms (`classic`, `radar`,
`pulse`) and four as music (`sunrise`, `ripple`, `bells`, `tide`).

The `.m4a` files are committed and served straight from `public/` — about 160KB for the set, nothing is
generated at request time. The script is how they are AUTHORED: each one has to loop seamlessly and
sit where a phone speaker carries across a room, and both of those are numbers in that file rather
than something to re-edit in an audio tool. A tone that clicks at its loop point is unbearable long
before ten minutes are up. Adding one is a `KIT` entry, a re-run, and committing the result.

`alarmclock.js` preloads the chosen tone whenever the feed reloads, not when the alarm fires: first
fetching the file at 7am over a bad connection turns a ring into a pause. It skips the swap while
ringing, so changing the setting cannot pull the file out from under a sound already playing.

## The surf alarm — the scenario this was built for

The most-used case, end to end. No session and no model is involved after the conditions are set.

1. `surf-report/capture.mjs` mirrors Surfline into `surf_snapshots` on the Pi's cron, about four
   snapshots a day. See that repo for the publish windows.
2. The conditions for one morning are a `surf_alarms` row (data-layer `00111`), written by the
   `set_surf_alarm` tool. They are the user's for that morning — ask, never reuse a previous night's.
   `rules` is an ORDERED list, first match wins:

       [{"hours":[8,9], "not_fair":[10,11], "wake":"07:00"}, {"hours":[8,9], "wake":"08:30"}]

   A rule matches when every hour in `hours` is Fair or better AND no hour in `not_fair` is; any
   other hour does not matter. No match means no alarm. Both lists empty is an unconditional
   "otherwise", which has to be last. Order alone can often say the same thing — a wider window
   listed first wins whenever it is fair — and `not_fair` is for saying it directly.
3. The hub decides (`server/lib/surfalarm.js`). It already subscribes to `surf_snapshots`, so every
   new capture re-decides, and so does any change to `surf_alarms` (in the realtime publication).
   A 15-minute backstop reads only the newest snapshot's timestamp, and nothing when no alarm is set.
   Every new LIVE WIND reading re-decides too, for the veto below. `decided` on the row records the
   last answer: which snapshot, which rule, what time, and the veto when it changed the answer.
4. The decision drives the row's `outputs`, a registry in that file — a new form of alarm is one
   more entry there. Today there is one, `item`: an alarm-marked `list_items` row the hub creates,
   moves and deletes, holding its id in `state`. It goes on the `l_alarms` list and is EXEMPT —
   an alarm is not a task, and waking up earns nothing. Exempt items close themselves when their
   moment passes, but never an alarm: that would pull it from the feed and end the ring in the minute
   it starts. STOP is what completes it. A moment that has arrived is never moved, a wake
   time already past is recorded as `late` and changes nothing, and an item the user deleted or completed
   by hand is not put back (re-engaging with the tool forgets it). Moving the item's `due` goes out
   over realtime → `/api/stream` → `hub:stream` → `alarmclock.js` reloads and re-arms, and over
   `/api/list-stream` to `tv-ring`. **No push is involved in either chain**, which is the entire point.
5. At the moment, the TV and any open page play the alarm tone on loop and `dueTick` sends a
   notification underneath.

Measured end to end: a 05:00 capture lands about 10 s later, the hub decides within a second and
the alarm item exists within 7 s more; the TV's beacon shows the new time within a minute, and the
TV starts ringing on the second.

**What has to be true the night before**, and each of these has failed at least once. The TV needs
nothing but to be on; these are for the phone to ring as well:

- The app is open on `/`, in Guided Access, **plugged in** — a lit screen all night will flatten it.
- The item is marked `alarm` (`list_items.alarm`); the page rings nothing else.
- The page is on a current bundle. A deploy after the page loaded leaves it holding old code until
  `goStale` (`core.js`) reloads it: at once when hidden, otherwise after two minutes with no touch,
  and never while a voice command is recording.

**Read `alarm_log` to check any of it** — the section below. The page beacons every minute with
`audio`, `media` (readyState), `lock`, `visible`, `next`, `armed`, `guided`. That beacon exists
because every failure here has been a silent one that reported success — `audio: "running"` was
true the whole morning nothing came out of the speaker.

## The wind veto: the live wind can rule a Fair forecast out

The forecast the morning is decided on is old by the time it matters. Surfline runs its model at
00/06/12/18Z and each run reaches the site 7-10 hours later, so what the hub holds at 5am is the
**8pm** run from the night before, and the 2am run lands around 10am to noon — too late for a wake
time. The wind is what moves in that gap.

`surfVeto` in `routes/surf.js`: when the half-hour average of the MEASURED wind (`lib/livewind.js`, the
Mayport Bar Pilots dock 2.2 miles away — NDBC's MYPF1, read from NOAA CO-OPS as 8720218 every five
minutes) is ONSHORE at or over `surf_veto_kts` (Settings, default 12, 0 turns it off), every hour of
TODAY from the current one on counts as not Fair. Only while the reading is fresh (30 minutes: CO-OPS
serves a reading about six minutes after it is taken) and only for today's alarm. NDBC's own file is
the wrong source for this: it is rewritten about hourly, so its newest reading is 30-90 minutes old. Every new reading re-runs the decision until the wake time, so a veto that lifts brings
the alarm back, and the moment itself is never moved.

What the history since July says, and why the rule is this one:

- **Wind cannot make an hour Fair, only rule it out.** On light offshore wind a 1-2 ft morning is still
  rated Fair only 15-20% of the time — swell decides that.
- **THE THRESHOLD LEANS LENIENT, and the asymmetry is the reason.** Suppressing a real alarm costs the
  session; letting one through costs a look out of the window. Onshore at 8 kt or more has never been
  rated Fair — 0 of 351 hours across the archive, 0 of 43 in the 6-11am window — and the strongest
  onshore wind on any Fair morning hour is 5.1 kt. So 12 sits well clear of anything that has ever been
  surfable and fires only on wind that has plainly ruined the morning.
- **The state it guards against does not lift within a morning.** Of 149 hours at measured onshore
  8 kt or more, NONE was offshore two hours later, against 10.2% going the other way. It builds: median
  measured speed across 7-11am on those days runs 16.4, 14.9, 15.6, 15.8, 16.6 kt.
- **It has never yet changed an outcome.** Over 96 days of snapshots the cell where it can bite — the
  5am capture rating an hour Fair while the measurement is onshore at the threshold — is empty; on all
  13 mornings the condition held, the forecast had already called every hour not Fair. It is insurance
  that has not paid out, which is an argument for leaving it alone rather than for tuning it.
- **4 kt onshore is too aggressive.** Surfline rates 2-3 ft mornings Fair 11-23% of the time at 4-6 kt
  onshore, and it re-rated several light-onshore mornings Fair after the fact.
- **The direction differing from the forecast is not a signal at light wind.** Measured offshore or
  cross-shore where the forecast said otherwise, at 2-3 kt, happened on six Fair hours and every one
  stayed Fair in Surfline's own revision.
- **The wind that spoils a morning builds after dawn** — but check this one before relying on it. Over
  2026-06-19 onward, 20 forecast-Fair hours were downgraded by the final capture and the veto would
  have caught none of them: every one spoiled under light or offshore measured wind. Reading the two
  days below out of the snapshot archive does not reproduce the account given here either, which may be
  a different choice of decision capture. If catching post-dawn downgrades is the goal, wind alone does
  not do it. On the 38 hours the 5am forecast called Fair,
  the dock read 7 kt or less at 6am every time, including the four hours Surfline later downgraded
  (Sep 1 and Sep 3), where it built to 8-11 kt onshore by 8-9am. So a veto that looked only at the
  decision moment would never have fired; its value is that it keeps looking until the wake time,
  which matters most for a later alarm.

### The mirror rule — measured offshore wind LIFTING an hour — does not work

The veto only ever removes hours, so the symmetric rule is the obvious next build: lift an hour the
forecast put exactly one step below Fair, when the forecast's own wind for that hour is not offshore
and the dock is measuring offshore under 8 kt — that is, only where the measurement contradicts the
forecast's stated reason for the lower rating. It is narrow, it has a mechanism behind it, and it
still fails. Backtested against Surfline's own later ratings across the whole snapshot archive:

- **It fires on 12 mornings in 95 and is wrong on 9 of them.** Nine unearned 5am wakes across a summer
  to catch three real ones. The failure modes are not symmetric — a veto that fires wrongly costs a
  lie-in, this costs a wake — so 75% wrong is disqualifying on its own.
- **The effect is not separable from the control.** 25% day-level precision against 11.5% for hours
  that met the forecast conditions while the measurement did not qualify; the 95% interval on that
  difference runs **-12 to +42 points**, day-level Fisher p = 0.27. An hour-level test looks
  significant and is pseudo-replication: no candidate morning has a mixed outcome, so a morning's five
  hours are one observation.
- **The 15-20% figure above is what the rule runs into.** The unconditional base rate for these hours
  is 14.3%. Narrowing by wind does not escape it.
- **A size floor is the natural fix and cannot be measured.** `sRawMax` is absent from every row before
  September; the `sMax` fallback is an integer that flattens every earlier candidate to the same value.
  On `swH`, which is present throughout, tightening makes precision worse.
- **The speed cap is inert.** "Offshore and under 8 kt" and "offshore at any speed" select the
  identical hours, because every measured-offshore 5am in the archive is already under 8 kt. Any
  future version should re-derive that clause rather than carry it as reassurance it is not providing.

The honest verdict is that the sample cannot decide it, and the rule fires about once every eight
days, so it is roughly a year before it could. **Two data problems sit underneath that and are worth
fixing whatever happens to the rule:**

- **The decision forecast is old.** Captures are a median 8 hours apart, so the one in hand at 5am is a
  median 14.5 hours old in June-August — from the previous afternoon. Capturing more often is a bigger
  lever on the alarm than any rule layered on top of it.
- **There is no settled rating to score against.** The last capture covering an hour lands a median 7.5
  hours after it, and **26% of hours whose last capture says Fair did not say Fair in the one before**.
  Ground truth here is same-day and unstable, which is why a single late revision must not be read as
  the final word on a morning. Keeping a capture at least 24 hours after each hour would give one.

## Auditing a morning: `alarm_log`

The hub's stdout is not a record: Fly keeps about the last hundred lines, so a morning's beacons are
gone within the hour. What happened is in the `alarm_log` table (data-layer `00113`), written by
`alarmLog` in `lib/alarmlog.js`, one row per EVENT:

| source | ev | when |
|---|---|---|
| `hub` | `decision` | every surf-alarm decision that differs from the last — so every new forecast, since the snapshot is part of it, and a rule change only when it changes the outcome — with the snapshot, the rule, the time, the one it replaced and the item. `surf_alarms.decided` keeps only the latest. |
| `hub` | `due` | an alarm item's moment, with `ringers`: what each ringer last reported and how many seconds ago |
| `tv`, `<surface>@<device>` | `ring`, `stop`, `sound`, `ended`, `stuck`, `player-died`… | what a ringer reports as an event |
| same | `state` / `resumed` | a CHANGE in a ringer's armed state (`changed` lists the fields), or a ringer heard again after five minutes of silence; the first row after a hub restart carries the user agent |

A ringer's minute heartbeat that says nothing new writes nothing, which is what keeps this to tens
of rows a day. Sources are `tv` (tv-ring on the Pi) and a page's alarm clock as surface@device:
`phone@iphone` is the home page in the app, `tv@pi` the wall's overlay. A page's heartbeat stopping
is visible only as the `resumed` row when it comes back, and in the `due` row's `heard_s_ago`.

## The TV rings too

Two things on the wall, from the same feed and the same moment as the phone:

- **The overlay** is `alarmclock.js`, loaded by the four wall pages. Its sound goes nowhere: the
  kiosk's Chromium renders audio to nothing on the Pi (no stream reaches PipeWire even from a running
  `AudioContext`), so on the wall the module is the picture and the beacon (`guided: null`).
- **The sound** is `tv-ring.service` on the Pi (`pi-config/scripts/tv-ring.py`): the same feed
  (`/api/due-widget`, alarm-marked items), re-read on every `/api/list-stream` push, a local timer to
  the moment, and the chosen tone through HDMI-2 with `ffmpeg` straight to ALSA. It beacons
  `ev: "tvring"` every minute — `next`, `in_s`, `ringing`, `player` — and its rings, stops and state
  changes land in `alarm_log` like the phone's.

Both stop when the item leaves the feed, which is what the phone's STOP does. Neither gives up on a
clock. The rule for when either one rings is the mirror above. pi-config's README has what fails
here (the PipeWire sink, and why it is left unforced).

## Playing a sound breaks the microphone, unless you say so

Anything on the hub page that plays audio can take the iOS audio session, and a capture track that
loses it **goes silent while still reporting `readyState: 'live'`**. `voiceagent.js` caches the mic
stream and reuses it on that flag, so once it happens every later recording is silence and comes
back as an empty transcript. Left alone it does not recover until the page reloads, so every voice command until then is lost.

So every player here — the alarm, the Settings preview, the bench — dispatches `hub:audioplaying`
as its sound starts and `hub:audioplayed` once it is over, and `voiceagent` marks the stream dirty
so the next recording acquires a fresh one. **Add both to anything new that plays audio**; there is
no way to detect this from the track itself.

**Nothing holds the microphone unless something is recording, and that is what keeps the alarm
audible.** A capture needs `.playAndRecord`, so an open one takes the session out from under
whatever plays — the alarm's `.playback` claim included — and the ring is reduced to its first
moment. So the mic opens when a recording starts and closes when it ends (`claimMic` in
`voiceagent.js`). The always-on listener is a recording for as long as it is engaged, so with it on
the mic is open and the same thing applies.

Underneath that, an EMPTY TRANSCRIPT from a clip with real bytes marks the mic dirty too
(`deliverVoice`). That is the microphone having handed over zeros, whatever the cause, so it costs one
lost attempt rather than every attempt until a reload. Re-acquiring also stops the old tracks first: a
silent-but-live track still holds the device, and `getUserMedia` will otherwise hand back the same
dead capture.

**Letting go of the session restores its category, and does not deactivate it.** `AlarmAudio.hold`
in `StatusHubApp.swift` saves the category, mode and options when the alarm (or the bench's
OSC+SESSION) claims `.playback`, and puts them back on release; left on `.playback`, the session
cannot record underneath every capture that follows. Deactivating is the trap: WebKit keeps its own
idea of whether the session is active and does not re-activate one it believes is up, so the next
capture records silence. With no capture open when the ring stops — the mic opens only to record —
a deactivation succeeds, and the first taps after a ring record nothing until the app is restarted.
The fix is in the app, so a build older than it still has this.

A capture can also break without going silent — dropping most of its frames while still sounding like
something. The hub catches that one by measuring the clip; see `VOICE-ON-THE-PHONE.md`.
