import SwiftUI

/// The page left of the sessions: the watch's own switches, reachable without Control Center.
/// Each one writes the same place its Control Center control and the hub's Settings do, so all three
/// always agree.
struct SettingsView: View {
    @ObservedObject private var speaker = Speaker.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Toggle("Speak", isOn: Binding(get: { speaker.on }, set: { Speaker.set($0) }))
                    .font(.system(size: 17))
            }
            .padding(.horizontal, 8)
            .padding(.top, Landing.top - 14)
        }
        .scrollIndicators(.never)
        .topOfTheScreen()
        .background(Color.black.ignoresSafeArea())
        // The Control Center control writes the flag from its own process, which this one does not hear.
        .onAppear { Speaker.reload() }
    }
}
