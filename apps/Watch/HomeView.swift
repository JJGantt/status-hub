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
                VStack(alignment: .leading, spacing: Landing.top) {
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
                }
                .padding(.horizontal, 8)
                .padding(.bottom, PageInset.bottom)
                .frame(maxWidth: .infinity, alignment: .leading)
                .opacity(dimmed ? 0.6 : 1)
                // The whole page records under a finger, as the thread always has. The lock is its
                // own mark on the bar now, so a tap is only ever start or send.
                .contentShape(Rectangle())
                .onTapGesture {
                    Capture.trigger = "tap"
                    if recording { chat.stopRecording() } else { chat.startRecording() }
                }
            }
            .scrollIndicators(.never)
            .topOfTheScreen(scrollTop: Landing.top)
            .background(Color.black.ignoresSafeArea())
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

}
