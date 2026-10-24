import AVFoundation
import SwiftUI
import WatchKit

/// **Rewind**: while it is engaged the last `seconds` of what the microphone hears are kept in memory,
/// and a grab sends them to the hub to be transcribed (`dry`, so nothing runs as a command) and shows
/// the words. Nothing is written to disk or uploaded until a grab. `docs/REWIND.md` is the whole picture.
///
/// It is the minimal build, made to MEASURE how long watchOS lets an app hold the microphone with the
/// wrist down, and what that costs in battery: every log line below carries the minutes since it was
/// engaged and the battery level.
@MainActor
final class Rewind: ObservableObject {
    static let shared = Rewind()

    /// How much it keeps: `watch_rewind_s` in the hub's settings, read when it is engaged. Unset, 30.
    static var seconds: TimeInterval = 30
    /// The rate the recorder's sink converts to, and so the rate the ring is in.
    static let rate: Double = 16_000

    /// What a grab is showing: nil text while the hub transcribes.
    struct Shown: Identifiable {
        let id = UUID()
        var text: String?
        var failed = false
    }
    @Published var shown: Shown?

    /// Fed by the recorder's sink whenever it is set, whoever owns the microphone.
    private(set) var tee: RewindTee?
    private var since: Date?
    /// Seconds of audio that have actually arrived since it was engaged; a line every `beat` of them.
    private var fed: TimeInterval = 0
    private static let beat: TimeInterval = 300

    var engaged: Bool { tee != nil }

    func engage() -> RewindTee {
        let tee = RewindTee(seconds: Self.seconds, rate: Self.rate)
        self.tee = tee
        since = Date()
        fed = 0
        WKInterfaceDevice.current().isBatteryMonitoringEnabled = true
        Hub.log("rewind", ["on": true, "seconds": Self.seconds].merging(Self.battery) { a, _ in a })
        return tee
    }

    func disengage(_ why: String) {
        guard tee != nil else { return }
        Hub.log("rewind", ["on": false, "why": why].merging(state) { a, _ in a })
        tee = nil
        since = nil
    }

    /// One buffer of audio reached the ring. A line every five minutes of it — audio arriving, not a
    /// timer, so a line only appears while the microphone is genuinely still feeding.
    func heard(_ seconds: TimeInterval) {
        guard engaged else { return }
        let before = Int(fed / Self.beat)
        fed += seconds
        if Int(fed / Self.beat) > before { Hub.log("rewind-alive", state) }
    }

    /// The app coming to the front with it engaged. `quiet` is how long before now the last audio
    /// arrived: near 0 means the microphone fed all along, minutes means watchOS took it away while the
    /// wrist was down, which no callback reports.
    func check() {
        guard engaged else { return }
        Hub.log("rewind-check", state)
    }

    /// The grab on screen: its id once the hub has kept it, nil when the upload failed. Instructions
    /// recorded for it wait on this (`Chat.startInstructions`).
    private(set) var pending: Task<String?, Never>?

    /// Takes what it holds, sends it to the hub to be kept and transcribed with speaker labels, and shows
    /// the words. With `ask` (the Rewind Ask control) it also starts recording his instructions for it at
    /// once, without waiting for the words.
    func grab(ask: Bool = false) {
        guard let tee else {
            Hub.log("rewind-grab", ["ok": false, "why": "off"])
            WKInterfaceDevice.current().play(.failure)
            return
        }
        let (samples, last) = tee.take()
        let held = Double(samples.count) / Self.rate
        guard held >= 0.5 else {
            Hub.log("rewind-grab", ["ok": false, "why": "empty", "held": held])
            WKInterfaceDevice.current().play(.failure)
            return
        }
        WKInterfaceDevice.current().play(.click)
        let showing = Shown()
        shown = showing
        let quiet = last.map { Date().timeIntervalSince($0) } ?? -1
        let task = Task<String?, Never> {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
            defer { try? FileManager.default.removeItem(at: url) }
            let began = Date()
            do {
                try RewindAudio.writeM4A(samples, rate: Self.rate, to: url)
                let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? -1
                let grabbed = try await Awake.hold("transcribing a rewind") {
                    try await Hub.sendRewind(url, held: held)
                }
                let text = grabbed.transcript ?? ""
                Hub.log("rewind-grab", ["ok": true, "held": held, "quiet": quiet, "bytes": bytes, "ask": ask,
                                        "ms": Int(Date().timeIntervalSince(began) * 1000), "id": grabbed.id ?? "",
                                        "model": grabbed.model ?? "", "words": text.split(separator: " ").count])
                if shown?.id == showing.id { shown?.text = text }
                WKInterfaceDevice.current().play(.notification)
                return grabbed.id
            } catch {
                Hub.log("rewind-grab", ["ok": false, "why": String(describing: error).prefix(120).description,
                                        "held": held, "ask": ask, "ms": Int(Date().timeIntervalSince(began) * 1000)])
                if shown?.id == showing.id { shown?.failed = true }
                WKInterfaceDevice.current().play(.failure)
                return nil
            }
        }
        pending = task
        if ask { Chat.shared.startInstructions(for: task) }
    }

    /// What every line carries: how long it has been engaged, how much audio has arrived, how long ago
    /// the last of it did, what it holds, who has the microphone, and the battery.
    private var state: [String: Any] {
        var f = Self.battery
        f["minutes"] = since.map { Date().timeIntervalSince($0) / 60 } ?? -1
        f["fed"] = Int(fed)
        f["held"] = tee.map { $0.held } ?? 0
        f["quiet"] = tee?.lastAudio.map { Date().timeIntervalSince($0) } ?? -1
        f["owner"] = Capture.shared.owner.map { String(describing: $0) } ?? ""
        return f
    }

    /// 0…1, -1 when the watch does not say; `charging` because a reading on the charger measures nothing.
    private static var battery: [String: Any] {
        let device = WKInterfaceDevice.current()
        return ["battery": Double(device.batteryLevel), "charging": device.batteryState == .charging || device.batteryState == .full]
    }
}

/// The ring the recorder's sink writes into. `write` runs on the audio thread and everything else on the
/// main actor, so the ring is only touched under the lock.
final class RewindTee: @unchecked Sendable {
    private let lock = NSLock()
    private var ring: RewindBuffer
    private let rate: Double
    private var last: Date?

    init(seconds: TimeInterval, rate: Double) {
        self.rate = rate
        ring = RewindBuffer(capacity: Int(seconds * rate))
    }

    /// One buffer already converted to the ring's rate, mono.
    func write(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        let input = UnsafeBufferPointer(start: data, count: Int(buffer.frameLength))
        lock.withLock {
            ring.append(input)
            last = Date()
        }
    }

    /// A copy of what it holds, oldest first, and when the newest of it arrived. The ring keeps it:
    /// a second grab a moment later hears the same moments again plus whatever came since.
    func take() -> ([Float], Date?) { lock.withLock { (ring.snapshot(), last) } }

    var held: TimeInterval { lock.withLock { Double(ring.count) / rate } }
    var lastAudio: Date? { lock.withLock { last } }
}

/// What a grab shows: the words, speaker-labeled, a spinner while they come, a mark if it failed. No
/// prose of its own. **A tap anywhere records his instructions for the grab**, locked open with the red
/// edge until the next tap sends them, as a session follow-up does; sending closes the sheet, and the
/// command runs on the home thread like any other.
struct RewindSheet: View {
    let shown: Rewind.Shown
    @ObservedObject private var capture = Capture.shared
    @ObservedObject private var style = BorderStyle.shared
    @Environment(\.dismiss) private var dismiss

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        ScrollView {
            if let text = shown.text {
                Text(text.isEmpty ? "—" : text).frame(maxWidth: .infinity, alignment: .leading)
            } else if shown.failed {
                Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .global) { at in
            CommandBorder.tapped(at)
            Hub.log("control", ["view": "rewind", "recording": recording, "how": "tap"])
            if recording {
                Chat.shared.stopRecording()
                dismiss()
            } else {
                Capture.trigger = "tap"
                Chat.shared.startInstructions(for: Rewind.shared.pending)
            }
        }
        // The sheet covers the app's own edge (`CommandBorder`), so it draws the locked line itself.
        .overlay {
            if recording {
                BeyondEdge(inset: CGFloat(max(1, style.px)) / WKInterfaceDevice.current().screenScale)
                    .fill(solid(style.locked), style: FillStyle(eoFill: true))
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
        }
    }
}
