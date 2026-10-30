# Location history

Every position the phone and the watch report, kept at the grain Core Location delivers it, so "where
was I yesterday at 3" has an answer. `locations` (data-layer 00128) is only the latest fix per device,
moved when he speaks a command; this is the history.

    phone / watch ─ LocationTrail.swift ─▶ POST /api/location/points ─▶ location_points

- `apps/Shared/LocationTrail.swift`, compiled into both the iOS app and the watch app, labelled
  `phone` or `watch`. The two are recorded separately and never merged: they get separated, and each
  row says where that device was.
- The source is `CLLocationUpdate.liveUpdates()` under a `CLBackgroundActivitySession`. It delivers
  while the device moves and goes quiet while it is stationary, so there is no timer. Every fix it
  delivers is stored, with accuracy, altitude, speed, course and floor when the device has them.
- Fixes queue in `location-trail.json` in Application Support and come off it only once the hub
  answers 200, so a dead network or a killed app loses nothing. Sent at 100 fixes, when the device
  comes to rest, or when a fix arrives over five minutes after the last send.
- `POST /api/location/points` (server.js, behind the auth gate) upserts on `(device, at)`, so a batch
  resent after a lost reply changes nothing.

## The table

`location_points` (data-layer 00139): `device`, `at`, `lat`, `lon`, `h_acc` (m), `alt` (m), `v_acc`,
`speed` (m/s), `course` (degrees), `floor`, `received_at`. RLS on with no policies.

Moving, a device reports about once a second, so an hour on the move is a few thousand rows.

## What keeps it running

- **Phone:** significant-change monitoring is what relaunches the app after iOS terminates it; every
  launch opens a new background session, which restarts the live updates. Recording through a
  termination needs **Always** location permission. With only While Using, it records from when the
  app was last opened until iOS ends it.
- **Watch:** watchOS has no significant-change relaunch. The watch records while its app is alive,
  which is from when it was last opened until watchOS ends it or the watch restarts.
- Both need `location` in `UIBackgroundModes` (project.yml).

## Prerequisites

His grant on each device's location prompt. The always-permission prompt needs
`NSLocationAlwaysAndWhenInUseUsageDescription` in both apps' Info.plists (project.yml); without it,
`requestAlwaysAuthorization` does nothing and the device records only under While Using.

## Checking it

    select device, count(*), max(at) from location_points group by device;

The hub logs `[location] <device> +N (sent K)` per batch (`fly logs -a jared-status-hub`).
