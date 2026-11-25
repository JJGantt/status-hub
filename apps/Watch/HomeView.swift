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
/// scrolling to the end.
///
/// **The thread scrolls by three rules, the phone's too (`threadScroll` in public/shared.js), and nothing
/// else moves it**: opening the page lands on the newest message; a new message lands only while the view
/// is FOLLOWING (landed and not scrolled since, or let go at the very end); everything else — the wrist
/// dropping and rising, the app coming back, a reload — leaves it where it is.
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
    /// Every message's height, which decides how much of it must be on screen to count as shown (`shownAt`).
    @State private var heights: [String: CGFloat] = [:]
    /// The wrist is up with home in front: the read rule's test (`attend`). It never moves the view.
    @State private var looking = false
    /// **The view is on the newest message**: landed there and not scrolled since, or let go at the very
    /// end (`atBottom`). Only while following does an arrival land.
    @State private var following = true
    /// Following because the user let go at the very end: a re-layout keeps the end on screen rather than
    /// jumping back to the top of the newest message.
    @State private var atBottom = false
    /// The very end of the thread is on screen, asked of a marker's visibility.
    @State private var atEnd = false
    /// The page has landed once. Swiping back to it, or the app coming back, is not opening it.
    @State private var opened = false
    /// The row that was at the top when the user scrolled there and more rows were asked for: the scroll goes
    /// back onto it once they have laid out above it.
    @State private var keepAtTop: String?
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
                                guard seen, !following, keepAtTop == nil else { return }
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
                    Color.clear.frame(height: 1).id(Self.endId)
                        .onScrollVisibilityChange(threshold: 1) { atEnd = $0 }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, PageInset.bottom)
                .frame(maxWidth: .infinity, alignment: .leading)
                // A thread not yet caught up (`Chat.current`) is dimmed, so it is never taken for the latest.
                .opacity(dimmed ? 0.6 : chat.current ? 1 : 0.45)
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
            .onChange(of: target) { _, _ in if following { land(proxy, "target") } }
            // Asked to land (the unread dot, an answer's notification): always, even on the same answer.
            .onChange(of: chat.landings) { _, _ in land(proxy, "asked") }
            // **Any movement the page did not make is the user's**, the crown included, which is not trusted
            // to report a scroll phase. A change of content height is the page re-laying out.
            .onScrollGeometryChange(for: Scroll.self) { Scroll(y: $0.contentOffset.y, h: $0.contentSize.height) } action: { old, new in
                guard new.h == old.h else { relayout(proxy); return }
                if abs(new.y - old.y) > 0.5 && Date() > ownMoveUntil { userScrolled("move") }
            }
            .onScrollPhaseChange { _, now in
                if now == .interacting || now == .tracking || now == .decelerating { userScrolled("\(now)") }
                // Let go with the very end on screen: following again, from the next arrival on.
                if now == .idle && atEnd && !following { follow(atBottom: true); scrollLog("end", nil) }
            }
            .onAppear {
                guard !opened else { return }
                opened = true
                ownMoveUntil = Date() + 0.6
                jump(proxy, "appear")
            }
        }
        // Over the thread, inside the page, so the double tap above the page row still records.
        .overlay { if inbox { InboxView(open: $inboxAnswer) } }
        // **The top strip** (`TopStrip`): nothing in it moves, and it takes no touch, so a tap there still records.
        // A spinner at its left while the thread is catching up (`Chat.current`).
        .overlay(alignment: .top) {
            TopStrip {
                if !chat.current { ProgressView().scaleEffect(0.5).frame(width: 18, height: 18) }
            }
        }
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
        // Off screen while following: the rows asked for above go again. Not while the user is up the
        // thread, because rows removed above the screen move everything on it.
        .onChange(of: onScreen) { _, now in
            if !now && following { chat.resetWindow(); chat.dropHeld() }
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
        // the wrist still up. The wrist going down dims the screen, which is what says the user stopped.
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

    private static let endId = "end"

    private func follow(atBottom bottom: Bool) {
        following = true
        atBottom = bottom
        chat.following = true
    }

    private func land(_ proxy: ScrollViewProxy, _ why: String) {
        follow(atBottom: false)
        chat.resetWindow()
        keepAtTop = nil
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
        Hub.log("scroll", ["why": why, "at": row(at), "target": row(target),
                           "following": following, "atBottom": atBottom, "looking": looking,
                           "atEnd": atEnd, "inbox": inbox, "rows": chat.recent.count, "more": chat.hasMore,
                           "seen": chat.recent.indices.filter { visible.contains(chat.recent[$0].id) }.map(String.init).joined(separator: ",")])
    }

    /// The content changed height. Following, the view stays on what it showed: the end if it rested there,
    /// otherwise the top of the newest message, re-applied as the thread lays out over several passes.
    /// Not following, rows added above put back the row that was at the top, so they arrive above the user
    /// rather than under the user's finger.
    private func relayout(_ proxy: ScrollViewProxy) {
        if following {
            if atBottom { ownMoveUntil = Date() + 0.15; proxy.scrollTo(Self.endId, anchor: .bottom) }
            else { jump(proxy, "layout") }
        } else if let a = keepAtTop {
            keepAtTop = nil
            scrollLog("keep-top", a)
            ownMoveUntil = Date() + 0.15
            proxy.scrollTo(a, anchor: .top)
        }
    }

    /// **The user scrolled — a finger or the crown.** The view is the user's: nothing that arrives moves it
    /// until the user lets go at the very end, and an answer landed on by request lets go
    /// (`Chat.releaseLanding`).
    private func userScrolled(_ how: String) {
        if following { scrollLog("user-\(how)", nil) }
        following = false
        atBottom = false
        chat.following = false
        chat.releaseLanding()
    }

    private struct Scroll: Equatable { let y: CGFloat; let h: CGFloat }

    private func jump(_ proxy: ScrollViewProxy, _ why: String, animated: Bool = false) {
        guard let at = target else { return }
        scrollLog(why, at)
        ownMoveUntil = Date() + (animated ? 0.4 : 0.15)
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(at, anchor: .top) }
        } else {
            proxy.scrollTo(at, anchor: .top)
        }
    }

}
