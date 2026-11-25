import Foundation

/// A finished set as the counter recorded it.
public protocol CountedRecord: Sendable {
    var count: Int { get }
    /// A set entered by hand, which goes through the same logging path as a counted one.
    static func manual(reps: Int) -> Self
}

/// What one call into the counter changed.
public enum CounterEvent<Record: CountedRecord, Sample: Sendable>: Sendable {
    /// A set was recognised, with this many reps already counted.
    case committed(Int)
    /// The running count advanced to this.
    case reps(Int)
    /// The set closed with this record, and these are the samples behind it.
    case closed(Record, [Sample])
    /// A set was recognised and then rejected. The samples still come back so the
    /// recording is kept, but it is not a logged set.
    case tooShort(Record, [Sample])
}

/// The counter `SessionLoop` drives: finds sets in a sample stream, counts them and
/// closes them, returning events rather than acting on them.
///
/// A value type, owned by exactly one `CounterBox` for the life of a session. Nothing
/// else holds a copy, which is what keeps a user's Stop or Discard from being
/// overwritten by a counting pass that was already running.
public protocol SetCounter: Sendable {
    associatedtype Sample: Sendable
    associatedtype Record: CountedRecord

    var count: Int { get }
    var isCounting: Bool { get }
    mutating func ingest(_ samples: [Sample]) -> [CounterEvent<Record, Sample>]
    /// Close whatever is in progress, e.g. when the session is switched off.
    mutating func finish() -> CounterEvent<Record, Sample>?
    /// Throw away the set in progress and return its samples.
    mutating func discard() -> [Sample]
}

/// Owns the counter. Every operation on it — a counting pass, Stop, Discard — runs
/// here, one at a time, in the order it arrived.
///
/// Each result carries a sequence number, so the main actor can tell a result that is
/// newer than what it has shown from one that arrived late.
actor CounterBox<C: SetCounter> {
    struct State: Sendable {
        let seq: Int
        let count: Int
        let isCounting: Bool
    }

    private var counter: C
    private var seq = 0

    /// A pass is long synchronous work, so the box runs on its own queue rather than
    /// holding one of the concurrency pool's few threads for the length of it.
    private let queue = DispatchSerialQueue(label: "SessionCore.counter", qos: .userInitiated)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    init(_ counter: C) { self.counter = counter }

    private func state() -> State {
        seq += 1
        return State(seq: seq, count: counter.count, isCounting: counter.isCounting)
    }

    func ingest(_ samples: [C.Sample]) -> (events: [CounterEvent<C.Record, C.Sample>], state: State, ms: Double) {
        let started = Date()
        let events = counter.ingest(samples)
        let ms = Date().timeIntervalSince(started) * 1000
        return (events, state(), ms)
    }

    func finish() -> (event: CounterEvent<C.Record, C.Sample>?, state: State) {
        let e = counter.finish()
        return (e, state())
    }

    func discard() -> (samples: [C.Sample], state: State) {
        let s = counter.discard()
        return (s, state())
    }
}
