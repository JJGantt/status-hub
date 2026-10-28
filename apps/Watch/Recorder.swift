import AVFoundation
import SoundAnalysis

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
        /// When the microphone went live for this file — what a pressed command sends as its
        /// `capture_start`, since that is the moment a voice-logged set is stamped with.
        let start: Date
        let duration: TimeInterval
        /// Seconds of audio the microphone actually delivered into the file. Far short of `duration`
        /// means the microphone went deaf, which the hub would otherwise only report as an empty clip.
        var heard: TimeInterval = 0
        /// The loudest buffer written (RMS, 0…1): 0 with `heard` > 0 is a live microphone recording silence.
        var peak: Float = 0
        /// Whether the start chirp was heard to finish playing; false means the speaker never sounded it.
        var chirped: Bool?
        /// Recorded in the `locked` flow: the hub sends it to the larger Whisper and shortens its long pauses.
        var locked = false
        /// A locked recording's stretches of no speech, `[start, end]` in seconds of the file, as the
        /// speech classifier (or the level line, without it) heard them. Only those of `Capture.quietMin`
        /// or more; the hub decides which of them are long enough to shorten.
        var quiet: [[TimeInterval]] = []
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
    var onInterruption: ((Bool, [String: Any]) -> Void)?
    /// Run Apple's sound classifier over the recording (`watch_speech_mode` = `voice`). Read at `start`.
    var classifies = false
    /// How sure the classifier is that the last half second was speech (0…1), on the main actor, about
    /// four times a second. Only while `classifying`.
    var onVoice: ((Float) -> Void)?
    /// The classifier is actually running on this recording: asked for, and the model loaded.
    var classifying: Bool { detector != nil }
    /// The classifier's working time as a fraction of the audio it has been fed: its cost on this watch.
    var classifierLoad: Double? { detector?.load }
    private var detector: VoiceDetector?
    /// Rewind's ring (`Rewind.swift`): fed every buffer, whoever's recording this is, while it is set.
    /// Set or cleared on a recording already running, which is how engaging rewind under the listener
    /// starts filling it at once.
    var tee: RewindTee? { didSet { sink?.tee = tee } }

    private let engine = AVAudioEngine()
    private var sink: Sink?
    /// The start chirp's voice, on the same engine as the microphone: one audio session that both plays
    /// and records, since a session set to record only plays nothing at all.
    private let player = AVAudioPlayerNode()
    private var playerWired = false
    /// Counts off the chirp's length of input; the tap keeps none of that audio (`cue`).
    private let gate = CueGate()
    private var startedAt = Date()
    /// Whether the first buffer from the microphone has arrived since `start`, logged once as `mic-live`.
    private let firstBuffer = Flag()
    /// Whether the chirp played through: nil when none was asked for this recording.
    private var chirped: Bool?
    private var observers: [NSObjectProtocol] = []

    /// Asks for the microphone on first use, then starts recording. With `keepsFile` false nothing is
    /// written to disk — the microphone only feeds `tee` and the levels, which is all rewind wants.
    func start(keepsFile: Bool = true) async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
        try session.setActive(true)
        Hub.log("mic-route", Self.describe(session))
        if !playerWired {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: Self.chirp.format)
            playerWired = true
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.notStarted }
        let sink = try Sink(input: format, keepsFile: keepsFile)
        sink.tee = tee
        let detector = classifies ? VoiceDetector(format: format, report: { [weak self] speech in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onVoice?(speech) } }
        }) : nil
        if classifies && detector == nil { Hub.log("voice-classifier", ["ok": false]) }
        let gate = self.gate
        let firstBuffer = self.firstBuffer
        firstBuffer.set(false)
        let opened = Date()
        chirped = nil
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            if !firstBuffer.getAndSet(true) {
                let ms = Int(Date().timeIntervalSince(opened) * 1000)
                DispatchQueue.main.async { Hub.log("mic-live", ["ms": ms, "rate": format.sampleRate]) }
            }
            // The chirp is not his voice: it is neither kept in the clip nor counted by the endpoint,
            // where it would read as speech and let the silence after it send an empty command.
            let seconds = Double(buffer.frameLength) / format.sampleRate
            if gate.swallow(seconds) { return }
            let level = sink.write(buffer)
            detector?.analyze(buffer)
            // Main queue, not a Task: a queue keeps the buffers in order, which the endpoint's running
            // count of silent seconds depends on.
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onLevel?(level, seconds) } }
        }
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: session,
                               queue: .main) { [weak self] note in
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
                let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
                // What the system says about it, for the log: `reason` (0 default — Siri, a call, an
                // alarm; 1 app suspended; 2 built-in mic muted; 3 route disconnected) and, on an end,
                // `options` (1 = may resume). Raw numbers, so a value this build does not name still shows.
                let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
                let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
                MainActor.assumeIsolated {
                    guard let self else { return }
                    var fields = Self.describe(session)
                    fields["reason"] = reason.map { $0 as Any } ?? NSNull()
                    fields["options"] = options.map { $0 as Any } ?? NSNull()
                    fields["recording"] = Date().timeIntervalSince(self.startedAt)
                    self.onInterruption?(began, fields)
                }
            },
            // The route changing under a recording (headphones, the system taking the speaker) is the
            // kind of thing that silently changes what the microphone hears.
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session,
                               queue: .main) { note in
                let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
                MainActor.assumeIsolated {
                    var fields = Self.describe(session)
                    fields["reason"] = raw
                    Hub.log("mic-route-change", fields)
                }
            },
            // A configuration change STOPS the engine, and a stopped engine delivers no more audio: the
            // recording would carry on looking live and send an empty clip. So it is started again.
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine,
                               queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.sink != nil else { return }
                    do {
                        try self.engine.start()
                        Hub.log("mic-engine-restart", ["ok": true])
                    } catch {
                        Hub.log("mic-engine-restart", ["ok": false, "error": String(describing: error).prefix(120).description])
                    }
                }
            },
        ]
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            sink.discard()
            throw Failure.notStarted
        }
        self.sink = sink
        self.detector = detector
        startedAt = Date()
    }

    /// **"Talk now."** A short rising chirp from the speaker, played the moment the microphone is live.
    /// The tap drops the chirp's length of input, plus the route's latency either way, so the clip
    /// starts after the chirp and never contains it. Counted in the microphone's own samples rather than
    /// opened by the chirp's playback callback: that callback does not always come, and a gate waiting
    /// on it stayed shut for the whole recording and sent an empty clip.
    func cue() {
        let session = AVAudioSession.sharedInstance()
        let chirp = Double(Self.chirp.frameLength) / Self.chirp.format.sampleRate
        gate.hold(chirp + session.outputLatency + session.inputLatency)
        chirped = false
        let asked = Date()
        player.scheduleBuffer(Self.chirp, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            let ms = Int(Date().timeIntervalSince(asked) * 1000)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.chirped = true
                    Hub.log("chirp-done", ["ms": ms])
                }
            }
        }
        player.play()
        Hub.log("chirp", ["engine": engine.isRunning, "playing": player.isPlaying])
    }

    /// What the audio session is set to and where sound goes in and out: the first thing to read when a
    /// recording comes back empty or the chirp is not heard.
    static func describe(_ session: AVAudioSession) -> [String: Any] {
        [
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "inputs": session.currentRoute.inputs.map(\.portType.rawValue).joined(separator: ","),
            "outputs": session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ","),
            "otherAudio": session.isOtherAudioPlaying,
            "inputAvailable": session.isInputAvailable,
        ]
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
        return Clip(url: sink.finish(), start: startedAt, duration: Date().timeIntervalSince(startedAt), heard: sink.heard,
                    peak: sink.peak, chirped: chirped)
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
        return sink.cut().map { Clip(url: $0, start: startedAt, duration: now.timeIntervalSince(startedAt)) }
    }

    /// Keeps recording into a new file and deletes the one it was writing: a stretch nobody spoke in.
    func drop() {
        if let url = sink?.cut() { try? FileManager.default.removeItem(at: url) }
        startedAt = Date()
    }

    @discardableResult
    private func halt() -> Sink? {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let sink else { return nil }
        self.sink = nil
        engine.inputNode.removeTap(onBus: 0)
        detector?.finish()
        detector = nil
        player.stop()
        gate.hold(0)
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
    /// Rewind's ring, fed the converted audio before the file is. Read on the audio thread, under the lock.
    private var teeing: RewindTee?
    var tee: RewindTee? {
        get { lock.withLock { teeing } }
        set { lock.withLock { teeing = newValue } }
    }
    private var written: TimeInterval = 0
    private var loudest: Float = 0
    /// Seconds of audio written into the current file.
    var heard: TimeInterval { lock.withLock { written } }
    /// The loudest buffer written into the current file.
    var peak: Float { lock.withLock { loudest } }

    init(input: AVAudioFormat, keepsFile: Bool = true) throws {
        url = Self.newURL()
        let file = keepsFile ? try Self.open(url) : nil
        // The file's processing format, spelled out so a sink with no file converts to the same thing.
        format = file?.processingFormat
            ?? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
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
        if out.frameLength > 0 { teeing?.write(out) }
        if out.frameLength > 0, let file {
            try? file.write(from: out)
            written += Double(out.frameLength) / format.sampleRate
            loudest = max(loudest, level)
        }
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
        written = 0
        loudest = 0
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
/// A flag the audio thread can read and set.
private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set(_ v: Bool) { lock.withLock { value = v } }
    /// Sets it and returns what it was.
    func getAndSet(_ v: Bool) -> Bool { lock.withLock { defer { value = v }; return value } }
}

private final class CueGate: @unchecked Sendable {
    private let lock = NSLock()
    private var left: TimeInterval = 0
    /// Drops the next `seconds` of input.
    func hold(_ seconds: TimeInterval) { lock.withLock { left = seconds } }
    /// Whether this buffer falls inside what is being dropped; counts it off either way.
    func swallow(_ seconds: TimeInterval) -> Bool {
        lock.withLock {
            guard left > 0 else { return false }
            left -= seconds
            return true
        }
    }
}

/// Apple's built-in sound classifier (SoundAnalysis, `.version1`, 303 labels, on the device), asked one
/// thing: how likely the last half second was to be SPEECH. It is what lets the silence endpoint ignore
/// a snap, a tap, a door, a zipper or a running tap — loud enough to cross any level line, and none of
/// them speech. Measured on 25 of his kept watch commands (`docs/WATCH.md` § It ends itself at the
/// silence): those noises score under 0.3, his talking over 0.5, and his quiet speech that falls under
/// the level line still scores as speech.
///
/// Half-second windows, a new one every quarter second. The analysis runs on its own queue, never the
/// tap's audio thread, and the verdict reaches `Capture` a beat behind the audio it describes.
final class VoiceDetector: NSObject, SNResultsObserving, @unchecked Sendable {
    private let analyzer: SNAudioStreamAnalyzer
    private let queue = DispatchQueue(label: "voice-detector")
    private let report: (Float) -> Void
    /// Frames handed to the analyzer so far; touched only on `queue`.
    private var position: AVAudioFramePosition = 0
    private let lock = NSLock()
    private var busy: TimeInterval = 0
    private var audio: TimeInterval = 0

    init?(format: AVAudioFormat, report: @escaping (Float) -> Void) {
        analyzer = SNAudioStreamAnalyzer(format: format)
        self.report = report
        super.init()
        guard let request = try? SNClassifySoundRequest(classifierIdentifier: .version1) else { return nil }
        request.windowDuration = CMTime(seconds: 0.5, preferredTimescale: 1000)
        request.overlapFactor = 0.5
        do { try analyzer.add(request, withObserver: self) } catch { return nil }
    }

    func analyze(_ buffer: AVAudioPCMBuffer) {
        queue.async { [self] in
            let began = Date()
            analyzer.analyze(buffer, atAudioFramePosition: position)
            position += AVAudioFramePosition(buffer.frameLength)
            let spent = Date().timeIntervalSince(began)
            let seconds = Double(buffer.frameLength) / buffer.format.sampleRate
            lock.withLock { busy += spent; audio += seconds }
        }
    }

    var load: Double { lock.withLock { audio > 0 ? busy / audio : 0 } }

    func finish() {
        queue.async { [self] in analyzer.completeAnalysis() }
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        report(Float(result.classification(forIdentifier: "speech")?.confidence ?? 0))
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        let text = String(describing: error).prefix(120).description
        DispatchQueue.main.async { Hub.log("voice-classifier", ["ok": false, "error": text]) }
    }
}
