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

Four, swiped left to right: **sessions · home · nutrition · workout**. The app opens on home, which
IS the conversation — there is no separate prompt page.
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

The thread ends in most of a screen of empty space, which is what lets the newest thing in it rise to
the top: a scroll view stops at the end of its content, and on a short thread that leaves the
transcript stranded mid-screen. The view holds that spot through the laying out that follows (`pinned`)
until he scrolls himself.

A tap anywhere on the conversation is the same press as the control. The page carries nothing else: no
second indicator of a state the control already holds, and a failure is the one thing it adds — an
icon and Retry under the thread, since a command that failed has nowhere else to be picked up.

**The system's clock is left alone.** watchOS puts the time in the top right of every app and nothing
hides it — the invisible-`VideoPlayer` trick that is passed around does nothing on watchOS 26.5,
measured four ways: as a background, as a full-size overlay at 0.001 opacity, with a real looping clip
playing, and visible at full opacity behind the content. A `ToolbarItem` does move it, but to the LEFT
of the strip rather than the middle, so the page draws no clock and puts nothing in the toolbar.

### The sessions page

Lists `/api/sessions` one row per conversation — running first, then parked, most recently active
first within each, the order `n` counts in — and follows `/api/session-stream`. Each row is its name
over up to three lines of what it last said: the list's `say`, which the hub already cuts to 120
characters, drawn smaller and grey with its markdown's bold and code dropped.

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

A tapped row opens its session on top of the whole row of pages (the `NavigationStack` is `RootView`'s,
around the `TabView`), not inside the sessions page: there the page row took sideways swipes and the
watch's own swipe back never fired. The session has no title bar.

**A session opens on its newest answer.** The page draws the last `SessionDetail.exchanges` (5)
prompts with every reply under each — a session can report more than once without being asked again, a
watcher firing or a job finishing — and lands with the top of the newest reply at the top of the
screen, since the answer is what he opened it for. The history above it costs nothing once the landing
is right.

**Its name is on the clock's line and there is no back arrow.** A leading `ToolbarItem` leaves the time
where watchOS puts it (a trailing one moves the clock to the other end of the strip); the swipe that
opened the session from the right takes it away again, so a title bar with a button in it would cost
the top of the screen for nothing.

**A long reply creeps down on its own** while he is reading it (`PagedScroll.creep`), at
`watch_reading_wpm` in the hub's settings — words a minute, 0 to leave the page still. A line of reply
text is about five words at 13pt and a line about sixteen points tall, so the speed is those points a
second: 200 wpm, ordinary silent reading, is a line every second and a half. It waits two seconds
before moving, because a reply lands on its first line and is read from there, and the distance is
measured AFTER that beat — the page lands on its newest reply during it, and a distance measured
before the landing crawls at a fraction of the speed asked for. **It moves only while he is looking**:
the wrist dropping dims the screen (`isLuminanceReduced`) and stops it, the app leaving the front stops
it, and his finger or the crown ends it until the session is opened again.

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
conversation's next `done`. **A follow-up ends only on a press** — it has no silence endpoint and no
lock.

**A session's reply notification opens it.** `WatchAppDelegate` registers the `SESSION_REPLY`
category with one foreground action, Open — the button double tap presses on a watch notification —
and answers it, or a tap on the notification itself, with `Sessions.open(rowId:)`: the app lands on
the sessions page with that conversation pushed (`Sessions.path`), a row the list has not loaded yet
(a resumed session's new one) included, and it fetches that conversation's reply itself. Left to the
view's own load the reply stays old: a conversation already on screen does not appear again, and an
app in the background misses the stream's `done`. The category is registered at launch, so the watch
app has to have run once for the button to appear.

### The nutrition page

The hub nutrition card's four pace rings (no produce rings) over today's log. The rings are
`cards/nutrition.js`'s SVG redrawn in a Canvas to the same geometry and colours. The card recomputes
them every second from the browser clock; the watch instead takes `/api/rings`'s per-minute frames and
blends between the two either side of now each second. Between two minutes the arcs, both ticks and
the deviation number all move linearly, so the blend reproduces the card's drain without a copy of
`lib/pace.js` in Swift. Colours come from a frame, never derived. This is why a frame's `frac` is sent
to four places: at two it moved the tick in ~8-minute jumps.

The watch compiles `Controls/RingsView.swift` for the `/api/rings` types and the palette; the widget's
own views in it go unused. The log is `cards/nutritionlog.js`'s day list (band, then entries newest
first, staged on top), display only, with the chips wrapping instead of scrolling (`Flow`).

### The workout page

The home wall's `#resttimer` (Last set · Session · Sets, ticking each second off naive wall-clock
digits exactly as `workouts.js` does) over every exercise logged today, each drawn as the wall's
`data-recent` row — the one a set just went onto at the top, the rest scrolling below — fed by
`/api/workout-now`.

The strip stays one line as on the wall, stepping smaller, and wraps only when one line would be
unreadable; on a 44mm screen that is always. A set row does the same (16pt down to 9, then eliding
repeated weights) and wraps as its last step, since five sets at a three-digit weight fit no single
line there.

- **Nothing on this page may report a width wider than it was offered.** The ScrollView lays its
  content out again at the width the content reports, so one overflowing row widens every row on the
  page past both edges of the glass. `Flow` offers an item wider than a line (a long exercise name)
  the line's width for that reason.
- **The size steps are ONE `ForEach` inside `ViewThatFits`.** ViewThatFits traps on duplicate child
  ids, and two ForEach over the same sizes give each size twice — the page crashed the moment it drew
  an exercise.

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

A command recorded from home ends itself once he has spoken and then stopped: `Chat.startRecording`
passes `onSilence`, and a session page does not.

`Endpointer` (in `Capture.swift`) is the phone's always-on rule (`makeListener` in `voiceagent.js`):
the floor is the quietest buffer so far, speech is 2.5x above it and at least 0.02, and once speech has
been heard, `watch_silence_s` below that line ends it exactly as a press would. The setting is under
Trailing silence in the hub's Settings; unset, it is 2 seconds. It is read at every start and kept for
the next, since a start does not wait on the hub.

**Nothing ends before speech crosses the line**, and a recording whose speech never registers is
never cut short mid-sentence. That is what keeps it clear of the failure that made the phone's buttons
press-only (`VOICE-ON-THE-PHONE.md`): a VAD that cut commands mid-sentence and threw away clips it
judged silent.

**One buffer over the line is not speech.** Speech has to last `Endpointer.minSpeech` (0.4s), unbroken
by a hang of quiet, before the utterance counts as begun. Without that a single blip of room noise
arms the endpoint, which is how a recording nobody spoke into ran 88 seconds on his watch, ended on a
peak of 0.021 against a 0.02 line, and went up as "Thank you. Thank you." — what Whisper writes for
silence, which the worker then ran as a command.

**A recording nobody meant to start is closed.** Two caps, both skipped while the recording is locked,
because holding one open through anything is what the lock is for:

- `Capture.unspoken` (15s of audio with no speech in it) — nobody is talking to it.
- `Capture.longest` (60s unlocked) — the silence ends a real command in a couple of seconds, so one
  still running heard speech the whole time without a gap: a room, a television, a conversation.

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

**Cancel is a red x on the bottom row**, in the corner beside the control, drawn by `BottomControl`
itself so it is the same mark in the same place on every page — home and a session alike. It is there only while there is something to throw away: the recording, or the command the hub
is still working on. The control at the bottom edge carries the recording: it is an open lock while recording, a closed
lock once locked, and pressing it walks that on — record, lock, send. Double tap is the same press, so
the three states are one gesture repeated. A finger tap on the conversation text presses it too, and
Cancel throws the clip away.

The lock holds the recording open through any silence; a follow-up has no silence endpoint, so its
control is a mic and then a stop, with no lock in between.

### Haptics

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
`/api/voice-reply/:id`. No id means the hub heard no words.

**Recording sets `voice_muted`**, as the phone's microphone does, so the Mac and the ESP do not
enqueue the same sentence a second time. The flag has no expiry, so every way out of a recording
(send, Cancel) writes the unmute, and the writes are chained so an unmute cannot land ahead of its
mute.

**Retry.** The clip is kept until its command has run, and the `client_msg_id` across a Retry, so a
resend after a dropped connection gets the first send's id back instead of running twice. Once the id
is known, Retry only waits again; after a worker error it uploads the clip as a new attempt. **Cancel
while waiting stops waiting — a command the hub already has still runs.**

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
(verified on an SE 3, watchOS 26.5). An app holding a workout session (Watchset while it captures)
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

**Double tap always starts a prompt.** Every page has one control at its bottom edge
(`BottomControl`) and it holds the gesture (`handGestureShortcut`, live only while its page is the one
showing — two live bindings leave the system to pick). It is a mic that records and a stop that sends,
and on home it is also the state glyph. It never hides.

**It is the only binding, in every state.** A command's three steps — start, lock, send — are three
presses of this one control, so nothing hands the gesture anywhere and nothing can hold two bindings
at once.

**Scrolling is a finger or the crown, never the gesture.** The control used to page the view down
while anything was below, and hand the gesture to recording only at the bottom; that is gone, along
with the scroll-geometry machinery it needed. What it cost is worth knowing, because it is why nothing
here should measure a scroll view again: the same scroll view reports its geometry in two frames
depending on how it was last moved, so the maths was right in one and wrong in the other, and on his
watch the geometry went on reporting content below after the view had stopped at its end — so every
double tap asked for a scroll that could not happen and recording never got the gesture at all.

A session's page scrolls through `PagedScroll` (`Watch/WatchUI.swift`), which is the control over a
scroll view and nothing more; home has its own scrolling, because it is the one page that lands the
view on the top of each new thing. A tap on the text records on both.

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
- `-autopage chat|session` stands in for double tap every two seconds;
- `-opensession <row id>` opens a session as its notification would;
- recording and stopping never reach the hub (`blockInSimulator` in `Hub.swift` — a test tap once sent
  a stray "you" into his conversation) and never mute the room mics.

The built app needs `WKWatchOnly` and no `WKCompanionAppBundleIdentifier` (then an ad-hoc `codesign`)
to install on an unpaired watch simulator. **One watch simulator is kept on this Mac** — a Series 11
46mm, the largest this runtime offers — because each device costs over a gigabyte of disk. Screenshots
are that geometry; a 44mm screen is narrower, and a row that fits here can still overflow there.

- **The simulator is watchOS 26.5 and his watch is 27**, so what a simulator proves about layout is
  not proof about his watch, and a system behaviour measured here (what hides the clock, how a gesture
  resolves) can differ there. Installing the 27 runtime is a multi-GB download this disk cannot take.
- **Do not click the Simulator window with System Events**: that moves his pointer. Reach a state
  with a launch argument instead; the simulator cannot make a double tap either way.
- **A recording in the simulator records from the Mac's microphone.** Test the silence endpoint by
  feeding `Endpointer` levels, never by playing sound into the room — the Mac's own always-on mic hears
  it too.
