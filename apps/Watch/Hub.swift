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

/// The hub calls the watch makes. Same host and header as the phone's native calls.
enum Hub {
    /// The conversation every surface shows, scoped by the hub to its current context, in whichever
    /// mode (hub or agent) is active.
    static func thread() async throws -> [Message] {
        try await json("/api/voice-messages?focus=hub&mode=active&limit=200")
    }

    /// What the hub heard in a clip, and the request it enqueued. No id means it heard no words.
    struct Heard: Decodable {
        let transcript: String?
        let id: String?
    }

    /// Uploads a recorded clip. The hub transcribes it and enqueues what it heard as a command, the
    /// same path the phone's microphone takes. A resend with the same `msgId` is answered with the
    /// first send's id instead of running the command twice.
    static func sendAudio(_ clip: Recorder.Clip, msgId: String) async throws -> Heard {
        let query = "client_msg_id=\(msgId)&client_now=\(clientNow())&dur=\(String(format: "%.1f", clip.duration))"
        var r = try request("/api/voice-command?" + query, method: "POST", timeout: 60)
        r.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await URLSession.shared.upload(for: r, fromFile: clip.url)
        try await check(resp)
        return try JSONDecoder().decode(Heard.self, from: data)
    }

    /// The global `voice_muted` flag every always-on listener obeys. Best effort, as on the phone.
    static func muteOthers(_ on: Bool) async {
        _ = try? await call("/api/settings", method: "POST", body: ["key": "voice_muted", "value": on ? "1" : "0"])
    }

    struct Outcome: Decodable {
        let status: String
        let error: String?
    }

    /// Waits for a command to finish. The hub holds each request open until it does, and answers
    /// `pending` when its own wait runs out, so this asks again until the answer is final.
    static func outcome(_ id: String) async throws -> Outcome {
        while true {
            let o: Outcome = try await json("/api/voice-reply/\(id)", timeout: 60)
            if o.status != "pending" { return o }
            try Task.checkCancellation()
        }
    }

    /// Holds /api/day-stream open and runs `reload` on each frame of `kind`, and once after every
    /// reconnect, since a change may have gone by while it was down. Backs off while the hub cannot be
    /// reached. Returns when the calling task is cancelled.
    static func follow(_ kind: String, reload: @escaping () async -> Void) async {
        var backoff: Double = 1
        var first = true
        while !Task.isCancelled {
            do {
                let bytes = try await stream("/api/day-stream")
                if !first { await reload() }
                first = false
                backoff = 1
                for try await line in bytes.lines where line == "event: " + kind {
                    await reload()
                }
            } catch {}
            guard !Task.isCancelled else { return }
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(backoff * 2, 60)
        }
    }

    static func json<T: Decodable>(_ path: String, timeout: TimeInterval = 20) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await call(path, timeout: timeout))
    }

    /// A server-sent event stream, open until the hub or the network drops it. The hub pings every
    /// 25s, so a minute without a byte is a dead connection rather than a quiet one.
    static func stream(_ path: String) async throws -> URLSession.AsyncBytes {
        let (bytes, resp) = try await URLSession.shared.bytes(for: try request(path, timeout: 60))
        try await check(resp)
        return bytes
    }

    private static func call(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                             timeout: TimeInterval = 20) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: try request(path, method: method, body: body,
                                                                              timeout: timeout))
        try await check(resp)
        return data
    }

    private static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                                timeout: TimeInterval) throws -> URLRequest {
        guard let token = HubToken.get() else { throw HubError.noToken }
        var r = URLRequest(url: URL(string: Auth.host + path)!)
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

    /// The watch's own wall clock, which the worker anchors "now" to for a typed command.
    private static func clientNow() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.string(from: Date())
    }
}
