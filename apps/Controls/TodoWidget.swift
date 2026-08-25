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
        TodoEntry(date: Date(), feed: TodoCache.load(), armed: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (TodoEntry) -> Void) {
        // The gallery preview: cache if we have one, so scrolling the widget picker never stalls.
        if let c = TodoCache.load() { return completion(TodoEntry(date: Date(), feed: c, armed: nil)) }
        fetch { completion(TodoEntry(date: Date(), feed: $0, armed: nil)) }
    }

    /// How long a cached payload is considered good enough to redraw from without going to the network.
    /// Only governs button-driven rebuilds; the app still forces a real refresh on foreground and after
    /// any edit in the pane, and the timeline policy still refetches hourly.
    private static let cacheGoodFor: TimeInterval = 60

    // Freshness comes from reloads, not from a short refresh policy: the app reloads every timeline
    // when it comes to the foreground and whenever the to-do pane edits something. The hourly policy
    // below is only the backstop for a list changed somewhere else entirely (voice, the Mac).
    //
    // CRUCIALLY, a rebuild does not always mean a fetch. WidgetKit rebuilds the timeline after every
    // button press, and the widget keeps showing its previous frame until the rebuild completes — so
    // fetching here unconditionally made every tap wait on an HTTPS round-trip to Fly before the
    // options would even open. Opening a row's options needs no server data at all, and clearing one
    // already knows the outcome (the POST is awaited and the row is dropped from the cache), so both
    // redraw from cache and feel immediate. The network is for going and finding out what CHANGED
    // elsewhere, which is not what a tap is.
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodoEntry>) -> Void) {
        let build: (TodoFeed?) -> Void = { feed in
            let now = Date()
            var entries = [TodoEntry]()
            if let a = ArmStore.armed(now: now) {
                // Two entries so the options close themselves: open now, closed the moment the arm
                // expires. Without this they'd sit open until something else rebuilt the timeline.
                entries.append(TodoEntry(date: now, feed: feed, armed: a.id))
                entries.append(TodoEntry(date: a.at.addingTimeInterval(ArmStore.ttl), feed: feed, armed: nil))
            } else {
                entries.append(TodoEntry(date: now, feed: feed, armed: nil))
            }
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
        }

        // A live arm means this rebuild came from a tap: redraw locally whatever the cache's age.
        // Otherwise a recent cache still spares the round-trip on the rapid tap/untap sequence.
        let armed = ArmStore.armed() != nil
        let fresh = (TodoCache.age() ?? .greatestFiniteMagnitude) < Self.cacheGoodFor
        if let cached = TodoCache.load(), armed || fresh { return build(cached) }
        fetch(build)
    }

    private func fetch(_ done: @escaping (TodoFeed?) -> Void) {
        guard let url = URL(string: Auth.host + "/api/due-widget"), let token = Auth.token() else {
            return done(TodoCache.load())
        }
        var r = URLRequest(url: url)
        // Short: this runs inside a widget refresh window, and a request that hangs holds the whole
        // rebuild open. Falling back to cache after a few seconds beats a frozen widget.
        r.timeoutInterval = 8
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        URLSession.shared.dataTask(with: r) { data, _, _ in
            guard let data, let feed = try? JSONDecoder().decode(TodoFeed.self, from: data) else {
                return done(TodoCache.load())
            }
            TodoCache.save(data)
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
