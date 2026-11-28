// The elevator ride rules (Sources/ElevatorDetector.swift). Run: apps/tests/run-elevator-detector.sh
import Foundation
var failures = 0
func check(_ ok: Bool, _ what: String) { if !ok { failures += 1; print("FAIL:", what) } else { print("ok:", what) } }

/// Feeds a scripted trace: altitude every second from `alt(t)`, steps from `steps(t)` every 2 s.
func run(_ seconds: Int, alt: (Double) -> Double, steps: (Double) -> Int) -> [ElevatorDetector.Event] {
    var d = ElevatorDetector()
    var out: [ElevatorDetector.Event] = []
    for i in 0...seconds {
        let t = Double(i)
        let a = d.altitude(alt(t), at: t); if a != .none { out.append(a) }
        if i % 2 == 0 { let s = d.stepCount(steps(t), at: t); if s != .none { out.append(s) } }
    }
    return out
}
// Elevator: flat until 20 s, up 10 m over 20 s standing still, then walks out from 45 s.
let rise = { (t: Double) in t < 20 ? 0 : t < 40 ? (t - 20) * 0.5 : 10 }
let walkOut = { (t: Double) in t < 45 ? 3 : 3 + Int(t - 45) }

let ride = run(80, alt: rise, steps: walkOut)
check(ride.count == 1, "a ride up then walking out unlocks once")
if case let .unlock(r, _, inRide, after)? = ride.first { check(r >= 9.5 && inRide <= 1 && after >= 5, "the unlock carries the rise and the steps") }
else { check(false, "the event is an unlock") }

check(run(80, alt: rise, steps: { _ in 3 }).allSatisfy { if case .unlock = $0 { return false }; return true },
      "a ride with no steps after it does not unlock")
check(run(200, alt: rise, steps: { _ in 3 }).contains { if case .noExit = $0 { return true }; return false },
      "a ride with no steps after it gives up as noExit")
check(run(80, alt: rise, steps: { t in Int(t * 1.8) }).isEmpty, "climbing stairs (steps all the way) is not a ride")
let down = run(80, alt: { t in t < 20 ? 0 : t < 40 ? -(t - 20) * 0.5 : -10 }, steps: walkOut)
check(down.count == 1 && { if case .down = down[0] { return true }; return false }(), "a ride down is recorded once and never unlocks")
check(run(80, alt: { t in t < 20 ? 0 : t < 24 ? (t - 20) * 0.5 : 2 }, steps: walkOut).isEmpty, "a 2 m rise is not a ride")
check(run(80, alt: { _ in 0 }, steps: { t in Int(t) }).isEmpty, "walking on the flat does nothing")
// The car stops at floor 2 for 8 s, then carries on; nobody steps out at floor 2.
let stop = { (t: Double) in t < 20 ? 0 : t < 28 ? (t - 20) * 0.5 : t < 36 ? 4 : t < 48 ? 4 + (t - 36) * 0.5 : 10 }
let stopRide = run(100, alt: stop, steps: { t in t < 55 ? 3 : 3 + Int(t - 55) })
check(stopRide.count == 1, "a stop at another floor then the rest of the ride unlocks once")
if case let .unlock(r, _, _, _)? = stopRide.first { check(r >= 9.5, "the rise covers the whole ride, not the first leg") }

// Hours near home: the buffers stay bounded and a ride after them still unlocks.
var long = ElevatorDetector()
var got: [ElevatorDetector.Event] = []
for i in 0...(4 * 3600) { let t = Double(i); _ = long.altitude(0, at: t); if i % 2 == 0 { _ = long.stepCount(i / 100, at: t) } }
for i in 0...80 {
    let t = Double(4 * 3600 + 1 + i)
    let e = long.altitude(rise(Double(i)), at: t); if e != .none { got.append(e) }
    if i % 2 == 0 { let s = long.stepCount(4 * 36 + walkOut(Double(i)), at: t); if s != .none { got.append(s) } }
}
check(long.alt.count < 1100, "four hours near home keep at most about fifteen minutes of samples")
check(got.count == 1 && { if case .unlock = got[0] { return true }; return false }(), "a ride after hours near home still unlocks")

// He walks 40 steps down the hall to the elevator, waits, then rides: the hallway steps are not the ride's.
let hallway = { (t: Double) in t < 15 ? Int(t * 2.5) : 40 }
let viaHall = run(80, alt: rise, steps: { t in t < 45 ? hallway(t) : 40 + Int(t - 45) })
check(viaHall.count == 1 && { if case .unlock = viaHall[0] { return true }; return false }(), "a walk to the elevator before the ride does not hide the ride")
let downHall = run(80, alt: { t in t < 20 ? 0 : t < 40 ? -(t - 20) * 0.5 : -10 }, steps: hallway)
check(downHall.count == 1 && { if case .down = downHall[0] { return true }; return false }(), "a walk to the elevator before a ride down does not hide it")

// The near-home trace's location accuracy (Sources/TracePolicy.swift).
typealias TP = TracePolicy
check(TP.mode(current: .low, activity: .walking, stationarySince: nil, now: 0) == .best, "walking switches to best accuracy at once")
check(TP.mode(current: .low, activity: .automotive, stationarySince: nil, now: 0) == .best, "driving switches to best accuracy at once")
check(TP.mode(current: .best, activity: .stationary, stationarySince: 100, now: 150) == .best, "a short stop keeps best accuracy")
check(TP.mode(current: .best, activity: .stationary, stationarySince: 100, now: 220) == .low, "two minutes stationary drops to low accuracy")
check(TP.mode(current: .low, activity: .stationary, stationarySince: 0, now: 10) == .low, "stationary at low stays low")
check(TP.mode(current: .best, activity: .unknown, stationarySince: nil, now: 0) == .best, "an unknown activity keeps the current mode")
check(TP.mode(current: .low, activity: .unknown, stationarySince: nil, now: 0) == .low, "an unknown activity keeps low too")

print(failures == 0 ? "all passed" : "\(failures) failed")
if failures > 0 { exit(1) }
