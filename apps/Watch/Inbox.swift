import SwiftUI

/// **The inbox** (docs/WATCH.md § The inbox): every reply flagged worth reading, newest
/// first, read or not, kept for good. The dot at the top of home, which is always there — amber while
/// anything is unread, gray otherwise — opens it, steps back out of an answer, and closes it; an open
/// answer also has a ✕ in its top-left corner that steps back to the list, where it was left. A
/// session's row (teal) opens that session on the sessions page; any other row opens its answer ON ITS OWN, question above it, opened at the top; a tap on that page records a
/// command about it (`Hub.about`), and the follow-ups and their replies list under it.
///
/// Drawn as a layer OVER home rather than a sheet, because the command is the double tap bound by
/// `CommandBorder` above the page row, and a sheet would cover it.
struct InboxRow: Decodable, Identifiable, Equatable {
    let id: String
    let at: String
    var read: Bool
    let label: String
    let session_id: String?
    let session_label: String?
}

struct InboxPage: Decodable {
    let unread: Bool
    let rows: [InboxRow]
}

struct InboxAnswer: Decodable {
    struct Follow: Decodable, Identifiable {
        let id: String
        let role: String
        let text: String
    }
    let id: String
    let read: Bool
    let question: String
    let answer: String
    let session_id: String?
    let session_label: String?
    var follow: [Follow]
}

extension Hub {
    /// The answer an inbox page has open, sent with a pressed command as `about` (`commandQuery`). Read
    /// when the clip is made, so a clip that waits to upload stays about what was on screen when it was
    /// said.
    nonisolated(unsafe) static var about: String?

    static func inbox(before: String? = nil) async throws -> InboxPage {
        let q = before.flatMap { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) }.map { "&before=\($0)" } ?? ""
        return try await json("/api/voice-inbox?limit=40\(q)")
    }

    static func inboxAnswer(_ id: String) async throws -> InboxAnswer {
        try await json("/api/voice-inbox/\(pathComponent(id))")
    }
}

struct InboxView: View {
    @EnvironmentObject private var chat: Chat
    /// The answer open, owned by home because the dot that steps back out of it is home's.
    @Binding var open: InboxAnswer?
    @State private var rows: [InboxRow] = []
    @State private var done = false
    @State private var loading = false
    /// The row tapped whose answer is still being fetched. The list stays up until it arrives.
    @State private var opening: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            // The list stays alive under an open answer, so closing the answer returns to the same place
            // in it rather than to the top.
            list
                .opacity(open == nil ? 1 : 0)
                .allowsHitTesting(open == nil)
            if let open {
                AnswerView(initial: open)
                    .background(Color.black.ignoresSafeArea())
                    .id(open.id)
            }
        }
        // **The ✕ closes an open answer back to the list.** Outside AnswerView, whose every tap is the
        // press, so a tap on it never also records.
        .overlay(alignment: .topLeading) {
            if open != nil {
                Button { open = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color(hex: "#8b96a5"))
                        .frame(width: 44, height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .ignoresSafeArea()
            }
        }
        .onChange(of: chat.thread.last?.id) { _, _ in if open == nil { Task { await refresh() } } }
        .onChange(of: open?.id) { _, now in if now == nil { Task { await refresh() } } }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { r in
                    Button {
                        Task { if let sid = r.session_id { await openSession(sid, row: r) } else { await show(r.id) } }
                    } label: { row(r) }
                        .buttonStyle(.plain)
                        .opacity(opening == r.id ? 0.5 : 1)
                        .onAppear { if r.id == rows.last?.id { Task { await more() } } }
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, PageInset.bottom)
        }
        .scrollIndicators(.never)
        .topOfTheScreen(scrollTop: Landing.top)
        .task { if rows.isEmpty { await more() } }
    }

    /// **A row opens only once its answer is in hand**, so the page appears whole — no frame of an empty
    /// page, no content arriving under the reader.
    private func show(_ id: String) async {
        guard opening == nil else { return }
        opening = id
        defer { opening = nil }
        do {
            let got = try await Hub.inboxAnswer(id)
            open = got
            if !got.read { chat.markRead(id) }
        } catch { Hub.log("inbox-answer-failed", ["id": id, "error": "\(error)"]) }
    }

    /// **A session's answer opens the session itself**, on the sessions page, where it can be read in
    /// full and answered; the inbox stays open on home for coming back to.
    private func openSession(_ sid: String, row r: InboxRow) async {
        if !r.read { chat.markRead(r.id) }
        await Sessions.shared.open(rowId: sid)
    }

    private func row(_ r: InboxRow) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Rectangle().fill(r.read ? Color.clear : Color(hex: "#e0a03a")).frame(width: 2)
            Text(r.label)
                .font(.system(size: 15))
                .foregroundStyle(r.read ? Color(hex: "#7d8794") : (r.session_id != nil ? Color(hex: "#9fe3d3") : .white))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    /// The next page further back.
    private func more() async {
        guard !loading, !done else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await Hub.inbox(before: rows.last?.at)
            let have = Set(rows.map(\.id))
            rows += page.rows.filter { !have.contains($0.id) }
            if page.rows.count < 40 { done = true }
        } catch { Hub.log("inbox-failed", ["error": "\(error)"]) }
    }

    /// The newest page again, merged in: a new answer lands at the top, a read one dims, and the rows
    /// further back — and the reader's place among them — are left alone.
    private func refresh() async {
        do {
            let page = try await Hub.inbox()
            var byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            for r in page.rows { byId[r.id] = r }
            rows = byId.values.sorted { $0.at > $1.at }
        } catch { Hub.log("inbox-failed", ["error": "\(error)"]) }
    }
}

/// One answer on its own: the question, the answer, then the follow-ups spoken from it. Opens at its
/// top, already loaded, and never moves after: a follow-up's words or its reply arriving lay out below.
///
/// **A tap anywhere on it is the press** — the same as a tap on home: it starts a recording and the
/// next press sends it, and while this page is up the command carries the answer as `about`
/// (`Hub.about`), so the model gets this question and answer with it.
private struct AnswerView: View {
    @EnvironmentObject private var chat: Chat
    @State private var a: InboxAnswer

    init(initial: InboxAnswer) { _a = State(initialValue: initial) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if !a.question.isEmpty {
                    Markdown(text: a.question, size: 13).foregroundStyle(Color(hex: "#8b96a5"))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                VStack(alignment: .leading, spacing: 2) {
                    if a.session_id != nil, let name = a.session_label {
                        Text(name.uppercased()).font(.system(size: 10, weight: .bold)).foregroundStyle(Color(hex: "#3fb89d"))
                    }
                    Markdown(text: a.answer, size: 14)
                }
                ForEach(a.follow) { m in
                    Markdown(text: m.text, size: m.role == "user" ? 13 : 14)
                        .foregroundStyle(m.role == "user" ? Color(hex: "#8b96a5") : .white)
                        .frame(maxWidth: .infinity, alignment: m.role == "user" ? .trailing : .leading)
                }
                // A follow-up still running: its words, from the moment the hub has heard them.
                ForEach(chat.pending(about: a.id), id: \.request) { p in
                    Markdown(text: p.words, size: 13).foregroundStyle(Color(hex: "#8b96a5"))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, PageInset.bottom)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
        .topOfTheScreen(scrollTop: Landing.top)
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .global) { at in
            CommandBorder.tapped(at)
            CommandBorder.press(chat: chat, sessions: Sessions.shared, how: "inbox-tap")
        }
        // A follow-up spoken from this page lands in the thread; its rows are taken from there.
        .onChange(of: chat.thread) { _, thread in takeFollow(thread) }
        .onAppear { Hub.about = a.id }
        .onDisappear { if Hub.about == a.id { Hub.about = nil } }
    }

    private func takeFollow(_ thread: [Message]) {
        let have = Set(a.follow.map(\.id))
        let rows = thread.filter { m in
            guard let rid = m.request_id, chat.askedAbout[rid] == a.id, !have.contains(m.id) else { return false }
            return m.role == "user" || m.role == "assistant"
        }
        guard !rows.isEmpty else { return }
        a.follow += rows.map { InboxAnswer.Follow(id: $0.id, role: $0.role ?? "assistant", text: $0.text ?? "") }
    }
}
