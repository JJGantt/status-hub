import SwiftUI
import WatchKit

/// **A RINGING ALARM TAKES OVER THE APP**, as it takes over the TV and the hub page (docs/ALARMS.md).
/// The same rule as every other ringer: an alarm-marked item whose moment has passed and which is still in
/// the feed is ringing. So opening the app mid-ring — from its notification or from anywhere — lands on
/// the alarm and nothing else, and Stop or Snooze here silences every surface, because both change the
/// item and every ringer follows the item.
///
/// It only runs while the app is in front: the list stream is held open then and dropped when the app
/// leaves, and the wrist down is the notification's job. A clock arrival while open is a local sleep to
/// the next moment, not a question asked of the hub.
@MainActor
final class Alarm: ObservableObject {
    static let shared = Alarm()
    /// The same as the hub page's SNOOZE_MIN and the phone's notification.
    static let snoozeMinutes = 9

    struct Item: Decodable, Identifiable, Equatable {
        let id: String
        let title: String?
        let when: String?
        let alarm: Bool?
    }

    @Published private(set) var ringing: Item?
    private var items: [Item] = []
    /// Answered here, so the moment between the tap and the feed catching up cannot ring again. Keyed on
    /// the moment too, so a snoozed alarm rings again at its new one.
    private var answered = Set<String>()
    private var stream: Task<Void, Never>?
    private var clock: Task<Void, Never>?
    private var buzz: Task<Void, Never>?

    func activate() {
        guard stream == nil else { return }
        stream = Task {
            await load()
            await Hub.listen("/api/list-stream", reconnected: { await self.load() }) { event, _ in
                if event == "lists" { await self.load() }
            }
        }
    }

    func deactivate() {
        stream?.cancel(); stream = nil
        clock?.cancel(); clock = nil
        stopBuzz()
    }

    func load() async {
        do {
            items = try await Hub.dueFeed().filter { $0.alarm == true && $0.when != nil }
        } catch {
            Hub.log("alarm-feed-failed", ["error": String(describing: error).prefix(120).description])
            return
        }
        settle()
    }

    func stop() { answer("stop") }
    func snooze() { answer("snooze") }

    private func answer(_ how: String) {
        guard let it = ringing else { return }
        answered.insert(key(it))
        Hub.log("alarm-\(how)", ["id": it.id])
        set(nil)
        settle()
        Task {
            if how == "snooze" { await Hub.snooze(it.id) } else { await Hub.complete(it.id) }
            await load()
        }
    }

    private func key(_ it: Item) -> String { "\(it.id):\(it.when ?? "")" }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f
    }()

    /// A naive local stamp, read on the watch's own clock and zone, as the TV reads it on the Pi's.
    static func moment(_ it: Item) -> Date? {
        guard let w = it.when, w.count >= 16 else { return nil }
        return stamp.date(from: String(w.prefix(16)))
    }

    /// Rings whatever is due now, and sleeps to the next moment otherwise.
    private func settle() {
        let now = Date()
        let live = items.filter { !answered.contains(key($0)) }
            .compactMap { it in Self.moment(it).map { (at: $0, it: it) } }
            .sorted { $0.at < $1.at }
        let due = live.first { $0.at <= now }?.it
        if due?.id != ringing?.id || due?.when != ringing?.when { set(due) }
        clock?.cancel(); clock = nil
        guard ringing == nil, let next = live.first(where: { $0.at > now }) else { return }
        clock = Task {
            try? await Task.sleep(for: .seconds(max(next.at.timeIntervalSinceNow, 0)))
            if !Task.isCancelled { self.settle() }
        }
    }

    private func set(_ it: Item?) {
        if let it { Hub.log("alarm-ring", ["id": it.id, "when": it.when ?? ""]) }
        ringing = it
        if it == nil { stopBuzz() } else { startBuzz() }
    }

    /// The wrist is the speaker: the notification haptic, which carries the system's alert tone with it,
    /// on a loop until the alarm is answered or the app leaves the screen.
    private func startBuzz() {
        guard buzz == nil else { return }
        buzz = Task {
            while !Task.isCancelled {
                WKInterfaceDevice.current().play(.notification)
                try? await Task.sleep(for: .seconds(1.6))
            }
        }
    }

    private func stopBuzz() { buzz?.cancel(); buzz = nil }
}

/// The whole screen while an alarm rings: its time, its name, Snooze and Stop, and nothing under it
/// takes a touch.
struct AlarmView: View {
    let item: Alarm.Item
    @ObservedObject private var alarm = Alarm.shared
    @State private var flash = false

    private var time: String {
        guard let d = Alarm.moment(item) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "h:mm"
        return f.string(from: d)
    }

    var body: some View {
        ZStack {
            Color(red: 1, green: 0.23, blue: 0.19).opacity(flash ? 0.6 : 1).ignoresSafeArea()
            VStack(spacing: 6) {
                Text(time).font(.system(size: 44, weight: .heavy)).monospacedDigit()
                if let t = item.title, !t.isEmpty {
                    Text(t).font(.system(size: 16, weight: .bold)).lineLimit(2).multilineTextAlignment(.center)
                }
                Spacer(minLength: 4)
                HStack(spacing: 8) {
                    Button("SNOOZE") { alarm.snooze() }
                        .tint(.black.opacity(0.35))
                    Button("STOP") { alarm.stop() }
                        .tint(.white)
                        .foregroundStyle(Color(red: 1, green: 0.23, blue: 0.19))
                }
                .buttonStyle(.borderedProminent)
                .font(.system(size: 15, weight: .heavy))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true)) { flash = true }
        }
    }
}
