# Location history

Every position the phone reports, kept at the grain Core Location delivers it, plus one point from the
watch each time its app is used, so "where was I yesterday at 3" has an answer. `locations` (data-layer 00128) is only the latest fix per device,
moved when he speaks a command; this is the history.

    phone / watch ─ LocationTrail.swift ─▶ POST /api/location/points ─▶ location_points

- `apps/Shared/LocationTrail.swift`, compiled into both the iOS app and the watch app, labelled
  `phone` or `watch`. The two are recorded separately and never merged: they get separated, and each
  row says where that device was.
- **Phone:** the source is `CLLocationUpdate.liveUpdates()` under a `CLBackgroundActivitySession`. It
  delivers while the phone moves and goes quiet while it is stationary, so there is no timer. Every fix
  is stored, with accuracy, altitude, speed, course and floor when the phone has them. Sent at 100
  fixes, when the phone comes to rest, or when a fix arrives over five minutes after the last send.
- **Watch:** one `requestLocation()` each time the app comes to the front (scene phase `active`, and
  at launch), at hundred-metre accuracy, sent the moment it lands. Nothing in the background, and no
  `location` background mode: a background session makes watchOS treat the app like a workout, and
  every wrist raise then returns to the app instead of the watch face. The watch's points are sparse
  on purpose; they cover the times it is out without the phone.
- Fixes queue in `location-trail.json` in Application Support and come off it only once the hub
  answers 200, so a dead network or a killed app loses nothing.
- `POST /api/location/points` (server.js, behind the auth gate) upserts on `(device, at)`, so a batch
  resent after a lost reply changes nothing.

## The table

`location_points` (data-layer 00139): `device`, `at`, `lat`, `lon`, `h_acc` (m), `alt` (m), `v_acc`,
`speed` (m/s), `course` (degrees), `floor`, `received_at`. RLS on with no policies.

Moving, the phone reports about once a second, so an hour on the move is a few thousand rows. The
watch adds one row per use.

## What keeps it running

- **Phone:** significant-change monitoring is what relaunches the app after iOS terminates it; every
  launch opens a new background session, which restarts the live updates. Recording through a
  termination needs **Always** location permission. With only While Using, it records from when the
  app was last opened until iOS ends it.
- **Watch:** nothing runs in the background; a point is taken only when the app is used. Its While
  Using grant (the one "near me" commands already ask for) is all it needs.
- The phone needs `location` in `UIBackgroundModes` (project.yml); the watch must NOT have it.

## Prerequisites

His grant on each device's location prompt. The phone's always-permission prompt needs
`NSLocationAlwaysAndWhenInUseUsageDescription` in its Info.plist (project.yml); without it,
`requestAlwaysAuthorization` does nothing and the phone records only under While Using.

## Checking it

    select device, count(*), max(at) from location_points group by device;

The hub logs `[location] <device> +N (sent K)` per batch (`fly logs -a jared-status-hub`).
