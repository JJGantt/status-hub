# Location history

Where the phone has been — the places it stayed, a point every few hundred metres between them, and a
point each time the app is opened — plus one point from the watch each time its app is used, so "where
was I yesterday at 3" has an answer. `locations` (data-layer 00128) is only the latest fix per device,
moved when a command is spoken; this is the history.

    phone / watch ─ LocationTrail.swift ─▶ POST /api/location/points ─▶ location_points

- `apps/Shared/LocationTrail.swift`, compiled into both the iOS app and the watch app, labelled
  `phone` or `watch`. The two are recorded separately and never merged: they get separated, and each
  row says where that device was.
- **Phone:** three events, none of which keeps the app running, each stored with a `source`:
  - **Visits** (`startMonitoringVisits`): iOS reports arriving somewhere and staying, and leaving
    again, with the place's coordinate. An `arrive` row at the arrival time and a `depart` row at the
    departure time. iOS reports the arrival with no departure yet and the same visit again when it
    ends, so the arrival is written twice onto one row. Short stops are often not a visit, and a
    visit can be reported minutes late.
  - **Significant-change wakes**: iOS wakes or relaunches the app after roughly 500 m of movement,
    usually no more than every few minutes. Neither number is ours to set. The position it hands over
    is from cell and Wi-Fi and can be hundreds of metres off: a `move` row. The app then asks for one
    GPS fix inside the wake, held awake by a background task until the fix lands and is sent: a `fix` row.
  - **The app coming to the front** (scene phase `active`, and every launch): one GPS fix, a `fix` row.

  A continuous stream (`CLLocationUpdate.liveUpdates()` under a `CLBackgroundActivitySession`) is the
  obvious source and the wrong one: it keeps the app alive behind every other app all day, with the
  location indicator up and the hub page running in it, for a one-second track. Rows from before
  2026-11-03 with a null `source` are that stream.
- **Watch:** one `requestLocation()` each time the app comes to the front (scene phase `active`, and
  at launch), at hundred-metre accuracy, sent the moment it lands (`source` `fix`). Nothing in the background, and no
  `location` background mode: a background session makes watchOS treat the app like a workout, and
  every wrist raise then returns to the app instead of the watch face. The watch's points are sparse
  on purpose; they cover the times it is out without the phone.
- Every point is sent as soon as it lands. Points queue in `location-trail.json` in Application Support and come off it only once the hub
  answers 200, so a dead network or a killed app loses nothing.
- `POST /api/location/points` (routes/healthdata.js, behind the auth gate) upserts on `(device, at)`, so a batch
  resent after a lost reply changes nothing.

## The table

`location_points` (data-layer 00139): `device`, `at`, `lat`, `lon`, `h_acc` (m), `alt` (m), `v_acc`,
`speed` (m/s), `course` (degrees), `floor`, `source` (00165: `arrive`, `depart`, `move`, `fix`; null on
older rows), `received_at`. RLS on with no policies. `source` is checked by the route; anything else is
stored as null.

A visit's `arrive` / `depart` pair is how long was spent where. A day of driving is tens of `move` +
`fix` pairs, not thousands of rows.

## What keeps it running

- **Phone:** visits and significant changes both relaunch the app after iOS terminates it, and both
  are started again at every launch. They need **Always** location permission; with only While Using
  the phone records only when the app is opened.
- **Watch:** nothing runs in the background; a point is taken only when the app is used. Its While
  Using grant (the one "near me" commands already ask for) is all it needs.
- Neither app has `location` in `UIBackgroundModes` (project.yml). Visits and significant changes do
  not need it, and on the phone it is what let the old stream keep the app running.

## Prerequisites

The user's grant on each device's location prompt. The phone's always-permission prompt needs
`NSLocationAlwaysAndWhenInUseUsageDescription` in its Info.plist (project.yml); without it,
`requestAlwaysAuthorization` does nothing and the phone records only under While Using.

## Checking it

    select device, source, count(*), max(at), avg(h_acc) from location_points
      where at > now() - interval '1 day' group by 1, 2;

`fix` rows with a small `h_acc` are the GPS fixes landing inside the wake; a wake whose `move` has no
`fix` within a minute after it is a fix iOS did not deliver in time.

The hub logs `[location] <device> +N (sent K)` per batch (`fly logs -a jared-status-hub`).
