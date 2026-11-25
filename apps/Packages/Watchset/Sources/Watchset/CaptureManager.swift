import Foundation
import CoreMotion
import os
import RepCounter

/// Records one contiguous set of device motion.
///
/// Reference frame is `.xMagneticNorthZVertical`: Z is locked to vertical by gravity
/// and X to magnetic north by the magnetometer, so yaw is an absolute heading rather
/// than drifting from wherever the watch happened to start.
@MainActor
final class CaptureManager: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var sampleCount = 0
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var quality: CaptureQuality?
    @Published private(set) var lastFailure: String?

    let keepAlive = KeepAlive.shared
    private let activity = ActivityMonitor()

    private let motion = CMMotionManager()
    private let queue = OperationQueue()
    /// Written by the motion queue and drained by the session, so it is behind a lock
    /// rather than on the main actor.
    private let samples = OSAllocatedUnfairLock(initialState: [MotionSample]())
    private var ticker: Timer?
    private var startedAt: Date?

    /// 100 Hz, the rate the reference recordings were made at.
    private let interval = 0.01

    init() {
        queue.name = "com.jaredgantt.workset.motion"
        queue.maxConcurrentOperationCount = 1
    }

    func start() async {
        guard !isRecording else { return }
        guard motion.isDeviceMotionAvailable else {
            lastFailure = "device motion unavailable"
            return
        }
        // The app holds the workout session (one app can hold one at a time). Report WHY it
        // could not, rather than returning quietly: a silent failure here looks exactly like a
        // dead button, nothing starts and nothing is said.
        let failure = await keepAlive.acquire()

        samples.withLock { $0.removeAll() }
        sampleCount = 0
        quality = nil
        lastFailure = failure
        startedAt = Date()

        activity.start()
        motion.deviceMotionUpdateInterval = interval
        motion.startDeviceMotionUpdates(using: .xMagneticNorthZVertical, to: queue,
                                        withHandler: Self.recorder(into: samples, activity: activity.latest))

        isRecording = true
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    /// The device-motion handler. Built outside the main actor because CoreMotion calls
    /// it on the motion queue; a closure formed inside a main-actor method would be
    /// isolated to the main actor and trap when called from there.
    private nonisolated static func recorder(
        into samples: OSAllocatedUnfairLock<[MotionSample]>,
        activity: OSAllocatedUnfairLock<ActivityMonitor.Reading>
    ) -> CMDeviceMotionHandler {
        return { data, _ in
            guard let d = data else { return }
            let act = activity.withLock { $0 }
            let s = MotionSample(
                sensorTime: d.timestamp,
                userAccel: SIMD3(d.userAcceleration.x, d.userAcceleration.y, d.userAcceleration.z),
                rotationRate: SIMD3(d.rotationRate.x, d.rotationRate.y, d.rotationRate.z),
                gravity: SIMD3(d.gravity.x, d.gravity.y, d.gravity.z),
                attitude: SIMD3(d.attitude.pitch, d.attitude.roll, d.attitude.yaw),
                magAccuracy: Int(d.magneticField.accuracy.rawValue),
                activityMask: act.mask,
                activityConfidence: act.confidence)
            samples.withLock { $0.append(s) }
        }
    }

    func stop() async -> [MotionSample] {
        guard isRecording else { return [] }
        motion.stopDeviceMotionUpdates()
        activity.stop()
        ticker?.invalidate(); ticker = nil
        keepAlive.release()
        isRecording = false

        let out = samples.withLock { $0 }
        quality = CaptureQuality.measure(out)
        sampleCount = out.count
        return out
    }

    /// Remove and return everything accumulated since the last call.
    ///
    /// Always-on counting runs for a whole workout, so nothing can accumulate here
    /// indefinitely — an hour at 100 Hz is 360,000 samples. The session keeps only
    /// the window it needs and drops the rest, so retention is its decision rather
    /// than a side effect of recording.
    nonisolated func drain() -> [MotionSample] {
        samples.withLock {
            let out = $0
            $0.removeAll(keepingCapacity: true)
            return out
        }
    }

    private func tick() {
        let n = samples.withLock { $0.count }
        sampleCount = n
        if let s = startedAt { elapsed = Date().timeIntervalSince(s) }
    }
}
