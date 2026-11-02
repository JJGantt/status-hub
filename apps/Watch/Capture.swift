import Foundation
import WatchKit

/// The watch's one microphone, shared by every page that records: the prompt page (a command for the
/// hub), a session page (a follow-up typed into that session), and the always-on listener. One owner at
/// a time; `owner` says whose it is, so only that page draws it and only that page can send it.
@MainActor
final class Capture: ObservableObject {
    static let shared = Capture()

    enum Owner: Equatable {
        case hub
        case session(String)
        /// The always-on listener (`listen`). Nothing on screen engages it yet.
        case listener
        /// Rewind holding the microphone (`hold`) so its ring keeps filling: no file, no upload, no
        /// endpoint. Only when nothing else wants the microphone — every other owner feeds the ring too.
        case rewind
    }

    /// How a recording ends, chosen by whatever started it. A press always sends. `standard` (the app's
    /// own) also sends itself at the user's silence; `silence` is the same, kept so the `Hub Silence`
    /// complication's URL still opens. `locked` — every session follow-up, and the `Hub Locked`
    /// complication — ignores the silence, so only a press ends it. `quick` is `standard` with a hard cap: it also sends
    /// itself `quickCap` seconds after the microphone opens, whatever the user is doing — for one-sentence
    /// commands.
    enum Flow: String { case standard, silence, locked, quick }

    @Published private(set) var owner: Owner?
    /// The current recording's flow; `standard` when nothing is recording.
    @Published private(set) var flow = Flow.standard
    /// This recording ends itself at the silence after speech, unless it is locked.
    @Published private(set) var endsOnSilence = false
    /// Locked open (the `locked` flow): the silence no longer ends it, only a press does.
    @Published private(set) var locked = false
    /// Always-on listening is engaged: the microphone is the listener's whenever nothing else wants it,
    /// and it takes it back when a command or a follow-up gives it up.
    @Published private(set) var listens = false
    /// Rewind is engaged (`Rewind.swift`): the last stretch of audio is kept in memory, and the
    /// microphone is held for it whenever nothing else has it.
    @Published private(set) var rewinds = false
    /// The listener standing aside while the watch speaks a reply (`Speaker`): `listens` stays on and it
    /// takes the microphone back when the speaking ends. Paused, not switched off.
    private(set) var hushed = false
    /// A page may start a recording now: nothing owns the microphone, or only the listener does, and a
    /// deliberate command takes it from the listener and hands it back when it is done.
    var free: Bool { owner == nil || owner == .listener || owner == .rewind }
    /// A command or a follow-up: the recordings that deafen the room mics while they run.
    private var mutes: Bool { owner != nil && owner != .listener && owner != .rewind }

    /// Seconds of trailing silence that end an utterance: `watch_silence_s` in the hub's settings, read
    /// whenever the app comes to the front and at every start, and kept for the next, since a start does
    /// not wait on the hub. Unset, 3 — the
    /// same as every other capture source; at 2 an ordinary pause mid-sentence ended the command.
    private static var hang: TimeInterval = 3
    /// The lowest level that counts as the user's voice whatever the room's floor: `watch_speech_min` in the
    /// hub's settings, read with `hang`. Unset, 0.02. Tuned from the `mic-end` log and kept clips, not a
    /// guess: in a quiet room the 2.5x-floor line falls below this, so this IS the line, and a voice that
    /// dips under it mid-sentence counts as silence.
    private static var speechMin: Float = 0.02
    /// `watch_speech_mode`: `fixed` (the default) is the line above; `room` drops it and puts the line at
    /// `watch_speech_ratio` (8 when unset) times the room's quietest level instead, so it follows the room.
    private static var followsRoom = false
    /// `watch_speech_mode` = `voice`: Apple's sound classifier decides what is speech (`VoiceDetector`),
    /// and the level line plays no part. Speech is a window scored at least `watch_voice_min` (0.5 unset).
    private static var hearsVoice = false
    private static var voiceMin: Float = 0.5
    private static var roomRatio: Float = 8
    /// The `quick` flow's hard cap, in seconds of audio from the moment the microphone opened (the
    /// chirp): `watch_quick_s` in the hub's settings, read with `hang`. Unset, 5.
    private static var quickCap: TimeInterval = 5

    /// Audio nobody has spoken in, after which a recording is closed rather than left holding the
    /// microphone — and with it the mute on every room mic. The listener starts another segment instead
    /// of growing one file for as long as the room stays quiet (the phone's IDLE_CYCLE_MS). A locked
    /// recording is held open deliberately, so it is exempt.
    private static let unspoken: TimeInterval = 15

    /// How long the always-on listener lets one stretch of unbroken sound run before it starts a fresh
    /// file. The listener only: **a command or a follow-up has no length limit**, and ends at the user's
    /// silence or the user's press however long the user talks.
    private static let longest: TimeInterval = 60

    private let recorder = Recorder()
    /// Started, microphone not open yet. A stop in this window cancels instead of sending.
    private var arming = false
    /// The recorder is still opening, so no second start may begin even after a cancel.
    private var opening = false
    /// Mute writes run one after another, so an unmute can never land ahead of its own mute.
    private var muteTask: Task<Void, Never>?
    private var endpoint = Endpointer(hang: Capture.hang, minimum: Capture.speechMin)

    /// Runs when the silence ends the recording: the owner sends it as if it had been pressed.
    private var onSilence: (() -> Void)?
    /// The system took the microphone mid-recording and it is waiting to carry on (`pause`): the words so
    /// far are kept, unsent, and the next recording time goes onto the end of the same clip.
    @Published private(set) var paused = false
    /// Where in the clip the last resume picked up. The caps on a recording (`unspoken`, `quickCap`) count
    /// from here, so a resumed command gets its full allowance again.
    private var resumedAt: TimeInterval = 0
    /// The endpoint had heard the user before the pause. The endpoint itself starts over at a resume, so the
    /// silence only ends the command once the user has spoken again.
    private var spokeBefore = false
    /// When the listener's current utterance first crossed the threshold, and how much audio its
    /// segment holds.
    private var spokeAt: Date?
    private var segment: TimeInterval = 0
    /// What started the recording being opened — a press, a tap on the page, or a launcher (the
    /// complication, the Record control, the Smart Stack). In the hub log beside `mic-open`, because a
    /// recording nobody meant to start is otherwise indistinguishable from one the user asked for.
    static var trigger = "press"

    /// Held while listening is engaged, for a microphone failure on a later re-engage.
    private var listenFailure: (@MainActor (Error) -> Void)?
    /// When listening was engaged, and how many silent segments it has rolled since — the evidence for
    /// how long watchOS actually lets it hold the microphone with the wrist down. A roll is audio
    /// arriving, not a timer, so a line only appears while the microphone is genuinely still feeding.
    private var listenSince: Date?
    private var rolls = 0
    /// The classifier's latest verdict on whether the user is talking, 0…1.
    private var voice: Float = 0
    /// A locked recording's stretches of no speech so far (`Recorder.Clip.quiet`), and when the one under
    /// way began; nil while the user is talking.
    private var quiet: [[TimeInterval]] = []
    private var quietSince: TimeInterval? = 0
    /// The shortest stretch of no speech worth sending. The hub shortens only those over 6s, so this
    /// leaves it room to be tuned without a watch build.
    static let quietMin: TimeInterval = 4
    /// A command or a follow-up still recording taps the wrist once every this many seconds of audio
    /// (`.directionDown`, a falling double tap — `.click` is too subtle to notice), so one left running, locked or held open by a noisy room, is
    /// noticed. Counted in the microphone's own seconds, so it rides the buffers already arriving rather
    /// than a timer of its own.
    private static let nudge: TimeInterval = 60

    private init() {
        if let kept = UserDefaults.standard.dictionary(forKey: Self.storeKey) { Self.take(kept) }
        recorder.onLevel = { [weak self] level, seconds in self?.heard(level, seconds) }
        recorder.onVoice = { [weak self] speech in self?.voice = speech }
        recorder.onInterruption = { [weak self] began, fields in self?.interrupted(began, fields) }
    }

    /// Starts recording for `owner`, which is set at once so a second tap while the microphone opens is
    /// always a stop. Every other listener (Mac, ESP) goes deaf while it records, as it does for the
    /// phone's microphone, so one sentence cannot arrive twice.
    ///
    /// With `onSilence`, the recording ends itself once the user has spoken and then stopped for the trailing
    /// silence, and calls it, unless the flow is `locked`. Without, only a press ends it. The system
    /// taking the microphone ends neither: it pauses the recording (`interrupted`).
    func start(for owner: Owner, flow: Flow = .standard, onSilence: (() -> Void)? = nil,
               onFailure: @escaping @MainActor (Error) -> Void) {
        Speaker.shared.stop()   // the user's voice comes first: a recording ends any reply being read out
        LiveListen.shared.stop()   // …and the live mic, which holds the microphone too
        begin(owner, flow: flow, onSilence: onSilence, onFailure: onFailure) { [weak self] in
            self?.setMuted(true)
            // The wrist is told the moment the microphone is actually live, not when it was asked
            // for: opening it takes a beat, and words spoken before this are not recorded. Commands
            // and follow-ups only — the always-on listener opens through `listen()`, and a tap on
            // every utterance it picks up would be noise.
            // A rising double tap and a chirp from the speaker: loud and plain enough to be the signal
            // to start talking, where the gentle `.start` tap was easy to miss.
            WKInterfaceDevice.current().play(.directionUp)
            self?.recorder.cue()
            self?.openLive(owner, flow)
        }
    }

    /// The command or follow-up being recorded, streamed to the hub as it records, so a recording that
    /// dies with the app is reported the moment it dies and the hub keeps what was said (`LiveStream`).
    private var live: LiveStream?

    private func openLive(_ owner: Owner, _ flow: Flow) {
        guard let format = recorder.liveFormat else { return }
        let view: String
        switch owner {
        case .hub: view = "chat"
        case .session: view = "session"
        default: return
        }
        live = LiveStream.open(view: view, flow: flow.rawValue, format: format)
        recorder.live = live
    }

    /// Every way out of a recording tells the stream which one it was before it closes.
    private func closeLive(cancelled: Bool) -> String? {
        guard let live else { return nil }
        recorder.live = nil
        self.live = nil
        live.finish(cancelled: cancelled)
        return live.id
    }

    /// Engages or drops always-on listening: the microphone is held, each utterance is cut at the
    /// silence after it and sent as its own command, and it keeps going until it is dropped. It is a
    /// peer of the Mac and the ESP, not a command someone is holding the watch to say, so it mutes
    /// nothing and names itself `watch` with the utterance's own window (docs/LISTENERS.md).
    func toggleListening(onFailure: @escaping @MainActor (Error) -> Void) {
        listens.toggle()
        Hub.log("listen", ["on": listens])
        if listens {
            listenFailure = onFailure
            listenSince = Date()
            rolls = 0
            if owner == nil && !hushed { listen() }
        } else {
            listenFailure = nil
            listenSince = nil
            unlisten()
        }
    }

    /// Engages or drops rewind. Engaged, the recorder feeds its ring whoever owns the microphone, and
    /// when nobody does it is held for rewind alone (`hold`), writing nothing. The listener, when it is
    /// also on, holds the microphone instead and the ring rides on it.
    func toggleRewind(onFailure: @escaping @MainActor (Error) -> Void) {
        rewinds.toggle()
        if rewinds {
            rewindFailure = onFailure
            recorder.tee = Rewind.shared.engage()
            if owner == nil && !hushed && !opening { hold() }
        } else {
            rewindFailure = nil
            recorder.tee = nil
            Rewind.shared.disengage("off")
            if owner == .rewind { cancel() }
        }
    }

    private var rewindFailure: (@MainActor (Error) -> Void)?

    private func hold() {
        begin(.rewind, onSilence: nil, onFailure: { [weak self] error in
            guard let self else { return }
            self.rewinds = false
            self.recorder.tee = nil
            Rewind.shared.disengage("mic-failed")
            self.rewindFailure?(error)
        }) {}
    }

    /// Takes the microphone for the listener. Only while nothing else owns it: a command and a
    /// follow-up come first, and the listener takes it back when they give it up.
    private func listen() {
        begin(.listener, onSilence: nil, onFailure: { [weak self] error in
            self?.listens = false
            self?.listenFailure?(error)
        }) {}
    }

    /// Gives the microphone up. An utterance under way still counts and goes up.
    private func unlisten() {
        guard owner == .listener else { return }
        let from = spokeAt
        if endpoint.heard, let clip = stop() { upload(clip, from: from) } else { cancel() }
    }

    /// Ends the recording and hands back the clip; nil when the microphone never opened.
    func stop() -> Recorder.Clip? {
        guard owner != nil else { return nil }
        let muted = mutes
        let wasLocked = flow == .locked
        reset()
        if arming { arming = false; resumeSoon(); return nil }
        var clip = recorder.stop()
        clip?.live = closeLive(cancelled: false)
        if wasLocked {
            markQuiet(true, at: segment)   // a stretch still running when the user pressed counts too
            clip?.locked = true
            clip?.quiet = quiet
        }
        if muted { setMuted(false) }
        resumeSoon()
        // Ending the recording handed the audio session back; a command still waiting holds it again.
        StayAwake.shared.sessionReleased()
        return clip
    }

    /// Ends the recording and throws it away.
    func cancel() {
        guard owner != nil else { return }
        let muted = mutes
        reset()
        if arming { arming = false; resumeSoon(); return }
        recorder.cancel()
        _ = closeLive(cancelled: true)
        if muted { setMuted(false) }
        resumeSoon()
        StayAwake.shared.sessionReleased()
    }

    private func begin(_ owner: Owner, flow: Flow = .standard, onSilence: (() -> Void)?,
                       onFailure: @escaping @MainActor (Error) -> Void, opened: @escaping () -> Void) {
        // A command or a follow-up takes the microphone off the listener, which picks it up again when
        // they give it back (`resume`). Whatever it had heard by then still goes up.
        if owner != .listener, self.owner == .listener { unlisten() }
        // Rewind's hold gives way to anything; the ring keeps filling from whatever records next.
        if owner != .rewind, self.owner == .rewind { cancel() }
        guard self.owner == nil, !opening else {
            Hub.log("mic-refused", ["owner": String(describing: self.owner), "opening": opening])
            return
        }
        self.owner = owner
        // A command waiting on its answer may be holding the microphone to stay awake; this recording
        // holds it now, and one tap at a time.
        StayAwake.shared.sessionReleased()
        self.onSilence = onSilence
        endsOnSilence = onSilence != nil || owner == .listener
        self.flow = flow
        locked = flow == .locked && endsOnSilence
        endpoint = Self.followsRoom
            ? Endpointer(hang: Self.hang, minimum: 0, ratio: Self.roomRatio)
            : Endpointer(hang: Self.hang, minimum: Self.speechMin)
        spokeAt = nil
        segment = 0
        resumedAt = 0
        spokeBefore = false
        voice = 0
        quiet = []
        quietSince = 0
        recorder.classifies = Self.hearsVoice
        arming = true
        opening = true
        if endsOnSilence { Task { await Self.readSettings() } }
        Task {
            defer { opening = false }
            do {
                try await recorder.start(keepsFile: owner != .rewind)
            } catch {
                arming = false
                reset()
                Hub.log("mic-failed", ["error": String(describing: error).prefix(120).description])
                onFailure(error)
                return
            }
            guard arming else { recorder.cancel(); return }   // stopped while the microphone opened
            arming = false
            Hub.log("mic-open", ["owner": String(describing: owner), "how": Self.trigger, "flow": flow.rawValue])
            opened()
        }
    }

    private func reset() {
        owner = nil
        paused = false
        onSilence = nil
        endsOnSilence = false
        locked = false
        flow = .standard
    }

    /// Back to listening once the microphone is free again, if listening is engaged. Scheduled rather
    /// than immediate: a command TAKES the microphone off the listener, and an immediate resume would
    /// take it back before that command had started.
    func hush(_ on: Bool) {
        hushed = on
        if on {
            unlisten()
            if owner == .rewind { cancel() }
        } else { resumeSoon() }
    }

    private func resumeSoon() {
        guard listens || rewinds, !hushed else { return }
        Task { @MainActor in
            guard listens || rewinds, !hushed, owner == nil, !opening else { return }
            if listens { listen() } else { hold() }
        }
    }

    /// A timer or alarm going off, Siri, a call or another app recording takes the microphone away
    /// mid-recording, and nothing can refuse it. A command or a follow-up is PAUSED rather than sent or
    /// thrown away: the clip stays open and unsent, and when the microphone comes back (`resumeDraft`) the user
    /// carries on into the same clip, so what reaches the hub is one whole command. A listener utterance
    /// that had begun goes up and the rest of the segment is dropped; when the microphone comes back,
    /// listening picks it up again — without this, always-on listening ended silently at the first Siri
    /// and the glyph went on claiming it was listening.
    ///
    /// Both edges are logged with the system's reason and the endpoint's state at that instant: `quiet`
    /// near 0 with `voice` high is a recording cut while the user was mid-word, which is otherwise
    /// indistinguishable from the silence ending it early.
    private func interrupted(_ began: Bool, _ fields: [String: Any] = [:]) {
        var line = fields
        line["owner"] = owner.map { String(describing: $0) } ?? ""
        guard began else {
            Hub.log("mic-interruption-ended", line)
            if paused { return resumeDraft(how: "interruption-ended") }
            return resumeSoon()
        }
        line["heard"] = endpoint.heard || spokeBefore
        line["quiet"] = endpoint.quiet
        line["voice"] = Double(voice)
        line["seconds"] = segment
        line["flow"] = flow.rawValue
        Hub.log("mic-interrupted", line)
        switch owner {
        case .listener:
            unlisten()          // sends what was heard, if anything
        case .rewind:
            cancel()
        case .some:
            pause()
        case .none:
            break
        }
    }

    /// Holds a command or follow-up through an interruption: the microphone is let go, the clip is kept,
    /// and the room mics are unmuted, since nobody knows how long the alarm will ring.
    private func pause() {
        if paused { return }
        if arming { return cancel() }   // the microphone never opened: there is nothing to keep
        if flow == .locked { markQuiet(true, at: segment) }   // the pause is not a silence in the clip
        recorder.pause()
        live?.mark(paused: true)
        paused = true
        spokeBefore = spokeBefore || endpoint.heard
        if mutes { setMuted(false) }
        WKInterfaceDevice.current().play(.failure)
        Hub.log("mic-paused", ["seconds": segment, "heard": spokeBefore, "flow": flow.rawValue])
    }

    /// Carries a paused recording on into the same clip, with the chirp that says to talk. `how` is what
    /// asked: the interruption ending, the app coming back to the front, or the user's press. A refusal leaves
    /// it paused, and the next of those tries again.
    func resumeDraft(how: String) {
        guard paused, owner != nil, !opening else { return }
        do {
            try recorder.resume()
        } catch {
            Hub.log("mic-resume", ["ok": false, "how": how, "error": String(describing: error).prefix(120).description])
            if how == "press" { WKInterfaceDevice.current().play(.failure) }
            return
        }
        paused = false
        live?.mark(paused: false)
        endpoint.restart()
        resumedAt = segment
        if mutes { setMuted(true) }
        Hub.log("mic-resume", ["ok": true, "how": how, "seconds": segment])
        WKInterfaceDevice.current().play(.directionUp)
        recorder.cue()
    }

    /// One buffer of audio from the recorder. Every recording is measured, even one that only a press
    /// can end, because the cap on a recording nobody speaks into protects all of them.
    private func heard(_ level: Float, _ seconds: TimeInterval) {
        guard let owner, !arming else { return }   // nothing counts until the mic is open
        Rewind.shared.heard(seconds)
        // Rewind's own hold only keeps the microphone open: no endpoint, no segments, no file.
        if owner == .rewind { return }
        let wasHeard = endpoint.heard
        endpoint.hang = Self.hang
        // With the classifier running, ITS verdict is what counts as speech; if it failed to load, the
        // level line still ends the recording rather than nothing ending it.
        let speaking = recorder.classifying ? voice >= Self.voiceMin : nil
        let ended = endpoint.feed(level, seconds, voice: speaking)
        if flow == .locked { markQuiet(speaking ?? (level >= endpoint.threshold), at: segment) }
        segment += seconds
        if mutes, Int(segment / Self.nudge) > Int((segment - seconds) / Self.nudge) {
            WKInterfaceDevice.current().play(.directionDown)
            Hub.log("mic-nudge", ["minutes": Int(segment / Self.nudge), "flow": flow.rawValue,
                                  "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""])
        }
        if endpoint.heard && !wasHeard { spokeAt = Date() }
        // Accidentally recording: nobody spoke into it, or it has run on and on unlocked. Either way
        // the microphone closes and the clip is thrown away rather than sent.
        let tooLong = owner == .listener && segment >= Self.longest
        let thisStretch = segment - resumedAt
        if !locked && (tooLong || (!endpoint.heard && thisStretch >= Self.unspoken)) {
            if owner == .listener {
                recorder.drop()
                endpoint.restart()
                segment = 0
                rolls += 1
                // Every twentieth roll, about five minutes of listening. Fly keeps only the recent log
                // lines, so a beat a minute would flush everything else out of them.
                if rolls % 20 == 0, let since = listenSince {
                    Hub.log("listen-alive", ["minutes": Int(Date().timeIntervalSince(since) / 60)])
                }
            } else if spokeBefore {
                // Resumed after an interruption and nothing said since: the words before the pause are
                // still the user's to finish, so it pauses again rather than throwing them away.
                logEnd("unspoken")
                pause()
            } else {
                logEnd("unspoken")
                cancel()
            }
            return
        }
        // The quick flow's cap: the command goes at `quickCap` however it is going. Nothing heard by
        // then is nothing to send, and is thrown away rather than handed to Whisper to invent words for.
        if flow == .quick && owner != .listener && thisStretch >= Self.quickCap {
            logEnd("cap")
            if endpoint.heard || spokeBefore { onSilence?() } else { cancel() }
            return
        }
        guard endsOnSilence, ended else { return }
        if owner == .listener {
            logEnd("silence")
            cutUtterance()
        } else if !locked {
            logEnd("silence")
            onSilence?()
        }
    }

    /// Keeps the locked recording's map of where the user was not talking, one buffer at a time.
    private func markQuiet(_ speaking: Bool, at second: TimeInterval) {
        if speaking {
            if let since = quietSince, second - since >= Self.quietMin { quiet.append([since, second]) }
            quietSince = nil
        } else if quietSince == nil {
            quietSince = second
        }
    }

    /// The listener's cut: the utterance goes up and the next one is already recording.
    private func cutUtterance() {
        let clip = recorder.cut()
        let from = spokeAt
        endpoint.restart()
        spokeAt = nil
        segment = 0
        if let clip { upload(clip, from: from) }
    }

    private func upload(_ clip: Recorder.Clip, from: Date? = nil) {
        let window = from.map { (start: $0, end: Date()) }
        Task {
            do {
                let heard = try await Awake.hold("sending a heard command") {
                    try await Hub.sendAudio(clip, msgId: UUID().uuidString, listener: window)
                }
                // Nothing on screen marks a listener's command going up, so the wrist does. No id is the
                // hub hearing no words: nothing was enqueued, and nothing taps.
                if heard.id != nil { WKInterfaceDevice.current().play(.success) }
                Hub.log("listener-sent", ["id": heard.id ?? "", "words": (heard.transcript ?? "").count])
            } catch {
                Hub.log("listener-failed", ["error": String(describing: error).prefix(120).description])
            }
            try? FileManager.default.removeItem(at: clip.url)
        }
    }

    /// What the endpoint saw, so a recording that ended too soon or never ended can be read from the hub
    /// log (`"ev":"mic-end"`) and the thresholds tuned from real numbers.
    private func logEnd(_ reason: String) {
        Hub.log("mic-end", ["reason": reason, "owner": owner.map { String(describing: $0) } ?? "", "hang": endpoint.hang,
                            "floor": endpoint.floor.isFinite ? Double(endpoint.floor) : -1,
                            "threshold": Double(endpoint.threshold), "peak": Double(endpoint.peak),
                            "spoken": endpoint.spoken, "seconds": segment,
                            "classifier": recorder.classifierLoad ?? -1])
    }

    /// The endpoint's settings and the quick cap, from one read of the hub's settings.
    private static func readSettings() async {
        guard let all = try? await Hub.settings() else { return }
        apply(all)
    }

    /// Takes the endpoint's settings from a read of the hub's settings. `WatchSettings.refresh` hands
    /// over the read it makes every time the app comes to the front, so a change made in Settings
    /// reaches the first recording after the wrist comes up; the read at each start only covers a
    /// change made while the app stayed in front, and lands one recording late.
    ///
    /// **They are kept on the watch** (`capture-settings`) and taken back at launch, because a launch
    /// from the complication starts recording before any read can answer. Without them the first
    /// recording after every launch runs on the built-in defaults — the level line at 0.02, which a
    /// voice with the wrist down sits under for most of a sentence.
    static func apply(_ all: [String: Any]) {
        var kept: [String: String] = [:]
        for key in storedKeys { if let v = all[key] { kept[key] = "\(v)" } }
        UserDefaults.standard.set(kept, forKey: storeKey)
        take(kept)
    }

    private static let storeKey = "capture-settings"
    private static let storedKeys = ["watch_silence_s", "watch_speech_min", "watch_speech_mode", "watch_voice_min",
                                     "watch_speech_ratio", "watch_quick_s", "watch_rewind_s"]

    private static func take(_ all: [String: Any]) {
        if let v = all["watch_silence_s"].flatMap({ Double("\($0)") }), v > 0 { hang = v }
        if let v = all["watch_speech_min"].flatMap({ Float("\($0)") }), v > 0 { speechMin = v }
        let mode = all["watch_speech_mode"].map { "\($0)" }
        followsRoom = mode == "room"
        hearsVoice = mode == "voice"
        if let v = all["watch_voice_min"].flatMap({ Float("\($0)") }), v > 0, v < 1 { voiceMin = v }
        if let v = all["watch_speech_ratio"].flatMap({ Float("\($0)") }), v > 0 { roomRatio = v }
        if let v = all["watch_quick_s"].flatMap({ Double("\($0)") }), v > 0 { quickCap = v }
        // Read when rewind is engaged; a change reaches the next engage. Capped at ten minutes, about
        // 38 MB of ring.
        if let v = all["watch_rewind_s"].flatMap({ Double("\($0)") }), v > 0 { Rewind.seconds = min(v, 600) }
    }

    private func setMuted(_ on: Bool) {
        #if targetEnvironment(simulator)
        return   // a test recording in the simulator must not deafen the real room mics
        #endif
        let previous = muteTask
        muteTask = Task {
            await previous?.value
            await Hub.muteOthers(on)
        }
    }
}

/// When an utterance is over, decided the way the phone's always-on listener decides it (`makeListener`
/// in voiceagent.js): the room's floor is the quietest buffer so far, speech is anything 2.5× above it
/// (and above `minimum` whatever the floor), and once speech has been heard, `hang` seconds below that line
/// end it. Before any speech nothing ends — that is the leeway at the start — so a recording whose
/// speech never crossed the line is not cut short or thrown away; it waits for a press, or for the cap
/// on a recording nobody speaks into.
struct Endpointer {
    /// Speech has to last this long, unbroken by `hang` of quiet, before an utterance has begun. **One
    /// buffer over the line is not speech**: otherwise a recording nobody spoke into can end on a peak
    /// of 0.021 against a 0.02 line and go up as "Thank you. Thank you." — which is what Whisper
    /// writes for silence, and the worker then runs it.
    static let minSpeech: TimeInterval = 0.4

    var hang: TimeInterval
    private(set) var floor: Float = .infinity
    private(set) var peak: Float = 0
    private(set) var heard = false
    /// Seconds over the line in the run of speech being counted now.
    private(set) var spoken: TimeInterval = 0
    /// Seconds below the line since the last speech.
    private(set) var quiet: TimeInterval = 0

    let minimum: Float
    /// How many times the room's quietest level counts as speech. 2.5 under a fixed `minimum`, which in
    /// a quiet room is the whole line; with no minimum (the `room` setting) this alone sets it.
    let ratio: Float

    init(hang: TimeInterval, minimum: Float, ratio: Float = 2.5) {
        self.hang = hang; self.minimum = minimum; self.ratio = ratio
    }

    var threshold: Float { max(floor * ratio, minimum) }

    /// Takes one buffer's level and length; true when that buffer ended the utterance. `voice`, when
    /// given, is the classifier's verdict and replaces the level line as what counts as speech.
    mutating func feed(_ level: Float, _ seconds: TimeInterval, voice: Bool? = nil) -> Bool {
        // A buffer of exact digital silence (the microphone still opening) is not the room. Counted, it
        // would put the room's level, and with `ratio` alone the whole line, at zero.
        if level > 0 { floor = min(floor, level) }
        peak = max(peak, level)
        if voice ?? (level >= threshold) {
            spoken += seconds
            if spoken >= Self.minSpeech { heard = true }
            quiet = 0
            return false
        }
        quiet += seconds
        guard heard else {
            if quiet >= hang { spoken = 0 }   // a gap ends a run of speech too short to have counted
            return false
        }
        return quiet >= hang
    }

    /// Ready for the next utterance. The floor is the room's, so it carries over.
    mutating func restart() {
        heard = false
        quiet = 0
        spoken = 0
        peak = 0
    }
}
