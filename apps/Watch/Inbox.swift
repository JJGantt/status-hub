import SwiftUI

/// **The answers inbox** (docs/WATCH.md § The answers inbox): every reply flagged worth reading, newest
/// first, read or not, kept for good. Opened by the dot at the top of home, which is always there —
/// amber while anything is unread, gray otherwise. A row opens its answer ON ITS OWN, with the question
/// above it and the page landed on the answer; a command spoken while it is open is about it
/// (`Hub.about`), and the follow-ups and their replies list under it.
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
    let follow: [Follow]
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
    let close: () -> Void
    @State private var rows: [InboxRow] = []
    @State private var done = false
    @State private var loading = false
    @State private var open: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let open {
                AnswerView(id: open, back: { self.open = nil; Task { await refresh() } })
            } else {
                list
            }
        }
        .onChange(of: chat.thread.last?.id) { _, _ in if open == nil { Task { await refresh() } } }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Button(action: close) {
                    Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
                        .frame(width: 40, height: 28, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                ForEach(rows) { r in
                    Button { open = r.id } label: { row(r) }
                        .buttonStyle(.plain)
                        .onAppear { if r.id == rows.last?.id { Task { await more() } } }
                }
            }
        }
        .task { if rows.isEmpty { await more() } }
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

/// One answer on its own: the question, the answer, then the follow-ups spoken from it. Lands on the
/// answer when it opens and never moves after: a follow-up's words or its reply arriving lay out below.
private struct AnswerView: View {
    @EnvironmentObject private var chat: Chat
    let id: String
    let back: () -> Void
    @State private var a: InboxAnswer?
    @State private var landed = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Button(action: back) {
                        Image(systemName: "chevron.left").font(.system(size: 14, weight: .semibold))
                            .frame(width: 40, height: 28, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if let a {
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
                        .id("answer")
                        ForEach(a.follow) { m in
                            Markdown(text: m.text, size: m.role == "user" ? 13 : 14)
                                .foregroundStyle(m.role == "user" ? Color(hex: "#8b96a5") : .white)
                                .frame(maxWidth: .infinity, alignment: m.role == "user" ? .trailing : .leading)
                        }
                    }
                }
            }
            .onChange(of: a?.id) { _, now in
                guard now != nil, !landed else { return }
                landed = true
                proxy.scrollTo("answer", anchor: .top)
            }
        }
        .task { await load() }
        .onChange(of: chat.thread.last?.id) { _, _ in Task { await load() } }
        .onAppear { Hub.about = id }
        .onDisappear { if Hub.about == id { Hub.about = nil } }
    }

    private func load() async {
        do {
            let got = try await Hub.inboxAnswer(id)
            a = got
            if !got.read { chat.markRead(id) }
        } catch { Hub.log("inbox-answer-failed", ["id": id, "error": "\(error)"]) }
    }
}
