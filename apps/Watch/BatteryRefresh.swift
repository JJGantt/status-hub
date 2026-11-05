import Foundation
import WatchKit

/// **The watch wakes itself every half hour to report its battery** (server lib/watchbattery.js, the
/// walls' battery hairline). Every log batch already carries the level, but a batch only goes out while
/// the app is in use, so an unused afternoon left the bar hours stale. watchOS gives an app no
/// battery-change event, so this is a scheduled background refresh, a timer by choice.
///
/// A chain: each wake sends a `battery` log line (which carries the level beside it) and books the
/// next, and every launch books one too, so a chain broken by a reboot or a failed booking restarts the
/// next time the app runs. watchOS keeps one request per app, so a booking replaces the one before it.
/// The time is a request: the system runs it within its budget, which a complication on the face
/// raises to about four an hour.
enum BatteryRefresh {
    static let every: TimeInterval = 30 * 60

    static func schedule() {
        WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: Date().addingTimeInterval(every),
                                                         userInfo: nil) { error in
            if let error { Hub.log("error", ["msg": "battery refresh not scheduled: \(error.localizedDescription)"]) }
        }
    }

    /// The wake itself: book the next one first, so a send that runs out of time still leaves the chain.
    static func run() async {
        schedule()
        await Hub.logNow("battery")
    }
}
