import SwiftUI

/// The page left of the prompt: every session the hub knows, running first, then parked, most recently
/// active first within each. A tap opens one.
struct SessionsView: View {
    @EnvironmentObject private var sessions: Sessions

    var body: some View {
        NavigationStack {
            List(sessions.list) { s in
                NavigationLink(value: s.id) { row(s) }
            }
            .navigationDestination(for: String.self) { id in SessionView(id: id) }
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
            if s.working == true || !(sessions.activity[s.id] ?? []).isEmpty {
                Circle().fill(Color.green).frame(width: 7, height: 7)
            }
        }
    }
}

/// One session: its last reply, the tool calls of the turn it is running, and — while it is running —
/// a reply of his own. A tap anywhere (or double tap) starts recording, and the next tap sends it.
struct SessionView: View {
    let id: String
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared

    private var detail: SessionDetail? { sessions.details[id] }
    private var activity: [String] { sessions.activity[id] ?? [] }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Button { sessions.toggleRecording(id) } label: { content }
                        .buttonStyle(.plain)
                        .handGestureShortcut(.primaryAction)
                        .disabled(detail?.running != true || sessions.busy.contains(id))
                    status
                    Color.clear.frame(height: 1).id("tail")
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
            // New work lands at the bottom, so that is where the view follows it; opening a session
            // leaves its reply at the top.
            .onChange(of: activity.count) { _, _ in proxy.scrollTo("tail", anchor: .bottom) }
            .onChange(of: sessions.sent[id]) { _, _ in proxy.scrollTo("tail", anchor: .bottom) }
            .onChange(of: capture.owner) { _, _ in proxy.scrollTo("tail", anchor: .bottom) }
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(detail?.name ?? "")
        .task { await sessions.loadDetail(id) }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let reply = detail?.last_reply, !reply.isEmpty {
                Text(inlineMarkdown(reply))
                    .foregroundColor(.white)
                    .font(.system(size: 13))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let words = sessions.sent[id] {
                Text(words)
                    .foregroundColor(.gray)
                    .font(.system(size: 12, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !activity.isEmpty {
                ActivityLines(lines: activity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var status: some View {
        if capture.owner == .session(id) {
            RecordingBar(since: capture.since) { sessions.cancelRecording(id) }
        } else if sessions.busy.contains(id) {
            ProgressView().frame(width: 24, height: 24)
        } else if let failure = sessions.failures[id] {
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
                Button("Retry") { sessions.retry(id) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }
}
