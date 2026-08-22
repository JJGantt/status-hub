import WidgetKit
import SwiftUI

// Home / Lock Screen widget: today's four macro rings at a glance, no app launch needed.
//
// This lives in the CONTROLS extension rather than a new widget-extension target on purpose. A new
// target needs its own bundle id, which needs a provisioning profile, which needs a working Xcode
// account session — and that session is currently rejected. A widgetkit-extension can host both
// ControlWidgets and ordinary Widgets in one WidgetBundle, so reusing this already-provisioned
// extension avoids the whole problem.

struct Ring: Decodable { let consumed: Double; let goal: Double; let progress: Double }
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

private struct RingView: View {
    let label: String, ring: Ring?, color: Color

    var body: some View {
        // Clamp at one full turn: going over goal shouldn't wrap the arc back to looking empty.
        let p = min(max(ring?.progress ?? 0, 0), 1)
        ZStack {
            Circle().stroke(color.opacity(0.20), lineWidth: 6)
            Circle()
                .trim(from: 0, to: p)
                .stroke(color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))       // start at 12 o'clock, not 3
            Text(label).font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(.primary)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct RingsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RingsEntry

    private var items: [(String, Ring?, Color)] {
        [("Cal", entry.rings?.calories,  Color(red: 0.13, green: 0.77, blue: 0.37)),
         ("P",   entry.rings?.protein_g, Color(red: 0.23, green: 0.51, blue: 0.96)),
         ("C",   entry.rings?.carbs_g,   Color(red: 0.96, green: 0.62, blue: 0.04)),
         ("F",   entry.rings?.fat_g,     Color(red: 0.65, green: 0.45, blue: 0.96))]
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
        let (label, r, color) = items[i]
        return RingView(label: label, ring: r, color: color)
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
