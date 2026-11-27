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

- **Trigger:** a geofence on `home_location` (150 m). Entering it wakes the app, even after iOS has
  terminated it, and opens a 15-minute window. It needs the phone's **Always** location grant.
- **The window** keeps the app running with background location updates (`location` in
  `UIBackgroundModes`) and reads the barometer and the step counter. It ends on the unlock, on leaving
  the geofence, or after 15 minutes, and stops everything, so the app is never kept alive at home.
- **The rules** (`ElevatorDetector.Thresholds`): a rise of 3.5 m or more within 90 s with at most 10
  steps is a ride; it has ended when the last 5 s rose less than 0.4 m; then 5 steps within 90 s is
  walking out, and the door is unlocked (`POST /api/door`, reason `elevator`). A rise that resumes (a
  stop at another floor) goes back to riding. These are loose first values, to be tuned from traces.
- **Every window is stored** in `elevator_rides` with the whole trace (relative altitude and
  cumulative steps, seconds from the window's start) and the thresholds it ran with, rides that did
  not unlock included (`no_exit`, `no_ride`).
- **What it cannot see:** a ride that starts without crossing into the geofence first (going down to
  the lobby and back up without leaving the 150 m), and an arrival iOS reports late, after the ride.
- Tests: `apps/tests/run-elevator-detector.sh` compiles the detector with its cases and runs them.

    select at, outcome, rise_m, ride_s, steps_in_ride, steps_after, unlock_ms from elevator_rides order by at desc;
