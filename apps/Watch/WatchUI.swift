import SwiftUI

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
/// the end — which is when double tap goes back to recording. Both come from the visible rect, in the
/// content's own coordinates: the end is where no content is left below what is showing.
struct ScrollState: Equatable {
    /// The content y at the screen's top edge (`contentOffset`).
    var offset: CGFloat = 0
    /// The whole screen's height, the strips under the clock and along the bottom edge included.
    var page: CGFloat = 0
    /// How much further the view can scroll down before it stops.
    var below: CGFloat = 0
    /// The content's height, so a view holding a position can re-aim as content lays out or grows.
    var content: CGFloat = 0
    var insetTop: CGFloat = 0
    var insetBottom: CGFloat = 0

    /// Within a line of the end, or nothing to scroll at all.
    var atBottom: Bool { below <= 12 }
}

extension View {
    /// Keeps `state` current as the scroll view this modifies moves or its content changes.
    func trackScroll(_ state: Binding<ScrollState>) -> some View {
        onScrollGeometryChange(for: ScrollState.self) { g in
            // The scroll stops with the content's end at the safe area's bottom, the bottom inset short
            // of the screen's edge.
            ScrollState(offset: g.contentOffset.y, page: g.visibleRect.height,
                        below: g.contentSize.height + g.contentInsets.bottom - g.visibleRect.maxY,
                        content: g.contentSize.height,
                        insetTop: g.contentInsets.top, insetBottom: g.contentInsets.bottom)
        } action: { _, new in
            state.wrappedValue = new
        }
    }
}

extension ScrollPosition {
    /// One screen further down: the last line showing above the page-down marker becomes the top line.
    /// Measured in the watchOS 26.5 simulator: `contentOffset` and `visibleRect` span the whole screen,
    /// the strips under the clock and the bottom edge included, but `scrollTo(y:)` puts y at the top of
    /// the safe area, `insetTop` below the screen's edge — so the new top edge is handed over plus
    /// `insetTop`. Paging by the offset alone came up short by that strip, about two and a half lines.
    mutating func pageDown(from s: ScrollState) {
        let lastLine: CGFloat = 18   // about one line of reply text, kept on screen as the new top line
        let shown = s.page - PageDownMarker.fade
        scrollTo(y: s.offset + max(0, min(shown - lastLine, s.below)) + s.insetTop)
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
    /// The scroll view's bottom inset: the strip between the safe area and the screen's edge.
    let edge: CGFloat
    let action: () -> Void

    var body: some View {
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
        .frame(maxWidth: .infinity)
        .opacity(more ? 1 : 0)
        // An overlay ends at the safe area's bottom; down by the inset puts it at the screen's edge
        // (36pt on a 46mm watch, measured). ignoresSafeArea does not move an overlay.
        .offset(y: edge)
    }
}
