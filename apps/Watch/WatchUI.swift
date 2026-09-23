import SwiftUI
import WatchKit

/// Inline markdown (bold, italics, code) renders; anything else stays as written.
func inlineMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
}

/// A reply's opening for the line under a title: its markdown syntax gone and none of the bold, code
/// or link styling kept, so it reads as one quiet run of text.
func snippet(_ s: String) -> AttributedString {
    var a = inlineMarkdown(s)
    a.inlinePresentationIntent = nil
    a.link = nil
    return a
}

/// One step of a running turn, as the machine running it reports it: a tool call, or what the model
/// said between two of them (`thought`).
struct ActivityLine: Equatable {
    let text: String
    let thought: Bool
}

/// A running turn's steps, oldest first. A tool call is one grey line; a thought is read in full.
struct ActivityLines: View {
    let lines: [ActivityLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                if line.thought {
                    Text(inlineMarkdown(line.text))
                        .font(.system(size: 12))
                        .foregroundColor(Color(white: 0.78))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(line.text)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.gray)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// The one control every page puts at its bottom edge, and the only thing bound to double tap.
/// **A command walks the whole way through it**: press to record, press again to lock it open through
/// silence, press again to send. It is the state as much as the button — a mic idle, an open lock
/// recording, a closed lock locked, a spinner while the hub has it — and it never hides. Scrolling is
/// a finger or the crown, never the gesture.
struct BottomControl: View {
    /// `glyph` is home's: the state of the microphone and the command drawn in this same spot, since
    /// that page has one indicator and it is here.
    enum Mode: Equatable { case record, stop, glyph(String, Color), working(running: Bool) }

    /// How much room the control needs at the foot of a page, so text does not run under it.
    static let height: CGFloat = 34

    let mode: Mode
    let enabled: Bool
    let action: () -> Void
    /// Held rather than pressed. Home engages always-on listening this way, since the press records.
    var onHold: (() -> Void)?
    /// Throws away what is under way — the recording, or the command the hub still has. Drawn as an x
    /// in the corner OF THIS ROW, so cancel is beside the control on every page rather than a word
    /// across one of them.
    var cancel: (() -> Void)?
    /// Home's control is the page's only one and its state indicator, so it takes a target worth
    /// hitting; a conversation page's sits under text and stays small.
    var big = false
    @Environment(\.onScreen) private var onScreen
    /// A hold has just fired, so the press that ends it is not also acted on.
    @State private var held = false

    var body: some View {
        // A full-height column reaching past the safe area puts the control on the screen's physical
        // bottom edge in either scroll frame. Its empty top takes no touches, so taps reach the page.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            ZStack(alignment: .bottom) {
                Button(action: { if held { held = false } else { action() } }) {
                    Group {
                        if case .working(let running) = mode {
                            ProgressView()
                                .controlSize(running ? .large : big ? .small : .mini)
                                .tint(running ? .white : .gray)
                        } else {
                            Image(systemName: symbol)
                                .font(.system(size: big ? 20 : 15, weight: .semibold))
                                .foregroundColor(colour)
                        }
                    }
                    .opacity(enabled ? 1 : 0.4)
                    .frame(width: big ? 110 : 44, height: big ? 34 : 18)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // A Button's own gesture swallows `onLongPressGesture` on watchOS, so the hold runs
                // beside it and cancels the press it ends.
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                    held = true
                    onHold?()
                })
                // Live only while the page is the one showing: every page stays alive in the TabView,
                // and two live bindings leave the system to pick.
                .handGestureShortcut(.primaryAction, isEnabled: onScreen && enabled)
                .disabled(!enabled)
                .padding(.bottom, 9)
                if let cancel {
                    Button(action: cancel) {
                        Image(systemName: "xmark")
                            .font(.system(size: big ? 18 : 14, weight: .semibold))
                            .foregroundColor(.red)
                            .frame(width: 40, height: big ? 34 : 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 9)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
    }

    private var symbol: String {
        switch mode {
        case .record: "mic.fill"
        case .stop: "stop.fill"
        case .glyph(let name, _): name
        case .working: ""
        }
    }

    private var colour: Color {
        switch mode {
        case .stop: .red
        case .glyph(_, let colour): colour
        default: .gray
        }
    }
}

extension EnvironmentValues {
    /// Whether the page this view is on is the one showing. Every page of the app stays alive side by
    /// side in the TabView, so a control that binds double tap asks this first.
    @Entry var onScreen: Bool = true
}

/// The scrolling both conversation pages share, so the bottom control and the double-tap handover
/// cannot differ between them. Scrolling is his finger or the crown; the gesture is the prompt's.
struct PagedScroll<Content: View>: View {
    /// What a log line calls this page: "chat" or "session".
    let name: String
    let recording: Bool
    /// Whether a recording may start now — not while the page is waiting on a command or a send.
    var canRecord = true
    /// Whether this page's recording is one the silence ends, so the lock is a step in it.
    var locks = false
    var locked = false
    /// Throws away what is under way; nil when there is nothing to throw away.
    var cancel: (() -> Void)?
    /// Walks the recording on: starts it, locks it, sends it.
    let record: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                content()
                // Room under the content for its last block to rise to the TOP of the screen: a scroll
                // view stops at the end of what it holds, which would strand a short reply mid-screen.
                Color.clear.frame(height: WKInterfaceDevice.current().screenBounds.height * 0.8).id("tail")
            }
            .padding(.horizontal, 8)
            .padding(.bottom, BottomControl.height)
        }
        .scrollIndicators(.never)
        .overlay {
            BottomControl(mode: mode, enabled: recording || canRecord, action: press, cancel: cancel)
        }
        .background(Color.black.ignoresSafeArea())
    }

    /// A command walks the control: the mic records, the open lock holds it through the silence, the
    /// closed lock sends. A follow-up has no silence to hold off, so it records and sends.
    private var mode: BottomControl.Mode {
        guard recording else { return .record }
        guard locks else { return .stop }
        return .glyph(locked ? "lock.fill" : "lock.open", .red)
    }

    private func press() {
        Hub.log("control", ["view": name, "recording": recording, "locked": locked])
        record()
    }
}

/// What went wrong with the last command, under the conversation, with a Retry. The control at the
/// bottom edge says everything else — recording, locked, the hub working — so this is only ever the
/// failure.
struct CommandStatus: View {
    @EnvironmentObject private var chat: Chat

    var body: some View {
        if let failure = chat.failure {
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
        guard chat.requestIsFresh else {
            Hub.log("record-stale", ["age": Int(Date().timeIntervalSince(chat.requestedAt))])
            return
        }
        Capture.trigger = "launcher"
        chat.startRecording()
    }
}

/// One message of the thread. Its own view so that SwiftUI, finding its inputs unchanged, skips it
/// instead of parsing its markdown again every time the page is rebuilt.
struct ThreadRow: View {
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
