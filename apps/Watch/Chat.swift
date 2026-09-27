import Foundation
import WatchKit

/// The prompt page's state: the shared thread, the hub command in flight, and the tool calls of
/// whatever hub command is running.
@MainActor
final class Chat: ObservableObject {
    /// One per app, so the Record control's intent can reach the screen (WatchWidgets/RecordIntent.swift).
    static let shared = Chat()

    enum Failure: Equatable {
        case noToken
        case micDenied
        case message(String)
    }

    @Published private(set) var thread: [Message] = []
    /// What home draws: the last ten exchanges. The hub sends forty rows, which is more than a wrist
    /// reads and slower to lay out than it is worth.
    var recent: [Message] { Array(thread.suffix(20)) }
    /// What the hub heard of each command still running, oldest first, shown until it lands in the
    /// thread.
    @Published private(set) var pending: [String] = []
    /// A command is on its way or running. Any number can be: firing one blocks nothing.
    @Published private(set) var waiting = false
    @Published private(set) var failure: Failure?
    /// Tool calls of the hub command running now, and what the model says between them, as the worker
    /// reports them. The hub does not store them, so they show while a command runs and clear when the
    /// next starts or this one finishes.
    @Published private(set) var activity: [ActivityLine] = []
    /// Set by the complication's statushub://record and by the Record control; home starts recording
    /// once it is on screen. It carries WHEN it was asked for: a request that nothing consumed (the app
    /// was not in front, the watch went back to its face) must not start a recording minutes later, on
    /// whatever raise of the wrist happens to bring the app back.
    @Published var recordRequested = false
    private(set) var requestedAt = Date.distantPast
    static let requestWindow: TimeInterval = 20

    private let capture = Capture.shared
    /// **Commands can overlap.** Each is sent and waited on by itself. Kept across a retry: the clip
    /// until its command has run, the msgId so a resend cannot enqueue twice, and the request id once
    /// known, after which a retry only waits again.
    private struct Command {
        var msgId = UUID().uuidString
        var clip: Recorder.Clip?
        var requestId: String?
        var words: String?
        var running = false
        /// It failed and is kept only so Retry can send it again: not waited on, and its words are not
        /// shown as pending (the hub has already put them in the thread, or never had them).
        var failed = false
    }
    private var commands: [Command] = [] {
        didSet {
            let live = commands.filter { !$0.failed }
            waiting = !live.isEmpty
            pending = live.compactMap(\.words)
            StayAwake.shared.refresh()
        }
    }
    private var tasks: [String: Task<Void, Never>] = [:]
    private var stream: Task<Void, Never>?
    private var loading = false
    private var reloadAfter = false

    private init() {
        PhoneLink.shared.onToken = { [weak self] in self?.tokenArrived() }
    }

    func requestRecording() {
        requestedAt = Date()
        recordRequested = true
    }

    /// A launcher's request is still worth acting on.
    var requestIsFresh: Bool { Date().timeIntervalSince(requestedAt) < Self.requestWindow }

    /// The page is on screen: load now, and follow the conversation and the tool calls of the hub
    /// command running until `deactivate`.
    func activate() {
        Task { await load() }
        guard stream == nil else { return }
        stream = Task {
            await Hub.listen("/api/voice-stream", reconnected: { [weak self] in await self?.load() }) { [weak self] event, data in
                await self?.voiceFrame(event, data)
            }
        }
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
    }

    func load() async {
        if loading { reloadAfter = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAfter = false
            do {
                thread = try await Hub.thread()
                if failure == .noToken { failure = nil }
                Hub.log("thread", ["rows": thread.count, "last": String((thread.last?.text ?? "").prefix(80))])
            } catch HubError.noToken {
                failure = .noToken
            } catch {
                // Keep showing what was there; the next frame or activation reloads.
            }
        } while reloadAfter
    }

    func startRecording() {
        guard capture.free else {
            Hub.log("record-refused", ["view": "chat", "owner": String(describing: capture.owner)])
            return
        }
        Hub.log("record-start", ["view": "chat", "running": commands.count])
        failure = nil
        // A command ends itself at the silence after he speaks; a second press locks it open, and the
        // next sends. A session's follow-up records the same way (Sessions.startRecording).
        capture.start(for: .hub, onSilence: { [weak self] in self?.stopRecording() },
                      onTaken: { [weak self] in self?.stopRecording() }) { [weak self] error in
            self?.failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and sends it. The wrist is tapped at the moment the microphone closes —
    /// which the silence may have decided, so it is the one moment nothing else reports.
    func stopRecording() {
        guard capture.owner == .hub, let finished = capture.stop() else { return }
        WKInterfaceDevice.current().play(.stop)
        Hub.log("record-stop", ["view": "chat", "seconds": finished.duration])
        let command = Command(clip: finished)
        commands.append(command)
        run(command.msgId)
    }

    /// Always-on listening, engaged from home: the watch joins the Mac and the ESP as a listener until
    /// it is turned off again.
    func toggleListening() {
        failure = nil
        capture.toggleListening { [weak self] error in
            self?.failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and throws it away.
    func cancelRecording() {
        if capture.owner == .hub {
            Hub.log("record-cancel", ["view": "chat"])
            capture.cancel()
        }
    }

    /// Sends again every command that is not on its way now; with none, reloads the thread.
    func retry() {
        failure = nil
        let idle = commands.filter { !$0.running }
        if idle.isEmpty { Task { await load() } }
        for c in idle {
            update(c.msgId) { $0.failed = false }
            run(c.msgId)
        }
    }

    /// Stops waiting on every command. One the hub already has still runs, and its turn appears in the
    /// thread like any other; a clip that never reached the hub is dropped.
    func cancel() {
        Hub.log("cancel", ["view": "chat", "commands": commands.count])
        tasks.values.forEach { $0.cancel() }
        tasks = [:]
        for c in commands { if let clip = c.clip { try? FileManager.default.removeItem(at: clip.url) } }
        commands = []
        failure = nil
    }

    private func tokenArrived() {
        if failure == .noToken { retry() } else { Task { await load() } }
    }

    private func update(_ msgId: String, _ change: (inout Command) -> Void) {
        guard let i = commands.firstIndex(where: { $0.msgId == msgId }) else { return }
        change(&commands[i])
    }

    private func finish(_ msgId: String) {
        if let c = commands.first(where: { $0.msgId == msgId }), let clip = c.clip {
            try? FileManager.default.removeItem(at: clip.url)
        }
        commands.removeAll { $0.msgId == msgId }
        tasks[msgId] = nil
    }

    private func voiceFrame(_ event: String, _ data: String) async {
        guard event == "voice", let frame = try? JSONDecoder().decode(VoiceFrame.self, from: Data(data.utf8)) else { return }
        switch frame.kind {
        case "activity":
            guard (frame.row?.focus ?? "hub") == "hub" else { return }
            switch frame.row?.state {
            case "tool", "text":
                if let text = frame.row?.text, !text.isEmpty {
                    activity.append(ActivityLine(text: text, kind: frame.row?.state == "text" ? .thought : .tool))
                }
            case "working", "done":
                activity = []
            default:
                break
            }
        case "message", "mode", "reset":
            await load()
        default:
            break
        }
    }

    private func run(_ msgId: String) {
        guard let command = commands.first(where: { $0.msgId == msgId }), !command.running else { return }
        failure = nil
        update(msgId) { $0.running = true }
        tasks[msgId] = Task {
            defer { update(msgId) { $0.running = false } }
            do {
                var requestId = command.requestId
                if requestId == nil {
                    guard let clip = command.clip else { finish(msgId); return }
                    let began = Date()
                    let heard = try await Awake.hold("sending a voice command") {
                        try await Hub.sendAudio(clip, msgId: msgId)
                    }
                    Hub.log("sent", ["ms": Int(Date().timeIntervalSince(began) * 1000),
                                     "id": heard.id ?? "", "words": (heard.transcript ?? "").count])
                    guard let id = heard.id else {
                        // The hub heard no words, so there is no command.
                        Hub.log("heard-nothing", ["view": "chat"])
                        finish(msgId)
                        WKInterfaceDevice.current().play(.failure)
                        return
                    }
                    requestId = id
                    update(msgId) { $0.requestId = id; $0.words = heard.transcript }
                }
                let outcome = try await Hub.outcome(requestId!)
                if Task.isCancelled { return }
                if outcome.status == "error" {
                    Hub.log("command-failed", ["id": requestId ?? "", "error": String((outcome.error ?? "").prefix(120))])
                    failure = .message(outcome.error ?? "")
                    WKInterfaceDevice.current().play(.failure)
                    // The worker ran it and failed, so a retry uploads the clip again as a new attempt.
                    update(msgId) { $0.requestId = nil; $0.running = false; $0.failed = true; $0.msgId = UUID().uuidString }
                    tasks[msgId] = nil
                } else {
                    Hub.log("answered", ["view": "chat", "id": requestId ?? ""])
                    await load()
                    finish(msgId)
                    WKInterfaceDevice.current().play(.notification)
                }
            } catch HubError.noToken {
                update(msgId) { $0.failed = true }
                failure = .noToken
            } catch {
                if Task.isCancelled { return }
                Hub.log("send-failed", ["error": String(describing: error).prefix(120).description])
                update(msgId) { $0.failed = true }
                failure = .message(error.localizedDescription)
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }
}

/// A frame of `/api/voice-stream`. `activity` rows are the worker's live reports (a tool call, the
/// command starting, it finishing); `message` rows are the conversation's own rows as they are written.
private struct VoiceFrame: Decodable {
    struct Row: Decodable {
        let text: String?
        let state: String?
        let focus: String?
    }
    let kind: String
    let row: Row?
}
