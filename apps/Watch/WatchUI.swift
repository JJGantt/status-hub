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

/// The row a recording shows under its page: a red dot, the time recorded once the microphone is
/// actually open, and Cancel.
struct RecordingBar: View {
    let since: Date?
    let cancel: () -> Void

    var body: some View {
        HStack {
            HStack(spacing: 6) {
                Circle().fill(Color.red).frame(width: 10, height: 10)
                if let since {
                    Text(since, style: .timer)
                        .font(.system(size: 14, weight: .medium, design: .monospaced))
                        .foregroundColor(.red)
                }
            }
            Spacer()
            Button("Cancel", action: cancel)
                .tint(.red)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }
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

/// Where a scroll view stands: enough to page it by the double-tap gesture, and to know it has reached
/// the end — which is when double tap goes back to recording. Kept in terms of the SAFE AREA, the one
/// frame the scroll geometry reports consistently. Measured in the watchOS 26.5 simulator, the same
/// scroll view reports two frames depending on how it was last moved: after a jump to a view
/// (ScrollViewReader) `visibleRect` is the safe area alone with zero `contentInsets`; after
/// `scrollTo(y:)` it is the whole screen with the strips as insets. Math on `contentOffset` and the
/// insets directly was right in one frame and wrong in the other — short pages, a chevron mid-screen,
/// and an end the view could never reach.
struct ScrollState: Equatable {
    /// The safe area's top and bottom edges, in the content's coordinates.
    var safeTop: CGFloat = 0
    var safeBottom: CGFloat = 0
    /// The content's height, so a view holding a position can re-aim as content lays out or grows.
    var content: CGFloat = 0
    /// Where the end of the content actually is on the screen: the bottom of a marker placed after the
    /// last view (`scrollEnd`), in screen points from the top. Unknown until that marker lays out.
    var endY: CGFloat = .infinity

    /// How far below the safe area the content runs, by the scroll geometry. Paging aims with it.
    var below: CGFloat { content - safeBottom }
    /// The end of the content is on screen, or within a line of the bottom edge. Read from where the
    /// last view really is, NOT from the scroll geometry: on his watch the geometry said content was
    /// left below after the view had stopped at its end, so every double tap asked for a scroll that
    /// could not happen and recording was never handed the gesture. A view that has stopped at its end
    /// always has its end on screen, whatever the geometry reports.
    var atBottom: Bool { endY <= WKInterfaceDevice.current().screenBounds.height + 12 }

    /// For a log line (`Hub.log`): enough to see from the hub what the page's scroll looked like.
    func fields(_ view: String) -> [String: Any] {
        ["view": view, "safeTop": Int(safeTop), "safeBottom": Int(safeBottom), "content": Int(content),
         "endY": endY.isFinite ? Int(endY) : -1, "atBottom": atBottom,
         "screen": Int(WKInterfaceDevice.current().screenBounds.height)]
    }
}

extension View {
    /// Keeps `state` current as the scroll view this modifies moves or its content changes.
    func trackScroll(_ state: Binding<ScrollState>) -> some View {
        onScrollGeometryChange(for: ScrollState.self) { g in
            ScrollState(safeTop: g.visibleRect.minY + g.contentInsets.top,
                        safeBottom: g.visibleRect.maxY - g.contentInsets.bottom,
                        content: g.contentSize.height)
        } action: { _, new in
            var s = new
            s.endY = state.wrappedValue.endY   // owned by the end marker
            state.wrappedValue = s
        }
    }

    /// Marks the end of a scroll view's content. Goes on the last view inside it.
    func scrollEnd(_ state: Binding<ScrollState>) -> some View {
        onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { state.wrappedValue.endY = $0 }
    }
}

extension ScrollPosition {
    /// One screen further down: the last line showing above the page-down marker becomes the top line
    /// at the screen's edge. `scrollTo(y:)` puts y at the safe area's top, so the target is that new top
    /// edge plus the strip under the clock. The strips come from the screen, not the scroll geometry,
    /// which reports them only in one of its frames.
    mutating func pageDown(from s: ScrollState) {
        let lastLine: CGFloat = 18   // about one line of reply text, kept on screen as the new top line
        let safe = s.safeBottom - s.safeTop
        let strips = WKInterfaceDevice.current().screenBounds.height - safe   // under the clock + bottom edge
        let top = s.safeBottom + strips - BottomControl.fade - lastLine
        scrollTo(y: min(max(top, s.safeTop), s.content - safe))
    }
}

/// The one control a conversation page puts under double tap, at the bottom edge. What it does depends
/// on where the page stands: pages down while more is below (a chevron, the text fading out under it),
/// records at the bottom (a mic), and sends while recording (a stop). It never disappears and never
/// hands the gesture to anything else. Two buttons trading the gesture at the bottom — a chevron, then
/// the page-sized record button — was how a double tap there pressed the whole page, how a tap where the
/// chevron had been landed in empty space, and how the view crept back up under it.
struct BottomControl: View {
    enum Mode { case more, record, stop }

    /// The strip along the screen's bottom edge that text fades out of while the chevron shows. Text
    /// scrolls to the very edge, so without it the chevron always sits on some line.
    static let fade: CGFloat = 28

    let mode: Mode
    let enabled: Bool
    let action: () -> Void
    @Environment(\.onScreen) private var onScreen

    var body: some View {
        // A full-height column reaching past the safe area puts the control on the screen's physical
        // bottom edge in either scroll frame. Its empty top takes no touches, so taps reach the page.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            ZStack(alignment: .bottom) {
                if mode == .more {
                    LinearGradient(colors: [Color.black.opacity(0), .black, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.fade)
                        .allowsHitTesting(false)
                }
                Button(action: action) {
                    Image(systemName: symbol)
                        .font(.system(size: mode == .more ? 16 : 13, weight: .semibold))
                        .foregroundColor(mode == .stop ? .red : .gray)
                        .opacity(enabled ? 1 : 0.4)
                        .frame(width: 44, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // The page's only double-tap binding, and live only while the page is the one showing:
                // every page stays alive in the TabView, and two live bindings leave the system to pick.
                .handGestureShortcut(.primaryAction, isEnabled: onScreen && enabled)
                .disabled(!enabled)
                // Clear of the page dots under it: a tap on those changes page, and in a simulator test
                // one aimed at this control did.
                .padding(.bottom, 9)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
    }

    private var symbol: String {
        switch mode {
        case .more: "chevron.compact.down"
        case .record: "mic.fill"
        case .stop: "stop.fill"
        }
    }
}

extension EnvironmentValues {
    /// Whether the page this view is on is the one showing. Every page of the app stays alive side by
    /// side in the TabView, so a control that binds double tap asks this first.
    @Entry var onScreen: Bool = true
}

/// The scrolling both conversation pages share, so paging, finding the bottom and the bottom control
/// are one piece of code on the prompt page and a session alike. It owns where the view stands; a page
/// reads only `atBottom`, which flips a few times a scroll rather than every frame, so the page's own
/// views are not rebuilt while it moves. The prompt page rebuilt its whole thread, forty rows of
/// markdown, on every frame of a page, and stuttered.
struct PagedScroll<Content: View>: View {
    /// What a log line calls this page: "chat" or "session".
    let name: String
    let recording: Bool
    /// Whether a recording may start now — not while the page is waiting on a command or a send.
    var canRecord = true
    @Binding var atBottom: Bool
    /// Runs before the control pages: the prompt page lets go of the reply it was holding.
    var willPage: () -> Void = {}
    /// Starts a recording at the bottom, or sends the one under way.
    let record: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var scroll = ScrollState()
    @State private var position = ScrollPosition(idType: String.self)
    @State private var paging = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                content()
                Color.clear.frame(height: 1).id("tail").scrollEnd($scroll)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .scrollIndicators(.never)
        .scrollPosition($position)
        .trackScroll($scroll)
        .onChange(of: scroll.atBottom, initial: true) { _, now in atBottom = now }
        .onScrollPhaseChange { _, now in
            guard paging, now == .idle else { return }
            paging = false
            Hub.log("paged", scroll.fields(name))
        }
        .overlay { BottomControl(mode: mode, enabled: mode != .record || canRecord, action: press) }
        .background(Color.black.ignoresSafeArea())
        #if targetEnvironment(simulator)
        .task { await autoPage() }
        #endif
    }

    private var mode: BottomControl.Mode { recording ? .stop : scroll.atBottom ? .record : .more }

    private func press() {
        guard mode != .more else { return page() }
        var f = scroll.fields(name)
        f["mode"] = mode == .stop ? "stop" : "record"
        Hub.log("control", f)
        record()
    }

    private func page() {
        willPage()
        Hub.log("page", scroll.fields(name))
        paging = true
        withAnimation(.easeOut(duration: 0.25)) { position.pageDown(from: scroll) }
    }

    #if targetEnvironment(simulator)
    /// `-autopage chat` (or `session`) at launch pages every two seconds until the bottom, standing in
    /// for the double tap a simulator cannot make, so the real pages can be watched scrolling there.
    private func autoPage() async {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-autopage"), i + 1 < args.count, args[i + 1] == name else { return }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        for _ in 0..<10 {
            if scroll.atBottom { Hub.log("bottom", scroll.fields(name)); return }
            page()
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
    #endif
}
