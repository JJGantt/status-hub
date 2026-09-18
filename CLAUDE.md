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

`Dockerfile` **enumerates what it copies** — `server.js`, `build.js`, `lib`, `public`, `legal`. A new
top-level directory under `server/` is not in the image until it is added there, and nothing
catches that: the build succeeds, `/healthz` reports the right sha, and the files are simply
absent at request time. Curl the new path after deploying, not just `/healthz`.

It also **builds the client** (`npm run build`, esbuild) before pruning dev dependencies, because
`public/dist` is generated and not committed. Nothing has to be rebuilt by hand before deploying, and
a bundle cannot be stale against the source it shipped with. Locally, `npm run build` once before
`npm start`.

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

**The build machines sign with one permanent development certificate** (secrets `IOS_DEV_P12` /
`IOS_DEV_P12_PASSWORD`, local copy `~/.appstoreconnect/private_keys/statushub-ci-development.p12`),
imported beside the distribution one in both iOS workflows. Without a development identity in the
runner's keychain, automatic signing creates a new certificate on every run and the runner discards
its key; ten of those filled the account and every archive then failed with "maximum number of
certificates". It lasts a year: when it expires, make a new one and replace both secrets — never let
Xcode mint them again.

**Ship to his phone through TestFlight.** It installs over the air; an Ad Hoc `.ipa` has to be
pushed from the Mac with `devicectl`, so it needs the phone on the Mac's network — a build made while
he was out never got installed. The App Store Connect app is "JaredHub" (id `6805268657`) and its
internal group `internal_main` receives every build. Without a group an upload reaches no one, which
is how builds 1 and 2 sat unused.

## Checking the Swift compiles, on this Mac

Xcode 26 ships without the iOS and watchOS **device platforms**, so nothing builds for a device here.
Do not run `xcodebuild -downloadPlatform` to fix that — it pulls the multi-GB simulator runtime,
which has filled this disk before; the device platforms come from Xcode → Settings → Components.

When a watchOS simulator runtime is installed (`xcrun simctl list runtimes`), the watch app and its
extension build for the simulator with no signing, which proves the Info.plist, assets, embedding and
App Intents metadata as well as the code:

    cd apps
    xcodebuild -project StatusHub.xcodeproj -scheme StatusHubWatch -destination 'generic/platform=watchOS Simulator' build

Without a runtime, a watchOS build fails in `actool` on the asset catalog; type-check against the
SDKs instead, which are always installed:

    xcrun -sdk iphoneos swiftc -typecheck -target arm64-apple-ios18.0 -D HUB_APP Sources/*.swift Shared/*.swift
    xcrun -sdk watchos swiftc -typecheck -parse-as-library -swift-version 5 -target arm64-apple-watchos11.0 -D WATCH_APP Watch/*.swift WatchWidgets/RecordIntent.swift Shared/Auth.swift Controls/RingsView.swift
    xcrun -sdk watchos swiftc -typecheck -parse-as-library -swift-version 5 -target arm64-apple-watchos11.0 WatchWidgets/*.swift

The iOS app's assets, Info.plists and embedding are only proven by the CI archive.

## A new bundle id is registered first, then archived on CI

Register a new target's bundle id with `node apps/tools/asc.mjs bundle-id <identifier> <name>`
before its first archive; the CI archive's automatic signing then makes its Ad Hoc and App Store
profiles. It does NOT register a missing id itself — it picks a profile it cannot find and the
archive fails with "Build input file cannot be found: …mobileprovision". That is how `StatusHubWatch`
and `StatusHubWatchWidgets` were added.

Still blocked by the rejected Xcode login: capabilities the ASC API cannot enable (Time Sensitive
Notifications — `docs/TODO.md` § Blocked on Jared) and App Groups. A new iOS widget still goes into
the existing `StatusHubControls` bundle (the `WidgetBundle` at the bottom of
`apps/Controls/RecordControl.swift`); a widget and its button intents share `UserDefaults.standard`,
since they are one process already.

## An alarm rings from the phone, and the hub can only ask

`list_items.alarm` marks a dated item alarm-grade: iOS 26's AlarmKit rings it through silent mode and
through a Focus, the same as the Clock app. Everything about the design follows from one fact — **an
AlarmKit alarm is registered ON the device.** No push rings one, and there is no push-to-start the way
a Live Activity has. So the hub's whole role is to publish what should be registered and to ask the
phone to look.

| | |
|---|---|
| `GET /api/alarms` | what the phone should hold right now: every marked item due inside `ALARM_WINDOW_DAYS`. `at` is an ABSOLUTE instant (`instantFromLocal`), not the naive stamp the rest of the API speaks, so a phone that has travelled resolves nothing itself. |
| `POST /api/todos/alarm` | sets or clears the mark. Nothing infers it from priority or wording. |
| `POST /api/alarms/ack` | the phone reporting the whole SET it holds, after every sync. Arms the items in it, disarms the ones that are not, and diffs first so an unchanged sync writes nothing. |
| `nudgeAlarms()` | a silent push off the `list_items` subscription, for rows that are or were marked. |
| `Sources/AlarmSync.swift` | reads the feed and makes the device match it. |
| `Controls/AlarmWidget.swift` | the alert's Live Activity. |

**The sync carries a WINDOW, not a change.** Every run registers everything in the next week and
cancels what is not in it. That is what makes a dropped wake cheap: iOS throttles background pushes on
its own heuristics and delivers none at all after a force-quit, so the worst a missed one costs is an
alarm created since the last sync registering late, never the next alarm failing to ring.

**The sync runs from `scenePhase`, not from the app delegate.** This app is a SwiftUI `WindowGroup`,
so it is scene-based, and UIKit does not promise to call `applicationDidBecomeActive` in a scene-based
app. `AlarmSync.sync(why:)` is called from `.onChange(of: scenePhase)` and `.task` in
`StatusHubApp.swift`; the delegate calls it too, and the `why` in every beacon names which fired.
Foreground is the guarantee, the silent push is the speed.

**Only a foreground run may prompt.** `mayPrompt` gates `requestAuthorization()` — the permission
prompt is a question someone has to be looking at to answer, and the system gives one chance at it.

**Every exit beacons** to `/api/clientlog` as `ev: "alarm-sync"` with the trigger and the
authorization state: `start`, `asked`, `unauthorized`, `no-feed`, `done`, `limit`. This is the only
trace the device side leaves — scheduling is local and the wake is a fire-and-forget push — so
without it a silent failure is indistinguishable from a declined one. A push-driven run reports the
application state in its trigger (`push:background` / `push:active`), which is the only way to tell
work done while suspended from work done on screen.

**The alarm id is derived, not stored.** `HubAlarm.id` is sha256 of (item id, moment), so the sync is
a set difference against `AlarmManager.shared.alarms` with no local bookkeeping to drift — and moving
an item is a different id, so the old alarm is cancelled and the new one scheduled without anything
having to notice it moved.

**The alert is a Live Activity.** AlarmKit draws no UI of its own: it requires a widget extension
declaring an `ActivityConfiguration` over `AlarmAttributes<Metadata>`, which is
`Controls/AlarmWidget.swift` in the `StatusHubControls` bundle. Without one, scheduling succeeds and
nothing appears.

**None of it is a capability.** `com.apple.developer.alarmkit` does not exist, and putting it in an
entitlements file is what makes a device build fail with "provisioning profile doesn't include…". The
whole cost in the project is three Info.plist keys — `NSAlarmKitUsageDescription`,
`NSSupportsLiveActivities`, `UIBackgroundModes: remote-notification` — so no profile is regenerated
and the rejected Xcode login does not gate it. It does need the **iOS 26 SDK**: both iOS workflows
select the newest Xcode on the runner and fail with a named error below SDK 26, because the failure
otherwise is "no such module AlarmKit" deep inside a Swift file.

`UIBackgroundModes` also means the app wakes for the **badge-only** silent pushes.
`didReceiveRemoteNotification` answers `.noData` immediately for anything without an `alarms` key: an
app that claims work it did not do gets woken less often.

## An alarm is a REQUEST until the phone confirms it

`list_items.alarm` asks; `list_items.alarm_armed_at` is the phone's answer. The hub cannot see whether
an alarm will ring, so `/api/alarms/ack` carries the whole set the phone holds. A set rather than an
event, because a message about one alarm cannot express a cancellation and nothing else would clear
the flag on an alarm the phone dropped.

**The chip carries both states** (`chip()` in `cards/dayline.js`, so every day surface gets it at
once): a ⏰ in full colour is armed and will ring, a GREY one is asked for and unconfirmed. The
difference is COLOUR, not opacity — a colour emoji stays legible as itself at low opacity, so the two
states have to differ in hue to be told apart. One glyph either way, so there is no second symbol to
learn, and the grey one is a warning readable before the moment rather than after sleeping through it.

**An alarm does not also notify.** `dueTick` skips the push for `r.alarm`: the full-screen alert has
already broken silent mode and Focus, and a banner behind it repeats it quieter at the same second.
The consequence to know: the notification is what carries the Done / 1 Hour / Tomorrow buttons, so an
alarm-grade item is actionable only from a list.

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

`public/tv-home.html` (`/tv`) is the **home wall — the default, and what the TV is showing**.
The shared frame (status strip · rings · health bar · footer · voice column) around four columns:
today's day column, the six days after it, the weekly weigh-in plot over the three heat maps stacked
with the strip that belongs to each (nutrition totals vs target, the rest/session clocks, surf), and
the focused session's last answer. `tv-home.js` + `tv-home.css` are its own; everything else on it is a shared card `core.js`
already paints, which is why the page is mostly markup. This is the one to shape.

Its grid is SIX columns, declared in `tv-home.css` — which means the spans app.css writes for its
five are wrong here and are overridden alongside it: the status strip reaches column 6, the footer
column 7, and the health bar sits in 6. Add a column and those three are what silently misplace.

`public/tv-health.html` (`/tv-health`) is the health wall — the only place nutrition, the muscle map,
the volume bars and the workout heatmap are on one screen, each with the detail panel its heatmap
fills. Too much to glance at from a couch, which is why it is not the default.

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

The weigh-in plot above the heat maps is aligned to their week columns, and that alignment is the
whole chart: `cards/weightweeks.js` insets its box by half a column at each end so x runs from the
first column's centre to the last's, all in CSS calc from `--cols` and the grid's gap. Change the
gap in `.heat` and `--hgap` in `tv-home.css` has to move with it. Its first column is deliberately
blank: the three axis values are written over the left end of the plot, because a gutter for them
would inset the data and being uninset is the entire point.

That is the HORIZONTAL axis. Vertically the drawing is inset by `--wpi`, half a label, at each end,
and that inset is what lets each axis value be centred on the line it names: centred on a line at the
very edge of the 68px slot, the top number would hang over the card's rule and the bottom one over the
first cells of the nutrition map. The label and its line are both placed from the server's `a.y`, so
they cannot drift apart — anchoring an EDGE of the text to the line is what made 179 sit under the 179
line and read as the label for the point above it.

It also has no height of its own to spend — the column was already exactly full — so the plot's 68px
came off the heat maps. A cell takes its height from its WIDTH, so squaring them again meant
narrowing the grid by the same proportion: `.hw-heatstack` is a fixed 359px, and the sum behind that
number is in `tv-home.css`. The 65px it frees goes to the muscle column, which is why those figures
are drawn `preserveAspectRatio="none"` — at that width a 36:93 figure no longer fills its box, and
`meet` leaves the other half of the artwork showing beside it.

**A wall drops every label a reader could infer, and this is deliberate.** No month row over the two
week heat maps (`.hmonths` is hidden in `tv-home.css`), no weekday letters over the surf grids and no
hour labels beside them (`onWall()` in `cards/surf.js`). At couch distance a 9-11px string is not
read, and what those said — which end is old, roughly where in the week a column falls — the columns
already say. The guide LINES they named all stay: the line was doing the work, not the word. Two
things keep their numbers, because no colour or placement can carry them: the water temperature and
the weigh-in plot's three values. The markup and the phone are untouched — the month row still paints
in the expanded sheet, and the phone's surf card keeps its weekday letters and its 6a / 12p / 6p
hour labels. Every phone surface carries `body.tv` for the card styling, so `onWall()` tells them
apart by `phonewall` — set by `wall.js` on a wall opened at phone size, and written into the markup
on `phone-home.html`, which is never anything else. Test for `tv` alone and the phone silently loses
its labels too.

**The heat column's bottom card is surf AND weather**, side by side: the surf plots narrowed to the
heat-map width (403px) so their day columns line up with the week columns above, and `cards/weather.js`
in the width that frees, under the muscle figures. Narrowing did not squeeze the surf columns — the
default window in `/api/surf/history` came down to three weeks with it, so a day is still ~18px. On
the phone `wall.js` adopts the whole `.card`, so weather goes with it and the two stack instead
(`app.css` sizes that; `tv-home.css` re-lays them as a row).

The surf grids are ruled the same way, and the ink says what a mark MEANS. **Black is fixed
structure**: a 1px line at each Saturday -> Sunday boundary (Sunday-aligned, like the week columns
above), which is what makes a day countable now that the letters are gone. **White is the hour axis
and now**, graded so the eye always knows which line it is on: the now-line and its crossbar solid,
noon at 70%, 6a and 6p at 35%. There is no rule between the two grids at all — ratings run red
through green and size runs white (0-1 ft) then blues, so the boundary draws itself. The white
guides are invisible over a white 0-1 ft cell; that band is the one place the hour axis drops out. A dashed line seven days out used
to count the columns off against today; the week rules do that better, per column edge instead of
once, and it is gone. The rain grid beside it follows every one of these rules, because they are one
card describing one week.

**A wall is a FILE, not a mode flag**, so work on one cannot disturb another. They share `core.js` /
`tv.js` / `wall.js` / `wallmode.js` / `cards/*`, so a change to those hits ALL of them; split
whatever needs to differ at the moment it needs to differ. If you are reshaping the default into
something you cannot verify in one pass, copy it to a new file and swap `/` when it is good — that
is how the home wall was built, and how the phone's home page was.

The phone's home page is a file on the same terms: it is NOT a wall and `wallmode.js` never touches
it, but it draws the same cards from the same frame, so a change to `core.js` or `cards/*` reaches
it as well as the four.

Each page loads **one** `<script src="dist/<page>.js">`, built from `public/pages/<page>.js` — which
lists the modules that page runs, in order. **That entry file is where a module is added or removed**;
a new `<script>` tag in the HTML will not load. A new *card* needs nothing, since `core.js` already
imports it and the bundler follows the graph.

**A WALL opened at phone size moves cards out of the shell into its misc pane** (`wall.js`,
`misc-litter-slot`, `misc-surf-slot`) by moving the nearest enclosing `.card`. A card sharing a
`.card` wrapper with its neighbours takes them along: surf has a `.card` of its own inside the home
wall's heat column purely so that adopting it does not carry the whole column into the pane. The
phone's own home page does none of this — it has its own markup and puts each card where it wants
it — so this is about the walls, and about keeping them openable on a phone.

## The phone's home page is not a wall, and it FITS ONE SCREEN

`public/phone-home.html` at `/` — what the iOS app loads. It carries everything the home wall
carries, in portrait, and two constraints shape all of it.

**It is not scaled.** Every other phone view of the hub is a wall: `wall.js` renders the 1920x1080
shell into a fixed 1080-wide canvas and CSS-transforms it down, so on a 393pt phone the scale is
about 0.36 and the wall's 17px label lands at 6px of glass. That is the whole readability problem,
and it is not reflowable — the wall's type is written for a room. `phone-home.css` is laid out at the
phone's own size instead, so a size in it is the size it is read at, and the cards that measure
themselves come out at the sizes their own modules chose for a phone.

**Nothing scrolls vertically** — except the conversation, which is the point of it. `.rows` is the
pane's height LESS the navbar and the home indicator, and it holds that in `height`, not in
`padding-bottom`: `overflow:hidden` clips at the PADDING box, so the moment the blocks added up to
more than the space the last of them rendered down into that padding and out under the bar. Every
block on it is either a declared height or sized by its own content.
Exactly one takes the leftover: the conversation at the bottom, `flex:1 1 auto`, because it is the
only block here that can spend an arbitrary amount of height — more room is simply more of the
thread. It scrolls and is pinned to the newest line, re-pinned by a ResizeObserver because its own
height is not settled when the thread first paints into it. There are no card borders and almost no padding for the same
reason: a rule costs two pixels of height for something the black ground between blocks already says,
and where two things genuinely need separating they get a background instead, which costs nothing.

Its body carries four classes and each does a job. `tv` is the card styling the walls share (black
ground, headings off, the heat maps, the rings, the chips). `phonewall` makes every card take its
phone branch. `homewall` is the 15-week heat window (`HOME_HEAT_WEEKS`), which is the window the
weigh-in plot's columns are built on — a surface drawing that plot has to ask for it. `phonehome` is
this page: it turns the kiosk verdict off whatever the window width, and it is what the CSS hangs on.
It also beats app.css's `body.tv.wallportrait` block on equal specificity, by loading after it.

**What it does differently from the wall, and why:**

- **Today LIES DOWN** (`cards/daystrip.js`) — hours left to right, each item at its own time. The
  dial is the same day standing up, which suits a tall column read across a room; a phone in portrait
  has width and no height, so the axis turns and the day scrolls under a fixed viewport.
- **TWO SCALES ON ONE BAND.** Today is a CLOCK: every hour named, wide enough to read the time off.
  A day at a remove is not a clock — nobody asks where in Saturday something falls, only what is on
  it — so it collapses to a block the width of a few chips, one per lane, with the rest counted at
  its head. At today's scale a distant day costs six hundred pixels to say almost nothing, and
  squeezes today's hours below the width a label needs.
  **Tapping a collapsed day opens it** at today's scale, and tapping it again closes it. One at a
  time, because two full days side by side is most of the strip spent on two days, which is what the
  blocks exist to avoid. The strip runs sixty days out (`ahead=60`): a scroller that stops a week out
  is a week you can reach and nothing beyond it.
- **The RESET button on the navbar** (`hubreset`, broadcast on `window`) leaves the page as a FRESH
  LOAD leaves it, without reloading. Not just scroll: the three heat rails to the newest week, every
  list to its own end, the pane back to home, the surf plots to today, the strip to now with only
  today open, both heat maps' selected day back to today, every expanded nutrition entry closed, the
  muscle sheet and any open section sheet closed, and a session opened over the repos list back to the
  list. An event rather than a call, so whoever owns a piece of that state listens for it and the
  navbar knows none of them — which is also the trap: state added anywhere without a listener is state
  the reset silently leaves behind.
- **The RINGS FOLLOW THE SELECTED DAY.** Tapping a cell on the food heat map points all seven gauges,
  the `2699 / 3060` under each and the deviation in each hole at that day, measured against the goal
  THAT day had: the calorie target is dynamic and the macro split follows that day's bodyweight, so a
  day in July is not judged by today's numbers. `cards/nutritionlog.js` announces the day it has
  loaded (`nutday`) and `cards/nutrition.js` draws it; today is announced too, which is what returns
  the rings to the live clock. A finished day is `frac = 1` — the whole goal was expected, so the arc
  is what was eaten against it, the same math the live tick reaches at the end of the eating window
  rather than a second way of drawing a ring. The mini produce rings move with them, because
  `/api/nutrition-day` rolls that day's own produce; without it three of the seven would report today
  beside a day in August.
- **Which day it is, is pinned to the left of the strip** and does not scroll with it (`.ds-here`).
  The day names inside the strip sit at their own midnights, so today's is off the left end whenever
  the strip is on now — leaving the page with no date on it anywhere but tomorrow's.
- **The strip keeps going past midnight**, ruled and labelled at each day boundary, which is what
  makes the look-ahead cost nothing here: scroll right and you are in tomorrow. There is no separate
  list of the next six days; one costs a third of the screen to say less.
- **No status strip.** The litter robot, the feeder, the mics and the routing chips are in the misc
  pane. None of them changes hour to hour, and all four are a chip strip, which is the one shape a
  swipe pane has room to spare for.
- **The session panel is the list and nothing else.** No head, no reply: a phone has nowhere to put
  a model's answer, and the wall spends a column on one because it is read word by word from a chair.
- **The voice column is the tail of the thread** (`#ph-conv`), rendered as MARKDOWN. A reply is
  written in markdown, so reading it as plain text collapses every newline and leaves `**bold**` and
  `- ` standing in the prose. `md()` in shared.js covers the part a model actually writes: headings,
  lists, emphasis, code, links. EVERY path escapes first — the text is a model's, rendered into an
  origin already authenticated as Jared, so no tag comes from the input; the input is escaped and our
  own patterns put tags around it, and a link is rewritten only when its target is http(s).
  A reply RELAYED FROM A SESSION carries that session's name and the tint the conversation card gives
  it: it is a machine reporting back, not the hub answering. There is no `You` / `Hub` label — his own
  words are dim and the hub's are not, which is the whole of who-said-what, and a word in a gutter
  repeats it at the cost of that gutter's width on every line.
  **IT LANDS ON THE TOP OF THE LAST MESSAGE**, not at the bottom of the thread: a reply is read from
  its first line, and a box scrolled to the very end shows its last line with the rest above. Clamped,
  so a short last message rests at the end of the scroll. The session view lands the same way (`open`
  in cards/repos.js puts the last turn's prompt at the top), and the reset button uses it too.
  Measured off the rects rather than `offsetTop`: the box is not an offset parent, so offsetTop is
  against some ancestor and the difference is a shift, not the number wanted.
  **A COMMAND HE HAS SPOKEN APPEARS BEFORE THE REPLY DOES.** The worker writes the user bubble only
  once a run is over — deliberately, so a wake-word false positive never lands in the thread — so
  nothing in the thread itself marks the gap between speaking and answering. `onPending` in
  voiceagent.js is the conversation card's optimistic bubble for every OTHER view of the thread: three
  dots while a clip is being transcribed, then the transcript in its place, then the real row
  replacing it. Two sources, and both are needed — the upload's own answer is LOCAL (only the
  recording device knows a clip is in the air), while the worker's `working` activity carries the
  transcript to EVERY device, which is what makes a command spoken at the puck appear here. The
  placeholder comes down on the matching user row or on the reply, never on a resync replaying
  history, and a run that reports nothing back drops it after five minutes.
  **There is no chat PANE; there is a chat SHEET.** The navbar's keyboard button opens `#ph-chat`
  over the page — the same `ai-shell` markup the walls carry, wired by the same `initCard()` in
  voiceagent.js — with the whole thread, the composer, the mic, the attach tray and Reset context. A
  sheet rather than a pane because it covers whatever is open instead of taking a slot in the swipe
  order, and the whole chat rather than a bare input because composing a reply means seeing what you
  are replying to, which the tail here cannot show with a keyboard over half the screen. It lands on
  the newest line BEFORE the input takes focus: focusing first makes iOS scroll the page to the input
  and the log stays wherever that left it.
- **The two heat maps are STACKED, each a small block at the LEFT of its own section.** Above each
  is its long view (the weigh-in trend, the clocks since the last set); below it is the day itself,
  as a SCROLLING LIST — four nutrition entries, each tapping open to its ingredients, and three
  exercises with their sets. The room for those lists is what the small maps buy.
- **The maps take NO trim, and that is not an oversight.** They scroll, so the box decides what is on
  screen and everything either side is a drag away — and a trim cannot carry the archive anyway:
  `/api/heat-history` returns the weeks OLDER than the frame's own window, so prefixing it to an
  eleven-week trim drops weeks 12-20 out of the middle of the picture, silently and in the right
  colours. The cell is 12px, so the map is 90px tall whatever its width; `PHONE_HEAT_WEEKS` survives
  only as the count the weigh-in plot is built on, which has to be the number of columns the FOOD map
  shows at rest, because the plot does not scroll with the map under it.
- **The maps land on the newest week and stay there**, held by an observer rather than pinned once:
  the cards rebuild the grids on every frame and `paintScrolled` carries the position across, so a
  single pin at the wrong moment is a wrong position that persists all day. It stops the moment he
  drags one, which is what `paintScrolled` is for.
- **Both maps are the same width**, and the ground beside each is the same shape: the figures fill it
  on the training side and it stays empty on the food side.
- **A DRAG ON A HEAT MAP HAS TO REACH THE BROWSER.** Scrubbing a map and scrolling one want the same
  gesture, and the cards resolve it by preventDefaulting the drag wherever the grid cannot scroll.
  That test is `scrollableX(el, host)` in shared.js, which asks the DOM — and its walk STOPS AT THE
  HOST, because the phone's panes are themselves a horizontal scroller and an unbounded walk finds one
  from anywhere, which would mean no grid ever scrubs.
- **THE TWO MAPS AND THE WEIGH-IN PLOT SCROLL AS ONE, AND THEIR DAYS STAY ALIGNED.** That needs both
  halves, and the first is the one that matters: **all three SPAN THE SAME WEEKS**. `/api/heat-history`
  builds both maps over the LONGER of the two archives and ships a weigh-in plot across it, so a given
  week is the same column in each. Built to their own lengths they stop at different places — the food
  map's archive starts later, since intake logging began after the training log did — and dragging
  back runs one out of columns while the other carries on, leaving the two on different months. A week
  before the logging started is an empty column, which is what the map draws for a day with nothing on
  it anyway.
  The mirroring is in WEEKS, not pixels: `round((max - scrollLeft) / 13)`. Pixels are close and not
  equal, because the plot's drawing is inset half a cell at each end and its scroll range is a column
  narrower than a map's.
  The plot's WIDTH is resolved ON THE PLOT, from the `--cols` cards/weightweeks.js writes onto
  `#weightweeks`. A custom property resolves `var()` against the element it is DECLARED on, so the same
  span declared further up the tree takes the fallback silently and draws the plot too narrow to
  follow the maps.
  It is drawn across the whole span inside a scroller of its own, with its axis values a SIBLING of
  that scroller rather than a child — a child slides off the left end the moment it is dragged. It is
  REPLACED outright on every render where the maps repaint through `paintScrolled`, so the rebuild
  handler puts it back on the week the maps are on; left alone it returns to `now` once a minute while
  they stay where he left them.
  Only the plot's two END values are labelled: three numbers stacked in a 22px box are crunched, and
  the middle one is the one a reader infers from the two either side. Its LINE stays — the line does
  the work.
  The mirroring flag clears a FRAME later, not on the next line: setting `scrollLeft` fires a scroll
  event of its own, so clearing it synchronously lets the mirrored rails answer back and the shortest
  of them drags everyone to its own end.
- **THE BODY OPENS**, into the same sheet the surf plots use (`expand.js`, `data-sec="body"`), and it
  brings the VOLUME BARS with it — `#volume` is in the phone's markup but `display:none`, because
  twenty-three rows do not fit a screen that already fits exactly, and the sheet is the only surface
  here with room for them. In the small view a tap does NOT pick a muscle: `#body` carries
  `data-nosel`, and `cards/muscle.js` tests `closest('.sectsheet')` rather than a fixed flag, because
  the same element is both surfaces and it is MOVED between them. Two whole figures in 133px puts a
  region at a few pixels, and the detail it opens covers half the screen; aiming at one is a thing to
  do expanded.
  The sheet gives the figures a DECLARED BOX with `flex:1 1 0` svgs inside it, not an `aspect-ratio`:
  the figure svgs carry a `width` presentation ATTRIBUTE, which beats `width:auto`, so aspect-ratio
  alone does nothing and each half takes the container's width. The volume rows are re-sized there
  too — their base styling is a desktop card's, and at 41px a row the list runs two screens under the
  figures.
- **The body figures fill the training section's height**, and their column's width is what that
  height implies (2 x 0.387 x it) rather than a number picked first — anything less leaves a band of
  black above and below them. A hair under, deliberately: each split svg holds the whole 72-unit
  artwork with a 36-unit window over it, so horizontal slack inside the box is filled by the figure
  next door and `overflow:hidden` cannot help, because the bleed is INSIDE the element.
- **Every list on the page scrolls** and is capped by a DECLARED height: the entries, the exercises,
  the sessions, the conversation. A list with no ceiling in a row that takes its height from its
  tallest child makes the row as tall as the list, which pushes everything under it off the screen.
- **The cell gap is 1px, not the wall's 2.5.** A cell is about eighteen pixels here where the wall's
  is twenty-five, so the wall's gap is a seventh of the mark instead of a tenth and the grid reads as
  black ruled by colour. `--hgap` on the weigh-in plot moves with it — half of it is what the plot's
  box is inset by at each end.
- **Surf and the session list share a row**, and a session row is TAPPABLE: it opens in the session
  view one swipe LEFT (`cards/repos.js`, `window.__showSession`), with the whole conversation and a
  composer. So a title truncated in that column costs nothing — it is a way in, not the answer.
- **THE SURF PLOTS ARE TAPPABLE TOO**, into the full-screen sheet (`expand.js`, `data-sec="surf"`).
  That is the other half of the bargain the small card makes: it is thirty pixels a grid and bare on
  purpose, and everything it drops — the gutter with its hour labels, the weekday letters, the key,
  the conditions strip — returns simply by not being inside `.ph-surfcard`, since every one of those
  rules is scoped to it. The sheet says its own `--surf-grid-h` / `--surf-water-h` / `--surf-back`,
  and re-sizes the conditions strip, which `body.tv` otherwise writes at wall size (a 23px name and a
  31px value) and which at that size takes a third of the screen for three words.
  **THE EXPANDED GRIDS ARE RULED HOURLY** (`--surf-hours: 1`), and it is the only surface that asks:
  at the card's 30px a grid an hour is a pixel and a quarter, where twenty-three lines are a white
  wash over the data. Three tiers, and they FOLLOW THE GUTTER — every line the gutter names is solid,
  every line it does not is a dash:
  6a / noon / 6p solid and bright, one mark rather than graded against each other, since they are
  equally the skeleton of a day and the gutter says which one you are on · 3a 9a 3p 9p solid and dim,
  so halving a quarter of the day is a read and not a count · every other hour dashed and fainter. The
  dash is not decoration: a faint SOLID line at hourly spacing reads as a second grid competing with
  the cells, where a dash reads as a ruler.
  The gutter names every THIRD hour and no more — twenty-three labels at 9px is the same noise in
  words. The card and the wall draw only the first tier, and THERE it is graded (noon the reference,
  the sixes bracketing the daylight), because with three lines on the whole grid the grading is the
  axis.
  **A TAP HERE IS NOT A CLICK**, because the plots are a horizontal scroller and the two gestures
  start identically: `bindTap` opens only when the pointer barely moved AND the scroller under it did
  not, the second test being what catches a flick answered by momentum rather than by the finger. It
  is delegated from the card, which persists, rather than bound to the plots, which are rebuilt twice
  a minute.
- **The day's totals are ON THE RINGS**, one under each gauge — `2699 / 3060` under Cal, `134 / 178`
  under P. That is the totals line split four ways and attached to the thing each number belongs to,
  so it needs no labels and there is no separate band: `#nutinfo` carries `data-noband` and
  cards/nutritionlog.js drops it. It also settles the section's two halves against each other, which
  come out within a pixel of each other.
  The ring grid is `repeat(2, minmax(0, 1fr))`, and the `minmax(0,` is load-bearing: a grid item's
  automatic minimum is its CONTENT, so a plain `1fr` sizes each ring to its svg's intrinsic width and
  the ring column stands far taller than the one it is supposed to match.

Its panes are [sessions] [home] [misc] [maint] [lists] [reports], landing on home — index 1, which is
what `panes.clientWidth` means in `phone-home.js` and what the reset returns to. Driven by
`phone-home.js` rather than `wall.js`, since there is no canvas to scale and only the paging is left.

**SESSIONS sits immediately left of home**, where the walls put their chat pane. It is the one pane
reached by swiping rather than by tapping something, and it is the answer to the home page's session
block, which is deliberately only a list. Tapping a row there lands here with that session's whole
conversation and a composer.

**A session row carries two marks, and they answer different questions.** `on` is the FOCUSED
session — where a spoken follow-up goes, and what a surface with a reply panel is showing below.
`unread` is a finished answer nobody has opened: `buildSessions` sets it from `reply_at` being newer
than `seen_at`, so tool calls and thoughts never raise it and only a completed reply does. Opening
the session stamps `seen_at` (`POST /api/sessions/seen`), on the row rather than per device, because
the phone and the wall are looking at one list and reading an answer on either means it has been
read. Two things stamp it: opening the session in the hub, and — on the Mac — its Terminal tab being
frontmost, which the orchestrator's reconcile tick watches (`readFront`). The terminal's own BELL
cannot be read or cleared: Terminal.app sets it from a BEL character and clears it when the tab is
selected, and its AppleScript dictionary has no property for it at all (a tab offers `busy`,
`selected`, `tty` and `custom title`). So what is watched is the thing that CLEARS the bell rather
than the bell, which fires at the same moment for the same reason — and the traffic runs one way:
reading on the Mac clears the phone, reading on the phone cannot clear the Mac's bell.
The `✳` and `◐` in a tab's `custom title` are Claude Code's idle/working glyphs, not an unread mark.
An unread row takes an amber left edge and its full opacity back — it is very often parked and
idle, which is exactly when a row is dimmed, and a finished session is the one most worth reading.
**That rule is written TWICE**, in `phone-home.css` and `tv-home.css`: `.hw-row` is defined in both
and each surface loads only its own, so a rule written in one of them reaches half the surfaces that
draw this row.

**A session is typed into, so a PICTURE is sent as a PATH.** The composer's attach button shrinks the
image and uploads it to `/api/attach` — the same bucket the chat composer fills — and the follow-up
carries the object names. The machine that OWNS the session pulls the bytes down beside its stashed
prompts (`fetchAttachment`) and prepends a line naming the local files, which the session reads
itself. A picture with no words is a whole message. It reaches the hub with `?token=`, the way
everything on that machine does; `X-Hub-Token` is the derived token the iOS app carries and not this.

**A message too long for a tty is stashed, and both halves of that are hidden here.** `sendToTty`
parks the words in `~/.claude-desk-prompts` and types a one-line stub naming the file, so the STUB is
what the transcript holds: `turnStart` substitutes the file's contents back, which is why every
surface shows the words. The stub also asks the session to reply with them verbatim, so they are
visible in the terminal — and that echo is the same paragraph twice anywhere the stub has already
been resolved, so `sessionWatch` drops the text frame that quotes it, matched on a flattened middle
slice of the prompt (the part a quotation reproduces exactly, where its two ends differ). The stash is
swept at thirty days: deleting a file turns the message back into the stub wherever it is drawn.

**The session view lands on the top of the NEWEST THING** (`paintBody` in `cards/repos.js`). The last
block in the body is that thing; inside a turn it resolves one level further in, to the reply rather
than the prompt that asked for it. A tool call or a thought after the last turn is newer, so it wins;
a turn still running ends in the caret, and the caret goes as far up as the scroll allows — which,
with history above it, is simply the bottom. The browser's own clamp is what turns "as far up as it
can" into "at the end" when the tail is shorter than the box, so there is one rule and no cases.

### Wall-sized numbers a surface can override

Each of these is a card's DEFAULT, sized for a wall, which any surface can replace with a CSS custom
property on the card's element. A surface that says nothing gets the default. A phone at arm's length
wants most of them smaller.

| what | where it is said | why |
|---|---|---|
| `--surf-grid-h` / `--surf-water-h` on `#surf` | `cards/surf.js` | its own 86px a grid plus 68px of water is a third of a phone screen for one card |
| `--surf-back` on `#surf` | `cards/surf.js` (`layout`) | the server lands the card twelve days back, which fills a wall; in a card a fifth of that area it put a day under ten pixels and showed MORE of the archive than the wall does. Seven back and everything forward. Older is still one drag away |
| `--surf-bare` on `#surf` | `cards/surf.js` (`onWall`) | the weekday letters and the hour labels. A wall drops them because nothing that small is read across a room; a small card drops them because the picture already answers them |
| `--surf-hours` on `#surf` | `cards/surf.js` (`HOURLY`) | rule every hour instead of the three. Only the expanded sheet asks: at 30px a grid an hour is a pixel and a quarter, and twenty-three lines there are a white wash over the data |
| `--wx-h0` / `--wx-h1` / `--wx-guide` on `#weather` | `cards/weather.js` | `pop` carries all 24 hours and `window` is only what the server took its peak over, so a surface can draw a narrower band. 6am to midnight here, with ONE guide at 3pm: in a 44px block the server's three graded lines are two pixels apart and say less than one does |
| `.addbtn` / `.dact-btn` / `.dex-head`'s column | app.css, under `body.tv.phonewall` | all three are written for a canvas scaled to about a third — a 110px-wide button and a name stacked over its macros. At native size that is a slab and two rows per entry, so the phone's home page flattens them |
| `--rc-base` / `--rc-min` / `--rc-name-base` on `.hw-recent` | `cards/workouts.js` (`fitRow`) | the set list starts at 16px and the exercise name at 17px, and both shrink only on overflow — so on a phone they draw half again the size of everything around them and stay there |

Two more things on that card are not knobs but are worth knowing. The left GUTTER holds the hour
labels and the water temperatures; with the hours dropped it is dead width, so the phone positions the
water's gutter canvas over the right-hand end of the plot (where the trace has run out) and hides the
grids' entirely, which is what gives the plots that width. And the water trace's scale hugs its data
rather than rounding out to whole degrees with one either side, which at this height flattens a
three-degree swing into a line across the middle of the box.

## The split body figures carry the WHOLE artwork, and only a viewBox hides half of it

`cards/muscle.js` splits the one 72x93 figure into a front and a back by emitting the same `<g>`
twice with `viewBox="0 0 36 93"` and `viewBox="36 0 36 93"`. Nothing is removed — each half is the
entire drawing with a window over it — so the window only holds while the svg's BOX is that 36:93
ratio, and any box wider than it paints the other figure beside the one it is supposed to show.

**Never size one with `width:auto`.** Chrome resolves it from the viewBox's ratio; **Safari resolves
it to the container's width**, so `meet` centres a 36-wide window inside a box twice that and the rest
of the artwork spills out beside it — four figures where there should be two. `.figstack svg` carries
`overflow:hidden` in app.css, and every box that holds one is pinned: `aspect-ratio:36/93` on the
phone's own, a declared box with `flex:1 1 0` svgs in the expanded sheet (where a `width` presentation
attribute on the svg beats `aspect-ratio` outright).

**The card that holds them is a DECLARED width**, not one sized by its content. A block whose width
comes from something that can go wrong takes its neighbours with it when it does: content-sized, a
spilled figure claims the whole row and leaves the sessions list beside it with no width at all.

## The day strip: the scale is what makes the lanes mean anything

Each chip goes in the first lane FREE AT ITS OWN X, so a title takes the width it needs and the next
one drops a lane. When every lane is busy, the chip already sitting in the lane that frees soonest is
CUT SHORT rather than overlapped — a title losing its tail is still readable, two titles on top of
each other are not.

**`hourW` is the number to be careful with, and it is 26px.** A chip is about three hours wide at
that scale, which is a duration — so two things at the same end of an afternoon share a lane and only
a real collision drops one. Narrow it and a titled chip spans five to ten HOURS, blocking its lane for
the rest of the day: four items an hour apart then take four lanes, one chip each, and the x of every
one of them says nothing the little `4p` written on it does not. The visible window is about fourteen
hours, most of a waking day.

**Its height comes from the DAY, not from the space available.** Three lanes always, which is the
room a collision needs; a fourth only when the day wants one; nothing beyond. It must not measure its
own container: that container is sized by its content, so a first paint reads a box nothing has
squeezed yet, claims six lanes of it and keeps them.

## What is running is one module

`cards/sessions.js`, on the home wall, the phone's home page AND the sessions wall
(`/tv-session-focus`). `mountSessions` takes the elements a surface has: a list always, and a `head` +
`reply` only where there is room for an answer.
Everything else — the numbering, the ordering, the highlight, the activity line under each row — is
shared, and it has to be: `n` is the number he says out loud, so two copies of that ordering is two
surfaces that can disagree about which session is "the second one".

**A surface styles those rows; it does not build them.** The sessions wall lays the same `.hw-row`
markup out as a row of tabs (`tv-focus.css` scopes every rule to `.sf-tabs`), which is why the pin,
the unread mark and the live activity line reach it without `tv-focus.js` knowing they exist — it is
twenty lines, and all of them are the mount. A second renderer is how a wall ends up disagreeing with
the phone about which session is pinned.

## The day column is one module

`cards/dayline.js` draws it everywhere — the calendar wall beside its months, the home wall's middle
column, and the phone's lists pane (`#daycard`, which it mounts itself). `mount` also takes a NULL
column, which is the phone home page: it wants the look-ahead and no hour rows, and it still has to
be the same mount, because the look-ahead and the day are one answer to one question and a second
fetch on its own clock is a second chance to be showing a different day. Surfaces differ in CSS size
and in which endpoint feeds them (`?day=1` alone, `?wall=1` when the same payload also carries the
months, handed back through `onload`), never in markup. There were two copies of this and they had
already drifted to different class names for the same chip and two separate clocks.

The home wall's **look-ahead** — the six days after today — is drawn by the same module, from the
same response (`&ahead=7`) and by the same reload, into a second element handed to `mount` as
`ahead`. The response asks for SEVEN days because the first one back is today: it feeds the **dock**
and the look-ahead column draws the six after it.

**The dock** is today's items the dial cannot show yet, held at the bottom of the dial column until
it can (`paintEdges` in `cards/dayline.js`) — and today's all-day items, under a rule beneath the
timed ones, since no row will ever carry them and their deadline is the end of the day. The dial is a rolling window centred on now and it
foreshortens hard, so being inside the +-12h window is not the same as being readable — just past
midnight a noon item sat on a ONE-PIXEL row while its 4pm and 10pm siblings were outside the window
altogether, and the whole of that day was invisible the moment it began. Membership is therefore
decided in the client, after `project()` measures: an item is docked when it is still ahead and not
on a row with room for words (`.thin`) that no cover reaches. A dock row is built to BECOME a dial row
without moving — same 46px hour gutter, same 10px gap, and the height of the dial's last readable
row (a full chip when no readable row has one to measure) — so the only
thing that changes when the drum reaches it is that its hour stops being greyed. The dock covers the
dial's tail rather than shortening it, and it is only as tall as it needs to be: nothing waiting, no
dock at all. One fetch and one clock for both: they are one answer to one question, and a look-ahead
re-reading on its own is two surfaces that can be showing different days at the same moment.

It is a LIST, not a timeline, and that is the whole design: today is a dial because he is inside it
and the question is how much of it is left, while a day at a remove only has to say what is on it.
The chips are the day column's own — same colours, same states — but they carry their time, because
no hour row underneath is saying it.

**A day's box is a grid that fills itself.** The server ships `rows` and `cols` per day and the
chips take the box between them, so four items are read at 20px, five at 15, six at 12, and seven
or more break into two columns. Nothing is a fixed size, because a fixed size in a box of unknown
fullness is a spare strip under every busy day. The table is in `docs/HUB-INTERNALS.md`.

**The overdue rows** are the dock turned over: items that went red and are still unfinished, held at
the TOP of the dial once it cannot show them — their row receded past words, left the window, or was
never in it because they were due on an earlier day. `full=1` ships every one as `overdue` (any date,
oldest first, each with a `when` label for the gutter) and the client keeps whichever are not legible,
newest four shown and the rest as `+N`. They sit ABOVE the date, because below it they would claim to
be today's. The date and these rows are one opaque block (`.cw-top`) covering the head of the dial,
so the axis stays the middle of the column. The dial gets no all-day strip (`allday` is empty for
`full=1`): an all-day item waits in the dock until its day ends, and only then, if still open, goes
red and joins these rows. Under the date it looked like one of the overdue items, which it is not.

**A cover counts against legibility.** A row either cover reaches, even partly, is `.covered`: blanked,
and its items not counted as shown, so an overdue item under the top cover joins it instead of
vanishing beneath it. That makes membership depend on the covers' heights and vice versa, so
`paintEdges` iterates from nothing held, painting and measuring each pass; each pass can only add, so
it settles, and on the same answer for the same geometry whatever was drawn the minute before.

## Where a fact goes

`ARCHITECTURE.md` is the ecosystem view — it covers voice-pipeline, data-layer, devices and hosting
too, and lives here because this is the most active repo. `docs/HUB-INTERNALS.md` is the map of this
server and app. `docs/TODO.md` is the open-work list.
