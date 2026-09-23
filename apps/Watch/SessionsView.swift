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
    @ObservedObject private var capture = Capture.shared

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
            VStack(alignment: .trailing, spacing: 4) {
                if s.working == true {
                    Circle().fill(Color.green).frame(width: 7, height: 7).padding(.top, 4)
                }
                Spacer(minLength: 0)
                // A recording running in THIS session, while he is somewhere else in the app: the one
                // thing about a session he needs to find again in a hurry.
                if capture.owner == .session(s.key) {
                    RoundedRectangle(cornerRadius: 2).fill(Color.red).frame(width: 9, height: 9)
                }
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

    /// Held on the newest reply until he scrolls: the turns lay out after the jump, and a single jump
    /// lands short of the spot it aimed at.
    @State private var pinned = true

    private var detail: SessionDetail? { sessions.details[key] }
    private var activity: [ActivityLine] { sessions.activity[key] ?? [] }
    private var recording: Bool { capture.owner == .session(key) }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(name: "session", readingWPM: sessions.readingWPM,
                        recording: recording, canRecord: !sessions.busy.contains(key),
                        cancel: recording ? { sessions.cancelRecording(key) } : nil,
                        record: { sessions.toggleRecording(key) }) {
                Button {
                    Hub.log("record", ["view": "session", "recording": recording])
                    sessions.toggleRecording(key)
                } label: { content }
                    .buttonStyle(.plain)
                    .disabled(sessions.busy.contains(key))
                status
            }
            // **A session opens ON its newest reply**, not at the top of the prompt above it: the
            // answer is what he came for, and the prompt is his own words. The same landing whenever a
            // new reply arrives. Work in progress — his words, a recording, tool calls — lands at the
            // bottom (`tail`, PagedScroll's end marker), so that is where the view follows it instead.
            .onChange(of: detail?.last_reply) { _, _ in pinned = true; toReply(proxy, animated: true) }
            .onChange(of: detail == nil) { _, _ in pinned = true; toReply(proxy) }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                if pinned { toReply(proxy) }
            }
            .onScrollPhaseChange { _, now in
                if now == .interacting || now == .tracking { pinned = false }
            }
            .onAppear { toReply(proxy) }
            .onChange(of: activity.count) { old, new in if new > old { toBottom(proxy) } }
            .onChange(of: sessions.sent[key]) { _, new in if new != nil { toBottom(proxy) } }
            .onChange(of: recording) { _, now in if now { toBottom(proxy) } }
        }
        // The session's name on the clock's line, and NO back arrow: the swipe that opened it from the
        // right is what takes it away again, and a title bar with a button in it costs the top of a
        // screen this page spends on the answer. A leading toolbar item leaves the clock where watchOS
        // puts it; a trailing one would push the time to the other end of the strip.
        .navigationBarBackButtonHidden(true)
        .persistentSystemOverlays(.hidden)   // the session's name has the line to itself
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Text(sessions.row(for: key)?.name ?? "")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .task {
            sessions.markSeen(key)   // opening it is reading it, here as on the phone
            await sessions.loadDetail(key)
        }
    }

    /// The top of the newest reply at the top of the screen. `PagedScroll` leaves most of a screen of
    /// room under the content, which is what lets the last block rise that far.
    private func toReply(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard detail != nil else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("reply", anchor: .top) }
        } else {
            proxy.scrollTo("reply", anchor: .top)
        }
    }

    private func toBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("tail", anchor: .bottom) }
    }

    private var content: some View {
        let turns = detail?.recent ?? []
        return VStack(alignment: .leading, spacing: 10) {
            // The last few exchanges, oldest first. The page opens on the newest reply, so the history
            // above it costs nothing to carry and is there when he scrolls up.
            ForEach(Array(turns.enumerated()), id: \.offset) { i, turn in
                if let prompt = turn.prompt, !prompt.isEmpty {
                    words(prompt)
                }
                if let reply = turn.reply, !reply.isEmpty {
                    Text(inlineMarkdown(reply))
                        .foregroundColor(.white)
                        .font(.system(size: 13))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id(i == turns.count - 1 ? "reply" : "reply\(i)")
                }
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
        if sessions.busy.contains(key) {
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
