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
    /// What the hub heard, shown until it lands in the thread.
    @Published private(set) var pending: String?
    @Published private(set) var waiting = false
    @Published private(set) var failure: Failure?
    /// Tool calls of the hub command running now, and what the model says between them, as the worker
    /// reports them. The hub does not store them, so they show while a command runs and clear when the
    /// next starts or this one finishes.
    @Published private(set) var activity: [ActivityLine] = []
    /// Set by the complication's statushub://record and by the Record control; the prompt page starts
    /// recording once it is on screen.
    @Published var recordRequested = false

    private let capture = Capture.shared
    // Kept across a retry: the clip until its command has run, the msgId so a resend cannot enqueue
    // twice, and the request id once known, after which a retry only waits again.
    private var clip: Recorder.Clip?
    private var msgId = UUID().uuidString
    private var requestId: String?
    private var task: Task<Void, Never>?
    private var stream: Task<Void, Never>?
    private var loading = false
    private var reloadAfter = false

    private init() {
        PhoneLink.shared.onToken = { [weak self] in self?.tokenArrived() }
    }

    func requestRecording() { recordRequested = true }

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
            } catch HubError.noToken {
                failure = .noToken
            } catch {
                // Keep showing what was there; the next frame or activation reloads.
            }
        } while reloadAfter
    }

    func toggleRecording() {
        if capture.owner == .hub { stopRecording() } else { startRecording() }
    }

    func startRecording() {
        guard capture.owner == nil, !waiting else { return }
        failure = nil
        capture.start(for: .hub) { [weak self] error in
            self?.failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
        }
    }

    /// Ends the recording and sends it.
    func stopRecording() {
        guard capture.owner == .hub, let finished = capture.stop() else { return }
        discardClip()
        clip = finished
        msgId = UUID().uuidString
        requestId = nil
        pending = nil
        run()
    }

    /// Ends the recording and throws it away.
    func cancelRecording() {
        if capture.owner == .hub { capture.cancel() }
    }

    func retry() {
        if clip == nil && requestId == nil {
            failure = nil
            Task { await load() }
        } else {
            run()
        }
    }

    /// Stops waiting. A command the hub already has still runs, and its turn appears in the thread like
    /// any other; a clip that never reached the hub is dropped.
    func cancel() {
        task?.cancel()
        task = nil
        waiting = false
        pending = nil
        requestId = nil
        failure = nil
        discardClip()
    }

    private func tokenArrived() {
        if failure == .noToken { retry() } else { Task { await load() } }
    }

    private func discardClip() {
        if let clip { try? FileManager.default.removeItem(at: clip.url) }
        clip = nil
    }

    private func voiceFrame(_ event: String, _ data: String) async {
        guard event == "voice", let frame = try? JSONDecoder().decode(VoiceFrame.self, from: Data(data.utf8)) else { return }
        switch frame.kind {
        case "activity":
            guard (frame.row?.focus ?? "hub") == "hub" else { return }
            switch frame.row?.state {
            case "tool", "text":
                if let text = frame.row?.text, !text.isEmpty {
                    activity.append(ActivityLine(text: text, thought: frame.row?.state == "text"))
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

    private func run() {
        failure = nil
        waiting = true
        task?.cancel()
        task = Task {
            do {
                if requestId == nil {
                    guard let clip else { waiting = false; return }
                    let heard = try await Hub.sendAudio(clip, msgId: msgId)
                    if let text = heard.transcript, !text.isEmpty { pending = text }
                    guard let id = heard.id else {
                        // The hub heard no words, so there is no command.
                        discardClip()
                        pending = nil
                        waiting = false
                        WKInterfaceDevice.current().play(.failure)
                        return
                    }
                    requestId = id
                }
                let outcome = try await Hub.outcome(requestId!)
                if Task.isCancelled { return }
                if outcome.status == "error" {
                    failure = .message(outcome.error ?? "")
                    // The worker ran it and failed, so a retry uploads the clip again as a new attempt.
                    requestId = nil
                    msgId = UUID().uuidString
                } else {
                    await load()
                    pending = nil
                    requestId = nil
                    discardClip()
                    WKInterfaceDevice.current().play(.notification)
                }
            } catch HubError.noToken {
                failure = .noToken
            } catch {
                if Task.isCancelled { return }
                failure = .message(error.localizedDescription)
            }
            waiting = false
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
