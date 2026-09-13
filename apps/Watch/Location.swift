import CoreLocation

/// Where the watch is, sent with each command so "near me" and a pickup point have something to go on.
/// A fix up to two minutes old is reused; otherwise one is asked for and given up on after two seconds,
/// so a command never waits on the GPS. No permission or no fix in time means the command goes without.
@MainActor
final class Here: NSObject, CLLocationManagerDelegate {
    static let shared = Here()
    private let manager = CLLocationManager()
    private var waiting: [CheckedContinuation<CLLocation?, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func fix() async -> CLLocation? {
        if let l = manager.location, -l.timestamp.timeIntervalSinceNow < 120 { return l }
        switch manager.authorizationStatus {
        case .notDetermined:
            // The prompt appears now; this command goes without and the next one has a fix.
            manager.requestWhenInUseAuthorization()
            return nil
        case .denied, .restricted:
            return nil
        default:
            break
        }
        return await withCheckedContinuation { c in
            waiting.append(c)
            if waiting.count == 1 { manager.requestLocation() }
            Task { try? await Task.sleep(for: .seconds(2)); self.finish(nil) }
        }
    }

    private func finish(_ l: CLLocation?) {
        let w = waiting
        waiting = []
        w.forEach { $0.resume(returning: l) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let l = locations.last
        Task { @MainActor in self.finish(l) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
