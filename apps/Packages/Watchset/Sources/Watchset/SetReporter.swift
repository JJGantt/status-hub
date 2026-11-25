import Foundation
import SessionCore

/// Reports a counted set to the data layer, and amends it afterwards.
///
/// The watch stays dumb: it says how many reps happened and when, and nothing about
/// what movement it was. The exercise and weight are armed separately — "set the set
/// watcher to chest presses at 80 pounds" — and a trigger attaches that meaning. If
/// nothing is armed the report is stored and simply never becomes training data,
/// which is the right failure: losing a log entry is recoverable, guessing the
/// exercise is not.
///
/// Edits act on the REPORT, never on the training log directly, and only on a report
/// from the last two hours; the `workset` function holds that rule (see `DataLayer`).
enum SetReporter {

    /// Report a finished set. Hands back the report id so the count can be corrected
    /// or the set removed from the wrist.
    static func report(reps: Int, at: Date, session: String, algorithm: String,
                       then: @escaping @Sendable (Int?) -> Void) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let body: [String: Any] = ["reps": reps,
                                   "occurred_at": iso.string(from: at),
                                   "session": session,
                                   "algorithm": algorithm]
        guard let req = DataLayer.request("report", "POST", json: body) else { then(nil); return }
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let d = data,
                  let rows = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
                  let id = rows.first?["id"] as? Int else { then(nil); return }
            then(id)
        }.resume()
    }

    /// Correct the count — the + and − buttons.
    static func correct(reportID: Int, reps: Int) {
        guard reps > 0,
              let req = DataLayer.request("report?id=\(reportID)", "PATCH",
                                          json: ["corrected_reps": reps]) else { return }
        URLSession.shared.dataTask(with: req).resume()
    }

    /// Remove the set — the ✕ button. The report survives, so the algorithm's original
    /// verdict is still there to learn from; only the logged set goes.
    static func remove(reportID: Int) {
        guard let req = DataLayer.request("report?id=\(reportID)", "PATCH",
                                          json: ["deleted": true]) else { return }
        URLSession.shared.dataTask(with: req).resume()
    }

    /// What the watcher is currently armed to, so the watch can say whether a set it
    /// counts is actually being logged.
    ///
    /// `reachable` is false only when the request itself failed. Without it, a watch
    /// with no route to the network is indistinguishable from a watcher that was never
    /// armed — both produce nil, both read "not logging", and the lifter has no way to
    /// tell "arm it" from "your watch is offline". Those need different reactions.
    static func armedExercise(then: @escaping @Sendable (Armed?, _ reachable: Bool) -> Void) {
        // The server decides armed-ness (set_watcher_is_armed: ten minutes with no set
        // disarms it) and returns nulls when nothing is armed.
        guard let req = DataLayer.request("watcher", "POST")
        else { then(nil, false); return }
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard err == nil, (200..<300).contains(code) else { then(nil, false); return }
            guard let d = data,
                  let rows = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
                  let row = rows.first else { then(nil, false); return }
            guard let ex = row["exercise"] as? String else { then(nil, true); return }
            // Bodyweight reads as "bodyweight", not "0 lb" — matching the hub.
            let w = row["weight_lbs"] as? Double
            let label = w.map { $0 == 0 ? "\(ex) · bodyweight" : "\(ex) · \(Int($0)) lb" } ?? ex
            then(Armed(label: label, exercise: ex, weight: w), true)
        }.resume()
    }
}
