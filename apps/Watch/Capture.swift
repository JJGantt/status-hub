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
    }

    @Published private(set) var owner: Owner?
    /// This recording ends itself at the silence after speech, so it can be locked open.
    @Published private(set) var endsOnSilence = false
    /// Locked open: the silence no longer ends it, only a press does.
    @Published private(set) var locked = false
    /// Always-on listening is engaged: the microphone is the listener's whenever nothing else wants it,
    /// and it takes it back when a command or a follow-up gives it up.
    @Published private(set) var listens = false
    /// The listener standing aside while the watch speaks a reply (`Speaker`): `listens` stays on and it
    /// takes the microphone back when the speaking ends. Paused, not switched off.
    private(set) var hushed = false
    /// A page may start a recording now: nothing owns the microphone, or only the listener does, and a
    /// deliberate command takes it from the listener and hands it back when it is done.
    var free: Bool { owner == nil || owner == .listener }

    /// Seconds of trailing silence that end an utterance: `watch_silence_s` in the hub's settings, read
    /// at every start and kept for the next, since a start does not wait on the hub. Unset, 3 — the
    /// same as every other capture source; at 2 an ordinary pause mid-sentence ended the command.
    private static var hang: TimeInterval = 3
    /// The lowest level that counts as his voice whatever the room's floor: `watch_speech_min` in the
    /// hub's settings, read with `hang`. Unset, 0.02. Tuned from the `mic-end` log and kept clips, not a
    /// guess: in a quiet room the 2.5x-floor line falls below this, so this IS the line, and a voice that
    /// dips under it mid-sentence counts as silence.
    private static var speechMin: Float = 0.02
    /// `watch_speech_mode`: `fixed` (the default) is the line above; `room` drops it and puts the line at
    /// `watch_speech_ratio` (8 when unset) times the room's quietest level instead, so it follows the room.
    private static var followsRoom = false
    private static var roomRatio: Float = 8

    /// Audio nobody has spoken in, after which a recording is closed rather than left holding the
    /// microphone — and with it the mute on every room mic. The listener starts another segment instead
    /// of growing one file for as long as the room stays quiet (the phone's IDLE_CYCLE_MS). A locked
    /// recording is held open deliberately, so it is exempt.
    private static let unspoken: TimeInterval = 15

    /// How long the always-on listener lets one stretch of unbroken sound run before it starts a fresh
    /// file. The listener only: **a command or a follow-up has no length limit**, and ends at his
    /// silence or his press however long he talks.
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
    /// Runs when the system takes the microphone mid-recording, for the same reason.
    private var onTaken: (() -> Void)?
    /// When the listener's current utterance first crossed the threshold, and how much audio its
    /// segment holds.
    private var spokeAt: Date?
    private var segment: TimeInterval = 0
    /// What started the recording being opened — a press, a tap on the page, or a launcher (the
    /// complication, the Record control, the Smart Stack). In the hub log beside `mic-open`, because a
    /// recording nobody meant to start is otherwise indistinguishable from one he asked for.
    static var trigger = "press"

    /// Held while listening is engaged, for a microphone failure on a later re-engage.
    private var listenFailure: (@MainActor (Error) -> Void)?
    /// When listening was engaged, and how many silent segments it has rolled since — the evidence for
    /// how long watchOS actually lets it hold the microphone with the wrist down. A roll is audio
    /// arriving, not a timer, so a line only appears while the microphone is genuinely still feeding.
    private var listenSince: Date?
    private var rolls = 0

    private init() {
        recorder.onLevel = { [weak self] level, seconds in self?.heard(level, seconds) }
        recorder.onInterruption = { [weak self] began in self?.interrupted(began) }
    }

    /// Starts recording for `owner`, which is set at once so a second tap while the microphone opens is
    /// always a stop. Every other listener (Mac, ESP) goes deaf while it records, as it does for the
    /// phone's microphone, so one sentence cannot arrive twice.
    ///
    /// With `onSilence`, the recording ends itself once he has spoken and then stopped for the trailing
    /// silence, and calls it; `toggleLock()` holds it open. Without, only a press ends it. `onTaken` is
    /// the same ending forced from outside — the system taking the microphone — and every caller wants
    /// one, because words already recorded are worth sending however the recording ended.
    func start(for owner: Owner, onSilence: (() -> Void)? = nil, onTaken: (() -> Void)? = nil,
               onFailure: @escaping @MainActor (Error) -> Void) {
        Speaker.shared.stop()   // his voice comes first: a recording ends any reply being read out
        begin(owner, onSilence: onSilence, onTaken: onTaken, onFailure: onFailure) { [weak self] in
            self?.setMuted(true)
            // The wrist is told the moment the microphone is actually live, not when it was asked
            // for: opening it takes a beat, and words spoken before this are not recorded. Commands
            // and follow-ups only — the always-on listener opens through `listen()`, and a tap on
            // every utterance it picks up would be noise.
            // A rising double tap and a chirp from the speaker: loud and plain enough to be the signal
            // to start talking, where the gentle `.start` tap was easy to miss.
            WKInterfaceDevice.current().play(.directionUp)
            self?.recorder.cue()
        }
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

    /// Takes the microphone for the listener. Only while nothing else owns it: a command and a
    /// follow-up come first, and the listener takes it back when they give it up.
    private func listen() {
        begin(.listener, onSilence: nil, onTaken: nil, onFailure: { [weak self] error in
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
        let muted = owner != .listener
        reset()
        if arming { arming = false; resumeSoon(); return nil }
        let clip = recorder.stop()
        if muted { setMuted(false) }
        resumeSoon()
        // Ending the recording handed the audio session back; a command still waiting holds it again.
        StayAwake.shared.sessionReleased()
        return clip
    }

    /// Ends the recording and throws it away.
    func cancel() {
        guard owner != nil else { return }
        let muted = owner != .listener
        reset()
        if arming { arming = false; resumeSoon(); return }
        recorder.cancel()
        if muted { setMuted(false) }
        resumeSoon()
        StayAwake.shared.sessionReleased()
    }

    /// Holds the recording open through silences, or lets the silence end it again.
    func toggleLock() {
        guard endsOnSilence else { return }
        locked.toggle()
        Hub.log("mic-lock", ["locked": locked])
    }

    private func begin(_ owner: Owner, onSilence: (() -> Void)?, onTaken: (() -> Void)?,
                       onFailure: @escaping @MainActor (Error) -> Void, opened: @escaping () -> Void) {
        // A command or a follow-up takes the microphone off the listener, which picks it up again when
        // they give it back (`resume`). Whatever it had heard by then still goes up.
        if owner != .listener, self.owner == .listener { unlisten() }
        guard self.owner == nil, !opening else {
            Hub.log("mic-refused", ["owner": String(describing: self.owner), "opening": opening])
            return
        }
        self.owner = owner
        // A command waiting on its answer may be holding the microphone to stay awake; this recording
        // holds it now, and one tap at a time.
        StayAwake.shared.sessionReleased()
        self.onSilence = onSilence
        self.onTaken = onTaken
        endsOnSilence = onSilence != nil || owner == .listener
        locked = false
        endpoint = Self.followsRoom
            ? Endpointer(hang: Self.hang, minimum: 0, ratio: Self.roomRatio)
            : Endpointer(hang: Self.hang, minimum: Self.speechMin)
        spokeAt = nil
        segment = 0
        arming = true
        opening = true
        if endsOnSilence { Task { await Self.readSettings() } }
        Task {
            defer { opening = false }
            do {
                try await recorder.start()
            } catch {
                arming = false
                reset()
                Hub.log("mic-failed", ["error": String(describing: error).prefix(120).description])
                onFailure(error)
                return
            }
            guard arming else { recorder.cancel(); return }   // stopped while the microphone opened
            arming = false
            Hub.log("mic-open", ["owner": String(describing: owner), "how": Self.trigger])
            opened()
        }
    }

    private func reset() {
        owner = nil
        onSilence = nil
        onTaken = nil
        endsOnSilence = false
        locked = false
    }

    /// Back to listening once the microphone is free again, if listening is engaged. Scheduled rather
    /// than immediate: a command TAKES the microphone off the listener, and an immediate resume would
    /// take it back before that command had started.
    func hush(_ on: Bool) {
        hushed = on
        if on { unlisten() } else { resumeSoon() }
    }

    private func resumeSoon() {
        guard listens, !hushed else { return }
        Task { @MainActor in
            guard listens, !hushed, owner == nil, !opening else { return }
            listen()
        }
    }

    /// Siri, a call or another app recording takes the microphone away mid-recording, and nothing can
    /// keep a recording through it. Words already recorded are sent (`onTaken`); a listener utterance
    /// that had begun goes up and the rest of the segment is dropped. When the microphone comes back,
    /// listening picks it up again — without this, always-on listening ended silently at the first Siri
    /// and the glyph went on claiming it was listening.
    private func interrupted(_ began: Bool) {
        guard began else { return resumeSoon() }
        Hub.log("mic-interrupted", ["owner": owner.map { String(describing: $0) } ?? "", "heard": endpoint.heard])
        switch owner {
        case .listener:
            unlisten()          // sends what was heard, if anything
        case .some:
            if endpoint.heard, let taken = onTaken { taken() } else { cancel() }
        case .none:
            break
        }
    }

    /// One buffer of audio from the recorder. Every recording is measured, even one that only a press
    /// can end, because the cap on a recording nobody speaks into protects all of them.
    private func heard(_ level: Float, _ seconds: TimeInterval) {
        guard let owner, !arming else { return }   // nothing counts until the mic is open
        let wasHeard = endpoint.heard
        endpoint.hang = Self.hang
        let ended = endpoint.feed(level, seconds)
        segment += seconds
        if endpoint.heard && !wasHeard { spokeAt = Date() }
        // Accidentally recording: nobody spoke into it, or it has run on and on unlocked. Either way
        // the microphone closes and the clip is thrown away rather than sent.
        let tooLong = owner == .listener && segment >= Self.longest
        if !locked && (tooLong || (!endpoint.heard && segment >= Self.unspoken)) {
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
            } else {
                logEnd("unspoken")
                cancel()
            }
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
                            "spoken": endpoint.spoken, "seconds": segment])
    }

    /// The two silence settings, from one read of the hub's settings.
    private static func readSettings() async {
        guard let all = try? await Hub.settings() else { return }
        if let v = all["watch_silence_s"].flatMap({ Double("\($0)") }), v > 0 { hang = v }
        if let v = all["watch_speech_min"].flatMap({ Float("\($0)") }), v > 0 { speechMin = v }
        followsRoom = all["watch_speech_mode"].map { "\($0)" } == "room"
        if let v = all["watch_speech_ratio"].flatMap({ Float("\($0)") }), v > 0 { roomRatio = v }
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
    /// buffer over the line is not speech**: a recording nobody spoke into ran 88 seconds on his watch,
    /// ended on a peak of 0.021 against a 0.02 line, and went up as "Thank you. Thank you." — which is
    /// what Whisper writes for silence, and the worker then ran it.
    static let minSpeech: TimeInterval = 0.4

    var hang: TimeInterval
    private(set) var floor: Float = .infinity
    private(set) var peak: Float = 0
    private(set) var heard = false
    /// Seconds over the line in the run of speech being counted now.
    private(set) var spoken: TimeInterval = 0
    private var quiet: TimeInterval = 0

    let minimum: Float
    /// How many times the room's quietest level counts as speech. 2.5 under a fixed `minimum`, which in
    /// a quiet room is the whole line; with no minimum (the `room` setting) this alone sets it.
    let ratio: Float

    init(hang: TimeInterval, minimum: Float, ratio: Float = 2.5) {
        self.hang = hang; self.minimum = minimum; self.ratio = ratio
    }

    var threshold: Float { max(floor * ratio, minimum) }

    /// Takes one buffer's level and length; true when that buffer ended the utterance.
    mutating func feed(_ level: Float, _ seconds: TimeInterval) -> Bool {
        // A buffer of exact digital silence (the microphone still opening) is not the room. Counted, it
        // would put the room's level, and with `ratio` alone the whole line, at zero.
        if level > 0 { floor = min(floor, level) }
        peak = max(peak, level)
        if level >= threshold {
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
