import Foundation

/// `/api/workout-now`: the home wall's workout block — the inputs to its clocks, today's set tally, and
/// the exercise the last set went onto.
struct WorkoutNow: Decodable {
    struct Muscle: Decodable { let label: String; let sets: Double; let color: String; let primary: Bool }
    struct Lift: Decodable { let weight_lbs: Double?; let reps: Int? }
    struct Recent: Decodable { let name: String; let sets: [Lift]; let muscles: [Muscle] }
    let last_set_at: String?
    let session_start_at: String?
    let sets_today: Int?
    let recent: Recent?
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
