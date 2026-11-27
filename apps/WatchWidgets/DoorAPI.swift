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
