# Live mic

The phone's microphone, streamed through the hub to the watch, which plays it live. Leave the phone
in a room, walk away, and the watch hears the room.

    phone (LiveMic.swift) ──WebSocket──▶ hub (lib/livemic.js) ──one long HTTP response──▶ watch (LiveListen.swift)

Delay end to end is about two to three seconds: the hub hands a joining watch its last two seconds,
and the watch gathers a second before it plays.

## The phone

`apps/Sources/LiveMic.swift`, started and stopped from the **Stream** button at the top of Utilities
(`server/public/cards/livemic.js`, the `liveMic` message handler in `StatusHubApp.swift`). The card
removes itself in a plain browser, where there is no app to ask.

- **Native, not the page's microphone.** WebKit stops a page's capture as soon as the app leaves the
  screen. The app declares background audio (`UIBackgroundModes: audio` in `project.yml`), and a
  recording app is kept running with the phone locked. It must be STARTED with the app on screen:
  iOS will not let a backgrounded app turn the microphone on.
- **The capture survives the network.** A dropped socket reconnects with backoff (1s doubling to 30s)
  while the microphone stays on; what it hears in the gap is dropped, so the watch rejoins at the
  live edge. A call or Siri stops the engine, and it restarts when the interruption ends.
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
- **It relies on the hub being ONE machine** (`fly.toml`). A second machine would put the phone and the
  watch in different processes and nothing would reach the watch.
- **A zero-length packet every 2s on each listener is a heartbeat**: the watch counts 5s with no bytes
  as a dead connection and reconnects. Without it a connection left silent (not failed) by the move
  from the phone's Bluetooth to the watch's LTE would sit until URLSession's 60s timeout. A ping every
  15s keeps Fly's proxy (60s idle) from closing the phone's socket between streams.

**Wire format, both directions:** a run of packets, each a 2-byte big-endian length followed by one
AAC-LC packet (24 kHz, mono, 1024 frames, ~32 kbit/s, about 15 MB an hour). Zero length is a
keepalive. Each WebSocket message holds whole packets, so the down stream is those messages
concatenated.

## The watch

`apps/Watch/LiveListen.swift`, the rightmost page. One control: ear to listen, red stop to end it, the
crown as the volume while it plays.

- **HTTP, not a WebSocket.** watchOS refuses WebSockets on every network; a long response read with
  `Hub.stream` works on Bluetooth-through-the-phone, Wi-Fi and LTE alike.
- **It holds the microphone and discards what it hears**, which is what keeps a watch app running
  with the wrist down. A watch app that only plays is frozen when the wrist drops (`Speaker` has the
  measurement).
- **A second of audio before it plays, and again after running dry**, so a jittery link is a delay, not
  stutter. It does not catch up: a stall that queues audio adds to the delay until the next
  reconnect.
- **What a switch costs, measured:** the stream died 33s in (`-1005`, connection lost) and reopened 14s
  later, because the watch waits until its new route is up before it reconnects (the first retry is
  immediate; only repeated failures back off); the 3s already
  queued covered the start of that, so about 11s were silent.
- **Why there is a switch at all:** watchOS routes an app's traffic through the phone while it is in
  Bluetooth range, then Wi-Fi, then its own LTE, and an app cannot choose. A connection opened through
  the phone dies when the phone goes out of range and is reopened over LTE. Start listening once away
  from the phone and there is no switch.
- **A reconnect drops what was queued**, because the hub resends its last two seconds and they would
  otherwise play twice. Walking out of the phone's Bluetooth range drops the connection while the
  watch moves to its own LTE, so expect a short gap there.
- It takes the microphone from the always-on listener (`Capture.hush`) and gives it back when it
  stops. Starting a recording or a spoken reply stops it.
- **AirPods connected to the watch play it** (`.allowBluetoothA2DP`). A2DP is output only, so the watch's
  own microphone is still the one held. Untested on the device.

## Reading what happened

Both apps log to the hub's `client_log` table (`src` = `watch` / `phone`):

| ev | says |
|---|---|
| `live-listen` | watch on/off, with the audio outputs |
| `live-listen-path` | how the watch reaches the internet: `via` cellular / wifi / other (other is the phone's Bluetooth link) |
| `live-listen-error` / `-open` | the stream dying, and reopening with `gap_ms` since it died |
| `live-listen-dry` | the watch ran out of audio and is gathering again |
| `live-listen-route` | audio output changed (AirPods in or out) |
| `livemic*` | the phone: on/off, `socket-open` / `socket-ended`, `listeners`, `interrupted`, `restart` |

The hub also prints `live-mic:` lines when the phone and each watch come and go (`fly logs`).

## Verified, and not yet

The encoder and decoder round-trip on the Mac (a 440 Hz tone in, 440 Hz at the same level out), and
the relay was exercised locally with a fake phone and watch. Not yet measured on the devices: AAC
decoding on the watch itself, and a long stretch on LTE with the wrist down.
