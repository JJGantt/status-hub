# The watch app

`StatusHubWatch`: a watchOS 11+ app (`apps/Watch/`, bundle `com.jaredgantt.statushub.watch`) embedded
by the iOS app, plus its widget extension `StatusHubWatchWidgets` (`apps/WatchWidgets/`,
`com.jaredgantt.statushub.watch.widgets`) — the complication and, on watchOS 26, the Record control.
It is native SwiftUI, not a web view: watchOS has no WKWebView. It talks to the hub directly with a
token the phone hands over.

## Shipping it

**It ships inside the iOS app**, so it reaches the watch with a TestFlight build of the app
(`gh workflow run ios-testflight.yml`), installed when the phone updates. Do not install a local build
of the iOS app to try the watch: that build cannot receive push (`CLAUDE.md`). How to prove the Swift
compiles on this Mac, with or without a simulator runtime, is in `CLAUDE.md` § Checking the Swift
compiles.

The sessions list ends with the build number (`CFBundleVersion`, which CI sets to the TestFlight
build), so a fix that has not been installed is not mistaken for one that failed.

## Pages

Four, swiped left to right: **sessions · prompt · nutrition · workout**. The app opens on the prompt.
`RootView` in `StatusHubWatchApp.swift` holds them in a paged `TabView` inside a `NavigationStack`.

A page loads when it comes on screen and holds its event stream open only while it is showing
(`follow()`), reloading after every reconnect, since a change may have gone by. `Hub.listen` reads all
three streams; every frame the hub sends has a `data:` line, keepalives included, and that is what it
dispatches on.

Every page stays alive side by side in the TabView, so anything that binds double tap or acts on a
request asks `onScreen` (an environment value `RootView` sets per page) first.

### The prompt page

The shared hub thread on black — `/api/voice-messages?focus=hub&mode=active`, the same
current-context thread the phone and the TV show, in whichever mode `agent_mode` selects, newest 40
rows. It follows `/api/voice-stream`: a `message` frame reloads the thread, and the worker's
`activity` frames draw the running command's tool calls under it, and what the model says between
them in full, in plain text rather than the tool calls' grey monospace (`ActivityLines`). The hub
stores none of those, so they show only while the page is watching and clear when the next command
starts (`working`) or this one ends (`done`).

A reply is read from its top: the page scrolls the newest reply's top to the top of the screen and
holds that spot (`pinned`) from the moment the app opens or comes back to the front until he scrolls
or pages, re-aiming on every change in the content's height — a single jump on a cold launch lands
short while the thread is still laying out.

Recording from it is § Recording a command. Thread rows are their own view (`ThreadRow`) so SwiftUI
skips re-parsing their markdown when the page rebuilds.

### The sessions page

Lists `/api/sessions` one row per conversation — running first, then parked, most recently active
first within each, the order `n` counts in — and follows `/api/session-stream`. Each row is its name
over up to three lines of what it last said: the list's `say`, which the hub already cuts to 120
characters, drawn smaller and grey with its markdown's bold and code dropped.

A tapped row opens its session on top of the whole row of pages (the `NavigationStack` is `RootView`'s,
around the `TabView`), not inside the sessions page: there the page row took sideways swipes and the
watch's own swipe back never fired. The session has no title bar.

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

A command recorded from the prompt page ends itself once he has spoken and then stopped:
`Chat.startRecording` passes `onSilence`, and a session page does not.

`Endpointer` (in `Capture.swift`) is the phone's always-on rule (`makeListener` in `voiceagent.js`):
the floor is the quietest buffer so far, speech is 2.5x above it and at least 0.02, and once speech has
been heard, `watch_silence_s` below that line ends it exactly as a press would. The setting is under
Trailing silence in the hub's Settings; unset, it is 2 seconds. It is read at every start and kept for
the next, since a start does not wait on the hub.

**Nothing ends before speech crosses the line, and the endpoint never discards anything.** A
recording whose speech never registers simply waits for the press. That is what keeps it clear of the
failure that made the phone's buttons press-only (`VOICE-ON-THE-PHONE.md`): a VAD that cut commands
mid-sentence and threw away clips it judged silent.

Every end logs `mic-end` with the numbers it decided on (floor, threshold, peak, hang, seconds of
audio). Tune the multiplier or the minimum from those, not by feel.

### The recording bar, the lock, and double tap

While a command records, the page shows two buttons of one size: the **lock** on the left and
**Cancel** on the right (`RecordingBar`). The stop control at the bottom edge is what says a recording
is under way; there is no timer. On a recording with no silence endpoint (a session follow-up) there
is no lock, and Cancel keeps its place with the left half empty.

The lock holds the recording open through any silence. **Double tap walks three states**: the first
starts the recording, the second locks it, the third sends it. While a command records unlocked,
double tap belongs to the lock (`Capture.lockHoldsDoubleTap`); once locked it returns to the bottom
control, which sends (§ Double tap and scrolling). A finger tap on the text or the stop sends at any
point; Cancel throws the clip away.

### Haptics

- A command the **silence** sent taps the wrist (`.success`) once the hub has enqueued it, since no
  press told him it went. A pressed one does not.
- The hub hearing no words in a clip buzzes `.failure`: nothing was enqueued.
- A finished command buzzes `.notification`.

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
the app switches to the prompt page and records as soon as it is active.

Without an Action button, the no-touch path is the Smart Stack: with Settings → Gestures → Double Tap →
Smart Stack set to Select and Record pinned, two double taps from the watch face open it recording
(verified on an SE 3, watchOS 26.5). An app holding a workout session (Watchset while it captures)
sits above even pinned items.

### The always-on listener — built, not reachable

`Capture.listen` / `unlisten`, with nothing on screen calling them yet. It is the phone's always-on
mode on the wrist: the recorder runs continuously and `Recorder.cut` swaps the file inside the tap, so
no sample falls between two utterances. Each utterance goes up as source `watch` with its own
`capture_start` / `capture_end`, which is what lets the worker collapse it against the Mac or the ESP
hearing the same sentence (`LISTENERS.md`). A segment nobody spoke in is dropped at 30s of audio and
never uploaded, because Whisper invents a sentence for silence. It mutes nothing: it is a peer of the
room mics, not a command someone is holding the watch to say. Each utterance the hub enqueues taps the
wrist (`.success`); one it heard no words in taps nothing. Uploads are fire-and-forget, with no outbox
behind them yet.

## Double tap and scrolling

Both conversation pages (the prompt and a session) scroll through one component, `PagedScroll`
(`Watch/WatchUI.swift`), so paging, the bottom and the double-tap handover cannot differ between them.
It owns the scroll state and hands its page only `atBottom`, which flips a few times a scroll: a page
holding the per-frame state itself rebuilds its whole thread every frame of a page, and stutters.

**Each page has one control at its bottom edge (`BottomControl`), and it holds double tap**
(`handGestureShortcut`, live only while its page is the one showing — two live bindings leave the
system to pick). It pages down while more is below (a chevron; text fades out of a 28pt strip under
it, and a page moves the last line showing above the strip to the top edge of the screen), records at
the bottom (a mic in the same spot), and sends while recording (a stop). It never hides. The control
sits 9pt up, clear of the page dots, which change page when tapped. A finger tap anywhere on the text
still records.

**It gives the gesture up in exactly one state**: a command recording that the silence would end and
that is not locked, when the recording bar's lock holds it. `Capture.lockHoldsDoubleTap` is read by
both bindings, so they cannot both be live. That is the only handover, because handing the gesture on
BY POSITION fails: with the chevron vanishing at the bottom and the page-sized record button taking
double tap, a double tap there pressed the whole page, a tap where the chevron had been hit empty
space, and the view crept back up under his finger (his watch, through build 23). The lock is a small
button of its own, handed the gesture by recording state, not by where the view stands.

The paging math rests on things measured in the watchOS 26.5 simulator, all easy to get wrong:

- **The same scroll view reports its geometry in two frames** depending on how it was last moved.
  After a jump to a view (`ScrollViewReader`, which every open and pin uses) `visibleRect` is the safe
  area alone with zero `contentInsets`; after `ScrollPosition.scrollTo(y:)` it is the whole screen
  with the strips as insets. Math on `contentOffset` and the insets is right in one frame and wrong in
  the other: a short first page, the chevron drawn mid-screen, and a last page aimed where the view
  cannot go. `ScrollState` therefore keeps only the safe area's edges (`visibleRect` less the insets,
  the same in both frames), and the strips' height comes from the screen
  (`WKInterfaceDevice.screenBounds`). `scrollTo(y:)` puts y at the safe area's top, so a page's
  target is the new top edge plus the strip under the clock. The control is a full-height column that
  ignores the bottom safe area, which lands it on the physical edge in either frame.
- **Being at the bottom is not read from the scroll geometry at all.** On his watch (not reproducible
  in the 46mm simulator) the geometry kept reporting content below after the view had stopped at its
  end, so each double tap asked for a scroll that could not happen. A 1pt view after the last content
  (`scrollEnd`) reports where it really is on screen, and the page is at the bottom when that is
  within a line of the screen's bottom edge — true by construction whenever the view has stopped at
  its end.

## The token comes from the phone

The watch has no web view to sign in with and shares neither cookies nor Keychain with the phone.
`Sources/WatchLink.swift` reads the `hub` cookie from the web view's cookie store (falling back to the
Keychain password) and sends it as WatchConnectivity application context on activation, when the
watch app is installed (`sessionWatchStateDidChange` — context sent before that is refused), and on
every cookie change. The watch keeps it in its own Keychain and, whenever it has none, asks with a
message, which wakes the phone app in the background. A 401 drops the stored token and asks again.

## It logs what it does to the hub

`Hub.log` posts to `/api/clientlog`, which prints one `[clientlog]` line per event:
`fly logs -a jared-status-hub | grep '"src":"watch"'`. Read it before guessing at a report from the
wrist. Fly keeps only the recent lines, so read it soon.

| event | what it says |
|---|---|
| `thread`, `detail` | what a page loaded |
| `page`, `paged`, `bottom` | the scroll state around each double tap |
| `control` | a press of the bottom control, with its mode |
| `record` | a finger tap on the text |
| `record-refused`, `mic-refused`, `mic-failed`, `mic-open` | why a recording did or did not start |
| `mic-end` | what the silence endpoint saw when it ended a recording |
| `mic-lock` | the lock toggled |
| `listener-sent`, `listener-failed` | an always-on utterance going up |
| `stream-open`, `stream-end`, `stream-error` | the event streams |
| `frame` | each stream frame for the session on screen |

## Running it in the simulator

The real app runs in a watchOS simulator against the live hub. Simulator-only code, compiled out of
device builds:

- the token comes from `SIMCTL_CHILD_HUB_TOKEN` (the kiosk's, sent as `?token=`);
- `-autopage chat|session` stands in for double tap every two seconds;
- `-opensession <row id>` opens a session as its notification would;
- recording and stopping never reach the hub (`blockInSimulator` in `Hub.swift` — a test tap once sent
  a stray "you" into his conversation) and never mute the room mics.

The built app needs `WKWatchOnly` and no `WKCompanionAppBundleIdentifier` (then an ad-hoc `codesign`)
to install on an unpaired watch simulator. Use an SE 3 device type for his watch: the 46mm geometry
differs.

- **Do not click the Simulator window with System Events**: that moves his pointer. Reach a state
  with a launch argument instead; the simulator cannot make a double tap either way.
- **A recording in the simulator records from the Mac's microphone.** Test the silence endpoint by
  feeding `Endpointer` levels, never by playing sound into the room — the Mac's own always-on mic hears
  it too.
