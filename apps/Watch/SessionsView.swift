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
        // A ScrollView, not a List: a watchOS List puts every row in a grey rounded slab, and this page
        // is a list of names. Rows are ruled apart the way the food log and the exercises are — the rule
        // does the separating and costs two pixels.
        //
        // A row pushes onto the app's root stack (RootView), so the session covers every page.
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(sessions.list.enumerated()), id: \.offset) { i, s in
                    NavigationLink(value: s.key) { row(s) }
                        .buttonStyle(.plain)
                        .overlay(alignment: .top) {
                            if i > 0 { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }
                        }
                }
                // Which build is on the wrist, so a fix that has not arrived is not taken for one that
                // failed. The TestFlight build number: CI stamps the run number into CFBundleVersion.
                Text("Build \(Self.build)")
                    .font(.system(size: 11))
                    .foregroundColor(.gray)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
                Color.clear.frame(height: PageInset.bottom)
            }
            // 8pt, matching every other page: a rule or a name run to the edge has its ends under
            // the display's corner arc at 4.
            .padding(.horizontal, 8)
        }
        .scrollIndicators(.never)
        .topOfTheScreen()
        .background(Color.black.ignoresSafeArea())
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
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        // A parked session is dimmed, unless it is holding a reply nobody has read.
        .opacity(s.running || unread ? 1 : 0.5)
    }

    /// What this session's machine is doing, newest step only, in the colours of `Ink`. The line is
    /// always there, however empty — a row
    /// that grows when a tool fires and shrinks when one stops makes the whole list jump every few seconds.
    private func step(_ s: SessionRow, unread: Bool) -> some View {
        let line = sessions.activity[s.key]?.last
        let ink: Color = switch line?.kind {
        case nil: .clear
        case .tool: Ink.tool
        case .thought: Ink.thought
        case .said: Ink.mine
        }
        return Text(line?.text ?? " ")
            .font(.system(size: 9, design: line?.kind == .tool ? .monospaced : .default))
            .foregroundColor(unread && line != nil ? Self.unreadStep : ink)
            .lineLimit(1)
            .frame(height: 11, alignment: .leading)
    }

    private static let amber = Color(hex: "#e0a03a")
    private static let name = Color(hex: "#c7cdd6")
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

    /// **Following the newest item.** The page stays on whatever is newest — his words, a tool call, the
    /// reply — until HE scrolls, by finger or crown, at all; then it is his, and nothing moves it until
    /// the session is opened again or he scrolls it to the very end himself. Also what holds the landing
    /// while the turns lay out after a jump, since a single jump lands short of the spot it aimed at.
    @State private var following = true
    /// The very end of the page is on screen.
    @State private var atEnd = false
    /// He has scrolled since following stopped: only HIS scroll reaching the end hands it back, not the
    /// page merely being at the end when it stopped.
    @State private var hisScroll = false
    /// A jump of the page's own is on its way; the move it makes is not his.
    @State private var jumping = false
    /// The page has landed once. Before that, the scroll view moves itself as it lays out (it shifts by
    /// the space under the title as it opens), and none of that is his.
    @State private var landed = false

    private var detail: SessionDetail? { sessions.details[key] }
    private var activity: [ActivityLine] { sessions.activity[key] ?? [] }
    private var recording: Bool { capture.owner == .session(key) }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(reachedEnd: { atEnd = $0 }) {
                Button {
                    Hub.log("record", ["view": "session", "recording": recording])
                    sessions.toggleRecording(key)
                } label: { content }
                    .buttonStyle(.plain)
                status
            }
            // **The top of the NEWEST ITEM at the top of the screen**: his words the moment they are
            // transcribed, then each tool call as it comes, then the reply — whichever is last. Never
            // an older one: the tool calls and his words stay until the reply that replaces them is
            // in hand (`Sessions.sessionFrame`).
            .onChange(of: newest) { _, _ in if following { toNewest(proxy) } }
            // **Any movement the page did not make is his.** A drag reports a scroll phase; the crown is
            // not relied on to, so a move with no jump of ours behind it and no change in the content's
            // height (which is the page re-laying out, and can clamp the offset) counts as his scroll
            // too. The page's own jumps are never animated, so each is exactly one move to account for.
            .onScrollGeometryChange(for: Scroll.self) { Scroll(y: $0.contentOffset.y, h: $0.contentSize.height) } action: { old, new in
                if new.h != old.h {
                    if following { toNewest(proxy) }
                } else if jumping {
                    jumping = false
                    landed = true
                } else if landed && abs(new.y - old.y) > 0.5 {
                    scrolled("move")
                }
            }
            .onScrollPhaseChange { _, now in
                switch now {
                case .interacting, .tracking, .decelerating: scrolled("drag")
                // Let go with the very end on screen after scrolling there: following again, from the
                // next new item on. Not a jump now: he is already looking at the end.
                case .idle:
                    if hisScroll && atEnd {
                        hisScroll = false
                        following = true
                        Hub.log("follow", ["on": true, "why": "end"])
                    }
                default: break
                }
            }
            .onAppear { toNewest(proxy) }
        }
        // The session's name on the clock's line, and NO back arrow: the swipe that opened it from the
        // right is what takes it away again, and a title bar with a button in it costs the top of a
        // screen this page spends on the answer. A leading toolbar item leaves the clock where watchOS
        // puts it; a trailing one would push the time to the other end of the strip.
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                // **The name closes it.** The swipe back watchOS gives a pushed view does not survive a
                // page row that also takes sideways swipes, so the way out is the thing at the top that
                // says which session this is.
                // A small chevron before the name says it is a way back without having to know it; the
                // name and the chevron are one button.
                Button { sessions.path.removeLast() } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(Color(hex: "#7d8894"))
                        Text(sessions.row(for: key)?.name ?? "")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .task {
            sessions.markSeen(key)   // opening it is reading it, here as on the phone
            await sessions.loadDetail(key)
        }
    }

    /// The scroll id of the last thing on the page: a tool call, else his words waiting for an answer,
    /// else the last turn's reply (or its prompt, while the session has not answered it).
    private var newest: String? {
        // His newest words take the top, with what the session does about them underneath; with none,
        // the tool calls land as one block, since each is a line or two and the newest alone at the top
        // would put the rest of the turn above the screen.
        if let i = activity.lastIndex(where: { $0.kind == .said }) { return "line\(i)" }
        if !activity.isEmpty { return "activity" }
        guard let turns = detail?.recent, let last = turns.last else { return nil }
        let i = turns.count - 1
        return (last.reply ?? "").isEmpty ? "prompt\(i)" : "reply\(i)"
    }

    /// The top of the newest item at the top of the screen, or as near it as the end of the content
    /// allows: a short last item sits at the bottom with what came before it filling the screen.
    private func toNewest(_ proxy: ScrollViewProxy) {
        guard let id = newest else { return }
        jumping = true
        proxy.scrollTo(id, anchor: .top)
    }

    /// He moved the page: it is his until the session is opened again or he scrolls to the end.
    private func scrolled(_ how: String) {
        hisScroll = true
        guard following else { return }
        following = false
        Hub.log("follow", ["on": false, "why": how])
    }

    private struct Scroll: Equatable { let y: CGFloat; let h: CGFloat }

    private var content: some View {
        let turns = detail?.recent ?? []
        return VStack(alignment: .leading, spacing: Landing.underTitle) {
            // The last few exchanges, oldest first. The page opens on the newest reply, so the history
            // above it costs nothing to carry and is there when he scrolls up.
            ForEach(Array(turns.enumerated()), id: \.offset) { i, turn in
                if let prompt = turn.prompt, !prompt.isEmpty {
                    words(prompt).id("prompt\(i)")
                }
                if let reply = turn.reply, !reply.isEmpty {
                    Text(inlineMarkdown(reply))
                        .foregroundColor(.white)
                        .font(.system(size: 13))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id("reply\(i)")
                }
            }
            if !activity.isEmpty {
                ActivityLines(lines: activity).id("activity")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// His side of the conversation, drawn as the prompt page draws his words.
    private func words(_ text: String) -> some View {
        Text(inlineMarkdown(text))
            .foregroundColor(Ink.mine)
            .font(.system(size: 12, weight: .medium))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var status: some View {
        if let failure = sessions.failures[key] {
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
