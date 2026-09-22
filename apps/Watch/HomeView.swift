import SwiftUI

/// The page the app opens on: the time, and the shared hub conversation cut down to what is happening
/// now — his words and the worker's newest step while a command runs, otherwise the newest reply. It
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

    /// The time as a watch face shows it: the wearer's 12- or 24-hour clock, no AM/PM, no leading zero.
    /// Built from the locale's own pattern because the FormatStyle hour options pad the hour on watchOS.
    private static let clock: DateFormatter = {
        let f = DateFormatter()
        let pattern = DateFormatter.dateFormat(fromTemplate: "jmm", options: 0, locale: .current) ?? "h:mm"
        f.dateFormat = pattern.replacingOccurrences(of: "a", with: "").trimmingCharacters(in: .whitespaces)
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TimelineView(.everyMinute) { ctx in
                VStack(alignment: .leading, spacing: 0) {
                    Text(Self.clock.string(from: ctx.date))
                        .font(.system(size: 46, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(ctx.date, format: .dateTime.weekday(.abbreviated).day())
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.gray)
                }
            }
            if !recording {
                now.opacity(dimmed ? 0.5 : 1)
            }
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
                    .lineLimit(3)
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
