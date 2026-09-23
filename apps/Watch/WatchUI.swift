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

/// **The one control in the app, and it does not move.** It is a single overlay over the whole row
/// of pages rather than one per page, so a swipe slides the PAGES underneath it while the three marks
/// stay exactly where the thumb left them. Same bar, same three places, on every page and inside an
/// open session; the only thing a page changes is where a command GOES, which is the session on top
/// of the stack when one is open and the hub when none is.
///
/// Three slots, each read by its position:
/// - **left** throws away what is under way, and is nothing at all when there is nothing to throw away.
/// - **middle** is the recording's lock while one runs — open and orange as it starts, closed and red
///   once pressed — and the always-on listener's switch when none is running.
/// - **right** is the command itself: a microphone at rest, a red square while recording, and ONE
///   spinner whenever the hub is working. The transcript and the command are the same wait to him, so
///   they are the same mark rather than two spinners that differ in a way only the code knows about.
struct CommandBar: View {
    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared

    /// The room a page leaves under its content. It is the slot (34) plus the bar's own bottom
    /// padding (9) and a hair, so the bottom row of every page is EMPTY and belongs to the bar — a
    /// page that reserves only the slot has its last line of text under the marks.
    static let height: CGFloat = 46
    /// The side of every slot's box. Each mark centres in one of these, so a mark that changes size —
    /// a microphone to a square to a spinner — never shifts the spot the eye is already holding.
    private static let slot: CGFloat = 34

    /// Where a command goes. A session pushed on the stack owns the command while it is open.
    private var target: String? { sessions.path.last }
    private var mine: Capture.Owner { target.map(Capture.Owner.session) ?? .hub }
    private var recording: Bool { capture.owner == mine }
    /// The hub has it and is working: a clip being transcribed and a command being run are one wait.
    private var working: Bool { target.map { sessions.busy.contains($0) } ?? chat.waiting }

    var body: some View {
        // A full-height column reaching past the safe area puts the row on the screen's physical
        // bottom edge. Its empty top takes no touches, so taps still reach the page underneath.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                slot { if let cancel { mark("xmark", .red, action: cancel) } }
                Spacer(minLength: 0)
                slot { middle }
                Spacer(minLength: 0)
                slot { primary }
            }
            // 12pt: the bottom corners are curved, and a mark in the outer slot loses its edge to the
            // arc at less than this.
            .padding(.horizontal, 12)
            .padding(.bottom, 9)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
    }

    private func slot<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        content().frame(width: Self.slot, height: Self.slot)
    }

    /// The command. A press starts the recording, and the next press sends it — the lock is its own
    /// mark now, so this one never has to mean three things at once.
    @ViewBuilder private var primary: some View {
        if working {
            ProgressView().controlSize(.large).tint(.white)
        } else {
            mark(recording ? "square.fill" : "mic.fill", recording ? .red : .white) {
                Hub.log("control", ["target": target ?? "hub", "recording": recording])
                Capture.trigger = "press"
                if let target { sessions.toggleRecording(target) }
                else if recording { chat.stopRecording() } else { chat.startRecording() }
            }
            .handGestureShortcut(.primaryAction)
        }
    }

    /// The lock while a recording runs, the always-on listener's switch when none does.
    @ViewBuilder private var middle: some View {
        if recording {
            mark(capture.locked ? "lock.fill" : "lock.open", capture.locked ? .red : .orange) {
                capture.toggleLock()
            }
        } else {
            mark("waveform", capture.listens ? .orange : Color(hex: "#5c6675")) {
                chat.toggleListening()
            }
        }
    }

    private var cancel: (() -> Void)? {
        if recording {
            return { if let target { sessions.cancelRecording(target) } else { chat.cancelRecording() } }
        }
        if working && target == nil { return chat.cancel }
        return nil
    }

    private func mark(_ symbol: String, _ colour: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(colour)
                .frame(width: Self.slot, height: Self.slot)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            .contentMargins(.top, 14, for: .scrollContent)
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
            .padding(.bottom, CommandBar.height)
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
