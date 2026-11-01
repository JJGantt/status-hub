import SwiftUI

/// The Claude subscription's two usage windows (`/api/usage`, from Supabase `claude_usage`), the same
/// reading the hairline bars along the top of the walls draw. The hub announces a new reading as a
/// `usage` frame on /api/day-stream, so the page follows that while it is showing.
struct UsageWindow: Decodable {
    let pct: Double
    let resets_in_min: Int?
}

struct UsageFeed: Decodable {
    let five_hour: UsageWindow
    let seven_day: UsageWindow
}

@MainActor
final class ClaudeUsage: ObservableObject {
    static let shared = ClaudeUsage()
    @Published private(set) var feed: UsageFeed?
    private var stream: Task<Void, Never>?

    @discardableResult func activate() -> Task<Void, Never> {
        let loaded = Task { await load() }
        if stream == nil { stream = Task { await Hub.follow("usage") { [weak self] in await self?.load() } } }
        return loaded
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
    }

    func load() async {
        if let f: UsageFeed = try? await Hub.json("/api/usage") { feed = f }
    }
}

struct UsageView: View {
    @ObservedObject private var usage = ClaudeUsage.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let f = usage.feed {
                row("5h", f.five_hour)
                row("Week", f.seven_day)
            }
        }
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func row(_ name: String, _ w: UsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(w.pct.rounded()))%").font(.system(size: 22, weight: .semibold).monospacedDigit())
                    .foregroundStyle(color(w.pct))
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule().fill(color(w.pct)).frame(width: g.size.width * min(1, max(0, w.pct / 100)))
                }
            }
            .frame(height: 6)
            if let m = w.resets_in_min {
                Text(Self.left(m)).font(.system(size: 13).monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }

    /// Amber from 75% and red from 90%: where a dispatched session is reported, then held back.
    private func color(_ pct: Double) -> Color {
        pct >= 90 ? Color(red: 0.898, green: 0.282, blue: 0.302)
            : pct >= 75 ? Color(red: 0.902, green: 0.725, blue: 0.239)
            : Color(red: 0.545, green: 0.580, blue: 0.620)
    }

    static func left(_ m: Int) -> String {
        let d = m / 1440, h = (m % 1440) / 60, mm = m % 60
        return d > 0 ? "\(d)d \(h)h" : h > 0 ? "\(h)h \(mm)m" : "\(mm)m"
    }
}
