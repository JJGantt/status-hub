import SwiftUI
import WatchKit

/// The prompt page: the shared hub conversation on black. A tap anywhere on it (or the double-tap
/// gesture) starts recording the next command, and the next tap sends it.
struct ChatView: View {
    @EnvironmentObject private var chat: Chat
    @ObservedObject private var capture = Capture.shared
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    recordButton { thread }
                    status
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .top) }
            }
        }
        .background(Color.black.ignoresSafeArea())
        .onAppear { recordIfAsked() }
        .onChange(of: phase) { _, now in if now == .active { recordIfAsked() } }
        .onChange(of: chat.recordRequested) { _, _ in recordIfAsked() }
    }

    /// Where the view settles: the recording under way, the command being waited on, or the start of
    /// the newest turn, as the restaurant app does.
    private var scrollTarget: String? {
        if capture.owner == .hub { return "recording" }
        return chat.pending != nil ? "pending" : chat.thread.last?.id
    }

    private var thread: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(chat.thread) { m in
                row(m.text ?? "", user: m.role == "user").id(m.id)
            }
            if let p = chat.pending {
                row(p, user: true).id("pending")
            }
            if !chat.activity.isEmpty {
                ActivityLines(lines: chat.activity)
            }
            if chat.thread.isEmpty && chat.pending == nil {
                Text(">")
                    .foregroundColor(.gray)
                    .font(.system(size: 20, weight: .regular, design: .monospaced))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .containerRelativeFrame(.vertical)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func row(_ text: String, user: Bool) -> some View {
        Text(inlineMarkdown(text))
            .foregroundColor(user ? .gray : .white)
            .font(.system(size: user ? 12 : 13, weight: user ? .medium : .regular))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var status: some View {
        if capture.owner == .hub {
            RecordingBar(since: capture.since, cancel: chat.cancelRecording)
                .id("recording")
        } else if chat.waiting {
            HStack {
                ProgressView().frame(width: 24, height: 24)
                Spacer()
                Button("Cancel", action: chat.cancel)
                    .tint(.red)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        } else if let failure = chat.failure {
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

    /// The whole thread is the record button: a tap starts, the next one sends. Double-tap does the same.
    private func recordButton<Label: View>(@ViewBuilder label: () -> Label) -> some View {
        Button(action: chat.toggleRecording, label: label)
            .buttonStyle(.plain)
            .handGestureShortcut(.primaryAction)
            .disabled(chat.waiting)
    }

    /// A launch from the complication or the Record control: start recording without a tap.
    private func recordIfAsked() {
        guard chat.recordRequested, phase == .active else { return }
        chat.recordRequested = false
        chat.startRecording()
    }
}
