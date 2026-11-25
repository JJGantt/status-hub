import Foundation
import Testing
@testable import SessionCore

// The session loop against a scripted counter. Samples are commands: a positive
// number sets the count and starts a set, 0 closes the set at its current count, and
// `hold` makes that pass wait inside the counter until the test releases it, which
// is how a Stop or a Discard is made to land in the middle of a pass.

let hold = -1

struct Record: CountedRecord {
    let count: Int
    let manual: Bool
    static func manual(reps: Int) -> Record { Record(count: reps, manual: true) }
}

/// Lets a test hold a counting pass open. Thread-safe: the counter runs on the
/// box's actor, the test on the main actor.
final class Gate: @unchecked Sendable {
    private let entered = DispatchSemaphore(value: 0)
    private let released = DispatchSemaphore(value: 0)

    func block() {
        entered.signal()
        released.wait()
    }

    /// Wait, without holding the main actor, until a pass is blocked in the counter.
    func waitEntered() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                self.entered.wait()
                c.resume()
            }
        }
    }

    func release() { released.signal() }
}

struct ScriptedCounter: SetCounter {
    let gate: Gate
    var count = 0
    var isCounting = false
    private var held: [Int] = []

    init(gate: Gate) { self.gate = gate }

    mutating func ingest(_ samples: [Int]) -> [CounterEvent<Record, Int>] {
        var events: [CounterEvent<Record, Int>] = []
        for s in samples {
            if s == hold { gate.block(); continue }
            held.append(s)
            if s > 0 {
                events.append(isCounting ? .reps(s) : .committed(s))
                count = s
                isCounting = true
            } else if s == 0, isCounting {
                events.append(count >= 6 ? .closed(Record(count: count, manual: false), held)
                                         : .tooShort(Record(count: count, manual: false), held))
                count = 0
                isCounting = false
                held = []
            }
        }
        return events
    }

    mutating func finish() -> CounterEvent<Record, Int>? {
        guard isCounting, count > 0 else { return nil }
        defer { count = 0; isCounting = false; held = [] }
        let rec = Record(count: count, manual: false)
        return count >= 6 ? .closed(rec, held) : .tooShort(rec, held)
    }

    mutating func discard() -> [Int] {
        guard isCounting else { return [] }
        defer { count = 0; isCounting = false; held = [] }
        return held
    }
}

/// Stands in for the watch: what was pulled, reported, uploaded and corrected.
@MainActor
final class World {
    var queue: [[Int]] = []
    var reports: [Record] = []
    var uploads: [(count: Int?, cancelled: Bool)] = []
    var corrections: [(id: Int, reps: Int)] = []
    var removals: [Int] = []
    let gate = Gate()
    private var nextReport = 100

    func feed(_ samples: [Int]) { queue.append(samples) }

    func session() -> SessionLoop<ScriptedCounter> {
        let gate = gate
        let effects = SessionEffects<Record, Int>(
            locked: {}, rep: { _ in }, setEnded: {}, release: {},
            upload: { [unowned self] _, verdict, _, cancelled in
                uploads.append((verdict?.count, cancelled))
            },
            report: { [unowned self] rec, done in
                reports.append(rec)
                nextReport += 1
                done(nextReport)
            },
            correct: { [unowned self] id, reps in corrections.append((id, reps)) },
            remove: { [unowned self] id in removals.append(id) },
            checkArmed: { done in done(nil, true) })
        let loop = SessionLoop(effects: effects, makeCounter: { ScriptedCounter(gate: gate) },
                               floor: .milliseconds(5))
        return loop
    }

    func pull() -> [Int] { queue.isEmpty ? [] : queue.removeFirst() }
}

/// Wait until `condition` holds; fails the test after `seconds`.
@MainActor
func until(_ seconds: Double = 5, _ condition: () -> Bool,
           sourceLocation: SourceLocation = #_sourceLocation) async {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() {
        if Date() > deadline {
            Issue.record("timed out", sourceLocation: sourceLocation)
            return
        }
        try? await Task.sleep(for: .milliseconds(2))
    }
}

@MainActor
@Suite struct SessionLoopTests {

    @Test func setIsFoundCountedClosedAndLoggedOnce() async {
        let w = World()
        let s = w.session()
        s.begin(pull: w.pull)
        #expect(s.phase == .armed)

        w.feed([3, 5])
        await until { s.phase == .counting && s.count == 5 }

        w.feed([8, 0])
        await until { s.phase == .armed && s.sets.count == 1 }
        #expect(w.reports.map(\.count) == [8])
        #expect(w.uploads.count == 1 && w.uploads[0].count == 8 && !w.uploads[0].cancelled)
        await until { s.sets[0].reportID != nil }

        // A detection the counter rejects is uploaded as cancelled and never logged.
        w.feed([2, 4, 0])
        await until { w.uploads.count == 2 }
        #expect(w.uploads[1].cancelled)
        #expect(s.sets.count == 1)

        // Wrist edits act on the report the set was logged as.
        s.adjust(0, by: 1)
        s.remove(0)
        #expect(w.corrections.map(\.reps) == [9])
        #expect(w.removals == [s.sets[0].reportID!])
        #expect(s.lastReps == nil)

        await s.end()
        #expect(s.phase == .off)
        #expect(w.reports.count == 1)
    }

    @Test func manualSetIsLoggedThroughTheSamePath() async {
        let w = World()
        let s = w.session()
        s.begin(pull: w.pull)
        s.addManual(reps: 12)
        s.addManual(reps: 0)
        #expect(w.reports.map(\.count) == [12])
        #expect(w.reports[0].manual)
        #expect(s.lastReps == 12)
        await s.end()
        // Manual sets carry no recording.
        #expect(w.uploads.isEmpty)
    }

    /// Stop pressed while a pass that closes the set is still running. The set is
    /// logged exactly once, and the session stays off.
    @Test func stopDuringAPassThatClosesTheSetLogsItOnce() async {
        let w = World()
        let s = w.session()
        s.begin(pull: w.pull)
        w.feed([7])
        await until { s.count == 7 }

        w.feed([9, 0, hold])
        await w.gate.waitEntered()
        let stop = Task { await s.end() }
        await until { !s.isRunning }
        w.gate.release()
        await stop.value

        #expect(w.reports.map(\.count) == [9])
        #expect(s.sets.count == 1)
        #expect(s.phase == .off)
        #expect(s.count == 0)
    }

    /// Stop pressed while a pass is running inside an open set. Stop closes what that
    /// pass left, and the finished pass cannot bring the set back.
    @Test func stopDuringAPassClosesWhatThePassLeft() async {
        let w = World()
        let s = w.session()
        s.begin(pull: w.pull)
        w.feed([7])
        await until { s.count == 7 }

        w.feed([9, hold])
        await w.gate.waitEntered()
        let stop = Task { await s.end() }
        await until { !s.isRunning }
        w.gate.release()
        await stop.value

        #expect(w.reports.map(\.count) == [9])
        #expect(s.phase == .off)
    }

    /// Discard pressed while a pass is running. The finished pass cannot bring the
    /// discarded set back, so it is never logged.
    @Test func discardDuringAPassIsNotUndone() async {
        let w = World()
        let s = w.session()
        s.begin(pull: w.pull)
        w.feed([7])
        await until { s.count == 7 }

        w.feed([9, hold])
        await w.gate.waitEntered()
        let discard = Task { await s.cancelCurrent() }
        // Let Discard reach the counter's queue behind the held pass.
        try? await Task.sleep(for: .milliseconds(20))
        w.gate.release()
        await discard.value
        await until { s.phase == .armed }

        // Give the loop a few more passes; nothing may revive the set.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(s.phase == .armed)
        #expect(s.count == 0)
        await s.end()
        #expect(w.reports.isEmpty)
        #expect(w.uploads.count == 1 && w.uploads[0].count == nil && w.uploads[0].cancelled)
    }
}
