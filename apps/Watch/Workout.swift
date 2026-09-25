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

    /// The page is on screen: load now, and follow changes until `deactivate`.
    func activate() {
        Task { await load() }
        guard stream == nil else { return }
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
            if let n: WorkoutNow = try? await Hub.json("/api/workout-now") { now = n }
        } while reloadAfter
    }
}
