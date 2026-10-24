# Rewind (watch)

**This file is the whole feature**: what is built, what has been measured, and what comes next. Keep
the plan at the bottom current as decisions are made, so a session that picks this up cold knows where
it stands.

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

Every line is kept for 14 days in Supabase `client_log` (`src = 'watch'`, `ev like 'rewind%'`); the
console (`fly logs -a jared-status-hub | grep '"ev":"rewind'`) holds only the last hour or so. Each carries
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

Reading the whole picture means the other watch lines around them: `mic-open` (with `owner`) shows
each handover, `record-start`/`record-stop` a command, `speak`/`speak-end` a reply read aloud, and
`phase` the app going to the background with the wrist down.

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

## What a grab does NOT keep

Neither the transcript nor the audio of a grab is stored anywhere: the words exist only in the sheet on
the watch, and `rewind-grab` logs their count, not their text. So a grab cannot be reviewed afterwards
for quality. Fixing that is step 1 of the plan below.

The ring is not fed while nothing owns the microphone — during a reply read aloud, for instance — and it
stitches what comes after onto what came before with no mark. A grab just after a long spoken reply
holds audio from either side of that gap as if it were continuous.

## Measured

**2026-10-24, first real use** (Series watch, TV on in the room, 30 s ring):

| UTC | what happened | ring |
|---|---|---|
| 13:05:57 | Buffer engaged | owner `rewind` |
| 13:07:13–13:08:12 | a command (58 s) | owner `hub`, ring kept feeding; back to `rewind` at once |
| 13:08:26–13:15:45 | app in the background, wrist down, 7 min | fed throughout (`quiet` 0.0–0.1 s at every check) |
| 13:17:23 | grab | `held` 30 s, 115 KB, words back in 3.9 s, 95 words |
| 13:17:50–13:21:56 | a 4-minute follow-up to a session | owner the session, ring kept feeding; back to `rewind` |
| 13:22:49–13:23:36 | a reply read aloud | ring idle (`quiet` 45 s), resumed when the speech stopped |

- `fed` 1004 s at 16.8 min engaged: 99.5% of wall time arrived. No interruption from watchOS in 17 min.
- `battery` read 0.35 at every line for the whole 17 minutes, so the cost is below what one session that
  short can show. It needs a stretch of an hour or more off the charger.
- 95 words in 30 s is about continuous dialogue for the full window, consistent with the TV. Whether the
  words were right cannot be checked: see above.

## Transcription: what is possible

The grab is transcribed by the same path as a command: Groq `whisper-large-v3-turbo`
(`server/lib/transcribe.js`), OpenAI as the fallback. Whisper returns plain text only — no speakers, no
tone, no sounds — and Groq offers no diarization. Everything not in the words is lost at that step.

**Speaker separation (diarization) is a solved, commercial feature.** Options as of October 2026:

| service | what it gives | notes |
|---|---|---|
| OpenAI `gpt-4o-transcribe-diarize` | text segmented by speaker A/B/C | can be given short reference clips of known voices, so his turns can come back named |
| AssemblyAI Universal | speaker labels, also speaker naming | ~$0.21/hr base, add-ons metered separately |
| ElevenLabs Scribe v2 | speaker labels, plus tagged non-speech events (laughter, music, applause) | the one that keeps some of the "nuance" beyond words |
| Deepgram Nova-3 | `diarize=true` | fast; strongest for streaming |
| pyannote / WhisperX | self-hosted diarization + Whisper | free, but Mac-only here; too heavy for the Pi |

What to expect: diarization separates by voice embedding, not by gender, so two men are separable when
each speaks for more than a second or two; it degrades with short overlapping turns, a distant mic, and
speech coming out of a TV speaker (which flattens voices). A 30-second clip gives it little to learn
each voice from. Labels are anonymous (Speaker A, B) unless a reference clip says who someone is.

**His own voice is already enrolled**: the hub keeps a `voiceprint` (ECAPA exemplar bank) for speaker
ID on uploaded clips (`server.js`, "IS IT HIM?"). Either that, or a reference clip passed to the
diarizing model, can turn "Speaker A" into "Jared" and leave the rest anonymous.

**Beyond text**: sending the audio itself to a model that takes audio input keeps tone, emphasis and
who-is-who without a transcription step losing them. Which models accept audio directly changes often;
check before building on it.

## Plan

Decided so far (2026-10-24):

1. **Keep what a grab produced** — store the transcript (and optionally the clip, in the same bucket as
   command clips) so a grab can be reviewed and acted on later, and so quality can be judged. Needed
   by everything below.
2. **Actions on the sheet** — under the words, a control to send them on:
   - **Send** as a prompt through the normal voice route (a `voice_requests` row, so the worker and
     its tools handle it).
   - **Send with instructions** — record a command of his own; it goes with the rewind text attached
     as context ("here is what was just said; do X with it").
3. **One-step rewind** — a variant of the Rewind control that skips the sheet: grab, transcribe, and
   start recording his instruction immediately, then send both together.
4. **A better transcription when it matters** — a diarized (and named-speaker) transcription for grabs,
   either always (rewind clips are rare, so cost is small) or as the path for "send" only. Pick a
   provider by running the same saved clips through two or three of the table above.

Open questions for Jared:

- Should the plain sheet show the diarized version (Speaker A / Speaker B), or only what is sent on?
- Is keeping the audio of grabs acceptable, or text only? It is overheard audio of other people.
