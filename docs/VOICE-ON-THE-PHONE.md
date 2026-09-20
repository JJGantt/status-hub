# Voice on the phone

Two microphones, deliberately different. Neither is a fallback for the other.

| | **The microphone button** | **The always-on button** |
|---|---|---|
| Shape | tap to open, tap to send | tap to engage, tap to disengage |
| Ends a clip | he does, and only he | the silence after each utterance |
| Sends | once | every utterance, until disengaged |
| Mirrors | nothing — it is the deliberate one | what the Mac and the ESP already do |

## The microphone button does not decide anything

It used to auto-stop on trailing silence, and gave up entirely after eight seconds of what it judged
to be silence. That is wrong for a button someone is holding a thought in front of: a pause
mid-sentence is not the end of a sentence, and the give-up path dropped the clip without sending
anything. `autoStop: false` in `navbar.js` — the recording ends when he ends it.

The give-up path still exists inside the recorder for the always-on caller, and it now also marks the
mic dirty; see the microphone section of `ALARMS.md` for why that matters.

## The always-on button

`makeListener()` in `voiceagent.js`. Engaged, it holds the mic, watches level against the same
noise-floor threshold the old VAD used, and cuts a clip at `phone_silence_s` of trailing silence.
Each one goes up on its own through `sendVoice` — the same outbox the button uses — and it keeps
listening until pressed again.

**The recorder runs the whole time; utterances are cut out of it.** Starting a `MediaRecorder` when
the VAD first hears something loses the onset of the word that triggered it, which is the failure the
Mac spent a long time on. So a segment is always already running, ends at the silence, and the next
starts in the same tick. Silence carried at the front of a clip costs nothing; a missing first
syllable costs the command.

**Silence is never uploaded.** A segment that never crossed the threshold is discarded, because
Whisper does not return an empty string for silence — it invents a plausible sentence, and the worker
then acts on it.

**It mutes the other listeners** while engaged (`voice_muted`), for the same reason the button does:
an always-on phone mic and an always-on room mic must not both route the same words.

## The button is the only indicator

Nothing else on screen says whether the microphone is open, so all three states live in the button
and `on` holds through every one of them — the distinction that matters most is open vs off.

| state | the button |
|---|---|
| engaged, waiting | red outline, bars sat low, ring pulsing slowly |
| hearing him | filled red, bars moving as a level meter |
| sending | amber, bars still, ring turning |

Waiting and hearing differ in SHAPE, not just speed, so a glance is enough. The sending state follows
the clip's own progress through `sendVoice` rather than a timer, so it clears when the transcription
actually settles — a button that guessed would be claiming a state it does not know.

**It disengages itself** on `pagehide` and when the page is hidden. A microphone left open behind a
backgrounded page is the one outcome worth defending against automatically.

## Opening the chat

Tapping the one-line prompt/reply strip on the home page (`#ph-conv`) opens the full thread sheet —
it is the conversation in miniature, so it is the obvious way into the whole of it, and it frees the
navbar slot the keyboard button held for the always-on button.

## A dead microphone is detected by the EMPTY TRANSCRIPT, not by the VAD

An iOS capture track that loses the audio session produces zeros while still reporting
`readyState: 'live'` (see `ALARMS.md`). The recovery first hung off `vad:grace` — but only the
auto-stopping recorders run a VAD, and `cardRec`, the microphone inside the session view, passes no
`autoStop` at all. It therefore had NO recovery: it uploaded silence, the hub answered
`{transcript: '', enqueued: false}`, and the prompt vanished with no row and no error, permanently,
because nothing ever marked the stream dirty.

So the signal is the one EVERY recorder produces: a clip with real bytes in it coming back with an
empty transcript. Whisper returns empty for silence, so that is the microphone reporting zeros.
`deliverVoice` marks the stream dirty there and the next press re-acquires. Clips under 2KB are
exempt — too short to contain anything is not evidence of a dead device.

The loud failure is covered separately: a track that ENDS announces it, so `mic()` attaches an
`ended` listener when it acquires.
