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

/// **The command's state is the edge of the glass.** There is no control on screen: double tap runs a
/// command, press and hold throws one away, and a one-pixel line around the very edge of the display
/// says what is happening — the whole screen stays content. It is ONE overlay over the whole
/// navigation stack, so it is the same on every page and inside a session, where the command goes
/// to the session instead of the hub.
///
/// | state | edge |
/// |---|---|
/// | recording, and the silence will end it | amber |
/// | locked open through the silence | red |
/// | the hub working on it (transcript or command) | white, a sweep travelling round |
/// | always-on listening | blue, dim |
/// | idle | none |
struct CommandBorder: View {
    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared
    @Environment(\.isLuminanceReduced) private var dimmed

    /// Where a command goes. A session pushed on the stack owns the command while it is open.
    private var target: String? { sessions.path.last }
    private var mine: Capture.Owner { target.map(Capture.Owner.session) ?? .hub }
    private var recording: Bool { capture.owner == mine }
    /// The hub has it and is working: a clip being transcribed and a command being run are one wait.
    private var working: Bool { target.map { sessions.busy.contains($0) } ?? chat.waiting }

    private enum State { case recording, locked, working, listening, idle }
    private var state: State {
        if recording { return capture.locked ? .locked : .recording }
        if working { return .working }
        if capture.listens { return .listening }
        return .idle
    }

    var body: some View {
        ZStack {
            // Double tap is the command. It needs a control to bind to, and there is no control on
            // screen, so this one is: a point of nothing that takes no touches of its own.
            Button(action: primary) { Color.clear.frame(width: 1, height: 1) }
                .buttonStyle(.plain)
                .handGestureShortcut(.primaryAction)
                .accessibilityHidden(true)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            edge.allowsHitTesting(false)
        }
        .ignoresSafeArea()
    }

    @ViewBuilder private var edge: some View {
        switch state {
        case .idle: EmptyView()
        case .recording: line(Color(hex: "#f2a13d"))
        case .locked: line(Color(hex: "#e5484d"))
        case .listening: line(Color(hex: "#3b82f6").opacity(0.7))
        case .working:
            // A dim full ring with a bright stretch travelling round it: moving, so "working" can
            // never be mistaken for a colour that means something else.
            TimelineView(.animation) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                ZStack {
                    line(.white.opacity(0.25))
                    GlassEdge(width: Self.width).trimmedPath(t, 0.18)
                        .stroke(Color.white.opacity(dimmed ? 0.6 : 1), lineWidth: Self.width)
                }
            }
        }
    }

    private func line(_ c: Color) -> some View {
        GlassEdge(width: Self.width).stroke(c.opacity(dimmed ? 0.6 : 1), lineWidth: Self.width)
    }

    /// One pixel on this 2x screen. The line sits entirely inside the glass (GlassEdge insets its path
    /// by half of it), so the whole pixel is lit rather than half of it under the bezel.
    static let width: CGFloat = 0.5

    /// Idle: start. Recording: lock it open through the silence, then send. A session's follow-up has
    /// no silence to hold off, so there the second double tap sends.
    private func primary() {
        Hub.log("control", ["target": target ?? "hub", "recording": recording, "locked": capture.locked])
        Capture.trigger = "double-tap"
        if let target { sessions.toggleRecording(target); return }
        if !recording { chat.startRecording() }
        else if capture.locked { chat.stopRecording() }
        else { capture.toggleLock() }
    }

    /// Press and hold anywhere: throw away what is under way — the recording, or the command the hub
    /// is still working on. Nothing happens when there is nothing to throw away.
    static func cancel(chat: Chat, sessions: Sessions) {
        let target = sessions.path.last
        let capture = Capture.shared
        if let target, capture.owner == .session(target) { sessions.cancelRecording(target) }
        else if capture.owner == .hub { chat.cancelRecording() }
        else if target == nil && chat.waiting { chat.cancel() }
    }
}

/// The outline of the glass itself, inset by half a line width so a stroke along it lies wholly inside
/// the display. **The corners are Apple's, not a guess**: each is the three cubic curves of the
/// device's own framebuffer mask (the 46mm simulator's `framebufferMask` PDF), written in units of the
/// display's corner radius. It is a continuous corner — at the very top edge the glass begins 1.31
/// radii in from the side, where a circular arc of the same radius would begin at 1.0 — so a one-pixel
/// line drawn on a circle leaves the bezel at every corner.
struct GlassEdge: Shape {
    let width: CGFloat
    /// The 46mm display's corner radius in points (`DeviceCornerRadius` in its device profile).
    static let radius: CGFloat = 50

    func path(in r: CGRect) -> Path {
        let rect = r.insetBy(dx: width / 2, dy: width / 2)
        let R = Self.radius - width / 2
        // One corner, as offsets from the corner point along its two edges, in units of R: the
        // straight edge ends 1.307581 R from the corner and three curves turn it.
        let k: [(CGFloat, CGFloat)] = [
            (0, 1.307581),
            (0, 0.852907), (0.04734106, 0.6880309), (0.1362377, 0.5218087),
            (0.2251343, 0.3555865), (0.3555865, 0.2251343), (0.5218087, 0.1362377),
            (0.6880309, 0.04734106), (0.852907, 0), (1.307581, 0),
        ]
        // Each corner maps (along the edge before it, along the edge after it) to a point.
        let corners: [(CGPoint, CGVector, CGVector)] = [
            (CGPoint(x: rect.minX, y: rect.minY), CGVector(dx: 0, dy: 1), CGVector(dx: 1, dy: 0)),
            (CGPoint(x: rect.maxX, y: rect.minY), CGVector(dx: -1, dy: 0), CGVector(dx: 0, dy: 1)),
            (CGPoint(x: rect.maxX, y: rect.maxY), CGVector(dx: 0, dy: -1), CGVector(dx: -1, dy: 0)),
            (CGPoint(x: rect.minX, y: rect.maxY), CGVector(dx: 1, dy: 0), CGVector(dx: 0, dy: -1)),
        ]
        var p = Path()
        for (i, (c, a, b)) in corners.enumerated() {
            func pt(_ u: (CGFloat, CGFloat)) -> CGPoint {
                // u.0 runs along `b` (the edge after), u.1 along `a` (the edge before).
                CGPoint(x: c.x + (u.1 * a.dx + u.0 * b.dx) * R, y: c.y + (u.1 * a.dy + u.0 * b.dy) * R)
            }
            if i == 0 { p.move(to: pt(k[0])) } else { p.addLine(to: pt(k[0])) }
            for j in stride(from: 1, to: k.count, by: 3) {
                p.addCurve(to: pt(k[j + 2]), control1: pt(k[j]), control2: pt(k[j + 1]))
            }
        }
        p.closeSubpath()
        return p
    }

    /// A stretch of the outline `length` long (as a fraction of it) starting at `from`, wrapping round
    /// the start of the path.
    func trimmedPath(_ from: Double, _ length: Double) -> Path {
        var out = Path()
        let whole = path(in: CGRect(origin: .zero, size: WKInterfaceDevice.current().screenBounds.size))
        let to = from + length
        out.addPath(whole.trimmedPath(from: from, to: min(1, to)))
        if to > 1 { out.addPath(whole.trimmedPath(from: 0, to: to - 1)) }
        return out
    }
}

/// How far a page's content stops short of the bottom of the glass, so its last line clears the curved
/// bottom corners when scrolled to the end. The bar that used to live there is gone; this is only the
/// curve.
enum PageInset {
    static let bottom: CGFloat = 12
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
    /// `scrollTop` is that inset. It is 0 for a page whose scroll view is NOT the thing at the top of
    /// the screen — the nutrition page holds its rings above the scroller, so the rings clear the
    /// curve themselves and the margin would only open a gap under them.
    func topOfTheScreen(scrollTop: CGFloat = 14) -> some View {
        ignoresSafeArea(edges: .top)
            .contentMargins(.top, scrollTop, for: .scrollContent)
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
            .padding(.bottom, PageInset.bottom)
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
