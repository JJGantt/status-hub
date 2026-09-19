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

That is all of it. `source` is free-form (`mac`, `fly`, `phone`, …) and nothing branches on it.

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

The ESP and the Mac gate on it: ECAPA-TDNN against the enrolled voiceprint, accepted at
`app_settings.voiceid_accept_threshold`. A room mic has to know it is him and not the television.

The phone's always-on mode is the same situation — engaging it is what puts the phone INTO the
always-on state — so it belongs behind the same gate, against the same bank and the same threshold.
**Not yet wired: see `docs/TODO.md`.** The phone's deliberate button needs no gate; someone holding
it down has already identified themselves.
