#if os(iOS)
import HealthKit
import UIKit

/// **Launches the watch app into a workout when a set lands while this app is in front.** The watch
/// can start its workout hold (`Watch/WorkoutHold.swift`) only while it is the app on screen, or when
/// the phone launches it this way, which reaches it in the background. The page tells native a set
/// landed (`workoutSet`, from `public/cards/workouts.js`) with that set's time; each time is acted on
/// once.
///
/// HealthKit allows the launch only while this app is active, so a set logged with the phone locked
/// starts the watch's hold when the watch app next comes to the front instead.
enum WatchWorkout {
    private static let store = HKHealthStore()
    private static var launchedFor: String?

    static func setLogged(at lastSetAt: String) {
        guard lastSetAt != launchedFor, HKHealthStore.isHealthDataAvailable(),
              UIApplication.shared.applicationState == .active else { return }
        launchedFor = lastSetAt
        let config = HKWorkoutConfiguration()
        config.activityType = .traditionalStrengthTraining
        config.locationType = .indoor
        store.startWatchApp(with: config) { ok, error in
            log(ok ? "watch-workout-launch" : "error",
                ok ? ["set": lastSetAt]
                   : ["page": "watch-workout", "msg": "watch workout launch failed: \(error?.localizedDescription ?? "no error given")"])
        }
    }

    private static func log(_ ev: String, _ fields: [String: Any]) {
        var line = fields
        line["src"] = "phone"
        line["ev"] = ev
        line["t"] = ISO8601DateFormatter().string(from: Date())
        guard let token = Auth.token(), let body = try? JSONSerialization.data(withJSONObject: line) else { return }
        var req = URLRequest(url: URL(string: Auth.host + "/api/clientlog")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        req.httpBody = body
        URLSession.shared.dataTask(with: req).resume()
    }
}
#endif
