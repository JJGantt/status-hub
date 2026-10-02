import AVFoundation
import MediaPlayer
import WatchKit
import WidgetKit

/// **Reads a session's reply aloud**, on the watch, with the system's own voice — no synthesis machine,
/// no audio sent anywhere. On when `session_speech` is on (the watch's Settings page, the hub's
/// Settings, and the Speak control in Control Center); then a reply to a follow-up sent FROM the watch
/// is spoken as it lands. The reply is written exactly as it would be with speech off; only its
/// markdown syntax is dropped before it is said.
///
/// **Two ways to keep the app running with the wrist down, picked on the watch's Settings page and
/// mirrored on the hub's** (`watch_speech_route`, `SpeechRoute`): watchOS keeps a watch app alive
/// wrist-down only while it plays under specific conditions, and there are two conditions that qualify.
///
/// **`.hold` (the default) holds the microphone.** The app is `.playAndRecord` and taps the microphone,
/// discarding what it hears, for exactly as long as the voice plays (`holdMic`) — the same mechanism a
/// command recording uses. Reliable, measured working, and it means the microphone shows as in use for
/// the length of a reply.
///
/// **`.nowPlaying` asks watchOS to treat the reply as a song**, `.playback` with `routeSharingPolicy:
/// .longFormAudio`, published to `MPNowPlayingInfoCenter` with play/pause/stop registered on
/// `MPRemoteCommandCenter` — the Digital Crown and AirPods controls a real audio app gets, and no
/// microphone use at all. **Not yet confirmed on a real watch**: whether watchOS keeps an app that is
/// never `.playAndRecord` in this route alive under this alone, and whether the watch opens its own Now
/// Playing screen over the session whenever a reply starts.
///
/// **The always-on listener stands aside while it speaks** (`Capture.hush`) — otherwise it transcribes
/// the watch's own voice as a command — and picks the microphone back up when the speaking ends. It is
/// paused, not switched off. Starting a recording stops the speaking at once: his voice wins.
@MainActor
final class Speaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = Speaker()
    static let key = "session_speech"
    /// Whether session replies are spoken. Kept in `SharedState`, where the Control Center toggle reads
    /// it too, and brought up to date from the hub whenever the app comes to the front (`WatchSettings`).
    static var enabled: Bool { SharedState.speech }
    /// The same flag for a view to watch: the Settings page's toggle.
    @Published private(set) var on = SharedState.speech
    /// How loud the voice plays, in percent of the watch's own volume (10…100, steps of 10): the watch's
    /// Settings page and the hub's (`watch_speech_volume`). Applies to a reply already playing.
    @Published private(set) var volume = Speaker.storedVolume
    static let volumeKey = "watch_speech_volume"

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
    /// Whether a reply is being spoken, which holds the microphone (`StayAwake` stands aside for it).
    var isSpeaking: Bool { speaking }
    private var micHeld = false
    private var startedAt = Date()
    private var replyTitle = "Reply"
    private var commandsRegistered = false

    /// Which way the reply is kept alive with the wrist down. Kept in `UserDefaults` and mirrored to
    /// the hub, the same as the volume.
    @Published private(set) var route = Speaker.storedRoute
    static let routeKey = "watch_speech_route"

    private override init() {
        super.init()
        synth.delegate = self
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

    func speak(_ reply: String, title: String = "Reply") {
        // The reply is written markdown; what is SAID is its text with the syntax gone.
        let words = MarkdownBlock.spoken(reply)
        guard !words.isEmpty else { return }
        halt()
        Capture.shared.hush(true)
        replyTitle = title
        turn += 1
        let this = turn
        speaking = true
        StayAwake.shared.sessionReleased()   // the reply owns the audio session now; one tap at a time
        startAudio { [weak self] ok in
            guard let self, this == self.turn, self.speaking else { return }
            guard ok else { self.finished("no-route"); return }
            self.render(words, turn: this)
        }
    }

    /// Claims the session the way the current route needs, and only calls back once it is really live:
    /// `.nowPlaying`'s activation is asynchronous and its own answer is whether it will play at all.
    private func startAudio(_ completion: @escaping (Bool) -> Void) {
        let session = AVAudioSession.sharedInstance()
        switch route {
        case .hold:
            do {
                // Play AND record: an app holding the microphone is kept running with the wrist down
                // (the same as a command recording), where a session that only plays is frozen the
                // moment the wrist drops — the engine and player still report running, no notification
                // comes, and the voice stops mid-word. So while it speaks the microphone is held and
                // what it hears is discarded (`holdMic`). The always-on listener has stood aside
                // (`Capture.hush`), so the microphone is free.
                try session.setCategory(.playAndRecord, mode: .default)
                try session.setActive(true)
                completion(true)
            } catch {
                Hub.log("speak-failed", ["error": String(describing: error).prefix(120).description])
                completion(false)
            }
        case .nowPlaying:
            do {
                try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
            } catch {
                Hub.log("speak-failed", ["error": String(describing: error).prefix(120).description])
                completion(false)
                return
            }
            session.activate(options: []) { ok, error in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        Hub.log("speak-activate", ["ok": ok, "outputs": Self.outputs(),
                                                   "error": error.map { String(describing: $0).prefix(120).description } ?? ""])
                    }
                    completion(ok)
                }
            }
        }
    }

    private func render(_ words: String, turn this: Int) {
        let u = AVSpeechUtterance(string: words)
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        buffers = []
        played = 0
        rendered = false
        startedAt = Date()
        switch route {
        case .hold: holdMic()
        case .nowPlaying: setUpNowPlaying(words: words)
        }
        Hub.log("speak", ["chars": words.count, "outputs": Self.outputs(), "route": route.rawValue])
        synth.write(u) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            Task { @MainActor in self?.take(pcm, turn: this) }
        }
    }

    /// One rendered piece of the reply. A buffer with no frames is the synthesizer saying it is done.
    private func take(_ pcm: AVAudioPCMBuffer, turn this: Int) {
        guard this == turn, speaking else { return }
        // An empty buffer marks the end of a stretch the synthesizer rendered, not of the reply: it sends
        // several. The end of the reply is the delegate's `didFinish`.
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

    /// Publishes the reply as a track and registers play/pause/stop once. The duration is a rough
    /// words-per-minute guess — the synthesizer has not rendered anything yet — and is not corrected:
    /// good enough for a scrub bar's rough shape, not worth another log line to fix up.
    private func setUpNowPlaying(words: String) {
        registerRemoteCommandsIfNeeded()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: replyTitle,
            MPMediaItemPropertyPlaybackDuration: Double(words.split(separator: " ").count) / 2.5,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
    }

    /// Play, pause and stop from the Now Playing screen or AirPods — only live in `.nowPlaying`, since
    /// `.hold` has no pause (a tap stops it outright, `CommandBorder.press`). Registered once and left
    /// registered; the guard on `route` is what keeps them inert in `.hold`.
    private func registerRemoteCommandsIfNeeded() {
        guard !commandsRegistered else { return }
        commandsRegistered = true
        let center = MPRemoteCommandCenter.shared()
        center.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.remotePause() }
            return .success
        }
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.remotePlay() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.player.isPlaying ? self.remotePause() : self.remotePlay()
            }
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
            return .success
        }
    }

    private func remotePause() {
        guard speaking, route == .nowPlaying else { return }
        player.pause()
        Hub.log("speak-pause")
        setNowPlayingRate(0)
    }

    private func remotePlay() {
        guard speaking, route == .nowPlaying else { return }
        player.play()
        Hub.log("speak-play")
        setNowPlayingRate(1)
    }

    private func setNowPlayingRate(_ rate: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
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
        player.volume = Float(volume) / 100
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

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.renderedAll() }
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
        releaseMic()
        if route == .nowPlaying { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        Hub.log("speak-end", ["how": how, "played": seconds(buffers[..<played]), "ms": ms(), "route": route.rawValue])
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

    /// Sets the voice's volume here and on the hub.
    func setVolume(_ percent: Int) {
        let v = Self.clamp(percent)
        guard v != volume else { return }
        apply(volume: v)
        Task { await Hub.putSetting(Self.volumeKey, "\(v)") }
    }

    /// Takes a volume the hub sent (`WatchSettings`), without writing it back.
    func apply(volume v: Int) {
        volume = Self.clamp(v)
        UserDefaults.standard.set(volume, forKey: Self.volumeKey)
        player.volume = Float(volume) / 100
    }

    private static func clamp(_ v: Int) -> Int { min(100, max(10, (v + 5) / 10 * 10)) }

    private static var storedVolume: Int {
        let v = UserDefaults.standard.integer(forKey: volumeKey)
        return v == 0 ? 100 : clamp(v)
    }

    /// Sets which route keeps the app alive — the Settings page's segmented control — here and on the
    /// hub. Changes only the NEXT reply: switching mid-reply would tear down whichever session and
    /// registrations the current one is using.
    func setRoute(_ r: SpeechRoute) {
        guard r != route else { return }
        route = r
        UserDefaults.standard.set(r.rawValue, forKey: Self.routeKey)
        Task { await Hub.putSetting(Self.routeKey, r.rawValue) }
    }

    /// Takes a route the hub sent (`WatchSettings`), without writing it back.
    func apply(route raw: String) {
        guard let r = SpeechRoute(rawValue: raw), r != route else { return }
        route = r
        UserDefaults.standard.set(r.rawValue, forKey: Self.routeKey)
    }

    private static var storedRoute: SpeechRoute {
        SpeechRoute(rawValue: UserDefaults.standard.string(forKey: routeKey) ?? "") ?? .hold
    }

    /// Brings the published flag in line after the hub changed it (`WatchSettings`).
    static func reload() { shared.on = SharedState.speech }

    static func redrawControl() {
        if #available(watchOS 26.0, *) {
            ControlCenter.shared.reloadControls(ofKind: "com.jaredgantt.statushub.watch.speak")
        }
    }

}

/// Which way a reply is kept playing with the wrist down (`Speaker`'s header doc has the tradeoffs).
enum SpeechRoute: String {
    case hold = "hold"
    case nowPlaying = "nowplaying"
}
