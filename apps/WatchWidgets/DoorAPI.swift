import Foundation

/// The front door (a SwitchBot lock), through the hub's `GET` / `POST /api/door` (server
/// routes/switchbot.js). Compiled into the app and the widget extension: the Control Center toggle
/// reads and sets it from the extension's own process, the door sheet from the app's.
enum DoorAPI {
    struct State: Decodable {
        let lock: String?
        let door: String?
        let battery: Int?
        let stale: Bool?
        var locked: Bool { lock == "locked" }
    }

    enum Failure: Error { case noToken, status(Int) }

    static func get() async throws -> State {
        try await call("GET", nil)
    }

    /// Locks or unlocks; the hub answers once the lock reports the new state.
    static func set(locked: Bool) async throws -> State {
        try await call("POST", ["action": locked ? "lock" : "unlock"])
    }

    /// A failure in the widget extension, sent straight to the hub's client log, which reports it
    /// (server lib/clientfail.js). The extension has no `Hub.log` outbox; the app's door sheet uses that.
    /// The door is the extension's only request, so this is every failure it can have.
    /// Without a token nothing can reach the hub, so `noToken` here goes unreported.
    static func report(_ event: String, _ error: Error) async {
        guard let token = HubToken.get() else { return }
        var r = URLRequest(url: URL(string: Auth.host + "/api/clientlog")!)
        r.httpMethod = "POST"
        r.timeoutInterval = 15
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let line: [String: Any] = ["src": "watch", "ev": event, "via": "control", "level": "error",
                                   "error": String(describing: error).prefix(120).description,
                                   "t": ISO8601DateFormatter().string(from: Date())]
        r.httpBody = try? JSONSerialization.data(withJSONObject: line)
        if (try? await URLSession.shared.data(for: r)) == nil { print("door failure not reported: \(event)") }
    }

    private static func call(_ method: String, _ body: [String: String]?) async throws -> State {
        guard let token = HubToken.get() else { throw Failure.noToken }
        var r = URLRequest(url: URL(string: Auth.host + "/api/door")!)
        r.httpMethod = method
        // The hub confirms a command against the lock itself, which can take up to 15s.
        r.timeoutInterval = 30
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Failure.status(code) }
        return try JSONDecoder().decode(State.self, from: data)
    }
}
