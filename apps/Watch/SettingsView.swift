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
                // Bare glyphs on black, like every other control here: a system Slider draws its track
                // and buttons on grey plates.
                HStack(spacing: 0) {
                    Text("Volume")
                    Spacer()
                    Button { speaker.setVolume(speaker.volume - 10) } label: {
                        Image(systemName: "minus").frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .disabled(speaker.volume <= 10)
                    Text("\(speaker.volume)%")
                        .monospacedDigit()
                        .frame(minWidth: 52)
                    Button { speaker.setVolume(speaker.volume + 10) } label: {
                        Image(systemName: "plus").frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .disabled(speaker.volume >= 100)
                }
                .font(.system(size: 17))
                .padding(.top, 12)
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
