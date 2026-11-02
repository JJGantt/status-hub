import Foundation

/// Today's nutrition day, as `/api/nutrition-day?date=today` returns it.
struct NutritionDay: Decodable {
    struct Targets: Decodable { let protein_g: Double?, carbs_g: Double?, fat_g: Double? }
    struct Entry: Decodable, Identifiable {
        struct Ingredient: Decodable {
            let food: String?
            let name: String?
            let amount: Double?
            let unit: String?
            let calories: Double?, protein_g: Double?, carbs_g: Double?, fat_g: Double?

            /// What it is, with its portion: the stored `name` already reads "2 cup nonfat milk", and
            /// the parts are there to build one when it does not.
            var label: String {
                if let n = name, !n.isEmpty { return n }
                let food = food ?? ""
                guard let a = amount else { return food }
                return [js(a), unit ?? "", food].filter { !$0.isEmpty }.joined(separator: " ")
            }
        }

        let id: String
        let occurred_at: String?
        let name: String?
        let calories: Double?, protein_g: Double?, carbs_g: Double?, fat_g: Double?
        let staged: Bool?
        let ingredients: [Ingredient]?
    }
    let date: String
    let total_cal: Double, total_protein: Double, total_carbs: Double, total_fat: Double
    let target_cal: Double?
    let target_macros: Targets?
    let entries: [Entry]
}

/// `/api/nut-history`: the intake calendar and the weigh-in plot over the same weeks, so a column is
/// the same week in both.
struct NutHistory: Decodable {
    /// A day: its colour, whether it is today, and its date, which a tap on the history view asks for.
    struct Cell: Decodable { let c: String?; let t: Int?; let d: String? }
    struct Point: Decodable { let x: Double?; let y: Double? }
    struct Plot: Decodable {
        /// The three values written over the plot's left end: a label and where on the box it sits.
        struct Axis: Decodable { let v: String; let y: Double }
        let points: [Point]
        let axis: [Axis]
    }
    let weeks: [[Cell]]
    /// The training map, in the same shape as the food one so both draw through one routine.
    let sets: [[Cell]]?
    let weight: Plot
}

/// One ring at one instant — the values `cards/nutrition.js` draws each second.
struct RingNow {
    let base: Double, over: Double
    let frac: Double
    let stagedMark: Double?
    let dev: Int
    let baseColor: String, overColor: String?, devColor: String
    let consumed: Int, goal: Int
}

/// The rings and today's log. Every value comes from the hub (`/api/rings` is lib/pace.js stepped a
/// minute at a time for an hour); the watch only places the instant between two of those minutes.
@MainActor
final class Nutrition: ObservableObject {
    @Published private(set) var feed: RingsFeed?
    @Published private(set) var day: NutritionDay?
    /// The calendar and the plot behind the rings, loaded when the user first turns to them.
    @Published private(set) var history: NutHistory?
    /// Every week back to the first meal or set logged, for the history view.
    @Published private(set) var fullHistory: NutHistory?
    @Published private(set) var weight: WeightView?

    /// The start of the minute the hub built `feed` in. Its clock is minute-resolution, so frame `t`
    /// describes `anchor + t` minutes.
    private var anchor = Date()
    private var loading = false
    private var reloadAfter = false
    private var stream: Task<Void, Never>?
    private var expiry: Task<Void, Never>?

    /// The page is on screen: load now, and follow changes until `deactivate`.
    @discardableResult func activate() -> Task<Void, Never> {
        let loaded = Task { await load() }
        if stream == nil { openStream() }
        return loaded
    }

    private func openStream() {
        stream = Task { await Hub.follow("nutrition") { [weak self] in await self?.load() } }
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
        expiry?.cancel()
        expiry = nil
    }

    /// The history is a tap away rather than part of every load: it is months of days and a plot, and
    /// most of the time the page is the log. **But once it has been fetched it is kept current**, by
    /// `load()` below — it was fetched exactly once and never again, so a meal logged after that
    /// moment moved the rings and left today's cell on the heat map showing the colour it had before
    /// the food, for as long as the app stayed up.
    func loadFullHistory() async {
        if let h: NutHistory = try? await Hub.json("/api/nut-history?all=1") { fullHistory = h }
    }

    func loadWeight() async {
        if let w: WeightView = try? await Hub.json("/api/weight-view") { weight = w }
    }

    /// One past day's log, for the history view.
    func day(_ date: String) async -> NutritionDay? {
        try? await Hub.json("/api/nutrition-day?date=" + date)
    }

    func loadHistory() async {
        history = try? await Hub.json("/api/nut-history?weeks=30")
    }

    func load() async {
        if loading { reloadAfter = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAfter = false
            let sent = Date()
            async let rings: RingsFeed = Hub.json("/api/rings")
            async let today: NutritionDay = Hub.json("/api/nutrition-day?date=today")
            if let f = try? await rings {
                let mid = sent.addingTimeInterval(Date().timeIntervalSince(sent) / 2)
                anchor = Date(timeIntervalSince1970: (mid.timeIntervalSince1970 / 60).rounded(.down) * 60)
                feed = f
                refetchWhenFramesEnd(f.frames.count)
            }
            if let d = try? await today { day = d }
            // Only for someone who has already opened it: this runs on every nutrition change.
            if history != nil { await loadHistory() }
        } while reloadAfter
    }

    /// The frames cover an hour from the fetch. Past the last one there is nothing true to draw, so
    /// fetch again then rather than holding the last frame.
    private func refetchWhenFramesEnd(_ count: Int) {
        expiry?.cancel()
        guard stream != nil else { return }
        let end = anchor.addingTimeInterval(Double(max(count - 1, 0)) * 60)
        expiry = Task { [weak self] in
            let wait = end.timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            await self?.load()
        }
    }

    /// The four rings at `now`, blended between the frames either side of it. Between two minutes
    /// the arcs, both ticks and the deviation number all move linearly with the clock, so blending
    /// gives the card's per-second drain. Colours are picked from a frame, never derived: within a
    /// minute they move by well under a degree of hue.
    func rings(at now: Date) -> [String: RingNow] {
        guard let frames = feed?.frames, !frames.isEmpty else { return [:] }
        let m = now.timeIntervalSince(anchor) / 60
        let i = min(max(Int(m.rounded(.down)), 0), frames.count - 1)
        let j = min(i + 1, frames.count - 1)
        let s = j == i ? 0 : min(max(m - Double(i), 0), 1)
        let lerp = { (x: Double, y: Double) in x + (y - x) * s }
        let frac = lerp(frames[i].frac, frames[j].frac)
        var out: [String: RingNow] = [:]
        for (key, a) in frames[i].macros {
            guard let b = frames[j].macros[key] else { continue }
            let near = s < 0.5 ? a : b
            let over = lerp(a.ring_over, b.ring_over)
            let dev = Int(lerp(a.dev_g, b.dev_g).rounded())
            // The number's colour belongs to its sign, so it comes from the frame on the same side of
            // the pace line as the blended number.
            let sameSide = [a, b].first { sign($0.dev_g) == sign(Double(dev)) } ?? near
            // The staged tick wraps from the end of the lap to the start of the overflow lap at the
            // same point on the circle; blending across that would sweep it all the way round.
            var staged: Double? = near.staged_mark
            if let x = a.staged_mark, let y = b.staged_mark, abs(y - x) < 0.5 { staged = lerp(x, y) }
            out[key] = RingNow(
                base: lerp(a.ring_base, b.ring_base), over: over, frac: frac, stagedMark: staged, dev: dev,
                baseColor: near.base_color,
                overColor: over > 0 ? (near.over_color ?? a.over_color ?? b.over_color) : nil,
                devColor: sameSide.dev_color,
                consumed: Int(a.consumed), goal: Int(a.goal))
        }
        return out
    }

    private func sign(_ v: Double) -> Int { v > 0 ? 1 : v < 0 ? -1 : 0 }
}

/// The phone's weight view (`cards/maintviz.js`): the weigh-ins, each day's intake, the maintenance and
/// target curves as they stood each day, and the trend fitted over the window the target is based on.
struct WeightView: Decodable {
    struct WeighIn: Decodable { let date: String; let weight: Double; let inwin: Bool }
    struct Intake: Decodable { let date: String; let calories: Double; let kept: Bool }
    struct Row: Decodable { let date: String; let maintenance: Double?; let target: Double? }
    let today: String
    let window_start: String?
    let window_end: String?
    let weighins: [WeighIn]
    let intake: [Intake]
    let series: [Row]
    let slope_lb_day: Double?
    let weight_at_end: Double?
}
