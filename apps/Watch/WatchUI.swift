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

    /// How much further the view can scroll down: it stops with the content's end at the safe area's
    /// bottom.
    var below: CGFloat { content - safeBottom }
    /// Within a line of the end, or nothing to scroll at all.
    var atBottom: Bool { below <= 12 }
}

extension View {
    /// Keeps `state` current as the scroll view this modifies moves or its content changes.
    func trackScroll(_ state: Binding<ScrollState>) -> some View {
        onScrollGeometryChange(for: ScrollState.self) { g in
            ScrollState(safeTop: g.visibleRect.minY + g.contentInsets.top,
                        safeBottom: g.visibleRect.maxY - g.contentInsets.bottom,
                        content: g.contentSize.height)
        } action: { _, new in
            state.wrappedValue = new
        }
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
        let top = s.safeBottom + strips - PageDownMarker.fade - lastLine
        scrollTo(y: min(max(top, s.safeTop), s.content - safe))
    }
}

/// The only sign a response runs past the screen: a small chevron at the bottom edge while there is more
/// below. It holds the double-tap gesture until the view reaches the bottom, when the page's own record
/// button takes it back.
struct PageDownMarker: View {
    /// The strip along the screen's bottom edge that text fades out of while the chevron shows. Text
    /// scrolls to the very edge, so without it the chevron always sits on some line.
    static let fade: CGFloat = 28

    let more: Bool
    let action: () -> Void

    var body: some View {
        // A full-height column reaching past the safe area puts the marker on the screen's physical
        // bottom edge in either frame. Its empty top takes no touches, so taps reach the page beneath.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            ZStack(alignment: .bottom) {
                LinearGradient(colors: [Color.black.opacity(0), .black, .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: Self.fade)
                    .allowsHitTesting(false)
                Button(action: action) {
                    Image(systemName: "chevron.compact.down")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.gray)
                        .frame(width: 44, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .handGestureShortcut(.primaryAction, isEnabled: more)
                .allowsHitTesting(more)
                .padding(.bottom, 2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
        .opacity(more ? 1 : 0)
    }
}
