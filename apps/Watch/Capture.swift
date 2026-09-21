import Foundation

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
    /// When the microphone actually opened; nil while it is still opening.
    @Published private(set) var since: Date?
    /// This recording ends itself at the silence after speech, so it can be locked open.
    @Published private(set) var endsOnSilence = false
    /// Locked open: the silence no longer ends it, only a press does.
    @Published private(set) var locked = false

    /// Seconds of trailing silence that end an utterance: `watch_silence_s` in the hub's settings, read
    /// at every start and kept for the next, since a start does not wait on the hub.
    private static var hang: TimeInterval = 2

    /// Audio nobody has spoken in, after which the listener drops its segment and starts another rather
    /// than growing one file for as long as the room stays quiet (the phone's IDLE_CYCLE_MS).
    private static let idleCycle: TimeInterval = 30

    private let recorder = Recorder()
    /// Started, microphone not open yet. A stop in this window cancels instead of sending.
    private var arming = false
    /// The recorder is still opening, so no second start may begin even after a cancel.
    private var opening = false
    /// Mute writes run one after another, so an unmute can never land ahead of its own mute.
    private var muteTask: Task<Void, Never>?
    private var endpoint = Endpointer(hang: Capture.hang)
    /// Runs when the silence ends the recording: the owner sends it as if it had been pressed.
    private var onSilence: (() -> Void)?
    /// When the listener's current utterance first crossed the threshold, and how much audio its
    /// segment holds.
    private var spokeAt: Date?
    private var segment: TimeInterval = 0

    private init() {
        recorder.onLevel = { [weak self] level, seconds in self?.heard(level, seconds) }
    }

    /// Starts recording for `owner`, which is set at once so a second tap while the microphone opens is
    /// always a stop. Every other listener (Mac, ESP) goes deaf while it records, as it does for the
    /// phone's microphone, so one sentence cannot arrive twice.
    ///
    /// With `onSilence`, the recording ends itself once he has spoken and then stopped for the trailing
    /// silence, and calls it; `toggleLock()` holds it open. Without, only a press ends it.
    func start(for owner: Owner, onSilence: (() -> Void)? = nil, onFailure: @escaping @MainActor (Error) -> Void) {
        begin(owner, onSilence: onSilence, onFailure: onFailure) { [weak self] in self?.setMuted(true) }
    }

    /// The always-on listener: holds the microphone, cuts each utterance at the silence after it and
    /// sends it as its own command, until `unlisten`. It is a peer of the Mac and the ESP, not a command
    /// someone is holding the watch to say, so it mutes nothing and names itself `watch` with the
    /// utterance's own window (docs/LISTENERS.md). Nothing on screen engages it yet.
    func listen(onFailure: @escaping @MainActor (Error) -> Void) {
        begin(.listener, onSilence: nil, onFailure: onFailure) {}
    }

    /// Stops listening. An utterance under way still counts and goes up.
    func unlisten() {
        guard owner == .listener else { return }
        let from = spokeAt
        if endpoint.heard, let clip = stop() { upload(clip, from: from) } else { cancel() }
    }

    /// Ends the recording and hands back the clip; nil when the microphone never opened.
    func stop() -> Recorder.Clip? {
        guard owner != nil else { return nil }
        let muted = owner != .listener
        reset()
        if arming { arming = false; return nil }
        let clip = recorder.stop()
        if muted { setMuted(false) }
        return clip
    }

    /// Ends the recording and throws it away.
    func cancel() {
        guard owner != nil else { return }
        let muted = owner != .listener
        reset()
        if arming { arming = false; return }
        recorder.cancel()
        if muted { setMuted(false) }
    }

    /// Holds the recording open through silences, or lets the silence end it again.
    func toggleLock() {
        guard endsOnSilence else { return }
        locked.toggle()
        Hub.log("mic-lock", ["locked": locked])
    }

    private func begin(_ owner: Owner, onSilence: (() -> Void)?, onFailure: @escaping @MainActor (Error) -> Void,
                       opened: @escaping () -> Void) {
        guard self.owner == nil, !opening else {
            Hub.log("mic-refused", ["owner": String(describing: self.owner), "opening": opening])
            return
        }
        self.owner = owner
        self.onSilence = onSilence
        endsOnSilence = onSilence != nil || owner == .listener
        locked = false
        endpoint = Endpointer(hang: Self.hang)
        spokeAt = nil
        segment = 0
        arming = true
        opening = true
        if endsOnSilence { Task { await Self.readHang() } }
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
            since = Date()
            Hub.log("mic-open", ["owner": String(describing: owner)])
            opened()
        }
    }

    private func reset() {
        owner = nil
        since = nil
        onSilence = nil
        endsOnSilence = false
        locked = false
    }

    /// One buffer of audio from the recorder.
    private func heard(_ level: Float, _ seconds: TimeInterval) {
        guard let owner, since != nil, endsOnSilence else { return }
        let wasHeard = endpoint.heard
        endpoint.hang = Self.hang
        let ended = endpoint.feed(level, seconds)
        segment += seconds
        if endpoint.heard && !wasHeard { spokeAt = Date() }
        if owner == .listener {
            if ended {
                logEnd("silence")
                cutUtterance()
            } else if !endpoint.heard && segment >= Self.idleCycle {
                recorder.drop()
                endpoint.restart()
                segment = 0
            }
        } else if ended && !locked {
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
                let heard = try await Hub.sendAudio(clip, msgId: UUID().uuidString, listener: window)
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
                            "seconds": segment])
    }

    private static func readHang() async {
        guard let v = try? await Hub.setting("watch_silence_s"), let s = Double(v), s > 0 else { return }
        hang = s
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
/// (and above 0.02 whatever the floor), and once speech has been heard, `hang` seconds below that line
/// end it. Before any speech nothing ends — that is the leeway at the start — so a recording whose
/// speech never crossed the line is not cut short or thrown away; it simply waits for a press, as
/// every recording did before it could end itself.
struct Endpointer {
    var hang: TimeInterval
    private(set) var floor: Float = .infinity
    private(set) var peak: Float = 0
    private(set) var heard = false
    private var quiet: TimeInterval = 0

    init(hang: TimeInterval) { self.hang = hang }

    var threshold: Float { max(floor * 2.5, 0.02) }

    /// Takes one buffer's level and length; true when that buffer ended the utterance.
    mutating func feed(_ level: Float, _ seconds: TimeInterval) -> Bool {
        floor = min(floor, level)
        peak = max(peak, level)
        if level >= threshold {
            heard = true
            quiet = 0
            return false
        }
        guard heard else { return false }
        quiet += seconds
        return quiet >= hang
    }

    /// Ready for the next utterance. The floor is the room's, so it carries over.
    mutating func restart() {
        heard = false
        quiet = 0
        peak = 0
    }
}
