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

    var name: String { sessionName(custom_title, label, repo) ?? id }
    var running: Bool { status == "resident" }
    /// The conversation this row is a stretch of. A resume makes a new row for the same conversation
    /// (`claude --resume` keeps its id), so everything the page keeps about a session is keyed by this.
    var key: String { claude_session_id ?? id }
}

/// `/api/sessions/:id`: one session with its last prompt and the whole reply to it.
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

    var name: String { sessionName(custom_title, label, repo) ?? id }
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
        // Asked here, not left to the view: when this conversation is already the one on screen the view
        // does not appear again, and an app that was in the background missed the stream's `done`, so
        // nothing else would fetch the reply the notification is about.
        await loadDetail(key)
    }

    /// One row per conversation: its running row if it has one, else its newest parked one.
    @Published private(set) var list: [SessionRow] = []
    @Published private(set) var details: [String: SessionDetail] = [:]
    /// Each conversation's tool calls since its last reply, and what it said between them, as its
    /// machine reports them. Live only: the hub does not store them.
    @Published private(set) var activity: [String: [ActivityLine]] = [:]
    /// His words for a conversation, shown from the moment they are transcribed until its next reply.
    @Published private(set) var sent: [String: String] = [:]
    @Published private(set) var busy: Set<String> = []
    @Published private(set) var failures: [String: Failure] = [:]

    private let capture = Capture.shared
    /// Every row the hub sent, so a stream frame (which names a row) can be matched to its conversation.
    private var rows: [SessionRow] = []
    // Kept across a retry: the clip until its words are known, and the msgId so a resend cannot type
    // the words twice.
    private var clips: [String: Recorder.Clip] = [:]
    private var msgIds: [String: String] = [:]
    private var stream: Task<Void, Never>?
    private var loading = false
    private var reloadAfter = false

    /// The page is on screen: load now, and follow every session's activity until `deactivate`.
    func activate() {
        // The conversation on screen too: a turn that finished while the app was away sent its `done`
        // to a stream that was not listening.
        Task {
            await load()
            if let key = path.last { await loadDetail(key) }
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
        struct Lists: Decodable { let resident: [SessionRow]; let evicted: [SessionRow] }
        if loading { reloadAfter = true; return }
        loading = true
        defer { loading = false }
        repeat {
            reloadAfter = false
            if let l: Lists = try? await Hub.json("/api/sessions") {
                rows = l.resident + l.evicted
                var seen = Set<String>()
                list = rows.filter { seen.insert($0.key).inserted }
            }
        } while reloadAfter
    }

    /// The row a conversation's words go to: its running row, else its newest parked one.
    func row(for key: String) -> SessionRow? {
        rows.first { $0.key == key && $0.running } ?? rows.first { $0.key == key }
    }

    func loadDetail(_ key: String) async {
        guard let r = row(for: key) else { return }
        if let d: SessionDetail = try? await Hub.json("/api/sessions/" + Hub.pathComponent(r.id)) { details[key] = d }
    }

    func toggleRecording(_ key: String) {
        if capture.owner == .session(key) { stopRecording(key) } else { startRecording(key) }
    }

    func startRecording(_ key: String) {
        guard capture.owner == nil, !busy.contains(key), row(for: key) != nil else { return }
        failures[key] = nil
        capture.start(for: .session(key)) { [weak self] error in
            self?.failures[key] = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and sends it into the session.
    func stopRecording(_ key: String) {
        guard capture.owner == .session(key), let clip = capture.stop() else { return }
        discard(key)
        clips[key] = clip
        msgIds[key] = UUID().uuidString
        sent[key] = nil
        send(key)
    }

    /// Ends the recording and throws it away.
    func cancelRecording(_ key: String) {
        if capture.owner == .session(key) { capture.cancel() }
    }

    func retry(_ key: String) { send(key) }

    private func reloadAll() async {
        await load()
        for key in details.keys { await loadDetail(key) }
    }

    /// The hub transcribes the clip without enqueueing anything (`?dry=1`), then hands the words to the
    /// session: typed in if it is running, resumed with them if it is parked — the hub decides. Once the
    /// words are known, a retry only resends them.
    private func send(_ key: String) {
        guard let msgId = msgIds[key], !busy.contains(key) else { return }
        failures[key] = nil
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                if sent[key] == nil {
                    guard let clip = clips[key] else { return }
                    let heard = try await Hub.sendAudio(clip, msgId: msgId, dry: true)
                    guard let text = heard.transcript, !text.isEmpty else {
                        discard(key)
                        WKInterfaceDevice.current().play(.failure)
                        return
                    }
                    sent[key] = text
                    discard(key)
                }
                try await Hub.followUp(row(for: key)?.id ?? key, text: sent[key] ?? "", msgId: msgId)
            } catch {
                failures[key] = .message(error.localizedDescription)
            }
        }
    }

    private func discard(_ key: String) {
        if let clip = clips[key] { try? FileManager.default.removeItem(at: clip.url) }
        clips[key] = nil
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
        guard f.state == "done" else {
            if let text = f.text, !text.isEmpty {
                activity[key, default: []].append(ActivityLine(text: text, thought: f.state == "text"))
            }
            return
        }
        activity[key] = nil
        if sent[key] != nil && failures[key] == nil && !busy.contains(key) {
            sent[key] = nil
            msgIds[key] = nil
            WKInterfaceDevice.current().play(.notification)
        }
        await load()
        if details[key] != nil { await loadDetail(key) }
    }
}
