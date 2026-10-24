import AVFoundation
import WatchKit

/// **Reads a session's reply aloud**, on the watch, in the hub's voice: the reply goes to `/api/tts` and
/// comes back as audio a chunk at a time (`lib/speech.js` on the server owns the model, the voice and
/// the splitting, so changing any of them needs no build). Chunk 0 plays the moment it lands and the
/// rest are fetched while it plays. Only when asked: the speaker glyph at the foot of a session's page
/// plays that session's last reply (`SessionView.playButton`), and nothing is ever spoken unprompted.
///
/// **It holds the microphone so it keeps talking with the wrist down.** The app is `.playAndRecord` and
/// taps the microphone, discarding what it hears, for exactly as long as the voice plays (`holdMic`) —
/// the same mechanism a command recording uses. Asking watchOS to treat the reply as long-form audio
/// (`.playback` with `.longFormAudio` and Now Playing) does not keep it running: tried on the watch, it
/// did not play wrist-down at all.
///
/// **It pauses and carries on** (`pause`, `unpause`): the reply stays queued, the microphone stays held,
/// and the voice picks up where it stopped.
///
/// **AirPods connected to the watch play it** (`.allowBluetoothA2DP`, as `LiveListen` does): A2DP is
/// output only, so the watch's own microphone is still the one held.
///
/// **The voice plays at full; the watch's own volume is the only knob**, and while a reply plays the
/// crown turns it (`VolumeKnob`, shown by `SessionView`).
///
/// **The always-on listener stands aside while it speaks** (`Capture.hush`) — otherwise it transcribes
/// the watch's own voice as a command — and picks the microphone back up when the speaking ends. It is
/// paused, not switched off. Starting a recording stops the speaking at once: his voice wins.
@MainActor
final class Speaker: NSObject, ObservableObject {
    static let shared = Speaker()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// The format the player is wired for; rewired only if a voice renders in a different one.
    private var wired: AVAudioFormat?
    /// Counts each reply, so buffers still arriving from a stopped one are dropped.
    private var turn = 0
    /// Every buffer of the reply rendered so far, in order, and how many have finished playing. Kept so
    /// that when the audio is cut out from under the player, it picks up from the first unplayed one.
    private var buffers: [AVAudioPCMBuffer] = []
    private var played = 0
    /// Counts each scheduling of the buffers, so callbacks from a schedule that was torn down (a resume
    /// re-queues what is left) are not counted twice.
    private var schedule = 0
    private var rendered = false
    @Published private var speaking = false
    /// Whether a reply is being spoken, which holds the microphone (`StayAwake` stands aside for it).
    var isSpeaking: Bool { speaking }
    private var micHeld = false
    private var startedAt = Date()
    /// Paused part way: everything stays queued, and nothing starts the player until `unpause`.
    @Published private(set) var paused = false


    private override init() {
        super.init()
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        // Each of these can stop the engine under a reply without any callback firing, which is how a
        // reply went quiet halfway and never counted as finished. Each is logged, and each resumes.
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
            let why = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
            MainActor.assumeIsolated {
                guard self.speaking else { return }
                Hub.log("speak-interrupted", ["began": began, "reason": why.map { $0 as Any } ?? NSNull()])
                if !began { self.resume("interruption-ended") }
            }
        }
        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            MainActor.assumeIsolated {
                guard self.speaking else { return }
                Hub.log("speak-config-change", ["outputs": Self.outputs()])
                self.resume("config-change")
            }
        }
        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { _ in
            MainActor.assumeIsolated {
                guard self.speaking else { return }
                Hub.log("speak-media-reset")
                self.wired = nil
                self.resume("media-reset")
            }
        }
    }

    func speak(_ reply: String) {
        // The reply is written markdown; what is SAID is its text with the syntax gone.
        let words = MarkdownBlock.spoken(reply)
        guard !words.isEmpty else { return }
        halt()
        LiveListen.shared.stop()   // one thing plays at a time
        Capture.shared.hush(true)
        turn += 1
        let this = turn
        speaking = true
        StayAwake.shared.sessionReleased()   // the reply owns the audio session now; one tap at a time
        startAudio { [weak self] ok in
            guard let self, this == self.turn, self.speaking else { return }
            guard ok else { self.finished("no-route"); return }
            self.render(reply, words: words, turn: this)
        }
    }

    /// Claims the audio session.
    private func startAudio(_ completion: @escaping (Bool) -> Void) {
        let session = AVAudioSession.sharedInstance()
        do {
            // Play AND record: an app holding the microphone is kept running with the wrist down
            // (the same as a command recording), where a session that only plays is frozen the
            // moment the wrist drops — the engine and player still report running, no notification
            // comes, and the voice stops mid-word. So while it speaks the microphone is held and
            // what it hears is discarded (`holdMic`). The always-on listener has stood aside
            // (`Capture.hush`), so the microphone is free. `.allowBluetoothA2DP` lets AirPods
            // connected to the watch play it — without it they are not a route at all, so choosing
            // them in the watch's output picker drops them back to the speaker.
            try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
            try session.setActive(true)
            completion(true)
        } catch {
            Hub.log("speak-failed", ["error": String(describing: error).prefix(120).description])
            completion(false)
        }
    }

    private func render(_ reply: String, words: String, turn this: Int) {
        buffers = []
        played = 0
        rendered = false
        startedAt = Date()
        holdMic()
        Hub.log("speak", ["chars": words.count, "outputs": Self.outputs()])
        Task { await self.fetch(reply, turn: this) }
    }

    /// Every chunk in order, each played as soon as it is decoded. One at a time is enough: a chunk is
    /// a second or two to render and ten or so to speak, so the next is always in hand first.
    private func fetch(_ reply: String, turn this: Int) async {
        var of = 1
        var i = 0
        while i < of {
            do {
                let got = try await Hub.tts(reply, chunk: i)
                guard this == turn, speaking else { return }
                of = got.of
                guard let pcm = Self.decode(got.audio) else { throw HubError.status(0) }
                take(pcm, turn: this)
                if i == 0 { Task { await Hub.ttsTiming(["first_ms": ms(), "of": of]) } }
            } catch {
                guard this == turn, speaking else { return }
                Hub.log("speak-failed", ["chunk": i, "error": String(describing: error).prefix(120).description])
                if buffers.isEmpty { finished("failed"); return }
                break
            }
            i += 1
        }
        guard this == turn else { return }
        renderedAll()
    }

    /// A WAV from the hub as one PCM buffer. AVAudioFile reads only from a file, so it goes through one.
    private static func decode(_ wav: Data) -> AVAudioPCMBuffer? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tts-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            try wav.write(to: url)
            let file = try AVAudioFile(forReading: url)
            guard let pcm = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                             frameCapacity: AVAudioFrameCount(file.length)) else { return nil }
            try file.read(into: pcm)
            return pcm
        } catch {
            return nil
        }
    }

    /// One decoded chunk of the reply.
    private func take(_ pcm: AVAudioPCMBuffer, turn this: Int) {
        guard this == turn, speaking else { return }
        guard pcm.frameLength > 0 else { return }
        buffers.append(pcm)
        if wired != pcm.format {
            // A new format means rewiring, which throws away what the player had queued: queue the
            // rest again from the first unplayed buffer.
            resume("format")
            return
        }
        enqueue(buffers.count - 1)
    }

    /// Taps the microphone and throws away what it hears. The tap is what makes this a recording app
    /// for as long as it speaks, which is what keeps it running with the wrist down.
    private func holdMic() {
        guard !micHeld else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            Hub.log("speak-mic-failed", ["rate": format.sampleRate])
            return
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in }
        micHeld = true
    }

    private func releaseMic() {
        guard micHeld else { return }
        engine.inputNode.removeTap(onBus: 0)
        micHeld = false
    }

    /// Queues one buffer on the current schedule.
    private func enqueue(_ i: Int) {
        let this = turn, sched = schedule
        do {
            if !engine.isRunning { try engine.start() }
        } catch {
            Hub.log("speak-failed", ["error": String(describing: error).prefix(120).description])
            finished("failed")
            return
        }
        player.scheduleBuffer(buffers[i], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, this == self.turn, sched == self.schedule, self.speaking else { return }
                self.played = max(self.played, i + 1)
                if self.rendered && self.played == self.buffers.count { self.finished("done") }
            }
        }
        if !paused && !player.isPlaying { player.play() }
    }

    /// Picks the reply up from the first buffer that has not played: after anything that stopped the
    /// engine under it, or when the app comes back to the front and finds it silent.
    private func resume(_ why: String) {
        guard speaking else { return }
        schedule += 1
        player.stop()
        let format = buffers.last?.format
        if let format, wired != format {
            if wired == nil { engine.attach(player) }
            engine.connect(player, to: engine.mainMixerNode, format: format)
            wired = format
        }
        try? AVAudioSession.sharedInstance().setActive(true)
        if why != "format" {
            Hub.log("speak-resume", ["why": why, "played": seconds(buffers[..<played]),
                                     "rendered": seconds(buffers[...]), "done": rendered])
        }
        guard played < buffers.count else {
            if rendered { finished("done") }
            return
        }
        for i in played..<buffers.count { enqueue(i) }
    }

    /// The app came to the front. A reply still counted as speaking with the player silent was cut
    /// off while the wrist was down; it carries on from where it stopped.
    func checkOnWake() {
        guard speaking, !paused, !(engine.isRunning && player.isPlaying) else { return }
        Hub.log("speak-stalled", ["engine": engine.isRunning, "player": player.isPlaying])
        resume("wake")
    }

    /// Everything is rendered; the reply is over once the player has played it all.
    private func renderedAll() {
        guard speaking, !rendered else { return }
        rendered = true
        Hub.log("speak-rendered", ["seconds": seconds(buffers[...]), "ms": ms()])
        if played == buffers.count { finished("done") }
    }

    /// Stops mid-sentence: a recording is starting, and his voice comes first.
    func stop() {
        guard speaking else { return }
        halt()
        finished("stopped")
    }

    /// Holds the voice where it is. Chunks still arriving are queued behind it, not played.
    func pause() {
        guard speaking, !paused else { return }
        paused = true
        player.pause()
        Hub.log("speak-pause", ["played": seconds(buffers[..<played])])
    }

    /// Carries on from where it paused. If the engine went down while it was paused (an interruption,
    /// the wrist), it is rebuilt from the first unplayed chunk instead.
    func unpause() {
        guard speaking, paused else { return }
        paused = false
        Hub.log("speak-unpause")
        if engine.isRunning { player.play() } else { resume("unpause") }
    }

    /// Silences whatever is playing and drops whatever is still being rendered.
    private func halt() {
        turn += 1
        paused = false
        player.stop()
    }

    private func seconds(_ list: ArraySlice<AVAudioPCMBuffer>) -> Double {
        (list.reduce(0.0) { $0 + Double($1.frameLength) / $1.format.sampleRate } * 10).rounded() / 10
    }

    private func ms() -> Int { Int(Date().timeIntervalSince(startedAt) * 1000) }

    private static func outputs() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue).joined(separator: ",")
    }

    /// The engine and the audio session go back and the listener, if it was on, takes the microphone
    /// again. The recorder claims its own category every time it starts, so nothing has to be restored.
    private func finished(_ how: String) {
        guard speaking else { return }
        speaking = false
        engine.stop()
        releaseMic()
        paused = false
        Hub.log("speak-end", ["how": how, "played": seconds(buffers[..<played]), "ms": ms()])
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Capture.shared.hush(false)
        StayAwake.shared.sessionReleased()   // a home command still waiting takes the audio back
    }
}
