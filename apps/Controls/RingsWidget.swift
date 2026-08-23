import WidgetKit
import SwiftUI

// Home / Lock Screen widget: today's four macro pace rings, drawn to match the hub's nutrition card.
//
// This lives in the CONTROLS extension rather than a new widget-extension target. One
// widgetkit-extension is meant to host several widgets and controls in a single WidgetBundle, so
// this is the intended shape — and it also avoids needing a new bundle id, which would need a new
// provisioning profile, which the currently-rejected Xcode account session can't issue.
//
// The rings are a PACE gauge, not absolute progress: full when on pace, draining as the clock runs
// ahead of what's been eaten, with an overflow arc once ahead. The white tick is where the arc would
// end if you were exactly on pace. All of it comes precomputed from the server (see /api/rings) so
// lib/pace.js stays the only implementation of that maths.

struct Macro: Decodable {
    let consumed: Double, goal: Double, dev_g: Double
    let ring_base: Double, ring_over: Double
    let base_color: String, over_color: String?, dev_color: String
}
struct Frame: Decodable {
    let t: Int                 // minutes from the fetch
    let frac: Double           // how far through the eating window — drives the marker
    let macros: [String: Macro]
}
struct RingsFeed: Decodable { let step_min: Int; let frames: [Frame] }

struct RingsEntry: TimelineEntry {
    let date: Date
    let frame: Frame?          // nil = couldn't load (no token yet, offline, hub down)
}

struct RingsProvider: TimelineProvider {
    func placeholder(in context: Context) -> RingsEntry { RingsEntry(date: Date(), frame: nil) }

    func getSnapshot(in context: Context, completion: @escaping (RingsEntry) -> Void) {
        fetch { completion(RingsEntry(date: Date(), frame: $0?.frames.first)) }
    }

    // One network fetch yields a few hours of frames, so the arcs keep draining and the marker keeps
    // advancing between fetches. WidgetKit budgets refreshes per day; this way movement doesn't cost
    // any of that budget.
    func getTimeline(in context: Context, completion: @escaping (Timeline<RingsEntry>) -> Void) {
        fetch { feed in
            let now = Date()
            guard let feed, !feed.frames.isEmpty else {
                completion(Timeline(entries: [RingsEntry(date: now, frame: nil)],
                                    policy: .after(now.addingTimeInterval(900))))
                return
            }
            let entries = feed.frames.map {
                RingsEntry(date: now.addingTimeInterval(TimeInterval($0.t) * 60), frame: $0)
            }
            // Refetch once the frames run out — consumed values are stale by then anyway.
            let end = entries.last?.date ?? now.addingTimeInterval(900)
            completion(Timeline(entries: entries, policy: .after(end)))
        }
    }

    private func fetch(_ done: @escaping (RingsFeed?) -> Void) {
        guard let url = URL(string: Auth.host + "/api/rings"), let token = Auth.token() else { return done(nil) }
        var r = URLRequest(url: url)
        r.timeoutInterval = 15
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        URLSession.shared.dataTask(with: r) { data, _, _ in
            done(data.flatMap { try? JSONDecoder().decode(RingsFeed.self, from: $0) })
        }.resume()
    }
}

private extension Color {
    /// "#rrggbb" from the server's pace palette.
    init(hex: String) {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let v = UInt32(h, radix: 16) ?? 0x22c55e
        self.init(red: Double((v >> 16) & 0xff) / 255,
                  green: Double((v >> 8) & 0xff) / 255,
                  blue: Double(v & 0xff) / 255)
    }
}

/// The on-pace marker. Geometry mirrors cards/nutrition.js tickRings(): angle 2π·frac measured
/// COUNTER-clockwise from twelve o'clock, drawn between 0.725 and 0.9875 of the half-size — the same
/// proportions as the card's r=29→39.5 line inside its 80-unit box.
private struct PaceMark: Shape {
    let frac: Double
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let half = min(rect.width, rect.height) / 2
        let phi = 2 * Double.pi * frac
        let pt = { (f: Double) in
            CGPoint(x: c.x - half * f * sin(phi), y: c.y - half * f * cos(phi))
        }
        var p = Path()
        p.move(to: pt(0.725))
        p.addLine(to: pt(0.9875))
        return p
    }
}

private struct RingView: View {
    let label: String
    let macro: Macro?
    let frac: Double
    var compact = false          // Lock Screen / small: drop the totals line, thinner strokes

    var body: some View {
        VStack(spacing: 2) {
            GeometryReader { geo in
                let size = min(geo.size.width, geo.size.height)
                let lw = size * (compact ? 0.10 : 0.115)   // thin enough that neighbouring rings don't crowd
                let base = min(max(macro?.ring_base ?? 0, 0), 1)
                let over = min(max(macro?.ring_over ?? 0, 0), 1)
                ZStack {
                    Circle().stroke(Color.primary.opacity(0.16), lineWidth: lw)
                    Circle()
                        .trim(from: 0, to: base)
                        .stroke(Color(hex: macro?.base_color ?? "#22c55e"),
                                style: StrokeStyle(lineWidth: lw, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    if let oc = macro?.over_color, over > 0 {
                        Circle()
                            .trim(from: 0, to: over)
                            .stroke(Color(hex: oc), style: StrokeStyle(lineWidth: lw, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                    PaceMark(frac: frac)
                        .stroke(Color.white, style: StrokeStyle(lineWidth: max(1, size * 0.045), lineCap: .round))
                    VStack(spacing: 0) {
                        Text(label)
                            .font(.system(size: size * 0.24, weight: .semibold, design: .rounded))
                            .foregroundStyle(.primary)
                        if let m = macro {
                            Text(devText(m))
                                .font(.system(size: size * 0.20, weight: .semibold, design: .rounded))
                                .foregroundStyle(Color(hex: m.dev_color))
                        }
                    }
                }
                .frame(width: size, height: size)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .aspectRatio(1, contentMode: .fit)

            if !compact, let m = macro {
                Text("\(Int(m.consumed))/\(Int(m.goal))")
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
        }
    }

    /// Signed distance from the pace line, same as the card's centre number.
    private func devText(_ m: Macro) -> String {
        let d = Int(m.dev_g)
        return (d > 0 ? "+" : "") + String(d)
    }
}

struct RingsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RingsEntry

    private let keys = [("Cal", "calories"), ("P", "protein_g"), ("C", "carbs_g"), ("F", "fat_g")]

    var body: some View {
        let frac = entry.frame?.frac ?? 0
        Group {
            switch family {
            case .accessoryCircular:
                // ~36pt: only one ring stays legible, so it shows calories.
                RingView(label: "Cal", macro: entry.frame?.macros["calories"], frac: frac, compact: true)
            case .accessoryRectangular:
                HStack(spacing: 6) { ForEach(keys, id: \.0) { row($0, compact: true) } }
            default:
                // One row of four on both Home Screen sizes — a 2x2 wastes the width and forces
                // vertical padding that squeezes the rings.
                HStack(spacing: family == .systemSmall ? 6 : 16) {
                    ForEach(keys, id: \.0) { row($0, compact: family == .systemSmall) }
                }
            }
        }
        .widgetURL(URL(string: "statushub://open"))   // any host but "record" just opens the app
    }

    private func row(_ k: (String, String), compact: Bool) -> some View {
        RingView(label: k.0, macro: entry.frame?.macros[k.1], frac: entry.frame?.frac ?? 0, compact: compact)
    }
}

struct RingsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.jaredgantt.statushub.rings", provider: RingsProvider()) { entry in
            RingsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Macro Rings")
        .description("Today's calories, protein, carbs and fat — on pace, draining with the clock.")
        // The accessory families are what make it offerable on the Lock Screen at all. Note iOS
        // renders those in a flattened tint, so the pace COLOURS don't survive there; arc lengths do.
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}
