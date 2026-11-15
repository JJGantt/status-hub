#if os(iOS)
import AVFoundation
import WebKit

/// **The page's mic buttons record here, natively, so a recording survives leaving the app.** WebKit
/// stops a page's capture the moment the app leaves the screen, so a command recorded through
/// `getUserMedia` loses everything said in another app. An `AVAudioRecorder` under the app's
/// `audio` background mode keeps recording behind any other app, the way the watch does.
///
/// The page drives it (message `nativeRec`, `makeRecorder` in voiceagent.js): `{op:'start', id}`,
/// `{op:'stop', id}`, `{op:'cancel', id}`, and `{op:'reset'}` as a page loads. It answers on
/// `hub:nativerec` with `{id, state}`: `rec` once capturing, `done` with the clip as base64 AAC and its
/// recorded seconds, `error` with why. The clip then goes up through the page's own outbox, exactly as
/// a WebKit clip does.
///
/// **An interruption pauses the file and the end of it carries on into the same file** (a call, Siri,
/// a timer): AVAudioRecorder appends on `record()` after a pause, so a command is one clip whatever
/// happened in the middle of it.
///
/// **The built-in microphone, never AirPods** — the same rule as the page's (`acquireBuiltIn`): opening
/// AirPods' mic drops the link into the hands-free profile.
///
/// The session is given back as it was found (category, mode, options) and NOT deactivated, for the
/// reason `AlarmAudio` gives: WebKit does not re-activate a session it believes is already up.
///
/// Logs to the hub as `src: phone` (`nativerec*` in `client_log`).
@MainActor
final class NativeRec: NSObject, AVAudioRecorderDelegate {
    static let shared = NativeRec()
    weak var web: WKWebView?

    private var recorder: AVAudioRecorder?
    private var id = ""
    private var file: URL?
    private var found: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
    private var interrupted = false

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                                               object: AVAudioSession.sharedInstance(), queue: .main) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
            MainActor.assumeIsolated { self.interruption(began: began) }
        }
    }

    func handle(_ body: Any) {
        guard let msg = body as? [String: Any], let op = msg["op"] as? String else { return }
        let rid = msg["id"] as? String ?? ""
        switch op {
        case "start": Task { await start(rid) }
        case "stop": if rid == id { finish(deliver: true) }
        case "cancel": if rid == id { finish(deliver: false) }
        case "reset":
            // A page that loaded while a recording ran cannot ask for it: nothing there holds its id.
            if recorder != nil { log("nativerec-orphaned", ["secs": recorder?.currentTime ?? 0]); finish(deliver: false) }
        default: break
        }
    }

    private func start(_ rid: String) async {
        if recorder != nil { finish(deliver: false) }   // one recording at a time; a new start replaces it
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
            let r = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000,
            ])
            r.delegate = self
            guard r.record() else { throw NSError(domain: "NativeRec", code: 1, userInfo: [NSLocalizedDescriptionKey: "record() refused"]) }
            recorder = r; file = url; interrupted = false
            emit(["state": "rec"])
        } catch {
            log("nativerec-failed", ["error": String(describing: error).prefix(160).description])
            restore()
            fail("Mic unavailable")
        }
    }

    private func finish(deliver: Bool) {
        guard let r = recorder else { return }
        let secs = r.currentTime
        r.stop()
        recorder = nil
        restore()
        let rid = id, url = file
        id = ""; file = nil
        guard let url else { return }
        defer { try? FileManager.default.removeItem(at: url) }
        guard deliver else { return }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            log("nativerec-empty", ["secs": secs])
            emit(["state": "error", "error": "Nothing recorded"], id: rid)
            return
        }
        emit(["state": "done", "b64": data.base64EncodedString(), "secs": secs, "mime": "audio/mp4"], id: rid)
    }

    private func interruption(began: Bool) {
        guard let r = recorder else { return }
        if began {
            interrupted = true
            log("nativerec-interrupted", ["secs": r.currentTime])
            return
        }
        guard interrupted else { return }
        interrupted = false
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            if !r.record() { log("nativerec-resume-refused", ["secs": r.currentTime]) }
        } catch {
            log("nativerec-resume-failed", ["error": String(describing: error).prefix(160).description])
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let e = String(describing: error).prefix(160).description
        Task { @MainActor in self.log("nativerec-encode-error", ["error": e]) }
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
#endif
