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
        // A full-height column reaching past the safe area puts the row on the screen's physical bottom
        // edge. Its empty top takes no touches, so taps reach the page. **The two buttons are an HStack,
        // not layers**: as overlapping full-width layers the one drawn on top swallowed the other's
        // taps, and cancel — the one with no second way to press it — was the one that stopped working.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                if let cancel {
                    Button(action: cancel) {
                        Image(systemName: "xmark")
                            .font(.system(size: big ? 18 : 14, weight: .semibold))
                            .foregroundColor(.red)
                            .frame(width: big ? 54 : 40, height: big ? 34 : 18, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
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
                    // **The mark is centred in a box of its own, and that box is what sits in the
                    // corner.** Every state draws a different symbol — a microphone, two padlocks, a
                    // spinner — and each has its own width, so aligning the SYMBOL to the corner moves
                    // the mark each time the state changes: the eye reads that as the control sliding.
                    // A fixed box centred on one point holds it still whatever is in it.
                    .frame(width: big ? 34 : 18, height: big ? 34 : 18)
                    // A wide target around that box: the thumb gets a big button and the eye gets a
                    // mark in the corner rather than one floating mid-screen.
                    .frame(width: big ? 96 : 44, height: big ? 34 : 18, alignment: big ? .trailing : .center)
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
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 9)
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

/// **The command, on every page.** A hub command can be started from wherever he is — the rings, the
/// workout, the sessions list — so the control that carries one is a thing any page lays over itself
/// rather than a feature of the conversation page. It IS the state: a mic idle, an open lock recording,
/// a closed lock locked, a spinner while the hub has it, a waveform while always-on listening is on.
/// A press walks it on, a hold turns listening on or off, and the x beside it throws away whatever is
/// under way.
struct CommandBar: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    /// What a log line calls the page it is on.
    let view: String

    /// How much room a page leaves under its content for this.
    static let height = BottomControl.height

    private var recording: Bool { capture.owner == .hub }

    var body: some View {
        BottomControl(mode: mode, enabled: recording || !chat.waiting, action: press,
                      onHold: { if !recording { chat.toggleListening() } },
                      cancel: cancel, big: true)
    }

    /// The colour is the stake: amber while the silence could still end it, red once it is locked open
    /// and only a press will send it.
    private var mode: BottomControl.Mode {
        if recording {
            return capture.locked ? .glyph("lock.fill", .red) : .glyph("lock.open", Color(hex: "#d6c042"))
        }
        if chat.waiting { return .working(running: chat.pending != nil) }
        return .glyph(capture.listens ? "waveform" : "mic.fill", capture.listens ? .orange : .gray)
    }

    private var cancel: (() -> Void)? {
        if recording { return chat.cancelRecording }
        if chat.waiting { return chat.cancel }
        return nil
    }

    private func press() {
        Hub.log("control", ["view": view, "recording": recording, "locked": capture.locked])
        Capture.trigger = "press"
        chat.press()
    }
}

extension View {
    /// **The strip the clock sat in belongs to the page.** watchOS keeps a safe area at the top for the
    /// time, and with the time hidden (`._statusBarHidden`) that is a band of black above everything.
    /// A page takes it back and puts its own first line there.
    /// A scroll view ALSO insets its content by that safe area, which is the part that shows: the page
    /// reaches the top and its first line still starts below the strip. Both have to go.
    ///
    /// **The margin left behind is the corner curve, not spare space.** The display is a rounded
    /// rectangle, so a full-width line drawn hard against the top has its first and last words under
    /// the curve and clipped — invisible in a simulator screenshot, which is a flat rectangle, and
    /// plain on the wrist. This is the smallest inset that clears it.
    func topOfTheScreen() -> some View {
        ignoresSafeArea(edges: .top)
            .contentMargins(.top, 12, for: .scrollContent)
    }
}

extension EnvironmentValues {
    /// Whether the page this view is on is the one showing. Every page of the app stays alive side by
    /// side in the TabView, so a control that binds double tap asks this first.
    @Entry var onScreen: Bool = true
}

/// A line of reply text is about five words at 13pt, and a line is about sixteen points tall, so a
/// reading speed in words a minute is that many points a second: 200 wpm — ordinary silent reading —
/// is about eleven points a second, a line every second and a half.
private let pointsPerWord: CGFloat = 16.0 / 5.0
/// The beat before the creep starts: a reply lands on its first line and is read from there.
private let leadIn: Duration = .seconds(2)

/// The scrolling both conversation pages share, so the bottom control and the double-tap handover
/// cannot differ between them. Scrolling is his finger or the crown; the gesture is the prompt's.
struct PagedScroll<Content: View>: View {
    /// What a log line calls this page: "chat" or "session".
    let name: String
    /// Reading speed for the creep down a long reply, in words a minute; 0 leaves the page still.
    var readingWPM: Double = 0
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

    @State private var position = ScrollPosition(idType: String.self)
    @State private var offset: CGFloat = 0
    @State private var viewport: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    /// He has taken the page over with a finger or the crown; it does not creep again until reopened.
    @State private var taken = false
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.scenePhase) private var phase

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
        .scrollPosition($position)
        .onScrollGeometryChange(for: CGRect.self) { $0.visibleRect } action: { _, r in
            offset = r.minY
            viewport = r.height
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, h in
            contentHeight = h
        }
        .onScrollPhaseChange { _, now in
            // His finger or the crown ends it: a page that fights him is worse than one that stops.
            if now == .interacting || now == .tracking { taken = true; hold() }
        }
        // **It creeps only while he is looking at it.** The wrist dropping dims the screen
        // (`isLuminanceReduced`) and the app leaving the front stops it outright, so he never comes back
        // to a reply that scrolled past while he was not reading it.
        .onChange(of: dimmed) { _, _ in creep() }
        .onChange(of: phase) { _, _ in creep() }
        .onChange(of: contentHeight) { _, _ in creep() }
        .task { creep() }
        .overlay {
            BottomControl(mode: mode, enabled: recording || canRecord, action: press, cancel: cancel)
        }
        .background(Color.black.ignoresSafeArea())
    }

    /// Start, continue or stop the creep, from wherever the view stands now. **The distance is measured
    /// after the lead-in, not before it**: the page lands on its newest reply in that beat, and a
    /// distance measured before the landing is a long way to a place the view has already reached — the
    /// creep then crawls at a fraction of the speed asked for.
    private func creep() {
        guard readingWPM > 0, !taken, !dimmed, phase == .active else { return hold() }
        Task { @MainActor in
            try? await Task.sleep(for: leadIn)
            guard readingWPM > 0, !taken, !dimmed, phase == .active else { return }
            let end = contentHeight - viewport - WKInterfaceDevice.current().screenBounds.height * 0.8
            let left = end - offset
            guard left > 1 else { return }
            let seconds = Double(left / (CGFloat(readingWPM) / 60 * pointsPerWord))
            Hub.log("creep", ["wpm": readingWPM, "points": Int(left), "seconds": Int(seconds)])
            withAnimation(.linear(duration: seconds)) { position.scrollTo(y: end) }
        }
    }

    /// Stop where it is: an animation in flight is replaced by a jump to the offset it has reached.
    private func hold() {
        withAnimation(.linear(duration: 0)) { position.scrollTo(y: offset) }
    }

    /// A command walks the control: the mic records, the open lock holds it through the silence, the
    /// closed lock sends. A follow-up has no silence to hold off, so it records and sends.
    private var mode: BottomControl.Mode {
        guard recording else { return .record }
        guard locks else { return .stop }
        return locked ? .glyph("lock.fill", .red) : .glyph("lock.open", Color(hex: "#d6c042"))
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
