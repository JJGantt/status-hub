import AVFoundation
import WatchKit
import WidgetKit

/// **Reads a session's reply aloud**, on the watch, with the system's own voice — no synthesis machine,
/// no audio sent anywhere. On when `session_speech` is on (the watch's Settings page, the hub's
/// Settings, and the Speak control in Control Center); then a reply to a follow-up sent FROM the watch
/// is spoken as it lands, and the follow-up carries `Sessions.spokenFormat` so the reply is written to
/// be heard.
///
/// **The app plays the voice itself, so it carries on with the wrist down.** `synth.speak` hands the
/// words to the system's speech service, and the app is not the one making the sound — so when the
/// wrist drops and the app goes to the background it is suspended mid-sentence, which stops the voice.
/// Instead the synthesizer only RENDERS (`write`), and the buffers play through the app's own audio
/// engine under `.playback`: an app playing audio is kept running in the background
/// (`UIBackgroundModes: audio`), the same way a music app is.
///
/// **The always-on listener stands aside while it speaks** (`Capture.hush`) — otherwise it transcribes
/// the watch's own voice as a command — and picks the microphone back up when the speaking ends. It is
/// paused, not switched off. Starting a recording stops the speaking at once: his voice wins.
@MainActor
final class Speaker: ObservableObject {
    static let shared = Speaker()
    static let key = "session_speech"
    /// Whether session replies are spoken. Kept in `SharedState`, where the Control Center toggle reads
    /// it too, and brought up to date from the hub whenever the app comes to the front (`WatchSettings`).
    static var enabled: Bool { SharedState.speech }
    /// The same flag for a view to watch: the Settings page's toggle.
    @Published private(set) var on = SharedState.speech

    private let synth = AVSpeechSynthesizer()
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
    private var speaking = false
    private var startedAt = Date()

    private init() {
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
        // The reply is asked for in plain speech, but markdown can still slip in; what is SAID is the
        // text with its syntax gone.
        let words = String(snippet(reply).characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        halt()
        Capture.shared.hush(true)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
        } catch {
            Hub.log("speak-failed", ["error": String(describing: error).prefix(120).description])
        }
        let u = AVSpeechUtterance(string: words)
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        turn += 1
        let this = turn
        buffers = []
        played = 0
        rendered = false
        speaking = true
        startedAt = Date()
        Hub.log("speak", ["chars": words.count, "outputs": Self.outputs()])
        synth.write(u) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            Task { @MainActor in self?.take(pcm, turn: this) }
        }
    }

    /// One rendered piece of the reply. A buffer with no frames is the synthesizer saying it is done.
    private func take(_ pcm: AVAudioPCMBuffer, turn this: Int) {
        guard this == turn, speaking else { return }
        guard pcm.frameLength > 0 else {
            rendered = true
            Hub.log("speak-rendered", ["seconds": seconds(buffers[...]), "ms": ms()])
            if played == buffers.count { finished("done") }
            return
        }
        buffers.append(pcm)
        if wired != pcm.format {
            // A new format means rewiring, which throws away what the player had queued: queue the
            // rest again from the first unplayed buffer.
            resume("format")
            return
        }
        enqueue(buffers.count - 1)
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
        if !player.isPlaying { player.play() }
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
        guard speaking, !(engine.isRunning && player.isPlaying) else { return }
        Hub.log("speak-stalled", ["engine": engine.isRunning, "player": player.isPlaying])
        resume("wake")
    }

    /// Stops mid-sentence: a recording is starting, and his voice comes first.
    func stop() {
        guard speaking else { return }
        halt()
        finished("stopped")
    }

    /// Silences whatever is playing and drops whatever is still being rendered.
    private func halt() {
        turn += 1
        synth.stopSpeaking(at: .immediate)
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
        Hub.log("speak-end", ["how": how, "played": seconds(buffers[..<played]), "ms": ms()])
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Capture.shared.hush(false)
        StayAwake.shared.sessionReleased()   // a home command still waiting takes the audio back
    }

    /// Sets it — the Speak toggle's action — on the watch at once and on the hub, and taps the wrist up
    /// for on and down for off.
    static func set(_ on: Bool) {
        SharedState.speech = on
        shared.on = on
        WKInterfaceDevice.current().play(on ? .directionUp : .directionDown)
        if !on { shared.stop() }
        redrawControl()
        Task { await Hub.putSetting(key, on ? "1" : "0") }
    }

    /// Control Center draws the toggle from the value it last read; it reads again only when told.
    /// Brings the published flag in line after the hub changed it (`WatchSettings`).
    static func reload() { shared.on = SharedState.speech }

    static func redrawControl() {
        if #available(watchOS 26.0, *) {
            ControlCenter.shared.reloadControls(ofKind: "com.jaredgantt.statushub.watch.speak")
        }
    }

}
