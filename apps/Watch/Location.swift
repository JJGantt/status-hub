import CoreLocation

/// Where the watch is, sent with each command so "near me" and a pickup point have something to go on.
///
/// The first position watchOS hands over is often a cell-tower one kilometres wide, with a GPS fix a few
/// seconds behind it, so this keeps listening for the whole window and sends the most precise fix it saw,
/// returning early as soon as one is GPS-grade. A fresh GPS-grade fix already in hand is reused. The window
/// is two seconds so a command never waits on the GPS; no permission or no fix in time means the command
/// goes without (`get_location` also reads the phone's history, data-layer `location.ts`).
@MainActor
final class Here: NSObject, CLLocationManagerDelegate {
    static let shared = Here()
    private static let gpsGrade: CLLocationAccuracy = 50  // metres; a cell or Wi-Fi position is hundreds+
    private let manager = CLLocationManager()
    private var waiting: [CheckedContinuation<CLLocation?, Never>] = []
    private var best: CLLocation?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func fix() async -> CLLocation? {
        if let l = manager.location, -l.timestamp.timeIntervalSinceNow < 120,
           l.horizontalAccuracy >= 0, l.horizontalAccuracy <= Self.gpsGrade { return l }
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
            if waiting.count == 1 {
                best = nil
                manager.startUpdatingLocation()
                Task { try? await Task.sleep(for: .seconds(2)); self.finish() }
            }
        }
    }

    private func finish() {
        guard !waiting.isEmpty else { return }
        manager.stopUpdatingLocation()
        let w = waiting, l = best
        waiting = []
        best = nil
        w.forEach { $0.resume(returning: l) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            guard !self.waiting.isEmpty else { return }
            for l in locations where l.horizontalAccuracy >= 0 {
                if self.best == nil || l.horizontalAccuracy < self.best!.horizontalAccuracy { self.best = l }
            }
            if let b = self.best, b.horizontalAccuracy <= Self.gpsGrade { self.finish() }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        // A transient failure (no signal yet) is not the end of the window; the deadline still sends the best seen.
    }
}
