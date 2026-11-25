import SwiftUI

/// A handoff as `/api/handoffs/:id` answers (status-hub routes/handoffs.js).
struct HandoffState: Decodable, Equatable {
    let id: String
    let note: String?
    let target: String
    let status: String
    let seq: Int
    let img: String?
    let width: Int?
    let height: Int?
    let error: String?
    var open: Bool { status == "new" || status == "open" }
}

struct HandoffID: Identifiable { let id: String }

/// **The screen a session handed over, full screen** (docs/HANDOFFS.md). A tap on the screenshot is
/// clicked at that spot on the real screen; the keyboard button types there; then a fresh screenshot
/// arrives. The crown zooms (to tap something small), a drag pans, a double tap fits it again. Followed
/// with a held request per screenshot, never a timer.
struct HandoffView: View {
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var state: HandoffState?
    @State private var image: UIImage?
    @State private var busy = false
    @State private var mark: CGPoint?
    @State private var zoom = 1.0
    @State private var offset = CGSize.zero
    @State private var drag = CGSize.zero

    var body: some View {
        VStack(spacing: 4) {
            GeometryReader { geo in screen(geo.size) }
            controls
        }
        .ignoresSafeArea(edges: .bottom)
        .focusable()
        .digitalCrownRotation($zoom, from: 1, through: 5, by: 0.1, sensitivity: .medium,
                              isContinuous: false, isHapticFeedbackEnabled: true)
        .onChange(of: zoom) { _, z in if z <= 1.01 { offset = .zero } }
        .task { await follow() }
    }

    @ViewBuilder private func screen(_ size: CGSize) -> some View {
        if let image {
            let fit = fitted(image.size, in: size)
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .contentShape(Rectangle())
                    .onTapGesture(coordinateSpace: .local) { p in tap(p, in: fit) }
                if let mark {
                    Circle().stroke(Color(hex: "#ff3b6b"), lineWidth: 2).frame(width: 14, height: 14)
                        .position(mark)
                }
            }
            .opacity(busy ? 0.55 : 1)
            .scaleEffect(zoom)
            .offset(x: offset.width + drag.width, y: offset.height + drag.height)
            .gesture(DragGesture(minimumDistance: 8)
                .onChanged { drag = $0.translation }
                .onEnded { v in offset.width += v.translation.width; offset.height += v.translation.height; drag = .zero })
            .simultaneousGesture(TapGesture(count: 2).onEnded { zoom = 1; offset = .zero })
            .clipped()
        } else if let s = state, !s.open {
            Text(s.status == "failed" ? (s.error ?? "Failed") : s.status.capitalized)
                .frame(width: size.width, height: size.height)
        } else {
            ProgressView().frame(width: size.width, height: size.height)
        }
    }

    private var controls: some View {
        HStack(spacing: 4) {
            TextFieldLink(prompt: Text(state?.note ?? "")) {
                Image(systemName: "keyboard")
            } onSubmit: { text in
                if !text.isEmpty { act(["kind": "text", "text": text]) }
            }
            button("return") { act(["kind": "key", "key": "enter"]) }
            button("arrow.clockwise") { act(["kind": "refresh"]) }
            button("xmark") { act(["kind": "cancel"]) }
            button("checkmark") { act(["kind": "done"]) }
        }
        .font(.system(size: 15, weight: .semibold))
        .disabled(busy || state?.open != true)
        .padding(.bottom, 6)
    }

    private func button(_ glyph: String, _ go: @escaping () -> Void) -> some View {
        Button(action: go) { Image(systemName: glyph).frame(maxWidth: .infinity) }.buttonStyle(.plain)
    }

    /// Where an aspect-fitted image sits inside `size`.
    private func fitted(_ img: CGSize, in size: CGSize) -> CGRect {
        let s = min(size.width / img.width, size.height / img.height)
        let w = img.width * s, h = img.height * s
        return CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h)
    }

    private func tap(_ p: CGPoint, in r: CGRect) {
        guard !busy, r.contains(p) else { return }
        mark = p
        act(["kind": "tap", "x": (p.x - r.minX) / r.width, "y": (p.y - r.minY) / r.height])
    }

    private func act(_ body: [String: Any]) {
        guard let s = state, s.open else { return }
        busy = true
        var b = body
        b["seq"] = s.seq
        Task {
            do { try await Hub.handoffAct(id, b) } catch {
                Hub.log("error", ["msg": "handoff \(body["kind"] ?? "") not sent: \(String(describing: error).prefix(160))"])
                busy = false
            }
        }
    }

    /// One held request per screenshot, for as long as the handoff is open and this view is up.
    private func follow() async {
        var after = -1
        while !Task.isCancelled {
            do {
                let s = try await Hub.handoff(id, after: after, wait: after < 0 ? 0 : 40)
                if s.seq > after, let path = s.img {
                    do { image = try await HubImageCache.load(path, maxPixels: 1400) } catch {
                        Hub.log("error", ["msg": "handoff screenshot \(path) did not load: \(String(describing: error).prefix(160))"])
                    }
                    after = s.seq
                    mark = nil
                    busy = false
                }
                state = s
                if !s.open {
                    try? await Task.sleep(for: .seconds(1.2))
                    dismiss()
                    return
                }
            } catch {
                if Task.isCancelled { return }
                Hub.log("error", ["msg": "handoff \(id) read failed: \(String(describing: error).prefix(160))"])
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}
