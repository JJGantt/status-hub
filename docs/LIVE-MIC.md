# Live mic

The phone's microphone, streamed through the hub to the watch, which plays it live. Leave the phone
in a room, walk away, and the watch hears the room.

    phone (LiveMic.swift) ──WebSocket──▶ hub (lib/livemic.js) ──one long HTTP response──▶ watch (LiveListen.swift)

Delay end to end is about half a second to a second: the hub hands a joining watch its last quarter second,
and the watch gathers a quarter second before it plays.

## The phone

`apps/Sources/LiveMic.swift`, started and stopped from the **Stream** button at the top of Utilities
(`server/public/cards/livemic.js`, the `liveMic` message handler in `StatusHubApp.swift`). The card
removes itself in a plain browser, where there is no app to ask.

- **Native, not the page's microphone.** WebKit stops a page's capture as soon as the app leaves the
  screen. The app declares background audio (`UIBackgroundModes: audio` in `project.yml`), and a
  recording app is kept running with the phone locked. It must be STARTED with the app on screen:
  iOS will not let a backgrounded app turn the microphone on.
- **The capture survives the network.** A dropped socket reconnects with backoff (1s doubling to 30s)
  while the microphone stays on; what it hears in the gap is held (up to the hub's five minutes) and
  sent first when the socket opens, so the hub's copy has no hole. A call or Siri stops the engine, and it restarts when the interruption ends.
- The card shows the state the app reports (`hub:livemic`) and how many watches are listening, which
  the hub sends down the socket whenever it changes.
- It sets the shared audio session to `.playAndRecord` for as long as it streams. A voice command from
  the hub page while streaming is untested.

### Room, not voice

`.default` mode: the whole room, unprocessed. `.voiceChat` (voice processing: echo cancellation, noise
suppression, gain control) treats music and effects as noise and cuts them, which defeats the point of
a phone left in a theatre. Whether to offer a Voice mode as well is open (`docs/TODO.md`).

## The hub

`server/lib/livemic.js`. In memory, nothing stored. The phone's socket is `/api/live-mic/up`
(checked against the same token as everything else, in the upgrade handler, since an upgrade never
reaches Express's gate); a watch reads `GET /api/live-mic`.

- **One phone at a time; the newest wins**, so a phone reconnecting replaces its own stale socket.
- **It keeps the last five minutes** (`RING_MS`, about 1.2MB), numbered, across phone reconnects, so a
  watch that loses its connection resumes where it left off instead of at the live edge. A fresh
  listen is handed only the last quarter second (`RECENT_MS`).
- **It relies on the hub being ONE machine** (`fly.toml`). A second machine would put the phone and the
  watch in different processes and nothing would reach the watch.
- **A zero-length packet every 2s on each listener is a heartbeat**: the watch counts 5s with no bytes
  as a dead connection and reconnects. Without it a connection left silent (not failed) by the move
  from the phone's Bluetooth to the watch's LTE would sit until URLSession's 60s timeout. A ping every
  15s keeps Fly's proxy (60s idle) from closing the phone's socket between streams.

**Wire format, both directions:** a run of packets, each a 2-byte big-endian length followed by one
AAC-LC packet (24 kHz, mono, 1024 frames, ~32 kbit/s, about 15 MB an hour). Zero length is a
keepalive. Each WebSocket message holds whole packets, so the down stream is those messages
concatenated. A watch asking `?seq=1` also gets, after each message, the length `0xFFFF` and an 8-byte
big-endian sequence number for it, and resumes with `&after=<the last one>`. Numbers start at the
process's start time in milliseconds, so a restarted hub's are above any it handed out before and a
resume from one starts fresh.

## The watch

`apps/Watch/LiveListen.swift`, the rightmost page. One control: ear to listen, red stop to end it, the
crown as the volume while it plays.

- **HTTP, not a WebSocket.** watchOS refuses WebSockets on every network; a long response read with
  `Hub.stream` works on Bluetooth-through-the-phone, Wi-Fi and LTE alike.
- **It holds the microphone and discards what it hears**, which is what keeps a watch app running
  with the wrist down. A watch app that only plays is frozen when the wrist drops (`Speaker` has the
  measurement).
- **The buffer adapts.** It starts at a quarter second (Jared's number, for the shortest delay). Each
  time it runs dry it rebuilds to the next level, half a second then one, so one bad patch costs one
  gap and the larger cushion covers the next. A minute with no gap steps it back down a level.
- **Behind the level, it plays fast at the same pitch** (`pace`, `Stretch.swift`): 20% fast while two
  seconds or more behind, easing down in proportion to 3% as it closes in, until it is back. A 14s
  drop is caught up in about a minute and a half. It never skips audio. Speed-up without a pitch rise
  is done in software (WSOLA, 20ms frames) because watchOS has none: `AVAudioUnitTimePitch`,
  `AVAudioUnitVarispeed` and the mixer's `rate` are all unavailable there, and a plain resample at 20%
  lifts voices about three semitones.
- **The pace is decided as audio is handed to the player, not as it arrives.** Decoded audio waits in
  `backlog` and `feed` keeps only 0.15s scheduled, because a buffer's speed is fixed once scheduled: a
  reconnect's whole backlog scheduled on arrival would all play at the pace of that moment.
- `RECENT_MS` on the hub matches the starting level: whatever the hub hands a joining watch is delay
  it starts with.
- **What a switch costs, measured:** the stream died 33s in (`-1005`, connection lost) and reopened 14s
  later, because the watch waits until its new route is up before it reconnects (the first retry is
  immediate; only repeated failures back off); the 3s already
  queued covered the start of that, so about 11s were silent.
- **Why there is a switch at all:** watchOS routes an app's traffic through the phone while it is in
  Bluetooth range, then Wi-Fi, then its own LTE, and an app cannot choose. A connection opened through
  the phone dies when the phone goes out of range and is reopened over LTE. Start listening once away
  from the phone and there is no switch.
- **A stalled output is restarted and its backlog dropped.** Taking AirPods out can leave the engine
  running and the player scheduled while nothing comes out, with no notification; the stream keeps
  arriving and queues behind it, and when the output wakes it plays the whole backlog minutes late
  (stale audio nobody wants). So a packet that arrives while playing,
  with no buffer finished for 2s, restarts the audio (`live-listen-restart`, `why: stalled`, with the
  seconds that were `queued` and whether the engine claimed to be `running`).
- **A reconnect loses nothing** (`lastSeq`). What was queued plays on while it reconnects, the hub
  sends everything after the last whole message the watch got, and packets of a message it had
  partly received are skipped (`partial`) rather than played twice. The delay grows by the length of
  the drop and the catch-up takes it back. Walking out of the phone's Bluetooth range drops the
  connection while the watch moves to its own LTE, so expect the delay to jump there.
- It takes the microphone from the always-on listener (`Capture.hush`) and gives it back when it
  stops. Starting a recording or a spoken reply stops it.
- **It is the Now Playing app while it listens**, taking every remote command (play, pause, skip) and
  doing nothing with it. Without that, AirPods' ear detection sent play to Music, which started
  playing on the watch, took the audio session, and the live mic could not get it back.
  `NWPathMonitor` is not used to tell the route: on the watch it reported `unsatisfied` while the
  stream was flowing.
- **AirPods connected to the watch play it** (`.allowBluetoothA2DP`). A2DP is output only, so the watch's
  own microphone is still the one held. Untested on the device.

## Reading what happened

Both apps log to the hub's `client_log` table (`src` = `watch` / `phone`):

| ev | says |
|---|---|
| `live-listen` | watch on/off, with the audio outputs |
| `live-listen-conn` | how one stream connection reached the hub, from its metrics when it ends: `cellular`, `proxy` (through the phone), `secs` |
| `live-listen-remote` | an AirPods play/pause command, taken and ignored |
| `live-listen-error` / `-open` | the stream dying, and reopening with `gap_ms` since it died and whether it `resume`d |
| `live-listen-missed` | a resume the hub could not fully cover (past its five minutes, or it restarted): `messages` lost |
| `live-listen-dry` | the watch ran out of audio and is gathering again, with the `buffer` (seconds) it now gathers |
| `live-listen-buffer` | a minute without a gap stepped the buffer down; `buffer` is the new level |
| `live-listen-route` | audio output changed (AirPods in or out) |
| `live-listen-restart` | the audio engine restarted under it: `why` (`config-change`, `interruption`, `media-reset`, `stalled`), `queued` seconds dropped, `running` |
| `livemic*` | the phone: on/off, `socket-open` / `socket-ended`, `listeners`, `interrupted`, `restart` |

The hub also prints `live-mic:` lines when the phone and each watch come and go (`fly logs`).

## Verified, and not yet

The encoder and decoder round-trip on the Mac (a 440 Hz tone in, 440 Hz at the same level out), and
the relay was exercised locally with a fake phone and watch. Not yet measured on the devices: AAC
decoding on the watch itself, and a long stretch on LTE with the wrist down.
