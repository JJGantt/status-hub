import SwiftUI

/// The page the app opens on: the shared hub conversation cut down to what is happening now — his
/// words and the worker's newest step while a command runs, otherwise the newest reply — over the
/// always-on listening toggle. It
/// records exactly as the prompt page does (the silence ends a command; double tap starts, locks,
/// sends) through the same `Chat` and the same microphone, so the two pages are two views of one
/// command. A tap on the reply opens the prompt page, one to the right, where the whole thread is.
struct HomeView: View {
    let openThread: () -> Void
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    /// Wrist down with the app still showing: everything but the time steps back.
    @Environment(\.isLuminanceReduced) private var dimmed

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            listenToggle
            now.opacity(dimmed ? 0.5 : 1)
            Spacer(minLength: 0)
            CommandStatus()
        }
        .padding(.horizontal, 8)
        .padding(.bottom, BottomControl.fade)   // clear of the bottom control
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay {
            BottomControl(mode: recording ? .stop : .record, enabled: recording || !chat.waiting,
                          holdsDoubleTap: !(recording && capture.lockHoldsDoubleTap), action: press)
        }
        .background(Color.black.ignoresSafeArea())
        .recordsWhenAsked()
    }

    /// Always-on listening: off, engaged, or hearing someone. The watch is a listener among the room
    /// mics while it is on, so this is the one control that changes what the watch does when nobody is
    /// touching it.
    private var listenToggle: some View {
        Button(action: chat.toggleListening) {
            Image(systemName: capture.listens ? "waveform" : "waveform.slash")
                .font(.system(size: 14, weight: .semibold))
                .frame(maxWidth: .infinity)
        }
        .tint(capture.hearing ? .red : capture.listens ? .orange : .gray)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .frame(width: 54)
    }

    /// His words while the hub works on them, with the worker's newest step under them; otherwise the
    /// newest reply, opening the whole thread when tapped.
    @ViewBuilder private var now: some View {
        if let words = chat.pending {
            VStack(alignment: .leading, spacing: 3) {
                Text(words)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.gray)
                    .lineLimit(2)
                if let step = chat.activity.last {
                    Text(step.text)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.gray)
                        .lineLimit(1)
                }
            }
        } else if let reply = chat.thread.last(where: { $0.role != "user" })?.text, !reply.isEmpty {
            Button(action: openThread) {
                Text(snippet(reply))
                    .font(.system(size: 13))
                    .foregroundColor(.white)
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
    }

    private func press() {
        Hub.log("control", ["view": "home", "mode": recording ? "stop" : "record"])
        chat.toggleRecording()
    }
}
