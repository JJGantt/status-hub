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

**The session view's microphone is the same button** (`at.rec` in `cards/repos.js`, `autoStop: false`).
With `autoStop` on, the VAD judges each clip, and one it thinks is silent is thrown away inside
`send()` with no message. On his phone it judged whole spoken follow-ups silent, so the press
recorded, discarded his words and showed nothing. Any press-to-talk button has to send what it
recorded, so none of them may set `autoStop`.

`autoStop: true` remains on the new-session dictation (`beginDictation` in `cards/repos.js`) and on
the `/mic` web clip, so both can still drop a clip that way. `vad:grace` in the hub log (`fly logs |
grep tap`) carries the analyser's `actx` state and the `peak`/`floor` RMS it saw, which shows WHICH
kind of silence it was: a suspended context, a dead capture, or a threshold he never crossed.

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

**It mutes nothing.** The Mac and the ESP already listen at the same time and the worker collapses
whichever of them heard the same utterance by capture window (`LISTENERS.md`), so the phone joins as
a peer. Only the microphone button mutes the others, because a hard-routed command is not a listener.

**Each segment's recorder fills its own array.** With no timeslice, a `MediaRecorder` delivers
essentially the whole segment in its final `dataavailable`, which fires after `stop()` — by which
time the next segment is running. Pushed into a shared array, that audio lands in the NEXT clip: one
upload holds half its segment and the next holds two recordings glued together.

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
auto-stopping recorders run a VAD, and the press-to-talk ones — `cardRec` in the chat sheet, the
navbar's, the session view's — pass no `autoStop`. It therefore had NO recovery: it uploaded silence, the hub answered
`{transcript: '', enqueued: false}`, and the prompt vanished with no row and no error, permanently,
because nothing ever marked the stream dirty.

So the signal is the one EVERY recorder produces: a clip with real bytes in it coming back with an
empty transcript. Whisper returns empty for silence, so that is the microphone reporting zeros.
`deliverVoice` marks the stream dirty there and the next press re-acquires. Clips under 2KB are
exempt — too short to contain anything is not evidence of a dead device.

The loud failure is covered separately: a track that ENDS announces it, so `mic()` attaches an
`ended` listener when it acquires.

## A capture that DROPS FRAMES is caught by the hub, from the clip

The phone's capture can keep one audio frame in about nine while its track reports live and unmuted:
36.7 seconds of talking arrives as 4.2 seconds of chopped fragments, at an effective 5.5kHz where a
sound clip is 48kHz — a sample-rate mismatch somewhere beneath the page. Whisper hears the fragments
as noise and writes `Thank you.`, which would otherwise be enqueued and acted on. Nothing the page can
read shows it; the clip does.

So `/api/voice-command` measures every clip that carries a `dur` of a second or more: `clipSeconds`
(`lib/transcribe.js`) reads the audio's length off its packet timestamps with an ffmpeg stream copy,
tens of milliseconds, and a clip holding under half its recorded time is refused as
`{capture: 'damaged'}` before transcription. Measured over every stored clip, sound ones hold 95-101%
and damaged ones 11-12%. The hub log line is `[voice-command] DAMAGED`.

The page's recovery escalates (`captureDamaged` in `voiceagent.js`). First a fresh capture: every
track stopped and the device asked for again, and the always-on mode re-engages onto it
(`hub:micreset`). If a clip recorded AFTER that reset is damaged too, the fault is below the stream and
the page reloads, which discards every AudioContext, media element and capture the page owns at once.
The reload waits for the outbox to drop the clip — resent on load it would be refused, and reload again.

**The trigger is not yet known.** Every damaged clip beacons `ev: "mic-damaged"` to the hub log with
the track's settings (`sampleRate`, device label), the audio devices present, how long the page has
been up and whether Guided Access is on; every device arriving or leaving beacons `mic-devicechange`.
A route change under the held capture (AirPods, a car) is the first suspect. Read those two side by
side the next time it happens. Fly keeps only the last hundred or so log lines, so read them soon.
