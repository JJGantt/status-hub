import SwiftUI

/// Enter a set by hand, at whatever the rep watcher is armed to.
///
/// The counter can only see movements the wrist takes part in. A leg press, a seated
/// calf raise, a hip abduction — the arm holds still and there is nothing to measure,
/// and no amount of work on the algorithm will change that. Those sets still belong in
/// the training log, so they get typed in.
///
/// It reuses the armed exercise and weight rather than asking for them, because that is
/// already how every counted set gets its meaning; a set entered here is the same kind
/// of thing as a set counted, differing only in where the number came from.
struct ManualSetView: View {
    let armedAs: String?
    let commit: (Int) -> Void

    /// Ten is where a set lands more often than anywhere else, and the crown scrolls
    /// away from it fast in either direction.
    @State private var reps = 10

    var body: some View {
        VStack(spacing: 8) {
            Text(armedAs ?? "nothing armed")
                .font(.caption2)
                .foregroundStyle(armedAs == nil ? .orange : .secondary)
                .lineLimit(1)

            // The digital crown, not +/- buttons: going from 10 to 25 is one motion
            // rather than fifteen taps.
            Text("\(reps)")
                .font(.system(size: 56, weight: .bold, design: .rounded))
                .contentTransition(.numericText())
                .focusable()
                .digitalCrownRotation(repsDouble, from: 1, through: 100, by: 1,
                                      sensitivity: .medium, isContinuous: false)

            HStack(spacing: 8) {
                Button { reps = max(1, reps - 1) } label: { Image(systemName: "minus") }
                    .buttonStyle(.bordered).controlSize(.mini)
                Button { reps = min(100, reps + 1) } label: { Image(systemName: "plus") }
                    .buttonStyle(.bordered).controlSize(.mini)
            }

            // Nothing armed means the set is reported but never becomes training data,
            // so say that here rather than let it silently vanish.
            Button(armedAs == nil ? "Add anyway" : "Add set") { commit(reps) }
                .tint(armedAs == nil ? .orange : .green)
                .font(.caption)
        }
        .padding()
    }

    /// The crown works in Double; the count is an Int. Bridged here so the rounding
    /// happens in one place and the two cannot drift apart.
    private var repsDouble: Binding<Double> {
        Binding(get: { Double(reps) },
                set: { reps = max(1, min(100, Int($0.rounded()))) })
    }
}
