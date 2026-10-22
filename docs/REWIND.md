# Rewind (watch)

The watch's own version of Apple's Live Rewind: while it is engaged, the last `watch_rewind_s`
seconds the microphone heard (30 when unset, ten minutes at most) are kept in memory, and a grab sends
them to the hub to be transcribed and shows the words. It is the minimal build, and it exists to
**measure** two things nobody knows for this app: how long watchOS lets it hold the microphone with
the wrist down, and what that costs in battery.

## How it works

- **Buffer** control (`BufferIntent`) engages or drops it. Like Listen it opens the app, because the
  microphone can only start with the app in front; it then carries on with the wrist down through the
  watch's `UIBackgroundModes: audio`. The edge of the glass shows the listening blue while it is on.
- **Rewind** control (`RewindIntent`) grabs: `Rewind.grab` copies the ring, encodes it to .m4a at the
  same settings as a command (`RewindAudio.writeM4A`), and posts it to `/api/voice-command?dry=1` —
  transcribed, never enqueued, so nothing he overheard runs as a command. The words appear in a sheet
  over whatever page is showing. The ring keeps its audio, so a second grab hears the same moments again.
- **The ring rides every recording.** `Recorder.tee` is fed every converted buffer whoever owns the
  microphone — a command, a follow-up, the always-on listener. When nobody does, Capture holds it for
  rewind alone (owner `.rewind`): no file is written (`Sink` with `keepsFile: false`), no endpoint
  runs, nothing is uploaded. A command takes the microphone from that hold and rewind takes it back
  afterwards (`resumeSoon`), exactly as the listener does, and the command's own audio lands in the
  ring too. A spoken reply and an interruption (Siri, a call) release it the same way.
- `RewindBuffer` is pure Swift so it can be tested off the device. Memory is 64 KB a second of ring
  (16 kHz mono floats): 30 s is 1.9 MB, two minutes 7.7 MB.

## Reading the measurement

Every line is in the hub log (`fly logs -a jared-status-hub | grep '"ev":"rewind'`) and carries
`minutes` since engaged, `fed` (seconds of audio that actually arrived), `held`, `quiet` (seconds since
the last audio arrived), `owner`, `battery` (0…1) and `charging`.

| event | when |
|---|---|
| `rewind` | engaged (`on: true`, `seconds`) or dropped (`on: false`, `why`: `off`, `mic-failed`) |
| `rewind-alive` | every five minutes of audio that actually arrived — audio, not a timer, so the lines stop when the microphone stops feeding |
| `rewind-check` | the app came to the front while engaged. `quiet` of minutes means watchOS took the microphone while the wrist was down, which no callback reports; `minutes - quiet/60` is how long it lasted |
| `rewind-grab` | a grab: `held`, `bytes`, `ms` to the words, `words`, or `ok: false` with `why` (`off`, `empty`, an error) |

`mic-interrupted` / `mic-interruption-ended` with `owner: rewind` are the system taking and returning
the microphone (WATCH.md § It logs what it does to the hub).

The battery cost is the slope of `battery` against `minutes` across `rewind-alive` lines with
`charging: false`; compare a stretch with it off.

## Testing

    cd apps && swiftc -parse-as-library -o /tmp/test-rewind Watch/RewindBuffer.swift tools/test-rewind.swift \
      && HUB_TOKEN=<a machine's ?token= hub token> /tmp/test-rewind

On the Mac. It checks the ring's wrap-around against a model over thousands of random appends, that a
sentence spoken after a minute of noise is what the ring hands back, that the encode is the right
length, and — with `HUB_TOKEN` — that the hub's dry transcription returns the sentence and enqueues
nothing. What it cannot check is the watch itself: holding the microphone, the controls, the sheet.
Those are measured from the log above.
