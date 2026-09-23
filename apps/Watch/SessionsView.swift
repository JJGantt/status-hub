import SwiftUI

/// The page left of home: one row per conversation the hub knows, running first, then parked, most
/// recently active first within each. A tap opens one.
///
/// A row carries the same three marks as the phone's list (`cards/sessions.js`, `phone-home.css`),
/// because they answer different questions and are read together: the WHITE edge is the focused
/// session — where a spoken follow-up goes — with a pin beside its name when he pinned it there; the
/// AMBER edge is a finished reply nobody has opened, which also takes back the dimming a parked row
/// gets, since a finished session is the one most worth reading; the DOT is a session working now.
/// Under each name is what its machine is doing, live off `/api/session-stream`.
struct SessionsView: View {
    @EnvironmentObject private var sessions: Sessions

    var body: some View {
        // A row pushes onto the app's root stack (RootView), so the session covers every page.
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
    }

    private static let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"

    private func row(_ s: SessionRow) -> some View {
        let unread = s.unread == true
        let focused = s.id == sessions.focus
        return HStack(alignment: .top, spacing: 6) {
            // The edge: amber over white, as on the phone, where a focused unread row shows both.
            Rectangle()
                .fill(unread ? Self.amber : focused ? Color.white : Color.clear)
                .frame(width: 2)
            if let n = s.n {
                Text("\(n)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(.gray)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if focused && sessions.pinned {
                        Image(systemName: "pin.fill").font(.system(size: 9)).foregroundColor(.gray)
                    }
                    Text(s.name)
                        .font(.system(size: 14))
                        .foregroundColor(unread || focused ? .white : s.running ? Self.name : .gray)
                        .lineLimit(2)
                }
                if let say = s.say, !say.isEmpty {
                    Text(snippet(say))
                        .font(.system(size: 11))
                        .foregroundColor(.gray)
                        .lineLimit(2)
                }
                step(s, unread: unread)
            }
            Spacer(minLength: 0)
            if s.working == true {
                Circle().fill(Color.green).frame(width: 7, height: 7).padding(.top, 4)
            }
        }
        // A parked session is dimmed, unless it is holding a reply nobody has read.
        .opacity(s.running || unread ? 1 : 0.5)
    }

    /// What this session's machine is doing, newest step only: a tool call in teal, what the model says
    /// between them in a plain light. The line is always there, however empty — a row that grows when a
    /// tool fires and shrinks when one stops makes the whole list jump every few seconds.
    private func step(_ s: SessionRow, unread: Bool) -> some View {
        let line = sessions.activity[s.key]?.last
        return Text(line?.text ?? " ")
            .font(.system(size: 9, design: line?.thought == true ? .default : .monospaced))
            .foregroundColor(line == nil ? .clear : unread ? Self.unreadStep : line?.thought == true ? Self.said : Self.tool)
            .lineLimit(1)
            .frame(height: 11, alignment: .leading)
    }

    private static let amber = Color(hex: "#e0a03a")
    private static let name = Color(hex: "#c7cdd6")
    private static let tool = Color(hex: "#4fd1c5")
    private static let said = Color(hex: "#d5dde6")
    private static let unreadStep = Color(hex: "#e6c88a")
}

/// One conversation: the last prompt and the reply to it, the tool calls of the turn it is running,
/// and a reply of his own. Double tap records a follow-up (bound to the bottom control alone: a
/// follow-up has no lock), as does a tap anywhere on the text; the next press sends, and a parked
/// session is resumed with the words. Scrolling is his finger or the crown.
struct SessionView: View {
    let key: String
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared

    private var detail: SessionDetail? { sessions.details[key] }
    private var activity: [ActivityLine] { sessions.activity[key] ?? [] }
    private var recording: Bool { capture.owner == .session(key) }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(name: "session", recording: recording, canRecord: !sessions.busy.contains(key),
                        record: { sessions.toggleRecording(key) }) {
                Button {
                    Hub.log("record", ["view": "session", "recording": recording])
                    sessions.toggleRecording(key)
                } label: { content }
                    .buttonStyle(.plain)
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
        .task {
            sessions.markSeen(key)   // opening it is reading it, here as on the phone
            await sessions.loadDetail(key)
        }
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
            RecordingBar { sessions.cancelRecording(key) }
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
