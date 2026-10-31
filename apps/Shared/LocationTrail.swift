#if HUB_APP || WATCH_APP
import CoreLocation
import Foundation

/// Every position this device reports, kept at the grain Core Location delivers it and sent to the
/// hub's location history (docs/LOCATION.md). The phone and the watch each run one, labelled by device,
/// because they get separated and the history should say where each of them was.
///
/// On the PHONE, `CLLocationUpdate.liveUpdates` is the source: it delivers while the device moves and
/// goes quiet when it is stationary, so nothing here asks on a clock. A `CLBackgroundActivitySession`
/// keeps it delivering with the app in the background, and significant-change monitoring is what brings
/// the app back after iOS terminates it; its fixes are recorded too.
///
/// The WATCH takes ONE fix each time the app comes to the front (`fix()`), and nothing in the background.
/// A background session there is the attractive version and it costs the watch face: watchOS treats an
/// app holding one like a workout, so every wrist raise returns to the app instead of the clock. The
/// phone carries the history; the watch's sparse points cover the times it is out without the phone.
///
/// Fixes wait in a file until the hub accepts them, so a dead network or a killed app loses nothing.
/// They go in batches rather than one per fix: when the batch is full, when the device comes to rest,
/// or when a fix arrives more than five minutes after the last send.
@MainActor
final class LocationTrail: NSObject, CLLocationManagerDelegate {
    static let shared = LocationTrail()

    #if WATCH_APP
    private static let device = "watch"
    #else
    private static let device = "phone"
    #endif
    private static let batch = 100
    private static let maxPost = 2000
    private static let staleSend: TimeInterval = 300

    private let manager = CLLocationManager()
    private var session: CLBackgroundActivitySession?
    private var updates: Task<Void, Never>?
    private var started = false
    private var pending: [[String: Any]] = []
    private var lastSend = Date.distantPast
    private var sending = false

    private static let file: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("location-trail.json")
    }()
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func start() {
        guard !started else { return }
        started = true
        pending = (try? Data(contentsOf: Self.file))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
        manager.delegate = self
        #if WATCH_APP
        // A place, not a track: a hundred metres answers "when did I get home" and lands fastest.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        fix()
        #else
        if manager.authorizationStatus == .notDetermined || manager.authorizationStatus == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
        manager.startMonitoringSignificantLocationChanges()
        // Created at every launch, background ones included: a relaunched app has to open a new one
        // for updates to keep arriving.
        session = CLBackgroundActivitySession()
        updates = Task { [weak self] in
            do {
                for try await u in CLLocationUpdate.liveUpdates() {
                    guard let self else { return }
                    if let l = u.location { self.add([l]) }
                    if u.isStationary { self.send() }
                }
            } catch {}
        }
        #endif
    }

    #if WATCH_APP
    /// One fix for the app coming to the front, sent as soon as it lands. Called from the root view's
    /// scene phase going active, and once at launch.
    func fix() {
        manager.requestLocation()
    }
    #endif

    private func add(_ locations: [CLLocation]) {
        for l in locations where l.horizontalAccuracy >= 0 {
            var p: [String: Any] = ["at": Self.iso.string(from: l.timestamp),
                                    "lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
                                    "h_acc": l.horizontalAccuracy]
            if l.verticalAccuracy > 0 { p["alt"] = l.altitude; p["v_acc"] = l.verticalAccuracy }
            if l.speed >= 0 { p["speed"] = l.speed }
            if l.course >= 0 { p["course"] = l.course }
            if let f = l.floor?.level { p["floor"] = f }
            pending.append(p)
        }
        save()
        #if WATCH_APP
        send()
        #else
        if pending.count >= Self.batch || Date().timeIntervalSince(lastSend) > Self.staleSend { send() }
        #endif
    }

    private func save() {
        if let data = try? JSONSerialization.data(withJSONObject: pending) { try? data.write(to: Self.file, options: .atomic) }
    }

    private func send() {
        guard !sending, !pending.isEmpty, let url = URL(string: Auth.host + "/api/location/points"),
              let token = Self.token() else { return }
        let chunk = Array(pending.prefix(Self.maxPost))
        guard let body = try? JSONSerialization.data(withJSONObject: ["device": Self.device, "points": chunk]) else { return }
        sending = true
        lastSend = Date()
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 60
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        URLSession.shared.dataTask(with: r) { _, resp, err in
            let ok = err == nil && (resp as? HTTPURLResponse)?.statusCode == 200
            Task { @MainActor in
                self.sending = false
                guard ok else { return }
                // Only what was sent comes off the front; fixes that arrived meanwhile stay queued.
                self.pending.removeFirst(min(chunk.count, self.pending.count))
                self.save()
                if self.pending.count >= Self.batch { self.send() }
            }
        }.resume()
    }

    private static func token() -> String? {
        #if WATCH_APP
        return HubToken.get()
        #else
        return Auth.token()
        #endif
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in self.add(locations) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}
}
#endif
