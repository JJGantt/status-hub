import AVFoundation
import MediaPlayer
import SwiftUI
import WatchKit

/// **Plays what the phone's microphone hears, live** (docs/LIVE-MIC.md). The phone streams it to the
/// hub (`LiveMic` in the iOS app); this holds `/api/live-mic` open and plays it as it arrives.
///
/// **A plain HTTP response, not a WebSocket**: watchOS refuses WebSockets on every network. The hub's
/// answer is one long body of AAC packets, read the way the event streams are read (`Hub.stream`).
///
/// **It holds the microphone so it keeps playing with the wrist down**, the same as `Speaker`: a watch
/// app that only plays is frozen the instant the wrist drops, one that records is kept running. What
/// the microphone hears is thrown away.
///
/// **A second of audio is gathered before it plays**, and again after any gap (`startAfter`), so the
/// unevenness of a cellular link is heard as a delay rather than as stutter. When the connection drops
/// (the switch from the phone's Bluetooth to the watch's own LTE does this) it reconnects with backoff
/// and starts again from the hub's last two seconds, dropping what was queued so nothing plays twice.
///
/// **AirPods connected to the watch play it** (`.allowBluetoothA2DP`): A2DP is output only, so the
/// watch's own microphone is still the one held.
///
/// **It is the Now Playing app while it listens** (`claimRemote`). AirPods send play and pause to
/// whichever app is Now Playing (ear detection, a squeeze); with no claim they went to Music, which then
/// started playing and took the audio session. Every command is taken here and does nothing: a live
/// stream has nothing to pause, and taking an AirPod out already moves the sound to the watch.
///
/// It logs how each stream connection reached the hub, read from the connection's own metrics when it
/// ends (`live-listen-conn`: cellular or not, through the phone or not), and how long each reconnect
/// took (`gap_ms`), which is what explains a cut-out.
@MainActor
final class LiveListen: ObservableObject {
    static let shared = LiveListen()

    enum State { case off, connecting, waiting, live }
    @Published private(set) var state = State.off
    var isOn: Bool { state != .off }

    static let rate: Double = 24000
    /// Frames queued before playback starts or resumes.
    private static let startAfter = AVAudioFrameCount(rate)

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    private var wired = false
    private var micHeld = false
    private var reader: Task<Void, Never>?
    /// Counts each connection's schedule, so callbacks from buffers dropped by a reconnect are ignored.
    private var schedule = 0
    /// Frames scheduled on the player and not yet played.
    private var queued: AVAudioFrameCount = 0
    private var playing = false
    /// When the stream last died, so the reconnect can say how long the gap was.
    private var lostAt: Date?
    /// The remote-command handlers registered while listening, removed on stop.
    private var remote: [(MPRemoteCommand, Any)] = []
    private let metrics = ConnectionLog()

    private init() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        // Each of these stops the engine underneath it with nothing else saying so.
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            let ended = AVAudioSession.InterruptionType(rawValue: raw) == .ended
            MainActor.assumeIsolated { if ended { self.restartAudio("interruption") } }
        }
        center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            MainActor.assumeIsolated { self.restartAudio("config-change") }
        }
        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { _ in
            MainActor.assumeIsolated { if self.isOn { Hub.log("live-listen-route", ["outputs": Self.outputs()]) } }
        }
        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { _ in
            MainActor.assumeIsolated { self.restartAudio("media-reset") }
        }
    }

    func toggle() { isOn ? stop() : start() }

    func start() {
        guard !isOn else { return }
        Speaker.shared.stop()          // one thing plays at a time
        Capture.shared.hush(true)      // the always-on listener stands aside; this holds the microphone
        StayAwake.shared.sessionReleased()
        guard startAudio() else { stop(); return }
        state = .connecting
        Hub.log("live-listen", ["on": true, "outputs": Self.outputs()])
        claimRemote()
        reader = Task { await self.read() }
    }

    func stop() {
        guard isOn else { return }
        reader?.cancel()
        reader = nil
        releaseRemote()
        lostAt = nil
        flush()
        engine.stop()
        releaseMic()
        state = .off
        Hub.log("live-listen", ["on": false])
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Capture.shared.hush(false)
        StayAwake.shared.sessionReleased()
    }

    // MARK: audio

    private func startAudio() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
            try session.setActive(true)
            if !wired {
                engine.attach(player)
                engine.connect(player, to: engine.mainMixerNode, format: format)
                wired = true
            }
            holdMic()
            if !engine.isRunning { try engine.start() }
            return true
        } catch {
            Hub.log("live-listen-failed", ["error": String(describing: error).prefix(120).description])
            return false
        }
    }

    private func holdMic() {
        guard !micHeld else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            Hub.log("live-listen-mic-failed", ["rate": format.sampleRate])
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

    /// The engine went down under it. What was queued is gone with it; the stream keeps arriving and
    /// refills from here.
    private func restartAudio(_ why: String) {
        guard isOn else { return }
        Hub.log("live-listen-restart", ["why": why])
        flush()
        releaseMic()
        engine.stop()
        if !startAudio() { stop() }
    }

    /// Drops everything queued, so a reconnect that resends the hub's last two seconds does not play
    /// them twice.
    private func flush() {
        schedule += 1
        player.stop()
        queued = 0
        playing = false
        if state == .live { state = .waiting }
    }

    private func play(_ pcm: AVAudioPCMBuffer) {
        guard isOn, pcm.frameLength > 0 else { return }
        let sched = schedule
        queued += pcm.frameLength
        player.scheduleBuffer(pcm, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, sched == self.schedule else { return }
                self.queued -= min(self.queued, pcm.frameLength)
                if self.queued == 0 && self.playing {
                    // Ran dry: gather again before resuming, rather than playing each packet as it lands.
                    self.player.pause()
                    self.playing = false
                    self.state = .waiting
                    Hub.log("live-listen-dry")
                }
            }
        }
        if !playing && queued >= Self.startAfter {
            if !engine.isRunning { try? engine.start() }
            player.play()
            playing = true
            state = .live
        }
    }

    private func claimRemote() {
        let center = MPRemoteCommandCenter.shared()
        for cmd in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.stopCommand,
                    center.nextTrackCommand, center.previousTrackCommand] {
            cmd.isEnabled = true
            let target = cmd.addTarget { _ in
                Task { @MainActor in Hub.log("live-listen-remote") }
                return .success
            }
            remote.append((cmd, target))
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: "Live Mic",
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
    }

    private func releaseRemote() {
        for (cmd, target) in remote { cmd.removeTarget(target) }
        remote = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private static func outputs() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType.rawValue).joined(separator: ",")
    }

    // MARK: the stream

    /// Holds the stream open for as long as it listens, reconnecting with backoff. Each packet is a
    /// 2-byte big-endian length and that many bytes; zero is the hub's keepalive.
    private func read() async {
        var backoff: Double = 0
        while !Task.isCancelled {
            do {
                // The hub sends at least a keepalive every 2s, so 5s of nothing is a dead connection: the
                // usual way is the move from the phone's Bluetooth to the watch's LTE, which can leave the
                // old connection silent rather than failed.
                let bytes = try await Hub.stream("/api/live-mic", idle: 5, delegate: metrics)
                guard let decoder = AACDecoder(rate: Self.rate) else {
                    Hub.log("live-listen-decoder-failed")
                    stop()
                    return
                }
                flush()
                state = .waiting
                backoff = 0
                Hub.log("live-listen-open", ["gap_ms": lostAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0])
                lostAt = nil
                var it = bytes.makeAsyncIterator()
                while let hi = try await it.next(), let lo = try await it.next() {
                    let n = Int(hi) << 8 | Int(lo)
                    guard n > 0 else { continue }
                    var packet = Data(capacity: n)
                    for _ in 0..<n {
                        guard let b = try await it.next() else { break }
                        packet.append(b)
                    }
                    guard packet.count == n else { break }
                    if let pcm = decoder.decode(packet) { play(pcm) }
                }
                Hub.log("live-listen-end")
            } catch {
                if !Task.isCancelled { Hub.log("live-listen-error", ["error": String(describing: error).prefix(120).description]) }
            }
            if lostAt == nil { lostAt = Date() }
            guard !Task.isCancelled else { return }
            state = .connecting
            // The first retry goes at once: a stream that died because the route changed is what this is
            // for, and the request itself waits for the new route. Only repeated failures back off.
            if backoff > 0 { try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000)) }
            backoff = max(1, min(backoff * 2, 30))
        }
    }
}

/// How a stream connection reached the hub, logged when it ends: the watch picks the route itself
/// (through the phone, Wi-Fi, its own cellular) and this is the one place an app can read which it was.
private final class ConnectionLog: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        guard let m = metrics.transactionMetrics.last else { return }
        let fields: [String: Any] = [
            "cellular": m.isCellular, "expensive": m.isExpensive, "constrained": m.isConstrained,
            "proxy": m.isProxyConnection, "local": m.localAddress ?? "", "secs": Int(metrics.taskInterval.duration),
        ]
        Task { @MainActor in Hub.log("live-listen-conn", fields) }
    }
}

/// One AAC-LC packet in, its PCM out, at the stream's rate, mono.
private final class AACDecoder {
    private let converter: AVAudioConverter
    private let aac: AVAudioFormat
    private let pcm: AVAudioFormat

    init?(rate: Double) {
        var desc = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
                                               mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
                                               mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard let aac = AVAudioFormat(streamDescription: &desc),
              let pcm = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: aac, to: pcm) else { return nil }
        self.aac = aac
        self.pcm = pcm
        self.converter = converter
    }

    func decode(_ packet: Data) -> AVAudioPCMBuffer? {
        let input = AVAudioCompressedBuffer(format: aac, packetCapacity: 1, maximumPacketSize: packet.count)
        packet.withUnsafeBytes { input.data.copyMemory(from: $0.baseAddress!, byteCount: packet.count) }
        input.byteLength = UInt32(packet.count)
        input.packetCount = 1
        input.packetDescriptions?[0] = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0,
                                                                    mDataByteSize: UInt32(packet.count))
        guard let out = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: 2048) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return input
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }
}

/// The last page: one control that starts and stops listening, and the crown as the volume while it
/// plays.
struct LiveListenView: View {
    @ObservedObject private var live = LiveListen.shared

    var body: some View {
        VStack(spacing: 10) {
            Spacer(minLength: 0)
            Button { live.toggle() } label: {
                Image(systemName: live.isOn ? "stop.fill" : "ear")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(live.isOn ? Color(hex: "#e5484d") : .white)
                    .frame(width: 90, height: 90)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Text(label)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(live.state == .live ? Color(hex: "#22c55e") : Color(white: 0.6))
            Spacer(minLength: 0)
            if live.isOn {
                VolumeKnob().frame(width: 44, height: 36).padding(.bottom, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
    }

    private var label: String {
        switch live.state {
        case .off: "Listen"
        case .connecting: "Connecting"
        case .waiting: "Waiting"
        case .live: "Live"
        }
    }
}
