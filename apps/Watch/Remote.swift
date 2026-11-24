import SwiftUI
import WatchKit

/// **The bedroom TV's remote** (docs/WATCH.md § The remote page): play/pause and volume, through the
/// hub's `/api/tv/remote`, which hands each press to the TV's companion app and answers with what the
/// TV reports afterwards. The volume shown is the level the user wants; the TV catches up to it.
@MainActor
final class TvRemote: ObservableObject {
    static let shared = TvRemote()

    /// The level the user wants, which is what the page shows. A press changes it at once and never
    /// waits on anything; until the TV has been read it starts from the last level the TV reported.
    @Published private(set) var target: Int?
    /// The TV's volume as it last reported it in this run; nil until it has answered.
    @Published private(set) var confirmed: Int?
    /// What the playing app's media session says: true playing, false paused, nil not known (not read
    /// yet, or nothing playing).
    @Published private(set) var playing: Bool?
    /// The TV's own words when a press did not land ("the TV is off…", "nothing is playing").
    @Published private(set) var problem: String?

    /// True once the user has pressed since the TV last matched `target`: the level has to be sent.
    private var dirty = false
    /// A read was asked for (the page came on screen) and has not gone out yet.
    private var needsRead = false
    /// Steps pressed before any level was known (first launch only), added to the first reading.
    private var pendingSteps = 0
    /// One volume command on the wire at a time: the TV app walks to a level a step at a time, and two
    /// walks at once would fight. Presses made meanwhile only move `target`; whatever it is when the
    /// answer comes back is what goes out next, so a fast crown spin is a few sends, never a queue.
    private var sending = false
    /// A failed send is retried with exponential backoff while the TV is still behind; a press
    /// cancels the wait and sends straight away.
    private var failures = 0
    private var retry: Task<Void, Never>?

    private static let cacheKey = "tvRemote.volume"

    private struct Answer: Decodable {
        let ok: Bool?
        let error: String?
        let volume: Int?
        let state: String?
        let playing: Bool?
    }

    private init() {
        target = UserDefaults.standard.object(forKey: Self.cacheKey) as? Int
    }

    /// True while the TV has not yet reported the level shown.
    var behind: Bool { target == nil || target != confirmed }

    /// Reads the TV's volume and what is playing, each time the page comes on screen.
    @discardableResult func activate() -> Task<Void, Never> {
        needsRead = true
        retry?.cancel()
        retry = nil
        pumpVolume()
        return Task { if let now = await send(["op": "now"]) { take(now) } }
    }

    /// A press or a crown detent: moves the shown level immediately, whatever the TV is doing.
    func step(_ by: Int) {
        if let t = target {
            target = max(0, min(100, t + by))
            dirty = true
        } else {
            pendingSteps += by
            needsRead = true
        }
        retry?.cancel()
        retry = nil
        failures = 0
        pumpVolume()
    }

    private func pumpVolume() {
        guard !sending, retry == nil else { return }
        let asked: Int? = dirty ? target : nil
        guard asked != nil || needsRead else { return }
        sending = true
        needsRead = false
        var body: [String: Any] = ["op": "volume"]
        if let asked { body["value"] = asked }
        Task {
            let a = await send(body)
            sending = false
            if let a, a.ok == true, let x = a.volume {
                confirmed = x
                UserDefaults.standard.set(x, forKey: Self.cacheKey)
                if let asked {
                    // Landed, or the TV settled elsewhere with nothing newer asked: the TV's level stands.
                    if target == asked { target = x; dirty = false }
                } else if !dirty {
                    target = max(0, min(100, x + pendingSteps))
                    dirty = pendingSteps != 0
                    pendingSteps = 0
                }
                failures = 0
                problem = nil
            } else {
                problem = a?.error ?? "no answer"
                Hub.log("remote_fail", ["op": "volume", "error": problem ?? ""])
                if asked == nil { needsRead = true }
                failures += 1
                let wait = min(30.0, pow(2.0, Double(failures - 1)))
                retry = Task {
                    try? await Task.sleep(for: .seconds(wait))
                    guard !Task.isCancelled else { return }
                    retry = nil
                    pumpVolume()
                }
                return
            }
            pumpVolume()
        }
    }

    /// `play` or `pause`, exactly as pressed: two buttons, never a toggle, so a press does what it says
    /// whatever the watch last heard about the TV.
    func media(_ action: String) {
        Task { if let a = await send(["op": "media", "action": action]) { take(a) } }
    }

    private func take(_ a: Answer) {
        if a.ok == true {
            playing = a.state.map { $0 == "playing" }
            problem = nil
        } else {
            problem = a.error ?? "no answer"
        }
    }

    private func send(_ body: [String: Any]) async -> Answer? {
        do {
            return try JSONDecoder().decode(Answer.self, from: try await Hub.post("/api/tv/remote", body, timeout: 20))
        } catch {
            Hub.log("remote_fail", ["op": body["op"] ?? "", "error": "\(error)"])
            return nil
        }
    }
}

struct RemoteView: View {
    @ObservedObject private var remote = TvRemote.shared
    /// The crown's raw position, and the detent last turned into a step.
    @State private var crown = 0.0
    @State private var detent = 0
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 10) {
            // The button matching what the TV last reported is lit; the other is dim. Only a look: each
            // one always sends its own action.
            HStack(spacing: 8) {
                mediaButton("play.fill", "play", lit: remote.playing == true)
                mediaButton("pause.fill", "pause", lit: remote.playing == false)
            }

            HStack(spacing: 8) {
                volumeButton("minus", -1)
                Text(remote.target.map(String.init) ?? "–")
                    .font(.system(size: 30, weight: .semibold).monospacedDigit())
                    .foregroundStyle(remote.behind ? .secondary : .primary)
                    .frame(minWidth: 54)
                volumeButton("plus", 1)
            }

            if let p = remote.problem {
                Text(p).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .focusable()
        .focused($focused)
        // The crown is a stream of detents, each one a step: it holds no level of its own, so it never
        // has to be lined up with the TV's.
        .digitalCrownRotation($crown, from: -10000, through: 10000, by: 1, sensitivity: .low,
                              isContinuous: true, isHapticFeedbackEnabled: true)
        .onChange(of: crown) { _, v in
            let d = Int(v.rounded()) - detent
            if d != 0 { detent += d; remote.step(d) }
        }
        .onAppear { focused = true }
    }

    private func mediaButton(_ glyph: String, _ action: String, lit: Bool) -> some View {
        Button { tap(); remote.media(action) } label: {
            Image(systemName: glyph).font(.system(size: 30, weight: .semibold))
                .frame(maxWidth: .infinity, minHeight: 70)
                .background(Color.white.opacity(lit ? 0.3 : 0.1), in: RoundedRectangle(cornerRadius: 16))
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
    }

    private func volumeButton(_ glyph: String, _ by: Int) -> some View {
        Button { tap(); remote.step(by) } label: {
            Image(systemName: glyph).font(.system(size: 22, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                // A plain button takes taps only where its label draws; without this the minus, a thin
                // bar, catches a fraction of the taps the plus does.
                .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    private func tap() { WKInterfaceDevice.current().play(.click) }
}
