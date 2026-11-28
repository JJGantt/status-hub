#if os(iOS)
import CoreLocation
import CoreMotion
import Foundation

/// The near-home trace (docs/DOOR.md § Near-home trace): while ElevatorUnlock is watching inside the
/// home geofence, every barometer sample, step-counter update, location fix and motion-activity change is
/// recorded and uploaded in chunks to `POST /api/home-trace` (table `home_trace`). Logging only: it is the
/// data the entrance-unlock thresholds will be picked from; nothing here acts on it.
///
/// It also sets the keep-alive location manager's accuracy (TracePolicy): best while he is moving, low
/// once he has been stationary for two minutes, each switch recorded in the chunk's `modes`.
///
/// A chunk is cut every `chunkEvery` seconds and when watching stops. A chunk whose upload fails is kept
/// and sent again at the next cut; the failure is reported once per run of failures.
@MainActor
final class HomeTrace {
    static let shared = HomeTrace()

    private static let chunkEvery: TimeInterval = 30

    private let activityManager = CMMotionActivityManager()
    private weak var locationManager: CLLocationManager?
    private var timer: Timer?

    private var chunkStart = Date()
    private var alt: [[Any]] = []
    private var steps: [[Any]] = []
    private var fixes: [[Any]] = []
    private var activity: [[Any]] = []
    private var modes: [[Any]] = []
    private var unsent: [[String: Any]] = []
    private var failing = false

    private(set) var mode = TracePolicy.Mode.low
    private(set) var lastActivity = TracePolicy.Activity.unknown
    private var stationarySince: TimeInterval?
    private(set) var lastChunkAt: Date?
    private var running = false

    /// Starts recording; `manager` is the keep-alive location manager whose accuracy this sets.
    func start(manager: CLLocationManager) {
        guard !running else { return }
        running = true
        locationManager = manager
        chunkStart = Date()
        setMode(.low, force: true)
        if CMMotionActivityManager.isActivityAvailable() {
            activityManager.startActivityUpdates(to: .main) { [weak self] a in
                MainActor.assumeIsolated { if let a { self?.activityChanged(a) } }
            }
        } else {
            ClientLog.fail("home-trace-failed", ["error": "motion activity not available on this phone"])
        }
        timer = Timer.scheduledTimer(withTimeInterval: Self.chunkEvery, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    /// Stops recording and sends what is buffered.
    func stop() {
        guard running else { return }
        running = false
        activityManager.stopActivityUpdates()
        timer?.invalidate(); timer = nil
        cut()
    }

    private func t(_ at: Date = Date()) -> Double { (at.timeIntervalSince(chunkStart) * 10).rounded() / 10 }
    private static func r(_ v: Double, _ places: Double) -> Double { (v * places).rounded() / places }

    func altitude(_ d: CMAltitudeData) {
        guard running else { return }
        alt.append([t(), Self.r(d.relativeAltitude.doubleValue, 100), Self.r(d.pressure.doubleValue, 10000)])
    }

    func pedometer(_ d: CMPedometerData) {
        guard running else { return }
        steps.append([t(), d.numberOfSteps.intValue, d.currentCadence.map { Self.r($0.doubleValue, 100) } ?? NSNull(),
                      d.currentPace.map { Self.r($0.doubleValue, 100) } ?? NSNull()])
    }

    func fix(_ l: CLLocation) {
        guard running else { return }
        fixes.append([t(l.timestamp), Self.r(l.coordinate.latitude, 1e6), Self.r(l.coordinate.longitude, 1e6),
                      Self.r(l.horizontalAccuracy, 10), Self.r(l.altitude, 10), Self.r(l.verticalAccuracy, 10),
                      Self.r(l.speed, 100), Self.r(l.course, 10)])
    }

    private func activityChanged(_ a: CMMotionActivity) {
        let kind: TracePolicy.Activity = a.stationary ? .stationary : a.walking ? .walking : a.running ? .running
            : a.automotive ? .automotive : a.cycling ? .cycling : .unknown
        activity.append([t(a.startDate), kind.rawValue, a.confidence.rawValue])
        let now = Date().timeIntervalSince1970
        if kind == .stationary { if stationarySince == nil { stationarySince = a.startDate.timeIntervalSince1970 } }
        else if kind != .unknown { stationarySince = nil }
        lastActivity = kind
        apply(now)
    }

    /// Re-decides the accuracy: on every activity change, and at every chunk cut for the stationary timeout.
    private func apply(_ now: TimeInterval) {
        setMode(TracePolicy.mode(current: mode, activity: lastActivity, stationarySince: stationarySince, now: now))
    }

    private func setMode(_ m: TracePolicy.Mode, force: Bool = false) {
        guard force || m != mode else { return }
        mode = m
        if let lm = locationManager {
            lm.desiredAccuracy = m == .best ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        }
        modes.append([t(), m.rawValue])
        ElevatorUnlock.shared.event("trace accuracy \(m.rawValue)", ["activity": lastActivity.rawValue])
    }

    private func tick() {
        apply(Date().timeIntervalSince1970)
        cut()
    }

    /// Closes the current chunk and sends every chunk not yet accepted.
    private func cut() {
        let end = Date()
        if !(alt.isEmpty && steps.isEmpty && fixes.isEmpty && activity.isEmpty && modes.isEmpty) {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            unsent.append(["device": "phone", "started_at": iso.string(from: chunkStart), "ended_at": iso.string(from: end),
                           "alt": alt, "steps": steps, "fixes": fixes, "activity": activity, "modes": modes])
        }
        alt = []; steps = []; fixes = []; activity = []; modes = []
        chunkStart = end
        guard !unsent.isEmpty else { return }
        let batch = unsent
        unsent = []
        Task { await self.send(batch) }
    }

    private func send(_ batch: [[String: Any]]) async {
        var left: [[String: Any]] = []
        var why: String?
        for chunk in batch {
            guard let url = URL(string: Auth.host + "/api/home-trace"), let token = Auth.token(),
                  let body = try? JSONSerialization.data(withJSONObject: chunk) else { left.append(chunk); why = "no hub token"; continue }
            var r = URLRequest(url: url)
            r.httpMethod = "POST"
            r.timeoutInterval = 20
            r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = body
            do {
                let (_, resp) = try await URLSession.shared.data(for: r)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if code == 200 { lastChunkAt = Date() } else { left.append(chunk); why = "HTTP \(code)" }
            } catch {
                left.append(chunk); why = ClientLog.describe(error)
            }
        }
        unsent = left + unsent
        if let why {
            if !failing { ClientLog.fail("home-trace-failed", ["error": why, "kept": unsent.count]) }
            failing = true
        } else {
            failing = false
        }
    }

    /// What the elevator pane shows (ElevatorUnlock.publish).
    var status: [String: Any] {
        var d: [String: Any] = ["running": running, "mode": mode.rawValue, "activity": lastActivity.rawValue, "unsent": unsent.count]
        if let at = lastChunkAt { d["last_chunk"] = ISO8601DateFormatter().string(from: at) }
        return d
    }
}
#endif
