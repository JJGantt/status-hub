import SwiftUI
import WatchKit

/// The page the app opens on, and the only one the conversation lives on: the last ten exchanges of
/// the shared hub thread in full — his words as they were transcribed, the reply as it was written —
/// with the control at the bottom edge carrying the command and the x beside it throwing one away.
///
/// **A command walks the page.** The press sends it and the wrist is tapped; the control turns to the
/// spinner and the x appears; the transcript lands in the thread and the view settles on the top of
/// it, with the spinner bigger now that the hub is running the command rather than hearing it; the
/// reply lands, the view settles on the top of THAT, the control is a microphone again and the x goes.
/// A reply is read from its first line, which is why each of those lands the view on a top rather than
/// scrolling to the end.
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
    /// Whether the view is held at `target`. Kept until he scrolls himself: a thread still laying out
    /// moves the spot, so a single jump lands short of it.
    @State private var pinned = true
    /// Every item's height, kept for all of them rather than only the newest: the newest changes in the
    /// same update that lands it, and a height measured only once an item IS the newest arrives a layout
    /// pass after the jump, so the room above it (`room`) came too late or not at all.
    @State private var heights: [String: CGFloat] = [:]


    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Items sit an ordinary gap apart; only the newest has the landing's height above it, so
                // the one before it is off the top when it lands (`lift`).
                VStack(alignment: .leading, spacing: Landing.itemGap) {
                    ForEach(chat.recent) { m in
                        room("msg\(m.id)")
                        ThreadRow(text: m.text ?? "", user: m.role == "user", session: m.session_id != nil)
                            .id("msg\(m.id)")
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights["msg\(m.id)"] = $0 }
                            .onScrollVisibilityChange(threshold: shownAt(m)) { shown in
                                if shown { visible.insert(m.id) } else { visible.remove(m.id) }
                                attend()
                            }
                    }
                    // What the hub heard, until the turn itself lands in the thread.
                    ForEach(Array(chat.pending.enumerated()), id: \.offset) { i, words in
                        room("pending\(i)")
                        ThreadRow(text: words, user: true).id("pending\(i)")
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights["pending\(i)"] = $0 }
                    }
                    if !chat.activity.isEmpty {
                        ActivityLines(lines: chat.activity)
                    }
                    CommandStatus()
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
            .onChange(of: target) { _, _ in
                pinned = true
                jump(proxy, animated: true)
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                if pinned { jump(proxy) }
            }
            .onScrollPhaseChange { _, now in
                if now == .interacting || now == .tracking { pinned = false }
            }
            .onAppear { jump(proxy) }
            // **Unread answers** (docs/WATCH.md): an amber dot at the top while any is left, and a tap
            // on it lands on the oldest. A button of its own, so the tap does not also record.
            .overlay(alignment: .top) {
                if let first = chat.unread.first {
                    Button {
                        Hub.log("unread-jump", ["id": first.id, "left": chat.unread.count])
                        pinned = false
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("msg\(first.id)", anchor: .top) }
                    } label: {
                        Circle().fill(Self.unreadDot).frame(width: 10, height: 10)
                            .frame(width: 48, height: 30).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .ignoresSafeArea()
                }
            }
        }
        .onChange(of: dimmed) { _, _ in attend() }
        .onChange(of: phase) { _, _ in attend() }
        .onChange(of: onScreen) { _, _ in attend() }
        .onChange(of: chat.unread) { _, _ in attend() }
        .recordsWhenAsked()
    }

    /// Where the view settles: the top of his words while they are being worked on, otherwise the top
    /// of the newest thing in the thread. **A row's scroll id is NOT the message id**: the ForEach
    /// already uses that as the identity of the row together with its `room`, and `scrollTo` resolves
    /// an id to the first view carrying it, so it landed the top of the ROOM on the landing line and
    /// left the room on screen with the item before it showing above.
    private var target: String? {
        if let last = chat.pending.indices.last { return "pending\(last)" }
        return chat.recent.last.map { "msg\($0.id)" }
    }

    /// The room above the newest item: a spacer of its OWN, not padding on the item. Padding becomes part
    /// of the frame a scroll lands on, which put the item's text a whole landing's height too low. And
    /// only when the item is tall enough to reach the landing line: a short last message rests at the
    /// end of the scroll with the thread above it on screen anyway, where the room is only a blank band.
    @ViewBuilder private func room(_ id: String) -> some View {
        if id == target && (heights[id] ?? 0) > WKInterfaceDevice.current().screenBounds.height - Landing.top - PageInset.bottom {
            Color.clear.frame(height: Landing.top - 2 * Landing.itemGap)
        }
    }

    /// The amber the sessions list marks unread with.
    private static let unreadDot = Color(hex: "#e0a03a")

    /// How much of a row must be on screen to count as shown: half, or for a row taller than the
    /// screen, enough to fill a little under half the screen. A long answer counts once its opening is
    /// in front of him, not only once he has scrolled through it.
    private func shownAt(_ m: Message) -> Double {
        guard let h = heights["msg\(m.id)"], h > 0 else { return 0.5 }
        return min(0.5, Double(WKInterfaceDevice.current().screenBounds.height * 0.4 / h))
    }

    /// **The read rule**: an unread answer counts as read after two seconds on screen, with the app in
    /// front, home showing and the wrist up. Any of those ending first stops the count.
    private func attend() {
        let looking = !dimmed && phase == .active && onScreen
        let due = looking ? Set(chat.unread.map(\.id)).intersection(visible) : []
        for (id, t) in reading where !due.contains(id) { t.cancel(); reading[id] = nil }
        for id in due where reading[id] == nil {
            reading[id] = Task {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                reading[id] = nil
                if let m = chat.unread.first(where: { $0.id == id }) { chat.markRead(m) }
            }
        }
    }

    private func jump(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard let target else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .top) }
        } else {
            proxy.scrollTo(target, anchor: .top)
        }
    }

}
