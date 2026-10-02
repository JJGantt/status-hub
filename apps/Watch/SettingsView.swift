import SwiftUI

/// The page left of the sessions: how a reply sounds when it is played (`SessionView.playButton`).
/// Each setting writes the same place the hub's Settings page does, so the two always agree.
struct SettingsView: View {
    @ObservedObject private var speaker = Speaker.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Bare text, highlighted by colour rather than a filled plate: which route keeps the
                // app alive with the wrist down while it speaks (`Speaker`'s header has the tradeoffs).
                // Stacked, not a trailing row: "Now Playing" needs more width than the right half of a
                // row leaves it, and wrapping it to two lines looks broken.
                VStack(alignment: .leading, spacing: 6) {
                    Text("Route").font(.system(size: 17))
                    HStack(spacing: 20) {
                        routeButton("Hold mic", .hold)
                        routeButton("Now Playing", .nowPlaying)
                    }
                    .font(.system(size: 14))
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, Landing.top - 14)
        }
        .scrollIndicators(.never)
        .topOfTheScreen()
        .background(Color.black.ignoresSafeArea())
    }

    private func routeButton(_ label: String, _ route: SpeechRoute) -> some View {
        Button { speaker.setRoute(route) } label: {
            Text(label).font(.system(size: 13, weight: speaker.route == route ? .semibold : .regular))
        }
        .buttonStyle(.plain)
        .foregroundColor(speaker.route == route ? .white : .gray)
    }
}
