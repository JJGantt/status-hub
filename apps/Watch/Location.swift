import CoreLocation

/// Where the watch is, sent with each command so "near me" and a pickup point have something to go on.
///
/// The first position watchOS hands over is often a cell-tower one kilometres wide, with a GPS fix a few
/// seconds behind it. So `warm()` starts listening the moment a command's microphone opens, keeping the most
/// precise fix seen and stopping once one is GPS-grade (or after `warmFor`), and `fix()` at send time takes
/// whatever that found without waiting: the speaking time is the GPS time, and a command is never held for
/// it. Only a `fix()` with no warm-up behind it listens itself, for at most `window`. No permission or no
/// fix means the command goes without (`get_location` also reads the phone's history, data-layer `location.ts`).
@MainActor
final class Here: NSObject, CLLocationManagerDelegate {
    static let shared = Here()
    private static let gpsGrade: CLLocationAccuracy = 50  // metres; a cell or Wi-Fi position is hundreds+
    private let manager = CLLocationManager()
    private var waiting: [CheckedContinuation<CLLocation?, Never>] = []
    private var best: CLLocation?
    private var listening = false
    private var run = 0   // which listen a deadline belongs to, so an old one cannot cut a new one short
    private var warmedAt: Date?
    private static let warmFor: Duration = .seconds(30)
    private static let window: Duration = .seconds(2)

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    /// A command's microphone just opened: start looking, so `fix()` has an answer when it is sent.
    func warm() {
        guard permitted(), !listening else { return }
        best = nil
        warmedAt = Date()
        listen(for: Self.warmFor)
    }

    func fix() async -> CLLocation? {
        if let l = manager.location, -l.timestamp.timeIntervalSinceNow < 120,
           l.horizontalAccuracy >= 0, l.horizontalAccuracy <= Self.gpsGrade { return l }
        // Warmed for this command: take what it found, never wait.
        if let w = warmedAt, -w.timeIntervalSinceNow < 120 {
            let l = best ?? manager.location
            stop()
            warmedAt = nil
            return l
        }
        guard permitted() else { return nil }
        return await withCheckedContinuation { c in
            waiting.append(c)
            if !listening { best = nil; listen(for: Self.window) }
        }
    }

    private func permitted() -> Bool {
        switch manager.authorizationStatus {
        case .notDetermined:
            // The prompt appears now; this command goes without and the next one has a fix.
            manager.requestWhenInUseAuthorization()
            return false
        case .denied, .restricted:
            return false
        default:
            return true
        }
    }

    private func listen(for limit: Duration) {
        listening = true
        run += 1
        let mine = run
        manager.startUpdatingLocation()
        Task { try? await Task.sleep(for: limit); if self.run == mine { self.stop() } }
    }

    /// Stops listening and hands the best fix to anyone waiting; the fix itself stays in `best` for `fix()`.
    private func stop() {
        guard listening else { return }
        listening = false
        manager.stopUpdatingLocation()
        let w = waiting
        waiting = []
        w.forEach { $0.resume(returning: best) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            guard self.listening else { return }
            for l in locations where l.horizontalAccuracy >= 0 {
                if self.best == nil || l.horizontalAccuracy < self.best!.horizontalAccuracy { self.best = l }
            }
            if let b = self.best, b.horizontalAccuracy <= Self.gpsGrade { self.stop() }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        // A transient failure (no signal yet) is not the end of the window; the limit still ends it with the best seen.
    }
}
