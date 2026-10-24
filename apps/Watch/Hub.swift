import Foundation
import Network
import Security
import WatchConnectivity

/// The hub token, handed over by the iPhone app and kept in this watch's own Keychain. The watch
/// cannot sign in by itself: it has no web view, and the phone's cookies and Keychain are not shared
/// with it. See `Sources/WatchLink.swift` for the phone's half.
///
/// **Readable while the watch is locked** (`AfterFirstUnlock`) and held in memory once read. With the
/// Keychain's default, a read with the wrist down failed and the live mic could not reconnect for over a
/// minute (`noToken`) until the wrist came up.
enum HubToken {
    nonisolated(unsafe) private static var cached: String?

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
        if let cached { return cached }
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        // A token stored before this was written carries the default; move it over.
        SecItemUpdate(query as CFDictionary, [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock] as CFDictionary)
        cached = s
        return s
    }

    static func set(_ token: String?) {
        SecItemDelete(query as CFDictionary)
        cached = nil
        guard let token, !token.isEmpty else { return }
        cached = token
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
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
        // The phone link, beside `net`: the route that drops when the phone does.
        Hub.log("phone-link", ["reachable": session.isReachable])
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

/// The watch's route to the internet, logged as `net` every time it changes, with how long the route
/// before it lasted. A command that sits on the wrist for two minutes and then lands in a bunch says
/// only that nothing got out; this says whether the route was gone, and which one it was on — the
/// phone (`other`), the watch's own Wi-Fi, or cellular. The lines wait in `LogOutbox` while there is no
/// route, so the gap itself reaches the hub once one returns.
@MainActor
final class Net {
    static let shared = Net()
    private let monitor = NWPathMonitor()
    private var started = false
    /// Until the first update says otherwise, assume a route, so nothing waits on a monitor not yet heard.
    private(set) var up = true
    private var since = Date()
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { path in Task { @MainActor in Net.shared.update(path) } }
        monitor.start(queue: DispatchQueue(label: "net-path", qos: .utility))
    }

    private func update(_ path: NWPath) {
        let now = Date()
        let kinds = path.availableInterfaces.map { i -> String in
            switch i.type {
            case .wifi: return "wifi"
            case .cellular: return "cellular"
            case .wiredEthernet: return "wired"
            case .loopback: return "loopback"
            default: return "other"
            }
        }
        Hub.log("net", ["status": "\(path.status)", "via": kinds.joined(separator: ","),
                        "expensive": path.isExpensive, "constrained": path.isConstrained,
                        "phone": WCSession.default.activationState == .activated && WCSession.default.isReachable,
                        "after": Int(now.timeIntervalSince(since))])
        since = now
        up = path.status == .satisfied
        if up {
            let ready = waiters.values
            waiters = [:]
            ready.forEach { $0.resume() }
        }
    }

    /// Returns once there is a route, at once when there already is. Cancelling it returns too.
    func whenUp() async {
        if up { return }
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { c in
                if up || Task.isCancelled { c.resume() } else { waiters[id] = c }
            }
        } onCancel: {
            Task { @MainActor in Net.shared.waiters.removeValue(forKey: id)?.resume() }
        }
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
                          listener: (start: Date, end: Date)? = nil, rewind: String? = nil,
                          timeout: TimeInterval = 60) async throws -> Heard {
        try blockInSimulator("voice-command")
        var query = await commandQuery(clip, msgId: msgId, dry: dry, listener: listener)
        // Instructions for a rewind grab: the hub sends the grab's words along with them (docs/REWIND.md).
        if let rewind { query += "&rewind=\(rewind)" }
        var r = try request("/api/voice-command?" + query, method: "POST", timeout: timeout)
        r.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await resending { try await session.upload(for: r, fromFile: clip.url) }
        try await check(resp)
        return try JSONDecoder().decode(Heard.self, from: data)
    }

    /// What the hub made of a rewind grab: the grab's id, its words (speaker-labeled when the diarizing
    /// model took it), and which model that was.
    struct Grabbed: Decodable {
        let id: String?
        let transcript: String?
        let model: String?
    }

    /// Uploads a rewind grab (`/api/rewind`). The hub keeps the clip and the words; nothing is enqueued.
    static func sendRewind(_ url: URL, held: TimeInterval) async throws -> Grabbed {
        try blockInSimulator("rewind")
        var r = try request("/api/rewind?held=\(String(format: "%.1f", held))", method: "POST", timeout: 120)
        r.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await resending { try await session.upload(for: r, fromFile: url) }
        try await check(resp)
        return try JSONDecoder().decode(Grabbed.self, from: data)
    }

    /// What a clip's upload says about it, to the hub and to the fallback alike.
    private static func commandQuery(_ clip: Recorder.Clip, msgId: String, dry: Bool,
                                     listener: (start: Date, end: Date)?) async -> String {
        var query = "client_msg_id=\(msgId)&client_now=\(clientNow())&dur=\(String(format: "%.1f", clip.duration))"
            + (dry ? "&dry=1" : "")
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        // The recording window rides every clip. `capture_start` is what the worker hands the data
        // layer as "now", so a set he logs by voice lands when he started talking rather than when
        // the model got round to calling the tool; and it is what the worker collapses two mics
        // hearing the same sentence on.
        let window = listener ?? (start: clip.start, end: clip.start.addingTimeInterval(clip.duration))
        query += "&capture_start=\(iso.string(from: window.start))&capture_end=\(iso.string(from: window.end))"
        if listener != nil {
            query += "&source=watch&quick=1"
        } else {
            // A command he pressed for. Named so the worker pushes its reply: the app is suspended the
            // moment the wrist drops, and the push is the only thing that reaches him then. Not
            // `watch`, which is the always-on listener and has its voice checked.
            query += "&source=watch-cmd"
        }
        // Where he is, for "near me" and a pickup point; a dictation (dry) goes nowhere yet.
        if !dry, let l = await Here.shared.fix() {
            query += String(format: "&lat=%.5f&lon=%.5f&acc=%.0f",
                            l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy)
        }
        return query
    }

    // MARK: The fallback, for when the hub does not answer

    /// Supabase's `voice-fallback` edge function (data-layer supabase/functions). It runs off Fly, so it
    /// is up when the hub is not: it transcribes the clip and queues it for the Pi's worker, which runs
    /// it on Opus and says it came this way. Same token as the hub; the function checks its hash.
    static let fallbackURL = "https://felyggqjjhltwokdfhop.supabase.co/functions/v1/voice-fallback"

    /// How long a command waits on the hub before trying the fallback. A healthy hub answers a clip in a
    /// few seconds, transcription included; a hub with no machine behind it does not answer at all — Fly's
    /// proxy holds the request open while it looks for one — so without a ceiling of its own a command
    /// waited out the full minute first. A hub that is merely slow past this gets the command twice (its
    /// own and the fallback's), which is the price of not waiting a minute on every outage.
    static let hubPatience: TimeInterval = 25

    /// A command, to the hub or, when the hub cannot be reached, to the fallback. `fallback` says which
    /// took it, because its outcome is waited on in the same place.
    ///
    /// **The patience is a deadline on the whole call**, not the request's own `timeoutInterval`: that one
    /// is an idle timer, it does not run while the session waits for connectivity, and `resending` starts
    /// it again — a send has taken 64s with it set to 25. The clock starts once the watch HAS a route
    /// (`Net.whenUp`): with no route at all the fallback cannot be reached either, and the command waits
    /// for one as before.
    static func sendCommand(_ clip: Recorder.Clip, msgId: String, rewind: String? = nil) async throws -> (heard: Heard, fallback: Bool) {
        do {
            let heard = try await withThrowingTaskGroup(of: Heard.self) { g in
                g.addTask { try await sendAudio(clip, msgId: msgId, rewind: rewind, timeout: hubPatience) }
                g.addTask {
                    await Net.shared.whenUp()
                    try await Task.sleep(for: .seconds(hubPatience))
                    throw URLError(.timedOut)
                }
                defer { g.cancelAll() }
                return try await g.next()!
            }
            return (heard, false)
        } catch let e where unreachable(e) {
            log("hub-unreachable", ["error": String(describing: e).prefix(120).description])
            return (try await sendFallback(clip, msgId: msgId), true)
        }
    }

    /// The hub is not there, as against there and refusing: no connection, no answer in time, or Fly's
    /// proxy answering for a machine it does not have. A 4xx is the hub itself, and the fallback would
    /// only be told the same thing.
    static func unreachable(_ e: Error) -> Bool {
        if let u = e as? URLError {
            return [.timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .networkConnectionLost,
                    .badServerResponse, .secureConnectionFailed, .cannotLoadFromNetwork].contains(u.code)
        }
        if case HubError.status(let c) = e { return c >= 500 }
        return false
    }

    private static func fallbackRequest(_ query: String, method: String, timeout: TimeInterval) throws -> URLRequest {
        guard let token = HubToken.get() else { throw HubError.noToken }
        var r = URLRequest(url: URL(string: fallbackURL + "?" + query)!)
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        return r
    }

    /// Not `check`: a 401 here means the function does not hold this token's hash yet, which says nothing
    /// about the token, so it must not be thrown away the way the hub's 401 throws it away.
    private static func checkFallback(_ resp: URLResponse) throws {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw HubError.status(code) }
    }

    static func sendFallback(_ clip: Recorder.Clip, msgId: String) async throws -> Heard {
        try blockInSimulator("voice-fallback")
        let query = await commandQuery(clip, msgId: msgId, dry: false, listener: nil)
        var r = try fallbackRequest(query, method: "POST", timeout: 60)
        r.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        let (data, resp) = try await resending { try await session.upload(for: r, fromFile: clip.url) }
        try checkFallback(resp)
        return try JSONDecoder().decode(Heard.self, from: data)
    }

    /// `outcome`, from the fallback: it holds the wait open on the row itself and answers `pending` when
    /// its own wait runs out. The reply comes back IN the outcome, since the hub's thread may be down.
    static func fallbackOutcome(_ id: String) async throws -> Outcome {
        var backoff: Double = 1
        while true {
            do {
                let r = try fallbackRequest("id=\(id)", method: "GET", timeout: 60)
                let (data, resp) = try await session.data(for: r)
                try checkFallback(resp)
                let o = try JSONDecoder().decode(Outcome.self, from: data)
                if o.status != "pending" { return o }
                backoff = 1
            } catch let e as URLError where e.code != .cancelled {
                log("reply-wait", ["error": e.code.rawValue, "via": "fallback"])
                try await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 30)
            }
            try Task.checkCancellation()
        }
    }

    /// Types his words into a running session. A resend with the same `msgId` returns the first send's
    /// command instead of typing the words twice.
    /// True when the hub took nothing: a thank-you-shaped transcription it never types into a session.
    static func followUp(_ session: String, text: String, msgId: String) async throws -> Bool {
        try blockInSimulator("followup")
        let data = try await call("/api/sessions/followup", method: "POST",
                                  body: ["id": session, "text": text, "client_msg_id": msgId])
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return (j?["ignored"] as? Bool) == true
    }

    /// One of the hub's app settings, as the text it is stored as; nil when unset.
    /// Writes one of the hub's Settings — for one the watch changes that the phone's Settings page
    /// shows too.
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

    /// One chunk of a reply read aloud (`/api/tts`), as WAV, and how many chunks the reply has. The hub
    /// owns everything about the voice — model, voice, how the text is split — so none of it is here.
    static func tts(_ text: String, chunk i: Int) async throws -> (audio: Data, of: Int) {
        let r = try request("/api/tts", method: "POST", body: ["text": text, "i": i], timeout: 60)
        let (data, resp) = try await resending { try await session.data(for: r) }
        try await check(resp)
        let of = Int((resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Chunks") ?? "") ?? 1
        return (data, of)
    }

    /// What a play measured: how long to the first sound, and how many chunks.
    static func ttsTiming(_ fields: [String: Any]) async {
        _ = try? await call("/api/tts/timing", method: "POST", body: fields.merging(["surface": "watch"]) { a, _ in a })
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
        /// The reply's text. Only the fallback sends it: the hub's own thread carries the reply otherwise.
        let result: String?
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
                        // An SSE event's name applies to it alone: a keepalive with no `event:` line of
                        // its own defaults to "message", not to whatever was last named. Left set, a
                        // keepalive after any real event kept matching `Hub.follow`'s event-name check,
                        // which reloads the day/health pages on every keepalive rather than only on a
                        // real change.
                        event = ""
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
    /// **A log line is kept on the watch until the hub has it** (`LogOutbox`), stamped with the watch's
    /// own time. Sent once and forgotten, every line written while the watch had no connection, or just
    /// before it slept, was gone, and those are exactly the moments a lost command has to be traced.
    static func log(_ event: String, _ fields: [String: Any] = [:]) {
        var body = fields
        body["src"] = "watch"
        body["ev"] = event
        body["t"] = ISO8601DateFormatter().string(from: Date())
        guard let line = try? JSONSerialization.data(withJSONObject: body),
              let text = String(data: line, encoding: .utf8) else { return }
        Task { await LogOutbox.shared.add(text) }
    }

    /// Sends what the outbox holds. Called after each line and when the app comes to the front.
    static func flushLog() {
        Task { await LogOutbox.shared.flush() }
    }

    fileprivate static func sendLog(_ lines: [String]) async -> Bool {
        let objects = lines.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) }
        return (try? await call("/api/clientlog", method: "POST", body: ["lines": objects], timeout: 20)) != nil
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
    /// `idle` is how long it waits for the next bytes before counting the stream dead.
    static func stream(_ path: String, idle: TimeInterval = 60,
                       delegate: URLSessionTaskDelegate? = nil) async throws -> URLSession.AsyncBytes {
        let (bytes, resp) = try await streamSession.bytes(for: try request(path, timeout: idle), delegate: delegate)
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

/// The log lines the hub has not acknowledged yet, oldest first, kept in UserDefaults so they survive
/// the app being closed. Sent in batches; a batch leaves only once the hub has answered for it. Capped,
/// oldest dropped: a watch offline for days must not grow this without end.
actor LogOutbox {
    static let shared = LogOutbox()
    private static let key = "log_outbox"
    private static let cap = 1000
    private static let batch = 50
    private var flushing = false

    func add(_ line: String) async {
        var lines = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
        lines.append(line)
        if lines.count > Self.cap { lines.removeFirst(lines.count - Self.cap) }
        UserDefaults.standard.set(lines, forKey: Self.key)
        await flush()
    }

    func flush() async {
        guard !flushing else { return }
        flushing = true
        defer { flushing = false }
        while true {
            let lines = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
            guard !lines.isEmpty else { return }
            let sending = Array(lines.prefix(Self.batch))
            guard await Hub.sendLog(sending) else { return }
            // Lines added while the batch was in the air are behind it, so only its own count goes.
            let now = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
            UserDefaults.standard.set(Array(now.dropFirst(min(sending.count, now.count))), forKey: Self.key)
        }
    }
}
