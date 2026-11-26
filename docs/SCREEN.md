# The Mac's screen, live, on the phone

The whole Mac display streamed to the phone's session view and driven from it: a tap clicks, a long
press right-clicks, two fingers moving together scroll, typing goes straight to the Mac. It is a
session tab (`cards/repos.js`, kind `screen`), opened by the monitor button in the session bar, and it
is what a `mac-screen` or `mac-chrome` handoff shows (docs/HANDOFFS.md), with Done and Cancel still
ending the handoff.

## The path

1. The phone (`public/screen.js`) fetches ICE servers (`GET /api/screen/ice`), builds a receive-only
   video offer with a data channel `input`, waits for its relay candidate (at most 2 s; no trickle), and posts it
   (`POST /api/screen`).
2. The hub (`routes/screenshare.js`) inserts a `screen_shares` row carrying the offer and the Mac's own
   TURN credentials.
3. The Mac's screen agent (data-layer `src/screenAgent.ts`, inside the handoff agent's process) claims
   the row and starts `hands/bin/screenshare` (data-layer `hands/screenshare.swift`), which answers as soon as its own relay candidate is in (at most 2.5 s).
   The agent writes the answer back; the phone's held `GET /api/screen/:id?wait=20` is woken by the
   row's realtime update and returns it.
4. Media flows peer to peer, or through the TURN relay. Input comes back on the data channel and the
   helper posts it as CGEvents.
5. It ends when the phone closes the tab (it sends `bye`), when the connection fails or stays
   disconnected for 10 s, or if nothing connects within 30 s of the answer. The phone then posts its
   receiving counters (`POST /api/screen/:id/stats` → `phone_stats`); the agent records the Mac's
   sending counters (`stats`), the path, and why it ended.

## The Mac side

- **Capture**: ScreenCaptureKit, the main display, at its framebuffer's pixel size, up to 30 fps, cursor
  included. A still screen produces no frames, so the helper hands the newest frame over again after a
  second of stillness: without it the encoder has nothing to answer a key-frame request with, and the
  phone stays frozen after a lost packet.
- **Encode**: H.264 on VideoToolbox, through libwebrtc's default encoder factory. Browsers offer H.264
  at level 3.1, which caps a frame at 1280x720, and libwebrtc then sends **no video at all** for a
  larger display rather than a smaller one. The helper reads the offer's H.264 lines as level 5.2
  before applying it; every phone decodes that in hardware, and `level-asymmetry-allowed` makes the
  receiver's level the one that bounds the sender.
- **Degradation**: `maintainResolution`, so a tight link costs frame rate, not legibility.
- **Grants**: the helper runs as a descendant of `hands-launch`, which holds Screen Recording and
  Accessibility (data-layer README § Handoffs); nothing new is granted. Without Accessibility the
  picture still comes and every touch is dropped, logged once.
- **WebRTC framework**: Google's libwebrtc, the macOS slice of stasel/WebRTC, pinned in
  `hands/build.sh`, fetched into `hands/vendor` (gitignored) and copied beside the binary.
- **The firewall**: macOS asks once per build whether `screenshare` may accept incoming connections.
  Denying it still works in practice (every connection starts with an outgoing check from the Mac),
  but Allow keeps the direct path on the home network.

## The relay: `jared-turn` on Fly

coturn (`status-hub/turn/`), one shared-cpu machine in `iad`, dedicated IPv4 `169.155.63.221`. On the
same wifi the share goes direct (`host`); on cellular the phone usually cannot reach the Mac's NAT and
it goes through the relay. Listens on UDP and TCP 3478 and TCP 443; relay ports UDP 50000-50099.

- **Fly delivers UDP only to sockets bound to `fly-global-services`**, and replies must leave from
  that address, so `entrypoint.sh` binds the listener and every relay socket there and announces the
  public IP as its external address. Binding `0.0.0.0` starts cleanly and relays nothing.
- **Credentials** are coturn's REST scheme: username `<expiry>:<who>`, password its HMAC-SHA1 under
  `TURN_SECRET`, set on both `jared-turn` and `jared-status-hub` (and kept in `~/.config/turn/secret` on
  the Mac). The hub mints them per request, valid 12 hours; the relay keeps no user list.
- **The relay refuses private peer addresses**, so it cannot be used to reach Fly's own network.
- **Fly's TCP proxy connects to the machine's primary eth0 address**, not `fly-global-services` (a
  secondary address on the same interface), so the TCP listener is bound there as well; without it every
  TURN-over-TCP connection is refused.
- Deploy: `fly deploy` from `turn/`.

## Phone gestures

| gesture | on the Mac |
|---|---|
| tap | left click; two taps close together are a double click |
| long press (0.55 s) | right click |
| one finger drag | pans the picture; with **Drag** on, a mouse drag |
| two fingers spreading | zooms the picture |
| two fingers moving together | scrolls whatever is under them |
| typing in the box | each character as typed; the phone's delete key and ⏎ as keys. The box is reset to one invisible character, never to empty, because iOS sends nothing for delete in an empty box |
| a suggestion button (a handoff) | types that value on the Mac (his email, a card number the session gave) |
| ⌘ then a key or letter | that shortcut |

A drag that starts on the picture never swipes back out of the session: the session view's swipe-back
(`swipeBack` in `cards/repos.js`) ignores any touch that starts inside `.ho-stage`, which the handoff tap
screen and the live Chrome tab share. The picture's own `preventDefault` stops only the browser's
scrolling, not that handler.

## Measured

Through the live hub, Mac and browser on one network, 1280x800 display: the agent hears the row about
0.4 s after it is asked, answers at 1.2 s, connects at 1.8 s; the picture is on glass under 3 s after
the session opens. Encode about 4.5 ms a frame on VideoToolbox. Forced through the relay from the same
network: about 136 ms round trip, since both ends relay through `iad`; TURN over TCP 443 alone also
connects.

**The first share after a rebuild takes several seconds longer** (about 6.5 s to answer, measured):
macOS checks the newly signed binary and framework on their first launch. Every share after it is fast.

## Ending

A page torn down without Close (a deploy's reload, the app closing) sends `bye` on `pagehide`, so the
helper ends the share as `bye` rather than waiting ten seconds on a dead connection and reporting it failed.
A capture macOS stops on its own ("Stream was stopped by the system", which one share's helper tearing
down its capture can cause in another's) is started again; three stops within a minute end the share.

## Failures

- A share the Mac does not answer in 20 s is reported by the hub (the Mac asleep, its agent down, or
  its realtime channel deaf look alike).
- The agent reports any end that is not `bye`, `stopped`, `disconnected` or `closed`, and a helper that
  exits without saying why.
- The phone reports a share that never showed a picture (`console.error`, reported through
  `/api/clientlog`).
- The hub reports a share whose time to first picture is over three times the median of the last
  twenty.
- A screen exists on one machine, so there is no fallback machine. For a handoff, the fallback is the
  screenshot tap screen.
