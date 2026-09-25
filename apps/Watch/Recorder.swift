import AVFoundation

/// The watch's microphone, recorded to temporary .m4a files (AAC, mono, 16 kHz). The hub transcribes a
/// clip through `/api/voice-command`, the same as the phone's microphone, so nothing here listens for
/// words — it only reports how loud each stretch of audio was (`onLevel`), which is what the silence
/// endpoint in `Capture` runs on.
///
/// An AVAudioEngine tap rather than AVAudioRecorder, for two reasons. The level arrives WITH the audio,
/// buffer by buffer; AVAudioRecorder's meters only answer when asked, on a timer. And the file can be
/// swapped for a fresh one inside the same callback (`cut`), so the always-on listener starts its next
/// utterance on the very next sample and never loses the onset of a word.
@MainActor
final class Recorder {
    struct Clip {
        let url: URL
        let duration: TimeInterval
    }

    enum Failure: Error {
        case denied
        case notStarted
    }

    /// Each buffer's RMS level (0…1) and how many seconds of audio it held, delivered on the main actor in
    /// the order they were recorded.
    var onLevel: ((Float, TimeInterval) -> Void)?
    /// The system took the microphone (Siri, a call, another app recording) — `true` — or gave it back,
    /// `false`. A recording cannot survive the first; the second is when a new one may start.
    var onInterruption: ((Bool) -> Void)?

    private let engine = AVAudioEngine()
    private var sink: Sink?
    /// The start chirp's voice, on the same engine as the microphone: one audio session that both plays
    /// and records, since a session set to record only plays nothing at all.
    private let player = AVAudioPlayerNode()
    private var playerWired = false
    /// Held while the chirp is sounding; the tap keeps none of that audio (`cue`).
    private let gate = CueGate()
    private var startedAt = Date()

    /// Asks for the microphone on first use, then starts recording.
    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default)
        try session.setActive(true)
        if !playerWired {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: Self.chirp.format)
            playerWired = true
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.notStarted }
        let sink = try Sink(input: format)
        let gate = self.gate
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            // The chirp is not his voice: it is neither kept in the clip nor counted by the endpoint,
            // where it would read as speech and let the silence after it send an empty command.
            if gate.closed { return }
            let level = sink.write(buffer)
            let seconds = Double(buffer.frameLength) / format.sampleRate
            // Main queue, not a Task: a queue keeps the buffers in order, which the endpoint's running
            // count of silent seconds depends on.
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onLevel?(level, seconds) } }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                                               object: session, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
            MainActor.assumeIsolated { self?.onInterruption?(began) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            sink.discard()
            throw Failure.notStarted
        }
        self.sink = sink
        startedAt = Date()
    }

    /// **"Talk now."** A short rising chirp from the speaker, played the moment the microphone is live.
    /// The tap drops what it hears until the chirp's own playback-finished callback opens the gate again,
    /// so the clip starts after the chirp and never contains it.
    func cue() {
        gate.closed = true
        player.scheduleBuffer(Self.chirp, completionCallbackType: .dataPlayedBack) { [gate] _ in gate.closed = false }
        player.play()
    }

    /// Two notes a fifth apart, C6 then G6, 70ms each, with short fades so neither clicks.
    private static let chirp: AVAudioPCMBuffer = {
        let rate = 44100.0
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let notes: [Double] = [1046.5, 1568.0]
        let each = Int(rate * 0.07), fade = Int(rate * 0.005)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(each * notes.count))!
        buffer.frameLength = buffer.frameCapacity
        let out = buffer.floatChannelData![0]
        for (n, hz) in notes.enumerated() {
            for i in 0..<each {
                let env = min(1, Double(min(i, each - 1 - i)) / Double(fade))
                out[n * each + i] = Float(0.6 * env * sin(2 * .pi * hz * Double(i) / rate))
            }
        }
        return buffer
    }()

    /// Ends the recording and hands back the finished file. The duration is wall-clock, since the file's
    /// own length is not known until the encoder has flushed it.
    func stop() -> Clip? {
        guard let sink = halt() else { return nil }
        return Clip(url: sink.finish(), duration: Date().timeIntervalSince(startedAt))
    }

    /// Ends the recording and throws the file away.
    func cancel() {
        halt()?.discard()
    }

    /// Keeps recording into a new file and hands back the one it was writing: the listener's cut between
    /// two utterances. No sample falls between the two files.
    func cut() -> Clip? {
        guard let sink else { return nil }
        let now = Date()
        defer { startedAt = now }
        return sink.cut().map { Clip(url: $0, duration: now.timeIntervalSince(startedAt)) }
    }

    /// Keeps recording into a new file and deletes the one it was writing: a stretch nobody spoke in.
    func drop() {
        if let url = sink?.cut() { try? FileManager.default.removeItem(at: url) }
        startedAt = Date()
    }

    @discardableResult
    private func halt() -> Sink? {
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification,
                                                 object: AVAudioSession.sharedInstance())
        guard let sink else { return nil }
        self.sink = nil
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        gate.closed = false
        engine.stop()
        // Hand the session back rather than just dropping it, so nothing is left looking like an app
        // holding the audio route.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return sink
    }
}

/// The file the tap writes into. `write` runs on the audio thread and everything else on the main actor,
/// so the file is only ever touched under the lock; a buffer still in flight after the tap is removed
/// finds no file and is dropped.
private final class Sink: @unchecked Sendable {
    private let lock = NSLock()
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    private var file: AVAudioFile?
    private var url: URL

    init(input: AVAudioFormat) throws {
        url = Self.newURL()
        let file = try Self.open(url)
        format = file.processingFormat
        guard let converter = AVAudioConverter(from: input, to: format) else { throw Recorder.Failure.notStarted }
        self.converter = converter
        self.file = file
    }

    /// Converts one buffer to the file's 16 kHz mono and appends it. Returns the buffer's RMS level.
    func write(_ buffer: AVAudioPCMBuffer) -> Float {
        let level = Self.rms(buffer)
        let frames = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return level }
        var fed = false
        var error: NSError?
        // `.noDataNow` rather than end-of-stream, so the resampler carries its state into the next buffer.
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        lock.lock()
        defer { lock.unlock() }
        if out.frameLength > 0 { try? file?.write(from: out) }
        return level
    }

    /// Closes the current file and opens the next. Returns the closed file, or nil if the next could not
    /// be opened — then the current one is kept and nothing is lost.
    func cut() -> URL? {
        let next = Self.newURL()
        guard let opened = try? Self.open(next) else { return nil }
        lock.lock()
        defer { lock.unlock() }
        let done = url
        file?.close()
        file = opened
        url = next
        return done
    }

    /// Closes the file and returns where it is.
    func finish() -> URL {
        lock.lock()
        defer { lock.unlock() }
        file?.close()
        file = nil
        return url
    }

    func discard() {
        try? FileManager.default.removeItem(at: finish())
    }

    private static func newURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
    }

    private static func open(_ url: URL) throws -> AVAudioFile {
        try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            // Starved bitrates have cost Whisper words before (HUB-INTERNALS, the phone's VOICE_BPS);
            // every clip's kbps is in the hub log as `[voice-command]`.
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        return (sum / Float(buffer.frameLength)).squareRoot()
    }
}

/// Whether the tap is dropping audio while the chirp sounds. Written on the main actor and in the
/// player's callback, read on the audio thread, so it is only touched under its lock.
private final class CueGate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var closed: Bool {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}
