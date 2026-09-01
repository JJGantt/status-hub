# Working in status-hub

## Server computes, clients render

Every derived display value — pace fills, colours, labels, maintenance math, gauge geometry — is
computed in `server/server.js` / `server/lib/` and shipped in the payload. The cards
(`server/public/`) and the Swift widgets only paint. Deriving a value in a client is how two
surfaces start disagreeing about the same number.

## Pushing does not deploy

Run `server/deploy.sh` from whichever machine changed the code. It ships and then polls `/healthz`,
which returns `ok <7-char sha>` from the `COMMIT` stamped in at deploy time — that check is the only
thing separating "shipped" from "silently didn't". `.github/workflows/` is iOS-only; nothing there
touches the server. `fly.toml` lives in `server/`, which is also the build context.

    curl -s https://jared-status-hub.fly.dev/healthz     # ok <sha>

## The auth gate is positional

One `app.use` in `server.js` gates everything **defined below it**; `/healthz` and `/login` sit above
it and are public. A new route added near the top of the file is world-readable.

## The day starts at 4am, in `TZ_DISPLAY`

Use `lib/dates.js` (`localDate`, `nutritionWindow`, `dayBucketOf`) — never
`new Date().toISOString().slice(0,10)`. Every nutrition figure is scoped to a 4am-origin day
rendered in one display timezone (default America/New_York); a UTC date puts a late meal on the
wrong day.

## `apps/StatusHub.xcodeproj` is generated

It is committed, but XcodeGen rewrites it from `apps/project.yml`. Edit `project.yml` and run
`xcodegen generate`; anything changed in Xcode's project editor is lost at the next generate.

## A build made on this Mac cannot receive push

This Mac's keychain holds only an Apple Development identity, so a local build carries
`aps-environment: development` and registers a **sandbox** APNs token — which the hub, sending to
the production gateway, answers with `BadDeviceToken`. The distribution certificate exists only in
this repo's GitHub secrets, so a build meant to receive real notifications has to come from
`ios-adhoc.yml` or `ios-testflight.yml`. Local builds are for iterating on UI.

## No new bundle ids, no App Groups

Xcode's developer-account login is rejected, so nothing needing a **new or updated provisioning
profile** can be signed (`docs/TODO.md` § Blocked on Jared). A new widget goes into the existing
`StatusHubControls` bundle (the `WidgetBundle` at the bottom of `apps/Controls/RecordControl.swift`);
a widget and its button intents share `UserDefaults.standard`, since they are one process already.

## Widget drawing files stay WidgetKit-free

`Controls/RingsView.swift`, `TodoView.swift` and `ReposView.swift` import no WidgetKit, so
`apps/tools/render-*.swift` compiles them standalone and writes PNGs at real device point sizes.
Importing WidgetKit there costs the whole iterate-without-a-device loop.

## Do not rename the reminder dedupe key

`reminder:<id>:<due>` in `notifications.dedupe_key`. Item ids were preserved through the
reminders→`list_items` merge precisely so already-written ledger rows still match; a new key re-fires
every item that was already delivered.

## `/report/:id` serves model-written HTML

Its CSP (`default-src 'none'` plus sandbox) is the only thing between that markup and an origin
already authenticated as Jared. Charts must be inline `<svg>` — no `<script>`, no CDN link.

## There are three walls, and one of them is live

`public/tv.html` (`/` and `/tv`) is the wall the Pi is showing on the TV. **Do not change it** while
the others exist.

`public/tv-session-focus.html` (`/tv-session-focus`) is the second — "TV session focus" — begun as a
byte-identical copy and being stripped down around the sessions list: always-on, no interaction,
readable across a room and eventually on a watch. Mold that one.

`public/tv-calendar.html` (`/tv-calendar`) is the third — the calendar wall — the session wall's
frame (status strip · rings · health bar · footer · voice column) with the freed middle painted by
`tv-calendar.js` from `/api/calendar?wall=1`: a day timeline plus `calendar_months` months of grid.
Display-only; voice switches to it and sizes it via `set_wall`. The phone's interactive calendar is
`public/calendar.html` at `/calendar` — a separate standalone page, not a wall.

The walls share `core.js` / `tv.js` / `wall.js` / `wallmode.js`, so a change to those hits ALL of
them; split whatever needs to differ at the moment it needs to differ.

## Where a fact goes

`ARCHITECTURE.md` is the ecosystem view — it covers voice-pipeline, data-layer, devices and hosting
too, and lives here because this is the most active repo. `docs/HUB-INTERNALS.md` is the map of this
server and app. `docs/TODO.md` is the open-work list.
