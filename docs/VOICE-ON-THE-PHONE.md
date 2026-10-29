# Voice on the phone

Two microphones, deliberately different. Neither is a fallback for the other.

| | **Every microphone button** | **The always-on button** |
|---|---|---|
| Shape | press to start, press to send | tap to engage, tap to disengage |
| Ends a clip | he does, and only he | the silence after each utterance |
| Sends | once, whatever it recorded | every utterance, until disengaged |
| Mirrors | nothing — it is the deliberate one | what the Mac and the ESP already do |

## A microphone button does not decide anything

There are five, and they are one recorder (`makeRecorder` in `voiceagent.js`) with different
destinations:

| button | where | its words go |
|---|---|---|
| navbar | every page's bottom bar | a voice command |
| chat sheet | `cardRec`, `voiceagent.js` | a voice command, or the text box while pictures are pending |
| session view | `at.rec`, `cards/repos.js` | that session, as a follow-up |
| new session | `beginDictation`, `cards/repos.js` — starts from the machine button, sends on a tap of the row | the new session's first message |
| `/mic` | `mic.js` | a voice command |

The recorder has no voice-activity detection and no timer: a recording ends on the second press and
everything recorded is sent. **Do not give it one.** A VAD on this path ends a recording at a
mid-sentence pause and discards any clip it judges silent, with no message — and on his phone it
judges whole spoken commands silent, so the button records, throws the words away and shows nothing.
That is why there is no `autoStop` option to turn on for one button. `docs/HUB-INTERNALS.md` has the
recorder's other guarantees (a recording ended underneath it still sends; an upload is bounded;
`cancel()` is the only way to end one without sending).

## The always-on button

`makeListener()` in `voiceagent.js`. Engaged, it holds the mic, watches level against a noise floor
(the quietest frame so far), and cuts a clip at `phone_silence_s` of trailing silence.
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
a peer. Only the microphone buttons mute the others, because a hard-routed command is not a listener.

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

## A dead microphone is detected by the EMPTY TRANSCRIPT

An iOS capture track that loses the audio session produces zeros while still reporting
`readyState: 'live'` (see `ALARMS.md`). Nothing on the page can see that, and no recorder judges
silence itself.

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
been up and whether Guided Access is on; every device arriving or leaving beacons `mic-devicechange`;
every acquisition beacons `mic-device` with the label it got (the capture is pinned to the built-in mic,
`acquireBuiltIn`, so AirPods are never the input — `HUB-INTERNALS.md`). A route change under the held capture (AirPods, a car) is the first suspect. Read those two side by
side the next time it happens. Fly keeps only the last hundred or so log lines, so read them soon.
