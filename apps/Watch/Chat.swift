import Foundation
import WatchKit

/// The screen's state: the shared thread, plus the one command in flight.
@MainActor
final class Chat: ObservableObject {
    enum Failure: Equatable {
        case noToken
        case message(String)
    }

    @Published private(set) var thread: [Message] = []
    /// Sent but not yet in the thread.
    @Published private(set) var pending: String?
    @Published private(set) var waiting = false
    @Published private(set) var failure: Failure?

    // Kept across a retry. A retry with the same msgId cannot enqueue twice, and once the request id
    // is known a retry only waits again — the command is already with the worker.
    private var msgId = UUID().uuidString
    private var requestId: String?
    private var task: Task<Void, Never>?

    init() {
        PhoneLink.shared.onToken = { [weak self] in self?.tokenArrived() }
    }

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

    func send(_ text: String) {
        pending = text
        msgId = UUID().uuidString
        requestId = nil
        run()
    }

    func retry() {
        if pending == nil {
            failure = nil
            Task { await load() }
        } else {
            run()
        }
    }

    /// Stops waiting. The command itself is already with the worker and still runs; its turn appears
    /// in the thread like any other.
    func cancel() {
        task?.cancel()
        task = nil
        waiting = false
        pending = nil
        requestId = nil
        failure = nil
    }

    private func tokenArrived() {
        if failure == .noToken { retry() } else { Task { await load() } }
    }

    private func run() {
        guard let text = pending else { return }
        failure = nil
        waiting = true
        task?.cancel()
        task = Task {
            do {
                if requestId == nil { requestId = try await Hub.send(text, msgId: msgId) }
                let outcome = try await Hub.outcome(requestId!)
                if Task.isCancelled { return }
                if outcome.status == "error" {
                    failure = .message(outcome.error ?? "")
                    // The worker ran it and failed, so a retry is a new attempt.
                    requestId = nil
                    msgId = UUID().uuidString
                } else {
                    await load()
                    pending = nil
                    requestId = nil
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
