import SwiftUI

/// The page left of home: sessions still queued for a machine on top, then one row per conversation
/// the hub knows, running first, then parked, most recently active first within each. A tap opens one.
///
/// A row carries the same three marks as the phone's list (`cards/sessions.js`, `phone-home.css`),
/// because they answer different questions and are read together: the WHITE edge is the focused
/// session — where a spoken follow-up goes — with a pin beside its name when he pinned it there; the
/// AMBER edge is a finished reply nobody has opened; the DOT is a session working now.
/// Under each name is what its machine is doing, live off `/api/session-stream`.
struct SessionsView: View {
    @EnvironmentObject private var sessions: Sessions
    @ObservedObject private var capture = Capture.shared

    var body: some View {
        // A ScrollView, not a List: a watchOS List puts every row in a grey rounded slab, and this page
        // is a list of names. Rows are ruled apart the way the food log and the exercises are — the rule
        // does the separating and costs two pixels.
        //
        // A row pushes onto this PAGE's own stack, so the row of pages still swipes with a session open
        // and the session is still there when he swipes back (`Sessions.path`).
        NavigationStack(path: $sessions.path) {
            list
                .navigationDestination(for: String.self) { key in SessionView(key: key) }
        }
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(sessions.queued.enumerated()), id: \.element.id) { i, q in
                    queuedRow(q)
                        .overlay(alignment: .top) { if i > 0 { rule } }
                }
                ForEach(Array(sessions.list.enumerated()), id: \.offset) { i, s in
                    NavigationLink(value: s.key) { row(s) }
                        .buttonStyle(.plain)
                        .overlay(alignment: .top) { if i > 0 || !sessions.queued.isEmpty { rule } }
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

    private var rule: some View { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }

    /// A session waiting for a machine to have room: on top, since it is the newest thing asked for,
    /// and not a link, since there is nothing running to open yet.
    private func queuedRow(_ q: QueuedRow) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Rectangle().fill(Color.clear).frame(width: 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(q.name)
                    .font(.system(size: 14))
                    .foregroundColor(Self.name)
                    .lineLimit(2)
                if let p = q.prompt, !p.isEmpty {
                    Text(snippet(p))
                        .font(.system(size: 11))
                        .foregroundColor(.gray)
                        .lineLimit(2)
                }
                Text("Queued")
                    .font(.system(size: 9))
                    .foregroundColor(Self.amber)
                    .frame(height: 11, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                        .foregroundColor(unread || focused ? .white : Self.name)
                        .lineLimit(2)
                }
                if let say = s.say, !say.isEmpty {
                    // Led by how long ago it last spoke or was spoken to, as on the phone's list.
                    ((s.ago.map { Text($0 + "  ").foregroundColor(Self.when) } ?? Text(""))
                        + Text(snippet(say)).foregroundColor(.gray))
                        .font(.system(size: 11))
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
        // An incident run: a red outline and a dark red ground, as on the phone.
        .background(s.incident == true ? Self.incidentGround : Color.clear)
        .overlay(RoundedRectangle(cornerRadius: 4)
            .stroke(s.incident == true ? Self.incidentEdge : Color.clear, lineWidth: 1.5))
        .contentShape(Rectangle())
    }

    private static let incidentEdge = Color(hex: "#d9443a")
    private static let incidentGround = Color(hex: "#1f0d0c")

    /// What this session's machine is doing, newest step only, in the colours of `Ink`. The line is
    /// always there, however empty — a row
    /// that grows when a tool fires and shrinks when one stops makes the whole list jump every few seconds.
    private func step(_ s: SessionRow, unread: Bool) -> some View {
        // A reply is not a step: the row's own `say` carries it, and a session that has answered shows
        // nothing live under its name.
        let ev = sessions.latest[s.key].flatMap { $0.kind == "reply" ? nil : $0 }
        let ink: Color = switch ev?.kind {
        case "tool": Ink.tool
        case "text": Ink.thought
        case "prompt": Ink.mine
        default: .clear
        }
        return Text(ev?.text ?? " ")
            .font(.system(size: 9, design: ev?.kind == "tool" ? .monospaced : .default))
            .foregroundColor(unread && ev != nil ? Self.unreadStep : ink)
            .lineLimit(1)
            .frame(height: 11, alignment: .leading)
    }

    private static let amber = Color(hex: "#e0a03a")
    private static let when = Color(hex: "#8b96a5")
    private static let name = Color(hex: "#c7cdd6")
    private static let unreadStep = Color(hex: "#e6c88a")
}

/// One conversation: the hub's list of its events — his words, the tool calls, what the session says
/// between them, its replies — drawn in order, plus his words on their way from this watch. Double tap
/// or a tap anywhere on the glass is the one press
/// (`CommandBorder.press`): it records a follow-up, locked open until the next press sends it; a
/// parked session is resumed with the words. Scrolling is his finger or
/// the crown.
struct SessionView: View {
    let key: String
    @EnvironmentObject private var sessions: Sessions

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
    /// Every item's height, which decides whether the newest needs room above it (`room`). Kept for all
    /// of them: the newest changes in the same update that lands it, and a height taken only once an item
    /// IS the newest arrives after the landing, or never when its height does not change.
    @State private var heights: [String: CGFloat] = [:]
    /// The item the page is on — `newest`, except while something newer is held: **nothing that arrives
    /// moves the page while he is looking.** It lands once he stops looking (home's rule too).
    @State private var spot: String?
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.scenePhase) private var phase
    @Environment(\.onScreen) private var onScreen
    private var looking: Bool { !dimmed && phase == .active && onScreen }

    @ObservedObject private var speaker = Speaker.shared

    private var events: [SessionEvent] { sessions.logs[key]?.events ?? [] }
    private var placeholders: [Placeholder] { sessions.placeholders[key] ?? [] }

    /// Every event in order, a prompt at the position of its LATEST occurrence — it moves from where it
    /// was queued to where the model read it — so one message is one line.
    private var all: [SessionEvent] {
        var seen = Set<String>()
        var out: [SessionEvent] = []
        for e in events.reversed() {
            if e.kind == "prompt" { if !seen.insert(e.id).inserted { continue } }
            out.append(e)
        }
        return out.reversed()
    }

    /// **How many turns are laid out**, counted back by his prompts: `turnStep` on opening, a step more
    /// each time he scrolls to the very top. The hub keeps up to ten turns and every tool call in them,
    /// which can be hundreds of rows, and laying all of those out is what made swiping onto the page lag.
    @State private var turns = SessionView.turnStep
    private static let turnStep = 3
    /// The row that was at the top when he scrolled there for more: the scroll goes back onto it once
    /// the earlier turns have laid out above it.
    @State private var keepAtTop: String?

    /// What is drawn: the last `turns` turns of `all`.
    private var shown: [SessionEvent] { window.events }
    private var window: (events: [SessionEvent], more: Bool) {
        let list = all
        let prompts = list.indices.filter { list[$0].kind == "prompt" }
        guard prompts.count > turns else { return (list, false) }
        return (Array(list[prompts[prompts.count - turns]...]), true)
    }

    var body: some View {
        ScrollViewReader { proxy in
            PagedScroll(reachedEnd: { atEnd = $0 }) {
                content
                status
            }
            // **A tap ANYWHERE is the press**, as on home: on the scroll view rather than its content, so
            // the glass below a short conversation presses too. A scroll, a swipe and the crown are not
            // taps. The name at the top and the speaker glyphs are buttons, so they take their own taps.
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .global) { at in
                CommandBorder.tapped(at)
                CommandBorder.press(chat: Chat.shared, sessions: sessions, how: "tap")
            }
            // **Swiping right closes it.** Sessions is the leftmost page, so the page row has nothing to
            // turn to on a rightward swipe and the drag is free to mean back. Mostly sideways, so a
            // scroll that drifts is not one; simultaneous, so the scroll and the page row keep theirs.
            .simultaneousGesture(DragGesture(minimumDistance: 20).onEnded { g in
                let dx = g.translation.width, dy = g.translation.height
                guard dx > 40, dx > 2 * abs(dy), !sessions.path.isEmpty else { return }
                Hub.log("swipe-close", ["row": key])
                sessions.path.removeLast()
            })
            // **The top of the NEWEST ITEM at the top of the screen**: his words the moment they are
            // transcribed, then each tool call as it comes, then the reply — whichever is last, once he
            // is not looking (`holds`). Never
            // an older one: the tool calls and his words stay until the reply that replaces them is
            // in hand (`Sessions.sessionFrame`).
            .onChange(of: newest) { _, now in
                guard following else { return }
                if holds(now) { Hub.log("land-held", ["row": key, "at": spot ?? "", "next": now ?? ""]); return }
                toNewest(proxy)
            }
            // He stopped looking with something held: it lands now, so it is waiting for the next raise.
            .onChange(of: looking) { _, now in
                if !now && following && spot != newest { toNewest(proxy) }
            }
            // Off screen while following the newest: the earlier turns he asked for go again, so the
            // next swipe back lays out only the default.
            .onChange(of: onScreen) { _, now in
                if !now && following && turns != Self.turnStep { turns = Self.turnStep }
            }
            // **Any movement the page did not make is his.** A drag reports a scroll phase; the crown is
            // not relied on to, so a move with no jump of ours behind it and no change in the content's
            // height (which is the page re-laying out, and can clamp the offset) counts as his scroll
            // too. The page's own jumps are never animated, so each is exactly one move to account for.
            .onScrollGeometryChange(for: Scroll.self) { Scroll(y: $0.contentOffset.y, h: $0.contentSize.height) } action: { old, new in
                if new.h != old.h {
                    if following { toSpot(proxy) }
                    // Earlier turns were added above: back onto the row that was at the top, so they
                    // arrive above him rather than under his finger.
                    else if let a = keepAtTop { keepAtTop = nil; jumping = true; proxy.scrollTo(a, anchor: .top) }
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
            .onAppear { toNewest(proxy); logShown("appear") }
            .onChange(of: newest) { _, n in logShown("newest") }
            .onChange(of: events.count) { _, _ in logShown("events") }
            .onChange(of: placeholders.count) { _, _ in logShown("placeholders") }
        }
        // In the corner of the GLASS, not of the safe area, which stops well short of the bottom while
        // the page scrolls on under it: a clear layer that reaches the screen's edge carries the button.
        .overlay {
            Color.clear
                .overlay(alignment: .bottomTrailing) {
                    // While the voice plays the crown is the watch's volume, not the scroll. Beside the
                    // stop glyph rather than in the other corner, where the display's curve cuts it off.
                    HStack(spacing: 0) {
                        if speaker.isSpeaking {
                            VolumeKnob().frame(width: 44, height: 36).padding(.bottom, 4)
                        }
                        playButton
                    }
                }
                .ignoresSafeArea(.container, edges: .bottom)
        }
        // The session's name on the clock's line, and NO system back arrow: a title bar with a button in
        // it costs the top of a screen this page spends on the answer. A leading toolbar item leaves the clock where watchOS
        // puts it; a trailing one would push the time to the other end of the strip.
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                // **The name closes it**, as does a swipe right (above). The swipe back watchOS gives a
                // pushed view does not survive a page row that also takes sideways swipes.
                // A small chevron before the name says it is a way back without having to know it; the
                // name and the chevron are one button.
                // Guarded: two taps close enough together that the first pop hasn't dismissed this
                // button yet would call removeLast() on an already-empty path and crash.
                Button { if !sessions.path.isEmpty { sessions.path.removeLast() } } label: {
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
            await sessions.loadLog(key)
        }
    }

    /// **The speaker glyph**: a tap plays this session's last reply out loud; HOLDING it turns speak mode
    /// on or off (`Sessions.toggleSpeakMode`, through the row's one hold gesture), and while the mode is on the glyph is white with a third
    /// wave instead of grey. While a reply plays the corner holds a stop and a pause, which becomes a play
    /// while paused: pausing keeps the place, so carrying on does not start the reply over. Bare glyphs
    /// over the page, so they cost no row. Their own gestures, so a tap on one is not the press the rest
    /// of the glass is.
    @ViewBuilder private var playButton: some View {
        let reply = events.last(where: { $0.kind == "reply" })
        if reply != nil || sessions.speakMode {
            HStack(spacing: 0) {
                if speaker.isSpeaking {
                    glyph("stop.fill") { speaker.stop() }
                    glyph(speaker.paused ? "play.fill" : "pause.fill") {
                        speaker.paused ? speaker.unpause() : speaker.pause()
                    }
                } else {
                    Image(systemName: sessions.speakMode ? "speaker.wave.3.fill" : "speaker.wave.2.fill")
                        .font(.system(size: 13))
                        .foregroundColor(sessions.speakMode ? .white : Color(hex: "#7d8894"))
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                        .onTapGesture { if let reply { speaker.speak(reply.text) } }
                        // Only says a finger is here; the row's hold does the toggle (`Sessions.speakerPressed`).
                        .simultaneousGesture(DragGesture(minimumDistance: 0)
                            .onChanged { _ in sessions.speakerPressed = true }
                            .onEnded { _ in sessions.speakerPressed = false })
                }
            }
            // Inset far enough to clear the display's corner curve.
            .padding(.trailing, 6)
            .padding(.bottom, 4)
        }
    }

    private func glyph(_ name: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 13))
                .foregroundColor(Color(hex: "#7d8894"))
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The scroll id of the newest thing on the page. His newest words take the top, with what the
    /// session does about them underneath: words of his still on their way, else the last prompt since
    /// the last reply; with none, the last event — the reply when it lands.
    private var newest: String? {
        if let p = placeholders.last { return "ph\(p.msgId)" }
        let list = shown
        let lastReply = list.lastIndex { $0.kind == "reply" } ?? -1
        if let i = list.indices.reversed().first(where: { $0 > lastReply && list[$0].kind == "prompt" }) {
            return "ev\(list[i].seq)"
        }
        return list.last.map { "ev\($0.seq)" }
    }

    /// The top of the newest item at the top of the screen, or as near it as the end of the content
    /// allows: a short last item sits at the bottom with what came before it filling the screen.
    private func toNewest(_ proxy: ScrollViewProxy) {
        spot = newest
        toSpot(proxy)
    }

    /// Back onto the item the page is on, as the content re-lays out under it.
    private func toSpot(_ proxy: ScrollViewProxy) {
        guard let id = spot ?? newest else { return }
        jumping = true
        proxy.scrollTo(id, anchor: .top)
    }

    /// **Whether an arrival waits: always, while he is looking.** His words from this watch, a tool call,
    /// the reply — none of them moves the page with the wrist up; it lands when he stops looking.
    private func holds(_ next: String?) -> Bool {
        guard looking, let spot, next != spot else { return false }
        return true
    }

    /// **What the screen actually holds**, logged whenever the reason it might be wrong changes: the
    /// data arriving, the anchor moving, or the page opening. A report of something wrong on the wrist
    /// is otherwise unreproducible — the `detail` log line is what the HUB sent, not what this page did
    /// with it, and those two can differ (a stale anchor, a scroll that never followed, a turn dropped
    /// by `newest`'s own rule).
    private func logShown(_ why: String) {
        let list = shown
        Hub.log("session-shown", [
            "why": why, "row": key, "newest": newest ?? "", "following": following, "landed": landed,
            "events": events.count, "last": sessions.logs[key]?.last ?? 0, "placeholders": placeholders.count,
            "tail": list.suffix(3).map { "\($0.kind):\($0.text.prefix(30))" }.joined(separator: " | "),
        ])
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
        // An ordinary gap between items, and the landing's height above the newest one only (`room`),
        // so the item before it is off the top of the screen when it lands.
        let (shown, more) = window
        return VStack(alignment: .leading, spacing: Landing.itemGap) {
            // **Scrolled to the very top lays out more** (`turns`). Asked of a marker's visibility, not
            // of offsets, which this scroll view reports unreliably (docs/WATCH.md); only after his own
            // scroll, so the page laying out never asks.
            if more {
                Color.clear.frame(height: 1)
                    .onScrollVisibilityChange(threshold: 1) { seen in
                        guard seen, !following, keepAtTop == nil else { return }
                        keepAtTop = shown.first.map { "ev\($0.seq)" }
                        turns += Self.turnStep
                        Hub.log("session-more", ["row": key, "turns": turns])
                    }
            }
            ForEach(shown, id: \.seq) { e in
                room("ev\(e.seq)")
                row(e).id("ev\(e.seq)").onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights["ev\(e.seq)"] = $0 }
            }
            // His words on their way from this watch, dimmed until the hub has them.
            ForEach(placeholders, id: \.msgId) { p in
                room("ph\(p.msgId)")
                words(p.text).opacity(0.5).id("ph\(p.msgId)")
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights["ph\(p.msgId)"] = $0 }
            }
        }
        // At least a screen tall, so a short conversation's blank space below the last line is still
        // tappable: the tap gesture and its hit-testing (below) are on this view's own frame, which
        // without a minimum is only as tall as the text, leaving the rest of the visible screen dead —
        // no press, and no way to stop a reply mid-speech by tapping there.
        .frame(maxWidth: .infinity, minHeight: WKInterfaceDevice.current().screenBounds.height, alignment: .topLeading)
        .contentShape(Rectangle())
    }

    /// The room above the newest item: a spacer of its OWN, not padding on the item. Padding becomes part
    /// of the frame a scroll lands on, which put the item's text a whole landing's height too low. And
    /// only when the item is tall enough to reach the landing line: a short last item rests at the end of
    /// the scroll with what came before it on screen anyway, where the room is only a blank band.
    @ViewBuilder private func room(_ id: String) -> some View {
        if id == (spot ?? newest) && tallEnough(id) { Color.clear.frame(height: Landing.underTitle - 2 * Landing.itemGap) }
    }

    private func tallEnough(_ id: String) -> Bool {
        (heights[id] ?? 0) > WKInterfaceDevice.current().screenBounds.height - Landing.underTitle - PageInset.bottom
    }

    /// One event, in the colours of `Ink`: his words a soft blue (dimmed while queued, not yet read),
    /// a tool call violet and cut to two lines, what the session says between calls grey, its reply
    /// white — the same as home's `ActivityLines` and `ThreadRow`, so who said what reads the same on
    /// every page.
    @ViewBuilder private func row(_ e: SessionEvent) -> some View {
        switch e.kind {
        case "prompt":
            words(e.text).opacity(e.seen == false ? 0.5 : 1)
        case "text":
            Markdown(text: e.text, size: 12)
                .foregroundColor(Ink.thought)
        case "tool":
            Text(e.text)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Ink.tool)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        default:
            Markdown(text: e.text)
                .foregroundColor(.white)
        }
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

