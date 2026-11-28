#if os(iOS)
import CoreLocation
import CoreMotion
import Foundation
import UIKit
import WebKit

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
///
/// While the app is in front it also feeds the hub page's elevator pane (`cards/elevator.js`) with its
/// live state on every sensor reading (`publish`), and keeps a short log of the detector's steps.
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

    /// The hub page, for the elevator pane (StatusHubApp.swift attaches it).
    weak var web: WKWebView?
    private var homeAt: CLLocation?
    private var homeRadius: Double = 0
    private var region = "unknown"
    private var lastFix: CLLocation?
    private var lastAlt: Double?
    private var lastSteps = 0
    private var lastPhase = "idle"
    private var lastStepsAfter = 0
    /// Whether the elevator may unlock the door (`door_unlock_modes.elevator`, GET /api/door/modes). Read
    /// when watching starts and again as a ride begins, so the unlock itself waits on nothing.
    private var elevatorOn = true
    /// The pane's event log, newest last, in memory only (the rides themselves are stored).
    private var events: [[String: Any]] = []

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
        homeAt = CLLocation(latitude: home.lat, longitude: home.lon)
        homeRadius = home.radius
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
        lastPhase = "idle"; lastAlt = nil; lastSteps = 0
        Self.note("elevator-watch-start")
        event("watching", [:])
        WatchLinkWatch.shared.start()   // what the phone can see of the watch's link, logged (docs/DOOR.md)
        refreshModes()
        keepAlive.allowsBackgroundLocationUpdates = true
        keepAlive.pausesLocationUpdatesAutomatically = false
        keepAlive.showsBackgroundLocationIndicator = false
        keepAlive.desiredAccuracy = kCLLocationAccuracyHundredMeters
        keepAlive.startUpdatingLocation()
        HomeTrace.shared.start(manager: keepAlive)   // the near-home trace, and the accuracy switching (docs/DOOR.md)
        altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, err in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let err { Self.error("elevator unlock: altimeter failed: \(err.localizedDescription)"); return }
                guard let data, let s = self.started else { return }
                HomeTrace.shared.altitude(data)
                self.lastAlt = data.relativeAltitude.doubleValue
                self.handle(self.detector.altitude(data.relativeAltitude.doubleValue, at: Date().timeIntervalSince(s)))
                self.traceSteps()
            }
        }
        pedometer.startUpdates(from: now) { [weak self] data, err in
            DispatchQueue.main.async {
                guard let self else { return }
                if let err { Self.error("elevator unlock: step counter failed: \(err.localizedDescription)"); return }
                guard let data, let s = self.started else { return }
                HomeTrace.shared.pedometer(data)
                self.lastSteps = data.numberOfSteps.intValue
                self.handle(self.detector.stepCount(data.numberOfSteps.intValue, at: Date().timeIntervalSince(s)))
                self.traceSteps()
            }
        }
    }

    private func handle(_ e: ElevatorDetector.Event) {
        guard let s = started else { return }
        let at = Date().timeIntervalSince(s)
        switch e {
        case .none: return
        case let .down(drop):
            event("down", ["drop": drop])
            store(["outcome": "down", "rise_m": -drop], at: at)
        case let .noExit(rise, rideSeconds, stepsInRide):
            event("no exit", ["rise": rise])
            store(["outcome": "no_exit", "rise_m": rise, "ride_s": rideSeconds, "steps_in_ride": stepsInRide], at: at)
        case let .unlock(rise, rideSeconds, stepsInRide, stepsAfter):
            guard elevatorOn else {
                event("unlock skipped: elevator off", ["rise": rise, "steps": stepsAfter])
                store(["outcome": "disabled", "rise_m": rise, "ride_s": rideSeconds, "steps_in_ride": stepsInRide,
                       "steps_after": stepsAfter], at: at)
                return
            }
            event("unlock sent", ["rise": rise, "steps": stepsAfter])
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
                self.event(ride["outcome"] as? String ?? "?", ["ms": ride["unlock_ms"] ?? 0])
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
        HomeTrace.shared.stop()
        altimeter.stopRelativeAltitudeUpdates()
        pedometer.stopUpdates()
        keepAlive.stopUpdatingLocation()
        keepAlive.allowsBackgroundLocationUpdates = false
        Self.note("elevator-watch-stop")
        event("stopped watching", [:])
    }

    /// Re-reads the unlock modes. A failed read keeps the last value and is reported.
    private func refreshModes() {
        Task {
            guard let req = Self.request("/api/door/modes", "GET", nil) else { return }
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard code == 200, let j = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let on = j["elevator"] as? Bool else {
                    Self.error("elevator unlock: GET /api/door/modes answered \(code)"); return
                }
                if on != self.elevatorOn { self.event(on ? "elevator mode on" : "elevator mode off", [:]) }
                self.elevatorOn = on
                // Any thresholds the hub sets replace the defaults key by key.
                if let th = j["thresholds"] as? [String: Any] {
                    var cur = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self.detector.t))) as? [String: Any] ?? [:]
                    cur.merge(th) { _, new in new }
                    if let data = try? JSONSerialization.data(withJSONObject: cur),
                       let next = try? JSONDecoder().decode(ElevatorDetector.Thresholds.self, from: data) {
                        self.detector.t = next
                    } else {
                        Self.error("elevator unlock: the hub's elevator_thresholds did not decode: \(th)")
                    }
                }
                self.publish()
            } catch {
                Self.error("elevator unlock: reading the unlock modes failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: The elevator pane

    /// Logs the detector's own transitions (ride, stopped, resumed) and each step out after a stop,
    /// then publishes. Called after every reading.
    private func traceSteps() {
        guard let s = started else { return }
        let st = detector.status(now: Date().timeIntervalSince(s))
        let phase = st["phase"] as? String ?? "idle"
        if phase != lastPhase {
            switch (lastPhase, phase) {
            case ("idle", "riding"): event("ride up", ["from": st["base"] ?? 0]); refreshModes()
            case ("riding", "stopped"): event("stopped", ["rise": st["rise"] ?? 0])
            case ("stopped", "riding"): event("moving again", ["rise": st["rise"] ?? 0])
            case ("idle", "falling"): event("ride down", [:])
            default: break
            }
            lastPhase = phase
            lastStepsAfter = 0
        }
        if phase == "stopped", let n = st["steps_after"] as? Int, n != lastStepsAfter {
            lastStepsAfter = n
            event("step", ["n": n, "of": st["steps_needed"] ?? 0])
        }
        publish()
    }

    /// A line in the elevator pane's live log. Also used by `WatchLinkWatch`.
    func event(_ what: String, _ fields: [String: Any]) {
        var e = fields
        e["what"] = what
        e["at"] = ISO8601DateFormatter().string(from: Date())
        events.append(e)
        if events.count > 60 { events.removeFirst(events.count - 60) }
        publish()
    }

    /// The live state, to the page as a `hub:elevator` event. Only while the app is in front.
    /// The pane asked: its switches may have changed, so re-read them (which publishes), and publish now.
    func pageAsked() {
        refreshModes()
        publish()
    }

    func publish() {
        guard let web, UIApplication.shared.applicationState == .active else { return }
        var d: [String: Any] = ["watching": started != nil, "region": region, "radius": homeRadius, "elevator_on": elevatorOn,
                                "steps": lastSteps, "events": events]
        if let s = started {
            d["since"] = ISO8601DateFormatter().string(from: s)
            d["detector"] = detector.status(now: Date().timeIntervalSince(s))
            d["thresholds"] = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(detector.t))) ?? [:]
        }
        if let a = lastAlt { d["alt"] = a }
        d["trace"] = HomeTrace.shared.status
        if let f = lastFix {
            var fix: [String: Any] = ["lat": f.coordinate.latitude, "lon": f.coordinate.longitude,
                                      "acc": f.horizontalAccuracy, "at": ISO8601DateFormatter().string(from: f.timestamp)]
            if let h = homeAt { fix["home_m"] = f.distance(from: h) }
            d["fix"] = fix
        }
        guard let json = try? JSONSerialization.data(withJSONObject: d), let s = String(data: json, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('hub:elevator',{detail:\(s)}))", completionHandler: nil)
    }

    // MARK: CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard region.identifier == Self.region else { return }
        Task { @MainActor in self.region = "inside"; self.event("entered home area", [:]); self.open() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier == Self.region else { return }
        Task { @MainActor in self.region = "outside"; self.event("left home area", [:]); self.close() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard region.identifier == Self.region else { return }
        Task { @MainActor in
            self.region = state == .inside ? "inside" : state == .outside ? "outside" : "unknown"
            if state == .inside { self.open() } else if state == .outside { self.close() }
            self.publish()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in
            locations.forEach { HomeTrace.shared.fix($0) }
            self.lastFix = last; self.publish()
        }
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
