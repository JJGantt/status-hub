import SwiftUI
import AppIntents
import Foundation

// The to-do widget's DRAWING and its BUTTONS, deliberately free of any WidgetKit dependency so it
// compiles and renders on its own — see tools/render-todo.swift. Same split as RingsView.swift, and
// for the same reason: row density is the whole design question here, and rebuilding onto a phone to
// count how many rows fit is a slow way to find out.
//
// The interaction: a widget has no gestures at all — no swipe, no long press, only Button and Toggle
// taps. So clearing is two taps: tap a row to ARM it (its ✕ appears), tap the ✕ to clear. That keeps
// the property the web pane's left-swipe was chosen for — no single stray tap can delete anything —
// with the only mechanism widgets actually offer.

struct TodoItem: Decodable, Identifiable { let id: String; let title: String }
struct TodoFeed: Decodable { let list: String; let items: [TodoItem] }

// MARK: - Arm state
//
// Which row is showing its ✕. This does NOT need an App Group: a widget's Button intent runs in the
// widget extension's own process, the same process the timeline provider runs in, so the extension's
// own defaults are shared ground between the two. (An App Group would mean a new entitlement, hence a
// regenerated provisioning profile — the thing the rejected Xcode account can't currently issue.)
enum ArmStore {
    /// An armed row auto-disarms after this long, so a ✕ left open on the Home Screen doesn't sit
    /// there indefinitely waiting to be brushed. The provider schedules an entry at the expiry.
    static let ttl: TimeInterval = 20
    private static let idKey = "todo.armedID"
    private static let atKey = "todo.armedAt"

    static func arm(_ id: String) {
        UserDefaults.standard.set(id, forKey: idKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: atKey)
    }
    static func disarm() {
        UserDefaults.standard.removeObject(forKey: idKey)
        UserDefaults.standard.removeObject(forKey: atKey)
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
// actions in Shortcuts, where "Select to-do item" is noise at best.

/// Tapping a row TOGGLES its ✕. One intent rather than an arm/disarm pair because `Button(intent:)`
/// takes one concrete type — a ternary over two intent types doesn't typecheck — and because backing
/// out should be a tap on the very row you just tapped, not a hunt for empty space.
struct TapTodoItem: AppIntent {
    static var title: LocalizedStringResource = "Select to-do item"
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
    static var title: LocalizedStringResource = "Clear to-do item"
    static var isDiscoverable: Bool = false
    @Parameter(title: "id") var id: String
    init() {}
    init(id: String) { self.id = id }

    // Awaited, not fired and forgotten: WidgetKit rebuilds the timeline as soon as perform() returns,
    // and that rebuild re-fetches the list. Returning early would race the write and redraw the row
    // that was just cleared.
    func perform() async throws -> some IntentResult {
        await TodoAPI.clear(id: id)
        ArmStore.disarm()
        return .result()
    }
}

enum TodoAPI {
    /// The same soft clear the web pane uses (`/api/todos/clear`, kind "item") — one cleared state
    /// across every surface, and the row survives its recovery window.
    static func clear(id: String) async {
        guard let url = URL(string: Auth.host + "/api/todos/clear"), let token = Auth.token() else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 15
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["kind": "item", "id": id])
        _ = try? await URLSession.shared.data(for: r)
    }
}

// MARK: - Drawing

/// Which family to lay out for. Mirrors the widget families without depending on WidgetKit, so the
/// render harness can ask for any of them.
public enum TodoLayout {
    case small, medium, large

    /// How many rows fit — measured with the render harness at real point sizes, not guessed. Each
    /// row is one line: titles only, never the body text after the em dash, so row height is fixed
    /// and the count is exact rather than a hope.
    var rows: Int { switch self { case .small: 6; case .medium: 5; case .large: 10 } }
    var titleSize: CGFloat { switch self { case .small: 11; case .medium: 13; case .large: 14 } }
    var rowGap: CGFloat { switch self { case .small: 5; case .medium: 7; case .large: 11 } }
}

private let dangerRed = Color(red: 0.937, green: 0.267, blue: 0.267)   // #ef4444

private struct TodoRowView: View {
    let item: TodoItem
    let armed: Bool
    let layout: TodoLayout

    var body: some View {
        HStack(spacing: 6) {
            Button(intent: TapTodoItem(id: item.id)) { label }
                .buttonStyle(.plain)
            if armed {
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
        HStack(spacing: 7) {
            Circle()
                .fill(armed ? dangerRed : mutedText.opacity(0.55))
                .frame(width: 4, height: 4)
            Text(item.title)
                .font(.system(size: layout.titleSize, weight: .medium, design: .rounded))
                .foregroundStyle(armed ? inkText : inkText.opacity(0.92))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())   // the whole row is the target, not just the glyphs
    }
}

struct TodoListView: View {
    let feed: TodoFeed?
    let armed: String?
    let layout: TodoLayout

    var body: some View {
        let items = feed?.items ?? []
        let shown = Array(items.prefix(layout.rows))
        let hidden = items.count - shown.count

        VStack(alignment: .leading, spacing: layout.rowGap) {
            HStack(spacing: 5) {
                Text((feed?.list ?? "to-do").uppercased())
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(mutedText)
                    .tracking(0.8)
                if !items.isEmpty {
                    Text(String(items.count))
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(mutedText.opacity(0.8))
                }
                Spacer(minLength: 0)
            }

            if feed == nil {
                // Distinct from an empty list on purpose: "nothing to show" and "couldn't load" are
                // different facts, and only one of them means you're done.
                Text("Can\u{2019}t reach the hub")
                    .font(.system(size: layout.titleSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            } else if shown.isEmpty {
                Text("All clear")
                    .font(.system(size: layout.titleSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            } else {
                ForEach(shown) { item in
                    TodoRowView(item: item, armed: item.id == armed, layout: layout)
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
