import WidgetKit
import SwiftUI

// Home / Lock Screen widget: today's four macro rings at a glance, no app launch needed.
//
// This lives in the CONTROLS extension rather than a new widget-extension target on purpose. A new
// target needs its own bundle id, which needs a provisioning profile, which needs a working Xcode
// account session — and that session is currently rejected. A widgetkit-extension can host both
// ControlWidgets and ordinary Widgets in one WidgetBundle, so reusing this already-provisioned
// extension avoids the whole problem.

// Mirrors one macro's pace gauge from lib/pace.js. ring_base is the main arc — FULL when you're on
// pace and draining as the day runs ahead of what you've eaten; ring_over is the overflow arc once
// you're ahead of pace. Colours come from the server so the widget and the hub card can never drift.
struct Ring: Decodable {
    let ring_base: Double
    let ring_over: Double
    let base_color: String
    let over_color: String?
}
struct Rings: Decodable { let calories: Ring; let protein_g: Ring; let carbs_g: Ring; let fat_g: Ring }

struct RingsEntry: TimelineEntry {
    let date: Date
    let rings: Rings?          // nil = couldn't load (no token yet, offline, hub down)
}

struct RingsProvider: TimelineProvider {
    func placeholder(in context: Context) -> RingsEntry { RingsEntry(date: Date(), rings: nil) }

    func getSnapshot(in context: Context, completion: @escaping (RingsEntry) -> Void) {
        fetch { completion(RingsEntry(date: Date(), rings: $0)) }
    }

    // Refresh every 15 minutes. WidgetKit budgets refreshes per day, so this is deliberately
    // unambitious — macros move on the scale of meals, not seconds.
    func getTimeline(in context: Context, completion: @escaping (Timeline<RingsEntry>) -> Void) {
        fetch { rings in
            let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
            completion(Timeline(entries: [RingsEntry(date: Date(), rings: rings)], policy: .after(next)))
        }
    }

    private func fetch(_ done: @escaping (Rings?) -> Void) {
        guard let url = URL(string: Auth.host + "/api/rings"), let token = Auth.token() else { return done(nil) }
        var r = URLRequest(url: url)
        r.timeoutInterval = 15
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        URLSession.shared.dataTask(with: r) { data, _, _ in
            done(data.flatMap { try? JSONDecoder().decode(Rings.self, from: $0) })
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

private struct RingView: View {
    let label: String, ring: Ring?

    var body: some View {
        let base = min(max(ring?.ring_base ?? 0, 0), 1)
        let over = min(max(ring?.ring_over ?? 0, 0), 1)
        let baseColor = Color(hex: ring?.base_color ?? "#22c55e")
        ZStack {
            Circle().stroke(Color.primary.opacity(0.14), lineWidth: 6)          // empty track
            Circle()                                                            // pace arc
                .trim(from: 0, to: base)
                .stroke(baseColor, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))                                  // start at 12 o'clock
            if let over_color = ring?.over_color, over > 0 {                    // overflow, one wrap max
                Circle()
                    .trim(from: 0, to: over)
                    .stroke(Color(hex: over_color), style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            Text(label).font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(.primary)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct RingsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RingsEntry

    // Colour is carried per-ring by the pace data (green on pace -> red behind, amber over), exactly
    // as on the hub card, so nothing is hard-coded per macro here.
    private var items: [(String, Ring?)] {
        [("Cal", entry.rings?.calories), ("P", entry.rings?.protein_g),
         ("C",   entry.rings?.carbs_g),  ("F", entry.rings?.fat_g)]
    }

    var body: some View {
        Group {
            if family == .systemSmall {
                // 2x2 — four rings in a square don't fit legibly in a row at this size.
                VStack(spacing: 8) {
                    HStack(spacing: 8) { ring(0); ring(1) }
                    HStack(spacing: 8) { ring(2); ring(3) }
                }
            } else {
                HStack(spacing: 12) { ForEach(0..<4, id: \.self) { ring($0) } }
            }
        }
        .padding(4)
        .widgetURL(URL(string: "statushub://open"))   // any host but "record" just opens the app
    }

    private func ring(_ i: Int) -> some View {
        let (label, r) = items[i]
        return RingView(label: label, ring: r)
    }
}

struct RingsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.jaredgantt.statushub.rings", provider: RingsProvider()) { entry in
            RingsWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Macro Rings")
        .description("Today's calories, protein, carbs and fat.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
