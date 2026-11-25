import Foundation
import CoreMotion
import os

/// What the OS believes the wearer is doing, sampled alongside the motion stream.
///
/// This exists to answer a question rather than to enforce a rule. An always-on rep
/// counter's obvious failure is walking: an arm swing is a repeated movement
/// with real displacement and excellent periodicity.
///
/// Apple already ships a trained classifier for this, so the sensible move is to use
/// it. But it may equally misread a rhythmic set AS walking, which would suppress
/// real sets. So nothing is gated on it yet: it is recorded into every capture, and
/// what it actually does during real sets decides whether it can be trusted.
@MainActor
final class ActivityMonitor {
    struct Reading: Sendable {
        var mask = 0
        var confidence = -1
    }

    private let manager = CMMotionActivityManager()
    /// Latest verdict. Read from the motion queue, so behind a lock.
    nonisolated let latest = OSAllocatedUnfairLock(initialState: Reading())

    nonisolated static var isAvailable: Bool { CMMotionActivityManager.isActivityAvailable() }

    func start() {
        guard Self.isAvailable else { return }
        manager.startActivityUpdates(to: .main) { [weak self] a in
            guard let self, let a else { return }
            // The flags are not exclusive — CoreMotion can report several at once —
            // so they are OR'd rather than collapsed to one label. Collapsing would
            // silently discard the ambiguous cases, which are the interesting ones.
            var m = 0
            if a.stationary { m |= 1 }
            if a.walking    { m |= 2 }
            if a.running    { m |= 4 }
            if a.cycling    { m |= 8 }
            if a.automotive { m |= 16 }
            if a.unknown || m == 0 { m |= 32 }
            let reading = Reading(mask: m, confidence: a.confidence.rawValue)
            self.latest.withLock { $0 = reading }
        }
    }

    func stop() {
        guard Self.isAvailable else { return }
        manager.stopActivityUpdates()
    }
}
