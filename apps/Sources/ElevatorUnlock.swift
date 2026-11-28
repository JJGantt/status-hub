#if os(iOS)
import CoreLocation
import CoreMotion
import Foundation

/// Unlocks the front door when he rides the elevator up and walks out of it (docs/DOOR.md).
///
/// A geofence around home (`app_settings.home_location`, from `GET /api/door/home`) wakes the app on
/// arrival, even after iOS has terminated it. The app then opens a WINDOW of `windowFor`: it keeps
/// itself running with background location updates (the only way an app may keep running in the
/// background, and the reason for `location` in UIBackgroundModes), reads the barometer
/// (`CMAltimeter`) and the step counter (`CMPedometer`), and feeds both to `ElevatorDetector`. On its
/// unlock the door is unlocked through `POST /api/door`. The window ends on the unlock, on leaving the
/// geofence, or after `windowFor`, and stops all of it, so the app is not kept alive at home all day.
///
/// Every window is stored with its whole trace (`POST /api/elevator/rides`, table `elevator_rides`),
/// rides that did not unlock included, so the thresholds can be tuned from real rides.
@MainActor
final class ElevatorUnlock: NSObject, CLLocationManagerDelegate {
    static let shared = ElevatorUnlock()

    nonisolated private static let region = "home-door"
    private static let windowFor: TimeInterval = 15 * 60

    private let geofence = CLLocationManager()
    /// Keeps the app running through a window; its positions are not used.
    private let keepAlive = CLLocationManager()
    private let altimeter = CMAltimeter()
    private let pedometer = CMPedometer()

    private var detector = ElevatorDetector()
    private var started: Date?
    private var ends: Timer?
    private var rides: [[String: Any]] = []

    func start() {
        geofence.delegate = self
        keepAlive.delegate = self
        Task { await armGeofence() }
    }

    private func armGeofence() async {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else {
            Self.error("elevator unlock: region monitoring is not available on this phone"); return
        }
        guard let home = await Self.home() else { return }
        let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: home.lat, longitude: home.lon),
                                      radius: home.radius, identifier: Self.region)
        region.notifyOnEntry = true
        region.notifyOnExit = true
        geofence.startMonitoring(for: region)
    }

    // MARK: The window

    private func open() {
        guard started == nil else { return }
        guard CMAltimeter.isRelativeAltitudeAvailable(), CMPedometer.isStepCountingAvailable() else {
            Self.error("elevator unlock: this phone has no barometer or step counter"); return
        }
        let now = Date()
        started = now
        detector = ElevatorDetector()
        rides = []
        keepAlive.allowsBackgroundLocationUpdates = true
        keepAlive.pausesLocationUpdatesAutomatically = false
        keepAlive.showsBackgroundLocationIndicator = false
        keepAlive.desiredAccuracy = kCLLocationAccuracyHundredMeters
        keepAlive.startUpdatingLocation()
        altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, err in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let err { Self.error("elevator unlock: altimeter failed: \(err.localizedDescription)"); return }
                guard let data, let s = self.started else { return }
                self.handle(self.detector.altitude(data.relativeAltitude.doubleValue, at: Date().timeIntervalSince(s)))
            }
        }
        pedometer.startUpdates(from: now) { [weak self] data, err in
            DispatchQueue.main.async {
                guard let self else { return }
                if let err { Self.error("elevator unlock: step counter failed: \(err.localizedDescription)"); return }
                guard let data, let s = self.started else { return }
                self.handle(self.detector.stepCount(data.numberOfSteps.intValue, at: Date().timeIntervalSince(s)))
            }
        }
        ends = Timer.scheduledTimer(withTimeInterval: Self.windowFor, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    private func handle(_ e: ElevatorDetector.Event) {
        switch e {
        case .none: return
        case let .noExit(rise, rideSeconds, stepsInRide):
            rides.append(["outcome": "no_exit", "rise_m": rise, "ride_s": rideSeconds, "steps_in_ride": stepsInRide])
        case let .unlock(rise, rideSeconds, stepsInRide, stepsAfter):
            var ride: [String: Any] = ["rise_m": rise, "ride_s": rideSeconds, "steps_in_ride": stepsInRide, "steps_after": stepsAfter]
            let asked = Date()
            Task {
                do {
                    let changed = try await Self.unlock()
                    ride["outcome"] = changed ? "unlocked" : "already_unlocked"
                } catch {
                    ride["outcome"] = "unlock_failed"
                    ride["error"] = String(describing: error)
                }
                ride["unlock_ms"] = Int(Date().timeIntervalSince(asked) * 1000)
                self.rides.append(ride)
                self.close()
            }
        }
    }

    /// Stops everything and stores the window: one row per ride in it, or one `no_ride` row.
    private func close() {
        guard let s = started else { return }
        started = nil
        ends?.invalidate(); ends = nil
        altimeter.stopRelativeAltitudeUpdates()
        pedometer.stopUpdates()
        keepAlive.stopUpdatingLocation()
        keepAlive.allowsBackgroundLocationUpdates = false
        let iso = ISO8601DateFormatter()
        let alt: [[Double]] = detector.alt.map { a in [(a.t * 10).rounded() / 10, (a.m * 100).rounded() / 100] }
        let steps: [[Double]] = detector.steps.map { p in [(p.t * 10).rounded() / 10, Double(p.n)] }
        let trace: [String: Any] = ["alt": alt, "steps": steps]
        let thresholds = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(detector.t))) ?? [:]
        let base: [String: Any] = ["device": "phone", "started_at": iso.string(from: s), "ended_at": iso.string(from: Date()),
                                   "thresholds": thresholds, "trace": trace]
        for r in (rides.isEmpty ? [["outcome": "no_ride"]] : rides) {
            Self.post("/api/elevator/rides", base.merging(r) { _, new in new })
        }
    }

    // MARK: CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard region.identifier == Self.region else { return }
        Task { @MainActor in self.open() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier == Self.region else { return }
        Task { @MainActor in self.close() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        Self.error("elevator unlock: the home geofence failed: \(error.localizedDescription)")
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A transient no-fix is normal for the keep-alive stream; anything else is worth seeing.
        if (error as? CLError)?.code == .locationUnknown { return }
        Self.error("elevator unlock: location failed: \(error.localizedDescription)")
    }

    // MARK: Hub

    nonisolated private static func request(_ path: String, _ method: String, _ json: [String: Any]?) -> URLRequest? {
        guard let url = URL(string: Auth.host + path), let token = Auth.token() else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.timeoutInterval = 30   // the hub answers an unlock once the lock confirms it, up to 15 s
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    nonisolated private static func home() async -> (lat: Double, lon: Double, radius: Double)? {
        guard let req = request("/api/door/home", "GET", nil) else { error("elevator unlock: no hub token"); return nil }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200, let j = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let lat = j["lat"] as? Double, let lon = j["lon"] as? Double else {
                error("elevator unlock: GET /api/door/home answered \(code)"); return nil
            }
            return (lat, lon, (j["radius_m"] as? Double) ?? 150)
        } catch {
            Self.error("elevator unlock: reading home failed: \(error.localizedDescription)"); return nil
        }
    }

    enum Failure: Error, CustomStringConvertible {
        case noToken, status(Int)
        var description: String { switch self { case .noToken: "no hub token"; case let .status(c): "HTTP \(c)" } }
    }

    /// True when the door was locked and is now unlocked; false when it was already unlocked.
    nonisolated private static func unlock() async throws -> Bool {
        guard let req = request("/api/door", "POST", ["action": "unlock", "reason": "elevator"]) else { throw Failure.noToken }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure.status(code) }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["changed"] as? Bool ?? true
    }

    nonisolated private static func post(_ path: String, _ json: [String: Any]) {
        guard let req = request(path, "POST", json) else { error("elevator unlock: no hub token to store a ride"); return }
        URLSession.shared.dataTask(with: req) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 { ClientLog.fail("elevator-ride-failed", ["error": err.map(ClientLog.describe) ?? "HTTP \(code)"]) }
        }.resume()
    }

    /// Reported to the ops responder (`ClientLog`).
    nonisolated private static func error(_ msg: String) {
        ClientLog.fail("elevator-unlock-failed", ["error": msg])
    }
}
#endif
