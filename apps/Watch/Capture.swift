import Foundation

/// The watch's one microphone, shared by every page that records: the prompt page (a command for the
/// hub) and a session page (a follow-up typed into that session). One recording at a time; `owner`
/// says whose it is, so only that page draws it and only that page can send it.
@MainActor
final class Capture: ObservableObject {
    static let shared = Capture()

    enum Owner: Equatable {
        case hub
        case session(String)
    }

    @Published private(set) var owner: Owner?
    /// When the microphone actually opened; nil while it is still opening.
    @Published private(set) var since: Date?

    private let recorder = Recorder()
    /// Started, microphone not open yet. A stop in this window cancels instead of sending.
    private var arming = false
    /// The recorder is still opening, so no second start may begin even after a cancel.
    private var opening = false
    /// Mute writes run one after another, so an unmute can never land ahead of its own mute.
    private var muteTask: Task<Void, Never>?

    private init() {}

    /// Starts recording for `owner`, which is set at once so a second tap while the microphone opens is
    /// always a stop. Every other listener (Mac, ESP) goes deaf while it records, as it does for the
    /// phone's microphone, so one sentence cannot arrive twice.
    func start(for owner: Owner, onFailure: @escaping @MainActor (Error) -> Void) {
        guard self.owner == nil, !opening else { return }
        self.owner = owner
        arming = true
        opening = true
        Task {
            defer { opening = false }
            do {
                try await recorder.start()
            } catch {
                arming = false
                self.owner = nil
                onFailure(error)
                return
            }
            guard arming else { recorder.cancel(); return }   // stopped while the microphone opened
            arming = false
            since = Date()
            setMuted(true)
        }
    }

    /// Ends the recording and hands back the clip; nil when the microphone never opened.
    func stop() -> Recorder.Clip? {
        guard owner != nil else { return nil }
        owner = nil
        since = nil
        if arming { arming = false; return nil }
        let clip = recorder.stop()
        setMuted(false)
        return clip
    }

    /// Ends the recording and throws it away.
    func cancel() {
        guard owner != nil else { return }
        owner = nil
        since = nil
        if arming { arming = false; return }
        recorder.cancel()
        setMuted(false)
    }

    private func setMuted(_ on: Bool) {
        let previous = muteTask
        muteTask = Task {
            await previous?.value
            await Hub.muteOthers(on)
        }
    }
}
