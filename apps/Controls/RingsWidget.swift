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

struct RingsEntry: TimelineEntry {
    let date: Date
    let frame: Frame?          // nil = couldn't load (no token yet, offline, hub down)
    var score: Score? = nil    // health bar; fixed for the fetch, not per-frame
}

struct RingsProvider: TimelineProvider {
    func placeholder(in context: Context) -> RingsEntry { RingsEntry(date: Date(), frame: nil) }

    func getSnapshot(in context: Context, completion: @escaping (RingsEntry) -> Void) {
        fetch { completion(RingsEntry(date: Date(), frame: $0?.frames.first, score: $0?.score)) }
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
                RingsEntry(date: now.addingTimeInterval(TimeInterval($0.t) * 60), frame: $0, score: feed.score)
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

struct RingsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RingsEntry

    // Drawing lives in RingsView.swift, WidgetKit-free so it can be rendered to a PNG for inspection.
    private var layout: RingsLayout {
        switch family {
        case .accessoryCircular:    return .circular
        case .accessoryRectangular: return .rectangular
        case .systemSmall:          return .small
        default:                    return .medium
        }
    }

    var body: some View {
        RingsRow(frame: entry.frame, layout: layout, score: entry.score)
            .widgetURL(URL(string: "statushub://open"))   // any host but "record" just opens the app
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
