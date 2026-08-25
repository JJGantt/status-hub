import WidgetKit
import SwiftUI

// Home Screen widget: the projects on the Mac, most recently touched first. The WidgetKit half only —
// the drawing and the intents live in ReposView.swift so they render without a device.
//
// Like the due widget, a rebuild does not always mean a fetch. Selecting a row is local state, and
// making it wait on an HTTPS round-trip is what made the first interactive widget feel broken.

struct ReposEntry: TimelineEntry {
    let date: Date
    let feed: ReposFeed?      // nil = couldn't load (no token yet, offline, hub down)
    let armed: String?        // the row awaiting its confirm
}

struct ReposProvider: TimelineProvider {
    /// How long a cached payload can back a button-driven redraw before it's worth a real fetch.
    private static let cacheGoodFor: TimeInterval = 60

    func placeholder(in context: Context) -> ReposEntry {
        ReposEntry(date: Date(), feed: ReposCache.load(), armed: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ReposEntry) -> Void) {
        if let c = ReposCache.load() { return completion(ReposEntry(date: Date(), feed: c, armed: nil)) }
        fetch { completion(ReposEntry(date: Date(), feed: $0, armed: nil)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ReposEntry>) -> Void) {
        let build: (ReposFeed?) -> Void = { feed in
            let now = Date()
            var entries = [ReposEntry]()
            if let a = RepoArmStore.armed(now: now) {
                // A second entry at the expiry so the confirm button retracts on its own — a live
                // "start a session" button left sitting on the Home Screen is worth closing.
                entries.append(ReposEntry(date: now, feed: feed, armed: a.path))
                entries.append(ReposEntry(date: a.at.addingTimeInterval(RepoArmStore.ttl), feed: feed, armed: nil))
            } else {
                entries.append(ReposEntry(date: now, feed: feed, armed: nil))
            }
            // Half an hour: the list is the Mac's own scan, which only moves when work happens, and
            // desk presence beats every 30s so "Mac asleep" is never far wrong after a foreground.
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(1800))))
        }
        let armed = RepoArmStore.armed() != nil
        let fresh = (ReposCache.age() ?? .greatestFiniteMagnitude) < Self.cacheGoodFor
        if let cached = ReposCache.load(), armed || fresh { return build(cached) }
        fetch(build)
    }

    private func fetch(_ done: @escaping (ReposFeed?) -> Void) {
        guard let url = URL(string: Auth.host + "/api/repos-widget"), let token = Auth.token() else {
            return done(ReposCache.load())
        }
        var r = URLRequest(url: url)
        r.timeoutInterval = 8      // inside a refresh window; cache beats a hung rebuild
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        URLSession.shared.dataTask(with: r) { data, _, _ in
            guard let data, let feed = try? JSONDecoder().decode(ReposFeed.self, from: data) else {
                return done(ReposCache.load())
            }
            ReposCache.save(data)
            done(feed)
        }.resume()
    }
}

enum ReposCache {
    static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("repos-last.json")
    }
    static func load() -> ReposFeed? {
        guard let u = url, let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(ReposFeed.self, from: d)
    }
    static func save(_ data: Data) {
        guard let u = url else { return }
        try? data.write(to: u, options: .atomic)
    }
    static func age() -> TimeInterval? {
        guard let u = url,
              let m = (try? FileManager.default.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date
        else { return nil }
        return Date().timeIntervalSince(m)
    }
}

struct ReposWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ReposEntry

    private var layout: ReposLayout {
        switch family {
        case .systemSmall: return .small
        case .systemLarge: return .large
        default:           return .medium
        }
    }

    var body: some View {
        ReposListView(feed: entry.feed, armed: entry.armed, layout: layout)
            .widgetURL(URL(string: "statushub://pane/repos"))
    }
}

struct ReposWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.jaredgantt.statushub.repos", provider: ReposProvider()) { entry in
            ReposWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Projects")
        .description("Start a Claude session on the Mac. Tap a project, then the mic to dictate what it should do.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
