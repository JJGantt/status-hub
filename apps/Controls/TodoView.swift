import SwiftUI
import AppIntents
import Foundation
#if canImport(WidgetKit)
import WidgetKit   // only to nudge a redraw mid-clear; the drawing below stays WidgetKit-free
#endif

// The due widget's DRAWING and its BUTTONS, deliberately free of any WidgetKit dependency so it
// compiles and renders on its own — see tools/render-todo.swift. Same split as RingsView.swift, and
// for the same reason: row density is the whole design question here, and rebuilding onto a phone to
// count how many rows fit is a slow way to find out.
//
// WHAT IT SHOWS: everything with a due date, from every list, ordered by when it was FIRST scheduled.
// Not one list at a time — "what needs dealing with" is never confined to a single list. Items whose
// moment has passed are EXPIRED and painted so, and an expired item is also draining his score for as
// long as it stays that way. `repeating` marks one occurrence of a materialised series (data-layer
// migration 00085) — there are more of these on other days; this one will not come back.
//
// THE INTERACTION: a widget has no gestures at all — no swipe, no long press, only Button and Toggle
// taps. So tapping a row opens its two options in place: open it in the app, or clear it. Clearing and
// checking off are the same act here, as everywhere else in this system. Two taps also means no single
// stray tap can clear anything, which is the property the web pane's left-swipe was chosen for.

struct TodoItem: Codable, Identifiable {
    let id: String
    let title: String
    let list: String?
    let emoji: String?
    /// Its originally-scheduled moment has passed and it hasn't been cleared. Says nothing about
    /// whether the item repeats — a one-shot and a repeater expire identically.
    ///
    /// Optional rather than defaulted: a defaulted `var` still makes the key REQUIRED when Decodable
    /// synthesises `init(from:)`, and a `todo-last.json` cached by a build predating these fields
    /// would then fail to decode — turning the offline fallback into a blank widget, which is the one
    /// thing that cache exists to prevent.
    private let expired: Bool?
    private let repeating: Bool?
    var isExpired: Bool { expired == true }
    var isRepeating: Bool { repeating == true }
}
struct TodoFeed: Codable { let items: [TodoItem] }

// MARK: - Cache
//
// The last good payload, on disk in the extension's own container. Two jobs:
//
//  1. Never blank. A background refresh can fail for reasons that have nothing to do with the data —
//     no network on a timeline expiry, a request that outlives its window — and a slightly stale list
//     beats an empty one.
//  2. Keep taps INSTANT. WidgetKit rebuilds the timeline after every button press, and if that
//     rebuild goes to the network the widget sits on its old frame until the round-trip finishes.
//     Opening a row's options needs no server data whatsoever, so it must never pay for one.
enum TodoCache {
    static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("due-last.json")
    }

    static func load() -> TodoFeed? {
        guard let u = url, let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(TodoFeed.self, from: d)
    }

    static func save(_ data: Data) {
        guard let u = url else { return }
        try? data.write(to: u, options: .atomic)
    }

    /// How long since it was last written, or nil if there is nothing cached.
    static func age() -> TimeInterval? {
        guard let u = url,
              let m = (try? FileManager.default.attributesOfItem(atPath: u.path))?[.modificationDate] as? Date
        else { return nil }
        return Date().timeIntervalSince(m)
    }

    /// Drop a row locally after it has been cleared on the server. The write already succeeded, so
    /// the next rebuild can redraw from cache without waiting on a fetch to learn what we just did.
    static func remove(id: String) {
        guard let feed = load() else { return }
        let kept = TodoFeed(items: feed.items.filter { $0.id != id })
        if let d = try? JSONEncoder().encode(kept) { save(d) }
    }
}

// MARK: - Arm state
//
// Which row has its options open. This does NOT need an App Group: a widget's Button intent runs in
// the widget extension's own process, the same process the timeline provider runs in, so the
// extension's own defaults are shared ground between the two. (An App Group would mean a new
// entitlement, hence a regenerated provisioning profile — the thing the rejected Xcode account can't
// currently issue.)
enum ArmStore {
    /// An armed row closes itself after this long, so options left open on the Home Screen don't sit
    /// there indefinitely waiting to be brushed. The provider schedules an entry at the expiry.
    static let ttl: TimeInterval = 20
    private static let idKey = "todo.armedID"
    private static let atKey = "todo.armedAt"
    private static let pendingKey = "todo.clearingID"

    static func arm(_ id: String) {
        UserDefaults.standard.set(id, forKey: idKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: atKey)
    }
    static func disarm() {
        UserDefaults.standard.removeObject(forKey: idKey)
        UserDefaults.standard.removeObject(forKey: atKey)
    }
    /// The row whose clear is in flight. Rendered as "clearing…" so the tap isn't a dead second while
    /// the POST is out — a widget cannot show a spinner, and it keeps drawing its previous frame until
    /// the intent returns, so without this the ✕ looks ignored.
    static func clearing() -> String? { UserDefaults.standard.string(forKey: pendingKey) }
    static func setClearing(_ id: String?) {
        if let id { UserDefaults.standard.set(id, forKey: pendingKey) }
        else { UserDefaults.standard.removeObject(forKey: pendingKey) }
    }

    /// The armed row and when it was armed — nil once it has aged past `ttl`.
    static func armed(now: Date = Date()) -> (id: String, at: Date)? {
        guard let id = UserDefaults.standard.string(forKey: idKey) else { return nil }
        let at = Date(timeIntervalSince1970: UserDefaults.standard.double(forKey: atKey))
        return at.addingTimeInterval(ttl) > now ? (id, at) : nil
    }
}

// MARK: - Intents
//
// isDiscoverable = false on both: they are widget plumbing, and without it they'd be offered as
// actions in Shortcuts, where "Select item" is noise at best.

/// Tapping a row TOGGLES its options. One intent rather than an open/close pair because
/// `Button(intent:)` takes one concrete type — a ternary over two intent types doesn't typecheck —
/// and because backing out should be a tap on the very row you just tapped, not a hunt for empty space.
struct TapTodoItem: AppIntent {
    static var title: LocalizedStringResource = "Select item"
    static var isDiscoverable: Bool = false
    @Parameter(title: "id") var id: String
    init() {}
    init(id: String) { self.id = id }
    func perform() async throws -> some IntentResult {
        if ArmStore.armed()?.id == id { ArmStore.disarm() } else { ArmStore.arm(id) }
        return .result()
    }
}

struct ClearTodoItem: AppIntent {
    static var title: LocalizedStringResource = "Clear item"
    static var isDiscoverable: Bool = false
    @Parameter(title: "id") var id: String
    init() {}
    init(id: String) { self.id = id }

    // Awaited, not fired and forgotten: WidgetKit rebuilds the timeline as soon as perform() returns,
    // and that rebuild re-fetches the feed. Returning early would race the write and redraw the row
    // that was just cleared.
    func perform() async throws -> some IntentResult {
        // Paint "clearing…" BEFORE going to the network. The request can't be fired and forgotten —
        // a widget extension may be suspended the moment perform() returns, and without an App Group
        // there's no background URLSession to survive it, so the write has to be awaited. Awaiting it
        // silently is what made the tap feel dead, hence the interim state.
        ArmStore.setClearing(id)
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: "com.jaredgantt.statushub.due")
        #endif
        await TodoAPI.clear(id: id)
        TodoCache.remove(id: id)   // so the rebuild redraws the row gone, with no second round-trip
        ArmStore.setClearing(nil)
        ArmStore.disarm()
        return .result()
    }
}

enum TodoAPI {
    /// The same soft clear every other surface uses (`/api/todos/clear`) — checking off and deleting
    /// are one act, and the row survives its recovery window either way.
    static func clear(id: String) async {
        guard let url = URL(string: Auth.host + "/api/todos/clear"), let token = Auth.token() else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 15
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id])
        _ = try? await URLSession.shared.data(for: r)
    }
}

// MARK: - Drawing

/// Which family to lay out for. Mirrors the widget families without depending on WidgetKit, so the
/// render harness can ask for any of them.
public enum TodoLayout {
    case small, medium, large

    /// How many rows fit — measured with the render harness at real point sizes, not guessed. Each
    /// row is one line: titles only, never the body text, so row height is fixed and the count is
    /// exact rather than a hope.
    var rows: Int { switch self { case .small: 6; case .medium: 5; case .large: 10 } }
    var titleSize: CGFloat { switch self { case .small: 11; case .medium: 13; case .large: 14 } }
    var rowGap: CGFloat { switch self { case .small: 5; case .medium: 7; case .large: 11 } }
    /// The small family has no width to spare for the list's mark next to the text.
    var showsList: Bool { self != .small }
}

private let dangerRed = Color(red: 0.937, green: 0.267, blue: 0.267)   // #ef4444
// Matches the due chip in the web pane (.todo .due), so an expired row reads the same on both.
private let expiredAmber = Color(red: 0.902, green: 0.725, blue: 0.239)   // #e6b93d

private struct TodoRowView: View {
    let item: TodoItem
    let armed: Bool
    let clearing: Bool
    let layout: TodoLayout

    var body: some View {
        if clearing {
            // No buttons: the outcome is already decided, and offering an action that can't be taken
            // back would be a lie.
            HStack(spacing: 6) {
                Text(item.title)
                    .font(.system(size: layout.titleSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
                    .strikethrough(true, color: mutedText)
                    .lineLimit(1).truncationMode(.tail)
                Text("clearing\u{2026}")
                    .font(.system(size: layout.titleSize - 2, weight: .semibold, design: .rounded))
                    .foregroundStyle(mutedText.opacity(0.8))
                Spacer(minLength: 0)
            }
        } else {
            content
        }
    }

    private var content: some View {
        HStack(spacing: 6) {
            Button(intent: TapTodoItem(id: item.id)) { label }
                .buttonStyle(.plain)
            if armed {
                // Open it in the app, showing the full body. A Button carrying an openAppWhenRun
                // intent rather than a SwiftUI Link: Link draws as a missing-content placeholder
                // under ImageRenderer, so the layout couldn't be checked with the render harness —
                // and the Record control already proves the intent route works from this extension.
                Button(intent: OpenTodoItem(id: item.id)) {
                    Text("\u{203A}")   // a plain caret; U+2197 resolves to an emoji presentation
                        .font(.system(size: layout.titleSize + 6, weight: .bold, design: .rounded))
                        .foregroundStyle(inkText)
                        .frame(width: 28, height: layout.titleSize + 9)
                        .background(Capsule().fill(inkText.opacity(0.18)))
                }
                .buttonStyle(.plain)
                Button(intent: ClearTodoItem(id: item.id)) {
                    Text("\u{00d7}")
                        .font(.system(size: layout.titleSize + 4, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .frame(width: 28, height: layout.titleSize + 9)
                        .background(Capsule().fill(dangerRed))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var label: some View {
        HStack(spacing: 6) {
            // The list's own emoji stands in for the bullet — it says where the item lives without
            // spending a chip's worth of width on the list name.
            if let e = item.emoji, layout.showsList, !e.isEmpty {
                Text(e).font(.system(size: layout.titleSize - 1))
            } else {
                Circle()
                    .fill(armed ? dangerRed : item.isExpired ? expiredAmber : mutedText.opacity(0.55))
                    .frame(width: item.isExpired && !armed ? 5 : 4,
                           height: item.isExpired && !armed ? 5 : 4)
            }
            Text(item.title)
                .font(.system(size: layout.titleSize,
                              weight: item.isExpired ? .semibold : .medium, design: .rounded))
                .foregroundStyle(armed ? inkText : item.isExpired ? expiredAmber : inkText.opacity(0.92))
                .lineLimit(1)
                .truncationMode(.tail)
            if item.isRepeating {
                Text("\u{21bb}")
                    .font(.system(size: layout.titleSize - 2))
                    .foregroundStyle(mutedText)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())   // the whole row is the target, not just the glyphs
    }
}

struct TodoListView: View {
    let feed: TodoFeed?
    let armed: String?
    var clearing: String? = nil
    let layout: TodoLayout

    var body: some View {
        let items = feed?.items ?? []
        let shown = Array(items.prefix(layout.rows))
        let hidden = items.count - shown.count
        let expiredCount = items.filter { $0.isExpired }.count

        VStack(alignment: .leading, spacing: layout.rowGap) {
            HStack(spacing: 5) {
                Text("DUE")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(mutedText)
                    .tracking(0.8)
                if expiredCount > 0 {
                    Text("\(expiredCount) expired")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(expiredAmber)
                } else if !items.isEmpty {
                    Text(String(items.count))
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(mutedText.opacity(0.8))
                }
                Spacer(minLength: 0)
            }

            if feed == nil {
                // Distinct from an empty feed on purpose: "nothing to show" and "couldn't load" are
                // different facts, and only one of them means you're done.
                Text("Can\u{2019}t reach the hub")
                    .font(.system(size: layout.titleSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            } else if shown.isEmpty {
                Text("Nothing due")
                    .font(.system(size: layout.titleSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            } else {
                ForEach(shown) { item in
                    TodoRowView(item: item, armed: item.id == armed,
                                clearing: item.id == clearing, layout: layout)
                }
                if hidden > 0 {
                    Text("+\(hidden) more")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(mutedText)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
