#if HUB_APP || WATCH_APP
import CoreLocation
import Foundation
#if HUB_APP
import UIKit
#endif

/// Where this device has been, sent to the hub's location history (docs/LOCATION.md). The phone and the
/// watch each run one, labelled by device, because they get separated and the history should say where
/// each of them was.
///
/// The PHONE records from three events, none of which keeps the app running:
/// - VISITS (`startMonitoringVisits`): iOS reports arriving somewhere and staying, and leaving again,
///   each with the place's coordinate. Stored as an `arrive` and a `depart` point.
/// - SIGNIFICANT-CHANGE WAKES: iOS wakes (or relaunches) the app after roughly 500 m of movement. The
///   position it hands over comes from cell and Wi-Fi, often hundreds of metres off, so it is stored as
///   `move` and one GPS fix is asked for in the seconds the wake allows, stored as `fix`.
/// - THE APP COMING TO THE FRONT: one GPS fix (`fix()`), also `fix`.
/// A continuous stream (`CLLocationUpdate.liveUpdates` under a `CLBackgroundActivitySession`) is the
/// obvious source and the wrong one: it keeps the app alive behind every other app all day, with the
/// location indicator up and the hub page running, for a track at one-second grain nobody reads.
///
/// The WATCH takes ONE fix each time the app comes to the front, and nothing in the background. A
/// background session there makes watchOS treat the app like a workout, so every wrist raise returns to
/// the app instead of the clock.
///
/// Points wait in a file until the hub accepts them, so a dead network or a killed app loses nothing,
/// and each is sent as soon as it lands: they are few now, and a wake's seconds are the only chance.
@MainActor
final class LocationTrail: NSObject, CLLocationManagerDelegate {
    static let shared = LocationTrail()

    #if WATCH_APP
    private static let device = "watch"
    #else
    private static let device = "phone"
    #endif
    private static let maxPost = 2000

    /// Visits and significant changes. Its locations are the coarse `move` points.
    private let monitor = CLLocationManager()
    /// One-shot GPS fixes, on a manager of its own so a fix is never mistaken for a wake's coarse position.
    private let fixer = CLLocationManager()
    private var started = false
    private var pending: [[String: Any]] = []
    private var sending = false
    private var fixing = false
    #if HUB_APP
    /// Holds the app awake past the wake's first seconds while a fix is taken and sent (up to ~30 s).
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    #endif

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
        fixer.delegate = self
        #if WATCH_APP
        // A place, not a track: a hundred metres answers "when did I get home" and lands fastest.
        fixer.desiredAccuracy = kCLLocationAccuracyHundredMeters
        if fixer.authorizationStatus == .notDetermined { fixer.requestWhenInUseAuthorization() }
        #else
        fixer.desiredAccuracy = kCLLocationAccuracyBest
        monitor.delegate = self
        // Always is what lets visits and wakes arrive with the app closed.
        if monitor.authorizationStatus == .notDetermined || monitor.authorizationStatus == .authorizedWhenInUse {
            monitor.requestAlwaysAuthorization()
        }
        // Both relaunch the app after iOS has terminated it, so starting them at every launch (background
        // ones included) is what keeps them registered.
        monitor.startMonitoringSignificantLocationChanges()
        monitor.startMonitoringVisits()
        #endif
        fix()
        send()  // anything left queued by a run that ended before the hub answered
    }

    /// One GPS fix, sent as soon as it lands: at launch, each time the app comes to the front, and on
    /// every significant-change wake.
    func fix() {
        #if HUB_APP
        holdAwake()
        #endif
        fixing = true
        fixer.requestLocation()
    }

    #if HUB_APP
    private func holdAwake() {
        guard bgTask == .invalid else { return }
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "location-fix") { [weak self] in
            self?.release()
        }
    }

    private func release() {
        guard bgTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bgTask)
        bgTask = .invalid
    }
    #endif

    private func add(_ l: CLLocation, source: String, at: Date? = nil) {
        guard l.horizontalAccuracy >= 0 else { return }
        var p: [String: Any] = ["at": Self.iso.string(from: at ?? l.timestamp), "source": source,
                                "lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
                                "h_acc": l.horizontalAccuracy]
        if l.verticalAccuracy > 0 { p["alt"] = l.altitude; p["v_acc"] = l.verticalAccuracy }
        if l.speed >= 0 { p["speed"] = l.speed }
        if l.course >= 0 { p["course"] = l.course }
        if let f = l.floor?.level { p["floor"] = f }
        pending.append(p)
        save()
    }

    private func save() {
        if let data = try? JSONSerialization.data(withJSONObject: pending) { try? data.write(to: Self.file, options: .atomic) }
    }

    private func send() {
        if sending { return }
        guard !pending.isEmpty, let url = URL(string: Auth.host + "/api/location/points"),
              let token = Self.token() else { return done() }
        let chunk = Array(pending.prefix(Self.maxPost))
        guard let body = try? JSONSerialization.data(withJSONObject: ["device": Self.device, "points": chunk]) else { return done() }
        sending = true
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 25
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        URLSession.shared.dataTask(with: r) { _, resp, err in
            let ok = err == nil && (resp as? HTTPURLResponse)?.statusCode == 200
            Task { @MainActor in
                self.sending = false
                guard ok else { return self.done() }
                // Only what was sent comes off the front; points that arrived meanwhile stay queued.
                self.pending.removeFirst(min(chunk.count, self.pending.count))
                self.save()
                if self.pending.isEmpty { self.done() } else { self.send() }
            }
        }.resume()
    }

    /// Nothing more to do for this wake — no fix in flight, nothing being sent: let the app be suspended.
    private func done() {
        #if HUB_APP
        if !fixing && !sending { release() }
        #endif
    }

    private static func token() -> String? {
        #if WATCH_APP
        return HubToken.get()
        #else
        return Auth.token()
        #endif
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            if m === self.fixer {
                self.fixing = false
                if let l = locations.last { self.add(l, source: "fix") }
                self.send()
            } else {
                for l in locations { self.add(l, source: "move") }
                self.fix()  // the coarse position is a hint; the GPS fix is the point worth having
                self.send()
            }
        }
    }

    #if HUB_APP
    nonisolated func locationManager(_ m: CLLocationManager, didVisit visit: CLVisit) {
        Task { @MainActor in
            let l = CLLocation(coordinate: visit.coordinate, altitude: 0, horizontalAccuracy: visit.horizontalAccuracy,
                               verticalAccuracy: -1, timestamp: visit.arrivalDate)
            // An arrival is reported with no departure yet, and the same visit comes again with one when
            // it ends; the hub upserts on (device, at), so the repeated arrival lands on its own row.
            if visit.arrivalDate != .distantPast { self.add(l, source: "arrive", at: visit.arrivalDate) }
            if visit.departureDate != .distantFuture { self.add(l, source: "depart", at: visit.departureDate) }
            self.holdAwake()
            self.send()
        }
    }
    #endif

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        // A fix that cannot be had (no signal indoors, permission off) is not an incident; the next
        // event tries again. Points already queued still go.
        Task { @MainActor in
            if m === self.fixer { self.fixing = false }
            self.send()
        }
    }
}
#endif
