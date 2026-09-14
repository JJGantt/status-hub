import SwiftUI

/// The page left of the prompt: one row per conversation the hub knows, running first, then parked,
/// most recently active first within each. A tap opens one.
struct SessionsView: View {
    @EnvironmentObject private var sessions: Sessions

    var body: some View {
        NavigationStack(path: $sessions.path) {
            List {
                ForEach(sessions.list) { s in
                    NavigationLink(value: s.key) { row(s) }
                }
                // Which build is on the wrist, so a fix that has not arrived is not taken for one that
                // failed. The TestFlight build number: CI stamps the run number into CFBundleVersion.
                Text("Build \(Self.build)")
                    .font(.system(size: 11))
                    .foregroundColor(.gray)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            }
            .navigationDestination(for: String.self) { key in SessionView(key: key) }
        }
    }

    private static let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"

    private func row(_ s: SessionRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let n = s.n {
                Text("\(n)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(.gray)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name)
                    .font(.system(size: 14))
                    .foregroundColor(s.running ? .white : .gray)
                    .lineLimit(2)
                if let say = s.say, !say.isEmpty {
                    Text(snippet(say))
                        .font(.system(size: 11))
                        .foregroundColor(.gray)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
            if s.working == true || !(sessions.activity[s.key] ?? []).isEmpty {
                Circle().fill(Color.green).frame(width: 7, height: 7)
            }
        }
    }
}

/// One conversation: the last prompt and the reply to it, the tool calls of the turn it is running,
/// and a reply of his own. A tap anywhere (or double tap, once the view is at the bottom) starts
/// recording and the next one sends it; a parked session is resumed with the words. While more of a
/// reply is below the screen, double tap pages down instead.
struct SessionView: View {
    let key: String
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared
    @State private var atBottom = false

    private var detail: SessionDetail? { sessions.details[key] }
    private var activity: [ActivityLine] { sessions.activity[key] ?? [] }
    private var recording: Bool { capture.owner == .session(key) }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(name: "session", recording: recording, atBottom: $atBottom) {
                Button {
                    Hub.log("record", ["view": "session", "atBottom": atBottom, "recording": recording])
                    sessions.toggleRecording(key)
                } label: { content }
                    .buttonStyle(.plain)
                    .handGestureShortcut(.primaryAction, isEnabled: atBottom || recording)
                    .disabled(sessions.busy.contains(key))
                status
            }
            // A new reply is read from its top. Work in progress — his words, a recording, tool calls —
            // lands at the bottom (`tail`, PagedScroll's end marker), so that is where the view follows
            // it. Opening a session leaves its prompt and reply at the top. Jumps to a view go through
            // the reader; paging moves by a distance instead.
            .onChange(of: detail?.last_reply) { old, new in
                guard old != nil, new != old else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("reply", anchor: .top) }
            }
            .onChange(of: activity.count) { old, new in if new > old { toBottom(proxy) } }
            .onChange(of: sessions.sent[key]) { _, new in if new != nil { toBottom(proxy) } }
            .onChange(of: recording) { _, now in if now { toBottom(proxy) } }
        }
        .navigationTitle(detail?.name ?? "")
        .task { await sessions.loadDetail(key) }
    }

    private func toBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("tail", anchor: .bottom) }
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
                    .id("reply")
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
        if recording {
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
