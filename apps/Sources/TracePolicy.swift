import Foundation

/// When the near-home trace (HomeTrace.swift, docs/DOOR.md § Near-home trace) runs location at full
/// accuracy. Pure, so it is tested by apps/tests (run-elevator-detector.sh).
///
/// Best accuracy (GPS, a fix every second or so) costs battery, so it runs only while he is moving: any
/// activity other than stationary switches to best at once. Low accuracy (the keep-alive's usual
/// 100 m) comes back only after he has been stationary for `settleAfter` seconds, so a pause at a door
/// or a red light does not flap the mode. An unknown activity keeps whatever mode is current.
enum TracePolicy {
    enum Mode: String { case best, low }
    enum Activity: String { case stationary, walking, running, automotive, cycling, unknown }

    static let settleAfter: TimeInterval = 120

    /// The mode to be in at `now`, given the current one, the latest activity and since when he has been
    /// stationary (nil when he is not).
    static func mode(current: Mode, activity: Activity, stationarySince: TimeInterval?, now: TimeInterval) -> Mode {
        switch activity {
        case .walking, .running, .automotive, .cycling: return .best
        case .unknown: return current
        case .stationary:
            guard let since = stationarySince else { return current }
            return now - since >= settleAfter ? .low : current
        }
    }
}
