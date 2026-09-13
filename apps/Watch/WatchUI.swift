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
