import SwiftUI

/// The front door, opened by the Door complication (`statushub://door`): the lock's state, read from
/// the hub as the sheet opens, and a tap on the glyph to lock or unlock (`DoorAPI`). The door's own
/// open/closed and the battery sit under it as bare labels.
struct DoorSheet: View {
    @State private var state: DoorAPI.State?
    @State private var busy = true
    @State private var failed = false

    var body: some View {
        VStack(spacing: 10) {
            Button(action: toggle) {
                ZStack {
                    if busy {
                        ProgressView()
                    } else {
                        Image(systemName: failed ? "exclamationmark.triangle.fill"
                              : (state?.locked ?? false) ? "lock.fill" : "lock.open.fill")
                            .font(.system(size: 56, weight: .semibold))
                            .foregroundStyle(failed ? .yellow : (state?.locked ?? false) ? .green : .orange)
                    }
                }
                .frame(width: 110, height: 110)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy || state == nil)
            if let s = state, !busy {
                Text(s.locked ? "Locked" : (s.lock == "jammed" ? "Jammed" : "Unlocked"))
                    .font(.headline)
                HStack(spacing: 8) {
                    if let d = s.door { Text(d == "opened" ? "Open" : "Closed") }
                    if let b = s.battery { Text("\(b)%") }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .task { await load() }
    }

    private func load() async {
        busy = true
        do { state = try await DoorAPI.get(); failed = false }
        catch { failed = true; Hub.log("door-read-failed", ["error": String(describing: error).prefix(120).description]) }
        busy = false
    }

    private func toggle() {
        guard let s = state else { return }
        busy = true
        Task {
            do { state = try await DoorAPI.set(locked: !s.locked); failed = false }
            catch { failed = true; Hub.log("door-set-failed", ["error": String(describing: error).prefix(120).description]) }
            busy = false
        }
    }
}
