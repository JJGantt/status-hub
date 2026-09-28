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
                // Bare text, highlighted by colour rather than a filled plate: which route keeps the
                // app alive with the wrist down while it speaks (`Speaker`'s header has the tradeoffs).
                // Stacked, not a trailing row like Volume: "Now Playing" needs more width than the
                // right half of the row leaves it, and wrapping it to two lines looks broken.
                VStack(alignment: .leading, spacing: 6) {
                    Text("Route").font(.system(size: 17))
                    HStack(spacing: 20) {
                        routeButton("Hold mic", .hold)
                        routeButton("Now Playing", .nowPlaying)
                    }
                    .font(.system(size: 14))
                }
                .padding(.top, 16)
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

    private func routeButton(_ label: String, _ route: SpeechRoute) -> some View {
        Button { speaker.setRoute(route) } label: {
            Text(label).font(.system(size: 13, weight: speaker.route == route ? .semibold : .regular))
        }
        .buttonStyle(.plain)
        .foregroundColor(speaker.route == route ? .white : .gray)
    }
}
