import SwiftUI
import WatchKit

/// **The bedroom TV's remote** (docs/WATCH.md § The remote page): play/pause and volume, through the
/// hub's `/api/tv/remote`, which hands each press to the TV's companion app and answers with what the
/// TV reports afterwards. The volume shown is the TV's last answer plus the steps it has not answered yet.
@MainActor
final class TvRemote: ObservableObject {
    static let shared = TvRemote()

    /// The TV's volume as it last reported it; nil until read, or when the TV did not answer.
    @Published private(set) var volume: Int?
    /// Steps pressed or turned that the TV has not answered yet: queued plus on the wire. What is shown
    /// is `volume + outstanding`, the level the user asked for, and the TV's answer catches up to it.
    @Published private(set) var outstanding = 0
    /// What the playing app's media session says: true playing, false paused, nil not known (not read
    /// yet, or nothing playing).
    @Published private(set) var playing: Bool?
    /// The TV's own words when a press did not land ("the TV is off…", "nothing is playing").
    @Published private(set) var problem: String?

    /// One volume command on the wire at a time: the TV app walks to a level a step at a time, and two
    /// walks at once would fight. Presses made meanwhile add to `queued`, which goes out as one step
    /// when the answer comes back, so a fast crown spin is a few sends, not one per detent.
    private var queued = 0
    private var sending = false

    private struct Answer: Decodable {
        let ok: Bool?
        let error: String?
        let volume: Int?
        let state: String?
        let playing: Bool?
    }

    private init() {}

    /// Reads the TV's volume and what is playing, each time the page comes on screen.
    @discardableResult func activate() -> Task<Void, Never> {
        Task {
            async let v = send(["op": "volume"])
            async let n = send(["op": "now"])
            let (vol, now) = await (v, n)
            if let vol, vol.ok == true, let x = vol.volume { volume = x }
            if let now { take(now) }
            problem = [vol, now].compactMap { $0 }.first { $0.ok == false }?.error
        }
    }

    /// A press or a crown detent: always taken, whatever the watch knows about the TV. It is a STEP,
    /// relative to wherever the TV is when it arrives, so nothing waits for a read.
    func step(_ by: Int) {
        queued += by
        outstanding += by
        pushVolume()
    }

    /// The level to show: what the user has asked for, when the TV's level is known.
    var shown: Int? { volume.map { max(0, min(100, $0 + outstanding)) } }

    private func pushVolume() {
        guard !sending, queued != 0 else { return }
        sending = true
        let by = queued
        queued = 0
        Task {
            let a = await send(["op": "volume", "step": by])
            sending = false
            outstanding -= by
            if let a, a.ok == true, let x = a.volume {
                volume = x
                problem = nil
            } else {
                problem = a?.error ?? "no answer"
                Hub.log("remote_fail", ["op": "volume", "error": problem ?? ""])
            }
            pushVolume()
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
                Text(remote.shown.map(String.init) ?? "–")
                    .font(.system(size: 30, weight: .semibold).monospacedDigit())
                    .foregroundStyle(remote.outstanding == 0 ? .primary : .secondary)
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
        }
        .buttonStyle(.plain)
        .background(Color.white.opacity(lit ? 0.3 : 0.1), in: RoundedRectangle(cornerRadius: 16))
    }

    private func volumeButton(_ glyph: String, _ by: Int) -> some View {
        Button { tap(); remote.step(by) } label: {
            Image(systemName: glyph).font(.system(size: 22, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 52)
        }
        .buttonStyle(.plain)
        .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
    }

    private func tap() { WKInterfaceDevice.current().play(.click) }
}
