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
- **AlarmKit must hold nothing.** Inside a session an armed AlarmKit alarm does not present — and it
  still fires, at the same instant as the page, and takes the audio session: the page's overlay comes
  up, its sound starts and is cut off a moment later, and nothing replaces it. That is specific to
  Guided Access; outside a session AlarmKit rings normally and is the right path.

## Whose job is it to ring

Per alarm, one of them makes the noise:

| | **`armed`** (AlarmKit holds it) | **not armed** |
|---|---|---|
| **In Guided Access** | the page rings — and the phone is told to drop it (below) | the page rings |
| **Not in Guided Access** | the page stays quiet, AlarmKit rings | the page rings |

**In Guided Access the hub takes the alarms off the phone.** The page reports the session in its
beacon (`guided`), and at once when it changes. While that is fresh and true, `/api/alarms` serves an
empty set and `unarmedAlarms()` expects nothing, and the change itself wakes the phone to sync — a
push to an app in front is not rationed — so AlarmSync cancels what it holds. When the session ends,
or the page stops beaconing, AlarmKit gets its alarms back. `inGuidedAccess()` in `server.js`.

The page still ignores `armed` inside a session, for the moment between a session starting and the
phone syncing.

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

The most-used case, end to end. No session and no model is involved after the conditions are set.

1. `surf-report/capture.mjs` mirrors Surfline into `surf_snapshots` on the Pi's cron, about four
   snapshots a day. See that repo for the publish windows.
2. The conditions for one morning are a `surf_alarms` row (data-layer `00111`), written by the
   `set_surf_alarm` tool. They are Jared's for that morning — ask, never reuse a previous night's.
   `rules` is an ORDERED list, first match wins:

       [{"hours":[8,9], "not_fair":[10,11], "wake":"07:00"}, {"hours":[8,9], "wake":"08:30"}]

   A rule matches when every hour in `hours` is Fair or better AND no hour in `not_fair` is; any
   other hour does not matter. No match means no alarm. Both lists empty is an unconditional
   "otherwise", which has to be last. Order alone can often say the same thing — a wider window
   listed first wins whenever it is fair — and `not_fair` is for saying it directly.
3. The hub decides (`server/lib/surfalarm.js`). It already subscribes to `surf_snapshots`, so every
   new capture re-decides, and so does any change to `surf_alarms` (in the realtime publication).
   A 15-minute backstop reads only the newest snapshot's timestamp, and nothing when no alarm is set.
   `decided` on the row records the last answer: which snapshot, which rule, what time.
4. The decision drives the row's `outputs`, a registry in that file — a new form of alarm is one
   more entry there. Today there is one, `item`: an alarm-marked `list_items` row the hub creates,
   moves and deletes, holding its id in `state`. It goes on the `l_alarms` list and is EXEMPT —
   an alarm is not a task, and waking up earns nothing. Exempt items close themselves when their
   moment passes; `closeExempt` waits out the ring for an alarm, since closing it pulls it from the
   feed and the page stops ringing. A moment that has arrived is never moved, a wake
   time already past is recorded as `late` and changes nothing, and an item he deleted or completed
   himself is not put back (re-engaging with the tool forgets it). Moving the item's `due` goes out
   over realtime → `/api/stream` → `hub:stream` → `alarmclock.js` reloads and re-arms. **No push is
   involved in that chain**, which is the entire point.
5. At the moment, the page plays the alarm tone on loop and `dueTick` sends a notification underneath.

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

## Playing a sound breaks the microphone, unless you say so

Anything on the hub page that plays audio can take the iOS audio session, and a capture track that
loses it **goes silent while still reporting `readyState: 'live'`**. `voiceagent.js` caches the mic
stream and reuses it on that flag, so once it happens every later recording is silence: the VAD never
hears speech, each clip is dropped at the grace timeout, and nothing is sent. It does not recover
until the page reloads. Measured 2026-09-19, hours of voice commands lost to it after the tone
previews went in.

So every player here — the alarm, the Settings preview, the bench — dispatches `hub:audioplaying`
as its sound starts and `hub:audioplayed` once it is over, and `voiceagent` marks the stream dirty
and re-acquires. **Add both to anything new that plays audio**; there is no way to detect this from
the track itself.

**The re-acquire waits for `hub:audioplayed`, and that is what keeps the alarm audible.** A capture
needs `.playAndRecord`, so opening one while a sound plays takes the session out from under it —
the alarm's `.playback` claim included — and the ring is reduced to its first moment. For the alarm,
over means `stopRing`, not the end of one pass of the loop. `holdMic`'s idle-time warm (and the one
on `visibilitychange`) stays shut in between; only a press that actually records acquires then.

Underneath that, `vad:grace` marks the mic dirty too. Reaching it means eight seconds of silence
arrived from a microphone he was talking into, whatever the cause, so it costs one lost attempt
rather than every attempt until a reload. Re-acquiring also stops the old tracks first: a
silent-but-live track still holds the device, and `getUserMedia` will otherwise hand back the same
dead capture.

**Letting go of the session restores its category.** `AlarmAudio.hold` in `StatusHubApp.swift` saves
the category, mode and options when the alarm (or the bench's OSC+SESSION) claims `.playback`, and
puts them back on release before deactivating. Deactivating alone leaves the session on `.playback`,
which cannot record, underneath every capture that follows.

A capture can also break without going silent — dropping most of its frames while still sounding like
something. The hub catches that one by measuring the clip; see `VOICE-ON-THE-PHONE.md`.
