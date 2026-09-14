import SwiftUI
import WatchKit

/// The prompt page: the shared hub conversation on black. A tap anywhere on it (or the double-tap
/// gesture) starts recording the next command, and the next tap sends it. A reply opens at its top, and
/// while more of it is below the screen double tap pages down instead of recording.
struct ChatView: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    @Environment(\.scenePhase) private var phase
    @State private var position = ScrollPosition(idType: String.self)
    @State private var scroll = ScrollState()
    /// Whether the view is held at `scrollTarget`, the top of the newest reply. Set when the app opens or
    /// comes back to the front and when a reply arrives, and kept until he scrolls or pages himself: a
    /// thread still laying out (two hundred rows on a cold launch) or still growing moves the spot, so a
    /// single jump lands short of it, and while pinned every change in the content's height re-aims.
    @State private var pinned = true

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    recordButton { thread }
                    status
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
            .scrollPosition($position)
            .trackScroll($scroll)
            // Jumps to a view go through the reader, which finds any view with an id; the position is
            // only for paging, which moves by a distance rather than to a view.
            .onChange(of: scrollTarget) { _, _ in
                pinned = true
                jump(proxy, animated: true)
            }
            .onChange(of: scroll.content) { _, _ in if pinned { jump(proxy) } }
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
        .overlay(alignment: .bottom) {
            PageDownMarker(more: !scroll.atBottom && !recording, edge: scroll.insetBottom) {
                pinned = false
                withAnimation(.easeOut(duration: 0.25)) { position.pageDown(from: scroll) }
            }
        }
        .background(Color.black.ignoresSafeArea())
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
                row(m.text ?? "", user: m.role == "user", session: m.session_id != nil).id(m.id)
            }
            if let p = chat.pending {
                row(p, user: true).id("pending")
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

    /// The tint a session's relayed reply wears on every surface (the web hub's .ai-msg-session text).
    private static let sessionTint = Color(red: 0.62, green: 0.89, blue: 0.83)

    private func row(_ text: String, user: Bool, session: Bool = false) -> some View {
        Text(inlineMarkdown(text))
            .foregroundColor(user ? .gray : session ? Self.sessionTint : .white)
            .font(.system(size: user ? 12 : 13, weight: user ? .medium : .regular))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var status: some View {
        if recording {
            RecordingBar(since: capture.since, cancel: chat.cancelRecording)
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

    /// The whole thread is the record button: a tap starts, the next one sends. Double tap does the
    /// same once the view is at the bottom (or a recording is under way); above that it pages down.
    private func recordButton<Label: View>(@ViewBuilder label: () -> Label) -> some View {
        Button(action: chat.toggleRecording, label: label)
            .buttonStyle(.plain)
            .handGestureShortcut(.primaryAction, isEnabled: scroll.atBottom || recording)
            .disabled(chat.waiting)
    }

    /// A launch from the complication or the Record control: start recording without a tap.
    private func recordIfAsked() {
        guard chat.recordRequested, phase == .active else { return }
        chat.recordRequested = false
        chat.startRecording()
    }
}
