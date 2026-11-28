# The front door

A SwitchBot Lock Ultra. The lock itself, its events and its history are data-layer's (`README.md`
§ The front door: `front_door`, `door_events`, `door_sightings`, the Bluetooth listener). This file is
what the hub and the apps do with it.

## Hub routes (`server/routes/switchbot.js`)

- `POST /api/switchbot/:token`: SwitchBot's webhook (public; the secret path segment is the auth).
- `GET /api/door`, `POST /api/door {action, reason?}`: read, lock or unlock, answered once the lock
  confirms. `reason` names the caller (`elevator`; the watch sends none and is recorded as `watch`) and
  is kept in the `command` row's `raw`. A failure is reported.
- `GET /api/door/home`: `app_settings.home_location` as `{lat, lon, radius_m}`, for the phone's geofence.
- `POST /api/elevator/rides`: one elevator-unlock window into `elevator_rides` (data-layer 00212).
- A 5-minute backstop reads the lock and records any change no source reported (reported as an error).

## Watch

The door sheet (`apps/Watch/DoorView.swift`), the `Hub Door` complication and the Control Center
toggle (`apps/WatchWidgets`, `DoorAPI.swift`). Failures in the sheet go through `Hub.log`; the toggle
runs in the widget extension and posts its failures to `/api/clientlog` itself. Both are reported by
`routes/voice.js`, except a 502, which the hub already reported.

## Elevator unlock (phone)

Riding the elevator up to the apartment and walking out of it unlocks the door.
`apps/Sources/ElevatorUnlock.swift` runs it, `ElevatorDetector.swift` holds the rules.

- **While near home** (a geofence on `home_location`, 500 m) the app keeps running and reads the
  barometer and the step counter without a break: low-accuracy background location updates keep it
  running (`location` in `UIBackgroundModes`). Watching goes on after an unlock, so a trip down for the
  mail and back up is another ride. Leaving the geofence stops everything; entering it wakes the app,
  even after iOS has terminated it, and a launch inside it starts watching too. Needs the phone's
  **Always** location grant. The cost is battery: `elevator-watch-start` / `-stop` lines in
  `client_log` carry `phone_battery`.
- **The rules** (`ElevatorDetector.Thresholds`): a rise of 3.5 m or more within 90 s with at most 10
  steps is a ride; it has ended when the last 5 s rose less than 0.4 m; then 5 steps within 90 s is
  walking out, and the door is unlocked (`POST /api/door`, reason `elevator`). A rise that resumes (a
  stop at another floor) goes back to riding from the same lowest point, so the whole climb counts. A ride
  down is recorded once it stops (`down`). These are loose first values, to be tuned from traces: `app_settings.elevator_thresholds` (any `Thresholds` key, e.g. `{"minRise":5,"rideWindow":120}`) overrides the app's defaults at runtime, sent with `GET /api/door/modes`, so tuning needs no build.
- **Every ride is stored** in `elevator_rides` a minute after it, up or down, unlocked or not
  (`no_exit`), with the thresholds it ran with and its trace: relative altitude and cumulative steps
  from four minutes before it, in seconds from `trace.t0`, when watching started.
- **What it cannot see:** an arrival iOS reports late. Entry is worked out from cell and Wi-Fi
  positions and can come a minute or more late, which the 500 m radius allows for.
- **The elevator pane** (rightmost swipe pane on the phone, `server/public/cards/elevator.js`), for
  testing: the unlock-mode switches (`/api/door/modes`), the live state the app sends while it is in
  front (`hub:elevator` from `ElevatorUnlock.publish`, on every sensor reading; the page asks for it
  through the `elevator` message handler when it mounts or regains focus): watching, area, location
  and distance from home, relative altitude, steps, the detector's phase (`ElevatorDetector.status`)
  and a log of its transitions, steps out and unlocks; then the last rides (`GET /api/elevator/rides`,
  `server/routes/elevator.js`) the Wi-Fi joins (`/api/presence/joins`) and `presence_devices`. In a browser it has no live
  state. The app reads the modes when watching starts and as each ride begins; with `elevator` off a
  ride is still detected and stored, as `disabled`, and nothing is unlocked.
- Tests: `apps/tests/run-elevator-detector.sh` compiles the detector with its cases and runs them.

    select at, outcome, rise_m, ride_s, steps_in_ride, steps_after, unlock_ms from elevator_rides order by at desc;

## Watch reconnecting to the phone (experiment)

`apps/Sources/WatchLinkWatch.swift` logs what iOS reports about the Apple Watch's link to the phone, to
learn whether it can see him arrive with only the watch while the phone is already home. Observation
only: nothing unlocks from it yet (it becomes the phone's half of the `bluetooth` mode once it is shown
to work). Three sources, each a `watch-link` line in `client_log` (`kind` says which) and a line in the
elevator pane's log:

- CoreBluetooth connection events (`registerForConnectionEvents`), matched on Device Information,
  Battery, Apple's Continuity and Nearby services and on every peripheral already seen connected;
  `bluetooth-central` in UIBackgroundModes and a restore identifier let them arrive in the background.
  iOS answers every `registerForConnectionEvents` call with the current state of each match, so the
  handler re-registers only when a peripheral is new and logs only a change of state; re-registering
  on every event is an endless loop on the main queue that freezes the app.
- `retrieveConnectedPeripherals(withServices:)` at launch and whenever watching near home starts.
- WatchConnectivity pairing, install and reachability changes (from `WatchLink`'s delegate).
  Reachability is the watch app being reachable, not the radio link.

It does: on build 235 a connection event named his Apple Watch (`connected`, id `DEEC6331`) the
moment the manager registered, before any disconnect was seen. Whether a reconnect after he leaves and
returns fires one in the background is still to be measured.

    select at, data->>'kind', data from client_log where ev = 'watch-link' order by at desc;

## Arrival by Wi-Fi and Bluetooth (house side)

Which approaches may unlock is `app_settings.door_unlock_modes` (`elevator`, `wifi`, `bluetooth`), read
and set by `GET` / `POST /api/door/modes` and the debug page's switches, so each can be tested alone.

- **Wi-Fi:** data-layer `presence/listener.py` writes every DHCP message heard on the LAN to `lan_joins`.
  The hub (realtime INSERT, `lanJoined`) unlocks on a Discover or Request from a MAC listed in
  `app_settings.presence_devices` (`{"<mac>": "phone" | "watch"}`) when `wifi` is on. iOS uses a private
  MAC per network, so the list is filled from his own test joins. `GET /api/presence/joins`.
- **Bluetooth:** data-layer `presence/ble.py` writes `arrive` / `leave` rows to `presence_events` for his
  phone and watch, which the Mac recognises by their real addresses. The hub (realtime INSERT,
  `presenceEvent`) unlocks on an `arrive` when `bluetooth` is on. `GET /api/presence/events`.
- **Only after he really left** (`lib/door.js` `leftAndCameBack`, tested in `test/door-arrival.test.js`): an
  arrival counts only if the door opened, after that one of his devices went unheard over Bluetooth
  (`presence_events` `leave`) or the phone rode the elevator down, and the door has not opened since. A
  phone restart or Bluetooth toggled at home has no door opening behind it. Every verdict is logged
  (`[switchbot] … an arrival / not an arrival (why)` in the hub's log), switch on or off.
- Both unlock at most once per device a minute, record the command with `reason` `wifi:<device>` /
  `bluetooth:<device>`, and report a failed unlock.

## Relock after an automatic unlock

Only while `door_unlock_modes.relock` is on (the page's Relock button; off by default, since there is no keypad outside yet), an unlock with reason `elevator`, `wifi:*` or `bluetooth:*` arms a relock in the hub (`relockAfter` in
`routes/switchbot.js`): 20 s after the door next closes, or 30 s after the unlock if the door never opens.
It never locks an open door (reported instead), and any lock in the meantime disarms it. It follows
`door_events` over realtime (`doorEvent`). The lock's own auto-lock in the SwitchBot app is off. The
arming lives in the hub's memory, so a hub restart inside that window drops it.

## Lobby door (ButterflyMX)

The building has three ButterflyMX doors: `door` is `main`, `north` or `south` (data-layer 00220, default `main`), carried in every message so his phone's automation runs the matching shortcut ("Unlock Main Entrance", "Unlock North Entrance", "Unlock South Entrance"). `POST /api/lobby/open {door}`; the `front_door` tool's `lobby` op takes `door`.

The building's downstairs door opens only from his phone: ButterflyMX's app exposes each door as a Siri
shortcut, and iOS lets no app run another app's shortcut in the background. So opening it is a race of
messages to the phone, whose Shortcuts automation (a Message or Mail trigger, Run Immediately) opens the
door on the first to land and then reports which one it was.

- **A race** is a `lobby_races` row (data-layer 00219) with a one-time `nonce`, started by
  `POST /api/lobby/open` (`{reason}`) or the data MCP's `front_door` op `lobby`. Every path sends
  `open-lobby-7731 <door> <nonce> <path>`:
  - `sms`: the hub, through Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` on Fly), to
    `app_settings.lobby_phone`.
  - `email`: the hub, through the Gmail API (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
    `GOOGLE_REFRESH_TOKEN` on Fly), to `app_settings.lobby_icloud_email`. iCloud mail reaches Apple Mail
    at once, which the Mail trigger needs; Gmail in Apple Mail is fetched, not pushed, so it is too slow.
  - `imessage`: the Mac only (data-layer `lobby.ts` in the home agent, through the messages MCP), to
    `app_settings.lobby_imessage_to`. No other machine has iMessage; the other paths cover the Mac asleep.
  A path not set up is recorded as skipped (a `send` row with `skipped`), not as a failure; a failed send
  is reported.
- **The phone reports** with `GET /api/lobby/opened/<nonce>/<path>` after opening the door. It is public:
  the nonce is the authorization, good once per path for 10 minutes (`lib/lobby.js`, tested in
  `test/lobby.test.js`), and the route opens nothing. Every path that lands reports, so each race records
  which won and each path's latency.
- A race with a path sent and no report within 90 s is reported as a failure.
- `GET /api/lobby/races`: the last 10 races (winner, each path's send result and arrival), shown in the
  elevator page's Lobby section.

## Near-home trace (phone)

While the elevator watch runs (inside the 500 m home geofence), `apps/Sources/HomeTrace.swift` records
everything the phone senses, for picking the thresholds of a future entrance unlock (precise location,
or the stairs in front of the main entrance). Logging only: nothing acts on it.

- **Streams**, each sample a compact array with `t` in seconds from the chunk's `started_at`:
  - `alt`: `[t, relative altitude m, pressure kPa]` (every barometer sample, about 1 Hz)
  - `steps`: `[t, cumulative steps, cadence steps/s, pace s/m]` (every pedometer update)
  - `fixes`: `[t, lat, lon, horizontal accuracy m, altitude m, vertical accuracy m, speed m/s, course deg]`
  - `activity`: `[t, stationary|walking|running|automotive|cycling|unknown, confidence 0-2]`
  - `modes`: `[t, best|low]`, each accuracy switch
- **Accuracy switching** (`TracePolicy.swift`, cases in `apps/tests`): the keep-alive location manager runs
  at best accuracy (GPS, about one fix a second) while the motion activity is anything but stationary,
  and drops back to 100 m after two minutes stationary. An unknown activity keeps the current mode.
- **Battery:** best accuracy is the expensive part, so it runs only while he is moving near home (arriving,
  leaving, walking the grounds). Not yet measured: the `elevator-watch-start` / `-stop` client-log lines
  carry `phone_battery` for that.
- **Upload:** a chunk every 30 s and when watching stops, `POST /api/home-trace` → table `home_trace`
  (data-layer 00221), one row per chunk; the hub validates it (`lib/hometrace.js`, `test/hometrace.test.js`).
  A failed upload keeps the chunk and sends it again at the next cut, reported once per run of failures
  (`home-trace-failed`). `GET /api/home-trace/summary` feeds the pane's Trace section.
- **Retention:** about 60 days is enough; there is no pruning yet (todo).

    select started_at, jsonb_array_length(fixes) fixes, jsonb_array_length(alt) alt, activity, modes
      from home_trace order by started_at desc limit 20;
