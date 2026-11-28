import Foundation

/// A failure on the phone, reported to the ops responder through the hub's `/api/clientlog`, which raises
/// every line carrying `level: error` (server lib/clientfail.js). Compiled into the app and the widget
/// extension, each with its own outbox.
///
/// **Held until the hub has it.** A failure is most often the network failing, which is exactly when a
/// fire-and-forget beacon is lost with it, so the lines wait in `UserDefaults` and go with the next one, or
/// when the app comes to the front (`flush`). Capped, oldest dropped.
enum ClientLog {
    private static let key = "client_log_outbox"
    private static let cap = 200
    private static let queue = DispatchQueue(label: "ClientLog")
    private static var sending = false

    /// Every way something on the phone did not happen: a request, a notification action, the audio
    /// session, HealthKit. `fields["error"]` is what went wrong.
    static func fail(_ event: String, _ fields: [String: Any] = [:]) {
        add(event, fields, level: "error")
    }

    /// A plain line, not a failure: kept in `client_log` and never raised. Same outbox as `fail`.
    static func note(_ event: String, _ fields: [String: Any] = [:]) {
        add(event, fields, level: nil)
    }

    private static func add(_ event: String, _ fields: [String: Any], level: String?) {
        var line = fields
        line["src"] = "phone"
        line["ev"] = event
        if let level { line["level"] = level }
        line["t"] = ISO8601DateFormatter().string(from: Date())
        line["build"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        guard let data = try? JSONSerialization.data(withJSONObject: line),
              let text = String(data: data, encoding: .utf8) else { return }
        queue.async {
            var lines = UserDefaults.standard.stringArray(forKey: key) ?? []
            lines.append(text)
            if lines.count > cap { lines.removeFirst(lines.count - cap) }
            UserDefaults.standard.set(lines, forKey: key)
            send()
        }
    }

    /// `error` as a short string for a line.
    static func describe(_ error: Error) -> String { String(describing: error).prefix(160).description }

    /// Sends what is held. Called after each line and when the app comes to the front.
    static func flush() { queue.async { send() } }

    /// On `queue`. One batch in flight; a batch leaves the outbox only once the hub has answered for it.
    private static func send() {
        guard !sending, let token = Auth.token(), let url = URL(string: Auth.host + "/api/clientlog") else { return }
        let lines = UserDefaults.standard.stringArray(forKey: key) ?? []
        guard !lines.isEmpty else { return }
        let objects = lines.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 20
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["lines": objects])
        sending = true
        URLSession.shared.dataTask(with: r) { _, resp, _ in
            queue.async {
                sending = false
                guard ((resp as? HTTPURLResponse)?.statusCode ?? 0) / 100 == 2 else { return }
                let sent = Set(lines)
                var now = UserDefaults.standard.stringArray(forKey: key) ?? []
                now.removeAll { sent.contains($0) }
                UserDefaults.standard.set(now, forKey: key)
                if !now.isEmpty { send() }
            }
        }.resume()
    }
}
