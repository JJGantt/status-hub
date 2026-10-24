import AVFoundation

/// **Keeps the app running, wrist down, until the answers are in.** watchOS keeps a watch app running
/// with the wrist down only while it RECORDS. Recording covers a command until it is sent; after that
/// nothing did, so with the wrist down the app was frozen while it waited, the answer's tap never came,
/// and the screen still said it was working when he looked. So while a HOME command is waiting on its
/// answer this holds the microphone and throws away everything it hears, and lets go the moment nothing
/// is waiting.
///
/// Playing silence does NOT do this, though it looks like it should: a watch app that only plays is
/// frozen the instant the wrist drops, with its engine still reporting running and no notification
/// (measured with spoken replies, `Speaker`).
///
/// Anything already holding the microphone (a recording, the always-on listener, a reply being spoken,
/// the live mic)
/// keeps the app running by itself, so this stands aside for it.
///
/// It does not make a dimmed screen redraw any faster: with the wrist down watchOS redraws at most about
/// once a second whatever the app does, which is why the edge shows a steady ring then. What it buys is
/// that the app is still working when the answer lands, so the ring stops, the screen is current and the
/// wrist is tapped on time.
///
/// **Home commands only, never session follow-ups**: a session can work for many minutes, and holding
/// the microphone that long costs battery he does not want spent. The hub answers in seconds.
///
/// `refresh()` is called whenever what is waiting changes, and after anything that hands the audio
/// session back (a recording ending, a spoken reply finishing), since that stops this too.
@MainActor
final class StayAwake {
    static let shared = StayAwake()

    private let engine = AVAudioEngine()
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
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            holding = false
        }
        refresh()
    }

    private func start() {
        // A recording, the listener or a spoken reply already holds the microphone, which keeps the app
        // alive by itself; a second tap on it would fight theirs.
        if Capture.shared.owner != nil || Speaker.shared.isSpeaking || LiveListen.shared.isOn { return }
        if holding && engine.isRunning { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetoothA2DP])
            try session.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                Hub.log("stay-awake-failed", ["error": "no microphone format"])
                // `holding` never becomes true on this path, so `stop()` would be a no-op forever and
                // the session claimed just above would sit active until something else overrides it.
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
                return
            }
            if !holding { input.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in } }
            if !engine.isRunning { try engine.start() }
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
            engine.inputNode.removeTap(onBus: 0)
            Hub.log("stay-awake-failed", ["error": String(describing: error).prefix(120).description])
        }
    }

    private func stop() {
        guard holding else { return }
        holding = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Hub.log("stay-awake", ["on": false])
    }
}
