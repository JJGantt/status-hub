#if os(iOS)
import Foundation
import HealthKit

// Apple Watch sleep, read from Apple Health and sent to the hub (docs/SLEEP.md).
//
// An anchored query returns only what changed since the last anchor, deletions included, so each run
// sends the difference and nothing is resent. The anchor is saved only after the hub accepts the
// batch: a failed post leaves it where it was and the next run sends the same samples again, which the
// hub's UUID-keyed upsert makes harmless.
//
// The observer query plus background delivery is what wakes the app when the watch's night lands on
// the phone. It must be registered on every launch, including the background relaunch HealthKit does
// to deliver, which is why start() is called from didFinishLaunching rather than from a view.
final class SleepSync {
    static let shared = SleepSync()
    private let store = HKHealthStore()
    private let type = HKCategoryType(.sleepAnalysis)
    private let anchorKey = "sleepAnchor"
    private let queue = DispatchQueue(label: "SleepSync")
    private var running = false

    func start() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        store.requestAuthorization(toShare: [], read: [type]) { [weak self] _, _ in
            guard let self else { return }
            let observer = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, done, error in
                guard error == nil, let self else { return done() }
                self.sync(then: done)
            }
            store.execute(observer)
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
        }
    }

    // One run at a time: the observer fires at launch and again on every delivery, and two runs from
    // the same anchor would post the same batch twice.
    private func sync(then done: @escaping () -> Void) {
        queue.async {
            if self.running { return done() }
            self.running = true
            self.page(from: self.loadAnchor()) {
                self.queue.async { self.running = false }
                done()
            }
        }
    }

    // A first run returns the whole history, so it is read and posted in pages, each one committing
    // its anchor before the next is asked for.
    private func page(from anchor: HKQueryAnchor?, then done: @escaping () -> Void) {
        let q = HKAnchoredObjectQuery(type: type, predicate: nil, anchor: anchor, limit: 500) { [weak self] _, added, deleted, next, error in
            guard let self, error == nil, let next else { return done() }
            let samples = (added ?? []).compactMap { $0 as? HKCategorySample }.compactMap(Self.row)
            let gone = (deleted ?? []).map { $0.uuid.uuidString }
            if samples.isEmpty && gone.isEmpty { self.saveAnchor(next); return done() }
            self.post(samples, gone) { ok in
                guard ok else { return done() }
                self.saveAnchor(next)
                // A full page means there may be more behind it.
                if (added?.count ?? 0) + (deleted?.count ?? 0) >= 500 { self.page(from: next, then: done) } else { done() }
            }
        }
        store.execute(q)
    }

    private static func row(_ s: HKCategorySample) -> [String: Any]? {
        let stage: String
        switch HKCategoryValueSleepAnalysis(rawValue: s.value) {
        case .inBed: stage = "in_bed"
        case .asleepUnspecified: stage = "asleep_unspecified"
        case .awake: stage = "awake"
        case .asleepCore: stage = "core"
        case .asleepDeep: stage = "deep"
        case .asleepREM: stage = "rem"
        default: return nil
        }
        let iso = ISO8601DateFormatter()
        return ["id": s.uuid.uuidString, "start": iso.string(from: s.startDate), "end": iso.string(from: s.endDate),
                "stage": stage, "source": s.sourceRevision.source.name]
    }

    private func post(_ samples: [[String: Any]], _ deleted: [String], done: @escaping (Bool) -> Void) {
        guard let url = URL(string: Auth.host + "/api/health/sleep"), let token = Auth.token() else { return done(false) }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 30
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["samples": samples, "deleted": deleted])
        URLSession.shared.dataTask(with: r) { _, resp, err in
            done(err == nil && (resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    private func loadAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ a: HKQueryAnchor) {
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: a, requiringSecureCoding: true) {
            UserDefaults.standard.set(data, forKey: anchorKey)
        }
    }
}
#endif
