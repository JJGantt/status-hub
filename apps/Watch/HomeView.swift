import SwiftUI

/// The page the app opens on: the shared hub conversation cut down to what is happening now — his
/// words and the worker's newest step while a command runs, otherwise the newest reply. It records
/// exactly as the prompt page does (the silence ends a command; double tap starts, locks, sends)
/// through the same `Chat` and the same microphone, so the two pages are two views of one command. A
/// tap on the reply opens the prompt page, one to the right, where the whole thread is.
///
/// **Everything the microphone and the command are doing is in the one glyph** at the top right. The
/// page carries nothing else: no second indicator of a state the glyph already holds, and no Retry —
/// a command that failed is handled on the prompt page, which shows the whole of it.
struct HomeView: View {
    let openThread: () -> Void
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    /// Wrist down with the app still showing: everything but the time steps back.
    @Environment(\.isLuminanceReduced) private var dimmed

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            now.opacity(dimmed ? 0.5 : 1)
            Spacer(minLength: 0)
            controls
        }
        .padding(.horizontal, 8)
        .padding(.bottom, BottomControl.fade)   // clear of the bottom control
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay {
            BottomControl(mode: recording ? .stop : .record, enabled: recording || !chat.waiting,
                          holdsDoubleTap: !(recording && capture.lockHoldsDoubleTap), action: press)
        }
        .background(Color.black.ignoresSafeArea())
        // The state glyph goes in the toolbar, which moves the system clock to the middle of the strip
        // and leaves the top right — the only way to put anything in that strip, since watchOS draws the
        // time over every app and offers no way to hide it.
        .toolbar { ToolbarItem(placement: .topBarTrailing) { state } }
        .recordsWhenAsked()
    }

    /// The recording bar while a command records (the lock and Cancel), and Cancel alone across the
    /// bottom while the hub has it. Nothing at all otherwise.
    @ViewBuilder private var controls: some View {
        if recording {
            RecordingBar(cancel: chat.cancelRecording)
        } else if chat.waiting {
            Button("Cancel", action: chat.cancel)
                .tint(.red)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .frame(maxWidth: .infinity)
        }
    }

    /// What the microphone and the command are doing, in one glyph, wherever the page is looked at:
    /// idle, always-on listening, recording a command the silence will end, that recording locked open,
    /// or — as the spinner itself — the hub transcribing and running what was sent. A tap engages or
    /// drops always-on listening; during a recording it does nothing, since the recording has its own
    /// controls.
    private var state: some View {
        Button(action: { if !recording { chat.toggleListening() } }) {
            if chat.waiting {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: symbol).foregroundColor(colour)
            }
        }
        .buttonStyle(.plain)
    }

    private var symbol: String {
        if recording { return capture.locked ? "lock.fill" : "mic.fill" }
        return capture.listens ? "waveform" : "waveform.slash"
    }

    private var colour: Color {
        if recording { return .red }
        return capture.listens ? .orange : .gray
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
