import SwiftUI
import WatchKit

/// Inline markdown (bold, italics, code, links) renders; blocks are `Markdown`'s job. A bare http(s) URL
/// is made a link too, since that is how a model usually writes one.
func inlineMarkdown(_ s: String) -> AttributedString {
    var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
    guard let detector = linkDetector else { return a }
    let plain = String(a.characters)
    for m in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
        guard let url = m.url, let sr = Range(m.range, in: plain), plain[sr].hasPrefix("http"),
              let r = Range(m.range, in: a), a[r].link == nil else { continue }
        a[r].link = url
    }
    return a
}

private let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

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
/// **Who said it, by colour**, the same on every page: his words a soft blue, the model's tool calls a
/// soft violet, what it says between them grey, and its final reply white (the brightest, since it is
/// what he reads). Relayed session replies keep their mint on home; amber stays the colour of
/// recording and of unread, so neither of those is used here.
enum Ink {
    static let mine = Color(hex: "#8ab4e8")
    static let tool = Color(hex: "#b39ddb")
    static let thought = Color(white: 0.62)
}

struct ActivityLine: Equatable {
    enum Kind { case tool, thought, said }
    let text: String
    let kind: Kind
}

/// A running turn's steps, oldest first. A tool call is one grey line; a thought is read in full; words
/// said INTO the session — his prompt, as the session took it in — are drawn as his words, in full.
struct ActivityLines: View {
    let lines: [ActivityLine]
    /// A line to open extra room above (the newest item, when it is one of these lines), and how much.
    var lift: (index: Int, by: CGFloat)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                // The room above the newest line, as its own spacer so the landing lands on the line.
                if lift?.index == i { Color.clear.frame(height: max(0, lift!.by - 4)) }
                Group {
                    switch line.kind {
                    case .said:
                        Text(inlineMarkdown(line.text))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Ink.mine)
                    case .thought:
                        Markdown(text: line.text, size: 12)
                            .foregroundColor(Ink.thought)
                    case .tool:
                        Text(line.text)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(Ink.tool)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .id("line\(i)")
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
    /// Everything the edge looks like — thickness, the black band, every state's colour — is a hub
    /// setting, so it is tuned without a build (`BorderStyle`).
    @ObservedObject private var style = BorderStyle.shared
    /// Wrist down: the system redraws the screen too seldom to animate, so anything moving freezes
    /// wherever it happened to be.
    @Environment(\.isLuminanceReduced) private var lowered

    /// Where a command goes (`Sessions.target`).
    private var target: String? { sessions.target }
    private var mine: Capture.Owner { target.map(Capture.Owner.session) ?? .hub }
    private var recording: Bool { capture.owner == mine }
    /// The hub has it and is working: a clip being transcribed and a command being run are one wait.
    /// Inside a session that runs until the session's reply lands, not just until the words are handed
    /// over.
    private var working: Bool {
        target.map { sessions.busy.contains($0) || !(sessions.awaiting[$0] ?? []).isEmpty } ?? chat.waiting
    }

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
        case .recording: line(style.recording)
        case .locked: line(style.locked)
        case .listening: line(style.listening)
        case .working where lowered:
            // A sweep frozen mid-way reads as something stuck, so with the wrist down it is the whole
            // line in the working colour instead, which no other state uses.
            line(style.working)
        case .working:
            // A dark ring with a bright stretch travelling round it: moving, so "working" can never be
            // mistaken for a colour that means something else.
            TimelineView(.animation) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                ZStack {
                    line(style.ring)
                    // Centred ON the outline and twice the line's width, so it reaches the line's inner
                    // edge and runs off past the glass on the other side, like the fill under it.
                    GlassEdge(inset: 0).trimmedPath(t, 0.18)
                        .stroke(solid(style.working), lineWidth: width * 2)
                }
            }
        }
    }

    /// The line, with the black band just inside it. **Every colour is SOLID**: a translucent line lets
    /// text scrolling up to the edge show through it, so a dim state is a darker colour rather than a
    /// fainter one — and the band is opaque black, so text disappears just before it reaches the line
    /// instead of running under it.
    private func line(_ hex: String) -> some View {
        ZStack {
            if band > 0 {
                GlassEdge(inset: width + band / 2).stroke(Color.black, lineWidth: band)
            }
            BeyondEdge(inset: width).fill(solid(hex), style: FillStyle(eoFill: true))
        }
    }

    private var scale: CGFloat { WKInterfaceDevice.current().screenScale }
    /// The thickness and the band in points; the settings are in PIXELS.
    private var width: CGFloat { CGFloat(max(1, style.px)) / scale }
    private var band: CGFloat { CGFloat(max(0, style.bandPx)) / scale }

    /// Idle: start. Recording: lock it open through the silence, then send. A session's follow-up has
    /// no silence to hold off, so there the second double tap sends.
    private func primary() { Self.press(chat: chat, sessions: sessions, how: "double-tap") }

    /// **In a session a tap only presses in the bottom half of the glass**; the top half is for touching
    /// what is there. Home is the whole glass (`everywhere`), because he asked for it: that page is the
    /// command, and a scroll or a swipe is a drag, which is not a tap. Double tap is unaffected.
    static func tapPresses(_ at: CGPoint, everywhere: Bool = false) -> Bool {
        // While a reply is spoken a tap anywhere is a press, and the press stops the voice.
        let presses = everywhere || Speaker.shared.isSpeaking || at.y > WKInterfaceDevice.current().screenBounds.height / 2
        // Where the finger landed, so a tap that started a recording can be traced to the half it hit.
        Hub.log("tap", ["y": Int(at.y), "presses": presses])
        return presses
    }

    /// **The one press.** Double tap and a tap on the conversation both come here, and home and a
    /// session follow the same flow: start (amber, sends itself at his silence), then lock (red, only a
    /// press ends it), then send. A recording a watch-face launcher started in another flow
    /// (`Capture.Flow`) skips the lock: its first press sends.
    static func press(chat: Chat, sessions: Sessions, how: String) {
        // A reply being spoken: the press stops it and does nothing else. The next one records.
        if Speaker.shared.isSpeaking {
            Hub.log("control", ["speaking": true, "how": how])
            Speaker.shared.stop()
            return
        }
        let capture = Capture.shared
        let target = sessions.target
        let recording = capture.owner == (target.map(Capture.Owner.session) ?? .hub)
        Hub.log("control", ["target": target ?? "hub", "recording": recording, "locked": capture.locked,
                               "flow": capture.flow.rawValue, "how": how])
        Capture.trigger = how
        if !recording {
            if let target { sessions.startRecording(target) } else { chat.startRecording() }
        } else if capture.pressSends {
            if let target { sessions.stopRecording(target) } else { chat.stopRecording() }
        } else {
            capture.toggleLock()
        }
    }

    /// Press and hold anywhere: throw away what is under way — the recording, or the command the hub
    /// is still working on. Nothing happens when there is nothing to throw away.
    static func cancel(chat: Chat, sessions: Sessions) {
        let target = sessions.target
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
    /// How far inside the glass's outline the path runs.
    let inset: CGFloat
    /// The 46mm display's corner radius in points (`DeviceCornerRadius` in its device profile).
    static let radius: CGFloat = 50

    func path(in r: CGRect) -> Path {
        let rect = r.insetBy(dx: inset, dy: inset)
        let R = Self.radius - inset
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

/// **Everything from `inset` inside the glass's outline outward**, off the edge of the screen: the line
/// is this filled, not a stroke along the outline. A stroke only covers the outline as drawn, and the
/// real glass is not exactly that curve — where a corner meets the top and bottom edges a sliver of
/// glass lies outside it, and text scrolling past showed there, beyond the line. A fill has no outside.
struct BeyondEdge: Shape {
    let inset: CGFloat

    func path(in r: CGRect) -> Path {
        var p = Path(r.insetBy(dx: -20, dy: -20))
        p.addPath(GlassEdge(inset: inset).path(in: r))
        return p
    }
}

/// **Where the newest item lands**, in points from the top of the glass, and the gap between items.
/// One place per page, the same with the edge lit or dark: a landing that moved with the border would
/// make the text jump every time a command started.
///
/// Low enough that a full-width first line clears the corner curve and the thickest default edge: text
/// sits 8pt in from the side, and the glass's corner only comes within 4.5pt of the side (leaving room
/// for a 2.5pt edge) from about 31pt down. A session's title owns the top down to about 41pt, so there
/// the landing is just under it. The GAP between items equals the landing, so with the newest item in
/// place the one before it ends just above the top of the screen rather than showing a sliver.
enum Landing {
    static let top: CGFloat = 32
    static let underTitle: CGFloat = 58
    /// The gap between items everywhere EXCEPT above the newest one, which gets the landing's height so
    /// the item before it ends just above the top of the screen. The others need no such room.
    static let itemGap: CGFloat = 12
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

/// The session page's scroller. Scrolling is his finger or the crown; nothing moves the page on its
/// own. It holds the content and nothing under it: a block near the end that cannot reach the top of
/// the screen stops where the content ends, as any list does.
struct PagedScroll<Content: View>: View {
    /// Told whether the very end of the page is on screen. Asked of a marker's VISIBILITY rather than
    /// worked out from offsets: the scroll view's reported geometry is not to be trusted here (§ Double
    /// tap, and scrolling in docs/WATCH.md).
    var reachedEnd: (Bool) -> Void = { _ in }
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                content()
                Color.clear.frame(height: 1)
                    .onScrollVisibilityChange(threshold: 1) { reachedEnd($0) }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, PageInset.bottom)
        }
        .scrollIndicators(.never)
        .topOfTheScreen(scrollTop: Landing.underTitle)
        .background(Color.black.ignoresSafeArea())
    }
}

/// What went wrong with the last command, under the conversation, with a Retry. The edge of the glass
/// says everything else — recording, locked, the hub working — so this is only ever the failure.
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
        chat.startRecording(flow: chat.requestedFlow)
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
        Markdown(text: text, size: user ? 12 : 13, weight: user ? .medium : .regular)
            .foregroundColor(user ? Ink.mine : session ? Self.sessionTint : .white)
    }
}
