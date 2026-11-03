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
    /// What home draws: the last `window` rows, after any unread answer older than them (`held`). The
    /// hub sends forty rows; laying all of them out is what made swiping onto the page lag, and a wrist
    /// rarely reads past the last few exchanges.
    var recent: [Message] { held + thread.suffix(shownCount) }
    /// How many of the thread's rows are laid out: `window`, or further back while the user is looking, so
    /// the row at the top stays laid out (`keepFrom`).
    private var shownCount: Int {
        guard let keepFrom, let i = thread.firstIndex(where: { $0.id == keepFrom }) else { return window }
        return max(window, thread.count - i)
    }
    /// **The first row laid out when the user started looking.** Nothing drops off the top of the window
    /// while the wrist is up: a row arriving at the bottom would otherwise push the oldest one out above
    /// the screen, and everything on it would shift up by that row's height. Let go when the user stops
    /// looking, when the page is free to move.
    @Published private var keepFrom: String?
    /// **How many rows home lays out**: `windowStep` (five exchanges) at rest, a step more each time the user
    /// scrolls to the top (`showMore`), back to one step whenever the page lands on the newest again or
    /// leaves the screen. Never past what the hub sent.
    @Published private(set) var window = Chat.windowStep
    static let windowStep = 10
    /// There are rows above the window to lay out.
    var hasMore: Bool { thread.count > window }
    func showMore() {
        guard hasMore else { return }
        window += Self.windowStep
        Hub.log("thread-more", ["window": window, "rows": thread.count])
        hold()
    }
    /// Back to one step — or as far back as the answer home is asked to land on, so a notification
    /// opened on an older answer still finds it laid out.
    func resetWindow() {
        let reach = landOn.flatMap { id in thread.lastIndex { $0.id == id } }.map { thread.count - $0 } ?? 0
        let next = max(Self.windowStep, reach)
        guard window != next else { return }
        window = next
        hold()
    }
    /// Unread answers older than the window, each after the words that asked for it: the hub sends every
    /// unread answer however old. Kept until the page leaves the screen even once read, so an answer
    /// does not vanish from under the user the moment it counts as read.
    @Published private(set) var held: [Message] = []
    /// Answers flagged worth reading that no surface has shown yet, oldest first (docs/WATCH.md, "Unread
    /// answers").
    var unread: [Message] {
        thread.filter { $0.role == "assistant" && $0.needs_read == true && $0.read_at == nil && !readHere.contains($0.id) }
    }
    /// The answer home lands on (the dot, or an answer's notification opened); nil lands on the newest.
    /// The next command's words take the landing back.
    @Published private(set) var landOn: String?
    /// Counts each request to land, so a second one on the same answer still moves the view.
    @Published private(set) var landings = 0
    /// Home is on screen, in front, with the wrist up (`HomeView.attend`). The read rule's test.
    var looking = false {
        didSet {
            guard looking != oldValue else { return }
            keepFrom = looking ? thread.suffix(shownCount).first?.id : nil
        }
    }
    /// Home is the page showing and the app is not in the background, wrist up or down
    /// (`HomeView.attend`). An answer's notification arriving now is not shown: the answer is in front
    /// of the user, or is what the next raise shows. Not `looking`: the scene drops to `inactive` in the
    /// same second an answer lands while the user is still reading, so a wrist-up test, even with a grace
    /// window, misses exactly the case it exists for.
    var homeOpen = false
    /// Read on this watch, kept so the mark goes the moment it is read rather than at the next reload.
    @Published private var readHere: Set<String> = []
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
    /// Which press flow the launcher asked for (`Capture.Flow`): each watch-face complication has its own.
    private(set) var requestedFlow = Capture.Flow.standard
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
        /// The hub did not answer, so the fallback took it (`Hub.sendCommand`): its outcome is waited on
        /// there, and its reply is put into the thread here, since the hub's thread may be down with it.
        var fallback = false
        var running = false
        /// It failed and is kept only so Retry can send it again: not waited on, and its words are not
        /// shown as pending (the hub has already put them in the thread, or never had them).
        var failed = false
        /// Instructions for a rewind grab. The grab is uploaded (again, if it failed) before the
        /// command, and a command whose grab cannot be uploaded fails rather than going without it.
        var rewind: Grab?
    }
    private var commands: [Command] = [] {
        didSet {
            let live = commands.filter { !$0.failed }
            waiting = !live.isEmpty
            pending = live.compactMap(\.words)
            if !pending.isEmpty { landOn = nil }
            StayAwake.shared.refresh()
        }
    }
    private var tasks: [String: Task<Void, Never>] = [:]
    /// The grab the recording now running is instructions for (`startInstructions`).
    private var instructing: Grab?
    private var stream: Task<Void, Never>?
    private var loading = false
    private var reloadAfter = false

    private init() {
        PhoneLink.shared.onToken = { [weak self] in self?.tokenArrived() }
    }

    func requestRecording(_ flow: Capture.Flow = .standard) {
        requestedAt = Date()
        requestedFlow = flow
        recordRequested = true
    }

    /// A launcher's request is still worth acting on.
    var requestIsFresh: Bool { Date().timeIntervalSince(requestedAt) < Self.requestWindow }

    /// The page is on screen: load now, and follow the conversation and the tool calls of the hub
    /// command running until `deactivate`.
    @discardableResult func activate() -> Task<Void, Never> {
        let loaded = Task { await load() }
        if stream == nil { openStream() }
        return loaded
    }

    private func openStream() {
        stream = Task {
            // Frames that went by while the stream was down are gone, `done` among them, so whatever
            // tool lines are up describe a run that may have ended: drop them with the reload.
            await Hub.listen("/api/voice-stream", reconnected: { [weak self] in await self?.caughtUp() }) { [weak self] event, data in
                await self?.voiceFrame(event, data)
            }
        }
    }

    private func caughtUp() async {
        activity = []
        await load()
    }

    /// Also drops the tool lines. The page goes inactive about two seconds after a command is sent,
    /// so the run's `done` arrives while the stream is closed; kept, its tool calls sat UNDER the reply
    /// the next activation loaded, as if they had come after it.
    func deactivate() {
        stream?.cancel()
        stream = nil
        activity = []
        held = []
    }

    func load() async {
        #if targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-threaddemo") { demo(); return }
        #endif
        if loading { reloadAfter = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAfter = false
            do {
                thread = try await Hub.thread()
                hold()
                if failure == .noToken { failure = nil }
                Hub.log("thread", ["rows": thread.count, "last": String((thread.last?.text ?? "").prefix(80))])
            } catch HubError.noToken {
                failure = .noToken
            } catch {
                // Keep showing what was there; the next frame or activation reloads.
            }
        } while reloadAfter
    }

    #if targetEnvironment(simulator)
    private var demoStarted = false
    /// `-threaddemo` at launch: a made-up thread, then one command walked through it the way the hub
    /// delivers a real one (the user's words pending, tool calls, the reply loaded, the pending words dropped),
    /// so where each step lands can be watched in a simulator with no hub token.
    private func demo() {
        guard !demoStarted else { return }
        demoStarted = true
        let long = String(repeating: "This is a long line of reply text that wraps across the watch. ", count: 10)
        thread = (0..<4).flatMap { i in
            [Message(id: "u\(i)", role: "user", text: "Question number \(i) about something", request_id: nil, session_id: nil),
             Message(id: "a\(i)", role: "assistant", text: "Answer \(i). " + long, request_id: nil, session_id: nil,
                     needs_read: i == 1)]
        }
        Task {
            try? await Task.sleep(for: .seconds(4))
            pending = ["What does the next answer look like when it lands"]
            try? await Task.sleep(for: .seconds(2))
            activity = [ActivityLine(text: "get_lists", kind: .tool), ActivityLine(text: "Looking it up.", kind: .thought)]
            try? await Task.sleep(for: .seconds(3))
            activity = []
            thread += [Message(id: "u9", role: "user", text: pending[0], request_id: nil, session_id: nil),
                       Message(id: "a9", role: "assistant", text: "NEW REPLY FIRST LINE. " + long, request_id: nil, session_id: nil)]
            await Task.yield()
            pending = []
        }
    }
    #endif

    func startRecording(flow: Capture.Flow = .standard) {
        guard capture.free else {
            Hub.log("record-refused", ["view": "chat", "owner": String(describing: capture.owner)])
            return
        }
        Hub.log("record-start", ["view": "chat", "running": commands.count, "flow": flow.rawValue])
        failure = nil
        // A command ends itself at the silence after the user speaks, or at the next press. A session's follow-up records the same way (Sessions.startRecording).
        capture.start(for: .hub, flow: flow, onSilence: { [weak self] in self?.stopRecording() }) { [weak self] error in
            self?.failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Records the user's instructions for the rewind grab on screen: locked like a session follow-up (red, only
    /// a press ends it), and sent as a command carrying the grab, which the hub hands the orchestrator
    /// together with the user's words (docs/REWIND.md).
    func startInstructions(for grab: Grab?) {
        guard let grab else {
            Hub.log("record-refused", ["view": "rewind", "why": "no-grab"])
            WKInterfaceDevice.current().play(.failure)
            return
        }
        guard capture.free else {
            Hub.log("record-refused", ["view": "rewind", "owner": String(describing: capture.owner)])
            return
        }
        Hub.log("record-start", ["view": "rewind", "running": commands.count])
        failure = nil
        instructing = grab
        capture.start(for: .hub, flow: .locked) { [weak self] error in
            self?.instructing = nil
            self?.failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and sends it. The wrist is tapped at the moment the microphone closes —
    /// which the silence may have decided, so it is the one moment nothing else reports.
    func stopRecording() {
        guard capture.owner == .hub, let finished = capture.stop() else { return }
        WKInterfaceDevice.current().play(.stop)
        Hub.log("record-stop", ["view": "chat", "seconds": finished.duration, "heard": finished.heard, "peak": finished.peak,
                                   "chirped": finished.chirped.map { $0 as Any } ?? NSNull()])
        var command = Command(clip: finished)
        command.rewind = instructing
        instructing = nil
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

    /// Rewind, engaged or dropped (the Buffer control): the last stretch of audio kept in memory for a grab.
    func toggleRewind() {
        failure = nil
        capture.toggleRewind { [weak self] error in
            self?.failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and throws it away.
    func cancelRecording() {
        if capture.owner == .hub {
            Hub.log("record-cancel", ["view": "chat"])
            capture.cancel()
            instructing = nil
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

    private func hold() {
        let tail = Set(thread.suffix(shownCount).map(\.id))
        let asks = Set(unread.compactMap(\.request_id))
        for m in thread.dropLast(shownCount) where !held.contains(where: { $0.id == m.id })
            && (unread.contains(m) || m.request_id.map(asks.contains) == true) {
            held.append(m)
        }
        held.removeAll { tail.contains($0.id) }
    }

    /// An answer has been read: on screen with the wrist up long enough, or its notification swiped
    /// away.
    func markRead(_ id: String) {
        guard !readHere.contains(id) else { return }
        readHere.insert(id)
        Hub.log("read", ["id": id])
        Task {
            do { try await Hub.read(id) } catch { Hub.log("read-failed", ["id": id, "error": "\(error)"]) }
        }
    }

    /// Home lands on this answer instead of the newest row, until the next command the user speaks.
    func land(on id: String) {
        landOn = id
        landings += 1
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
                var fallback = command.fallback
                if requestId == nil {
                    guard let clip = command.clip else { finish(msgId); return }
                    let began = Date()
                    // A grab's instructions go nowhere without the grab: this throws when it cannot be
                    // uploaded, and the command fails into Retry.
                    let rewind = try await command.rewind?.upload()
                    let sent = try await Awake.hold("sending a voice command") {
                        try await Hub.sendCommand(clip, msgId: msgId, rewind: rewind)
                    }
                    let heard = sent.heard
                    fallback = sent.fallback
                    Hub.log("sent", ["ms": Int(Date().timeIntervalSince(began) * 1000), "fallback": fallback,
                                     "rewind": rewind ?? "",
                                     "id": heard.id ?? "", "words": (heard.transcript ?? "").count])
                    guard let id = heard.id else {
                        // The hub heard no words, so there is no command.
                        Hub.log("heard-nothing", ["view": "chat"])
                        finish(msgId)
                        WKInterfaceDevice.current().play(.failure)
                        return
                    }
                    requestId = id
                    update(msgId) { $0.requestId = id; $0.words = heard.transcript; $0.fallback = fallback }
                }
                let outcome = fallback ? try await Hub.fallbackOutcome(requestId!) : try await Hub.outcome(requestId!)
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
                    // The reply IS the end of the run, whether or not its `done` frame got here.
                    activity = []
                    await load()
                    // A fallback reply is shown from its outcome when the thread did not bring it: the
                    // hub that serves the thread is the thing that did not answer.
                    if fallback, let id = requestId, !thread.contains(where: { $0.request_id == id }) {
                        let words = commands.first(where: { $0.msgId == msgId })?.words
                        thread += [Message(id: id + ":user", role: "user", text: words, request_id: id, session_id: nil),
                                   Message(id: id + ":reply", role: "assistant", text: outcome.result, request_id: id, session_id: nil)]
                    }
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
