import SwiftUI
import AppIntents
import Foundation

// The repo widget's DRAWING, WidgetKit-free so it renders standalone — see tools/render-repos.swift.
// Mirrors the phone's repos pane (cards/repos.js): every directory in ~/repos, most recently touched
// first, with a branch chip only when it is worth knowing and a dot when the checkout is dirty.
//
// WHAT A TAP DOES, and why it is not a launch: opening a bare session leaves you typing the actual
// request into a fresh prompt on the Mac afterwards. So a tap dictates the session's FIRST message
// instead — except a widget extension has no microphone, so it can't do the dictating. It hands the
// choice to the app (statushub://repo/<path>) and the recording happens there, on the repos pane.
//
// Which makes this widget a two-tap PICKER: tap a row to select it, tap ▶ to confirm and hand over.
// The confirm step matters more here than on the due widget — this one starts a process on a real
// machine, and a stray tap that opens a terminal is a worse outcome than one that opens options.

struct RepoRow: Codable, Identifiable {
    let path: String
    let name: String
    let branch: String?     // already filtered hub-side: null unless worth showing
    let dirty: Bool?
    let age: String?
    var id: String { path }
    var isDirty: Bool { dirty == true }
}
struct ReposFeed: Codable {
    let repos: [RepoRow]
    /// Whether the Mac is awake. Optional so a cache written by an older build still decodes rather
    /// than blanking the widget — the same reason the due widget's flags are optional.
    private let online: Bool?
    var isOnline: Bool { online == true }
}

/// Which row is selected, awaiting its confirm. Extension-local for the same reason as the due
/// widget's ArmStore: a widget's button intent runs in the extension's own process, so no App Group
/// is needed — and an App Group would mean a new entitlement and a regenerated profile.
enum RepoArmStore {
    static let ttl: TimeInterval = 20
    private static let idKey = "repo.armedPath"
    private static let atKey = "repo.armedAt"

    static func arm(_ path: String) {
        UserDefaults.standard.set(path, forKey: idKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: atKey)
    }
    static func disarm() {
        UserDefaults.standard.removeObject(forKey: idKey)
        UserDefaults.standard.removeObject(forKey: atKey)
    }
    static func armed(now: Date = Date()) -> (path: String, at: Date)? {
        guard let p = UserDefaults.standard.string(forKey: idKey) else { return nil }
        let at = Date(timeIntervalSince1970: UserDefaults.standard.double(forKey: atKey))
        return at.addingTimeInterval(ttl) > now ? (p, at) : nil
    }
}

/// Selecting a row toggles its confirm button. Purely local — no network, so it redraws immediately.
struct TapRepo: AppIntent {
    static var title: LocalizedStringResource = "Select project"
    static var isDiscoverable: Bool = false
    @Parameter(title: "path") var path: String
    init() {}
    init(path: String) { self.path = path }
    func perform() async throws -> some IntentResult {
        if RepoArmStore.armed()?.path == path { RepoArmStore.disarm() } else { RepoArmStore.arm(path) }
        return .result()
    }
}

/// Confirm: hand the project to the app, which lands on the repos pane and starts recording.
/// `openAppWhenRun`, so perform() runs in the app process where the bridge exists.
struct OpenRepoSession: AppIntent {
    static var title: LocalizedStringResource = "Start a session in this project"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = true

    @Parameter(title: "path") var path: String
    init() {}
    init(path: String) { self.path = path }

    @MainActor
    func perform() async throws -> some IntentResult {
        RepoArmStore.disarm()
        #if HUB_APP
        RepoLaunch.shared.request(path)
        #endif
        return .result()
    }
}

public enum ReposLayout {
    case small, medium, large

    var rows: Int { switch self { case .small: 6; case .medium: 5; case .large: 10 } }
    var nameSize: CGFloat { switch self { case .small: 11; case .medium: 13; case .large: 14 } }
    var rowGap: CGFloat { switch self { case .small: 5; case .medium: 7; case .large: 11 } }
    /// The small family has no width for a branch chip or an age column beside the name.
    var showsMeta: Bool { self != .small }
}

private let goRed = Color(red: 0.898, green: 0.282, blue: 0.302)      // #e5484d — the recording colour
private let dirtyAmber = Color(red: 0.902, green: 0.725, blue: 0.239) // #e6b93d

private struct RepoRowView: View {
    let repo: RepoRow
    let armed: Bool
    let online: Bool
    let layout: ReposLayout

    var body: some View {
        HStack(spacing: 6) {
            Button(intent: TapRepo(path: repo.path)) { label }
                .buttonStyle(.plain)
                .disabled(!online)
            if armed && online {
                Button(intent: OpenRepoSession(path: repo.path)) {
                    // A mic, not a play arrow: the next thing that happens is the app listening, not
                    // a terminal opening. Promising the wrong outcome is worse than a dull icon.
                    Image(systemName: "mic.fill")
                        .font(.system(size: layout.nameSize, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: layout.nameSize + 9)
                        .background(Capsule().fill(goRed))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var label: some View {
        HStack(spacing: 6) {
            Text(repo.name)
                .font(.system(size: layout.nameSize, weight: armed ? .semibold : .medium, design: .rounded))
                .foregroundStyle(online ? inkText.opacity(armed ? 1 : 0.92) : mutedText)
                .lineLimit(1)
                .truncationMode(.tail)
            if repo.isDirty {
                Circle().fill(dirtyAmber).frame(width: 5, height: 5)
            }
            if let b = repo.branch, layout.showsMeta {
                Text(b)
                    .font(.system(size: layout.nameSize - 3, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let a = repo.age, layout.showsMeta, !armed {
                Text(a)
                    .font(.system(size: layout.nameSize - 3, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            }
        }
        .contentShape(Rectangle())
    }
}

struct ReposListView: View {
    let feed: ReposFeed?
    let armed: String?
    let layout: ReposLayout

    var body: some View {
        let repos = feed?.repos ?? []
        let shown = Array(repos.prefix(layout.rows))
        let online = feed?.isOnline ?? false

        VStack(alignment: .leading, spacing: layout.rowGap) {
            HStack(spacing: 5) {
                Text("PROJECTS")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(mutedText)
                    .tracking(0.8)
                if feed != nil && !online {
                    Text("Mac asleep")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(dirtyAmber)
                }
                Spacer(minLength: 0)
            }

            if feed == nil {
                Text("Can\u{2019}t reach the hub")
                    .font(.system(size: layout.nameSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            } else if shown.isEmpty {
                Text("No projects published")
                    .font(.system(size: layout.nameSize, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
            } else {
                ForEach(shown) { r in
                    RepoRowView(repo: r, armed: r.path == armed, online: online, layout: layout)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
