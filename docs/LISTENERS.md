# Listeners

An always-on microphone that can enqueue a voice command. The Mac, the ESP and the phone are three of
them; there is nothing special about any one, and **adding a fourth is satisfying this contract, not
changing code here.**

## They all listen at once. Nothing mutes anything

Two mics in one room both hear the same sentence, and that is fine — the worker collapses them. What
must never happen is a listener standing the others down, because then the best-placed mic loses to
whichever one was engaged last.

The one exception is the phone's **deliberate** microphone button, which does mute the rest: a
hard-routed command someone is holding the phone to say is not a listener, and it should not race the
room.

## The contract

1. **Capture one utterance.** Where it starts and ends is the listener's business (energy endpointing,
   a wake word, a button — all three are in use).
2. **Stamp `capture_start` and `capture_end`** — the window of the UTTERANCE in absolute time, not of
   whatever buffer it was cut from, and not when it was uploaded.
3. **Write a `voice_requests` row** with its own `source` label. Over HTTP that is
   `POST /api/voice-command?source=<name>&capture_start=…&capture_end=…`; the hub transcribes and
   inserts. A listener that speaks Supabase directly (the Mac does) can insert the row itself.

That is all of it. `source` is free-form (`mac`, `fly`, `phone`, …) and a new listener needs nothing
else, but a few labels are read: `watch` and `phone` have their voice checked (`GATED_SOURCES`) and are
stamped `always_on`, which is the one thing the worker reads to decide whether a turn may be dropped as
overheard or barred from sending — a listener inserting its own row (the Mac, the ESP) stamps it
itself (the ESP only for a wake-free capture; a wake-word command is a press), and an unstamped row is
treated as a press. The worker itself reads one label,
`watch-fallback`, the watch's route when the hub does not answer. The watch is a listener as `watch`,
engaged from its home page (`Capture.toggleListening`); a command he presses for on it is `watch-cmd`,
which is not a listener and not voice-checked. It still carries its window — from the microphone going live to the press that ends it — because
`capture_start` is also the moment the worker hands the data layer as "now", which is what a set
logged by voice is stamped with. A press without one is stamped when the model calls the tool.

## Why the window is the whole thing

`_duplicate_of_recent` in `voice-pipeline/server/worker.py` collapses a request whose
`[capture_start, capture_end]` **overlaps** an earlier one that actually ran, each padded by
`DEDUP_TOL_S` for clock skew and stream latency. Overlap — not arrival order — so the pair collapses
however slowly one of them transcribed, while two genuinely sequential commands both run even a
second apart.

**A listener without a window is not a peer.** It falls back to `created_at` proximity, and a clip
that is recorded, queued and uploaded later arrives far outside any useful window — so it either runs
twice or collapses something it never overlapped. Web clips had no window at all until the phone
became a listener, which is exactly the bug this contract exists to prevent.

The window is the utterance, not the buffer. The phone's recorder runs continuously and cuts
utterances out of it (so no onset is lost), so its segments start before he speaks; stamping the
segment's own start would overlap the previous one and collapse two real commands into one.

## Speaker ID

**A listener that UPLOADS a clip is scored by the hub** (`soundsLikeHim` in `status-hub/server.js`):
the clip goes to the voice server as 16k mono WAV, `/verify` answers the top-3 cosine against the
voiceprint, and anything under `voice_upload_accept` (0.22 when unset, 0 to accept anything) is never enqueued. That
setting is its own: `voiceid_accept_threshold` is the ESP's whole-clip gate, it reads 0 today, and a
number tuned for a puck streaming raw audio should not silently decide what a watch may say. That is
the phone and the watch, which hand over a finished file rather than streaming — until 2026-09-23 they
were the only mics in the house with no gate at all, and eleven minutes of watch listening sent a
podcast, a television and a room to the worker.

**0.30 is measured, not chosen.** Every stored watch-listener clip was scored against the voiceprint
on 2026-09-23 — eleven minutes of always-on listening that had caught a podcast, a television and the
room, plus three real commands:

| | |
|---|---|
| him, through the watch | 0.33, 0.37, 0.37 |
| him, pressed on a phone | 0.39, 0.45, 0.52 |
| the room (podcast, television, a passing sentence) | 0.26 and below — twenty-one clips |
| near-silence, whoever it was | under 0.13 |

So his speech and the room separate at about 0.3, and the bar sits in that gap. The old default of 0.22
would have passed the two loudest podcast clips. Three positive samples is thin, so read the
`[voice-command] … voice accepted/REFUSED sim=` lines as more arrive and move it if they crowd the bar.

Scoring is not free: the voice server is one small machine running ECAPA, and a batch of back-to-back
verifies answered 502. One clip at a time, which is what a listener does anyway.

**A gate that cannot run lets the command through.** A voice server that is down, a missing voiceprint
and a clip that will not decode all answer 0, which the hub reads as "cannot tell" — eating his
commands because a service is unreachable is the worse failure.

**A press is its own proof.** Only always-on sources are scored; the deliberate button on a phone or a
watch identifies whoever is holding it.

The ESP and the Mac gate on it in the stream itself, scoring 2s slices as they arrive (and, at
`app_settings.voiceid_accept_threshold`, the whole clip — 0 today, so off), so audio that is not him
never reaches Whisper. An uploaded clip is scored only AFTER the hub has transcribed it: a refused
clip has already been sent to Groq, and the gate saves the worker run, not the transcription.
