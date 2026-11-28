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
  down is recorded once it stops (`down`). These are loose first values, to be tuned from traces.
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
