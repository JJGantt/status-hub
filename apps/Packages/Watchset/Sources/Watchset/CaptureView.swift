import SwiftUI
import RepCounter
import SessionCore

/// Records a set WITHOUT counting it — how new reference recordings get made.
///
/// The recording is uploaded on stop, labelled with whatever the rep watcher is armed
/// to. It reports no rep count and creates no logged set: this mode exists to capture
/// a movement the algorithm should be measured against, not to add training data.
///
/// It previously assigned the finished samples to a local array and dropped them. A
/// recording made here reached the quality summary and went no further, which made the
/// whole mode silently useless — the thing it exists to produce was never produced.
struct CaptureView: View {
    @StateObject private var capture = CaptureManager()
    @ObservedObject private var keepAlive = KeepAlive.shared
    @State private var armed: Armed?
    @State private var uploaded = false

    var body: some View {
        VStack(spacing: 10) {
            if capture.isRecording {
                Text(capture.elapsed, format: .number.precision(.fractionLength(0)))
                    .font(.system(size: 40, weight: .semibold, design: .rounded))
                    .contentTransition(.numericText())
                Text("\(capture.sampleCount) samples")
                    .font(.caption2).foregroundStyle(.secondary)

                // Whether the app is actually being kept alive is the single thing
                // that decides if this recording is usable, so it is on screen the
                // whole time rather than discovered afterwards.
                Label(keepAlive.isHolding ? "Protected" : "NOT PROTECTED",
                      systemImage: keepAlive.isHolding ? "checkmark.shield.fill" : "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(keepAlive.isHolding ? .green : .red)

                Button("Stop") {
                    Task {
                        let samples = await capture.stop()
                        CaptureUploader.upload(samples, verdict: nil,
                                               exercise: armed?.exercise,
                                               weightLbs: armed?.weight)
                        uploaded = samples.count > 8
                    }
                }
                .tint(.red)
            } else if let q = capture.quality {
                summary(q)
            } else {
                Button {
                    Task {
                        uploaded = false
                        await capture.start()
                    }
                } label: {
                    Label("Start set", systemImage: "record.circle")
                }
                .tint(.green)

                // What the recording will be labelled as. A capture that lands
                // unlabelled is far less useful than one that names its movement, so
                // this is on screen BEFORE recording rather than discovered after.
                Text(armed.map { "labels as \($0.label)" } ?? "no exercise armed")
                    .font(.caption2)
                    .foregroundStyle(armed == nil ? .orange : .secondary)
            }

            if let f = capture.lastFailure {
                Text(f).font(.caption2).foregroundStyle(.red)
            }
        }
        .padding()
        .navigationTitle("Capture")
        .task {
            SetReporter.armedExercise { a, _ in
                Task { @MainActor in armed = a }
            }
        }
    }

    @ViewBuilder
    private func summary(_ q: CaptureQuality) -> some View {
        VStack(spacing: 6) {
            if q.isDegraded {
                Text("\(Int(q.missingFraction * 100))% OF SET LOST")
                    .font(.caption.weight(.bold)).foregroundStyle(.red)
            } else {
                Text("Complete").font(.caption.weight(.bold)).foregroundStyle(.green)
            }
            Text("\(q.sampleCount) samples · \(q.effectiveHz, format: .number.precision(.fractionLength(0))) Hz")
                .font(.caption2).foregroundStyle(.secondary)
            Text("\(q.spanSeconds, format: .number.precision(.fractionLength(1)))s")
                .font(.caption2).foregroundStyle(.secondary)
            // Whether it actually left the watch. A queued upload retries, but a
            // recording that was never handed over at all is simply gone.
            Text(uploaded ? "saved" : "NOT SAVED")
                .font(.caption2.weight(.bold))
                .foregroundStyle(uploaded ? .green : .red)
        }
    }
}
