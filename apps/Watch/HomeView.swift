import SwiftUI
import WatchKit

/// The page the app opens on, and the only one the conversation lives on: the last ten exchanges of
/// the shared hub thread in full — his words as they were transcribed, the reply as it was written —
/// with the control at the bottom edge carrying the command and the x beside it throwing one away.
///
/// **A command walks the page.** The press sends it and the wrist is tapped; the control turns to the
/// spinner and the x appears; the transcript lands in the thread and the view settles on the top of
/// it, with the spinner bigger now that the hub is running the command rather than hearing it; the
/// reply lands, the view settles on the top of THAT, the control is a microphone again and the x goes.
/// A reply is read from its first line, which is why each of those lands the view on a top rather than
/// scrolling to the end.
struct HomeView: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    /// Wrist down with the app still showing.
    @Environment(\.isLuminanceReduced) private var dimmed
    /// Whether the view is held at `target`. Kept until he scrolls himself: a thread still laying out
    /// moves the spot, so a single jump lands short of it.
    @State private var pinned = true

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(chat.recent) { m in
                        ThreadRow(text: m.text ?? "", user: m.role == "user", session: m.session_id != nil)
                            .id(m.id)
                    }
                    // What the hub heard, until the turn itself lands in the thread.
                    if let words = chat.pending {
                        ThreadRow(text: words, user: true).id("pending")
                    }
                    if !chat.activity.isEmpty {
                        ActivityLines(lines: chat.activity)
                    }
                    CommandStatus()
                    // Room under the conversation for the newest thing in it to rise to the TOP of the
                    // screen. Without it the view stops at the end of the content, which on a short
                    // thread leaves the transcript or the reply stranded mid-screen — and a reply is
                    // read from its first line.
                    Color.clear.frame(height: WKInterfaceDevice.current().screenBounds.height * 0.8).id("tail")
                }
                .padding(.horizontal, 8)
                .padding(.bottom, BottomControl.height)
                .frame(maxWidth: .infinity, alignment: .leading)
                .opacity(dimmed ? 0.6 : 1)
                // The whole page records under a finger, as the thread always has: a tap starts a
                // command, the next locks it, the next sends it.
                .contentShape(Rectangle())
                .onTapGesture {
                    Capture.trigger = "tap"
                    chat.press()
                }
            }
            .scrollIndicators(.never)
            .background(Color.black.ignoresSafeArea())
            .overlay {
                BottomControl(mode: mode, enabled: recording || !chat.waiting, action: press,
                              onHold: { if !recording { chat.toggleListening() } },
                              cancel: cancel, big: true)
            }
            .onChange(of: target) { _, _ in
                pinned = true
                jump(proxy, animated: true)
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                if pinned { jump(proxy) }
            }
            .onScrollPhaseChange { _, now in
                if now == .interacting || now == .tracking { pinned = false }
            }
            .onAppear { jump(proxy) }
        }
        .recordsWhenAsked()
        // **The system clock, hidden.** `persistentSystemOverlays(.hidden)` is what does it on watchOS —
        // the invisible-`VideoPlayer` trick that is passed around does nothing, and a toolbar item only
        // moves the time to the other end of the strip. The page draws no clock of its own: what it is
        // for is the conversation, and the watch face is one press of the crown away.
        .persistentSystemOverlays(.hidden)
    }

    /// Where the view settles: the top of his words while they are being worked on, otherwise the top
    /// of the newest thing in the thread.
    private var target: String? {
        chat.pending != nil ? "pending" : chat.recent.last?.id
    }

    private func jump(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard let target else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .top) }
        } else {
            proxy.scrollTo(target, anchor: .top)
        }
    }

    /// What the microphone and the command are doing, in one glyph at the bottom edge: idle, always-on
    /// listening, recording a command the silence will end, that recording locked open, or the spinner
    /// while the hub has it — small while it is only being transcribed, and bigger once the worker is
    /// running the command, which is the part worth waiting through.
    private var mode: BottomControl.Mode {
        if recording { return .glyph(capture.locked ? "lock.fill" : "lock.open", .red) }
        if chat.waiting { return .working(running: chat.pending != nil) }
        return .glyph(capture.listens ? "waveform" : "mic.fill", capture.listens ? .orange : .gray)
    }

    /// There is something to throw away: the recording, or the command the hub still has.
    private var cancel: (() -> Void)? {
        if recording { return chat.cancelRecording }
        if chat.waiting { return chat.cancel }
        return nil
    }

    private func press() {
        Hub.log("control", ["view": "home", "recording": recording, "locked": capture.locked])
        Capture.trigger = "press"
        chat.press()
    }
}
