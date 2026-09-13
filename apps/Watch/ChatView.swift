import SwiftUI
import WatchKit

/// The one screen: the shared hub conversation on black, and a tap anywhere on it (or the double-tap
/// gesture) to dictate the next command. the restaurant app's chat screen, pointed at the hub.
struct ChatView: View {
    @EnvironmentObject private var chat: Chat
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    dictationLink { thread }
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
        .task { await chat.load() }
        .onChange(of: phase) { _, now in
            guard now == .active else { return }
            Task { await chat.load() }
            dictateIfAsked()
        }
        .onChange(of: chat.dictationRequested) { _, _ in dictateIfAsked() }
    }

    /// Where the view settles: the start of the newest turn, as the restaurant app does, or the prompt
    /// being waited on.
    private var scrollTarget: String? {
        chat.pending != nil ? "pending" : chat.thread.last?.id
    }

    private var thread: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(chat.thread) { m in
                row(m.text ?? "", user: m.role == "user").id(m.id)
            }
            if let p = chat.pending {
                row(p, user: true).id("pending")
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
        Text(rendered(text))
            .foregroundColor(user ? .gray : .white)
            .font(.system(size: user ? 12 : 13, weight: user ? .medium : .regular))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Inline markdown (bold, italics, code) renders; anything else stays as written.
    private func rendered(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }

    @ViewBuilder private var status: some View {
        if chat.waiting {
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

    /// System dictation — the same text-input sheet the restaurant app opens. Double-tap opens it too.
    private func dictationLink<Label: View>(@ViewBuilder label: () -> Label) -> some View {
        TextFieldLink(prompt: nil, label: label) { text in
            let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !prompt.isEmpty { chat.send(prompt) }
        }
        .buttonStyle(.plain)
        .handGestureShortcut(.primaryAction)
        .disabled(chat.waiting)
    }

    /// The complication's launch: raise the same sheet without a tap. SwiftUI has no call for that,
    /// so it goes through WatchKit's text-input controller on the hosting interface controller.
    private func dictateIfAsked() {
        guard chat.dictationRequested, phase == .active else { return }
        chat.dictationRequested = false
        guard !chat.waiting else { return }
        WKApplication.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: nil, allowedInputMode: .plain
        ) { results in
            guard let text = (results?.first as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else { return }
            Task { @MainActor in chat.send(text) }
        }
    }
}
