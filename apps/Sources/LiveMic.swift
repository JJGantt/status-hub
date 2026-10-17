#if os(iOS)
import AVFoundation
import WebKit

/// **The phone's microphone, streamed live to the hub** for the watch to play (docs/LIVE-MIC.md).
/// Started from the Stream button in the hub page's Utilities (`cards/livemic.js`, message `liveMic`);
/// it keeps going with the phone locked, because the app declares background audio and a recording
/// app is kept running.
///
/// Native rather than the page's own microphone: WebKit stops a page's capture the moment the app
/// leaves the screen, and the phone is meant to be put down.
///
/// **The whole room, unprocessed.** `.default` mode, not `.voiceChat`: voice processing treats music and
/// effects as noise and cuts them, which is the opposite of what a phone left in a theatre is for.
///
/// Packets are AAC-LC, 24 kHz mono, ~32 kbit/s, each sent as a 2-byte big-endian length and its bytes
/// (`lib/livemic.js` has the wire format). The capture keeps running while the socket reconnects, and
/// what it hears in that gap is held (`held`) and sent first when the socket opens, so the hub's copy has
/// no hole for a resuming watch to miss.
///
/// Logs to the hub as `src: phone` (`livemic*` in `client_log`): on and off, each socket opening and
/// ending, interruptions. A line written while the phone has no connection is lost.
@MainActor
final class LiveMic: NSObject, URLSessionWebSocketDelegate {
    static let shared = LiveMic()
    weak var web: WKWebView?

    enum State: String { case off, connecting, live, denied }
    private var state = State.off
    private var listeners = 0

    private let engine = AVAudioEngine()
    private var tapped = false
    /// Encodes on its own queue, off the audio thread and off the main thread.
    private let queue = DispatchQueue(label: "livemic.encode")
    private nonisolated(unsafe) var encoder: Encoder?
    private lazy var urls = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    private nonisolated(unsafe) var socket: URLSessionWebSocketTask?
    private nonisolated(unsafe) var open = false
    /// Messages encoded while the socket is down, oldest first, sent when it opens. Touched on `queue`.
    private nonisolated(unsafe) var held: [(message: Data, packets: Int)] = []
    private nonisolated(unsafe) var heldPackets = 0
    /// The hub keeps five minutes for a resuming watch (`RING_MS`); holding more than that here buys nothing.
    private static let holdPackets = Int(5 * 60 * Encoder.rate / 1024)
    /// Counts each connection, so a failure from a socket already replaced does not tear down the new one.
    private var attempt = 0
    private var backoff: Double = 1

    private override init() {
        super.init()
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        // A call or Siri takes the microphone; when it is handed back the engine has stopped and nothing
        // restarts it on its own.
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            let ended = AVAudioSession.InterruptionType(rawValue: raw) == .ended
            MainActor.assumeIsolated {
                if self.state != .off { self.log("livemic-interrupted", ["ended": ended]) }
                if ended { self.restartCapture() }
            }
        }
        // A route change (headphones in or out) can change the input format, which the tap was built on.
        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            MainActor.assumeIsolated { self.restartCapture() }
        }
        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { _ in
            MainActor.assumeIsolated { self.restartCapture() }
        }
    }

    // MARK: the page

    func handle(_ body: Any) {
        guard let msg = body as? [String: Any] else { return }
        if let on = msg["on"] as? Bool {
            if on { Task { await start() } } else { stop() }
        } else {
            report()
        }
    }

    private func set(_ s: State) {
        state = s
        report()
    }

    private func report() {
        let js = "window.dispatchEvent(new CustomEvent('hub:livemic',{detail:{state:'\(state.rawValue)',listeners:\(listeners)}}))"
        web?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: on and off

    private func start() async {
        guard state == .off || state == .denied else { return }
        guard await AVAudioApplication.requestRecordPermission() else { set(.denied); log("livemic-denied"); return }
        set(.connecting)
        log("livemic", ["on": true])
        guard startCapture() else { stop(); return }
        connect()
    }

    func stop() {
        guard state != .off else { return }
        attempt += 1
        stopCapture()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        open = false
        queue.async { self.held = []; self.heldPackets = 0 }
        listeners = 0
        backoff = 1
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        set(.off)
        log("livemic", ["on": false])
    }

    // MARK: capture

    private func startCapture() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker])
            try session.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0, let enc = Encoder(from: format) else {
                log("livemic-failed", ["error": "no input format"])
                return false
            }
            queue.sync { encoder = enc }
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                self?.queue.async { self?.encode(buffer) }
            }
            tapped = true
            engine.prepare()
            try engine.start()
            return true
        } catch {
            log("livemic-failed", ["error": String(describing: error).prefix(120).description])
            stopCapture()
            return false
        }
    }

    private func stopCapture() {
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        engine.stop()
        queue.sync { encoder = nil }
    }

    private func restartCapture() {
        guard state == .connecting || state == .live else { return }
        log("livemic-restart")
        stopCapture()
        if !startCapture() { stop() }
    }

    /// One tap buffer in, its AAC packets out as one message. Runs on `queue`.
    private nonisolated func encode(_ buffer: AVAudioPCMBuffer) {
        guard let packets = encoder?.encode(buffer), !packets.isEmpty else { return }
        var message = Data()
        for p in packets {
            message.append(UInt8(p.count >> 8))
            message.append(UInt8(p.count & 0xff))
            message.append(p)
        }
        if open, let socket {
            socket.send(.data(message)) { _ in }   // a failed send surfaces as the socket closing
            return
        }
        held.append((message, packets.count))
        heldPackets += packets.count
        while heldPackets > Self.holdPackets, !held.isEmpty {
            heldPackets -= held.removeFirst().packets
        }
    }

    /// The socket is up: what was held goes first, in order, and only then does `encode` send straight
    /// through. Runs on `queue`, so nothing encoded meanwhile can overtake it.
    private nonisolated func release(to socket: URLSessionWebSocketTask) {
        for h in held { socket.send(.data(h.message)) { _ in } }
        held = []
        heldPackets = 0
        open = true
    }

    // MARK: the log

    private func log(_ ev: String, _ fields: [String: Any] = [:]) {
        var line = fields
        line["src"] = "phone"
        line["ev"] = ev
        line["t"] = ISO8601DateFormatter().string(from: Date())
        guard let token = Auth.token(), let body = try? JSONSerialization.data(withJSONObject: line) else { return }
        var req = URLRequest(url: URL(string: Auth.host + "/api/clientlog")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        req.httpBody = body
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: the socket

    private func connect() {
        guard state == .connecting || state == .live, let token = Auth.token() else { stop(); return }
        attempt += 1
        var req = URLRequest(url: URL(string: Auth.host.replacingOccurrences(of: "https://", with: "wss://") + "/api/live-mic/up")!)
        req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        let task = urls.webSocketTask(with: req)
        socket = task
        open = false
        task.resume()
        receive(task, attempt: attempt)
    }

    /// Reads what the hub says back (how many are listening) until the socket fails, then reconnects.
    private func receive(_ task: URLSessionWebSocketTask, attempt this: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, this == self.attempt else { return }
                switch result {
                case .success(.string(let text)):
                    if let d = text.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                       let n = obj["listeners"] as? Int {
                        self.listeners = n
                        self.report()
                        self.log("livemic-listeners", ["n": n])
                    }
                    self.receive(task, attempt: this)
                case .success:
                    self.receive(task, attempt: this)
                case .failure(let error):
                    self.log("livemic-socket-ended", ["error": String(describing: error).prefix(120).description])
                    self.reconnect()
                }
            }
        }
    }

    /// The connection dropped (a dead spot, the hub redeploying). The microphone stays on; the socket
    /// comes back with backoff, so a hub that is down is not hammered.
    private func reconnect() {
        guard state == .connecting || state == .live else { return }
        open = false
        socket = nil
        set(.connecting)
        let this = attempt
        let wait = backoff
        backoff = min(backoff * 2, 30)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(wait))
            guard this == self.attempt, self.state == .connecting else { return }
            self.connect()
        }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated {
            guard webSocketTask === self.socket else { return }
            self.queue.async { self.release(to: webSocketTask) }
            self.backoff = 1
            self.set(.live)
            self.log("livemic-socket-open")
        }
    }
}

/// The device's microphone format in, AAC-LC packets out: resampled to 24 kHz mono, then encoded.
private final class Encoder {
    static let rate: Double = 24000
    private let resampler: AVAudioConverter
    private let aac: AVAudioConverter
    private let mono: AVAudioFormat
    /// Resampled audio waiting for the encoder, which takes it 1024 frames a packet.
    private var pending: [AVAudioPCMBuffer] = []

    init?(from input: AVAudioFormat) {
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.rate, channels: 1, interleaved: false),
              let resampler = AVAudioConverter(from: input, to: mono) else { return nil }
        var desc = AudioStreamBasicDescription(mSampleRate: Self.rate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
                                               mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
                                               mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard let aacFormat = AVAudioFormat(streamDescription: &desc),
              let aac = AVAudioConverter(from: mono, to: aacFormat) else { return nil }
        aac.bitRate = 32000
        self.mono = mono
        self.resampler = resampler
        self.aac = aac
    }

    func encode(_ buffer: AVAudioPCMBuffer) -> [Data] {
        let ratio = Self.rate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return [] }
        var fed = false
        var error: NSError?
        resampler.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if error != nil || out.frameLength == 0 { return [] }
        pending.append(out)

        var packets: [Data] = []
        while true {
            let compressed = AVAudioCompressedBuffer(format: aac.outputFormat, packetCapacity: 8,
                                                     maximumPacketSize: max(aac.maximumOutputPacketSize, 1536))
            let status = aac.convert(to: compressed, error: &error) { _, status in
                guard !self.pending.isEmpty else { status.pointee = .noDataNow; return nil }
                status.pointee = .haveData
                return self.pending.removeFirst()
            }
            if let descs = compressed.packetDescriptions {
                for i in 0..<Int(compressed.packetCount) {
                    let d = descs[i]
                    packets.append(Data(bytes: compressed.data.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize)))
                }
            }
            if status != .haveData || compressed.packetCount == 0 { break }
        }
        return packets
    }
}
#endif
