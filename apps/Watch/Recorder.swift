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

    private let engine = AVAudioEngine()
    private var sink: Sink?
    private var startedAt = Date()

    /// Asks for the microphone on first use, then starts recording.
    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.notStarted }
        let sink = try Sink(input: format)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            let level = sink.write(buffer)
            let seconds = Double(buffer.frameLength) / format.sampleRate
            // Main queue, not a Task: a queue keeps the buffers in order, which the endpoint's running
            // count of silent seconds depends on.
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onLevel?(level, seconds) } }
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
        guard let sink else { return nil }
        self.sink = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
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
