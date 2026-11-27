import Foundation
import RepCounter

/// Ships every recognised set to Supabase as a raw CSV.
///
/// Without this a wrong count in the gym teaches nothing — the number is all you
/// get, and the recording that produced it is gone. With it, a miscount becomes a
/// file that can be replayed against the algorithm the same day.
///
/// Objects land at `workset/sensor_capture/<session>/motion.csv`, and the column order
/// matches the reference recordings exactly, so the analysis tooling reads these with
/// no modification.
enum CaptureUploader {

    /// Sets that could not be uploaded yet. The gym is exactly where the watch has
    /// no useful connection, so a failed upload queues on disk and is retried rather
    /// than dropped — losing the recording defeats the point of making it.
    private static var queueDir: URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true)
            .appendingPathComponent("watchset-pending", isDirectory: true)
    }

    /// Persist first, then try to send. Writing to disk before attempting the network
    /// means a set survives the app being killed mid-upload.
    static func upload(_ samples: [MotionSample], verdict: CountedSet?,
                       exercise: String? = nil, weightLbs: Double? = nil,
                       cancelled: Bool = false) {
        guard samples.count > 8 else { return }
        let session = "unlabeled_0_\(Int(Date().timeIntervalSince1970))"
        let body = Data(CaptureFormat.csv(samples, session: session, verdict: verdict,
                                          exercise: exercise, weightLbs: weightLbs,
                                          cancelled: cancelled).utf8)
        do {
            guard let dir = queueDir else { throw CocoaError(.fileNoSuchFile) }
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try body.write(to: dir.appendingPathComponent("\(session).csv"))
        } catch {
            // Not queued, so a failed send below loses the recording for good.
            WatchsetHost.fail("capture-queue-failed", ["session": session, "error": String(describing: error).prefix(120).description])
        }
        flush()
    }

    /// Try to send everything queued. Files are removed only on a confirmed 2xx.
    static func flush() {
        guard let dir = queueDir,
              let files = try? FileManager.default.contentsOfDirectory(at: dir,
                                                                      includingPropertiesForKeys: nil)
        else { return }
        for f in files where f.pathExtension == "csv" {
            guard let body = try? Data(contentsOf: f) else { continue }
            let session = f.deletingPathExtension().lastPathComponent
            // The function stores it at workset/sensor_capture/<session>/motion.csv in the
            // workset-captures bucket, never overwriting.
            guard let req = DataLayer.request("capture?session=\(session)", "POST",
                                              contentType: "text/csv", body: body) else { continue }
            URLSession.shared.dataTask(with: req) { _, resp, err in
                // 409 means this session is already stored — also a reason to stop
                // retrying, not a failure.
                guard let why = WatchsetHost.failure(resp, err, ok: [409]) else {
                    try? FileManager.default.removeItem(at: f)
                    return
                }
                // No connection is what the queue is for: the file stays and the next flush sends it.
                // An answer that refused it will refuse it on every flush, so that one is a failure.
                if err == nil { WatchsetHost.fail("capture-upload-failed", ["session": session, "error": why]) }
                else { WatchsetHost.current?.log("capture-upload-retry", ["session": session, "error": why]) }
            }.resume()
        }
    }
}
