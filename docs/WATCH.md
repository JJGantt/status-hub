# The watch app

`StatusHubWatch`: a watchOS 11+ app (`apps/Watch/`, bundle `com.jaredgantt.statushub.watch`) embedded
by the iOS app, plus its widget extension `StatusHubWatchWidgets` (`apps/WatchWidgets/`,
`com.jaredgantt.statushub.watch.widgets`) — the watch-face complications (four that record, two that open a page) and, on watchOS 26, the controls.
It is native SwiftUI, not a web view: watchOS has no WKWebView. It talks to the hub directly with a
token the phone hands over.

## Shipping it

**It ships inside the iOS app**, so it reaches the watch with a TestFlight build of the app —
`apps/tools/testflight.sh`, built and uploaded from this Mac in a few minutes — installed when the
phone updates. The GitHub workflow is the fallback for when the Mac is away (`CLAUDE.md`). Do not install a local build
of the iOS app to try the watch: that build cannot receive push (`CLAUDE.md`). How to prove the Swift
compiles on this Mac, with or without a simulator runtime, is in `CLAUDE.md` § Checking the Swift
compiles.

The sessions list ends with the build number (`CFBundleVersion`, which CI sets to the TestFlight
build), so a fix that has not been installed is not mistaken for one that failed.

## Pages

Six, swiped left to right: **sessions · home · day · health · live · gesture**. The app opens on home,
which IS the conversation — there is no separate prompt page. New layouts are added as NEW pages beside the old
ones rather than by reshaping a page in place, and the ones that lose are deleted; `day` and `health`
are two layouts of the same food-and-training data, and one of them is expected to go.
`RootView` in `StatusHubWatchApp.swift` holds them in a paged `TabView`, with the page dots off (`indexDisplayMode: .never`) — a strip of screen spent saying what a swipe
already says.

A page holds its event stream open only while it is showing (`follow()`), reloading after every
reconnect, since a change may have gone by. **Every page is loaded each time the app comes to the
front, the one on screen first**: the others wait for its fetch (the day page's two, or the sessions
list and the open conversation) and then load side by side — the sessions list, the hub thread, the
rings and today's log, the training day, 30 weeks of history — so a swipe lands on data already
there, which its stream then catches up. The page put first is read a beat after the app opens,
because a complication or a notification turns to its page in the same pass. The drill-ins (every
week of history, the weight page) still load when opened. The sessions list is fetched with
`?brief=1`, every row as its one-line `say`: the watch never draws a whole reply from the list, and
those replies were nearly half the response. `Hub.listen` reads all
three streams; every frame the hub sends has a `data:` line, keepalives included, and that is what it
dispatches on.

Every page stays alive side by side in the TabView, so anything that binds double tap or acts on a
request asks `onScreen` (an environment value `RootView` sets per page) first.

`live` is the live mic: one control that plays what the phone's microphone hears
(`LiveListen.swift`, [LIVE-MIC.md](LIVE-MIC.md)). It holds no stream until it is pressed.

`gesture` is the gesture recorder (`GestureLab.swift`), a test bench rather than a feature: the
button records a fixed eight-second window of 100 Hz device motion (attitude, rotation rate, user
acceleration, gravity), and the word under it is the label, which a tap moves through
`flick · lower · raise · other`. The window ends by itself because the gestures worth recording take the
app off the screen. Each capture also carries the app's state changes (`active`, `resign`, `background`,
`foreground`, `dim`, `undim`) on the same clock as the samples, which is how a wrist flick can be compared with a
lowered wrist: there is no API for the flick, so what it does to the app is the only signal there is.
It holds the microphone through the window and the upload, the way `StayAwake` does, because otherwise
the motion stream stops seconds after the wrist drops. No workout session: 100 Hz is CMMotionManager's
own rate, and only the 800 Hz batched sensors need a workout. Captures land in the `gesture-captures` bucket
through `POST /api/gestures`; `GET /api/gestures` lists the last week and `GET /api/gestures/<day>/<file>` returns one.

### Home — the conversation

`HomeView`: the last five exchanges of the shared hub thread, each in full — his words as the hub
transcribed them, the reply as it was written — over `/api/voice-messages?focus=hub&mode=active`,
the same current-context thread the phone and the TV show, in whichever mode `agent_mode` selects. It
follows `/api/voice-stream`: a `message` frame reloads the thread, and the worker's `activity` frames
draw the running command's tool calls under it (`ActivityLines`), which the hub does not store, so they
show only while the page is watching. They clear on `done`, on the command's own answer, on a
reconnect and when the page goes inactive — never on `done` alone, because the page goes inactive
seconds after a command is sent and the `done` frame then goes by while the stream is closed, which
leaves the tool calls drawn under a reply that came after them.

**A command walks the page**, and each step lands the view on a TOP, because a reply is read from its
first line rather than scrolled to the end — but only once he is not looking (next paragraph but one);
with the wrist up the view stays where it is:

| | screen | control | x | wrist |
|---|---|---|---|---|
| the command goes (silence, or a press) | — | the spinner | appears | tapped |
| the hub has transcribed it | his words appended in full, the view on their top | the spinner, larger and brighter: the worker is running it now, not hearing it | stays | — |
| the reply lands | the reply appended in full, the view on ITS top | back to the microphone | goes | tapped, with the sound |

**Nothing is padded under the thread.** A landing puts the top of the newest thing at the top of the
screen only when there is enough below it to fill the screen; a short one stops where the content ends,
with what came before it above, as any list does. Blank space added so everything could reach the top
is exactly what he does not want. The view holds that spot through the laying out that follows
(`pinned`) until he scrolls himself. The session page lands the same way.

**Nothing moves the view while he is looking.** While home is in front with the wrist up, every new
item — his own transcribed words, a tool call, the reply, a session's relayed answer — is HELD; it lands
the moment he stops looking (wrist down, app behind, another page), so it is waiting at the next raise,
with the unread dot meanwhile if it is flagged. Holding only while the view was on an answer is not
enough: he reads an earlier answer while a command runs, and his transcript and then its reply each
pulled the view off it. A tap on the unread dot or an answer's notification is asked for and never waits.
`landed` is the spot the view is held at, and the room above the newest item follows IT, not `target`
— keyed on the target, the room vanished from above the answer being read and shifted it. Each hold is
logged as `land-held`.

**The landing spot is fixed, per page** (`Landing` in `WatchUI.swift`): 32pt from the top of the glass
on home, where a full-width first line clears the corner curve and the thickest default edge; 58pt in
a session, under its title and clear of the fade the title draws over what scrolls beneath it. It does
not move with the edge: text that shifted whenever a command lit the border would jump on every
command. **Items sit an ordinary 12pt apart (`Landing.itemGap`); only the newest has room above it**,
enough that when it lands the item before it ends just above the top of the screen. That room is a
spacer of its own (`room`), never padding on the item: SwiftUI measures a scroll target INCLUDING
padding, so padding put the item's text a whole landing too low. For the same reason a row's scroll
id is never the id its `ForEach` already uses (home scrolls to `msg<id>`): `scrollTo` lands the first
view carrying an id, and the ForEach's identity covers the room and the row together, so the room's top
lands on the line and the item before it shows above the blank. And the room appears only when the newest
item is tall enough to reach the landing line: a short last item rests at the end of the scroll with the
thread above it on screen anyway, where the room is a blank band. Every row's height is measured, not
just the newest's: the newest changes in the same update that lands it, so a height taken only once a row
is newest arrives after the landing, or never when the row's height does not change. The tool calls of a running
turn land as one block (`activity`), not line by line. Within that block a session's echo of his words (`said`, or `queued` behind a running turn) is drawn as
his words, in full; only tool calls are cut to two lines. Words the watch sent are already on screen, so
their echo is dropped, and `summary` frames are ignored because the detail fetch brings the reply.

**A tap ANYWHERE on home or in a session is the same press as double tap** (`CommandBorder.press`),
bound on the scroll view rather than its content so the glass under a short thread presses too. That is
his call, made knowing a finger resting on the text can start a recording: scrolling, the crown and
swiping to another page are drags, not taps, and still only move. A session's name and its speaker
glyphs are buttons, which take their own taps. The page carries nothing else: no
second indicator of a state the control already holds, and a failure is the one thing it adds — an
icon and Retry under the thread, since a command that failed has nowhere else to be picked up.

**The system's clock is hidden**, by `._statusBarHidden(true)` on the root view in
`StatusHubWatchApp.swift` — an underscored SwiftUI modifier, and the only thing that hides it. Measured
on watchOS 26.5, each alone:

| | |
|---|---|
| `._statusBarHidden(true)` | **hides it** |
| `persistentSystemOverlays(.hidden)` | does nothing |
| `statusBarHidden(_:)` | does not compile — unavailable on watchOS |
| an invisible `VideoPlayer` | does nothing, in four variants: as a background, as a full-size overlay at 0.001 opacity, with a real looping clip playing, and visible at full opacity behind the content |
| a `ToolbarItem` | only moves the time to the left of the strip |

Underscored means unsupported, so a watchOS release can take it away — which would show as the clock
simply coming back, not as a build failure. Nothing here ships to the App Store, so private API is a
risk to the look rather than to the app. The page draws no clock of its own either: it is for the
conversation, and the watch face is one press of the crown away.

### Unread answers

Most replies only confirm that something was done and are never read. A reply that tells him
something he asked to know is the one that gets buried when he speaks the next command before
looking, so those are kept reachable until they have actually been on screen.

- **The model flags them.** It ends such a reply with a marker, which the worker strips and stores
  as `voice_messages.needs_read` (voice-pipeline `docs/ROUTING.md`). Confirmations carry no flag and
  never enter the queue; a flag the model forgets falls back to the ordinary thread.
- **Read means shown**: two seconds on screen with the app in front, home showing and the wrist up
  (`HomeView.attend`). On screen is half the row, or for a row taller than the screen, enough of it to
  fill a little under half the screen, so a long answer counts once its opening was in front of him.
  The watch posts `/api/voice-messages/read`, which stamps `read_at` once; the row's UPDATE reaches
  every surface through the voice stream.
- **An amber dot at the top of home while any is unread**, in the sessions list's unread amber. A tap
  on it lands on the OLDEST unread answer; once that is read the next tap goes to the next. It is a
  button of its own, so the tap does not also record. Home stays landed there (`Chat.landOn`) until
  the next command's words appear.
- **Each one is pushed as it lands** (`notifyAnswer` in the hub, category `VOICE_ANSWER`, titled with
  his words, the answer as the body); no other orchestrator reply is. The watch drops it unshown whenever
  home is the page showing and the app is not in the background, wrist up or down (`Chat.homeOpen`):
  the answer is in front of him or is what the next raise shows. It is not gated on `looking`, because
  the scene drops to `inactive` in the same second an answer lands while he is still reading it. On any
  other page it is shown, and once the watch is back on the clock the app is in the background and the
  system shows it. Any interaction with it is reading it: swiped away, on the watch or the phone, it is marked
  read at once (`customDismissAction` is what reports the swipe); tapped on the watch, home lands on
  the answer and the read rule marks it, since marking it first would drop an old answer out of the
  thread before home could land on it; tapped on the phone, it is marked read. Only seeing it, with no
  touch, does not count: nothing reports that.
- **None is lost to age.** `/api/voice-messages` returns every unread answer however old, with the
  words that asked for it, ahead of the current context; the watch draws them above the last ten
  exchanges (`Chat.held`) and keeps them there, read or not, until home leaves the screen, so an
  answer never vanishes from under him the moment it counts as read. The wall and the phone get the
  same rows from that endpoint.

### Replies are markdown

Every reply and thought on the watch, home's thread and a session's alike, is drawn by `Markdown`
(`Markdown.swift`): headings at their own sizes, nested lists, fenced code, quotes, rules and tables,
with `inlineMarkdown` doing the inside of each block (bold, italics, code, links, bare http(s) URLs).
`Text` alone renders only the inline part and runs every block into one paragraph, which is why the
blocks are split out first. A table wider than the screen scrolls sideways (`ViewThatFits`) instead of
wrapping each cell to a word a line. A tapped link opens in the watch's own web view.

### The sessions page

Lists `/api/sessions` one row per conversation, sorted by `n` — most recently active first, running and
parked interleaved — and follows `/api/session-stream`. Each row is its name
over up to three lines of what it last said: the list's `say`, which the hub already cuts to 120
characters, drawn smaller and grey with its markdown's bold and code dropped. Opening a session marks it read on the hub
whatever the watch's own copy of the row says, then reloads the list: the hub announces the change on
the walls' stream, not this one, so without the reload the amber stayed until something else did. A
reply landing on the session he is looking at is marked read as it lands.

**Who said what is a colour** (`Ink`): his words soft blue, tool calls soft violet, the model's
in-between text grey, its final reply white; relayed session replies keep their mint on home, and amber
is left for recording and unread.

**A row carries the same three marks as the phone's list** (`cards/sessions.js`, `phone-home.css`),
because they answer different questions and are read together: a **white** left edge is the focused
session — where a spoken follow-up goes — with a pin beside its name when he pinned it there; an
**amber** left edge is a finished reply nobody has opened; a green **dot** is a session working
now. Under each name is what that machine is doing, live off `/api/session-stream` — a tool call in
teal, what the model says between them in a plain light — and the line is always there, however empty,
because a row that grows when a tool fires and shrinks when one stops makes the whole list jump every
few seconds. Opening a session marks it seen (`POST /api/sessions/seen`), so the mark clears on the
phone and the wall too.

The list is a **ScrollView, not a List**: a watchOS List puts every row in a grey rounded slab, and
this page is a list of names — rules separate them, as they do on the food log and the exercises.

**A tapped row opens its session INSIDE the sessions page** (a `NavigationStack` of the page's own, in
`SessionsView`), so the row of pages still swipes with a session open — to home, to the day page — and
the session is still open when he swipes back. The page row takes the sideways swipe, so the system's
swipe back never fires; the session's name is one way out (below), and swiping right is the other.
A swipe right is a `DragGesture` on `SessionView` itself, simultaneous with the scroll and the page
row: mostly sideways and more than 40pt to the right pops `Sessions.path`. It is free to mean back
because sessions is the leftmost page, so the page row has nothing to turn to in that direction. The session has no title bar.

**An open session is therefore not the same as one on screen**, and where a command goes is
`Sessions.target`: the session a recording belongs to while it runs (so the press that ends it ends it,
whichever page he has swiped to), otherwise the open session only while the sessions page is showing.
A session left open behind home does not take home's commands. A session's tap in the BOTTOM HALF of the
glass is the press; its top half is for reading.

**A session is ONE LIST, the hub's** (`Sessions.logs`, from `GET /api/sessions/:id` and the `ev`
frames of `/api/session-stream`; server.js, the event log): his words (`prompt`), tool calls, what the
session says between them (`text`) and its replies, each with its position in the conversation (`seq`,
given by the hub) and an identity (`id`). The page draws that list and nothing else, oldest first. The
phone draws the same list by the same rule (`cards/repos.js`), which is what makes the two agree.

**Only the tail is laid out.** The session page draws the last three turns of that list (counted back
by his prompts) and home the last ten rows of the thread (`Chat.window`); scrolled to the very top,
each lays out one step more, and the row that was at the top is put back at the top once it has.
Laying out everything held (up to ten turns with every tool call in them on a session, forty rows on
home) is what made swiping between the two pages lag. The top is noticed by a 1pt marker's visibility,
like the end (§ Double tap, and scrolling), and only once he has scrolled himself, so the page laying
out never asks for more. Each falls back to one step when it lands on the newest again or leaves the
screen (a session only while it is following the newest, so a place he scrolled to is kept).

**The whole rule** (`Sessions.frame`): the next seq is appended; a gap means the hub has what went by
while this was not listening, and it is fetched from the last seq held (`/api/sessions/:id/events
?since=`); an old seq is a duplicate delivery and is ignored. A fetch and a frame that arrived while
it was in flight are merged by seq (`take`), so they cannot disagree whichever lands first. A frame
whose epoch is not the one held is a hub that restarted and numbered from one again: the list is
fetched afresh. There is no separate record of the turn in flight, nothing is cleared when a reply
lands, and nothing is matched by its text.

**A prompt queued behind a running turn is one event at two moments**, same id: when Claude Code
takes it (`seen` false, drawn dimmed) and when the model reads it (`seen` true). The page draws a
prompt at its LATEST occurrence, so it moves from where it was sent to where it was read (`shown`).

**His words show the instant they are transcribed**, before the hub has them: a placeholder
(`Sessions.placeholders`) carrying the message's own id, dimmed, after everything the session has done.
The follow-up carries that id to the hub (`client_msg_id`), the hub to the host (`msg`), and the host
stamps it on the prompt those words become (sessionWatch.js `expectPrompt`) — the one place a text is
compared, once, against the exact string that machine just typed. The event that comes back carries
it as `cmd`, and the placeholder is replaced by id. **Every path that delivers words registers them**,
the resume of a PARKED session as much as a follow-up typed into a running one (pi-desk `startSession`,
the Mac's `resume_session`), and the claim is made even when the watcher reads that prompt as the prefix
of a turn it attached to late, which is how a resumed session's first prompt is always read. A path that
skips either leaves its placeholder drawn under the whole turn, below the same words already in place. A send the hub refused, or took nothing from (a
thank-you-shaped transcription), drops its placeholder.

**It lands on his newest words**: a placeholder if any, else the last prompt since the last reply,
with what the session does about them underneath; with none, the last event — the reply when it lands
(`newest`). The top of that sits at the top of the screen.

**Nothing moves the page while he is looking**, by home's rule: with the wrist up, a newer item — his
placeholder, a tool call, the reply, a prompt typed from elsewhere — is held in `spot` and lands when he
stops looking.

**His scrolling ends the following**, finger or crown, and nothing moves the page after that until the
session is opened again or HE scrolls it to the very end (letting go with the end on screen after a
scroll of his; the page merely sitting at the end does not count). A drag reports a scroll phase; the
crown is not trusted to, so any move of the offset that is neither one of the page's own jumps nor a
change in content height counts as his scroll too, once the page has landed: before its first landing
the scroll view moves itself (it shifts by the space under the title as it opens). The page's jumps are never animated, which makes each
one exactly one move to discount. Every change of following is logged to the hub as `follow`, with
`why` (`drag`, `move`, `end`), so a fight on the wrist can be read back afterwards. The end is a one-point marker at the bottom of `PagedScroll`, asked whether
it is VISIBLE (`onScrollVisibilityChange`), not a sum over the scroll view's reported offsets, which
this app does not trust (§ Double tap, and scrolling).

**What the screen actually holds is logged as `session-shown`**, whenever the reason it might be wrong
changes: the anchor moving, an event or a placeholder arriving, or the page opening — the computed
anchor, `following`, whether it has landed, the count and last seq held, and the tail of the list —
so a report of something wrong on the wrist is reproducible from the log rather than guessed at.

**Commands overlap.** A command can be recorded and sent while earlier ones are still being
transcribed, handed over or worked on, on home and in a session alike: each is its own item (`Chat`'s
`commands`, `Sessions`' `outgoing`), sent and retried by itself. Each shows as its own placeholder the
moment it is transcribed, and each is replaced by its own event.

**The edge sweeps until every follow-up sent from here is answered**: `awaiting` holds their message
ids, and the wait ends when a reply lands AFTER every one of them has been read — a prompt event
carrying that id, `seen`, with a seq below the reply's (`settle`). A reply to an earlier command, or
one that came before the words went in, is not the answer he is waiting on. **An id the list does not
hold two minutes after it was sent is let go**: the hub keeps a conversation's last ten turns
(`SESSION_TURNS`), so after a hub restart a follow-up from further back is not in the list, and waiting
for it swept the edge over an idle session until the app was killed. A follow-up being worked on shows
in the list within seconds of being typed, so the limit never cuts a real wait short.

**Its name is on the clock's line, and the name is how it closes.** A leading `ToolbarItem` holds it
(a trailing one moves the clock to the other end of the strip), and tapping it pops the session. The
swipe back watchOS gives a pushed view does not survive a page row that also takes sideways swipes, so
the way out is the thing at the top that says which session this is — or a swipe right (above).
The swipe's drag is SIMULTANEOUS, never high-priority (the `SideScroll` trick): a high-priority drag
claims every drag, the vertical scroll and the leftward page swipe included. The pop is guarded
against an empty path (two taps close enough together that the first has not dismissed the button
yet would otherwise call `removeLast()` on an already-empty array and crash).

**A recording running in a session is marked in the list**: a red square in its row, beside the green
working dot, so a recording started in one and left there can be found from anywhere in the app.

Everything it keeps is keyed by `claude_session_id`, not by row: a resume makes a new row for the
same conversation, and keyed by row the page would lose a session the moment it resumed; an `ev`
frame names its conversation, so nothing has to look a row up. A session opens to the hub's whole
list (the last ten finished turns, seeded from `desk_turns`, and the turn in flight). The page fetches
the on-screen conversation's list again whenever it becomes active or the stream reconnects, and a
conversation nobody has opened is never fetched: its frames only keep the newest event, for its row in
the list (`latest`).

**The list follows the hub's `sessions` frames** on `/api/session-stream`, the same payload as
`/api/sessions`, pushed whenever a session starts, ends or queues; a session started while the page is
open appears without leaving it. Sessions still waiting for a machine (`queued`, from `desk_queue`)
sit on top, marked Queued and not openable, since nothing is running yet.

A tap or double tap records a follow-up: the hub transcribes it without enqueueing anything
(`/api/voice-command?dry=1`), and `POST /api/sessions/followup` types the words in, or resumes a
parked session with them (`HUB-INTERNALS.md` §6b). **A follow-up is always locked**: red edge, no silence ends it, and the
next press sends it (`Capture.Flow.locked`, from `Sessions.startRecording`). A session gets talked to
in long, paused thoughts, and a pause there must not send half of one.

**A session's reply notification opens it.** `WatchAppDelegate` registers the `SESSION_REPLY`
category with one foreground action, Open — the button double tap presses on a watch notification —
and answers it, or a tap on the notification itself, with `Sessions.open(rowId:)`: the app lands on
the sessions page with that conversation pushed (`Sessions.path`), a row the list has not loaded yet
(a resumed session's new one) included, and it fetches that conversation's reply itself. Left to the
view's own load the reply stays old: a conversation already on screen does not appear again, and an
app in the background misses the stream's `done`. The category is registered at launch, so the watch
app has to have run once for the button to appear.

### The pages start at the top of the screen

With the clock hidden there is no reason for the band it sat in. `topOfTheScreen()` takes it back, and
it takes BOTH halves: `ignoresSafeArea(edges: .top)` for the page, and `contentMargins(.top, …)` for
the scroll view, which insets its own content by that same safe area — with only the first, the page
reaches the top and its first line still starts below the strip.

### The command is on every page

There is no control on screen. **Double tap runs a command, press and hold (home only) starts a locked
one or throws a recording away, and a line around the very edge of the glass says what is happening** (`CommandBorder`, one overlay on
`RootView`'s whole navigation stack, so it is the same on every page and inside a session, where a
command goes to the session instead of the hub):

| state | edge |
|---|---|
| recording, and the silence will end it | amber |
| locked open through the silence (every session follow-up, and the `Hub Locked` complication) | red |
| the hub working on it (transcript or command) | white, a bright stretch travelling round a dim ring; with the wrist down, the whole line white |
| always-on listening | blue, dim |
| idle | none |

**The line follows Apple's own outline of the glass**, not a rounded rectangle: `GlassEdge` draws each
corner as the three cubic curves of the device's framebuffer mask (the 46mm simulator's
`framebufferMask` PDF), in units of the display's 50pt corner radius. It is a continuous corner — at
the top edge the glass begins 1.31 radii from the side, where a circle would begin at 1.0 — so a thin
line drawn on a circle leaves the bezel at every corner. **The line is a FILL of everything from its
inner edge outward** (`BeyondEdge`, even-odd against a rect past the screen), never a stroke along the
outline: the real glass is not exactly that curve, and where a corner meets the top and bottom edges a
stroke leaves a sliver of glass outside it in which text shows beyond the line. The working sweep is a
stroke centred on the outline at twice the line's width for the same reason.
**Every part of it is a hub setting** (Settings → Watch edge), so it is tuned without a build
(`BorderStyle` in `WatchSettings.swift`): the line's thickness (`watch_border_px`, 3), an opaque black
band just inside it (`watch_border_band_px`, 2; 0 for none), and each state's colour
(`watch_border_recording`, `_locked`, `_working`, `_ring`, `_listening`). Thicknesses are in PIXELS.
**Every colour is solid, never translucent**: a see-through line lets text scrolling up to the edge
show through it. With the wrist down the edge keeps its colours and only the system's own dimming of
the screen applies; the app adds none. The band is what stops text
reaching the line at all — it disappears just inside it. A colour that is not `#rrggbb`, or a thickness
that is not a number, falls back to the default rather than drawing something else.

**One read serves all the watch's hub settings** (`WatchSettings.refresh`: the edge), on launch and whenever the app comes to the front; the last values are kept between launches.
Pages leave only `PageInset.bottom` (12pt) under their content, for the curve.

### The nutrition page

Replaced by the day and health pages below. The pieces it was built from are shared by both:
`RingCell` is `cards/nutrition.js`'s ring redrawn in a Canvas to the same geometry and colours, fed by
`/api/rings`'s per-minute frames blended each second so the arcs, ticks and deviation move linearly
between minutes without a copy of `lib/pace.js` in Swift; `DayLog` is today's log, one entry to two
lines (name, then `466 cal 23P 88C 4F 12:30P`) that tap open to their ingredients, staged entries on
top with the gold edge.

### The workout page

Now `ExerciseList`, the training detail the day page opens (and the Workout control). **The clocks
strip is pinned above the list**, not its first row, since it is the live number read while training;
its times are 22pt and the count 22pt behind a 12pt "sets", which is what keeps `9:59` and `1:41` full
size beside it. Under the strip: the rest clocks on one
line, then one row per exercise — its name and how many sets — tapping open to the muscles it trains
(weekly sets in each muscle's colour) beside its sets. **Nothing in it may report a width wider than it
was offered**: the ScrollView lays its content out again at the width the content reports, so one
overflowing row widens every row past the glass. The set count on the clocks line never truncates;
past an hour the clocks shrink to make room, and at three digits of sets with a session over an hour
the session clock still clips.

**The rest clocks are `RestClock`**, shared by this list and the day page so they cannot disagree: the
time since the last set is **m:ss inside the hour and whole hours after it** (`3h`, `12h`, `72h`) —
past an hour the minutes are noise, and the short form is what fits beside the figures' feet; the
session clock is m:ss, then h:mm:ss, and only while a set landed within 20 minutes.

### The day page

`DayView`: **food on the left, training on the right**, on one screen. It was drawn as a mockup at this
screen's own pixels and signed off element by element; `Geo` holds its numbers, the mockup's halved.
The conversation is not on it: that is home's alone.

- **Two equal columns with a gutter line between them from the top to the bottom of the glass.**
  Nothing crosses it: the training clocks live on the training side.
- **Left:** the four rings packed 2x2, 4pt apart. **Right:** the body figures at the same height.
- **The training numbers stand beside the figures' feet** — `last` over the rest time at the left,
  the session clock centred between the figures, `sets` over the count at the right — at 10pt bold,
  a point under the lists' numbers, bright (a trailing `h` or `m` stays 7pt, and so does everything
  from a colon on in either clock: a big `9` then `:59` for the rest, a big `1` then `:41` for the session), the INK of every value ending on the feet's last
  row (`Geo.footDrop`). **The rest is never more than three digits** (`RestClock.restText`: `m:ss` under ten
  minutes, `10m`–`59m`, then `3h`), and **the session clock is `h:mm`**, no seconds. Rendered at 10pt
  against the artwork (`DAY_CLOCKS=<rest s>,<session s>` in the simulator), `11h`, `19m` and `9:59` (small
  seconds) sit clear of the feet, and a centred `0:41` or `1:41` fits between the feet.
- **Under each column, a list to the bottom of the glass, scrolling:** every meal in today's log, staged
  ones on top with the full log's gold edge (planned is not eaten), and every exercise today, most recent first. A tap opens
  its full view. The page ignores its bottom safe area so the lists reach the glass.
- **The rings and the figures are switches.** A tap on the rings trades the lists for the day's totals,
  one macro to a line (eaten bold, `/ goal` dim), full width; a second tap brings the lists back. A tap
  on the figures opens the week's muscles as a page of their own: every muscle's `sets / goal`, in the
  colour it has on the figures, furthest behind first — the phone's Priority order, sent sorted by the
  hub in `/api/workout-now` (`volume`). Its `‹ Muscles` heading is the way back.

An open session's name has a small back chevron before it; the two are one button that closes it.

The full views keep their heading and the heading is the way back: the food log sits under the four
rings in a row, and a tap on the rings returns; the exercise list sits under its clocks, and a tap on
the clocks returns.

**The figures are the web's artwork, drawn natively.** `BodyPaths.swift` is GENERATED from
`server/lib/bodymap.js` by `apps/tools/gen-body.mjs` — rerun it when the artwork changes — and
`BodyFigure` parses those paths and draws one half of the 72x93 drawing through a CLIPPED 36-wide
window; without the clip the other half paints beside it. Each region's colour comes from
`/api/workout-now`'s `body`, which the hub builds with `lib/musclemap.js` — the same region→muscle
mapping the browser's muscle card imports, so a region is one colour on the wrist and the wall.

### The health page

`HealthView`: the weeks, not the day. The weigh-in plot over the two heat maps (food, then training),
each across the full width at 10pt cells, so a map holds as many weeks as the width allows (18 on the
46mm) with the newest at the right. No rings and no lists: the day's are on the day page. It starts at
`Landing.top`, below the corner curve, since it now runs to both edges. It loads its weeks when it
appears (`loadHistory`) and follows no live stream.

**Both are dragged sideways with `SideScroll`, not a horizontal ScrollView.** The app's pages are
themselves swiped left and right, and that swipe beats a ScrollView inside a page, so a map in one
could not be moved at all. `SideScroll` offsets its content by hand under a high-priority drag, claimed
before the page swipe, that begins only after 6pt of travel so a tap still picks a cell; it rests on
the newest end and clamps to the content. Not yet tried on the wrist: if the page swipe still wins
there, the fallback is arrows.

**Each part opens the whole of its history, with a back arrow** (`BackArrow`; a page in the row cannot
be swiped back from, and a tap on a map picks a day):
- **A heat map opens `HistoryView`**: that map's every week back to the first meal or set logged
  (`/api/nut-history?all=1`, each cell carrying its date `d`), resting on the newest week, at the
  health page's own 10pt cell. The day picked (today to begin with) is outlined and named beside the
  back arrow, one short row above the map, and under the map is that day's list: its meals (`/api/nutrition-day?date=`, `DayLog`, each opening to
  its ingredients) or its exercises (`/api/workout-day?date=`, `LiftRow`, each opening to its sets; a past
  day's rows carry no muscle chips, since those are this week's volume).
- **The plot opens `WeightChart`**, the phone's weight view (`cards/maintviz.js`) from `/api/weight-view`:
  every day at 4pt, resting on today; weigh-ins as purple dots (faint outside the
  window the target is fitted over) with the fitted trend across the window, and each day's intake as a
  blue bar (faint outside the window) under the maintenance (amber) and target (green) steps. The y
  values sit in a gutter at the right edge and do not scroll.

## Recording a command

### One microphone

`Watch/Capture.swift` owns the recorder for every page. `owner` (`hub`, `session(key)`, `listener`)
says whose recording it is, so a page cannot start one over another's, and only the owner draws or
sends it. The owner is set the instant a recording is asked for, so a second press while the
microphone opens is always a stop, which cancels rather than sends.

### The recorder

`Watch/Recorder.swift` records AAC, mono, 16 kHz, through an **AVAudioEngine tap**, not
AVAudioRecorder. The tap hands over each buffer with its level (`onLevel`), which is what the silence
endpoint runs on; AVAudioRecorder's meters answer only when asked, on a timer. The tap can also swap
the file for a fresh one inside the same callback (`cut`), which is how the listener loses no audio
between utterances. `Sink` owns the file under a lock, because the tap writes on the audio thread and
everything else runs on the main actor; a buffer still in flight after the tap is removed finds no
file and is dropped. Levels reach the main actor through the main queue, not a Task, so they arrive in
order.

### It ends itself at the silence

A command, on home or in a session, ends itself once he has spoken and then stopped: both pass
`onSilence`.

`Endpointer` (in `Capture.swift`) is the phone's always-on rule (`makeListener` in `voiceagent.js`):
the floor is the quietest buffer so far (exact zeros, the microphone still opening, are not the
room), and once speech has been heard, `watch_silence_s` below the speech line ends it exactly as a press
would. **The speech line has three modes, a switch in Settings (Watch: speech line):** `fixed`, the default,
is 2.5x the floor and at least `watch_speech_min` (0.02 when unset); `room` drops the fixed number and is
`watch_speech_ratio` (8 when unset) times the floor, so it follows the room. `voice` drops the level line
altogether: Apple's built-in sound classifier (`VoiceDetector` in `Recorder.swift`, SoundAnalysis
`.version1`, on the device) scores every half second, a new window each quarter second, and only a window
scored `speech` at least `watch_voice_min` (0.5 unset) counts. Any level line is crossed by a snap, a
tap, a door or a running tap, and each of those restarts the trailing silence; the classifier calls
them what they are. Measured on 25 of his kept watch commands (run on the Mac, which has the same model):
kitchen noise in the long weigh-the-ingredients commands — zippers, door slams, glass clinks, the tap
running for seconds — scored under 0.3, his ordinary commands never went more than about 2s without a
window over 0.5, and his quiet speech that sat under the 0.02 line still scored as speech. On all 158 kept watch commands
(2026-10-15, classifier pauses bounded by whisper's word span, so trailing chatter and music are not counted),
the longest pause inside his own words was 0.25s at the median, 1.5s at p90 and 3.25s at p95. Even
five-minute rambles never paused over 3s. The longer pauses, 6-13s, were all read-the-scale dictations
(cereal, eggs) where he stops on purpose while pouring. Under Voice those pauses end the recording at any
trailing silence below them, because the clinks no longer hold it open. At 0.3 the
trailing silence itself scores as speech often enough to keep a recording open, which is why the
default is 0.5. A duration rule (a sound must last N ms to count) is the obvious cheaper fix and does not
reach far enough: the running tap lasts seconds. The verdict arrives a beat behind the audio, and if the
model fails to load (`voice-classifier` in the log) the level line ends the recording instead. Its cost
on the watch is `classifier` in `mic-end`: seconds of work per second of audio. All of these are hub
settings, read together whenever the app comes to the front (`WatchSettings.refresh`) and again at every
start, and kept for the next, since a start does not wait on the hub. They are also kept on the watch
(`capture-settings` in UserDefaults) and taken back at launch, because a launch from the complication
starts recording before any read answers; without them that recording runs on the built-in defaults. So a change made in Settings
reaches the first recording after the wrist comes up; one made while the app stays in front lands a
recording late, because the read at a start applies to the one after it;
`watch_silence_s` is Trailing silence in Settings (5 set on 2026-09-25, 3 when unset). **In `fixed` mode in a quiet room `watch_speech_min` is the whole line**, since
2.5x a floor of 0.0003-0.0015 is under it, and his ordinary voice dips below 0.02 mid-sentence: a kept
20s command measured 8s over 0.02 and 16s over 0.005, with dips of 0.010-0.018 inside speech. The
`mic-end` log (`speech` against `len`) and the kept clips in `voice-clips` are what to tune it from.

**Nothing ends before speech crosses the line**, and a recording whose speech never registers is
never cut short mid-sentence. That is what keeps it clear of the failure that made the phone's buttons
press-only (`VOICE-ON-THE-PHONE.md`): a VAD that cut commands mid-sentence and threw away clips it
judged silent.

**One buffer over the line is not speech.** Speech has to last `Endpointer.minSpeech` (0.4s), unbroken
by a hang of quiet, before the utterance counts as begun. Without that a single blip of room noise
arms the endpoint, which is how a recording nobody spoke into ran 88 seconds on his watch, ended on a
peak of 0.021 against a 0.02 line, and went up as "Thank you. Thank you." — what Whisper writes for
silence, which the worker then ran as a command.

**A command or a follow-up has no length limit.** It ends at his silence or his press, however long he
talks; he did not ask for a cap, and one (60s unlocked, discarding the clip) threw away 40 seconds of
his words. The one close left is `Capture.unspoken`: 15s of audio with no speech in it at all, skipped
while locked. `Capture.longest` (60s) applies only to the always-on listener, which starts a fresh file
after that much unbroken sound.

A **launcher's** request expires too (`Chat.requestWindow`, 20s): the complication and the Record
control set a flag home acts on when it is next on screen, and without the window a request nothing
consumed starts a recording on whatever raise of the wrist brings the app back. Every `mic-open` line
carries `how` — press, tap or launcher — because a recording nobody meant to start is otherwise
indistinguishable from one he asked for.

After `Capture.unspoken` of audio with no speech in it, a command or a follow-up is cancelled and its clip thrown away, and the listener
starts a fresh segment. The microphone and the mute it puts on every room mic are not left open
because a recording started by accident — which the Smart Stack and the complication make easy. A
**locked** recording is exempt: holding it open through silence is exactly what the lock is for. Every
follow-up is locked, and so is the recording the `Hub Locked` complication opens, so a stray touch on
that slot or on a session page holds the microphone (and the room mics' mute) until a press or a
press-and-hold ends it.

Every end logs `mic-end` with the numbers it decided on: `reason` (`silence` or `unspoken`), floor,
threshold, peak, seconds spoken and seconds of audio. Tune the multiplier, the minimum or the minimum
speech from those, not by feel.

### A press starts, the next sends; a session is always locked

Double tap, or a tap on the conversation, starts a command, and the next press sends it. Home and a
session follow the same two steps, both through `CommandBorder.press`. On home the silence after he
speaks also sends it by itself. **In a session it does not**: a follow-up is always locked
(`Capture.Flow`, chosen per recording and reset when it ends) — the red edge, no silence ends it — and
so is the recording the `Hub Locked` complication opens; the first press sends either. `Hub Silence` now starts exactly what the
standard launcher does; it stays so a face that holds it keeps working. `Hub Quick` is the standard
recording with a hard cap, for one-sentence commands: it also sends
itself `watch_quick_s` seconds (Settings → Watch: quick command, 5 when unset) after the microphone
opens — counted from the chirp, in seconds of audio — however he is going; a cap reached with no speech
heard throws the clip away instead, and either logs `mic-end` with `reason: cap`.

**Press and hold (0.6s) cancels the recording under way**, on home and in a session. On home, with
nothing recording, it starts a locked recording (red, the `Hub Locked` flow), so home offers both: a
tap for the amber recording that sends at his silence, a hold for the one only a press sends. A hold
while a reply is being spoken stops the speech instead (`CommandBorder.hold`). **In a session a
follow-up is only ever started by a tap**, so a hold there with nothing recording does nothing, and on
the speaker glyph it toggles speak mode instead. On every other page a hold does nothing. A command already sent is never cancelled; there is no gesture for it.

### Haptics

- **The microphone opening is a rising double tap and a chirp from the speaker** (`.directionUp` and
  `Recorder.cue`, two notes a fifth apart), at the moment it is actually live rather than when it was
  asked for — opening takes a beat, and words spoken before it are lost. The gentle `.start` tap alone
  was easy to miss. The chirp needs the audio session to play AND record (`.playAndRecord`; set to
  record only, nothing plays), and the tap drops the chirp's length of input plus the route latency,
  counted in the microphone's own samples, so the clip never contains it and the endpoint never counts
  it as speech. It must not wait on the chirp's playback-finished callback: that callback does not
  always come (when the speaker does not play the chirp at all), and a gate waiting on it stays shut
  for the whole recording, which the hub then refuses as an empty clip. Commands and follow-ups only; the always-on listener opens silently.
- **The microphone closing taps the wrist** (`.stop`), on home and in a session, on a recording the
  silence ended and on one a press ended alike. That is the moment nothing else reports: the silence
  decides it, and by then the watch may be back at his side.
- **A recording still open taps the wrist once a minute** (`.directionDown`, `Capture.nudge`), a
  command or a follow-up alike, counted in seconds of audio, and logs `mic-nudge`. A locked recording ends only at a press, so one left
  running holds the microphone and every room mic's mute until he notices; the tap is how he does. A
  falling double tap, the start tap's mirror; a test with `.click` went unnoticed. Never on the listener or rewind, which are
  meant to run.
- **Every command ends in a second tap, whichever way it ends**: a reply buzzes `.notification` (the one
  that makes a sound, so it is heard as well as felt); a failure buzzes `.failure`, whether the hub
  heard no words, the worker failed the command, or the send itself failed.

### The wrist can drop mid-recording

The watch declares `UIBackgroundModes: audio` (in `project.yml`) — that key, not `WKBackgroundModes`,
which takes only session types. A recording can only START with the app in front; once running it
continues behind the watch face with the microphone indicator showing, so a command still ends at its
silence with the wrist down. Measured on the device: a locked recording ran 31s past the app going
`inactive` and the 33s clip arrived whole.

**What happens when something else takes the microphone mid-recording is the interruption path below
(§ The always-on listener)**: a command or follow-up is PAUSED, never sent half-said or thrown away.
The log can show it as `mic-route-change` with empty `inputs`, then `mic-interrupted` — or as
`mic-interrupted` alone: on 2026-10-19 a command ended mid-sentence with no route change before it, a
`phase` → `inactive` 3s earlier, and nothing sent to the watch at that moment by the hub or Messages.
To him that reads exactly like the silence endpoint firing early, so tell the two apart by the end
event: a silence end logs `mic-end`, an interruption logs `mic-interrupted` and no `mic-end`. Which
events raise it: a Siri timer going off does (2026-10-31, `reason` 0, 1.1s into a recording opened from
the complication). An ordinary notification has not been seen to; Siri (Raise to Speak) and a call are the
other candidates. `mic-interrupted` carries the system's reason and the endpoint's state.

### Sending it

A command is sent the way the phone's microphone sends one: `Hub.sendAudio` uploads the file to
`/api/voice-command` (source `watch-cmd`), the hub transcribes it with the same Groq Whisper, and the
worker treats it as push-to-talk — no addressing gate, no spoken reply on the TV. It
carries the clip's recording window (`Recorder.Clip.start` plus its duration) as `capture_start` /
`capture_end`: the start is what a voice-logged set is stamped with (`LISTENERS.md`), and the window is
what lets the worker drop it as a duplicate only when a room mic heard the same sentence. The hub
answers with the transcript, shown until the turn lands, and the request id, and the watch waits on
`/api/voice-reply/:id`.

**A locked recording is transcribed differently** (`flow=locked` on the upload, from `Recorder.Clip.locked`).
It is long and he stops talking while he does things, so the hub sends it to `whisper-large-v3` rather
than turbo — turbo dropped the first 10s of a 27s locked command on every retry — and first shortens its
long pauses (`shortenPauses` in `server/lib/transcribe.js`). The pauses come from the watch: while a
locked recording runs, `Capture.markQuiet` notes every stretch the speech classifier (or the level line,
when the classifier is off) heard no speech for `Capture.quietMin` (4s) or more, and they ride the
upload as `quiet=start-end,…` in seconds of the file. The hub cuts only pauses over 6s and keeps 2s at
each edge, so a 9-minute recording of a sentence and a meal's worth of quiet goes up as the sentence; it
never cuts close to speech, because Whisper reads pauses as sentence breaks and tight cuts merge
sentences and lose the words beside them. The stored clip is the original. Turbo still runs on it, as the second opinion every command gets (`docs/HUB-INTERNALS.md`, `transcribe.js` row): the two models mishear different words, so the worker sees both whenever they disagree. No id means the hub heard no words. **With the wrist down the app is kept running until
a home command's answer is in** (`StayAwake`): recording keeps a watch app alive, but once the command
is sent nothing did, so the app was suspended mid-wait, the answer's tap never came, and the screen
still showed the command working when he looked. `StayAwake` holds the microphone and discards what it
hears while `Chat.waiting`, and lets go the moment nothing is, or after a minute. Speak mode holds it
for as long as the mode is on instead (see Speak mode). Playing silence instead looks equivalent
and is not: a watch app that only plays is frozen the instant the wrist drops (see Spoken replies). It
stands aside for anything else holding the microphone (a recording, the listener, a spoken reply), which
keeps the app alive by itself, and each of those makes it let go when they start, since two taps on
the microphone fight. Anything that turns the audio session off (a recording ending, a spoken reply
finishing) calls `sessionReleased()` so it takes the microphone back if a command is still waiting.
Home commands only: a session can work for minutes, and he does not want the battery spent on that. And **one minute at most per wait** (his number): if the answer has not come by then it lets go,
and nothing restarts it until nothing is waiting. It
does not make the dimmed screen redraw faster (watchOS caps that at about once a second, which is why
the edge is a steady ring wrist-down); it keeps the app working so the answer lands on time. A connection lost during that wait is asked
again with backoff (`Hub.outcome`), never shown as a failure: the command is with the hub already, and a
lowered wrist suspends the app and kills the open request, which used to read "The request timed out"
over a command that had finished.

**Recording holds the mute**, as the phone's microphone does (`Hub.muteOthers`, holder `watch` on
`/api/voice-mute`, which keeps `voice_muted` set while any holder has it), so the Mac and the ESP do
not enqueue the same sentence a second time. Every way out of a recording (send, cancel) gives it
back, and the writes are chained so a release cannot land ahead of its take; a holder left set is
ignored after 15 minutes.

**Retry.** The clip is kept until its command has run, and the `client_msg_id` across a Retry, so a
resend after a dropped connection gets the first send's id back instead of running twice. Once the id
is known, Retry only waits again; after a worker error it uploads the clip as a new attempt.

### When the hub does not answer

The hub is one machine on Fly, and every command the watch sends goes through it. So a command that
gets no answer from the hub in `Hub.hubPatience` (25s), or gets Fly's proxy answering for it (a 5xx),
goes to the **fallback** instead (`Hub.sendCommand`): Supabase's `voice-fallback` edge function
(data-layer `supabase/functions`), which runs off Fly, transcribes the clip with Groq and queues it as
status `fallback`. Only the Pi's worker claims that status. It runs the command on Opus with every
tool, opens the reply by saying it came the fallback way, and the first fallback command in thirty
minutes also starts a session to find out why the hub did not answer.

The patience is the trade. Fly's proxy holds a request open while it looks for a machine it does not
have, so without a ceiling of its own a command waited the full minute before anything else was tried.
A hub that is up but slower than 25s gets the command twice, its own copy and the fallback's.

The 25s is a deadline on the whole send, raced against it in `sendCommand`, not the request's
`timeoutInterval`: that is an idle timer, it does not run while the session waits for connectivity, and
`resending` starts it over, so with it alone a send has taken 64s. The deadline starts only once the
watch has a route (`Net.whenUp`). With no route the fallback is unreachable too, and the send waits for
connectivity until the session's resource limit (`connectionWait` + 60, two minutes) runs out.

The function checks the same `X-Hub-Token`, against a hash the hub writes to `fallback_config` at every
boot, and a 401 from it does not throw the token away the way the hub's 401 does: it means the
function lacks the hash, not that the token is wrong. The outcome is waited on at the function too
(`Hub.fallbackOutcome`, held open on the row, `pending` after 50s), and it carries the reply's text,
which the watch puts into the thread itself when `load()` did not bring it — the thread is served by
the hub that did not answer. Only home commands fall back; a session's follow-up and the always-on
listener still go to the hub alone.

### A control per page

Control Center, the Smart Stack and an Ultra's Action button each hold **Hub · Listen · Sessions · Nutrition ·
Workout**, which open the app on that page (`OpenPageIntent` → `Router` → `RootView`); Nutrition and Workout
land on the day page opened straight into a full list (`Router.dayList`): today's food log, or the
exercise list. Sessions always lands on the LIST, closing a session left open there; the others leave it
open for when he swipes back. Hub (the mic control; `RecordControl` in the code) is the odd one out: it opens home AND starts a command. It is labelled Hub because it sends a command to the hub — a recording is only how.
Each control is its own type, spelled out in full — the `kind`, title and symbol are literals, because
Control Center reads them before the extension runs and a computed one is not there to read.

**Blank tiles — no name, no icon, on every one of the app's controls — are a stale cache on the watch,
not the code.** Deleting the app from the watch and reinstalling it clears it. It is worth knowing
before debugging: the controls still register correctly (the simulator log shows `query returned …
controls` for every kind) and the same control draws normally in the Smart Stack, and a build that is
byte-identical to one that worked (files, plists, entitlements, asset catalog) still shows blank tiles
until the reinstall. Toggling Low Power Mode, the fix circulating for watchOS 26, does not clear it.

**Listen is a button that opens the app**, an `OpenIntent`, because the microphone can only run in
the app; it turns always-on listening on or off, which then carries on with the wrist down (background
audio), and the blue edge shows it. No control shares state with the app: the extension is a separate
process, this account cannot enable App Groups, and nothing a control draws depends on the app's state.

### Spoken replies

**Nothing is spoken unless he asks.** A session's page carries a bare speaker glyph in its bottom right
corner (`SessionView.playButton`, shown once the session has a reply): a tap reads that session's LAST
reply aloud (`Speaker`). While it plays the corner holds a stop and a pause; the pause becomes a play
while paused, and carries on from the same place (`Speaker.pause` / `unpause`), with everything still
queued and the microphone still held. Asking once for every reply is speak mode, below.

### Speak mode

**Holding the speaker glyph** (0.6s) turns it on or off (`Sessions.toggleSpeakMode`), with the start or
stop haptic; while it is on the glyph is white with a third wave. The toggle is done by the app's ONE
hold gesture, on the whole page row (home's hold, which does nothing else in a session): the glyph only
reports that a finger is on it (`Sessions.speakerPressed`). A second hold recogniser on the glyph would
fire at the same instant as the row's, and both would act. It is for lying in bed without looking
at the watch, so everything about it works wrist-down:

- **Every reply is read aloud as it lands** (`Sessions.speakIfNew`) — replies to the session open on the
  sessions page, and to any session this watch sent a follow-up to and is waiting on. Only replies that
  land after the mode came on; a first load of a conversation is history and is never read out. A
  recording in progress wins: a reply landing mid-recording is skipped, not queued.
- **The microphone is held for as long as the mode is on** (`StayAwake`, with no cut-off), and the
  session stream stays open on every page and with the wrist down (`RootView.follow`). Without both the
  app is frozen the moment the wrist drops and never hears the reply. This is the battery the mode
  costs, and why it is a mode he turns on rather than how sessions always behave.
- **Follow-ups sent from the watch ask for a reply written for the ear.** The watch sends
  `spoken: true`; the hub appends `SPEAK_NOTE` (server.js) to the words it types into the session —
  complete, but as succinct as the content allows, no tables, code, paths or URLs unless they are the
  answer. The note rides in a `<speak-mode>` tag that `resolvePrompt` (voice-pipeline transcripts.js)
  strips, so every surface shows only his words and the sender's message id still matches its prompt.
- **It lives in memory only.** An app relaunched later does not come back holding the microphone.

**The voice is the hub's, not the watch's.** The reply goes to `/api/tts` and comes back as WAV a chunk
at a time — the same endpoint the phone's session view plays, described in `docs/HUB-INTERNALS.md` §
Replies read aloud. The server strips the markdown, splits the text, and picks the model and the voice
(`tts_voice` and `tts_speed`, on the hub's Settings page), so none of that needs a build. The watch fetches the chunks
in order, decodes each, and queues it on its player the moment it lands; `/api/tts/timing` logs how long
the first sound took. While it plays, the session page shows the system volume control (`VolumeKnob`),
which takes the Digital Crown and turns the watch's own volume; the voice itself plays at full, and the hub has already compressed and limited it to just under clipping and voiced it for the watch speaker (`surface: 'watch'` on `/api/tts`). The glyph is its own button over
the page, so a tap on it is not the press the rest of the glass is. **The always-on
listener stands aside while it speaks** (`Capture.hush`), so it does not transcribe the watch's own
voice, and takes the microphone back when it finishes — paused, not switched off. Starting a recording
stops the speaking at once, and so does the press.

**AirPods connected to the watch play it.** Every `.playAndRecord` claim in the watch app carries
`.allowBluetoothA2DP` (the reply, a recording, the stay-awake tap, the live listener). Without it AirPods
are not a route at all: picking them in the watch's output menu connects them, then they drop out of the
list and the sound stays on the speaker. A2DP is output only, so the watch's own mic is always the input.

**The app plays the voice itself and holds the microphone while it does, so it keeps talking with
the wrist down.** watchOS keeps an app running wrist-down while it records, not while it only plays.
The app's own engine under `.playback` freezes when the wrist drops, with the engine and player still
reporting running and no notification firing. So `Speaker` plays the buffers through its own
`AVAudioEngine` under `.playAndRecord`, and taps the microphone and discards what it hears for exactly
as long as the voice plays (`holdMic`) — the mechanism that keeps a command recording wrist-down. The
reply has finished rendering once the last chunk is in hand. Every reply ends in a `speak-end` log line saying
how (`done`, `stopped`, `failed`) and how many seconds of it played.

**A reply can be cut out from under the player without any callback firing** (an interruption, an
engine configuration change, the media services resetting, the app being suspended), and then it is
never counted as finished: the voice stops and the listener stays hushed. So `Speaker` keeps every
rendered buffer and how many have played, and resumes from the first unplayed one on each of those
notifications and whenever the app comes to the front and finds the player silent (`checkOnWake`).

**While a reply is spoken, the next press only stops it** (`CommandBorder.press`): a double tap, or a tap
anywhere on the screen (the top half included, which otherwise does nothing). The press after that
records as usual.


**Treating the reply as long-form audio does not keep it running.** `.playback` with
`routeSharingPolicy: .longFormAudio` and a Now Playing entry is the documented way an audio app plays
wrist-down, and it is what a reader will reach for to stop the microphone showing as in use. Tried on
the watch, it did not play wrist-down at all, so holding the microphone is the only route.

### Launchers, one request

Six complications (circular and corner), all invisible on the face. The face editor shows a complication's drawing rather than its display name, so each writes a one-word name only in a preview (`context.isPreview`) — clear everywhere, all six are identical blank tiles there. Four record: `RecordComplication` opens
`statushub://record` (the standard flow), `RecordSilenceComplication` `statushub://record?flow=silence`,
`RecordLockedComplication` `statushub://record?flow=locked` and `RecordQuickComplication`
`statushub://record?flow=quick`; `onOpenURL` passes the flow through `Chat.requestRecording` to the
recording. Two only travel, as a page's control does (`Router.open`): `DayComplication`
(`statushub://open?page=day`, the day page with nothing opened on it) and `SessionsComplication`
(`statushub://open?page=sessions`, always the list). Each draws nothing — a clear view filling the slot — so the face shows no trace of it and the empty slot is still the button — which also means the face does not say which slot is which. The Record control
(`RecordControl`, watchOS 26 — Control Center, the Smart Stack, and the Action button on an Ultra)
runs `RecordIntent`, an `OpenIntent`, which launches the app and runs `perform()` in it: the file is
compiled into both targets, and `WATCH_APP` gates the app-only call. Both set `Chat.recordRequested`;
the app switches to home and records as soon as it is active. The page that acts on the request is
whichever is showing (`recordsWhenAsked`, which checks `onScreen`), so two pages cannot both start
one.

**A launcher opens ON its page, not on the last one.** watchOS brings a backgrounded app back by
zooming in from its last picture of it, and the URL only arrives once the app is active, so the page he
left would show first and then move. Two things stop that in `RootView`: the app goes black
(`veiled`) when it reaches the background and lifts the black a beat after it is active again, once
the URL has turned the page; and every page a launcher, control or notification picks is a cut
(`jump(to:)`, animations disabled), never a scroll across the pages between. The cost is that opening
the app any other way also starts from black for that beat. Not yet confirmed on the watch: the
simulator cannot background the app or deliver a complication's URL without clicking its window.
**A veil that stays up is a black watch**, so it is built to fail open: it takes no touches
(`allowsHitTesting(false)`), so the page under it still works, and it comes down 400ms after the app
is active whatever else happened, logging `veil-stuck` when that deadline is what lifted it. Every
`phase` line carries `veiled`, the state at that change.

Without an Action button, the no-touch path is the Smart Stack: with Settings → Gestures → Double Tap →
Smart Stack set to Select and Record pinned, two double taps from the watch face open it recording
(verified on watchOS 26.5). An app holding a workout session (Watchset while it captures)
sits above even pinned items.

### Rewind

The **Buffer** and **Rewind** controls keep the last stretch of audio in memory and transcribe it on
demand, riding the same microphone as everything above (owner `.rewind`, which gives way to any
command and takes it back after). [REWIND.md](REWIND.md) is the whole of it, including its `rewind*`
log lines.

### The always-on listener

`Capture.toggleListening`, from home's toggle. It is the phone's always-on mode on the wrist: the recorder runs continuously and `Recorder.cut` swaps the file inside the tap, so
no sample falls between two utterances. Each utterance goes up as source `watch` with its own
`capture_start` / `capture_end`, which is what lets the worker collapse it against the Mac or the ESP
hearing the same sentence (`LISTENERS.md`). A segment nobody spoke in is dropped at 30s of audio and
never uploaded, because Whisper invents a sentence for silence. It mutes nothing: it is a peer of the
room mics, not a command someone is holding the watch to say. Each utterance the hub enqueues taps the
wrist (`.success`); one it heard no words in taps nothing. Uploads are fire-and-forget, with no outbox
behind them yet.

**The send is the moment the app has nothing keeping it awake.** Recording is what holds a watch app
in the background, and it has just ended — with the wrist down the app would be suspended mid-upload.
Every clip therefore goes up inside `Awake.hold` (an expiring activity), which is best effort: the
system can take it back, and the `sent` / `send-failed` log lines carry how long a send took, so a
send being cut off is visible rather than a command that quietly never arrived.

**A timer or alarm, Siri, a call or another app recording takes the microphone**, and nothing can refuse
it. The interruption notification is what says so (`Recorder.onInterruption`). A command or a follow-up
is PAUSED (`Capture.pause`, logged `mic-paused`, buzzes `.failure`): the engine stops and the session is
handed back, but the clip's file stays open and nothing is sent — sending the half said before the timer
rang runs a command he had not finished. It carries on INTO THE SAME CLIP (`resumeDraft`, with the chirp)
at the first of: the interruption's end, the app coming back to the front, or his press — a press on a
paused recording resumes it and never sends it. A resume the system refuses (still ringing, app not in
front) logs `mic-resume` `ok:false` and stays paused for the next. After a resume the endpoint starts
over, so the silence only ends the command once he has spoken again, and the `unspoken` and `quick`
caps count from the resume; a resumed recording he says nothing more into pauses again rather than
discarding what came before. Press and hold still throws it away. The draft lives only in the app's
process, so a watchOS kill while paused loses it. A listener utterance that had begun goes up, and when
the microphone comes back listening picks it up again. Without that handling always-on listening ended at
the first Siri and the glyph went on claiming it was listening.

**A deliberate command comes first.** Starting a command or a follow-up takes the microphone off the
listener — whatever it had heard by then still goes up — and the listener takes it back when that
recording is sent or cancelled (`resumeSoon`, scheduled rather than immediate so it cannot grab the
microphone back before the command has started). So `Capture.free` is what a page asks before
recording, not `owner == nil`.

## Double tap, and scrolling

**Double tap is the command, and it is the only binding.** With no control on screen it binds to a
point-sized, invisible button inside `CommandBorder` (`handGestureShortcut(.primaryAction)`). The
simulator cannot perform the gesture, so the binding is proven only on the watch.

**Scrolling is a finger or the crown, never the gesture.** The control used to page the view down
while anything was below, and hand the gesture to recording only at the bottom; that is gone, along
with the scroll-geometry machinery it needed. What it cost is worth knowing, because it is why nothing
here should measure a scroll view again: the same scroll view reports its geometry in two frames
depending on how it was last moved, so the maths was right in one and wrong in the other, and on his
watch the geometry went on reporting content below after the view had stopped at its end — so every
double tap asked for a scroll that could not happen and recording never got the gesture at all.

A session's page scrolls through `PagedScroll` (`Watch/WatchUI.swift`), which is the control over a
scroll view and nothing more; home has its own scrolling, because it is the one page that lands the
view on the top of each new thing. A tap records anywhere on home and anywhere in a session.

**The tap is bound to the conversation's own frame, which is only as tall as its text** — a short
conversation left the blank space below it unresponsive: no press, no way to stop a reply mid-speech by
tapping there, because nothing was there to receive the tap. The session view's content is given a
minimum height of a full screen so the tappable area always reaches the bottom of the glass, whatever
the conversation's own length. Home binds its tap on the scroll view itself, so it has no gap to fill.

## The token comes from the phone

The watch has no web view to sign in with and shares neither cookies nor Keychain with the phone.
`Sources/WatchLink.swift` reads the `hub` cookie from the web view's cookie store (falling back to the
Keychain password) and sends it as WatchConnectivity application context on activation, when the
watch app is installed (`sessionWatchStateDidChange` — context sent before that is refused), and on
every cookie change. The watch keeps it in its own Keychain and, whenever it has none, asks with a
message, which wakes the phone app in the background. A 401 drops the stored token and asks again.

## It waits for a connection

With the phone off or out of range the watch has no route at all until it brings up its own Wi-Fi or
cellular, and the phone keeps carrying traffic for a few seconds while it shuts down — so a request
can start on the phone's link and lose it mid-flight. Every call goes through `Hub.session`, which
sets `waitsForConnectivity`: a request made in the gap waits up to `Hub.connectionWait` (60s) for a
route instead of failing on the spot, and one whose connection drops mid-flight is sent once more
(`resending`), which is safe because commands and follow-ups carry a `client_msg_id`. The event
streams use `streamSession`, the same with no overall limit. `URLSession.shared` fails at once with
no connection, so a new call must not use it.

## It logs what it does to the hub

`Hub.log` posts to `/api/clientlog`, which prints one `[clientlog]` line per event:
`fly logs -a jared-status-hub | grep '"src":"watch"'`. Read it before guessing at a report from the
wrist. Fly keeps only the recent lines, so read it soon.

| event | what it says |
|---|---|
| `thread` | what home loaded |
| `log` | a conversation's list fetched from the hub: from which seq, how many events came, the last seq held |
| `control` | a press of the bottom control, with its mode |
| `record` | a finger tap on the text |
| `record-refused`, `mic-refused`, `mic-failed`, `mic-open` | why a recording did or did not start |
| `mic-nudge` | the once-a-minute tap on a recording still open: minutes so far, the flow, the build |
| `mic-end` | what the endpoint saw when a recording ended, and why (`silence`, `unspoken`) |
| `mic-paused`, `mic-resume` | a command or follow-up held through an interruption (`seconds` recorded, `heard`), and carried on: `how` (`interruption-ended`, `active`, `press`), `ok` |
| `mic-interrupted`, `mic-interruption-ended` | the system took the microphone mid-recording, and gave it back: the system's `reason` (0 default — Siri, a call, an alarm; 1 app suspended; 2 built-in mic muted; 3 route disconnected), `options` on the end (1 = may resume), the route, `recording` (seconds since the microphone opened), and on the start the endpoint's state — `quiet` (seconds since the last speech), `voice` (the classifier's last score), `heard`, `seconds`, `flow`. `quiet` near 0 with `voice` high is a cut mid-word |
| `mic-route`, `mic-route-change` | the audio session's category and mode, its input and output ports, and whether other audio is playing — at every recording's start, and whenever the route changes under one |
| `mic-live` | the first buffer from the microphone, with how long after opening it came. A recording with no `mic-live` never heard anything |
| `mic-engine-restart` | the audio engine was stopped by a configuration change mid-recording and started again (a stopped engine records nothing) |
| `chirp`, `chirp-done` | the start chirp asked for (whether the engine and player were running) and heard to finish, with how long it took. A `chirp` with no `chirp-done` is a chirp the speaker never played |
| `record-stop` | a recording stopped: its length, `heard` (seconds actually written to the clip), `peak` (loudest RMS written) and `chirped`. `heard` far short of `seconds` is a deaf microphone; `heard` with `peak` near 0 is a live one hearing silence |
| `listener-sent`, `listener-failed` | an always-on utterance going up |
| `sent`, `send-failed` | a command's clip going up, with how long it took |
| `listen-alive` | always-on listening still has the microphone, with minutes since it was engaged — one line per twenty silent segments, about five minutes. **This is how long watchOS lets it hold the microphone with the wrist down**, which is otherwise unknown: read the gap between the last line and when it was engaged |
| `rewind`, `rewind-alive`, `rewind-check`, `rewind-grab` | rewind engaged and dropped, still fed, checked on wake, grabbed — each with minutes engaged and the battery ([REWIND.md](REWIND.md)) |
| `speak`, `speak-end`, `speak-failed` | a spoken reply starting (its length and output port) and how it ended, with seconds played |
| `speak-rendered` | the synthesizer finished rendering the reply: its total seconds, and how long rendering took |
| `speak-interrupted`, `speak-config-change`, `speak-media-reset`, `speak-stalled`, `speak-resume` | what cut a reply off, and the resume from where it stopped (seconds played of seconds rendered) |
| `phase` | the app becoming active, inactive or background: wrist up and down. `veiled` is whether the black launch veil was up at the change |
| `veil-stuck` | the veil was still up 400ms after the app became active and the deadline lifted it (The launcher section) |
| `speak-pause`, `speak-unpause` | the pause glyph holding a reply, and carrying it on |
| `session-shown` | what the session page actually has on screen and why it was logged (see The sessions page) |
| `stream-open`, `stream-end`, `stream-error` | the event streams |
| `resend` | a call's connection dropped mid-flight and it was sent again |
| `net` | the watch's route changed (`Net`, NWPathMonitor): `status`, `via` (`other` is the phone, `wifi` / `cellular` the watch's own), `expensive`, `constrained`, `phone` (the phone link reachable), and `after`, the seconds the previous route lasted. Read it first when commands sat on the wrist and landed together |
| `phone-link` | WatchConnectivity's reachability to the phone changed |
| `frame` | each `ev` frame for the session on screen: its seq and kind |

## Hiding the system clock

watchOS draws the time over the top right corner of every app, composited above the app's own content
— there is no way to draw around it and no public modifier for it. One underscored SwiftUI modifier
turns it off, on the scene's root view:

    WindowGroup {
        RootView()
            ._statusBarHidden(true)
    }

It works. **Verified by removing it and looking**, which is the only way to know: with the modifier the
clock is absent, without it `11:02` sits over the top-right of the screen. The SIMULATOR renders the
clock faithfully, so this is testable without a device — a screenshot that shows no clock is evidence,
not a capture artefact.

It is underscored, which is a promise of instability rather than a private-API rejection risk: the
symbol is visible to the compiler in SwiftUI, not looked up at runtime. So it can stop working in any
watchOS release without warning, and the check above is what to re-run when it does.

## Running it in the simulator

The real app runs in a watchOS simulator against the live hub. Simulator-only code, compiled out of
device builds:

- the token comes from `SIMCTL_CHILD_HUB_TOKEN` (the kiosk's, sent as `?token=`);
- `-opensession <row id>` opens a session as its notification would;
- `-threaddemo` gives home a made-up thread and then walks one command through it as the hub delivers a
  real one (his words pending, tool calls, the reply loaded, the pending words dropped), so each landing
  can be screenshotted without a token;
- `-page <sessions|home|day|health>` lands on a page; `-dayview <totals|muscles>` opens the day page's
  totals or its muscles page; `-health <weight|food|training>` opens a health page's full view;
- `DAY_CLOCKS=<rest s>,<session s>` (as `SIMCTL_CHILD_DAY_CLOCKS`) sets the day page's rest and session
  clocks to any length, to check what fits beside the feet;
- recording and stopping never reach the hub (`blockInSimulator` in `Hub.swift` — a test tap once sent
  a stray "you" into his conversation) and never mute the room mics.

The built app needs `WKWatchOnly` and no `WKCompanionAppBundleIdentifier` (then an ad-hoc `codesign`)
to install on an unpaired watch simulator. **His watch is a Series 12, 46mm**, and the one watch
simulator kept on this Mac is a Series 11 46mm — the same 416x496 screen and the same corner mask — so
a screenshot here is his geometry, and the device's framebuffer mask (named by `framebufferMask` in the
simulator's `profile.plist`) is the true outline of his glass. Only one is kept because each device
costs over a gigabyte of disk.

- **The simulator is watchOS 26.5 and his watch is 27**, so what a simulator proves about layout is
  not proof about his watch, and a system behaviour measured here (what hides the clock, how a gesture
  resolves) can differ there. Installing the 27 runtime is a multi-GB download this disk cannot take.
- **Do not click the Simulator window with System Events**: that moves his pointer. Reach a state
  with a launch argument instead; the simulator cannot make a double tap either way.
- **A recording in the simulator records from the Mac's microphone.** Test the silence endpoint by
  feeding `Endpointer` levels, never by playing sound into the room — the Mac's own always-on mic hears
  it too.
