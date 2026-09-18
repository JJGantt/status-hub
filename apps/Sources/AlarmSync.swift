#if os(iOS)
import Foundation
import UIKit
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
#endif

// Keeping the phone's registered alarms equal to what the hub says they should be.
//
// AN ALARM IS REGISTERED ON THE DEVICE. There is no push that rings one — unlike a notification, and
// unlike a Live Activity, which at least has push-to-start. So the server can only ever say "look
// again", and this is what looks.
//
// A WINDOW, NOT A CHANGE LIST. Every run reads the whole next week from /api/alarms and makes the
// device match it: cancel what is no longer there, schedule what is new, leave the rest alone. That
// is what makes a missed wake cheap — iOS throttles background pushes and delivers none at all after
// a force-quit, so the cost of one being dropped has to be "an alarm created in the last few hours is
// late to register", not "the next alarm never happened". It also means there is no local state: the
// alarm id is derived from (item, moment) (HubAlarm.id), so the diff is a set difference and nothing
// can drift out of step with the server.
//
// Called on foreground (the guarantee) and from the silent push (the speed). Both in Push.swift.
enum AlarmSync {
    /// - Parameters:
    ///   - why: which trigger this is, for the beacon. Nothing on the device's side of this leaves a
    ///     trace otherwise — scheduling is local and the wake is a fire-and-forget push — so when it
    ///     does nothing there is no way to tell "never ran" from "ran and declined" without being told.
    ///   - mayPrompt: whether this run may ask for authorization. Only a foreground run may: the
    ///     prompt is a question someone has to be looking at to answer, and asking from a background
    ///     wake spends the one chance the system gives on a screen nobody is watching.
    static func sync(why: String, mayPrompt: Bool = false, done: ((Bool) -> Void)? = nil) {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task { let changed = await run(why: why, mayPrompt: mayPrompt); done?(changed) }
            return
        }
        beacon(["at": "no-alarmkit", "why": why])
        #else
        beacon(["at": "not-compiled", "why": why])
        #endif
        done?(false)
    }

    /// Into the hub's app log (`[clientlog]`), which is the only place a phone can say anything.
    static func beacon(_ fields: [String: Any]) {
        var body = fields
        body["ev"] = "alarm-sync"
        HubAPI.post("/api/clientlog", body, done: {})
    }
}

#if canImport(AlarmKit)
@available(iOS 26.0, *)
private extension AlarmSync {
    struct Feed: Decodable {
        struct Item: Decodable { let id: String; let at: String; let title: String }
        let alarms: [Item]
    }

    static func name(_ state: AlarmManager.AuthorizationState) -> String {
        switch state {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        @unknown default: return "unknown"
        }
    }

    static func run(why: String, mayPrompt: Bool) async -> Bool {
        let manager = AlarmManager.shared
        var state = manager.authorizationState
        beacon(["at": "start", "why": why, "prompt": mayPrompt, "state": name(state)])
        if state == .notDetermined {
            guard mayPrompt else { return false }
            // The returned state is what to trust. Re-reading `authorizationState` right after the
            // prompt is reading a value that may not have caught up yet, and a run that answers its
            // own question with a stale snapshot does nothing and says nothing.
            do { state = try await manager.requestAuthorization() }
            catch { beacon(["at": "ask-failed", "why": why, "err": String(describing: error)]); return false }
            beacon(["at": "asked", "why": why, "state": name(state)])
        }
        guard state == .authorized else {
            beacon(["at": "unauthorized", "why": why, "state": name(state)])
            return false
        }
        guard let feed = await fetch() else {
            beacon(["at": "no-feed", "why": why, "token": Auth.token() != nil])
            return false
        }

        // What SHOULD be registered, keyed by the id the device will know it under.
        var want: [UUID: Feed.Item] = [:]
        for item in feed.alarms where !item.id.isEmpty {
            want[HubAlarm.id(item: item.id, at: item.at)] = item
        }
        let have = (try? manager.alarms) ?? []
        var changed = false

        // Gone from the window: cancelled. Only ones still merely SCHEDULED — an alarm that is ringing
        // or counting down has already left the feed by definition (its moment has passed), and taking
        // it off the screen mid-ring is not what "no longer due in the next week" means.
        for alarm in have where want[alarm.id] == nil && alarm.state == .scheduled {
            try? manager.cancel(id: alarm.id)
            changed = true
        }

        // New in the window: scheduled. Anything already registered is left exactly as it is — the id
        // encodes the moment, so an unchanged alarm is the same id and a moved one is a different one.
        let registered = Set(have.map(\.id))
        for (id, item) in want where !registered.contains(id) {
            guard let date = instant(item.at), date > Date() else { continue }
            let alert = AlarmPresentation.Alert(
                title: LocalizedStringResource(stringLiteral: item.title),
                stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.fill"))
            let attributes = AlarmAttributes<HubAlarmMetadata>(
                presentation: AlarmPresentation(alert: alert),
                metadata: HubAlarmMetadata(itemID: item.id),
                tintColor: .orange)
            do {
                _ = try await manager.schedule(
                    id: id, configuration: .alarm(schedule: .fixed(date), attributes: attributes))
                changed = true
            } catch AlarmManager.AlarmError.maximumLimitReached {
                // The per-app cap. Nothing later in the window will fit either, and the ones already
                // registered are the sooner ones, so stopping here keeps the nearest alarms.
                beacon(["at": "limit", "why": why, "registered": registered.count])
                break
            } catch {
                beacon(["at": "schedule-failed", "why": why, "err": String(describing: error)])
            }
        }
        // WHAT WE ACTUALLY HOLD, back to the hub. An AlarmKit alarm lives here, not there, so without
        // this the hub can only ever say an item was ASKED to ring — and a surface that draws that as
        // a promise is lying whenever a schedule failed, the limit was hit, or authorization was
        // never granted. Read fresh rather than assumed from the loop above: what matters is what the
        // system says it has, not what we believe we did to it.
        //
        // The whole SET, because a cancellation cannot be expressed by a message about one alarm.
        let held = ((try? manager.alarms) ?? []).compactMap { a in want[a.id]?.id }
        HubAPI.post("/api/alarms/ack", ["ids": held], done: {})
        beacon(["at": "done", "why": why, "want": want.count, "have": have.count,
                "held": held.count, "changed": changed])
        return changed
    }

    static func fetch() async -> Feed? {
        await withCheckedContinuation { cont in
            HubAPI.get("/api/alarms") { data in
                guard let data, let feed = try? JSONDecoder().decode(Feed.self, from: data) else {
                    return cont.resume(returning: nil)
                }
                cont.resume(returning: feed)
            }
        }
    }

    /// The server sends an absolute instant (see /api/alarms) precisely so the phone never resolves a
    /// wall-clock time against wherever it happens to be. Parsed both with and without fractional
    /// seconds, because which one arrives is a detail of whoever serialized it.
    static func instant(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}
#endif
#endif
