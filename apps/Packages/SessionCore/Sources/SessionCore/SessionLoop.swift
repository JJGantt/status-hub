import Foundation
import Combine

/// What the rep watcher is armed to: the exercise and weight that give a reported
/// set its meaning.
public struct Armed: Sendable, Equatable {
    public let label: String
    public let exercise: String
    public let weight: Double?

    public init(label: String, exercise: String, weight: Double?) {
        self.label = label
        self.exercise = exercise
        self.weight = weight
    }
}

/// Everything the session does to the outside world. The watch passes haptics,
/// audio, uploads and reports; tests pass recorders.
public struct SessionEffects<Record: CountedRecord, Sample: Sendable> {
    public var locked: @MainActor () -> Void
    public var rep: @MainActor (Int) -> Void
    public var setEnded: @MainActor () -> Void
    public var release: @MainActor () -> Void
    /// Save a recording. `verdict` is nil for a discarded set.
    public var upload: @MainActor (_ samples: [Sample], _ verdict: Record?, _ armed: Armed?,
                                   _ cancelled: Bool) -> Void
    /// Report a finished set; `done` receives the report id, from any thread.
    public var report: @MainActor (_ record: Record, _ done: @escaping @Sendable (Int?) -> Void) -> Void
    public var correct: @MainActor (_ reportID: Int, _ reps: Int) -> Void
    public var remove: @MainActor (_ reportID: Int) -> Void
    /// Ask what is armed; `done` receives it, and whether the server answered at all,
    /// from any thread.
    public var checkArmed: @MainActor (_ done: @escaping @Sendable (Armed?, Bool) -> Void) -> Void

    public init(locked: @escaping @MainActor () -> Void,
                rep: @escaping @MainActor (Int) -> Void,
                setEnded: @escaping @MainActor () -> Void,
                release: @escaping @MainActor () -> Void,
                upload: @escaping @MainActor ([Sample], Record?, Armed?, Bool) -> Void,
                report: @escaping @MainActor (Record, @escaping @Sendable (Int?) -> Void) -> Void,
                correct: @escaping @MainActor (Int, Int) -> Void,
                remove: @escaping @MainActor (Int) -> Void,
                checkArmed: @escaping @MainActor (@escaping @Sendable (Armed?, Bool) -> Void) -> Void) {
        self.locked = locked
        self.rep = rep
        self.setEnded = setEnded
        self.release = release
        self.upload = upload
        self.report = report
        self.correct = correct
        self.remove = remove
        self.checkArmed = checkArmed
    }
}

/// Drives a `SetCounter` for a whole workout: pacing, threading, the list of logged
/// sets, and published state.
///
/// All the decisions — is this a set, has it ended, what is the count — live in the
/// counter. This class deliberately holds none of them.
///
/// The counter lives in a `CounterBox` actor, and every operation on it goes through
/// that actor, so a Stop or a Discard runs strictly after any pass already in flight
/// and acts on what that pass left. Results come back with a sequence number and the
/// box they came from: displayed state only moves forward, and a pass that finishes
/// after its session ended still has its sets logged but changes nothing on screen.
@MainActor
public final class SessionLoop<C: SetCounter>: ObservableObject {

    public enum Phase: Sendable { case off, armed, counting }

    /// A closed set plus the id of the report that logged it, so the wrist can still
    /// correct or remove it afterwards.
    public struct Logged: Identifiable {
        public let id = UUID()
        public let set: C.Record
        public var reportID: Int?
        /// What the +/- buttons have applied.
        public var adjust = 0
        public var removed = false
        public var reps: Int { max(1, set.count + adjust) }
    }

    @Published public private(set) var phase: Phase = .off
    @Published public private(set) var count = 0
    @Published public private(set) var sets: [Logged] = []
    /// What the set watcher is armed to, or nil when nothing is being logged.
    @Published public private(set) var armedAs: String?
    /// The last check could not reach the server at all. Distinct from "nothing is
    /// armed": one means arm it, the other means the watch is offline.
    @Published public private(set) var watcherUnreachable = false
    /// Cost of the last counting pass. On screen because the update rate has to be
    /// judged against real hardware rather than assumed.
    @Published public private(set) var lastPassMs: Double = 0

    /// The armed exercise and weight as separate values, so a capture records what it
    /// IS rather than only how it is displayed.
    private var armed: Armed?

    private let effects: SessionEffects<C.Record, C.Sample>
    private let makeCounter: @Sendable () -> C

    /// Floor between passes. Not a cadence — the next pass starts as soon as the last
    /// one finishes, and this only stops a fast watch from spinning.
    ///
    /// A fixed timer is worse than it looks: a tick that arrives while a pass is still
    /// running is dropped, so on hardware where a pass takes longer than the tick the
    /// real cadence silently doubles and every rep is announced late. Self-pacing
    /// cannot drift that way, and `lastPassMs` says what it actually costs.
    private let floor: Duration

    /// The watcher can be set, changed or allowed to expire while the app is running,
    /// so the badge is re-checked rather than read once.
    private let armedRecheck: TimeInterval = 15
    private var lastArmedCheck = Date.distantPast

    private var pull: @MainActor () -> [C.Sample] = { [] }
    /// The live session's counter. nil when off, and set to nil the moment Stop is
    /// pressed, which is what marks any pass still running as belonging to the past.
    private var box: CounterBox<C>?
    private var loop: Task<Void, Never>?
    /// Sequence number of the newest counter state shown.
    private var shownSeq = 0

    public init(effects: SessionEffects<C.Record, C.Sample>,
                makeCounter: @escaping @Sendable () -> C,
                floor: Duration = .milliseconds(200)) {
        self.effects = effects
        self.makeCounter = makeCounter
        self.floor = floor
    }

    /// True from `begin` until Stop is pressed.
    var isRunning: Bool { box != nil }

    public func begin(pull: @escaping @MainActor () -> [C.Sample]) {
        guard box == nil else { return }
        self.pull = pull
        let box = CounterBox(makeCounter())
        self.box = box
        shownSeq = 0
        count = 0
        sets = []
        phase = .armed
        // Ask straight away what the rep watcher is set to. Knowing whether sets are
        // being logged is only useful BEFORE lifting.
        refreshArmed()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                let started = ContinuousClock.now
                guard let self, await self.pass(box) else { return }
                try? await Task.sleep(until: started + self.floor, clock: .continuous)
            }
        }
    }

    /// One counting pass. False once this box's session is over.
    private func pass(_ box: CounterBox<C>) async -> Bool {
        guard self.box === box else { return false }
        if Date().timeIntervalSince(lastArmedCheck) > armedRecheck { refreshArmed() }
        let r = await box.ingest(pull())
        let live = self.box === box
        if live { lastPassMs = r.ms }
        show(r.state, live: live)
        for e in r.events { handle(e, live: live) }
        return self.box === box
    }

    /// Switch the session off. A set in progress is closed and, if it is a set, logged.
    public func end() async {
        guard let box else { return }
        self.box = nil
        loop?.cancel()
        let running = loop
        loop = nil
        // Runs after any pass already in flight, on what that pass left.
        let r = await box.finish()
        // Let that pass's own events land first: they happened before the Stop.
        await running?.value
        switch r.event {
        case .closed(let rec, let samples)?:
            // A set ended by pressing Stop is still a set: it uploads AND logs, the
            // same as one that closed on its own.
            effects.upload(samples, rec, armed, false)
            logClosed(rec)
            effects.setEnded()
        case .tooShort(let rec, let samples)?:
            // Too few reps to be a set. The recording is still kept: it is the only
            // labelled evidence of a false detection.
            effects.upload(samples, rec, armed, true)
        default:
            break
        }
        // Unless a new session has already started while this one was closing.
        guard self.box == nil else { return }
        effects.release()
        phase = .off
        count = 0
    }

    /// Throw away the set being counted right now, without stopping the session.
    ///
    /// Switching the whole session off and on again would clear the list of sets
    /// already done — losing a workout's worth of history to reject one bad set.
    ///
    /// The recording is still uploaded, marked cancelled. A set the counter recognised
    /// and the lifter rejected is a labelled false positive, and there is no other way
    /// to produce one.
    public func cancelCurrent() async {
        guard let box else { return }
        let r = await box.discard()
        effects.upload(r.samples, nil, armed, true)
        guard self.box === box else { return }
        show(r.state, live: true)
        effects.setEnded()
    }

    /// Add a set by hand, at whatever the watcher is armed to.
    ///
    /// For everything the wrist cannot see. It goes through the identical path a
    /// counted set takes, so it lands in the training log the same way and can be
    /// corrected or removed from the wrist afterwards.
    public func addManual(reps: Int) {
        guard reps > 0 else { return }
        logClosed(C.Record.manual(reps: reps))
    }

    /// The rep count of the last set that was not removed, or nil if there is none.
    /// What "repeat" repeats.
    public var lastReps: Int? { sets.last(where: { !$0.removed })?.reps }

    /// The +/- buttons: fix a count on the wrist.
    public func adjust(_ index: Int, by delta: Int) {
        guard sets.indices.contains(index), !sets[index].removed else { return }
        let next = max(1, sets[index].set.count + sets[index].adjust + delta)
        sets[index].adjust = next - sets[index].set.count
        if let id = sets[index].reportID { effects.correct(id, next) }
    }

    /// The X button: this was not a set.
    public func remove(_ index: Int) {
        guard sets.indices.contains(index) else { return }
        sets[index].removed = true
        if let id = sets[index].reportID { effects.remove(id) }
    }

    public func refreshArmed() {
        lastArmedCheck = Date()
        effects.checkArmed { [weak self] info, reachable in
            Task { @MainActor in
                guard let self else { return }
                self.watcherUnreachable = !reachable
                // A failed check leaves the last known arming in place rather than
                // blanking it: one timed-out request does not mean sets stopped being
                // recorded.
                guard reachable else { return }
                self.armed = info
                self.armedAs = info?.label
            }
        }
    }

    // MARK: -

    /// Show counter state, if it is this session's and newer than what is shown.
    private func show(_ s: CounterBox<C>.State, live: Bool) {
        guard live, s.seq > shownSeq else { return }
        shownSeq = s.seq
        count = s.count
        phase = s.isCounting ? .counting : .armed
    }

    /// Act on one counter event. A pass that outlived its session (`live` false) still
    /// logs and uploads what it closed — those sets happened — but announces nothing
    /// and changes nothing on screen.
    private func handle(_ e: CounterEvent<C.Record, C.Sample>, live: Bool) {
        switch e {
        case .committed:
            if live { effects.locked() }
        case .reps(let n):
            if live { effects.rep(n) }
        case .tooShort(let rec, let samples):
            // Not a set: nothing logged, nothing announced, no entry on the wrist. The
            // recording is still kept, marked cancelled.
            effects.upload(samples, rec, armed, true)
            if live { effects.release() }
        case .closed(let rec, let samples):
            // The log carries the counter's record, which can be one below what was
            // announced. The record is the authority, not the haptics.
            if live { count = rec.count }
            logClosed(rec)
            // Save the recording AND what produced its count. A wrong number is only
            // useful if the data behind it survives.
            effects.upload(samples, rec, armed, false)
            if live { effects.setEnded() }
        }
    }

    /// Record the set locally and report it, so it lands in the training log.
    private func logClosed(_ rec: C.Record) {
        let entry = Logged(set: rec, reportID: nil)
        sets.append(entry)
        let id = entry.id
        // Matched by id, not by position: the list can be replaced by a new session
        // before the report answers.
        effects.report(rec) { [weak self] reportID in
            Task { @MainActor in
                guard let self, let i = self.sets.firstIndex(where: { $0.id == id }) else { return }
                self.sets[i].reportID = reportID
            }
        }
        refreshArmed()
    }
}
