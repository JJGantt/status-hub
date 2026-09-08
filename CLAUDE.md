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

`Dockerfile` **enumerates what it copies** — `server.js`, `lib`, `public`, `legal`. A new
top-level directory under `server/` is not in the image until it is added there, and nothing
catches that: the build succeeds, `/healthz` reports the right sha, and the files are simply
absent at request time. Curl the new path after deploying, not just `/healthz`.

    curl -s https://jared-status-hub.fly.dev/healthz     # ok <sha>

## The auth gate is positional

One `app.use` in `server.js` gates everything **defined below it**. Public, because they are
declared above it: `/healthz`, `/login`, `/privacy`, `/terms`, and the Search Console verification
file named by `GSC_VERIFICATION`. A new route added near the top of the file is world-readable.

The legal pages and the verification file are deliberately public: Google fetches them as an
anonymous crawler while verifying the domain and reviewing the OAuth app, and behind the gate it
gets the login page instead. They exist because publishing that OAuth app to production is what
stops Google revoking the Gmail refresh token every 7 days.

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

## A dated item with a past `due` pushes to his phone within 60 seconds

`dueTick` scans every 60s and app-pushes anything overdue. So inserting a test item with a due time
in the past does not simulate an overdue item — it **sends Jared a real notification** with fake
content, and there is no way to unsend it. It happened: three test items named "Costing me",
"Important slip" and "Still worth it" arrived on his phone while the per-item scoring was being
checked.

Test the scoring instead of the database. `lib/score.js` is pure — `tasksScore`, `completionValue`
and `taskDeadline` take plain objects and a `nowLocal` string, so every state (overdue, in grace,
late, drained to zero) is reachable with no rows at all. When a row genuinely is needed, give it a
**future** due and set `completed_at` or `deleted` directly rather than letting its moment pass.

Clearing up afterwards means the item AND its ledger row: `notifications.dedupe_key` keeps a
`reminder:<id>:<due>` entry per delivery, and deleting the item leaves that behind.

## Do not rename the reminder dedupe key

`reminder:<id>:<due>` in `notifications.dedupe_key`. Item ids were preserved through the
reminders→`list_items` merge precisely so already-written ledger rows still match; a new key re-fires
every item that was already delivered.

## `/report/:id` serves model-written HTML

Its CSP (`default-src 'none'` plus sandbox) is the only thing between that markup and an origin
already authenticated as Jared. Charts must be inline `<svg>` — no `<script>`, no CDN link.

## There are four walls, and the default is the one being molded

`public/tv-home.html` (`/` and `/tv`) is the **home wall — the default, and what the TV is showing**.
The shared frame (status strip · rings · health bar · footer · voice column) around four columns:
today's day column, the six days after it, the three heat maps stacked with the strip that belongs
to each (nutrition totals vs target, the rest/session clocks, surf), and the newest session's last
answer. `tv-home.js` + `tv-home.css` are its own; everything else on it is a shared card `core.js`
already paints, which is why the page is mostly markup. This is the one to shape.

Its grid is SIX columns, declared in `tv-home.css` — which means the spans app.css writes for its
five are wrong here and are overridden alongside it: the status strip reaches column 6, the footer
column 7, and the health bar sits in 6. Add a column and those three are what silently misplace.

`public/tv-health.html` (`/tv-health`) is the health wall — what used to be the default, and still
the only place nutrition, the muscle map, the volume bars and the workout heatmap are on one screen,
each with the detail panel its heatmap fills. Too much to glance at from a couch, which is why it
gave up `/`.

`public/tv-session-focus.html` (`/tv-session-focus`) is the sessions wall: always-on, no interaction,
stripped down around the sessions list so it reads across a room and eventually on a watch.

`public/tv-calendar.html` (`/tv-calendar`) is the calendar wall — the shared frame with the freed
middle painted by `tv-calendar.js`: a day timeline plus `calendar_months` months of grid.
Display-only. The phone's interactive calendar is `public/calendar.html` at `/calendar` — a separate
standalone page, not a wall.

Voice picks between them with `set_wall`, which writes `app_settings.wall_mode`; `wallmode.js` maps
that to a path and the kiosk navigates itself, because nothing can reach in and navigate it. Modes
are `standard` (the home wall — `home` is accepted as a second word for it and stored as `standard`),
`health`, `sessions`, `calendar`.

**A wall is a FILE, not a mode flag**, so work on one cannot disturb another. They share `core.js` /
`tv.js` / `wall.js` / `wallmode.js` / `cards/*`, so a change to those hits ALL of them; split
whatever needs to differ at the moment it needs to differ. If you are reshaping the default into
something you cannot verify in one pass, copy it to a new file and swap `/` when it is good — that
is how the home wall was built.

**On a phone, `wall.js` moves cards out of the shell into the misc pane** (`misc-litter-slot`,
`misc-surf-slot`) by moving the nearest enclosing `.card`. A card sharing a `.card` wrapper with its
neighbours takes them along: surf has a `.card` of its own inside the home wall's heat column purely
so that adopting it does not carry the whole column into the pane.

## The day column is one module

`cards/dayline.js` draws it everywhere — the calendar wall beside its months, the home wall's middle
column, and the phone's lists pane (`#daycard`, which it mounts itself). Surfaces differ in CSS size
and in which endpoint feeds them (`?day=1` alone, `?wall=1` when the same payload also carries the
months, handed back through `onload`), never in markup. There were two copies of this and they had
already drifted to different class names for the same chip and two separate clocks.

The home wall's **look-ahead** — the six days after today — is drawn by the same module, from the
same response (`&ahead=6`) and by the same reload, into a second element handed to `mount` as
`ahead`. One fetch and one clock for both: they are one answer to one question, and a look-ahead
re-reading on its own is two surfaces that can be showing different days at the same moment.

It is a LIST, not a timeline, and that is the whole design: today is a dial because he is inside it
and the question is how much of it is left, while a day at a remove only has to say what is on it.
The chips are the day column's own — same colours, same states — but they carry their time, because
no hour row underneath is saying it.

## Where a fact goes

`ARCHITECTURE.md` is the ecosystem view — it covers voice-pipeline, data-layer, devices and hosting
too, and lives here because this is the most active repo. `docs/HUB-INTERNALS.md` is the map of this
server and app. `docs/TODO.md` is the open-work list.
