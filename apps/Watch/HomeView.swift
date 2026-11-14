import SwiftUI
import WatchKit

/// The page the app opens on, and the only one the conversation lives on: the last five exchanges of
/// the shared hub thread in full — the user's words as they were transcribed, the reply as it was written —
/// with the control at the bottom edge carrying the command and the x beside it throwing one away.
///
/// **A command walks the page.** The press sends it and the wrist is tapped; the control turns to the
/// spinner and the x appears; the transcript lands in the thread and the view settles on the top of
/// it, with the spinner bigger now that the hub is running the command rather than hearing it; the
/// reply lands, the view settles on the top of THAT, the control is a microphone again and the x goes.
/// A reply is read from its first line, which is why each of those lands the view on a top rather than
/// scrolling to the end. **None of it moves the view while the user is reading** (`holds`) — looking, and
/// scrolled since the raise: each landing then waits for the wrist to drop, so it is in place at the next raise.
struct HomeView: View {
    @EnvironmentObject private var chat: Chat
    /// Wrist down with the app still showing.
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.scenePhase) private var phase
    @Environment(\.onScreen) private var onScreen
    /// Rows on screen now, by message id, for the read rule (`attend`).
    @State private var visible: Set<String> = []
    /// An unread answer on screen, counting down to read.
    @State private var reading: [String: Task<Void, Never>] = [:]
    /// Whether the view is held at `target`. Kept until the user scrolls themselves: a thread still laying out
    /// moves the spot, so a single jump lands short of it.
    @State private var pinned = true
    /// Every message's height, which decides how much of it must be on screen to count as shown (`shownAt`).
    @State private var heights: [String: CGFloat] = [:]
    /// What the view is held at — `target`, except while something newer is HELD: **an arrival does not
    /// take the view from an answer the user is reading** (`holds`). It lands as soon as the user stops looking.
    @State private var landed: String?
    @State private var looking = false
    /// **The user has scrolled since this look began** (the raise, the app coming to the front, the page
    /// swiped to). Looking without having scrolled is not reading: a fresh raise is on whatever the page
    /// left it on, so an arrival lands then. Cleared when the user stops looking.
    @State private var touched = false
    /// The very end of the thread is on screen. **Letting go of a scroll with the end on screen is not
    /// reading** (`touched` goes false): resting at the bottom, the next arrival lands like any other.
    @State private var atEnd = false
    /// Reading (`engaged`), which is what holds an arrival (`holds`): looking, and scrolled since the look began.
    private var engaged: Bool { looking && touched }
    /// The row that was at the top when the user scrolled there and more rows were asked for: the scroll goes
    /// back onto it once they have laid out above it.
    @State private var keepAtTop: String?
    /// A landing of the page's own is still settling: the thread lays out over several passes after a
    /// jump, and each one re-lands on `landed`. Only until the next arrival or the user's scroll — after
    /// that, while the user is reading, **nothing re-lands** (`settle`).
    @State private var settling = true
    /// The inbox is open over the thread (`InboxView`). The thread underneath is not being
    /// looked at then, so nothing in it counts as read.
    @State private var inbox = false
    /// The answer open in the inbox, already loaded: a row opens only once its answer is in hand, so the
    /// page appears whole rather than empty and then filled in.
    @State private var inboxAnswer: InboxAnswer?
    @State private var lastScrollLog: (key: String, at: Date) = ("", .distantPast)
    /// Until then a move of the offset is the page's own: a jump (animated ones run 0.2s) or the scroll view
    /// placing itself as it opens. After it, any move that is not a change of content height is the user's
    /// (`userScrolled`), which is how the crown counts: it is not trusted to report a scroll phase.
    @State private var ownMoveUntil = Date.distantPast

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Items sit an ordinary gap apart. What is above the newest one when it lands stays on
                // screen, under the top strip's shade.
                VStack(alignment: .leading, spacing: Landing.itemGap) {
                    // **Scrolled to the very top lays out more** (`Chat.window`). Asked of a marker's
                    // visibility, not of offsets, which this scroll view reports unreliably
                    // (docs/WATCH.md); only after the user's own scroll, so the page laying out never asks.
                    if chat.hasMore {
                        Color.clear.frame(height: 1)
                            .onScrollVisibilityChange(threshold: 1) { seen in
                                guard seen, !pinned, keepAtTop == nil else { return }
                                keepAtTop = chat.recent.first.map { "msg\($0.id)" }
                                scrollLog("more", keepAtTop)
                                chat.showMore()
                            }
                    }
                    ForEach(chat.recent) { m in
                        ThreadRow(text: m.text ?? "", user: m.role == "user", session: m.session_id != nil,
                                  engine: m.role == "assistant" ? m.engine : nil)
                            .id("msg\(m.id)")
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights["msg\(m.id)"] = $0 }
                            .onScrollVisibilityChange(threshold: shownAt(m)) { shown in
                                if shown { visible.insert(m.id) } else { visible.remove(m.id) }
                                attend()
                            }
                    }
                    // What the hub heard, until the turn itself lands in the thread.
                    ForEach(Array(chat.pending.enumerated()), id: \.offset) { i, words in
                        ThreadRow(text: words, user: true).id("pending\(i)")
                    }
                    if !chat.activity.isEmpty {
                        ActivityLines(lines: chat.activity)
                    }
                    CommandStatus()
                    // The very end of the thread is on screen (`atEnd`), asked of a marker's visibility.
                    Color.clear.frame(height: 1)
                        .onScrollVisibilityChange(threshold: 1) { atEnd = $0 }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, PageInset.bottom)
                .frame(maxWidth: .infinity, alignment: .leading)
                .opacity(dimmed ? 0.6 : 1)
            }
            // **A tap ANYWHERE on home is the same press as double tap**: start, then send. On the
            // scroll view rather than its content, so the glass below a short thread presses too. A
            // scroll, a swipe to another page and the crown are not taps, so they still only move.
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .global) { at in
                CommandBorder.tapped(at)
                CommandBorder.press(chat: chat, sessions: Sessions.shared, how: "tap")
            }
            .scrollIndicators(.never)
            .topOfTheScreen(scrollTop: Landing.top)
            .background(Color.black.ignoresSafeArea())
            .onChange(of: target) { _, now in
                if holds(now) { Hub.log("land-held", ["at": landed ?? "", "next": now ?? ""]); return }
                land(proxy, "target")
            }
            // Asked to land again on the same answer, after scrolling away from it: the target has not
            // changed, so nothing above moves the view.
            .onChange(of: chat.landings) { _, _ in land(proxy, "asked") }
            // The user stopped looking with something held: it lands now, so it is waiting for the next raise.
            .onChange(of: looking) { _, now in
                if !now { touched = false }
                if !now && landed != target { land(proxy, "unlook") }
            }
            // **Nothing moves the view while the user is reading**, a re-landing as much as a landing. Held,
            // `landed` is an older answer, and jumping back onto it each time the thread grows pulled the
            // view up the thread on every arrival — onto an answer that had itself moved. Content added
            // below moves nothing by itself, and `Chat.keepFrom` keeps rows from dropping off the top.
            .onScrollGeometryChange(for: Scroll.self) { Scroll(y: $0.contentOffset.y, h: $0.contentSize.height) } action: { old, new in
                guard new.h == old.h else { relayout(proxy); return }
                if abs(new.y - old.y) > 0.5 && Date() > ownMoveUntil { userScrolled("move") }
            }
            .onScrollPhaseChange { _, now in
                if now == .interacting || now == .tracking || now == .decelerating { userScrolled("\(now)") }
                if now == .idle && atEnd && touched { touched = false; Hub.log("reading", ["on": false, "why": "end"]) }
            }
            // Anything arriving while the user is reading ends a landing's settling: from then on it is the
            // user's page until the user stops looking.
            .onChange(of: chat.thread.last?.id) { _, _ in settle() }
            .onChange(of: chat.pending.count) { _, _ in settle() }
            .onChange(of: chat.activity.count) { _, _ in settle() }
            .onAppear { landed = target; settling = true; ownMoveUntil = Date() + 0.6; jump(proxy, "appear") }
        }
        // Over the thread, inside the page, so the double tap above the page row still records.
        .overlay { if inbox { InboxView(open: $inboxAnswer) } }
        // **The top strip** (`TopStrip`): nothing in it moves, and it takes no touch, so a tap there still records.
        .overlay(alignment: .top) { TopStrip { EmptyView() } }
        // **The inbox** (docs/WATCH.md): a dot at the top, always — amber while any answer is
        // unread, gray otherwise — drawn over the inbox as well as home, because it is the inbox's only
        // way in and out: home -> the list, an open answer -> the list, the list -> home. A button of its
        // own, so the tap does not also record.
        .overlay(alignment: .top) {
            Button {
                if !inbox { inbox = true } else if inboxAnswer != nil { inboxAnswer = nil } else { inbox = false }
                Hub.log("inbox-dot", ["open": inbox, "answer": inboxAnswer?.id ?? "", "unread": chat.unread.count])
            } label: {
                Circle().fill(chat.unread.isEmpty ? Self.readDot : Self.unreadDot).frame(width: 10, height: 10)
                    .frame(width: 48, height: TopStrip<EmptyView>.height).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(y: TopStrip<EmptyView>.drop)   // on the strip's row, beside the clock
            .ignoresSafeArea()
        }
        // An answer's notification lands on the answer in the thread, so the inbox gets out of the way.
        .onChange(of: chat.landings) { _, _ in inbox = false; inboxAnswer = nil }
        // A command spoken from an open answer goes in line in the thread, so the inbox gets out of the way.
        .onChange(of: chat.askedFromAnswer) { _, _ in inbox = false; inboxAnswer = nil }
        .onChange(of: inbox) { _, _ in attend() }
        .onChange(of: dimmed) { _, _ in attend() }
        .onChange(of: phase) { _, _ in attend() }
        .onChange(of: onScreen) { _, now in
            if !now { chat.resetWindow(); chat.dropHeld() }
            attend()
        }
        .onChange(of: chat.unread) { _, _ in attend() }
        .recordsWhenAsked()
    }

    /// Where the view settles: the top of the user's words while they are being worked on, otherwise the top
    /// of the newest thing in the thread, by the row's scroll id (`msg<id>`, `pending<i>`).
    private var target: String? {
        if let last = chat.pending.indices.last { return "pending\(last)" }
        if let id = chat.landOn, chat.recent.contains(where: { $0.id == id }) { return "msg\(id)" }
        return chat.recent.last.map { "msg\($0.id)" }
    }

    /// The amber the sessions list marks unread with.
    private static let unreadDot = Color(hex: "#e0a03a")
    private static let readDot = Color(hex: "#4a525c")

    /// How much of a row must be on screen to count as shown: half, or for a row taller than the
    /// screen, enough to fill a little under half the screen. A long answer counts once its opening is
    /// in front of the user, not only once the user has scrolled through it.
    private func shownAt(_ m: Message) -> Double {
        guard let h = heights["msg\(m.id)"], h > 0 else { return 0.5 }
        return min(0.5, Double(WKInterfaceDevice.current().screenBounds.height * 0.4 / h))
    }

    /// **The read rule**: an unread answer counts as read after two seconds on screen, with the app in
    /// front, home showing and the wrist up. Any of those ending first stops the count.
    private func attend() {
        // **A notification over the app is not looking away**: it drops the scene to `inactive` with
        // the wrist still up, and counted as away it would clear `touched` and land the view under the
        // user. The wrist going down dims the screen, which is what says the user stopped.
        looking = !dimmed && phase != .background && onScreen && !inbox
        chat.looking = looking
        chat.homeOpen = onScreen && phase != .background
        let due = looking ? Set(chat.unread.map(\.id)).intersection(visible) : []
        for (id, t) in reading where !due.contains(id) { t.cancel(); reading[id] = nil }
        for id in due where reading[id] == nil {
            reading[id] = Task {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                reading[id] = nil
                if chat.unread.contains(where: { $0.id == id }) { chat.markRead(id) }
            }
        }
    }

    /// **Whether an arrival waits: while the user is reading.** Nothing that arrives — the user's transcribed
    /// words, a tool call, a reply — moves the view once the user has scrolled with the wrist up; it lands
    /// the moment the user stops looking. Before that first scroll the raise is not reading, so it lands.
    /// A tap on the unread dot or an answer's notification (`chat.landings`) is asked for, so it never waits.
    private func holds(_ next: String?) -> Bool {
        guard engaged, let landed, next != landed else { return false }
        return true
    }

    private func land(_ proxy: ScrollViewProxy, _ why: String) {
        chat.resetWindow()
        keepAtTop = nil
        landed = target
        pinned = true
        settling = true
        jump(proxy, why, animated: true)
    }

    /// **Every scroll the page makes, and the start of every scroll the user makes**, as a `scroll` line
    /// with why it moved and the state that decided it (docs/WATCH.md § It logs what it does). A repeat
    /// of the same move within two seconds is one line: layout re-lands on every pass while it settles.
    private func scrollLog(_ why: String, _ at: String?) {
        let key = "\(why)|\(at ?? "")"
        if key == lastScrollLog.key && Date().timeIntervalSince(lastScrollLog.at) < 2 { return }
        lastScrollLog = (key, Date())
        // Row ids as their place in the thread (0 = oldest shown), which is what a reader of the log needs.
        func row(_ id: String?) -> String {
            guard let id else { return "" }
            if let i = chat.recent.firstIndex(where: { "msg\($0.id)" == id }) { return String(i) }
            return id
        }
        Hub.log("scroll", ["why": why, "at": row(at), "landed": row(landed), "target": row(target),
                           "pinned": pinned, "settling": settling, "looking": looking, "touched": touched,
                           "atEnd": atEnd, "inbox": inbox, "rows": chat.recent.count, "more": chat.hasMore,
                           "seen": chat.recent.indices.filter { visible.contains(chat.recent[$0].id) }.map(String.init).joined(separator: ",")])
    }

    /// The content changed height. While pinned, the landing is re-applied as it lays out; rows added
    /// above put back the row that was at the top, so they arrive above the user rather than under the user's finger.
    private func relayout(_ proxy: ScrollViewProxy) {
        if pinned { if settling || !engaged { jump(proxy, "layout") } }
        else if let a = keepAtTop {
            keepAtTop = nil
            scrollLog("keep-top", a)
            ownMoveUntil = Date() + 0.15
            proxy.scrollTo(a, anchor: .top)
        }
    }

    /// **The user scrolled — a finger or the crown.** The page is the user's from here: no landing is held
    /// against it, an answer landed on by request lets go (`Chat.releaseLanding`), and while the wrist is
    /// up an arrival waits.
    private func userScrolled(_ how: String) {
        if !touched || pinned { scrollLog("user-\(how)", nil) }
        pinned = false
        settling = false
        touched = looking
        chat.releaseLanding()
    }

    private struct Scroll: Equatable { let y: CGFloat; let h: CGFloat }

    private func settle() {
        guard engaged, settling else { return }
        settling = false
    }

    private func jump(_ proxy: ScrollViewProxy, _ why: String, animated: Bool = false) {
        guard let at = landed ?? target else { return }
        scrollLog(why, at)
        ownMoveUntil = Date() + (animated ? 0.4 : 0.15)
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(at, anchor: .top) }
        } else {
            proxy.scrollTo(at, anchor: .top)
        }
    }

}
