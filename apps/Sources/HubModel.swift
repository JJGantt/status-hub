import Foundation

@MainActor
final class HubModel: ObservableObject {
    @Published var status: Status?
    @Published var connected = false
    @Published var authed: Bool = Auth.token() != nil
    @Published var lastError: String?

    private var streamTask: Task<Void, Never>?

    func start() {
        guard authed, streamTask == nil else { return }
        streamTask = Task { await streamLoop() }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        connected = false
    }

    func login(_ pw: String) async -> Bool {
        Auth.savePassword(pw)
        if await fetchOnce() {
            authed = true
            start()
            return true
        }
        Auth.clear()
        authed = false
        return false
    }

    func logout() {
        stop()
        Auth.clear()
        authed = false
        status = nil
    }

    private func request(_ path: String) -> URLRequest? {
        guard let token = Auth.token(), let url = URL(string: Auth.host + path) else { return nil }
        var r = URLRequest(url: url)
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        return r
    }

    @discardableResult
    func fetchOnce() async -> Bool {
        guard let req = request("/api/status") else { return false }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return false }
            status = try JSONDecoder().decode(Status.self, from: data)
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    // Live updates via Server-Sent Events on /api/stream, with auto-reconnect.
    private func streamLoop() async {
        while !Task.isCancelled {
            guard var req = request("/api/stream") else { return }
            req.timeoutInterval = 600
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            do {
                let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                    connected = false
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                    continue
                }
                connected = true
                for try await line in bytes.lines {
                    if Task.isCancelled { break }
                    guard line.hasPrefix("data:") else { continue } // ignore ": keepalive" comments
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if let d = payload.data(using: .utf8),
                       let s = try? JSONDecoder().decode(Status.self, from: d) {
                        status = s
                    }
                }
            } catch {
                lastError = error.localizedDescription
            }
            connected = false
            if !Task.isCancelled { try? await Task.sleep(nanoseconds: 3_000_000_000) }
        }
    }
}
