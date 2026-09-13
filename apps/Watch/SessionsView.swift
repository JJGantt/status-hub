import SwiftUI

/// The page left of the prompt: one row per conversation the hub knows, running first, then parked,
/// most recently active first within each. A tap opens one.
struct SessionsView: View {
    @EnvironmentObject private var sessions: Sessions

    var body: some View {
        NavigationStack {
            List(sessions.list) { s in
                NavigationLink(value: s.key) { row(s) }
            }
            .navigationDestination(for: String.self) { key in SessionView(key: key) }
        }
    }

    private func row(_ s: SessionRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let n = s.n {
                Text("\(n)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(.gray)
            }
            Text(s.name)
                .font(.system(size: 14))
                .foregroundColor(s.running ? .white : .gray)
                .lineLimit(2)
            Spacer(minLength: 0)
            if s.working == true || !(sessions.activity[s.key] ?? []).isEmpty {
                Circle().fill(Color.green).frame(width: 7, height: 7)
            }
        }
    }
}

/// One conversation: the last prompt and the reply to it, the tool calls of the turn it is running,
/// and a reply of his own. A tap anywhere (or double tap) starts recording and the next tap sends it;
/// a parked session is resumed with the words.
struct SessionView: View {
    let key: String
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared

    private var detail: SessionDetail? { sessions.details[key] }
    private var activity: [String] { sessions.activity[key] ?? [] }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Button { sessions.toggleRecording(key) } label: { content }
                        .buttonStyle(.plain)
                        .handGestureShortcut(.primaryAction)
                        .disabled(sessions.busy.contains(key))
                    status
                    Color.clear.frame(height: 1).id("tail")
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
            // New work lands at the bottom, so that is where the view follows it; opening a session
            // leaves its prompt and reply at the top.
            .onChange(of: activity.count) { _, _ in proxy.scrollTo("tail", anchor: .bottom) }
            .onChange(of: sessions.sent[key]) { _, _ in proxy.scrollTo("tail", anchor: .bottom) }
            .onChange(of: capture.owner) { _, _ in proxy.scrollTo("tail", anchor: .bottom) }
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(detail?.name ?? "")
        .task { await sessions.loadDetail(key) }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let prompt = detail?.last_prompt, !prompt.isEmpty {
                words(prompt)
            }
            if let reply = detail?.last_reply, !reply.isEmpty {
                Text(inlineMarkdown(reply))
                    .foregroundColor(.white)
                    .font(.system(size: 13))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let mine = sessions.sent[key] {
                words(mine)
            }
            if !activity.isEmpty {
                ActivityLines(lines: activity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// His side of the conversation, drawn as the prompt page draws his words.
    private func words(_ text: String) -> some View {
        Text(inlineMarkdown(text))
            .foregroundColor(.gray)
            .font(.system(size: 12, weight: .medium))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var status: some View {
        if capture.owner == .session(key) {
            RecordingBar(since: capture.since) { sessions.cancelRecording(key) }
        } else if sessions.busy.contains(key) {
            ProgressView().frame(width: 24, height: 24)
        } else if let failure = sessions.failures[key] {
            VStack(alignment: .leading, spacing: 6) {
                switch failure {
                case .micDenied:
                    Image(systemName: "mic.slash").foregroundColor(.gray)
                case .message(let m):
                    Text(m)
                        .foregroundColor(.red)
                        .font(.system(size: 11))
                        .lineLimit(3)
                }
                Button("Retry") { sessions.retry(key) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }
}
