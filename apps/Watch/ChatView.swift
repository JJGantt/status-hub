import SwiftUI
import WatchKit

/// The prompt page, one right of home: the whole shared hub conversation on black. A reply opens at its
/// top, and scrolling is his finger or the crown. Double tap starts a recording, wherever the view
/// stands, as does a tap anywhere on the thread (`PagedScroll`, shared with a session's page). The
/// silence after he speaks sends it. During it double tap moves to the recording bar's lock, so the
/// next double tap locks it open and the one after sends; a tap on the text or the stop sends at any
/// point.
struct ChatView: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    @Environment(\.scenePhase) private var phase
    /// Whether the view is held at `scrollTarget`, the top of the newest reply. Set when the app opens or
    /// comes back to the front and when a reply arrives, and kept until he scrolls or pages himself: a
    /// thread still laying out (two hundred rows on a cold launch) or still growing moves the spot, so a
    /// single jump lands short of it, and while pinned every change in the content's height re-aims.
    @State private var pinned = true

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(name: "chat", recording: recording, canRecord: !chat.waiting,
                        locks: true, locked: capture.locked, record: chat.press) {
                recordButton { thread }
                CommandStatus().id(recording ? "recording" : "status")
            }
            // Jumps to a view go through the reader, which finds any view with an id.
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
            }
            .onAppear { jump(proxy) }
        }
        .recordsWhenAsked()
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

    /// The whole thread records under a finger: a tap starts, the next one sends. Double tap is not
    /// bound here — it belongs to the bottom control alone (BottomControl says why).
    private func recordButton<Label: View>(@ViewBuilder label: () -> Label) -> some View {
        Button(action: {
            Hub.log("record", ["view": "chat", "recording": recording])
            chat.press()
        }, label: label)
            .buttonStyle(.plain)
            .disabled(chat.waiting)
    }
}

/// What the hub command is doing, under the page that records it (home and the prompt page): the
/// recording bar, the wait for the hub with Cancel, or what went wrong with Retry. Nothing while idle.
struct CommandStatus: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared

    var body: some View {
        if capture.owner == .hub {
            RecordingBar(cancel: chat.cancelRecording)
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
}

extension View {
    /// Starts the recording a launch asked for (the complication, the Record control) once this page is
    /// the one showing and the app is in front. Every page stays alive in the TabView, so without
    /// `onScreen` two pages would both try.
    func recordsWhenAsked() -> some View { modifier(RecordWhenAsked()) }
}

private struct RecordWhenAsked: ViewModifier {
    @EnvironmentObject private var chat: Chat
    @Environment(\.scenePhase) private var phase
    @Environment(\.onScreen) private var onScreen

    func body(content: Content) -> some View {
        content
            .onAppear(perform: start)
            .onChange(of: phase) { _, _ in start() }
            .onChange(of: onScreen) { _, _ in start() }
            .onChange(of: chat.recordRequested) { _, _ in start() }
    }

    private func start() {
        guard chat.recordRequested, phase == .active, onScreen else { return }
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
