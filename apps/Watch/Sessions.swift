import Foundation
import WatchKit

/// A row of `/api/sessions`. The hub sends running sessions and parked ones as two lists, each most
/// recently active first; running then parked is the order every surface draws, and `n` is the number
/// "session three" means.
struct SessionRow: Decodable, Identifiable, Equatable {
    let id: String
    let n: Int?
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

    var name: String { sessionName(custom_title, label, repo) ?? id }
    var running: Bool { status == "resident" }
    /// The conversation this row is a stretch of. A resume makes a new row for the same conversation
    /// (`claude --resume` keeps its id), so everything the page keeps about a session is keyed by this.
    var key: String { claude_session_id ?? id }
}

/// One exchange of a session: what he asked, and what came back. A turn with no prompt is a reply the
/// session produced on its own — a watcher firing, a job reporting — and those belong to the prompt
/// above them.
struct SessionTurn: Decodable, Equatable {
    let at: String?
    let prompt: String?
    let reply: String?
}

/// `/api/sessions/:id`: one session with its last prompt, the whole reply to it, and the turns behind
/// them.
struct SessionDetail: Decodable, Equatable {
    let id: String
    let label: String?
    let custom_title: String?
    let repo: String?
    let status: String?
    let working: Bool?
    let claude_session_id: String?
    let last_prompt: String?
    let last_reply: String?
    /// When `last_reply` was said. What tells the watch a reply came AFTER words it sent.
    let reply_at: String?
    let turns: [SessionTurn]?
    /// The turn in flight so far (tool calls, what it says between them, his words), while it runs: the
    /// steps the stream carried before this view was listening.
    struct Step: Decodable, Equatable { let state: String; let text: String }
    let steps: [Step]?

    var name: String { sessionName(custom_title, label, repo) ?? id }

    /// What the page shows: the last few exchanges, oldest first. A turn with no prompt is a reply the
    /// session produced on its own, so it belongs under the prompt above it rather than starting a
    /// block of its own. Further back than this is context he can ask the session for, and a wrist is
    /// not where it would be read.
    static let exchanges = 5

    var recent: [SessionTurn] {
        guard let turns, !turns.isEmpty else {
            let fallback = SessionTurn(at: nil, prompt: last_prompt, reply: last_reply)
            return (last_prompt ?? last_reply) == nil ? [] : [fallback]
        }
        // Count back `exchanges` PROMPTS, keeping the unprompted replies that follow each of them.
        var prompts = 0
        var start = turns.startIndex
        for i in turns.indices.reversed() where !(turns[i].prompt ?? "").isEmpty {
            prompts += 1
            start = i
            if prompts == Self.exchanges { break }
        }
        return Array(turns[start...])
    }
}

/// The name a session goes by everywhere: the one Jared gave it, else the router's label, else its repo.
private func sessionName(_ names: String?...) -> String? {
    names.compactMap { $0 }.first { !$0.isEmpty }
}

/// The sessions page's state, per conversation: the list, each open one's last prompt and reply, the
/// tool calls it is making, and a reply of his being recorded or sent into it.
@MainActor
final class Sessions: ObservableObject {
    /// One per app, so a tapped notification can open a session (WatchAppDelegate).
    static let shared = Sessions()

    enum Failure: Equatable {
        case micDenied
        case message(String)
    }

    /// The sessions page's navigation: empty is the list, one key is that conversation open.
    @Published var path: [String] = []

    private init() {}

    /// A session's reply notification, opened: shows that conversation on the sessions page. The row
    /// named may be one the list has not loaded yet — a resumed session's new row.
    func open(rowId: String) async {
        await load()
        let key = rows.first { $0.id == rowId }?.key ?? rowId
        path = [key]
        markSeen(key)
        // Asked here, not left to the view: when this conversation is already the one on screen the view
        // does not appear again, and an app that was in the background missed the stream's `done`, so
        // nothing else would fetch the reply the notification is about.
        await loadDetail(key)
    }

    /// One row per conversation: its running row if it has one, else its newest parked one.
    @Published private(set) var list: [SessionRow] = []
    /// The focused session — where a spoken follow-up goes — and whether he pinned it there.
    @Published private(set) var focus: String?
    @Published private(set) var pinned = false
    @Published private(set) var details: [String: SessionDetail] = [:]
    /// Each conversation's tool calls since its last reply, and what it said between them, as its
    /// machine reports them. Live only: the hub does not store them.
    @Published private(set) var activity: [String: [ActivityLine]] = [:]
    /// His words for a conversation that the session has not answered yet, oldest first. What is DRAWN
    /// is the activity list, where each is a `.said` line in the order he spoke it among the tool calls;
    /// this is what the session's echo of them is matched against, so they are not drawn twice.
    private var sent: [String: [String]] = [:]
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
    /// A follow-up the watch handed over, by conversation, with when the hub took it, until a reply
    /// lands after that. The edge keeps sweeping through the whole of it: handing the words over is
    /// seconds, the session working on them is the real wait.
    ///
    /// **The answer is the first reply AFTER the words, not a turn that begins with them.** Words sent to
    /// a session in the middle of a turn are folded into that turn rather than starting one, so no turn
    /// ever carries them as its prompt, and a match on the prompt kept the edge sweeping after the
    /// session had long finished.
    @Published private(set) var awaiting: [String: Date] = [:]
    /// **Replies owed out loud**, by conversation, with when the words were sent (seconds since 1970).
    /// A follow-up sent from the watch with speech on owes its reply spoken, and it is spoken when that
    /// session is ON SCREEN with a reply newer than the words — the moment it lands if he is looking,
    /// else whenever he next opens it (the reply notification, the list, or raising the wrist on it).
    /// Once, then it is paid. Kept across launches, since the app is often closed by the time it comes.
    private var owed: [String: Double] = UserDefaults.standard.dictionary(forKey: "owed_speech") as? [String: Double] ?? [:] {
        didSet { UserDefaults.standard.set(owed, forKey: "owed_speech") }
    }
    @Published private(set) var failures: [String: Failure] = [:]

    private let capture = Capture.shared
    /// Every row the hub sent, so a stream frame (which names a row) can be matched to its conversation.
    private var rows: [SessionRow] = []
    private var stream: Task<Void, Never>?
    private var loading = false
    private var reloadAfter = false

    /// The page is on screen: load now, and follow every session's activity until `deactivate`.
    func activate() {
        // The conversation on screen too, and any the watch is waiting on: a turn that finished while
        // the app was away sent its `done` to a stream that was not listening.
        Task {
            await load()
            for key in Set(path.suffix(1) + Array(awaiting.keys)) { await loadDetail(key) }
        }
        guard stream == nil else { return }
        stream = Task {
            await Hub.listen("/api/session-stream", reconnected: { [weak self] in await self?.reloadAll() }) { [weak self] event, data in
                await self?.sessionFrame(event, data)
            }
        }
    }

    func deactivate() {
        stream?.cancel()
        stream = nil
    }

    func load() async {
        struct Lists: Decodable {
            let resident: [SessionRow]
            let evicted: [SessionRow]
            let focus: String?
            let pinned: Bool?
        }
        if loading { reloadAfter = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAfter = false
            if let l: Lists = try? await Hub.json("/api/sessions") {
                rows = l.resident + l.evicted
                var seen = Set<String>()
                list = rows.filter { seen.insert($0.key).inserted }
                focus = l.focus
                pinned = l.pinned ?? false
            }
        } while reloadAfter
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

    /// `resync` is true only right after the stream reconnects (`reloadAll`): the socket was down for
    /// some stretch, and whatever the hub kept of the turn (`steps`, the same record a cold open seeds
    /// from) is what actually happened during the gap, replacing local activity rather than only
    /// filling it when it was empty. Without this a turn that kept working through a drop showed
    /// exactly what had streamed in before the drop and nothing since — a live tool-call count with a
    /// stale one, both looking equally current, since the page never says the stream is behind.
    func loadDetail(_ key: String, resync: Bool = false) async {
        guard let r = row(for: key) else { return }
        if let d: SessionDetail = try? await Hub.json("/api/sessions/" + Hub.pathComponent(r.id)) {
            details[key] = d
            if d.working == true {
                if let steps = d.steps, !steps.isEmpty, resync || (activity[key] ?? []).isEmpty {
                    activity[key] = steps.compactMap { line($0.state, $0.text, key) }
                }
            } else if resync {
                // The turn ended during the gap; nothing further is coming for it.
                activity[key] = nil
            }
            // Everything the watch sent is answered: the wait is over, however the news arrived.
            if let since = awaiting[key], Self.finished(d, since) {
                awaiting[key] = nil
                sent[key] = nil
                Hub.log("answered", ["row": r.id])
            }
            speakIfOwed(key)
            Hub.log("detail", ["row": r.id, "prompt": String((d.last_prompt ?? "").prefix(60)),
                               "reply": String((d.last_reply ?? "").prefix(80)), "replyChars": d.last_reply?.count ?? 0])
        }
    }

    /// The instruction that rides with every follow-up while replies are spoken (`Speaker`). It changes how the
    /// reply is WRITTEN, which is the whole reason this is a mode and not a speaker switch — the watch
    /// cannot turn a table into something worth hearing after the fact. Format only: the detail he
    /// asked for still belongs in the answer.
    static let spokenFormat = "\n\n[This reply is read aloud. Plain spoken words only — never any "
        + "markdown, tables, code, lists, bullets, paths, URLs or symbols; speak the substance of those "
        + "instead. Say everything you would otherwise say: this is about the form, not the length.]"

    func startRecording(_ key: String) {
        guard capture.free, row(for: key) != nil else {
            // Each of these used to return in silence, which from the wrist is a record tap doing nothing.
            Hub.log("record-refused", ["view": "session", "owner": String(describing: capture.owner),
                                       "row": row(for: key)?.id ?? "none"])
            return
        }
        failures[key] = nil
        Hub.log("record-start", ["view": "session", "row": row(for: key)?.id ?? ""])
        // Ends itself at the silence after he speaks, as a command on home does; a press locks it open.
        capture.start(for: .session(key), onSilence: { [weak self] in self?.stopRecording(key) },
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

    private func reloadAll() async {
        await load()
        for key in details.keys { await loadDetail(key, resync: true) }
    }

    /// The hub transcribes the clip without enqueueing anything (`?dry=1`), then hands the words to the
    /// session: typed in if it is running, resumed with them if it is parked — the hub decides. Once the
    /// words are known, a retry only resends them. The msgId makes a resend unable to type them twice.
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
                    // His words join the turn's lines where he said them, and the page lands on them.
                    sent[key, default: []].append(text)
                    activity[key, default: []].append(ActivityLine(text: text, kind: .said))
                }
                // The directive travels with the command rather than being set on the session once:
                // a session that restarts forgets a mode, and cannot forget what is in the prompt.
                let words = (item.words ?? "") + (Speaker.enabled ? Self.spokenFormat : "")
                let rowId = row(for: key)?.id ?? key
                try await Hub.followUp(rowId, text: words, msgId: msgId)
                Hub.log("followup-sent", ["row": rowId, "words": item.words?.count ?? 0])
                drop(key, msgId)
                // The wait and the spoken reply follow the NEWEST command: whatever was answered before
                // it is not what he is waiting on now.
                let now = Date()
                awaiting[key] = now
                if Speaker.enabled { owed[key] = now.timeIntervalSince1970 }
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

    /// The conversation a stream frame's row belongs to. A row the list has not seen yet — a session
    /// a resume just opened — is looked up after reloading it.
    private func key(forRow id: String) async -> String {
        if let r = rows.first(where: { $0.id == id }) { return r.key }
        await load()
        return rows.first(where: { $0.id == id })?.key ?? id
    }

    private func sessionFrame(_ event: String, _ data: String) async {
        struct Frame: Decodable { let session: String; let state: String?; let text: String? }
        guard event == "session", let f = try? JSONDecoder().decode(Frame.self, from: Data(data.utf8)) else { return }
        let key = await key(forRow: f.session)
        // Every frame for the conversation on screen, so the hub's log shows whether the stream reaches
        // the wrist live or arrives late in a lump.
        if key == path.last {
            Hub.log("frame", ["row": f.session, "state": f.state ?? "", "text": String((f.text ?? "").prefix(50))])
        }
        guard f.state == "done" else {
            guard let text = f.text, let l = line(f.state ?? "tool", text, key) else { return }
            // "queued" and "said" are the same message at two points in its life — taken in while a
            // turn was still running, then actually started — and the hub sends both with the same
            // text. Without this, a message that arrived queued showed on the wrist a second time the
            // moment it started: two identical lines for the one thing he said.
            if l.kind == .said, activity[key]?.contains(where: { $0.kind == .said && $0.text == l.text }) == true {
                return
            }
            activity[key, default: []].append(l)
            return
        }
        // A turn ended. It is the ANSWER only if the session is now idle with a reply after the newest
        // words the watch sent (`finished`): with commands overlapping, a turn can end while the next
        // one is already running, and that is not the answer he is waiting on.
        let waiting = awaiting[key] != nil
        await load()
        if details[key] != nil || owed[key] != nil || waiting { await loadDetail(key) }
        let answered = waiting && awaiting[key] == nil
        // Only now that the reply is in hand do the tool calls go. Cleared first, the page's newest item
        // would be the PREVIOUS reply for the moment the fetch takes, and a view following the newest
        // item would jump up to it and back down. Words he sent that are still being worked on stay.
        if answered || !waiting {
            activity[key] = nil
        } else {
            activity[key] = activity[key]?.filter { $0.kind == .said }
        }
        // The wrist is told when a follow-up the WATCH sent is answered. Only these: a session answering
        // something typed on the Mac is not something he asked the watch about.
        if answered { WKInterfaceDevice.current().play(.notification) }
        // A reply landing on the session he is looking at is read as it lands.
        if path.last == key { markSeen(key) }
    }

    /// One step of a turn as the page draws it, from a frame or from the steps kept on the hub. Nil for
    /// what is not a step: a `summary` (a digest of the reply, which the detail fetch brings in full)
    /// and the echo of words the watch sent, which are on screen already.
    private func line(_ state: String, _ text: String, _ key: String) -> ActivityLine? {
        guard !text.isEmpty else { return nil }
        switch state {
        case "summary": return nil
        // His words as the session took them in, or queued behind a turn still running.
        case "said", "queued":
            let words = text.replacingOccurrences(of: Self.spokenFormat, with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if (sent[key] ?? []).contains(where: { words.hasPrefix(String($0.prefix(40))) }) { return nil }
            return ActivityLine(text: words, kind: .said)
        case "text": return ActivityLine(text: text, kind: .thought)
        default: return ActivityLine(text: text, kind: .tool)
        }
    }

    /// Speaks the reply this conversation owes, if it is the one on screen and the reply is in. With
    /// speech switched off by then, the debt is dropped rather than kept for later.
    private func speakIfOwed(_ key: String) {
        guard let at = owed[key] else { return }
        guard Speaker.enabled else { owed[key] = nil; return }
        let since = Date(timeIntervalSince1970: at)
        guard path.last == key, let d = details[key], Self.finished(d, since), let reply = d.last_reply else { return }
        owed[key] = nil
        Speaker.shared.speak(reply, title: d.name)
    }

    /// The session has answered everything since `since`: it is idle, and its last reply is stamped
    /// after the words went in. Idle matters when commands overlap: a turn that ends while the session
    /// already has the next one is a reply, but not the last one.
    private static func finished(_ d: SessionDetail, _ since: Date) -> Bool {
        guard d.working != true, !(d.last_reply ?? "").isEmpty,
              let at = d.reply_at.flatMap(Self.stamp) else { return false }
        return at > since
    }

    private static func stamp(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}
