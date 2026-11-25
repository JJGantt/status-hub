import Foundation
import HealthKit
import Watchset
import WatchKit

/// **A workout session while he is lifting, so a wrist raise comes back to this app.** watchOS returns
/// to the clock face a little while after the wrist drops; an app holding an `HKWorkoutSession` is the
/// exception, and is what a raise shows instead. So a logged set (by any path: a voice command, the
/// hub's add-set button, the rep watcher) starts one, every later set keeps it going, and it ends
/// `idle` after the last set.
///
/// **It can only START while the app is in front**, or when the phone launches it for a workout
/// (`handle(_:)` in `WatchAppDelegate`, from `Sources/WatchWorkout.swift`). watchOS refuses a session
/// started from the background. So a set logged while neither app is open starts it the next time
/// this app comes to the front with that set still under `idle` old. Once running it keeps the app
/// alive wrist-down, which keeps the workout stream (`Workout`) open, which is how later sets extend it.
///
/// The end is a clock arrival, not a poll: the deadline is held in memory and one sleep runs to it.
///
/// **Watchset's capture rides the same session** (`Packages/Watchset`, through `WatchsetHost` in
/// `StatusHubWatchApp`): while its counter is watching, the hold does not end on the idle deadline,
/// and when watching stops it ends on that deadline as usual. Only one app can hold a workout session
/// at a time, which is why Watchset is a page of this app and holds none of its own.
@MainActor
final class WorkoutHold: NSObject {
    static let shared = WorkoutHold()

    /// How long after the last set the session ends.
    static let idle: TimeInterval = 10 * 60

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    /// When the session ends, unless another set moves it.
    private var ends: Date?
    private var ender: Task<Void, Never>?
    private var starting = false
    /// Watchset's counter is watching: the hold stays on whatever the deadline says.
    private var captureHeld = false

    /// Told whenever the session starts or ends, so the workout stream can open or close behind it.
    var changed: (() -> Void)?

    var isHolding: Bool { session != nil }

    /// The newest set's naive wall-clock time, as `/api/workout-now` gives it. Starts the session when
    /// that set is recent and the app is in front, and moves the end to `idle` after it.
    func saw(lastSetAt naive: String?) {
        guard let naive, let at = wallClock(naive) else { return }
        let age = max(0, wallClock(Date()) - at)
        guard age < Self.idle else { return }   // a running session ends on its own deadline
        extend(to: Date().addingTimeInterval(Self.idle - age))
        if session == nil, WKApplication.shared().applicationState == .active {
            Task { await start(why: "set") }
        }
    }

    /// The phone launched the app for a workout: a set was just logged there. Started whatever the app's
    /// state, since this is the one launch watchOS lets begin in the background, then timed off the set.
    func phoneAsked() async {
        if ends == nil || ends! < Date() { extend(to: Date().addingTimeInterval(Self.idle)) }
        await start(why: "phone")
        if let n: WorkoutNow = try? await Hub.json("/api/workout-now") { saw(lastSetAt: n.last_set_at) }
    }

    /// Watchset started watching (a tap on its Start, so the app is in front). Nil once the session
    /// is holding, else why it is not.
    func holdForCapture() async -> String? {
        captureHeld = true
        await start(why: "watchset")
        return session == nil ? "workout session did not start" : nil
    }

    /// Watchset stopped watching. The hold carries on to the idle deadline after the newest set, and
    /// ends now when there is none.
    func releaseCapture() {
        captureHeld = false
        guard session != nil else { return }
        if let e = ends, e > Date() { extend(to: e, force: true) } else { Task { await stop(why: "watchset-off") } }
    }

    private func extend(to deadline: Date, force: Bool = false) {
        if !force, let e = ends, e >= deadline, ender != nil { return }
        ends = deadline
        ender?.cancel()
        ender = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, let e = self.ends, e <= Date(), !self.captureHeld else { return }
            await self.stop(why: "idle")
        }
    }

    private func start(why: String) async {
        guard session == nil, !starting else { return }
        starting = true
        defer { starting = false }
        guard HKHealthStore.isHealthDataAvailable() else {
            return Hub.log("error", ["page": "workout-hold", "msg": "workout hold: HealthKit unavailable"])
        }
        let types: Set = [HKObjectType.workoutType()]
        do {
            try await store.requestAuthorization(toShare: types, read: types)
        } catch {
            return Hub.log("error", ["page": "workout-hold", "msg": "workout hold authorization: \(error.localizedDescription)"])
        }
        let config = HKWorkoutConfiguration()
        config.activityType = .traditionalStrengthTraining
        config.locationType = .indoor
        do {
            let s = try HKWorkoutSession(healthStore: store, configuration: config)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            s.delegate = self
            session = s
            builder = b
            s.startActivity(with: Date())
            try await b.beginCollection(at: Date())
            KeepAlive.shared.update(holding: true)
            Hub.log("workout-hold", ["on": true, "why": why,
                                     "until": ends.map { ISO8601DateFormatter().string(from: $0) } ?? ""])
            changed?()
        } catch {
            session?.end()
            session = nil
            builder = nil
            Hub.log("error", ["page": "workout-hold", "msg": "workout hold start (\(why)): \(error.localizedDescription)"])
        }
    }

    private func stop(why: String) async {
        captureHeld = false
        ender?.cancel()
        ender = nil
        ends = nil
        guard let s = session else { return }
        let b = builder
        session = nil
        builder = nil
        s.end()
        if let b {
            do {
                try await b.endCollection(at: Date())
                _ = try await b.finishWorkout()
            } catch {
                Hub.log("error", ["page": "workout-hold", "msg": "workout hold save: \(error.localizedDescription)"])
            }
        }
        KeepAlive.shared.update(holding: false)
        Hub.log("workout-hold", ["on": false, "why": why])
        changed?()
    }
}

extension WorkoutHold: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState, date: Date) {
        // Ended from outside (the workout ended in Control Center, or another app started one): let go,
        // and say so, since nothing here asked for it.
        guard toState == .ended else { return }
        Task { @MainActor in
            guard self.session === workoutSession else { return }
            await self.stop(why: "ended-elsewhere")
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        let msg = error.localizedDescription
        Task { @MainActor in
            guard self.session === workoutSession else { return }
            Hub.log("error", ["page": "workout-hold", "msg": "workout hold failed: \(msg)"])
            await self.stop(why: "failed")
        }
    }
}
