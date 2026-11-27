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
check(run(80, alt: { t in t < 20 ? 0 : t < 40 ? -(t - 20) * 0.5 : -10 }, steps: walkOut).isEmpty, "a ride down does nothing")
check(run(80, alt: { t in t < 20 ? 0 : t < 24 ? (t - 20) * 0.5 : 2 }, steps: walkOut).isEmpty, "a 2 m rise is not a ride")
check(run(80, alt: { _ in 0 }, steps: { t in Int(t) }).isEmpty, "walking on the flat does nothing")
// The car stops at floor 2 for 8 s, then carries on; nobody steps out at floor 2.
let stop = { (t: Double) in t < 20 ? 0 : t < 28 ? (t - 20) * 0.5 : t < 36 ? 4 : t < 48 ? 4 + (t - 36) * 0.5 : 10 }
let stopRide = run(100, alt: stop, steps: { t in t < 55 ? 3 : 3 + Int(t - 55) })
check(stopRide.count == 1, "a stop at another floor then the rest of the ride unlocks once")
if case let .unlock(r, _, _, _)? = stopRide.first { check(r >= 9.5, "the rise covers the whole ride, not the first leg") }

print(failures == 0 ? "all passed" : "\(failures) failed")
if failures > 0 { exit(1) }
