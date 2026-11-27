import Foundation

/// What the app running Watchset provides. Watchset holds no workout session, credential or log
/// of its own: one app can hold a workout at a time, and the app already holds one (its workout
/// hold) and talks to the hub. Set once at launch with `WatchsetHost.install`.
public struct WatchsetHost: Sendable {
    /// Hold a workout session for capture; nil once it is holding, else why it could not.
    public var hold: @MainActor @Sendable () async -> String?
    /// Capture no longer needs the session. The app decides whether it keeps holding it.
    public var release: @MainActor @Sendable () -> Void
    /// A request to the `workset` routes (`report`, `report?id=`, `watcher`, `capture?session=`),
    /// authenticated however the app authenticates. Nil when it cannot be built (no credential yet).
    public var request: @Sendable (_ route: String, _ method: String, _ contentType: String, _ body: Data?) -> URLRequest?
    /// True while the app is using the audio session itself (a recording, a spoken reply), so the
    /// rep feedback plays inside it rather than reconfiguring or releasing it.
    public var audioInUse: @MainActor @Sendable () -> Bool
    /// A line in the app's log. `error` lines are reported as failures.
    public var log: @Sendable (_ event: String, _ fields: [String: String]) -> Void

    public init(hold: @escaping @MainActor @Sendable () async -> String?,
                release: @escaping @MainActor @Sendable () -> Void,
                request: @escaping @Sendable (String, String, String, Data?) -> URLRequest?,
                audioInUse: @escaping @MainActor @Sendable () -> Bool,
                log: @escaping @Sendable (String, [String: String]) -> Void) {
        self.hold = hold
        self.release = release
        self.request = request
        self.audioInUse = audioInUse
        self.log = log
    }

    /// Set once, at launch, before any screen of Watchset exists; read from any thread after.
    nonisolated(unsafe) static var current: WatchsetHost?

    @MainActor public static func install(_ host: WatchsetHost) { current = host }

    /// A failure, as a line the app's log reports (`level: error`). Every way a set, a report edit, a
    /// recording or the rep sounds did not happen goes through here.
    static func fail(_ event: String, _ fields: [String: String] = [:]) {
        current?.log(event, fields.merging(["level": "error"]) { _, b in b })
    }

    /// A request's outcome as a failure description, or nil when it succeeded (2xx, or one of `ok`).
    static func failure(_ resp: URLResponse?, _ err: Error?, ok: Set<Int> = []) -> String? {
        if let err { return String(describing: err).prefix(120).description }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (200..<300).contains(code) || ok.contains(code) ? nil : "HTTP \(code)"
    }
}

/// Whether the app is holding the workout session, as the screens show it. The app sets it whenever
/// its hold starts or ends, including when something else ends it.
@MainActor
public final class KeepAlive: ObservableObject {
    public static let shared = KeepAlive()
    @Published public private(set) var isHolding = false

    public func update(holding: Bool) { if isHolding != holding { isHolding = holding } }

    /// Ask the app for the session; nil on success, else the failure.
    func acquire() async -> String? {
        guard let host = WatchsetHost.current else { return "no host" }
        return await host.hold()
    }

    func release() { WatchsetHost.current?.release() }
}

/// The `workset` routes, through the app.
enum DataLayer {
    static func request(_ route: String, _ method: String, contentType: String = "application/json",
                        body: Data? = nil) -> URLRequest? {
        WatchsetHost.current?.request(route, method, contentType, body)
    }

    static func request(_ route: String, _ method: String, json: [String: Any]) -> URLRequest? {
        request(route, method, body: try? JSONSerialization.data(withJSONObject: json))
    }
}
