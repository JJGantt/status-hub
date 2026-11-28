import Foundation

/// Recognises the elevator ride up to the apartment from the barometer and the step counter, and says
/// when to unlock: after the ride has ended and he has walked a few steps out of the elevator, so the
/// lock is heard from the hallway. Pure logic, fed by `ElevatorUnlock`; tested by
/// `apps/tests/elevator-detector.swift`. The thresholds are deliberately loose to start with and are
/// tuned from the traces in `elevator_rides` (docs/DOOR.md).
///
/// A ride counts from its lowest point. Standing still at another floor (someone else getting off) is
/// still the same ride: only walking out ends it, and the whole climb counts.
///
/// - A RIDE is a rise of `minRise` metres within `rideWindow` seconds while taking at most
///   `maxRideSteps` steps (an elevator, not stairs).
/// - It has STOPPED once the altitude has risen less than `stillRise` over the last `stillFor` seconds.
/// - Then `exitSteps` steps within `exitWithin` seconds is walking out: unlock. A rise that resumes (the
///   car stopped at another floor) goes back to riding from the same lowest point; no steps in time
///   gives up on it.
struct ElevatorDetector {
    struct Thresholds: Codable {
        var minRise = 3.5
        var rideWindow: TimeInterval = 90
        var maxRideSteps = 10
        var stillRise = 0.4
        var stillFor: TimeInterval = 5
        var exitSteps = 5
        var exitWithin: TimeInterval = 90
    }

    enum Event: Equatable {
        case none
        case unlock(rise: Double, rideSeconds: Double, stepsInRide: Int, stepsAfter: Int)
        case noExit(rise: Double, rideSeconds: Double, stepsInRide: Int)
        /// A ride down (a fall of `minRise` within `rideWindow` with at most `maxRideSteps` steps). Only
        /// recorded, for tuning; leaving is not acted on.
        case down(drop: Double)
    }

    private enum State {
        case idle
        case riding(start: TimeInterval, base: Double)
        case falling(top: Double)
        /// `steps` is the cumulative count when the ride ended; steps after it are counted from there.
        case ended(rideStart: TimeInterval, base: Double, at: TimeInterval, top: Double, steps: Int, stepsInRide: Int)
    }

    let t: Thresholds
    private(set) var alt: [(t: TimeInterval, m: Double)] = []
    private(set) var steps: [(t: TimeInterval, n: Int)] = []
    private var state = State.idle
    /// A ride that ended (unlocked or gave up) is not found again in the samples it was made of.
    private var since = -TimeInterval.infinity

    init(_ t: Thresholds = Thresholds()) { self.t = t }

    /// Where the rules stand, for the debug pane (`ElevatorUnlock.publish`). Read-only: nothing here
    /// changes what the detector does. `now` is the current time on the same clock as the samples.
    func status(now: TimeInterval) -> [String: Any] {
        let cur = alt.last?.m
        switch state {
        case .idle:
            return ["phase": "idle"]
        case let .riding(start, base):
            return ["phase": "riding", "base": base, "rise": (cur ?? base) - base, "since": now - start,
                    "steps_in_ride": steps(at: now) - steps(at: start)]
        case let .falling(top):
            return ["phase": "falling", "top": top, "drop": top - (cur ?? top)]
        case let .ended(rideStart, base, at, top, from, stepsInRide):
            return ["phase": "stopped", "base": base, "top": top, "rise": top - base, "ride_s": at - rideStart,
                    "steps_in_ride": stepsInRide, "steps_after": steps(at: now) - from, "steps_needed": t.exitSteps,
                    "left_s": max(0, t.exitWithin - (now - at))]
        }
    }

    /// Cumulative steps counted by time `at` (the last report at or before it).
    func steps(at time: TimeInterval) -> Int { steps.last(where: { $0.t <= time })?.n ?? 0 }

    /// Samples older than this are dropped: the detector runs for as long as he is near home.
    static let keep: TimeInterval = 15 * 60

    mutating func altitude(_ m: Double, at time: TimeInterval) -> Event {
        alt.append((time, m))
        if let first = alt.first, first.t < time - Self.keep - 60 { alt.removeAll { $0.t < time - Self.keep } }
        if let first = steps.first, first.t < time - Self.keep - 60 {
            // Keep the last count before the cut, so step differences across it stay right.
            let cut = time - Self.keep
            let last = steps.last(where: { $0.t < cut })
            steps.removeAll { $0.t < cut }
            if let last { steps.insert(last, at: 0) }
        }
        switch state {
        case .idle:
            let recent = alt.filter { $0.t >= max(time - t.rideWindow, since) }
            if let high = recent.max(by: { $0.m < $1.m }), high.m - m >= t.minRise,
               steps(at: time) - steps(at: high.t) <= t.maxRideSteps {
                state = .falling(top: high.m)
                return .none
            }
            guard let low = recent.min(by: { $0.m < $1.m }), m - low.m >= t.minRise,
                  steps(at: time) - steps(at: low.t) <= t.maxRideSteps else { return .none }
            state = .riding(start: low.t, base: low.m)
        case let .riding(start, base):
            // Still once the last `stillFor` seconds rose less than `stillRise`; needs that much history.
            guard let past = alt.last(where: { $0.t <= time - t.stillFor }), past.t >= start else { return .none }
            if m - past.m < t.stillRise {
                state = .ended(rideStart: start, base: base, at: time, top: m, steps: steps(at: time),
                               stepsInRide: steps(at: time) - steps(at: start))
            }
        case let .falling(top):
            // Recorded once the car has stopped going down, with the whole drop.
            guard let past = alt.last(where: { $0.t <= time - t.stillFor }), past.m - m < t.stillRise else { return .none }
            state = .idle; since = time
            return .down(drop: top - m)
        case let .ended(rideStart, base, at, top, _, stepsInRide):
            if m - top >= 1.0 { state = .riding(start: rideStart, base: base); return .none }
            if time - at > t.exitWithin {
                state = .idle; since = time
                return .noExit(rise: top - base, rideSeconds: at - rideStart, stepsInRide: stepsInRide)
            }
        }
        return .none
    }

    mutating func stepCount(_ n: Int, at time: TimeInterval) -> Event {
        steps.append((time, n))
        guard case let .ended(rideStart, base, at, top, from, stepsInRide) = state else { return .none }
        if time - at > t.exitWithin {
            state = .idle; since = time
            return .noExit(rise: top - base, rideSeconds: at - rideStart, stepsInRide: stepsInRide)
        }
        guard n - from >= t.exitSteps else { return .none }
        state = .idle; since = time
        return .unlock(rise: top - base, rideSeconds: at - rideStart, stepsInRide: stepsInRide, stepsAfter: n - from)
    }
}
