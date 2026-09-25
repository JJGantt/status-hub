import Foundation
import Security
import WatchConnectivity

/// The hub token, handed over by the iPhone app and kept in this watch's own Keychain. The watch
/// cannot sign in by itself: it has no web view, and the phone's cookies and Keychain are not shared
/// with it. See `Sources/WatchLink.swift` for the phone's half.
enum HubToken {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.jaredgantt.statushub.watch",
        kSecAttrAccount as String: "hubToken",
    ]

    static func get() -> String? {
        #if targetEnvironment(simulator)
        // A simulator has no phone to hand it a token. Passed at launch instead
        // (`SIMCTL_CHILD_HUB_TOKEN=… xcrun simctl launch`), so the real app runs against real data there.
        if let t = ProcessInfo.processInfo.environment["HUB_TOKEN"], !t.isEmpty { return t }
        #endif
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    static func set(_ token: String?) {
        SecItemDelete(query as CFDictionary)
        guard let token, !token.isEmpty else { return }
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// The watch's half of WatchConnectivity: takes the token from application context, and asks for it
/// directly — a message wakes the iPhone app in the background — whenever it has none.
@MainActor
final class PhoneLink: NSObject, WCSessionDelegate {
    static let shared = PhoneLink()

    /// Called when a token arrives, so a screen stuck without one can carry on.
    var onToken: (() -> Void)?

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func request() {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["want": "hubToken"], replyHandler: { reply in
            let token = reply["hubToken"] as? String
            Task { @MainActor in self.ingest(token) }
        }, errorHandler: nil)
    }

    private func ingest(_ token: String?) {
        guard let token else { return }
        let changed = token != (HubToken.get() ?? "")
        if changed { HubToken.set(token) }
        if changed && !token.isEmpty { onToken?() }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState,
                             error: Error?) {
        let token = session.receivedApplicationContext["hubToken"] as? String
        Task { @MainActor in
            self.ingest(token)
            if HubToken.get() == nil { self.request() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        let token = context["hubToken"] as? String
        Task { @MainActor in self.ingest(token) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in if HubToken.get() == nil { self.request() } }
    }
}

/// One row of the shared hub conversation (`voice_messages`), as `/api/voice-messages` returns it.
struct Message: Decodable, Identifiable, Equatable {
    let id: String
    let role: String?
    let text: String?
    let request_id: String?
    /// Set on a session's reply relayed into the thread (voice-pipeline orchestrator/src/relay.js).
    let session_id: String?
}

enum HubError: LocalizedError {
    case noToken
    case status(Int)

    var errorDescription: String? {
        switch self {
        case .noToken:       return nil
        case .status(let c): return "HTTP \(c)"
        }
    }
}

/// Holds the process awake while a piece of work runs. **The send is the one part of a command that
/// happens with no audio running**: the recording has just ended, so nothing is keeping a watch app
/// alive, and with the wrist down it is suspended in seconds — mid-upload. An expiring activity buys
/// the time to finish; it is best effort and the system can take it back, which is what `expired` says.
enum Awake {
    static func hold<T>(_ reason: String, _ work: () async throws -> T) async rethrows -> T {
        let done = DispatchSemaphore(value: 0)
        ProcessInfo.processInfo.performExpiringActivity(withReason: reason) { expired in
            if expired { done.signal() } else { done.wait() }
        }
        defer { done.signal() }
        return try await work()
    }
}

/// The hub calls the watch makes. Same host and header as the phone's native calls.
enum Hub {
    /// How long a call waits for the watch to have any connection before it fails. When the phone goes
    /// off or out of range the watch has no route at all until it brings up its own Wi-Fi or cellular,
    /// and a request made in that gap fails on the spot under URLSession's defaults.
    static let connectionWait: TimeInterval = 60

    /// Waits for a connection instead of failing. `timeoutIntervalForResource` is the only limit that
    /// applies while a task waits, so it is the wait plus the longest call (60s: a clip being
    /// transcribed, a reply the hub holds open).
    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.waitsForConnectivity = true
        c.timeoutIntervalForResource = connectionWait + 60
        return URLSession(configuration: c)
    }()

    /// The same with no overall limit, for the event streams, which stay open as long as their page is
    /// showing. A stream opened with no connection simply starts when one arrives.
    private static let streamSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.waitsForConnectivity = true
        return URLSession(configuration: c)
    }()

    /// Sends once more when the connection dropped mid-request, which is what the switch from the phone
    /// to the watch's own radio does to a request already on the wire; the resend waits for the new
    /// route. Safe for every call here: a command and a follow-up carry a `client_msg_id` the hub
    /// answers a resend with, and the rest are reads, a log line, or setting a value. `note` is off for
    /// the log's own post, so a resent log line does not log another.
    private static func resending<T>(note: Bool = true, _ send: () async throws -> T) async throws -> T {
        do {
            return try await send()
        } catch let e as URLError where e.code == .networkConnectionLost {
            if note { log("resend") }
            return try await send()
        }
    }

    /// The conversation every surface shows, scoped by the hub to its current context, in whichever
    /// mode (hub or agent) is active.
    static func thread() async throws -> [Message] {
        // The newest 40 rows, about twenty exchanges: all a wrist needs, and a short thread lays out
        // fast enough on opening for the view to land on the newest reply.
        try await json("/api/voice-messages?focus=hub&mode=active&limit=40")
    }

    /// What the hub heard in a clip, and the request it enqueued. No id means it heard no words, or the
    /// clip was sent `dry`.
    struct Heard: Decodable {
        let transcript: String?
        let id: String?
    }

    /// Uploads a recorded clip, transcribed with the same Groq Whisper as the phone's microphone. The
    /// hub enqueues what it heard as a command, or with `dry` only hands the words back. A resend with
    /// the same `msgId` is answered with the first send's id instead of running the command twice.
    ///
    /// `listener` is set for an utterance the always-on listener cut: it goes up as the listener `watch`
    /// with the utterance's own window, which is what lets the worker collapse it against the Mac or the
    /// ESP hearing the same sentence (docs/LISTENERS.md).
    static func sendAudio(_ clip: Recorder.Clip, msgId: String, dry: Bool = false,
                          listener: (start: Date, end: Date)? = nil) async throws -> Heard {
        try blockInSimulator("voice-command")
        var query = "client_msg_id=\(msgId)&client_now=\(clientNow())&dur=\(String(format: "%.1f", clip.duration))"
            + (dry ? "&dry=1" : "")
        if let listener {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            query += "&source=watch&quick=1&capture_start=\(iso.string(from: listener.start))"
                + "&capture_end=\(iso.string(from: listener.end))"
        }
        // Where he is, for "near me" and a pickup point; a dictation (dry) goes nowhere yet.
        if !dry, let l = await Here.shared.fix() {
            query += String(format: "&lat=%.5f&lon=%.5f&acc=%.0f",
                            l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy)
        }
        var r = try request("/api/voice-command?" + query, method: "POST", timeout: 60)
        r.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await resending { try await session.upload(for: r, fromFile: clip.url) }
        try await check(resp)
        return try JSONDecoder().decode(Heard.self, from: data)
    }

    /// Types his words into a running session. A resend with the same `msgId` returns the first send's
    /// command instead of typing the words twice.
    static func followUp(_ session: String, text: String, msgId: String) async throws {
        try blockInSimulator("followup")
        _ = try await call("/api/sessions/followup", method: "POST",
                           body: ["id": session, "text": text, "client_msg_id": msgId])
    }

    /// One of the hub's app settings, as the text it is stored as; nil when unset.
    /// Writes one of the hub's Settings — for a switch the watch flips (the Speak control) that the
    /// phone's Settings page shows too.
    static func putSetting(_ key: String, _ value: String) async {
        _ = try? await call("/api/settings", method: "POST", body: ["key": key, "value": value])
    }

    static func setting(_ key: String) async throws -> String? {
        try await settings()[key].map { "\($0)" }
    }

    /// Every setting the hub serves to a client, in one read.
    static func settings() async throws -> [String: Any] {
        (try JSONSerialization.jsonObject(with: try await call("/api/settings")) as? [String: Any]) ?? [:]
    }

    /// Marks a dated item done — the Done button on its notification. It SCORES: the item stays on the
    /// day as something that happened, where clearing it would delete it and score nothing.
    static func complete(_ id: String) async {
        _ = try? await call("/api/todos/complete", method: "POST", body: ["id": id])
    }

    /// A session has been read here, so its unread mark clears everywhere.
    static func seen(_ id: String) async throws {
        _ = try await call("/api/sessions/seen", method: "POST", body: ["id": id])
    }

    /// Takes the mute for the watch, or gives it back. Every microphone in the house is deaf while any
    /// source holds one (`/api/voice-mute`), so giving this one back cannot wake them while another is
    /// still capturing. Best effort, as on the phone.
    static func muteOthers(_ on: Bool) async {
        _ = try? await call("/api/voice-mute", method: "POST", body: ["holder": "watch", "on": on])
    }

    struct Outcome: Decodable {
        let status: String
        let error: String?
    }

    /// Waits for a command to finish. The hub holds each request open until it does, and answers
    /// `pending` when its own wait runs out, so this asks again until the answer is final.
    ///
    /// **A connection that drops while waiting is asked again, not reported.** The command is already
    /// with the hub by now, so a lost wait says nothing about it: lowering the wrist suspends the app
    /// and kills the open request, and raising it again showed "The request timed out" over a command
    /// that had finished half a minute after it was sent. Backs off while the hub cannot be reached.
    static func outcome(_ id: String) async throws -> Outcome {
        var backoff: Double = 1
        while true {
            do {
                let o: Outcome = try await json("/api/voice-reply/\(id)", timeout: 60)
                if o.status != "pending" { return o }
                backoff = 1
            } catch let e as URLError where e.code != .cancelled {
                log("reply-wait", ["error": e.code.rawValue])
                try await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 30)
            }
            try Task.checkCancellation()
        }
    }

    /// Holds a hub event stream open and hands every frame's event name and data to `frame`, running
    /// `reconnected` after each reconnect, since something may have gone by while it was down. Every
    /// frame the hub sends has a `data:` line, keepalives included. Backs off while the hub cannot be
    /// reached. Returns when the calling task is cancelled.
    static func listen(_ path: String, reconnected: @escaping () async -> Void = {},
                       frame: @escaping (_ event: String, _ data: String) async -> Void) async {
        var backoff: Double = 1
        var first = true
        while !Task.isCancelled {
            do {
                let bytes = try await stream(path)
                log("stream-open", ["path": path])
                if !first { await reconnected() }
                first = false
                backoff = 1
                var event = ""
                for try await line in bytes.lines {
                    if line.hasPrefix("event: ") {
                        event = String(line.dropFirst(7))
                    } else if line.hasPrefix("data: ") {
                        await frame(event, String(line.dropFirst(6)))
                    }
                }
                log("stream-end", ["path": path])
            } catch {
                if !Task.isCancelled { log("stream-error", ["path": path, "error": String(describing: error).prefix(120).description]) }
            }
            guard !Task.isCancelled else { return }
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(backoff * 2, 60)
        }
    }

    /// Runs `reload` on each /api/day-stream frame of `kind`, and after every reconnect.
    static func follow(_ kind: String, reload: @escaping () async -> Void) async {
        await listen("/api/day-stream", reconnected: reload) { event, _ in
            if event == kind { await reload() }
        }
    }

    /// The simulator runs the real app against the live hub, so a test tap that records and stops would
    /// otherwise land in his conversation as a command, or be typed into a session. Compiled out of
    /// device builds.
    private static func blockInSimulator(_ what: String) throws {
        #if targetEnvironment(simulator)
        log("send-blocked", ["what": what])
        throw HubError.status(0)
        #endif
    }

    /// A line in the hub's log (`fly logs -a jared-status-hub | grep clientlog`): what the watch showed
    /// and how a page scrolled, so a report from the wrist can be checked against what the watch did.
    /// Fire and forget; a lost line costs nothing.
    static func log(_ event: String, _ fields: [String: Any] = [:]) {
        var body = fields
        body["src"] = "watch"
        body["ev"] = event
        Task.detached { _ = try? await call("/api/clientlog", method: "POST", body: body, timeout: 10) }
    }

    static func json<T: Decodable>(_ path: String, timeout: TimeInterval = 20) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await call(path, timeout: timeout))
    }

    /// One path segment, escaped: session ids go into URLs.
    static func pathComponent(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s
    }

    /// A server-sent event stream, open until the hub or the network drops it. The hub pings every
    /// 25s, so a minute without a byte is a dead connection rather than a quiet one.
    static func stream(_ path: String) async throws -> URLSession.AsyncBytes {
        let (bytes, resp) = try await streamSession.bytes(for: try request(path, timeout: 60))
        try await check(resp)
        return bytes
    }

    private static func call(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                             timeout: TimeInterval = 20) async throws -> Data {
        let r = try request(path, method: method, body: body, timeout: timeout)
        let (data, resp) = try await resending(note: path != "/api/clientlog") { try await session.data(for: r) }
        try await check(resp)
        return data
    }

    private static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                                timeout: TimeInterval) throws -> URLRequest {
        guard let token = HubToken.get() else { throw HubError.noToken }
        var url = URL(string: Auth.host + path)!
        #if targetEnvironment(simulator)
        // The simulator's token is the kiosk's, which the hub takes as `?token=`, not as the header.
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
        url = c.url!
        #endif
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private static func check(_ resp: URLResponse) async throws {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 {
            HubToken.set(nil)
            await PhoneLink.shared.request()
            throw HubError.noToken
        }
        guard (200..<300).contains(code) else { throw HubError.status(code) }
    }

    /// The watch's own wall clock, which the worker anchors "now" to for a command.
    private static func clientNow() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.string(from: Date())
    }
}
