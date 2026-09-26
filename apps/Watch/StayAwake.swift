import AVFoundation

/// **Keeps the app running, wrist down, until the answers are in.** A watch app is kept alive in the
/// background only while it plays or records audio. Recording covers a command until it is sent; after
/// that nothing did, so with the wrist down the app was suspended while it waited, the answer's tap
/// never came, and the screen still said it was working when he looked. So while a HOME command is
/// waiting on its answer this plays SILENCE (mixed with others, so it interrupts nothing he is listening to)
/// and stops the moment none is.
///
/// It does not make a dimmed screen redraw any faster: with the wrist down watchOS redraws at most about
/// once a second whatever the app does, which is why the edge shows a steady ring then. What it buys is
/// that the app is still working when the answer lands, so the ring stops, the screen is current and the
/// wrist is tapped on time.
///
/// **Home commands only, never session follow-ups**: a session can work for many minutes, and holding
/// the audio that long costs battery he does not want spent. The hub answers in seconds.
///
/// `refresh()` is called whenever what is waiting changes, and after anything that hands the audio
/// session back (a recording ending, a spoken reply finishing), since that stops this too.
@MainActor
final class StayAwake {
    static let shared = StayAwake()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var wired = false
    private var holding = false
    /// The most it holds for in one go, his number: past this an answer that has not come is not worth
    /// the battery to wait on awake, and the app goes back to being suspended as usual.
    private static let longest: TimeInterval = 60
    /// Counts each hold, so the cut-off for an earlier one cannot end a later one.
    private var hold = 0
    /// The minute ran out on this wait: nothing restarts the hold until nothing is waiting any more.
    private var spent = false

    private init() {}

    /// Holds or lets go to match what is waiting now.
    func refresh() {
        if !Chat.shared.waiting { spent = false; stop() } else if !spent { start() }
    }

    /// Something else just deactivated the audio session (a recording ending, a spoken reply
    /// finishing). The engine can still report running over a session that is off, which keeps nothing
    /// alive, so it is taken down and started again if a command is still waiting.
    func sessionReleased() {
        if holding {
            player.stop()
            engine.stop()
            holding = false
        }
        refresh()
    }

    private func start() {
        // A recording or a spoken reply owns the session while it runs, and keeps the app alive itself.
        if Capture.shared.owner != nil && Capture.shared.owner != .listener { return }
        if holding && engine.isRunning { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            if !wired {
                engine.attach(player)
                engine.connect(player, to: engine.mainMixerNode, format: Self.silence.format)
                wired = true
            }
            if !engine.isRunning { try engine.start() }
            player.scheduleBuffer(Self.silence, at: nil, options: .loops)
            player.play()
            if !holding {
                hold += 1
                let this = hold
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(Self.longest))
                    guard let self, self.holding, self.hold == this else { return }
                    self.spent = true
                    self.stop()
                }
            }
            if !holding { Hub.log("stay-awake", ["on": true]) }
            holding = true
        } catch {
            Hub.log("stay-awake-failed", ["error": String(describing: error).prefix(120).description])
        }
    }

    private func stop() {
        guard holding else { return }
        holding = false
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Hub.log("stay-awake", ["on": false])
    }

    /// A second of silence, looped.
    private static let silence: AVAudioPCMBuffer = {
        let format = AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 22050)!
        buffer.frameLength = buffer.frameCapacity   // zero-filled: silence
        return buffer
    }()
}
