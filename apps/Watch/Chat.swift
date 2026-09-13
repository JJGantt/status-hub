import Foundation
import WatchKit

/// The screen's state: the shared thread, the clip being recorded, and the one command in flight.
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
    @Published private(set) var recording = false
    /// When the microphone actually opened; nil while it is still opening.
    @Published private(set) var recordingSince: Date?
    /// What the hub heard, shown until it lands in the thread.
    @Published private(set) var pending: String?
    @Published private(set) var waiting = false
    @Published private(set) var failure: Failure?
    /// Set by the complication's statushub://record and by the Record control; the prompt page starts
    /// recording once it is on screen.
    @Published var recordRequested = false

    private let recorder = Recorder()
    /// Tapped, microphone not open yet. A tap in this window cancels instead of stopping.
    private var arming = false
    // Kept across a retry: the clip until its command has run, the msgId so a resend cannot enqueue
    // twice, and the request id once known, after which a retry only waits again.
    private var clip: Recorder.Clip?
    private var msgId = UUID().uuidString
    private var requestId: String?
    private var task: Task<Void, Never>?
    /// Mute writes run one after another, so an unmute can never land ahead of its own mute.
    private var muteTask: Task<Void, Never>?

    private init() {
        PhoneLink.shared.onToken = { [weak self] in self?.tokenArrived() }
    }

    func requestRecording() { recordRequested = true }

    func load() async {
        do {
            thread = try await Hub.thread().filter { $0.role != "tool" }
            if failure == .noToken { failure = nil }
        } catch HubError.noToken {
            failure = .noToken
        } catch {
            // Keep showing what was there; the next activation reloads.
        }
    }

    func toggleRecording() {
        if recording { stopRecording() } else { startRecording() }
    }

    func startRecording() {
        guard !recording, !waiting else { return }
        failure = nil
        // Flipped before the await, so a second tap while the microphone opens is always a stop.
        recording = true
        arming = true
        Task {
            do {
                try await recorder.start()
            } catch {
                arming = false
                recording = false
                failure = (error as? Recorder.Failure) == .denied ? .micDenied : .message(error.localizedDescription)
                return
            }
            guard arming else { recorder.cancel(); return }   // cancelled while the microphone opened
            arming = false
            recordingSince = Date()
            // Every other listener (Mac, ESP) goes deaf while the watch records, as it does for the
            // phone's microphone, so one sentence cannot arrive as two commands.
            setMuted(true)
        }
    }

    /// Ends the recording and sends it.
    func stopRecording() {
        guard recording else { return }
        recording = false
        recordingSince = nil
        if arming { arming = false; return }
        let finished = recorder.stop()
        setMuted(false)
        guard let finished else { return }
        discardClip()
        clip = finished
        msgId = UUID().uuidString
        requestId = nil
        pending = nil
        run()
    }

    /// Ends the recording and throws it away.
    func cancelRecording() {
        guard recording else { return }
        recording = false
        recordingSince = nil
        if arming { arming = false; return }
        recorder.cancel()
        setMuted(false)
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

    private func setMuted(_ on: Bool) {
        let previous = muteTask
        muteTask = Task {
            await previous?.value
            await Hub.muteOthers(on)
        }
    }

    private func discardClip() {
        if let clip { try? FileManager.default.removeItem(at: clip.url) }
        clip = nil
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
