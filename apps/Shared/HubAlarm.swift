#if canImport(AlarmKit)
import AlarmKit
import CryptoKit
import Foundation

// The types both halves of an alarm need: the app, which schedules it (Sources/AlarmSync.swift), and
// the widget extension, which draws it (Controls/AlarmWidget.swift). They are separate processes with
// separate bundle ids, so anything that crosses between them lives here.
//
// AlarmKit is iOS 26; this app's deployment target is 17 and the extension's is 18, so every
// declaration is gated and the framework is weak-linked. Nothing below runs on an older phone.

/// Carried on every hub alarm. AlarmKit requires the type even when it holds nothing; the item id is
/// what lets the alert lead back to the thing that is due.
@available(iOS 26.0, *)
struct HubAlarmMetadata: AlarmMetadata {
    var itemID: String = ""
}

@available(iOS 26.0, *)
enum HubAlarm {
    /// An alarm's id, derived rather than stored. It is a pure function of (item, moment), which buys
    /// two things: a sync is a plain set difference against `AlarmManager.shared.alarms` with no local
    /// bookkeeping to drift, and MOVING an item — snoozing it — is automatically a different alarm, so
    /// the old one is cancelled and the new one scheduled without anything having to notice the change.
    static func id(item: String, at: String) -> UUID {
        let digest = SHA256.hash(data: Data("hub-alarm:\(item)|\(at)".utf8))
        var b = [UInt8](digest.prefix(16))
        b[6] = (b[6] & 0x0F) | 0x40     // version 4, so it is a well-formed UUID and not just 16 bytes
        b[8] = (b[8] & 0x3F) | 0x80     // RFC 4122 variant
        return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                           b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
    }
}
#endif
