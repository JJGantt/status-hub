import SwiftUI

/// Inline markdown (bold, italics, code) renders; anything else stays as written.
func inlineMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(s)
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

/// Tool calls as the machine running them reports them, one line each, oldest first.
struct ActivityLines: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.gray)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// Where a scroll view stands: enough to page it by the double-tap gesture, and to know it has reached
/// the end — which is when double tap goes back to recording. Both come from the visible rect, in the
/// content's own coordinates: the end is where no content is left below what is showing.
struct ScrollState: Equatable {
    var offset: CGFloat = 0
    var page: CGFloat = 0
    var below: CGFloat = 0

    /// Within a line of the end, or nothing to scroll at all.
    var atBottom: Bool { below <= 12 }
}

extension View {
    /// Keeps `state` current as the scroll view this modifies moves or its content changes.
    func trackScroll(_ state: Binding<ScrollState>) -> some View {
        onScrollGeometryChange(for: ScrollState.self) { g in
            ScrollState(offset: g.contentOffset.y, page: g.visibleRect.height,
                        below: g.contentSize.height - g.visibleRect.maxY)
        } action: { _, new in
            state.wrappedValue = new
        }
    }
}

extension ScrollPosition {
    /// One screen further down, keeping the last line just read at the top, and never past the end.
    mutating func pageDown(from s: ScrollState) {
        scrollTo(y: s.offset + min(max(s.page - 24, 40), max(s.below, 0)))
    }
}

/// The only sign a response runs past the screen: a small chevron at the bottom edge while there is more
/// below. It holds the double-tap gesture until the view reaches the bottom, when the page's own record
/// button takes it back.
struct PageDownMarker: View {
    let more: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.compact.down")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.gray)
                .shadow(color: .black, radius: 3)
                .frame(width: 44, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .handGestureShortcut(.primaryAction, isEnabled: more)
        .opacity(more ? 1 : 0)
        .allowsHitTesting(more)
    }
}
