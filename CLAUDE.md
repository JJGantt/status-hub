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

`public/tv-health.html` (`/tv-health`) is the health wall — what used to be the default, and still
the only place nutrition, the muscle map, the volume bars and the workout heatmap are on one screen,
each with the detail panel its heatmap fills. Too much to glance at from a couch, which is why it
gave up `/tv`. It held `/` for a while after that, which is how the phone came to be reading a wall;
`public/phone-home.html` has that route now.

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
  dial is the same day standing up, which is right for a tall column read across a room; a phone in
  portrait has width and no height, so the axis turns and the day scrolls under a fixed viewport.
- **Which day it is, is pinned to the left of the strip** and does not scroll with it (`.ds-here`).
  The day names inside the strip sit at their own midnights, so today's is off the left end from the
  moment it lands on now — and the only date anywhere on the page then read FRI 18: tomorrow.
- **The strip keeps going past midnight**, ruled and labelled at each day boundary, which is what
  makes the look-ahead cost nothing here: scroll right and you are in tomorrow. There is no separate
  list of the next six days, and there was — it ate a third of the screen to say less.
- **No status strip.** The litter robot, the feeder, the mics and the routing chips are in the misc
  pane. None of them changes hour to hour, and all four are a chip strip, which is the one shape a
  swipe pane has room to spare for.
- **The session panel is the list and nothing else.** No head, no reply: a phone has nowhere to put
  a model's answer, and the wall spends a column on one because it is read word by word from a chair.
- **The voice column is the last exchange.** One line of what he asked, one of what came back
  (`#ph-conv`). The whole thread with its composer is the chat pane, one swipe left.
- **The two heat maps are STACKED, each a small block at the LEFT of its own section.** Above each
  is its long view (the weigh-in trend, the clocks since the last set); below it is the day itself,
  as a SCROLLING LIST — four nutrition entries, each tapping open to its ingredients, and three
  exercises with their sets. Those were one line saying only the last thing logged; the room came
  from making the maps smaller, which is what the smaller maps are for.
- **The maps take NO trim, and that is not an oversight.** They scroll, so the box decides what is on
  screen and everything either side is a drag away — and a trim could not carry the archive anyway:
  `/api/heat-history` returns the weeks OLDER than the frame's own window, so prefixing it to an
  eleven-week trim leaves weeks 12-20 missing out of the middle of the picture, silently and in the
  right colours. The cell is 12px, so the map is 90px tall whatever its width; `PHONE_HEAT_WEEKS`
  survives only as the count the weigh-in plot is built on, which has to be the number of columns the
  FOOD map shows at rest, because the plot does not scroll with the map under it.
- **The maps land on the newest week and stay there**, held by an observer rather than pinned once:
  the cards rebuild the grids on every frame and `paintScrolled` carries the position across, so one
  pin at the wrong moment is a wrong position that persists all day. It stops the moment he drags
  one, which is what `paintScrolled` is for.
- **Both maps are the same width**, and the ground beside each is the same shape: the figures fill it
  on the training side and it stays empty on the food side.
- **A DRAG ON A HEAT MAP HAS TO REACH THE BROWSER.** Scrubbing a map and scrolling one want the same
  gesture, and the cards resolve it by preventDefaulting the drag wherever the grid cannot scroll —
  a test that read `closest('.sectsheet.open')`, because the expanded sheet was the only place one
  did. The moment another surface scrolled its maps, every drag on them was still being swallowed as
  a scrub and nothing moved. `scrollableX(el, host)` in shared.js asks the DOM instead, and its walk
  STOPS AT THE HOST: the phone's panes are themselves a horizontal scroller, so an unbounded walk
  finds one from anywhere and no grid would ever scrub again.
- **THE TWO MAPS AND THE WEIGH-IN PLOT SCROLL AS ONE, AND THEIR DAYS STAY ALIGNED.** That needs both
  halves, and the first is the one that matters: **all three SPAN THE SAME WEEKS**. `/api/heat-history`
  builds both maps over the LONGER of the two archives and ships a weigh-in plot across it, so a
  given week is the same column in each. Built to their own lengths they simply stopped at different
  places — the food map's archive starts later, because intake logging began after the training log
  did — so dragging back ran it out of columns while the training map carried on, and the two ended
  up showing different months. A week before the logging started is an empty column, which is what
  the map draws for a day with nothing on it anyway.
  The mirroring is then in WEEKS, not pixels: `round((max - scrollLeft) / 13)`. Pixels would be close
  and not equal, because the plot's drawing is inset half a cell at each end and its scroll range is
  a column narrower than a map's.
  The plot is drawn across the whole span inside a scroller of its own, with its axis values a
  SIBLING of that scroller rather than a child — inside it they slide off the left end the moment it
  is dragged, and it lands at the right. It is also REPLACED outright on every render where the maps
  are repainted through `paintScrolled`, so the rebuild handler puts it back on the week the maps are
  on; left alone it returned to `now` once a minute while they stayed where he left them.
  Only the plot's two END values are labelled: in a 22px box three numbers stacked are crunched, and
  the middle one is the one a reader infers from the two either side. Its LINE stays — the line was
  what did the work.
  The mirroring flag clears a FRAME later, not on the next line: setting `scrollLeft` fires a scroll
  event of its own, so clearing it synchronously let the mirrored rails answer back and the shortest
  of them dragged everyone to its own end — the training map could never be scrolled past where the
  food map ran out.
- **The body figures fill the training section's height**, and their column's width is what that
  height implies (2 x 0.387 x it) rather than a number picked first — anything less is a band of
  black above and below them. A hair under, deliberately: each split svg holds the whole 72-unit
  artwork with a 36-unit window over it, so horizontal slack inside the box is filled by the figure
  next door and `overflow:hidden` cannot help, because the bleed is INSIDE the element.
- **Every list on the page scrolls** and is capped by a DECLARED height: the entries, the exercises,
  the sessions, the conversation. A list with no ceiling in a row that takes its height from its
  tallest child is a row as tall as the list — forty sessions made that row 1,596px and pushed
  everything under it off the screen.
- **The cell gap is 1px, not the wall's 2.5.** A cell is about eighteen pixels here where the wall's
  is twenty-five, so the same gap was a seventh of the mark instead of a tenth and the grid read as
  black ruled by colour. `--hgap` on the weigh-in plot moves with it — half of it is what the plot's
  box is inset by at each end.
- **Surf and the session list share a row**, and a session row is TAPPABLE: it opens in the session
  view the lists pane already has, with the whole conversation and a composer. So a title truncated
  in that column costs nothing — it is a way in, not the answer.
- **The day's totals lose their GOALS.** `1380/3060 cal` four times over does not fit a half-width
  column at any size worth reading, and the denominator is the half of it already on screen: the
  rings above ARE the goal, drawn as the distance still to go. The strip is the amount.

It shares the panes the walls had: [chat] [home] [misc] [maint] [lists] [repos] [reports], landing on
home, driven by `phone-home.js` rather than `wall.js` — there is no canvas to scale, so only the
paging is left.

### Three wall-sized numbers a surface can now override

Each of these lived as a constant inside a card because there was only ever one surface drawing it at
one size. A phone at arm's length wants all three smaller, and each is now a default the surface can
replace — everything else gets exactly what it had.

| what | where it is said | why |
|---|---|---|
| `--surf-grid-h` / `--surf-water-h` on `#surf` | `cards/surf.js` | its own 86px a grid plus 68px of water is a third of a phone screen for one card |
| `--surf-back` on `#surf` | `cards/surf.js` (`layout`) | the server lands the card twelve days back, which fills a wall; in a card a fifth of that area it put a day under ten pixels and showed MORE of the archive than the wall does. Seven back and everything forward. Older is still one drag away |
| `--surf-bare` on `#surf` | `cards/surf.js` (`onWall`) | the weekday letters and the hour labels. A wall drops them because nothing that small is read across a room; this drops them because the picture already answers them |
| `--wx-h0` / `--wx-h1` / `--wx-guide` on `#weather` | `cards/weather.js` | `pop` carries all 24 hours and `window` is only what the server took its peak over, so a surface can draw a narrower band. 6am to midnight here, with ONE guide at 3pm: in a 44px block the server's three graded lines are two pixels apart and say less than one does |
| `.addbtn` / `.dact-btn` / `.dex-head`'s column | app.css, under `body.tv.phonewall` | all three are written for a canvas scaled to about a third — a 110px-wide button and a name stacked over its macros. At native size they are slabs and two rows per entry, so the phone's home page flattens them |
| `--rc-base` / `--rc-min` / `--rc-name-base` on `.hw-recent` | `cards/workouts.js` (`fitRow`) | the set list starts at 16px and the exercise name at 17px, and both only shrink if they overflow — so on a phone they were drawn half again the size of everything around them and stayed there |

Two more things on that card are not knobs but are worth knowing. The left GUTTER holds the hour
labels and the water temperatures; with the hours gone it is dead width, so the phone positions the
water's gutter canvas over the right-hand end of the plot instead (where the trace has run out) and
hides the grids' entirely — which is also what gives the plots the width it was holding. And the
water trace's scale now hugs its data rather than rounding out to whole degrees and padding one
either side, which had turned a three-degree swing into a flat line across the middle of the box.

## The split body figures carry the WHOLE artwork, and only a viewBox hides half of it

`cards/muscle.js` splits the one 72x93 figure into a front and a back by emitting the same `<g>`
twice with `viewBox="0 0 36 93"` and `viewBox="36 0 36 93"`. Nothing is removed — each half is the
entire drawing with a window over it — so the window only holds while the svg's BOX is that 36:93
ratio, and any box wider than it paints the other figure beside the one it is supposed to show.

Give the svg `width:auto` and Chrome resolves it from the viewBox's ratio while **Safari resolves it
to the container's width**, so `meet` centres a 36-wide window inside a box twice that and the rest
of the artwork spills out: FOUR figures on his phone, two in every test here. `.figstack svg` now
carries `overflow:hidden` in app.css, which cannot change a surface that was already right, and the
phone's own boxes are pinned with `aspect-ratio:36/93` rather than trusting `auto`.

The knock-on was worse than the drawing: the body card was sized by its content, so the bad figures
took the whole row and the sessions list beside them ended up with no width at all. A block whose
width comes from something that can go wrong takes its neighbours with it when it does — the card is
a declared width now.

## The day strip: the scale is what makes the lanes mean anything

Each chip goes in the first lane FREE AT ITS OWN X, so a title takes the width it needs and the next
one drops a lane. When every lane is busy, the chip already sitting in the lane that frees soonest is
CUT SHORT rather than overlapped — a title losing its tail is still readable, two titles on top of
each other are not.

**`hourW` is the number to be careful with, and it is 26px.** At eleven a chip with a title on it was
five to ten HOURS wide, so every item blocked its lane for the rest of the day and four things an
hour or two apart came out as a diagonal staircase: four lanes, one chip each, the x of every one of
them saying nothing the little `4p` written on it was not already saying. At twenty-six a chip is
about three hours, which is a duration — so two things at the same end of an afternoon share a lane
and only a real collision drops one. The visible window is about fourteen hours, most of a waking day.

**Its height comes from the DAY, not from the space available.** Three lanes always, which is the
room a collision needs; a fourth only when the day wants one; nothing beyond. It measured its own
container once, which is sized by its content — so a first paint read a box that had not been
squeezed yet, claimed six lanes of it and kept them.

## What is running is one module

`cards/sessions.js`, on both the home wall and the phone's home page. `mountSessions` takes the
elements a surface has: a list always, and a `head` + `reply` only where there is room for an answer.
Everything else — the numbering, the ordering, the highlight, the activity line under each row — is
shared, and it has to be: `n` is the number he says out loud, so two copies of that ordering is two
surfaces that can disagree about which session is "the second one".

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
