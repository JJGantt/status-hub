#if os(iOS)
import CoreLocation
import CoreMotion
import Foundation
import UIKit

/// Unlocks the front door when he rides the elevator up and walks out of it (docs/DOOR.md).
///
/// WHILE HE IS NEAR HOME (a geofence on `app_settings.home_location`, from `GET /api/door/home`) the app
/// keeps itself running with low-accuracy background location updates (the only way an app may keep
/// running in the background, and the reason for `location` in UIBackgroundModes), reads the
/// barometer (`CMAltimeter`) and the step counter (`CMPedometer`) without a break, and feeds both to
/// `ElevatorDetector`. Its unlock unlocks the door through `POST /api/door`. Watching goes on after an
/// unlock (a trip down for the mail and back up is another ride). Leaving the geofence stops all of it;
/// entering it, which wakes the app even after iOS has terminated it, starts it again, and so does a
/// launch inside it.
///
/// Every ride, up or down, unlocked or not, is stored with its trace (`POST /api/elevator/rides`, table
/// `elevator_rides`) a minute after it, so the thresholds can be tuned from real rides.
@MainActor
final class ElevatorUnlock: NSObject, CLLocationManagerDelegate {
    static let shared = ElevatorUnlock()

    nonisolated private static let region = "home-door"
    /// How much trace goes with a ride: this long before it, and the minute after.
    private static let traceBefore: TimeInterval = 4 * 60

    private let geofence = CLLocationManager()
    /// Keeps the app running through a window; its positions are not used.
    private let keepAlive = CLLocationManager()
    private let altimeter = CMAltimeter()
    private let pedometer = CMPedometer()

    private var detector = ElevatorDetector()
    private var started: Date?

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
        geofence.requestState(for: region)   // already inside at launch: start now
    }

    // MARK: Watching

    private func open() {
        guard started == nil else { return }
        guard CMAltimeter.isRelativeAltitudeAvailable(), CMPedometer.isStepCountingAvailable() else {
            Self.error("elevator unlock: this phone has no barometer or step counter"); return
        }
        let now = Date()
        started = now
        detector = ElevatorDetector()
        Self.note("elevator-watch-start")
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
    }

    private func handle(_ e: ElevatorDetector.Event) {
        guard let s = started else { return }
        let at = Date().timeIntervalSince(s)
        switch e {
        case .none: return
        case let .down(drop):
            store(["outcome": "down", "rise_m": -drop], at: at)
        case let .noExit(rise, rideSeconds, stepsInRide):
            store(["outcome": "no_exit", "rise_m": rise, "ride_s": rideSeconds, "steps_in_ride": stepsInRide], at: at)
        case let .unlock(rise, rideSeconds, stepsInRide, stepsAfter):
            var ride: [String: Any] = ["rise_m": rise, "ride_s": rideSeconds, "steps_in_ride": stepsInRide, "steps_after": stepsAfter]
            let asked = Date()
            Task {
                do {
                    try await Self.unlock()
                    ride["outcome"] = "unlocked"
                } catch {
                    ride["outcome"] = "unlock_failed"
                    ride["error"] = String(describing: error)
                }
                ride["unlock_ms"] = Int(Date().timeIntervalSince(asked) * 1000)
                self.store(ride, at: at)
            }
        }
    }

    /// Stores a ride a minute after `at` (seconds into watching), with the trace from `traceBefore`
    /// ahead of it to then. Sent at once instead if watching stops first.
    private func store(_ ride: [String: Any], at: TimeInterval) {
        guard let s = started else { return }
        let send = { [weak self] in
            guard let self else { return }
            let from = at - Self.traceBefore
            let alt: [[Double]] = self.detector.alt.filter { $0.t >= from }.map { a in [(a.t * 10).rounded() / 10, (a.m * 100).rounded() / 100] }
            let steps: [[Double]] = self.detector.steps.filter { $0.t >= from }.map { p in [(p.t * 10).rounded() / 10, Double(p.n)] }
            let iso = ISO8601DateFormatter()
            let thresholds = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self.detector.t))) ?? [:]
            let row: [String: Any] = ["device": "phone", "started_at": iso.string(from: s.addingTimeInterval(at)),
                                      "ended_at": iso.string(from: Date()), "thresholds": thresholds,
                                      "trace": ["t0": iso.string(from: s), "alt": alt, "steps": steps]]
            Self.post("/api/elevator/rides", row.merging(ride) { _, new in new })
        }
        pendingStores.append(send)
        Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.pendingStores.isEmpty else { return }
                self.pendingStores.removeFirst()()
            }
        }
    }
    private var pendingStores: [() -> Void] = []

    /// Leaving the area: stores anything still waiting, then stops everything.
    private func close() {
        guard started != nil else { return }
        let waiting = pendingStores
        pendingStores = []
        waiting.forEach { $0() }
        started = nil
        altimeter.stopRelativeAltitudeUpdates()
        pedometer.stopUpdates()
        keepAlive.stopUpdatingLocation()
        keepAlive.allowsBackgroundLocationUpdates = false
        Self.note("elevator-watch-stop")
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

    nonisolated func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard region.identifier == Self.region else { return }
        Task { @MainActor in if state == .inside { self.open() } else if state == .outside { self.close() } }
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

    /// Answers once the lock reports unlocked. Sent whether or not it already was; that costs nothing.
    nonisolated private static func unlock() async throws {
        guard let req = request("/api/door", "POST", ["action": "unlock", "reason": "elevator"]) else { throw Failure.noToken }
        let (_, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw Failure.status(code) }
    }

    nonisolated private static func post(_ path: String, _ json: [String: Any]) {
        guard let req = request(path, "POST", json) else { error("elevator unlock: no hub token to store a ride"); return }
        URLSession.shared.dataTask(with: req) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 { ClientLog.fail("elevator-ride-failed", ["error": err.map(ClientLog.describe) ?? "HTTP \(code)"]) }
        }.resume()
    }

    /// A plain client-log line with the battery level, which is how the cost of watching is measured.
    nonisolated private static func note(_ ev: String) {
        Task { @MainActor in
            UIDevice.current.isBatteryMonitoringEnabled = true
            let level = Int((UIDevice.current.batteryLevel * 100).rounded())
            guard let req = request("/api/clientlog", "POST", ["src": "phone", "ev": ev, "phone_battery": level,
                                                               "t": ISO8601DateFormatter().string(from: Date())]) else { return }
            URLSession.shared.dataTask(with: req).resume()
        }
    }

    /// Reported to the ops responder (`ClientLog`).
    nonisolated private static func error(_ msg: String) {
        ClientLog.fail("elevator-unlock-failed", ["error": msg])
    }
}
#endif
