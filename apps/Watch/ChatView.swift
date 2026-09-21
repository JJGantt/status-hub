import SwiftUI
import WatchKit

/// The prompt page: the shared hub conversation on black. A reply opens at its top. The bottom control
/// (and double tap, bound to it alone) pages down while more is below and records at the bottom; a tap
/// anywhere on the thread also records. The next press sends (`PagedScroll`, shared with a session's
/// page), and so does the silence after he speaks unless the recording is locked (`Capture`).
struct ChatView: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    @Environment(\.scenePhase) private var phase
    @State private var atBottom = false
    /// Whether the view is held at `scrollTarget`, the top of the newest reply. Set when the app opens or
    /// comes back to the front and when a reply arrives, and kept until he scrolls or pages himself: a
    /// thread still laying out (two hundred rows on a cold launch) or still growing moves the spot, so a
    /// single jump lands short of it, and while pinned every change in the content's height re-aims.
    @State private var pinned = true

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(name: "chat", recording: recording, canRecord: !chat.waiting, atBottom: $atBottom,
                        willPage: { pinned = false }, record: chat.toggleRecording) {
                recordButton { thread }
                status
            }
            // Jumps to a view go through the reader, which finds any view with an id; paging moves by a
            // distance instead (PagedScroll).
            .onChange(of: scrollTarget) { _, _ in
                pinned = true
                jump(proxy, animated: true)
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                if pinned { jump(proxy) }
            }
            .onScrollPhaseChange { _, now in
                if now == .interacting || now == .tracking { pinned = false }
            }
            .onChange(of: phase) { _, now in
                guard now == .active else { return }
                pinned = true
                jump(proxy)
                recordIfAsked()
            }
            .onAppear {
                jump(proxy)
                recordIfAsked()
            }
        }
        .onChange(of: chat.recordRequested) { _, _ in recordIfAsked() }
    }

    private func jump(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard let target = scrollTarget else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .top) }
        } else {
            proxy.scrollTo(target, anchor: .top)
        }
    }

    /// Where the view settles: the recording under way, the command being waited on, or the top of the
    /// newest reply, so a long one is read from its start.
    private var scrollTarget: String? {
        if recording { return "recording" }
        return chat.pending != nil ? "pending" : chat.thread.last?.id
    }

    private var thread: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(chat.thread) { m in
                ThreadRow(text: m.text ?? "", user: m.role == "user", session: m.session_id != nil).id(m.id)
            }
            if let p = chat.pending {
                ThreadRow(text: p, user: true).id("pending")
            }
            if !chat.activity.isEmpty {
                ActivityLines(lines: chat.activity)
            }
            if chat.thread.isEmpty && chat.pending == nil {
                Text(">")
                    .foregroundColor(.gray)
                    .font(.system(size: 20, weight: .regular, design: .monospaced))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .containerRelativeFrame(.vertical)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var status: some View {
        if recording {
            RecordingBar(cancel: chat.cancelRecording)
                .id("recording")
        } else if chat.waiting {
            HStack {
                ProgressView().frame(width: 24, height: 24)
                Spacer()
                Button("Cancel", action: chat.cancel)
                    .tint(.red)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        } else if let failure = chat.failure {
            VStack(alignment: .leading, spacing: 6) {
                switch failure {
                case .noToken:
                    Image(systemName: "iphone").foregroundColor(.gray)
                case .micDenied:
                    Image(systemName: "mic.slash").foregroundColor(.gray)
                case .message(let m) where !m.isEmpty:
                    Text(m)
                        .foregroundColor(.red)
                        .font(.system(size: 11))
                        .lineLimit(3)
                default:
                    EmptyView()
                }
                Button("Retry", action: chat.retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }

    /// The whole thread records under a finger: a tap starts, the next one sends. Double tap is not
    /// bound here — it belongs to the bottom control alone (BottomControl says why).
    private func recordButton<Label: View>(@ViewBuilder label: () -> Label) -> some View {
        Button(action: {
            Hub.log("record", ["view": "chat", "atBottom": atBottom, "recording": recording])
            chat.toggleRecording()
        }, label: label)
            .buttonStyle(.plain)
            .disabled(chat.waiting)
    }

    /// A launch from the complication or the Record control: start recording without a tap.
    private func recordIfAsked() {
        guard chat.recordRequested, phase == .active else { return }
        chat.recordRequested = false
        chat.startRecording()
    }
}

/// One message of the thread. Its own view so that SwiftUI, finding its inputs unchanged, skips it
/// instead of parsing its markdown again every time the page is rebuilt.
private struct ThreadRow: View {
    let text: String
    let user: Bool
    var session = false

    /// The tint a session's relayed reply wears on every surface (the web hub's .ai-msg-session text).
    private static let sessionTint = Color(red: 0.62, green: 0.89, blue: 0.83)

    var body: some View {
        Text(inlineMarkdown(text))
            .foregroundColor(user ? .gray : session ? Self.sessionTint : .white)
            .font(.system(size: user ? 12 : 13, weight: user ? .medium : .regular))
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
