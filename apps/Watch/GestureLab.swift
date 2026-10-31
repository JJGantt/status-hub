import SwiftUI
import CoreMotion
import AVFoundation
import WatchKit

/// **The gesture page: records raw motion around one gesture and uploads it, labelled.** The data is
/// for designing gestures of our own, and for finding out whether anything the app can see tells a
/// wrist flick (the system's dismiss gesture, which has no API) from simply lowering the wrist.
///
/// A capture is a fixed window (`seconds`) from the press, at 100 Hz device motion: attitude, rotation
/// rate, user acceleration and gravity. It ends by itself because the gestures worth recording are the
/// ones that take the app off the screen, so there is often no screen to press stop on. Alongside the
/// samples it records every change of the app's state (`events`: active, resign, background,
/// foreground, and the dimmed screen) on the same clock, which is the evidence for the flick question.
///
/// **It holds the microphone for the window and the upload**, throwing the audio away, for the reason
/// `StayAwake` does: watchOS keeps an app running wrist-down only while it records. Without it the
/// motion stream stops seconds after the wrist drops, which is the middle of the gesture. No workout
/// session is needed: 100 Hz is CMMotionManager's own rate, and only the 800 Hz batched sensors want one.
///
/// Uploads go to the hub (`POST /api/gestures`), which stores each capture as one JSON object in the
/// `gesture-captures` bucket. `GET /api/gestures` lists them.
@MainActor
final class GestureLab: ObservableObject {
    static let shared = GestureLab()

    enum Phase: Equatable { case idle, recording, sending, sent, failed }

    static let labels = ["flick", "lower", "raise", "other"]
    static let seconds = 8

    @Published private(set) var phase = Phase.idle
    @Published private(set) var left = 0
    @Published var label = labels[0]
    /// Captures uploaded since launch, so a run of them can be counted off on the wrist.
    @Published private(set) var sent = 0

    private let motion = CMMotionManager()
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        return q
    }()
    private let buffer = Buffer()
    private let engine = AVAudioEngine()
    private var holdingMic = false
    private var observers: [NSObjectProtocol] = []
    private var t0: TimeInterval = 0
    private var startedAt = Date()
    private var run = 0
    /// The last capture that failed to upload, kept for one retry.
    private var unsent: [String: Any]?

    private init() {}

    /// The page's button: start a capture, or end the one running early.
    func press() {
        switch phase {
        case .recording: finish()
        case .sending: break
        case .failed where unsent != nil: Task { await upload() }
        default: start()
        }
    }

    func nextLabel() {
        guard phase != .recording else { return }
        let i = Self.labels.firstIndex(of: label) ?? 0
        label = Self.labels[(i + 1) % Self.labels.count]
    }

    /// The dimmed screen comes from the page's environment, the only place watchOS reports it.
    func dimmed(_ on: Bool) { event(on ? "dim" : "undim") }

    private func start() {
        guard motion.isDeviceMotionAvailable else { phase = .failed; Hub.log("gesture-failed", ["error": "no device motion"]); return }
        buffer.reset()
        unsent = nil
        run += 1
        t0 = ProcessInfo.processInfo.systemUptime
        startedAt = Date()
        holdMic()
        watchAppState()
        motion.deviceMotionUpdateInterval = 1.0 / 100
        let base = t0
        let buffer = buffer
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { m, _ in
            guard let m else { return }
            let q = m.attitude.quaternion, r = m.rotationRate, u = m.userAcceleration, g = m.gravity
            buffer.add([m.timestamp - base, q.x, q.y, q.z, q.w, r.x, r.y, r.z, u.x, u.y, u.z, g.x, g.y, g.z])
        }
        phase = .recording
        left = Self.seconds
        WKInterfaceDevice.current().play(.start)
        Hub.log("gesture-start", ["label": label])
        let this = run
        Task { [weak self] in
            for s in stride(from: Self.seconds - 1, through: 0, by: -1) {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.run == this, self.phase == .recording else { return }
                self.left = s
            }
            guard let self, self.run == this, self.phase == .recording else { return }
            self.finish()
        }
    }

    private func finish() {
        motion.stopDeviceMotionUpdates()
        queue.waitUntilAllOperationsAreFinished()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        WKInterfaceDevice.current().play(.stop)
        let dev = WKInterfaceDevice.current()
        unsent = [
            "label": label,
            "started_at": ISO8601DateFormatter().string(from: startedAt),
            "rate_hz": 100,
            "seconds": Self.seconds,
            "fields": ["t", "qx", "qy", "qz", "qw", "rx", "ry", "rz", "ux", "uy", "uz", "gx", "gy", "gz"],
            "units": ["t": "s since press", "q": "attitude quaternion (xArbitraryZVertical)",
                      "r": "rad/s", "u": "g, gravity removed", "g": "g"],
            "samples": buffer.rows(),
            "events": buffer.events(),
            "device": ["model": dev.model, "os": dev.systemVersion,
                       "wrist": dev.wristLocation == .left ? "left" : "right",
                       "crown": dev.crownOrientation == .left ? "left" : "right"],
        ]
        Task { await upload() }
    }

    private func upload() async {
        guard let body = unsent else { return }
        phase = .sending
        do {
            let path = try await Hub.sendGesture(body)
            unsent = nil
            sent += 1
            phase = .sent
            Hub.log("gesture-sent", ["path": path, "samples": (body["samples"] as? [Any])?.count ?? 0])
        } catch {
            phase = .failed
            Hub.log("gesture-failed", ["error": String(describing: error).prefix(120).description])
        }
        releaseMic()
    }

    private func event(_ name: String) {
        guard phase == .recording else { return }
        buffer.mark(name, ProcessInfo.processInfo.systemUptime - t0)
    }

    private func watchAppState() {
        let nc = NotificationCenter.default
        let names: [(Notification.Name, String)] = [
            (WKApplication.didBecomeActiveNotification, "active"),
            (WKApplication.willResignActiveNotification, "resign"),
            (WKApplication.didEnterBackgroundNotification, "background"),
            (WKApplication.willEnterForegroundNotification, "foreground"),
        ]
        observers = names.map { name, label in
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.event(label) }
            }
        }
    }

    /// The same hold as `StayAwake.start`, for this capture only. Anything already holding the
    /// microphone keeps the app running by itself, so it stands aside for that.
    private func holdMic() {
        if Capture.shared.owner != nil || Speaker.shared.isSpeaking || LiveListen.shared.isOn { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetoothA2DP])
            try session.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
                Hub.log("gesture-mic-failed", ["error": "no microphone format"])
                return
            }
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in }
            try engine.start()
            holdingMic = true
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            Hub.log("gesture-mic-failed", ["error": String(describing: error).prefix(120).description])
        }
    }

    private func releaseMic() {
        guard holdingMic else { return }
        holdingMic = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        // A home command may be waiting on its answer, which StayAwake holds the microphone for.
        StayAwake.shared.sessionReleased()
    }

    /// Written from the motion queue, read on the main actor once the stream has stopped.
    private final class Buffer: @unchecked Sendable {
        private let lock = NSLock()
        private var samples: [[Double]] = []
        private var marks: [(String, Double)] = []

        func reset() { lock.withLock { samples = []; samples.reserveCapacity(1000); marks = [] } }
        func add(_ row: [Double]) { lock.withLock { samples.append(row) } }
        func mark(_ name: String, _ t: Double) { lock.withLock { marks.append((name, t)) } }
        /// Four decimals: past that it is sensor noise, and it halves the upload.
        func rows() -> [[Double]] { lock.withLock { samples.map { $0.map { ($0 * 10000).rounded() / 10000 } } } }
        func events() -> [[String: Any]] { lock.withLock { marks.map { ["ev": $0.0, "t": ($0.1 * 1000).rounded() / 1000] } } }
    }
}

/// The page right of the live mic. The button starts a capture (or ends one early, or retries a failed
/// upload); the word under it is the label, and a tap on it moves to the next one.
struct GestureLabView: View {
    @ObservedObject private var lab = GestureLab.shared
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        VStack(spacing: 8) {
            Spacer(minLength: 0)
            Button { lab.press() } label: {
                ZStack {
                    Circle().fill(lab.phase == .recording ? Color(hex: "#e5484d") : Color(white: 0.18))
                    if lab.phase == .recording {
                        Text("\(lab.left)").font(.system(size: 34, weight: .semibold, design: .rounded))
                    } else {
                        Image(systemName: icon).font(.system(size: 30, weight: .semibold))
                    }
                }
                .foregroundStyle(.white)
                .frame(width: 86, height: 86)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            Button { lab.nextLabel() } label: {
                Text(lab.label)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(lab.phase == .recording ? Color(white: 0.5) : .white)
                    .frame(maxWidth: .infinity, minHeight: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Text(status)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(lab.phase == .failed ? Color(hex: "#e5484d") : Color(white: 0.55))
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .onChange(of: dimmed) { _, on in lab.dimmed(on) }
    }

    private var icon: String {
        switch lab.phase {
        case .sending: "arrow.up"
        case .failed: "arrow.clockwise"
        default: "waveform.path"
        }
    }

    private var status: String {
        switch lab.phase {
        case .idle, .recording: lab.sent > 0 ? "\(lab.sent) sent" : " "
        case .sending: "Sending"
        case .sent: "\(lab.sent) sent"
        case .failed: "Failed"
        }
    }
}
