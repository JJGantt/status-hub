import SwiftUI

/// One switch for the whole workout.
///
/// Not a set timer — turn it on and leave it on. Sets are found inside the stream,
/// counted, closed when they end, and logged; then it re-arms for whatever comes
/// next, which may be a completely different exercise.
struct SessionView: View {
    @StateObject private var capture = CaptureManager()
    @ObservedObject private var keepAlive = KeepAlive.shared
    @StateObject private var session = SessionCounter.live()
    @State private var showManual = false

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                switch session.phase {
                case .off:      idle
                case .armed:    armed
                case .counting: counting
                }

                if session.phase != .off { watcherBadge }
                if !session.sets.isEmpty { log }

                if let f = capture.lastFailure {
                    Text(f).font(.caption2).foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Watchset")
        .sheet(isPresented: $showManual) {
            ManualSetView(armedAs: session.armedAs) { reps in
                session.addManual(reps: reps)
                showManual = false
            }
        }
    }

    private var idle: some View {
        Button {
            Task {
                await capture.start()
                if capture.isRecording {
                    session.begin(pull: { [capture] in capture.drain() })
                }
            }
        } label: {
            Label("Start", systemImage: "power")
        }
        .tint(.green)
    }

    private var armed: some View {
        VStack(spacing: 6) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.title2)
                .foregroundStyle(.green)
                .symbolEffect(.variableColor.iterative)
            Text("watching")
                .font(.caption).foregroundStyle(.secondary)
            protection
            // Only offered between sets: adding a set by hand while one is being
            // counted would put two sets in the log for one piece of lifting.
            HStack(spacing: 6) {
                Button {
                    showManual = true
                } label: {
                    Label("Add", systemImage: "plus.circle")
                }
                .tint(.blue)

                // Straight sets are the common case — the same number again, and
                // again. Dialling it in each time is the same work repeated, so the
                // last count is one tap. Hidden until there IS a last count.
                if let last = session.lastReps {
                    Button {
                        session.addManual(reps: last)
                    } label: {
                        Label("\(last)", systemImage: "arrow.clockwise")
                    }
                    .tint(.indigo)
                }
            }
            .font(.caption)
            stopButton
        }
    }

    private var counting: some View {
        VStack(spacing: 2) {
            Text("\(session.count)")
                .font(.system(size: 64, weight: .bold, design: .rounded))
                .contentTransition(.numericText())
                .animation(.snappy, value: session.count)
            Text("reps").font(.caption2).foregroundStyle(.secondary)
            protection
            // Reject THIS set without switching the session off. Turning the session
            // off and on again was the only way to do it before, and that clears the
            // list of sets already done.
            Button("Discard set") { Task { await session.cancelCurrent() } }
                .tint(.orange)
                .font(.caption)
            stopButton
        }
    }

    /// Whether the app is being kept alive decides whether any of this works, so it
    /// is visible while it matters rather than discovered afterwards.
    @ViewBuilder
    private var protection: some View {
        if !keepAlive.isHolding {
            Label("NOT PROTECTED", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2).foregroundStyle(.red)
        }
    }

    private var stopButton: some View {
        Button("Stop") {
            Task {
                await session.end()
                _ = await capture.stop()
            }
        }
        .tint(.red)
        .font(.caption)
    }

    private var log: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            // Newest first — the set just finished is the one being checked.
            ForEach(Array(session.sets.enumerated().reversed()), id: \.element.id) { i, s in
                HStack(spacing: 6) {
                    Text("\(s.reps)")
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                        .frame(width: 30, alignment: .trailing)
                        .strikethrough(s.removed)
                        .foregroundStyle(s.removed ? .secondary : .primary)
                    Text("reps").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    if !s.removed {
                        // A miscount is fixed on the wrist rather than remembered
                        // until later. These edit the report, which edits the log.
                        Button { session.adjust(i, by: -1) } label: { Image(systemName: "minus") }
                            .buttonStyle(.bordered).controlSize(.mini)
                        Button { session.adjust(i, by: 1) } label: { Image(systemName: "plus") }
                            .buttonStyle(.bordered).controlSize(.mini)
                        Button { session.remove(i) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.bordered).controlSize(.mini).tint(.red)
                    }
                }
            }
        }
    }

    /// What the set watcher is armed to. If nothing is, counted sets are NOT being
    /// logged, and the lifter should know that while there is still time to arm it.
    @ViewBuilder
    private var watcherBadge: some View {
        if session.watcherUnreachable {
            // Not the same as nothing being armed, and not the same reaction either.
            Label("can't reach server", systemImage: "wifi.exclamationmark")
                .font(.caption2).foregroundStyle(.orange).lineLimit(1)
        } else if let a = session.armedAs {
            Label(a, systemImage: "checkmark.circle.fill")
                .font(.caption2).foregroundStyle(.green).lineLimit(1)
        } else {
            Label("not logging", systemImage: "circle.dashed")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
}
