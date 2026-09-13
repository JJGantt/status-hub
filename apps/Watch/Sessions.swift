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

    var name: String { sessionName(custom_title, label, repo) ?? id }
    var running: Bool { status == "resident" }
}

/// `/api/sessions/:id`: one session with its whole last reply.
struct SessionDetail: Decodable, Equatable {
    let id: String
    let label: String?
    let custom_title: String?
    let repo: String?
    let status: String?
    let working: Bool?
    let last_reply: String?

    var name: String { sessionName(custom_title, label, repo) ?? id }
    var running: Bool { status == "resident" }
}

/// The name a session goes by everywhere: the one Jared gave it, else the router's label, else its repo.
private func sessionName(_ names: String?...) -> String? {
    names.compactMap { $0 }.first { !$0.isEmpty }
}

/// The sessions page's state: the list, each open session's reply, the tool calls each is making, and
/// a reply being recorded or sent into one.
@MainActor
final class Sessions: ObservableObject {
    enum Failure: Equatable {
        case micDenied
        case message(String)
    }

    @Published private(set) var list: [SessionRow] = []
    @Published private(set) var details: [String: SessionDetail] = [:]
    /// Each session's tool calls since its last reply, as its machine reports them. Live only: the
    /// hub does not store them.
    @Published private(set) var activity: [String: [String]] = [:]
    /// His words for a session, shown from the moment they are transcribed until its next reply.
    @Published private(set) var sent: [String: String] = [:]
    @Published private(set) var busy: Set<String> = []
    @Published private(set) var failures: [String: Failure] = [:]

    private let capture = Capture.shared
    // Kept across a retry: the clip until its words are known, and the msgId so a resend cannot type
    // the words twice.
    private var clips: [String: Recorder.Clip] = [:]
    private var msgIds: [String: String] = [:]
    private var stream: Task<Void, Never>?
    private var loading = false
    private var reloadAfter = false

    /// The page is on screen: load now, and follow every session's activity until `deactivate`.
    func activate() {
        Task { await load() }
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
            if let l: Lists = try? await Hub.json("/api/sessions") { list = l.resident + l.evicted }
        } while reloadAfter
    }

    func loadDetail(_ id: String) async {
        if let d: SessionDetail = try? await Hub.json("/api/sessions/" + Hub.pathComponent(id)) { details[id] = d }
    }

    func toggleRecording(_ id: String) {
        if capture.owner == .session(id) { stopRecording(id) } else { startRecording(id) }
    }

    func startRecording(_ id: String) {
        guard capture.owner == nil, !busy.contains(id), details[id]?.running == true else { return }
        failures[id] = nil
        capture.start(for: .session(id)) { [weak self] error in
            self?.failures[id] = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and sends it into the session.
    func stopRecording(_ id: String) {
        guard capture.owner == .session(id), let clip = capture.stop() else { return }
        discard(id)
        clips[id] = clip
        msgIds[id] = UUID().uuidString
        sent[id] = nil
        send(id)
    }

    /// Ends the recording and throws it away.
    func cancelRecording(_ id: String) {
        if capture.owner == .session(id) { capture.cancel() }
    }

    func retry(_ id: String) { send(id) }

    private func reloadAll() async {
        await load()
        for id in details.keys { await loadDetail(id) }
    }

    /// The hub transcribes the clip without enqueueing anything (`?dry=1`), then types the words into
    /// the session. Once the words are known, a retry only resends them.
    private func send(_ id: String) {
        guard let msgId = msgIds[id], !busy.contains(id) else { return }
        failures[id] = nil
        busy.insert(id)
        Task {
            defer { busy.remove(id) }
            do {
                if sent[id] == nil {
                    guard let clip = clips[id] else { return }
                    let heard = try await Hub.sendAudio(clip, msgId: msgId, dry: true)
                    guard let text = heard.transcript, !text.isEmpty else {
                        discard(id)
                        WKInterfaceDevice.current().play(.failure)
                        return
                    }
                    sent[id] = text
                    discard(id)
                }
                try await Hub.followUp(id, text: sent[id] ?? "", msgId: msgId)
            } catch {
                failures[id] = .message(error.localizedDescription)
            }
        }
    }

    private func discard(_ id: String) {
        if let clip = clips[id] { try? FileManager.default.removeItem(at: clip.url) }
        clips[id] = nil
    }

    private func sessionFrame(_ event: String, _ data: String) async {
        struct Frame: Decodable { let session: String; let state: String?; let text: String? }
        guard event == "session", let f = try? JSONDecoder().decode(Frame.self, from: Data(data.utf8)) else { return }
        guard f.state == "done" else {
            if let text = f.text, !text.isEmpty { activity[f.session, default: []].append(text) }
            return
        }
        activity[f.session] = nil
        if sent[f.session] != nil && failures[f.session] == nil && !busy.contains(f.session) {
            sent[f.session] = nil
            msgIds[f.session] = nil
            WKInterfaceDevice.current().play(.notification)
        }
        await load()
        if details[f.session] != nil { await loadDetail(f.session) }
    }
}
