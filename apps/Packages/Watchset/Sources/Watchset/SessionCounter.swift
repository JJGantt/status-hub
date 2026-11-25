import Foundation
import RepCounter
import SessionCore

/// The session loop the watch runs: `SessionLoop` from SessionCore, driving the rep
/// counter, with the watch's haptics, audio, uploads and reports as its effects.
///
/// All the decisions — is this a set, has it ended, what is the count — live in
/// `SessionMachine`. Everything around it (pacing, threading, the logged sets, what
/// happens when Stop or Discard lands mid-pass) lives in SessionCore, where it is
/// tested without the counter.
typealias SessionCounter = SessionLoop<RepCounterMachine>

/// `SessionMachine` as SessionCore sees it.
struct RepCounterMachine: SetCounter {
    /// A logged set: the counter's record, or one built for a set entered by hand.
    struct Verdict: CountedRecord {
        let counted: CountedSet
        var count: Int { counted.count }

        static func manual(reps: Int) -> Verdict {
            Verdict(counted: CountedSet(count: reps, startedAt: 0, endedAt: 0, seedSpread: 0,
                                    travelCm: 0, repEnds: [], repFired: [],
                                    algorithm: "manual"))
        }
    }

    private var machine = SessionMachine()

    var count: Int { machine.count }
    var isCounting: Bool { machine.phase == .counting }

    mutating func ingest(_ samples: [MotionSample]) -> [CounterEvent<Verdict, MotionSample>] {
        machine.ingest(samples).map(Self.event)
    }

    mutating func finish() -> CounterEvent<Verdict, MotionSample>? {
        machine.finish().map(Self.event)
    }

    mutating func discard() -> [MotionSample] { machine.discard() }

    private static func event(_ e: SessionMachine.Event) -> CounterEvent<Verdict, MotionSample> {
        switch e {
        case .committed(let n): return .committed(n)
        case .reps(let n): return .reps(n)
        case .closed(let rec, let samples): return .closed(Verdict(counted: rec), samples)
        case .tooShort(let rec, let samples): return .tooShort(Verdict(counted: rec), samples)
        }
    }
}

extension SessionLoop where C == RepCounterMachine {
    static func live() -> SessionCounter {
        let feedback = Feedback()
        let effects = SessionEffects<RepCounterMachine.Verdict, MotionSample>(
            locked: { feedback.locked() },
            rep: { feedback.rep($0) },
            setEnded: { feedback.setEnded() },
            release: { feedback.release() },
            upload: { samples, verdict, armed, cancelled in
                CaptureUploader.upload(samples, verdict: verdict?.counted,
                                       exercise: armed?.exercise, weightLbs: armed?.weight,
                                       cancelled: cancelled)
            },
            report: { rec, done in
                SetReporter.report(reps: rec.count, at: Date(), session: "watch",
                                   algorithm: rec.counted.algorithm, then: done)
            },
            correct: { SetReporter.correct(reportID: $0, reps: $1) },
            remove: { SetReporter.remove(reportID: $0) },
            checkArmed: { SetReporter.armedExercise(then: $0) })
        return SessionCounter(effects: effects, makeCounter: { RepCounterMachine() })
    }
}
