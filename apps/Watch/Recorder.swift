import AVFoundation

/// One voice clip at a time, recorded to a temporary .m4a (AAC, mono, 16 kHz). The hub transcribes it
/// through `/api/voice-command`, the same as the phone's microphone, so nothing here listens for words.
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

    private var recorder: AVAudioRecorder?
    private var startedAt = Date()

    /// Asks for the microphone on first use, then starts recording.
    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
        let r = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            // Starved bitrates have cost Whisper words before (HUB-INTERNALS, the phone's VOICE_BPS);
            // every clip's kbps is in the hub log as `[voice-command]`.
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
        guard r.record() else { throw Failure.notStarted }
        recorder = r
        startedAt = Date()
    }

    /// Ends the recording and hands back the finished file. The duration is wall-clock, because an
    /// interrupted recorder reports zero for its own.
    func stop() -> Clip? {
        guard let r = recorder else { return nil }
        r.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        return Clip(url: r.url, duration: Date().timeIntervalSince(startedAt))
    }

    /// Ends the recording and throws the file away.
    func cancel() {
        guard let r = recorder else { return }
        r.stop()
        r.deleteRecording()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
