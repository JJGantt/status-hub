# The watch app

`StatusHubWatch`: a watchOS 11+ app (`apps/Watch/`, bundle `com.jaredgantt.statushub.watch`) embedded
by the iOS app, plus its widget extension `StatusHubWatchWidgets` (`apps/WatchWidgets/`,
`com.jaredgantt.statushub.watch.widgets`) — the complication and, on watchOS 26, the Record control.
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

Four, swiped left to right: **sessions · home · day · health**. The app opens on home, which IS the
conversation — there is no separate prompt page. New layouts are added as NEW pages beside the old
ones rather than by reshaping a page in place, and the ones that lose are deleted; `day` and `health`
are two layouts of the same food-and-training data, and one of them is expected to go.
`RootView` in `StatusHubWatchApp.swift` holds them in a paged `TabView` inside a `NavigationStack`,
with the page dots off (`indexDisplayMode: .never`) — a strip of screen spent saying what a swipe
already says.

A page loads when it comes on screen and holds its event stream open only while it is showing
(`follow()`), reloading after every reconnect, since a change may have gone by. `Hub.listen` reads all
three streams; every frame the hub sends has a `data:` line, keepalives included, and that is what it
dispatches on.

Every page stays alive side by side in the TabView, so anything that binds double tap or acts on a
request asks `onScreen` (an environment value `RootView` sets per page) first.

### Home — the conversation

`HomeView`: the last ten exchanges of the shared hub thread, each in full — his words as the hub
transcribed them, the reply as it was written — over `/api/voice-messages?focus=hub&mode=active`,
the same current-context thread the phone and the TV show, in whichever mode `agent_mode` selects. It
follows `/api/voice-stream`: a `message` frame reloads the thread, and the worker's `activity` frames
draw the running command's tool calls under it (`ActivityLines`), which the hub does not store, so they
show only while the page is watching.

**A command walks the page**, and each step lands the view on a TOP, because a reply is read from its
first line rather than scrolled to the end:

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

**The landing spot is fixed, per page** (`Landing` in `WatchUI.swift`): 32pt from the top of the glass
on home, where a full-width first line clears the corner curve and the thickest default edge; 58pt in
a session, under its title and clear of the fade the title draws over what scrolls beneath it. It does
not move with the edge: text that shifted whenever a command lit the border would jump on every
command. **Items sit an ordinary 12pt apart (`Landing.itemGap`); only the newest has room above it**,
enough that when it lands the item before it ends just above the top of the screen. That room is a
spacer of its own (`room`), never padding on the item: SwiftUI measures a scroll target INCLUDING
padding, so padding put the item's text a whole landing too low. And it appears only when the newest
item is tall enough to reach the landing line (its height is measured): a short last item rests at the
end of the scroll with the thread above it on screen anyway, where the room was a blank band. The tool calls of a running
turn land as one block (`activity`), not line by line. Within that block a session's echo of his words (`said`, or `queued` behind a running turn) is drawn as
his words, in full; only tool calls are cut to two lines. Words the watch sent are already on screen, so
their echo is dropped, and `summary` frames are ignored because the detail fetch brings the reply.

A tap in the BOTTOM HALF of the glass is the same press as the control (`CommandBorder.tapPresses`); the
top half is for reading, since the whole page as a button kept starting recordings under a finger. The page carries nothing else: no
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

### The sessions page

Lists `/api/sessions` one row per conversation — running first, then parked, most recently active
first within each, the order `n` counts in — and follows `/api/session-stream`. Each row is its name
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
**amber** left edge is a finished reply nobody has opened, which also takes back the dimming a parked
row gets, since a finished session is the one most worth reading; a green **dot** is a session working
now. Under each name is what that machine is doing, live off `/api/session-stream` — a tool call in
teal, what the model says between them in a plain light — and the line is always there, however empty,
because a row that grows when a tool fires and shrinks when one stops makes the whole list jump every
few seconds. Opening a session marks it seen (`POST /api/sessions/seen`), so the mark clears on the
phone and the wall too.

The list is a **ScrollView, not a List**: a watchOS List puts every row in a grey rounded slab, and
this page is a list of names — rules separate them, as they do on the food log and the exercises.

A tapped row opens its session on top of the whole row of pages (the `NavigationStack` is `RootView`'s,
around the `TabView`), not inside the sessions page: there the page row took sideways swipes and the
watch's own swipe back never fired. The session has no title bar.

**A session follows its newest item.** The page draws the last `SessionDetail.exchanges` (5)
prompts with every reply under each — a session can report more than once without being asked again, a
watcher firing or a job finishing — then his words waiting for an answer, then the tool calls of the
turn in flight. The top of whichever is LAST sits at the top of the screen: his words the moment they
are transcribed, each tool call as it arrives, the reply when it lands. The tool calls and his words
are cleared only after the reply is fetched (`Sessions.sessionFrame`); cleared first, the newest item
would be the previous reply for the length of the fetch and the view would jump up to it and back.

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

**Commands overlap.** A command can be recorded and sent while earlier ones are still being
transcribed, handed over or worked on, on home and in a session alike: each is its own item (`Chat`'s
`commands`, `Sessions`' `outgoing`), sent and retried by itself. His words join the conversation in the
order he said them (home's `pending`; in a session, `.said` lines in the activity list among the tool
calls), and the page lands on his newest words.

**The edge sweeps until the last command is answered**: `awaiting` holds the time the NEWEST follow-up
was accepted, and the wait ends only when a detail fetch shows the session idle with a reply stamped
after it (`finished`: `working` false and `reply_at` later). Idle matters because a turn can end while
the session already has the next command, and that reply is not the one he is waiting on; the host
marks a row not-working, with its reply, before it sends `done`, so the fetch on `done` sees the truth.
A reply AFTER the words, not a turn whose prompt is the words: words sent into a turn already running
are folded into it and never become a prompt. Spoken replies (`owed`) use the same test, so only the
reply to his last command is read, once everything is answered; nothing earlier is queued.

**Its name is on the clock's line, and the name is how it closes.** A leading `ToolbarItem` holds it
(a trailing one moves the clock to the other end of the strip), and tapping it pops the session. The
swipe back watchOS gives a pushed view does not survive a page row that also takes sideways swipes, so
the way out is the thing at the top that says which session this is.

**A recording running in a session is marked in the list**: a red square in its row, beside the green
working dot, so a recording started in one and left there can be found from anywhere in the app.

Everything it keeps is keyed by `claude_session_id`, not by row: a resume makes a new row for the
same conversation, and keyed by row the page would lose a session the moment it resumed. A session
opens to its last prompt and the whole reply to it (`GET /api/sessions/:id`) and the tool calls of the
turn it is running, as its machine reports them. The page refetches the on-screen conversation
whenever it becomes active.

A tap or double tap records a follow-up: the hub transcribes it without enqueueing anything
(`/api/voice-command?dry=1`), and `POST /api/sessions/followup` types the words in, or resumes a
parked session with them (`HUB-INTERNALS.md` §6b). His words stay under the reply until the
conversation's next `done`. **A follow-up records exactly as a command on home does**: it sends
itself at his silence, a second press locks it open, the next sends (`CommandBorder.press`, one flow
everywhere).

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

There is no control on screen. **Double tap runs a command, press and hold anywhere throws one away,
and a line around the very edge of the glass says what is happening** (`CommandBorder`, one overlay on
`RootView`'s whole navigation stack, so it is the same on every page and inside a session, where a
command goes to the session instead of the hub):

| state | edge |
|---|---|
| recording, and the silence will end it | amber |
| locked open through the silence (home and sessions alike) | red |
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

**One read serves all the watch's hub settings** (`WatchSettings.refresh`: the edge, and spoken
replies), on launch and whenever the app comes to the front; the last values are kept between launches.
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
- **Under each column, a list to the bottom of the glass, scrolling:** every meal EATEN today (staged
  ones are left out — planned is not eaten) and every exercise today, most recent first. A tap opens
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
would. **The speech line has two modes, a switch in Settings (Watch: speech line):** `fixed`, the default,
is 2.5x the floor and at least `watch_speech_min` (0.02 when unset); `room` drops the fixed number and is
`watch_speech_ratio` (8 when unset) times the floor, so it follows the room. All of these are hub
settings, read together at every start and kept for the next, since a start does not wait on the hub;
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
**locked** recording is exempt: holding it open through silence is exactly what the lock is for.

Every end logs `mic-end` with the numbers it decided on: `reason` (`silence` or `unspoken`), floor,
threshold, peak, seconds spoken and seconds of audio. Tune the multiplier, the minimum or the minimum
speech from those, not by feel.

### The lock is a step, not a button

Double tap, or a tap on the conversation, walks a command: start, then lock it open through any
silence, then send. Unlocked, the silence still ends it by itself. Home and a session follow the same
steps; both go through `CommandBorder.press`. Press and hold anywhere cancels the recording, or the command the hub is still
working on; it does nothing when there is nothing to throw away.

### Haptics

- **The microphone opening is a rising double tap and a chirp from the speaker** (`.directionUp` and
  `Recorder.cue`, two notes a fifth apart), at the moment it is actually live rather than when it was
  asked for — opening takes a beat, and words spoken before it are lost. The gentle `.start` tap alone
  was easy to miss. The chirp needs the audio session to play AND record (`.playAndRecord`; set to
  record only, nothing plays), and the tap drops what the microphone hears until the chirp's
  playback-finished callback, so the clip never contains it and the endpoint never counts it as
  speech. Commands and follow-ups only; the always-on listener opens silently.
- **The microphone closing taps the wrist** (`.stop`), on a command the silence ended and on one a
  press ended alike. That is the moment nothing else reports: the silence decides it, and by then the
  watch may be back at his side.
- The hub hearing no words in a clip buzzes `.failure`: nothing was enqueued.
- A finished command buzzes `.notification` — the one that makes a sound, so a reply arriving is heard
  as well as felt.

### The wrist can drop mid-recording

The watch declares `UIBackgroundModes: audio` (in `project.yml`) — that key, not `WKBackgroundModes`,
which takes only session types. A recording can only START with the app in front; once running it
continues behind the watch face with the microphone indicator showing, so a command still ends at its
silence with the wrist down. Not yet confirmed on the device: `TODO.md` § Watch: does a recording
survive the wrist dropping.

### Sending it

A command is sent the way the phone's microphone sends one: `Hub.sendAudio` uploads the file to
`/api/voice-command` (source `web`), the hub transcribes it with the same Groq Whisper, and the worker
treats it as push-to-talk — no addressing gate, no duplicate-drop, no spoken reply on the TV. The hub
answers with the transcript, shown until the turn lands, and the request id, and the watch waits on
`/api/voice-reply/:id`. No id means the hub heard no words. **With the wrist down the app is kept running until
a home command's answer is in** (`StayAwake`): recording keeps a watch app alive, but once the command
is sent nothing did, so the app was suspended mid-wait, the answer's tap never came, and the screen
still showed the command working when he looked. `StayAwake` plays silence, mixed with others, while
`Chat.waiting`, and lets go the moment nothing is; anything that turns the audio session off (a
recording ending, a spoken reply finishing) calls `sessionReleased()` so it restarts over a live session.
Home commands only: a session can work for minutes, and he does not want the battery spent on that. And **one minute at most per wait** (his number): if the answer has not come by then it lets go,
and nothing restarts it until nothing is waiting. It
does not make the dimmed screen redraw faster (watchOS caps that at about once a second, which is why
the edge is a steady ring wrist-down); it keeps the app working so the answer lands on time. A connection lost during that wait is asked
again with backoff (`Hub.outcome`), never shown as a failure: the command is with the hub already, and a
lowered wrist suspends the app and kills the open request, which used to read "The request timed out"
over a command that had finished.

**Recording sets `voice_muted`**, as the phone's microphone does, so the Mac and the ESP do not
enqueue the same sentence a second time. The flag has no expiry, so every way out of a recording
(send, Cancel) writes the unmute, and the writes are chained so an unmute cannot land ahead of its
mute.

**Retry.** The clip is kept until its command has run, and the `client_msg_id` across a Retry, so a
resend after a dropped connection gets the first send's id back instead of running twice. Once the id
is known, Retry only waits again; after a worker error it uploads the clip as a new attempt. **Cancel
while waiting stops waiting — a command the hub already has still runs.**

### A control per page

Control Center, the Smart Stack and an Ultra's Action button each hold **Hub · Listen · Speak · Sessions · Nutrition ·
Workout**, which open the app on that page (`OpenPageIntent` → `Router` → `RootView`); Nutrition and Workout
land on the day page opened straight into a full list (`Router.dayList`): today's food log, or the
exercise list. Every control closes an open session first: a session is pushed over the whole row of pages, so
turning the page beneath it would leave the session on screen. Hub (the mic control; `RecordControl` in the code) is the odd one out: it opens home AND starts a command. It is labelled Hub because it sends a command to the hub — a recording is only how.
Each control is its own type, spelled out in full — the `kind`, title and symbol are literals, because
Control Center reads them before the extension runs and a computed one is not there to read.

**Blank tiles — no name, no icon, on every one of the app's controls — are a stale cache on the watch,
not the code.** Deleting the app from the watch and reinstalling it clears it. It is worth knowing
before debugging: the controls still register correctly (the simulator log shows `query returned …
controls` for every kind) and the same control draws normally in the Smart Stack, and a build that is
byte-identical to one that worked (files, plists, entitlements, asset catalog) still shows blank tiles
until the reinstall. Toggling Low Power Mode, the fix circulating for watchOS 26, does not clear it.

**Speak is a real toggle, filled while on; Listen is a button that opens the app.** Control Center draws
a control from the extension, a separate process, and this account cannot enable App Groups, so the two
share a KEYCHAIN access group instead (`SharedState`, declared on both targets in project.yml, as the
iPhone app does with its widgets). The app mirrors `session_speech` and the hub token there; Speak's
`ControlValueProvider` reads the one to draw itself, and its `SetSpeechIntent` writes the flag and the
hub setting from whichever process runs it. The app asks Control Center to redraw
(`reloadControls`) whenever the value changes, including when the hub's copy changes. Listen stays an
`OpenIntent` because the microphone can only run in the app; it turns always-on listening on or off,
which then carries on with the wrist down (background audio), and the blue edge shows it.

### Spoken replies

With `session_speech` on (the Speak control, or Settings → Watch: speak session replies on the phone), a reply to a
follow-up SENT FROM THE WATCH is read aloud (`Speaker`, the system voice — nothing leaves the watch), and
every follow-up carries `Sessions.spokenFormat` so the reply is written to be heard. **It is spoken when
that session is on screen with its reply in hand**: as it lands if he is looking at it, otherwise the
next time he opens it (the reply notification, the list, or raising the wrist with it open). The debt is
`Sessions.owed`, kept in UserDefaults because the app is usually closed by the time the answer comes;
it is paid once, and dropped if speech is off when the session is opened. A watch app cannot start
speaking with the wrist down, which is why opening is the trigger rather than the reply's arrival. Only
those replies: a session answering something typed on the Mac is not spoken. **The always-on listener
stands aside while it speaks** (`Capture.hush`), so it does not transcribe the watch's own voice, and
takes the microphone back when it finishes — paused, not switched off. Starting a recording stops the
speaking at once. The setting is on the hub so the phone shows the same switch; the watch reads it when
it comes to the front.

### Two launchers, one request

The complication (circular and corner) opens `statushub://record`. The Record control
(`RecordControl`, watchOS 26 — Control Center, the Smart Stack, and the Action button on an Ultra)
runs `RecordIntent`, an `OpenIntent`, which launches the app and runs `perform()` in it: the file is
compiled into both targets, and `WATCH_APP` gates the app-only call. Both set `Chat.recordRequested`;
the app switches to home and records as soon as it is active. The page that acts on the request is
whichever is showing (`recordsWhenAsked`, which checks `onScreen`), so two pages cannot both start
one.

Without an Action button, the no-touch path is the Smart Stack: with Settings → Gestures → Double Tap →
Smart Stack set to Select and Record pinned, two double taps from the watch face open it recording
(verified on watchOS 26.5). An app holding a workout session (Watchset while it captures)
sits above even pinned items.

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

**Siri, a call or another app recording takes the microphone**, and no recording survives that. The
interruption notification is what says so (`Recorder.onInterruption`): words already recorded are sent
(`onTaken`, which every caller passes), a listener utterance that had begun goes up, and when the
microphone comes back listening picks it up again. Without that handling always-on listening ended at
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
view on the top of each new thing. A tap in the bottom half of the glass records on both.

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
| `thread`, `detail` | what a page loaded |
| `control` | a press of the bottom control, with its mode |
| `record` | a finger tap on the text |
| `record-refused`, `mic-refused`, `mic-failed`, `mic-open` | why a recording did or did not start |
| `mic-end` | what the endpoint saw when a recording ended, and why (`silence`, `unspoken`) |
| `mic-lock` | the lock toggled |
| `listener-sent`, `listener-failed` | an always-on utterance going up |
| `sent`, `send-failed` | a command's clip going up, with how long it took |
| `listen-alive` | always-on listening still has the microphone, with minutes since it was engaged — one line per twenty silent segments, about five minutes. **This is how long watchOS lets it hold the microphone with the wrist down**, which is otherwise unknown: read the gap between the last line and when it was engaged |
| `stream-open`, `stream-end`, `stream-error` | the event streams |
| `resend` | a call's connection dropped mid-flight and it was sent again |
| `frame` | each stream frame for the session on screen |

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
