import Foundation

/// Today's nutrition day, as `/api/nutrition-day?date=today` returns it.
struct NutritionDay: Decodable {
    struct Targets: Decodable { let protein_g: Double?, carbs_g: Double?, fat_g: Double? }
    struct Entry: Decodable, Identifiable {
        let id: String
        let occurred_at: String?
        let name: String?
        let calories: Double?, protein_g: Double?, carbs_g: Double?, fat_g: Double?
        let staged: Bool?
    }
    let date: String
    let total_cal: Double, total_protein: Double, total_carbs: Double, total_fat: Double
    let target_cal: Double?
    let target_macros: Targets?
    let entries: [Entry]
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

    /// The start of the minute the hub built `feed` in. Its clock is minute-resolution, so frame `t`
    /// describes `anchor + t` minutes.
    private var anchor = Date()
    private var loading = false
    private var reloadAfter = false
    private var stream: Task<Void, Never>?
    private var expiry: Task<Void, Never>?

    /// The page is on screen: load now, and follow changes until `deactivate`.
    func activate() {
        Task { await load() }
        guard stream == nil else { return }
        stream = Task { await follow() }
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
        expiry?.cancel()
        expiry = nil
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

    /// Holds /api/nutrition-stream open and reloads on each `nutrition` event. A dropped stream comes
    /// back with backoff and reloads once reconnected, since a change may have gone by unheard.
    private func follow() async {
        var backoff: Double = 1
        var first = true
        while !Task.isCancelled {
            do {
                let bytes = try await Hub.stream("/api/nutrition-stream")
                if !first { await load() }
                first = false
                backoff = 1
                for try await line in bytes.lines where line == "event: nutrition" {
                    await load()
                }
            } catch {}
            guard !Task.isCancelled else { return }
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(backoff * 2, 60)
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
