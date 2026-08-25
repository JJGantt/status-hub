import WidgetKit
import SwiftUI

// Home Screen widget: everything with a due date, from every list, anchor-ordered and flagged when
// expired. The WidgetKit half only — the drawing and the button intents live in TodoView.swift so
// they can be rendered without a device (tools/render-todo.swift).
//
// Much simpler than the rings widget, and deliberately so: that one ships an hour of per-minute
// frames because pace DRAINS with the clock and a widget can't tick. A to-do list doesn't move on its
// own. It changes when something is written or cleared, so this fetches one snapshot and leans on the
// reload triggers instead (see "Freshness" below).

struct TodoEntry: TimelineEntry {
    let date: Date
    let feed: TodoFeed?        // nil = couldn't load (no token yet, offline, hub down)
    let armed: String?         // the row currently showing its ✕
}

struct TodoProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodoEntry {
        TodoEntry(date: Date(), feed: cached(), armed: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (TodoEntry) -> Void) {
        fetch { completion(TodoEntry(date: Date(), feed: $0, armed: nil)) }
    }

    // Freshness comes from reloads, not from a short refresh policy: tapping a button in the widget
    // makes WidgetKit rebuild the timeline immediately, and the app reloads every timeline when it
    // comes to the foreground and whenever the to-do pane edits something. The hourly policy below is
    // only the backstop for a list changed somewhere else entirely (voice, the Mac, another device).
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodoEntry>) -> Void) {
        fetch { feed in
            let now = Date()
            var entries = [TodoEntry]()
            if let a = ArmStore.armed(now: now) {
                // Two entries so the ✕ closes itself: armed now, un-armed the moment the arm expires.
                // Without this a revealed ✕ would sit open until something else rebuilt the timeline.
                entries.append(TodoEntry(date: now, feed: feed, armed: a.id))
                entries.append(TodoEntry(date: a.at.addingTimeInterval(ArmStore.ttl), feed: feed, armed: nil))
            } else {
                entries.append(TodoEntry(date: now, feed: feed, armed: nil))
            }
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
        }
    }

    // Same rationale as the rings widget's cache: a background refresh can fail for reasons that have
    // nothing to do with the data, and a slightly stale list beats a blank one.
    private static var cacheURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("due-last.json")
    }

    private func cached() -> TodoFeed? {
        guard let u = Self.cacheURL, let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(TodoFeed.self, from: d)
    }

    private func fetch(_ done: @escaping (TodoFeed?) -> Void) {
        guard let url = URL(string: Auth.host + "/api/due-widget"), let token = Auth.token() else {
            return done(cached())
        }
        var r = URLRequest(url: url)
        r.timeoutInterval = 15
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        URLSession.shared.dataTask(with: r) { data, _, _ in
            guard let data, let feed = try? JSONDecoder().decode(TodoFeed.self, from: data) else {
                return done(self.cached())
            }
            if let u = Self.cacheURL { try? data.write(to: u, options: .atomic) }
            done(feed)
        }.resume()
    }
}

struct TodoWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodoEntry

    private var layout: TodoLayout {
        switch family {
        case .systemSmall: return .small
        case .systemLarge: return .large
        default:           return .medium
        }
    }

    var body: some View {
        TodoListView(feed: entry.feed, armed: entry.armed, layout: layout)
            // Rows are buttons and take their own taps; this catches the header and the space below
            // the last row, so there is still somewhere to tap that opens the app.
            .widgetURL(URL(string: "statushub://open"))
    }
}

struct TodoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.jaredgantt.statushub.due", provider: TodoProvider()) { entry in
            TodoWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Due")
        .description("Everything with a due date, soonest-scheduled first. Tap a row for its options.")
        // Home Screen only. The accessory families are too small for a list, and option buttons that
        // small on the Lock Screen are a mis-tap waiting to happen.
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
