# Alarms

Two paths, for two different situations. They are not primary and backup — neither can do the
other's job.

| | **AlarmKit** | **The page clock** |
|---|---|---|
| For | an alarm Jared sets himself | an alarm set PROGRAMMATICALLY while he is asleep |
| Set when | he is holding the phone | any time, including 4am |
| Rings via | iOS, natively | `alarmclock.js` playing `alarm.m4a` |
| Needs | nothing open | the app open, screen on |
| Breaks when | the alarm has to CHANGE while the phone sleeps | the app is closed or backgrounded |

## Why neither one covers both

**A sleeping phone cannot be told about a new alarm.** An AlarmKit alarm is registered ON the
device, so the hub can only push a silent wake asking the phone to re-read `/api/alarms`. iOS rations
those hard: measured 2026-09-19, four in a row were refused overnight, and a passive alert push
carrying `content-available` was refused too. A push to an ACTIVE app is not rationed at all — the
same phone fetched and acked one second later with the app on screen. So whether a 4am decision
reaches the phone comes down entirely to whether the app is in front.

That is the whole reason the page clock exists. It needs nothing delivered at the moment itself: it
holds a local timer and already has the stream.

**And a page can only ring while it is running**, which is why AlarmKit keeps its job for ordinary
alarms. Requiring the app be open to set a 9am alarm would be absurd.

## GUIDED ACCESS IS THE LOCK — this is the constraint everything else follows from

The programmatic path needs the app open and the screen lit all night. A phone sitting unlocked all
night is not acceptable, so **Guided Access is what makes that safe**: one app, Face ID to leave. It
is the security equivalent of a locked screen, not an optional extra.

**So anything Guided Access suppresses is unusable for this path**, and it suppresses more than it
looks like it does:

- **Web Audio is silenced. A media element is not.** Measured on the device with the ringer on: in a
  Guided Access session `<audio>` plays and an oscillator makes no sound at all. This is why the
  alarm is a FILE. An alarm built on oscillators flashed its overlay, reported `state: "running"`,
  scheduled its beeps and was silent through the entire morning of 2026-09-19.
- **AlarmKit is suspect for the same reason.** An alarm it had acked (`held:2`) passed in silence —
  but that test ran inside Guided Access, so it is confounded and does NOT establish that AlarmKit is
  broken generally. Retiring it on that evidence was a mistake. What it does mean: AlarmKit cannot be
  relied on for the Guided Access path until it is tested there specifically.

## Whose job is it to ring

Per alarm, one of them makes the noise:

| | **`armed`** (AlarmKit holds it) | **not armed** |
|---|---|---|
| **In Guided Access** | the page rings — AlarmKit will not present | the page rings |
| **Not in Guided Access** | the page stays quiet, AlarmKit rings | the page rings |

`armed` alone is not enough to decide, which is why this needs the session state: inside Guided
Access AlarmKit reports holding an alarm it may never present, so suppressing on `armed` there trades
a duplicate noise for a silent morning.

**The page cannot detect a Guided Access session** — there is no web API, and the giveaway (Web Audio
being silenced) is not measurable from inside the audio graph. `GuidedAccess` in `StatusHubApp.swift`
pushes `window.__guidedAccess` into the page on every load and on
`guidedAccessStatusDidChangeNotification`, since a session can start or end while the page sits
untouched. `hub:guidedaccess` re-decides immediately rather than waiting for the two-minute reload.

**Undefined means ring** — a plain browser, or the app before the flag lands. A duplicate is
recoverable; a silence is the failure this exists to prevent.

## The tones

`server/tools/make-alarms.py` generates `public/alarm-<slug>.m4a`; Settings → Alarm sound picks one
(`app_settings.alarm_sound`) and previews it on change. Three read as alarms (`classic`, `radar`,
`pulse`) and four as music (`sunrise`, `ripple`, `bells`, `tide`).

The `.m4a` files are committed and served straight from `public/` — 180KB for the set, nothing is
generated at request time. The script is how they are AUTHORED: each one has to loop seamlessly and
sit where a phone speaker carries across a room, and both of those are numbers in that file rather
than something to re-edit in an audio tool. A tone that clicks at its loop point is unbearable long
before ten minutes are up. Adding one is a `KIT` entry, a re-run, and committing the result.

`alarmclock.js` preloads the chosen tone whenever the feed reloads, not when the alarm fires: first
fetching the file at 7am over a bad connection turns a ring into a pause. It skips the swap while
ringing, so changing the setting cannot pull the file out from under a sound already playing.

## The surf alarm — the scenario this was built for

The most-used case, end to end.

1. `surf-report/capture.mjs` mirrors Surfline into `surf_snapshots` on the Pi's cron, about four
   snapshots a day. See that repo for the publish windows.
2. A session watches `surf_snapshots` over Supabase realtime — **not a poll**; the table is in the
   publication already (data-layer `00040`).
3. A new capture lands overnight. The session reads the morning's hours and applies Jared's rules
   (they live with him, not here — ask, do not infer) to decide a wake time.
4. It moves the item's `due`. That write goes out over realtime → the hub's `/api/stream` →
   `core.js` dispatches `hub:stream` → `alarmclock.js` reloads `/api/due-widget` and re-arms.
   **No push is involved anywhere in that chain**, which is the entire point.
5. At the moment, the page plays `alarm.m4a` on loop and `dueTick` sends a notification underneath.

Measured 2026-09-19: the alarm moved 8:30 → 7:00 at 05:00, and the phone's beacon showed the new
moment **within one minute**, over the stream, with the phone untouched.

**What has to be true the night before**, and each of these has failed at least once:

- The app is open on `/`, in Guided Access, **plugged in** — a lit screen all night will flatten it.
- The item is marked `alarm` (`list_items.alarm`); the page rings nothing else.
- The page is on a current bundle. A deploy after the page loaded leaves it holding old code, and
  `goStale` used to wait for a `visibilitychange` that never comes on a parked screen.

**Read `ev: "alarmclock"` in the hub log to check any of it.** The page beacons every minute with
`audio`, `media` (readyState), `lock`, `visible`, `next`, `armed`. That beacon exists because every
failure here has been a silent one that reported success — `audio: "running"` was true the whole
morning nothing came out of the speaker.
