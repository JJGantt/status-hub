#if os(iOS)
import AVFoundation
import AudioToolbox
import UIKit
import UserNotifications
import WebKit

/// **The page's mic buttons record here, natively, so a recording survives leaving the app.** WebKit
/// stops a page's capture the moment the app leaves the screen, so a command recorded through
/// `getUserMedia` loses everything said in another app. An `AVAudioEngine` under the app's `audio`
/// background mode keeps recording behind any other app, the way the watch does.
///
/// The page drives it (message `nativeRec`, `makeRecorder` in voiceagent.js): `{op:'start', id}`,
/// `{op:'stop', id}`, `{op:'cancel', id}`, and `{op:'reset'}` as a page loads. It answers on
/// `hub:nativerec` with `{id, state}`: `rec` once capturing, `stall` with `on` while the hub is not acknowledging its stream,
/// `broken` with `why` when it stopped itself,
/// `done` with the clip as base64 AAC, its recorded seconds and its `stream` id, `error` with why. The clip
/// then goes up through the page's own outbox, exactly as a WebKit clip does.
///
/// **It streams to the hub while it records** (`NativeChunks` below, `/api/voice-chunk`): the AAC encoded
/// so far goes up once a second and each chunk is acknowledged. A chunk unacknowledged for six seconds, or
/// an acknowledgement saying the capture is `damaged` (holding under half the time recorded), STOPS THE
/// RECORDING at once: it buzzes, keeps and sends everything recorded so far, and tells the page, which says
/// so and reports it. docs/VOICE-ON-THE-PHONE.md § Every pressed recording streams to the hub.
///
/// **An interruption pauses the recording and the end of it carries on into the same file** (a call,
/// Siri, a timer): the engine stops, the stream is told `paused`, and the engine restarts into the same
/// file when the system hands the microphone back. Paused time is not counted as recorded time.
/// **A `began` is only believed once the audio has actually stopped arriving.** iOS posts some that stop
/// nothing (another audio client in the app, the page's own AudioContext), and taking one at its word
/// showed Paused and stopped the clock over a recording that went on capturing every word. So `began`
/// waits `confirmGap` and pauses only if no buffer reached the file meanwhile; otherwise it is logged
/// (`nativerec-interrupt-ignored`) and the recording carries on. The page is told `paused` and `rec`
/// here rather than reading the raw notification (`pauses` on the first `rec` says so).
/// Every confirmed pause has its end: `nativerec-resumed` when the microphone comes back, and a recording
/// that finishes still paused is reported (`nativerec-interrupt-unended`).
///
/// **The built-in microphone, never AirPods** — the same rule as the page's (`acquireBuiltIn`): opening
/// AirPods' mic drops the link into the hands-free profile.
///
/// The session is given back as it was found (category, mode, options) and NOT deactivated, for the
/// reason `AlarmAudio` gives: WebKit does not re-activate a session it believes is already up.
///
/// Logs to the hub as `src: phone` (`nativerec*` in `client_log`).
@MainActor
final class NativeRec: NSObject {
    static let shared = NativeRec()
    weak var web: WKWebView?

    private var engine: AVAudioEngine?
    private var id = ""
    private var file: URL?
    private var writer: AVAudioFile?
    private var stream: NativeChunks?
    private var tick: Timer?
    private var found: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
    private var interrupted = false
    private var pausedAt: Date?     // when the confirmed interruption began, for its matching end
    /// What the recording is, for the hub: its source label, and whether it is a dictation rather than a
    /// command (a dictation is never enqueued from its stream).
    private var source = "web"
    private var dry = false
    /// Seconds recorded: the running stretch since `since`, plus every stretch before an interruption.
    private var banked: TimeInterval = 0
    private var since: Date?
    /// Buffers written so far, touched only on `q`: whether audio is still arriving after an interruption.
    private let frames = BufferCount()
    private let confirmGap: TimeInterval = 0.6
    /// The audio thread's work (conversion, the file, the encoder) runs here, never on the main thread.
    private let q = DispatchQueue(label: "native-rec")
    /// 16 kHz mono: what Whisper reads, and the watch's format.
    private let speech = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                                               object: AVAudioSession.sharedInstance(), queue: .main) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
            let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt ?? 0
            MainActor.assumeIsolated { self.interruption(began: began, reason: reason) }
        }
    }

    func handle(_ body: Any) {
        guard let msg = body as? [String: Any], let op = msg["op"] as? String else { return }
        let rid = msg["id"] as? String ?? ""
        switch op {
        case "start":
            source = (msg["source"] as? String) ?? "web"
            dry = (msg["dry"] as? Bool) ?? false
            Task { await start(rid) }
        case "stop": if rid == id { finish(deliver: true) }
        case "cancel": if rid == id { finish(deliver: false) }
        case "reset":
            // A page that loaded while a recording ran cannot ask for it: nothing there holds its id. Its
            // stream is left open rather than cancelled, so the hub uses what arrived (it goes silent).
            if engine != nil { ClientLog.fail("nativerec-orphaned", ["secs": recorded]); finish(deliver: false, orphaned: true) }
        default: break
        }
    }

    private var recorded: TimeInterval { banked + (since.map { Date().timeIntervalSince($0) } ?? 0) }

    private func start(_ rid: String) async {
        if engine != nil { finish(deliver: false) }   // one recording at a time; a new start replaces it
        id = rid
        guard await AVAudioApplication.requestRecordPermission() else { fail("Mic permission denied"); return }
        guard id == rid else { return }                  // cancelled while asking
        let s = AVAudioSession.sharedInstance()
        if found == nil { found = (s.category, s.mode, s.categoryOptions) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rec-\(rid).m4a")
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            if let mic = s.availableInputs?.first(where: { $0.portType == .builtInMic }) { try? s.setPreferredInput(mic) }
            try s.setActive(true)
            let writer = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ], commonFormat: .pcmFormatFloat32, interleaved: false)
            guard let token = Auth.token(), let chunks = NativeChunks(token: token, source: source, dry: dry, format: speech, onBroken: { [weak self] why in
                Task { @MainActor in self?.broken(why) }
            }, onStall: { [weak self] on in
                Task { @MainActor in self?.stalled(on) }
            }) else { throw NSError(domain: "NativeRec", code: 2, userInfo: [NSLocalizedDescriptionKey: "stream setup"]) }
            self.writer = writer; file = url; stream = chunks
            let engine = AVAudioEngine()
            self.engine = engine
            try startEngine(engine)
            banked = 0; since = Date(); interrupted = false; pausedAt = nil
            q.sync { frames.n = 0 }
            tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                MainActor.assumeIsolated { self.stream?.flush(secs: self.recorded, state: self.interrupted ? "paused" : "rec") }
            }
            emit(["state": "rec", "pauses": true])
            log("nativerec-start", ["stream": chunks.id])
        } catch {
            ClientLog.fail("nativerec-failed", ["error": String(describing: error).prefix(160).description])
            teardown()
            fail("Mic unavailable")
        }
    }

    /// Taps the microphone into the file and the stream, converted to 16 kHz mono on `q`.
    private func startEngine(_ engine: AVAudioEngine) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let convert = AVAudioConverter(from: format, to: speech) else {
            throw NSError(domain: "NativeRec", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input format"])
        }
        let speech = self.speech, q = self.q
        let writer = self.writer, stream = self.stream, frames = self.frames
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            let ratio = speech.sampleRate / format.sampleRate
            guard let out = AVAudioPCMBuffer(pcmFormat: speech, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32) else { return }
            var fed = false
            var error: NSError?
            convert.convert(to: out, error: &error) { _, state in
                if fed { state.pointee = .noDataNow; return nil }
                fed = true
                state.pointee = .haveData
                return buffer
            }
            guard out.frameLength > 0 else { return }
            q.async {
                do { try writer?.write(from: out) } catch { NSLog("nativeRec write: \(error)") }
                stream?.write(out)
                frames.n += 1
            }
        }
        engine.prepare()
        try engine.start()
    }

    /// The hub stopped acknowledging the stream (a deploy restarts it for several seconds, or the
    /// connection dropped). The recording carries on: it is all in the file here, and the stream resends it
    /// when the hub is back. The page says so on its status line, and it is counted, not raised.
    private func stalled(_ on: Bool) {
        guard engine != nil else { return }
        if on { log("voice-stream-stall", ["secs": recorded, "native": true]) }
        emit(["state": "stall", "on": on])
    }

    /// The capture is dropping audio: stop now, keep everything, and make it impossible to miss.
    private func broken(_ why: String) {
        guard engine != nil else { return }
        log("error", ["msg": "a native recording was stopped mid-recording: \(why == "damaged" ? "the hub found the capture dropping audio" : "its stream to the hub stopped being acknowledged")",
                      "why": why, "secs": recorded, "page": "nativerec"])
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        AudioServicesPlayAlertSound(SystemSoundID(kSystemSoundID_Vibrate))
        if UIApplication.shared.applicationState != .active {
            // Behind another app the page cannot say it, so the system does.
            let c = UNMutableNotificationContent()
            c.title = "Recording stopped"
            c.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "nativerec-\(id)", content: c, trigger: nil))
        }
        emit(["state": "broken", "why": why])
        finish(deliver: true)
    }

    private func finish(deliver: Bool, orphaned: Bool = false) {
        guard engine != nil else { return }
        let secs = recorded
        // A confirmed interruption is a start whose end is the system handing the microphone back. A
        // recording that finishes still paused never got that end.
        if interrupted, let at = pausedAt {
            ClientLog.fail("nativerec-interrupt-unended", ["secs": secs, "paused": Date().timeIntervalSince(at), "deliver": deliver])
        }
        interrupted = false; pausedAt = nil
        teardown()
        let rid = id, url = file, chunks = stream
        var held = writer   // the file finishes when the last reference goes, after every queued write
        id = ""; file = nil; stream = nil; writer = nil
        // The stream says how it ended, after the last audio: `end` (the clip is coming through the outbox),
        // `cancel` (thrown away). An orphaned one says nothing, so the hub recovers what arrived.
        q.async {
            if !orphaned { chunks?.close(secs: secs, state: deliver ? "end" : "cancel") }
            if held != nil { held = nil }
            DispatchQueue.main.async {
                guard let url else { return }
                defer { try? FileManager.default.removeItem(at: url) }
                guard deliver else { return }
                guard let data = try? Data(contentsOf: url), !data.isEmpty else {
                    MainActor.assumeIsolated {
                        ClientLog.fail("nativerec-empty", ["secs": secs])
                        self.emit(["state": "error", "error": "Nothing recorded"], id: rid)
                    }
                    return
                }
                MainActor.assumeIsolated {
                    self.emit(["state": "done", "b64": data.base64EncodedString(), "secs": secs, "mime": "audio/mp4",
                               "stream": chunks?.id ?? ""], id: rid)
                }
            }
        }
    }

    private func teardown() {
        tick?.invalidate(); tick = nil
        if let e = engine { e.inputNode.removeTap(onBus: 0); e.stop() }
        engine = nil
        if let s = since { banked += Date().timeIntervalSince(s) }
        since = nil
        restore()
    }

    private func interruption(began: Bool, reason: UInt) {
        guard let engine else { return }
        if began {
            guard !interrupted else { return }
            let at = Date(), rid = id
            let before = q.sync { frames.n }
            DispatchQueue.main.asyncAfter(deadline: .now() + confirmGap) {
                MainActor.assumeIsolated {
                    guard self.engine != nil, self.id == rid, !self.interrupted else { return }
                    let after = self.q.sync { self.frames.n }
                    if after > before {
                        self.log("nativerec-interrupt-ignored", ["secs": self.recorded, "reason": reason, "buffers": after - before])
                        return
                    }
                    self.interrupted = true
                    self.pausedAt = at
                    if let s = self.since { self.banked += at.timeIntervalSince(s) }
                    self.since = nil
                    self.stream?.flush(secs: self.recorded, state: "paused")
                    self.log("nativerec-interrupted", ["secs": self.recorded, "reason": reason])
                    self.emit(["state": "paused"])
                }
            }
            return
        }
        guard interrupted else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try startEngine(engine)
            interrupted = false
            log("nativerec-resumed", ["secs": recorded, "paused": pausedAt.map { Date().timeIntervalSince($0) } ?? 0])
            pausedAt = nil
            since = Date()
            emit(["state": "rec"])
        } catch {
            ClientLog.fail("nativerec-resume-failed", ["error": String(describing: error).prefix(160).description])
        }
    }

    private func restore() {
        guard let (category, mode, options) = found else { return }
        found = nil
        do { try AVAudioSession.sharedInstance().setCategory(category, mode: mode, options: options) }
        catch { NSLog("nativeRec restore: \(error)") }
    }

    private func fail(_ why: String) {
        emit(["state": "error", "error": why])
        id = ""
    }

    private func emit(_ detail: [String: Any], id rid: String? = nil) {
        var d = detail
        d["id"] = rid ?? id
        guard let json = try? JSONSerialization.data(withJSONObject: d), let s = String(data: json, encoding: .utf8) else { return }
        web?.evaluateJavaScript("document.dispatchEvent(new CustomEvent('hub:nativerec',{detail:\(s)}))", completionHandler: nil)
    }

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
}

/// Buffers the tap has written, read and written only on `NativeRec.q`.
final class BufferCount: @unchecked Sendable { var n = 0 }

/// One recording's stream to the hub (`/api/voice-chunk`, server/lib/chunkstream.js): its audio encoded to
/// AAC in ADTS framing, posted a chunk a second, one request in flight, each acknowledged. The same rules
/// as the page's `ChunkStream` in voiceagent.js: an answer saying `damaged` calls `onBroken` once; a chunk
/// unacknowledged for `stall` seconds calls `onStall(true)`, and the next acknowledgement `onStall(false)`.
/// A stall never stops the recording: a hub restart lasts several seconds and loses nothing. A retry the hub already took is answered again, not counted
/// twice; 409 resends from where the hub is; 410 (the hub lost the stream) resends everything.
///
/// The encoder and the ADTS header are the watch's (Watch/LiveStream.swift), at the same 16 kHz mono.
/// Everything here runs on the caller's queue (`NativeRec.q`) or the session's own delegate queue, which
/// hops back to `q`.
final class NativeChunks: @unchecked Sendable {
    let id = UUID().uuidString.lowercased()
    private let token: String
    private let source: String
    private let dry: Bool
    private let encoder: AVAudioConverter
    private let onBroken: @Sendable (String) -> Void
    private let onStall: @Sendable (Bool) -> Void
    private var stalled = false
    private let q = DispatchQueue(label: "native-chunks")
    private var pending = Data()
    private var chunks: [(data: Data, secs: Double, state: String, at: Date)] = []
    private var sent = 0
    private var busy = false
    private var broken = false
    private var closed = false
    private static let stall: TimeInterval = 6

    init?(token: String, source: String, dry: Bool, format: AVAudioFormat, onBroken: @escaping @Sendable (String) -> Void,
          onStall: @escaping @Sendable (Bool) -> Void) {
        var aac = AudioStreamBasicDescription(mSampleRate: format.sampleRate, mFormatID: kAudioFormatMPEG4AAC,
                                              mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 1024,
                                              mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard let out = AVAudioFormat(streamDescription: &aac), let encoder = AVAudioConverter(from: format, to: out) else { return nil }
        encoder.bitRate = 32_000
        self.encoder = encoder
        self.token = token
        self.source = source
        self.dry = dry
        self.onBroken = onBroken
        self.onStall = onStall
    }

    /// One converted buffer of the recording.
    func write(_ buffer: AVAudioPCMBuffer) {
        q.async {
            var fed = false
            while true {
                let out = AVAudioCompressedBuffer(format: self.encoder.outputFormat, packetCapacity: 8,
                                                  maximumPacketSize: max(self.encoder.maximumOutputPacketSize, 1536))
                var error: NSError?
                let status = self.encoder.convert(to: out, error: &error) { _, state in
                    if fed { state.pointee = .noDataNow; return nil }
                    fed = true
                    state.pointee = .haveData
                    return buffer
                }
                if status == .error { return }
                for p in 0..<Int(out.packetCount) {
                    guard let d = out.packetDescriptions?[p] else { continue }
                    self.pending.append(Self.adts(Int(d.mDataByteSize)))
                    self.pending.append(Data(bytes: out.data.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize)))
                }
                if status != .haveData { break }
            }
        }
    }

    /// The audio encoded since the last chunk goes up as the next one (empty while paused: it still says
    /// the recording is alive and how long it has run, which is what lets the hub see a capture that has
    /// stopped delivering audio).
    func flush(secs: Double, state: String) { q.async { self.push(secs: secs, state: state) } }

    /// The last chunk, saying how the recording ended.
    func close(secs: Double, state: String) { q.async { self.push(secs: secs, state: state) } }

    private func push(secs: Double, state: String) {
        if closed || (broken && state == "rec") { return }
        chunks.append((pending, secs, state, Date()))
        pending = Data()
        if state != "rec" && state != "paused" { closed = true }
        check()
        pump()
    }

    private func check() {
        guard !broken, !closed else { return }
        let now = sent < chunks.count && Date().timeIntervalSince(chunks[sent].at) > Self.stall
        if now != stalled { stalled = now; onStall(now) }
    }

    private func fail(_ why: String) {
        guard !broken else { return }
        broken = true
        onBroken(why)
    }

    private func pump() {
        guard !busy, sent < chunks.count else { return }
        busy = true
        let seq = sent, c = chunks[seq]
        var u = URLComponents(string: Auth.host + "/api/voice-chunk")!
        u.queryItems = [.init(name: "id", value: id), .init(name: "seq", value: String(seq)), .init(name: "type", value: "aac"),
                        .init(name: "secs", value: String(format: "%.1f", c.secs)), .init(name: "state", value: c.state),
                        .init(name: "source", value: source)] + (dry ? [.init(name: "dry", value: "1")] : [])
        var req = URLRequest(url: u.url!, timeoutInterval: Self.stall)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        URLSession.shared.uploadTask(with: req, from: c.data) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            self.q.async {
                self.busy = false
                if code == 200 {
                    self.sent = max(self.sent, (j["next"] as? Int) ?? seq + 1)
                    if self.stalled { self.stalled = false; self.onStall(false) }
                    if (j["damaged"] as? Bool) == true && !self.closed { self.fail("damaged") }
                } else if code == 409, let next = j["next"] as? Int {
                    self.sent = next
                } else if code == 410 {
                    self.sent = 0
                } else {
                    // Not taken: the next chunk tries again, and check() decides when waiting is a failure.
                    self.check()
                    return
                }
                self.pump()
            }
        }.resume()
    }

    // ADTS header for AAC-LC, 16 kHz (sampling index 8), one channel.
    private static func adts(_ packet: Int) -> Data {
        let len = packet + 7
        let profile = 1, freq = 8, chan = 1   // profile is the object type minus one: LC = 2 - 1
        return Data([0xFF, 0xF1,
                     UInt8((profile << 6) | (freq << 2) | (chan >> 2)),
                     UInt8(((chan & 3) << 6) | (len >> 11)),
                     UInt8((len >> 3) & 0xFF),
                     UInt8(((len & 7) << 5) | 0x1F),
                     0xFC])
    }
}
#endif
