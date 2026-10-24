import Foundation
import WatchKit

/// A row of `/api/sessions`. The hub sends running sessions and parked ones as two lists, each most
/// recently active first; running then parked is the order every surface draws, and `n` is the number
/// "session three" means.
struct SessionRow: Decodable, Identifiable, Equatable {
    let id: String
    let label: String?
    let custom_title: String?
    let repo: String?
    let status: String?
    let working: Bool?
    let claude_session_id: String?
    /// The start of what it last said (its prompt until it has replied), whitespace collapsed and cut
    /// to 120 characters by the hub.
    let say: String?
    /// A finished reply nobody has opened. The hub decides it (`reply_at` against `seen_at`) so every
    /// surface agrees; tool calls and thoughts do not set it, so it marks an answer and nothing else.
    let unread: Bool?
    /// The number he says out loud, which is also the row's position: most recently active first,
    /// running and parked together.
    let n: Int?
    /// When it last did something — its last prompt or reply, the instant the list is ordered by.
    let at: String?

    var name: String { sessionName(custom_title, label, repo) ?? id }
    var running: Bool { status == "resident" }
    /// `at` as the phone's sessions list writes it: now / 12m / 3h / 2d.
    var ago: String? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let at, let t = iso.date(from: at) else { return nil }
        let s = Date().timeIntervalSince(t)
        if s < 90 { return "now" }
        if s < 3600 { return "\(Int((s / 60).rounded()))m" }
        if s < 86400 { return "\(Int((s / 3600).rounded()))h" }
        return "\(Int((s / 86400).rounded()))d"
    }
    /// The conversation this row is a stretch of. A resume makes a new row for the same conversation
    /// (`claude --resume` keeps its id), so everything the page keeps about a session is keyed by this.
    var key: String { claude_session_id ?? id }
}

/// Work sent to a machine with no room for it yet (`desk_queue`): the Pi holds a new session until a
/// slot and enough memory are free. Nothing to open until it launches, but it is the work he just
/// asked for, so the list shows it.
struct QueuedRow: Decodable, Identifiable, Equatable {
    let id: String
    let repo: String?
    let label: String?
    let prompt: String?

    var name: String { sessionName(label, repo) ?? "Session" }
}

/// **One event of a conversation's list**, as the hub keeps it (server.js, the event log): his words
/// (`prompt`), a tool call, what the session says between tool calls (`text`), or its reply. `seq` is
/// its position in the conversation, given by the hub; `id` its identity. A prompt queued behind a
/// running turn and later read by the model is one event at two moments, same id, the second marked
/// `seen`; a prompt this watch sent carries the message's own id as `cmd`.
struct SessionEvent: Decodable, Equatable {
    let seq: Int
    let id: String
    let kind: String
    let text: String
    let seen: Bool?
    let cmd: String?
    let at: String?
}

/// A conversation's list, and the hub epoch it was numbered in: a hub that restarts numbers from one
/// again, and a list from before it is stale the moment a frame says so.
struct ConversationLog: Equatable {
    var epoch: String?
    var events: [SessionEvent] = []
    var last: Int { events.last?.seq ?? 0 }
}

/// His words sent from this watch that the hub does not have yet: shown the instant they are
/// transcribed, and replaced by the event that carries the same id back (`cmd`).
struct Placeholder: Equatable {
    let msgId: String
    let text: String
}

/// The name a session goes by everywhere: the one Jared gave it, else the router's label, else its repo.
private func sessionName(_ names: String?...) -> String? {
    names.compactMap { $0 }.first { !$0.isEmpty }
}

/// The sessions page's state: the list, and per conversation ONE THING — the hub's list of events —
/// plus what this watch itself is doing to it (words being sent, a wait for their reply).
///
/// **The whole rule for the list is in `frame`**: the next seq is appended, a gap is fetched from the
/// hub, an old seq is ignored. Nothing here reconstructs what happened from text or timing; the phone
/// keeps the same list by the same rule (`cards/repos.js`).
@MainActor
final class Sessions: ObservableObject {
    /// One per app, so a tapped notification can open a session (WatchAppDelegate).
    static let shared = Sessions()

    enum Failure: Equatable {
        case micDenied
        case message(String)
    }

    /// The sessions page's navigation: empty is the list, one key is that conversation open. It is the
    /// sessions PAGE's, not the app's: an open session stays open while he swipes to another page and
    /// back.
    @Published var path: [String] = []
    /// The sessions page is the one on screen (`RootView.follow`).
    @Published var onPage = false

    /// **Where a command goes**: the session a recording belongs to while it runs, wherever he has
    /// swiped since, so the press that ends it ends it; otherwise the session open on the sessions page
    /// while that page is showing. Nil is the hub. A session left open on the sessions page does not
    /// take the commands made on home.
    var target: String? {
        if case .session(let key)? = capture.owner { return key }
        return onPage ? path.last : nil
    }

    private init() {}

    /// A session's reply notification, opened: shows that conversation on the sessions page. The row
    /// named may be one the list has not loaded yet — a resumed session's new row.
    func open(rowId: String) async {
        await load()
        let key = rows.first { $0.id == rowId }?.key ?? rowId
        path = [key]
        markSeen(key)
        // Fetched here, not left to the view: when this conversation is already the one on screen the
        // view does not appear again, and an app that was in the background missed the stream.
        await loadLog(key)
    }

    /// One row per conversation: its running row if it has one, else its newest parked one.
    @Published private(set) var list: [SessionRow] = []
    /// Sessions waiting for a machine to have room, oldest first.
    @Published private(set) var queued: [QueuedRow] = []
    /// The focused session — where a spoken follow-up goes — and whether he pinned it there.
    @Published private(set) var focus: String?
    @Published private(set) var pinned = false
    /// Each OPENED conversation's list. A conversation nobody has opened is not fetched: its frames
    /// only keep `latest` for the list's row.
    @Published private(set) var logs: [String: ConversationLog] = [:]
    /// The newest event of every conversation the stream has mentioned, for the list's live line.
    @Published private(set) var latest: [String: SessionEvent] = [:]
    /// His words on their way from this watch, per conversation.
    @Published private(set) var placeholders: [String: [Placeholder]] = [:]
    /// Conversations with a clip being transcribed or words being handed over right now.
    @Published private(set) var busy: Set<String> = []
    /// **Commands can overlap.** Each recording is its own `Outgoing`, sent on its own; one still being
    /// transcribed, or waiting on a session still working on the one before, blocks nothing. Kept until
    /// its words are in the session, which is what a retry resends.
    private struct Outgoing { let msgId: String; var clip: Recorder.Clip?; var words: String? }
    private var outgoing: [String: [Outgoing]] = [:]
    private var inFlight: [String: Int] = [:] {
        didSet { busy = Set(inFlight.filter { $0.value > 0 }.keys) }
    }
    /// Follow-ups this watch sent, by conversation, whose reply has not come — their message ids. The
    /// edge sweeps while any is here. Answered when a reply lands after every one of them has been
    /// read (`settle`): a reply to an EARLIER command, or one that came before the words went in, is
    /// not the answer he is waiting on.
    @Published private(set) var awaiting: [String: Set<String>] = [:]
    /// When each awaited follow-up was handed over, so one the list no longer reaches can be let go.
    private var sentAt: [String: Date] = [:]
    /// A follow-up shows in the list within seconds of being typed (as `queued`, then `said`). One still
    /// absent after this long is older than the list: the hub keeps a conversation's last SESSION_TURNS
    /// turns, so after a hub restart a message from fifteen turns ago is simply not in it — and waiting
    /// for it would sweep the edge until the app was killed.
    private static let notInList: TimeInterval = 120
    @Published private(set) var failures: [String: Failure] = [:]

    private let capture = Capture.shared
    /// Every row the hub sent, so a conversation's words go to the row running it.
    private var rows: [SessionRow] = []
    private var stream: Task<Void, Never>?
    /// The in-flight `load()`, if one is running: a second caller awaits THIS rather than returning at
    /// once, so `await load()` keeps its promise that `rows`/`list` are current once it returns.
    private var loadTask: Task<Void, Never>?
    private var reloadAfter = false

    /// The page is on screen: load now, and follow every conversation's events until `deactivate`.
    @discardableResult func activate() -> Task<Void, Never> {
        // The conversation on screen too, and any the watch is waiting on: whatever went by while the
        // app was away is in the hub's list, not here.
        let loaded = Task {
            await load()
            for key in Set(path.suffix(1) + Array(awaiting.keys)) { await loadLog(key) }
            // Swiping back to a session left open is reading whatever landed in it meanwhile.
            if let key = path.last, row(for: key)?.unread == true { markSeen(key) }
        }
        if stream == nil {
            stream = Task {
                await Hub.listen("/api/session-stream", reconnected: { [weak self] in await self?.reloadAll() }) { [weak self] event, data in
                    await self?.frame(event, data)
                }
            }
        }
        return loaded
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
    }

    func load() async {
        if let t = loadTask {
            // Ask it to go around again rather than trust the pass already under way, which may have
            // read before whatever prompted this call, then wait on the SAME task everyone else is.
            reloadAfter = true
            return await t.value
        }
        let t = Task { await self.fetchSessions() }
        loadTask = t
        await t.value
        loadTask = nil
    }

    /// The hub's session payload: `/api/sessions`, or a `sessions` frame on the stream, which carries
    /// the same thing whenever a session starts, ends or queues.
    private struct Lists: Decodable {
        let resident: [SessionRow]
        let evicted: [SessionRow]
        let queued: [QueuedRow]?
        let focus: String?
        let pinned: Bool?
    }

    private func fetchSessions() async {
        repeat {
            reloadAfter = false
            if let l: Lists = try? await Hub.json("/api/sessions?brief=1") { apply(l) }
        } while reloadAfter
    }

    private func apply(_ l: Lists) {
        rows = l.resident + l.evicted
        var seen = Set<String>()
        list = rows.filter { seen.insert($0.key).inserted }
            .sorted { ($0.n ?? .max) < ($1.n ?? .max) }
        queued = l.queued ?? []
        focus = l.focus
        pinned = l.pinned ?? false
    }

    /// The row a conversation's words go to: its running row, else its newest parked one.
    func row(for key: String) -> SessionRow? {
        rows.first { $0.key == key && $0.running } ?? rows.first { $0.key == key }
    }

    /// Opening a session is reading it: the mark clears on every surface, not just this one, because
    /// the phone and the wall are looking at the same list. Sent whatever the watch's own copy of the
    /// row says (that copy can predate the reply), and the list reloaded after, since the hub announces
    /// the change to the walls' stream and not to this one.
    func markSeen(_ key: String) {
        guard let r = row(for: key) else { return }
        Task {
            do {
                try await Hub.seen(r.id)
                await load()
            } catch {
                Hub.log("seen-failed", ["row": r.id, "error": String(describing: error).prefix(120).description])
            }
        }
    }

    /// The conversation's list from the hub — the whole of it, or with `since` only what comes after
    /// that seq, which is what a gap in the stream asks for. Merged by seq (`take`), so a fetch and a
    /// frame that arrived while it was in flight cannot disagree, whichever lands first.
    func loadLog(_ key: String, since: Int? = nil) async {
        guard let r = row(for: key) else { return }
        struct Page: Decodable { let epoch: String?; let events: [SessionEvent]? }
        let path = since.map { "/api/sessions/\(Hub.pathComponent(r.id))/events?since=\($0)" }
            ?? "/api/sessions/\(Hub.pathComponent(r.id))"
        guard let p: Page = try? await Hub.json(path) else { return }
        take(key, p.events ?? [], epoch: p.epoch)
        Hub.log("log", ["row": r.id, "since": since ?? 0, "got": p.events?.count ?? 0, "last": logs[key]?.last ?? 0])
    }

    private func reloadAll() async {
        await load()
        for key in logs.keys { await loadLog(key) }
    }

    /// Events into a conversation's list, by seq. An epoch that is not the one held is a hub that
    /// restarted and numbered from one again: what was held is dropped first. An event carrying a
    /// message id this watch sent replaces that message's placeholder.
    private func take(_ key: String, _ events: [SessionEvent], epoch: String?) {
        var log = logs[key] ?? ConversationLog()
        if let epoch, let mine = log.epoch, epoch != mine { log.events = [] }
        if let epoch { log.epoch = epoch }
        var by = [Int: SessionEvent]()
        for e in log.events { by[e.seq] = e }
        for e in events { by[e.seq] = e }
        log.events = by.values.sorted { $0.seq < $1.seq }
        logs[key] = log
        if let last = log.events.last { latest[key] = last }
        let cmds = Set(events.compactMap(\.cmd))
        if !cmds.isEmpty { placeholders[key] = placeholders[key]?.filter { !cmds.contains($0.msgId) } }
        settle(key)
    }

    /// The wait ends when a reply lands after every follow-up he is waiting on has been read.
    private func settle(_ key: String) {
        guard var waiting = awaiting[key], !waiting.isEmpty, let events = logs[key]?.events else { return }
        let gone = waiting.filter { id in
            !events.contains { $0.cmd == id } && Date().timeIntervalSince(sentAt[id] ?? .distantPast) > Self.notInList
        }
        if !gone.isEmpty {
            waiting.subtract(gone)
            gone.forEach { sentAt[$0] = nil }
            awaiting[key] = waiting.isEmpty ? nil : waiting
            Hub.log("await-dropped", ["row": row(for: key)?.id ?? key, "count": gone.count])
            if waiting.isEmpty { return }
        }
        guard let reply = events.last(where: { $0.kind == "reply" }) else { return }
        let answered = waiting.allSatisfy { id in
            events.contains { $0.kind == "prompt" && $0.cmd == id && $0.seen != false && $0.seq < reply.seq }
        }
        guard answered else { return }
        waiting.forEach { sentAt[$0] = nil }
        awaiting[key] = nil
        Hub.log("answered", ["row": row(for: key)?.id ?? key])
        // The wrist is told when a follow-up the WATCH sent is answered. Only these: a session answering
        // something typed on the Mac is not something he asked the watch about.
        WKInterfaceDevice.current().play(.notification)
    }

    func startRecording(_ key: String) {
        guard capture.free, row(for: key) != nil else {
            // Each of these used to return in silence, which from the wrist is a record tap doing nothing.
            Hub.log("record-refused", ["view": "session", "owner": String(describing: capture.owner),
                                       "row": row(for: key)?.id ?? "none"])
            return
        }
        failures[key] = nil
        Hub.log("record-start", ["view": "session", "row": row(for: key)?.id ?? ""])
        // Locked open: a follow-up is sent by his next press, never by a pause.
        capture.start(for: .session(key), flow: .locked, onSilence: { [weak self] in self?.stopRecording(key) },
                      onTaken: { [weak self] in self?.stopRecording(key) }) { [weak self] error in
            Hub.log("record-failed", ["error": String(describing: error).prefix(120).description])
            self?.failures[key] = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and sends it into the session, alongside anything still on its way.
    func stopRecording(_ key: String) {
        guard capture.owner == .session(key), let clip = capture.stop() else { return }
        // The wrist is told the moment the microphone closes, as on home: the silence may have decided
        // it, and nothing else says so.
        WKInterfaceDevice.current().play(.stop)
        Hub.log("record-stop", ["view": "session", "seconds": clip.duration, "heard": clip.heard, "peak": clip.peak,
                                   "chirped": clip.chirped.map { $0 as Any } ?? NSNull()])
        let item = Outgoing(msgId: UUID().uuidString, clip: clip, words: nil)
        outgoing[key, default: []].append(item)
        send(key, item.msgId)
    }

    /// Ends the recording and throws it away.
    func cancelRecording(_ key: String) {
        if capture.owner == .session(key) {
            Hub.log("record-cancel", ["view": "session"])
            capture.cancel()
        }
    }

    /// Sends again whatever has not reached the session.
    func retry(_ key: String) {
        failures[key] = nil
        for item in outgoing[key] ?? [] { send(key, item.msgId) }
    }

    /// The hub transcribes the clip without enqueueing anything (`?dry=1`), then hands the words to the
    /// session: typed in if it is running, resumed with them if it is parked — the hub decides. Once the
    /// words are known, a retry only resends them. The msgId makes a resend unable to type them twice,
    /// and it is what the event for these words carries back (`cmd`), so the placeholder shown the
    /// moment they are transcribed is replaced by id.
    private func send(_ key: String, _ msgId: String) {
        guard var item = outgoing[key]?.first(where: { $0.msgId == msgId }) else { return }
        inFlight[key, default: 0] += 1
        Task {
            defer { inFlight[key, default: 1] -= 1 }
            do {
                if item.words == nil {
                    guard let clip = item.clip else { return }
                    Hub.log("upload", ["view": "session", "seconds": clip.duration])
                    let heard = try await Hub.sendAudio(clip, msgId: msgId, dry: true)
                    try? FileManager.default.removeItem(at: clip.url)
                    guard let text = heard.transcript, !text.isEmpty else {
                        Hub.log("heard-nothing", ["view": "session"])
                        drop(key, msgId)
                        WKInterfaceDevice.current().play(.failure)
                        return
                    }
                    item.words = text
                    item.clip = nil
                    update(key, item)
                    Hub.log("heard", ["view": "session", "words": text.count])
                    // His words on screen the instant they are transcribed, before the hub has them.
                    placeholders[key, default: []].append(Placeholder(msgId: msgId, text: text))
                }
                let words = item.words ?? ""
                let rowId = row(for: key)?.id ?? key
                let ignored = try await Hub.followUp(rowId, text: words, msgId: msgId)
                Hub.log("followup-sent", ["row": rowId, "words": item.words?.count ?? 0, "ignored": ignored])
                drop(key, msgId)
                // The hub taking nothing (a thank-you-shaped transcription) sends nothing to the
                // session: no event will come for it, and nothing is waited on.
                if ignored {
                    placeholders[key] = placeholders[key]?.filter { $0.msgId != msgId }
                    return
                }
                awaiting[key, default: []].insert(msgId)
                sentAt[msgId] = Date()
            } catch {
                Hub.log("send-failed", ["view": "session", "error": String(describing: error).prefix(120).description])
                failures[key] = .message(error.localizedDescription)
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }

    private func update(_ key: String, _ item: Outgoing) {
        guard let i = outgoing[key]?.firstIndex(where: { $0.msgId == item.msgId }) else { return }
        outgoing[key]?[i] = item
    }

    private func drop(_ key: String, _ msgId: String) {
        outgoing[key]?.removeAll { $0.msgId == msgId }
    }

    /// One `ev` frame: an event of some conversation, with its seq. **The whole rule**: the next seq is
    /// appended; a gap means the hub has what went by, and it is fetched from the last seq held; an
    /// old seq is a duplicate delivery and is ignored. A conversation not opened here only keeps its
    /// newest event, for the list's row.
    private func frame(_ event: String, _ data: String) async {
        if event == "sessions" {
            if let l = try? JSONDecoder().decode(Lists.self, from: Data(data.utf8)) { apply(l) }
            return
        }
        struct Frame: Decodable { let conversation: String; let session: String?; let epoch: String?; let ev: SessionEvent }
        guard event == "ev", let f = try? JSONDecoder().decode(Frame.self, from: Data(data.utf8)) else { return }
        let key = f.conversation
        latest[key] = f.ev
        // Every frame for the conversation on screen, so the hub's log shows whether the stream reaches
        // the wrist live or arrives late in a lump.
        if key == path.last {
            Hub.log("frame", ["row": f.session ?? "", "seq": f.ev.seq, "kind": f.ev.kind, "text": String(f.ev.text.prefix(50))])
        }
        guard let log = logs[key] else { return }
        if let epoch = f.epoch, let mine = log.epoch, epoch != mine { await loadLog(key); return }
        let seq = f.ev.seq
        if seq <= log.last { return }
        if seq > log.last + 1 { Task { await loadLog(key, since: log.last) } }
        take(key, [f.ev], epoch: f.epoch)
        if f.ev.kind == "reply" {
            // The list's `say` and `unread` follow the row, which the host writes on its own path.
            await load()
            // A reply landing on the session he is looking at is read as it lands.
            if onPage && path.last == key { markSeen(key) }
        }
    }
}
