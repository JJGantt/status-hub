import Foundation

/// `/api/workout-now`: the inputs to the home wall's rest clocks and set tally, and every exercise
/// logged today, newest first by its last set.
struct WorkoutNow: Decodable {
    struct Muscle: Decodable { let label: String; let sets: Double; let color: String; let primary: Bool }
    struct Lift: Decodable { let weight_lbs: Double?; let reps: Int? }
    struct Exercise: Decodable { let name: String; let sets: [Lift]; let muscles: [Muscle] }
    let last_set_at: String?
    let session_start_at: String?
    let sets_today: Int?
    let exercises: [Exercise]
    /// Body-map region id → fill for the figures, the week's training (see BodyFigure).
    let body: [String: String]?
    /// Every muscle's sets this week against its goal, furthest behind first, in its volume colour.
    struct Volume: Decodable { let label: String; let sets: Double; let target: Double; let color: String }
    let volume: [Volume]?
}

@MainActor
final class Workout: ObservableObject {
    @Published private(set) var now: WorkoutNow?
    private var loading = false
    private var reloadAfter = false
    private var stream: Task<Void, Never>?
    private var live = false

    init() {
        WorkoutHold.shared.changed = { [weak self] in self?.refollow() }
    }

    /// **The workout stream is open while the app is in front, on any page, and while a workout is
    /// held**, not only while the day page shows it: a set logged by any path is what starts and
    /// extends the hold (`WorkoutHold`), and a set spoken from home has to reach it. Returns the load it
    /// started, for the day page to wait on.
    @discardableResult func follow(live: Bool) -> Task<Void, Never>? {
        self.live = live
        return refollow()
    }

    @discardableResult private func refollow() -> Task<Void, Never>? {
        guard live || WorkoutHold.shared.isHolding else { deactivate(); return nil }
        let loaded = Task { await load() }
        if stream == nil { openStream() }
        return loaded
    }

    private func openStream() {
        stream = Task { await Hub.follow("workout") { [weak self] in await self?.load() } }
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
    }

    /// One past day's exercises, most recent first, for the history view. The muscle chips are this
    /// week's and say nothing about a day in the past, so a past day's rows carry none.
    func day(_ date: String) async -> [WorkoutNow.Exercise] {
        struct Day: Decodable {
            struct Ex: Decodable { let name: String; let sets: [WorkoutNow.Lift] }
            let exercises: [Ex]
        }
        guard let d: Day = try? await Hub.json("/api/workout-day?date=" + date) else { return [] }
        return d.exercises.map { WorkoutNow.Exercise(name: $0.name, sets: $0.sets, muscles: []) }
    }

    func load() async {
        if loading { reloadAfter = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAfter = false
            if let n: WorkoutNow = try? await Hub.json("/api/workout-now") { now = n; WorkoutHold.shared.saw(lastSetAt: n.last_set_at) }
        } while reloadAfter
    }
}
