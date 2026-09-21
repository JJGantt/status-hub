import SwiftUI

/// The page to the right of the prompt: the hub nutrition card's four pace rings, then today's log.
struct NutritionView: View {
    @EnvironmentObject private var nutrition: Nutrition

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                // Redrawn every second, as the card's setInterval(tickRings, 1000).
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    RingsStrip(rings: nutrition.rings(at: ctx.date))
                }
                if let day = nutrition.day { DayLog(day: day) }
            }
            .padding(.horizontal, 4)
        }
        .scrollIndicators(.never)
        .background(Color.black.ignoresSafeArea())
    }
}

/// The card's `.rings` row: Cal, P, C, F, spread evenly with a 6pt gap. A macro the hub did not send
/// draws nothing, as the card's `ring()` returns '' for it.
private struct RingsStrip: View {
    let rings: [String: RingNow]
    private let keys = [("Cal", "calories"), ("P", "protein_g"), ("C", "carbs_g"), ("F", "fat_g")]

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            ForEach(keys, id: \.1) { glyph, key in
                if let r = rings[key] { RingCell(glyph: glyph, ring: r) }
            }
        }
    }
}

/// One ring, drawn to `cards/nutrition.js`'s SVG: an 80-unit box, a r=34 circle on a 7-unit stroke,
/// arcs from twelve o'clock clockwise with round caps, ticks from r=29 to r=39.5, the glyph on a
/// baseline at 37 and the deviation number on one at 54. Then `consumed / goal` under it (`.rtot`).
private struct RingCell: View {
    let glyph: String
    let ring: RingNow

    private static let track = Color(hex: "#0e1318")
    private static let glyphInk = Color(hex: "#c7ced8")

    var body: some View {
        VStack(spacing: 1) {
            Canvas { ctx, size in draw(ctx, k: size.width / 80) }
                .aspectRatio(1, contentMode: .fit)
            // String(), not interpolation: an interpolated Int is localised to "2,600", which the card
            // never prints.
            Text(String(ring.consumed) + " / " + String(ring.goal))
                .font(.system(size: 11))
                .foregroundColor(mutedText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
        .frame(maxWidth: .infinity)
    }

    private func draw(_ ctx: GraphicsContext, k: CGFloat) {
        let c = CGPoint(x: 40 * k, y: 40 * k)
        let r = 34 * k, lw = 7 * k

        var circle = Path()
        circle.addArc(center: c, radius: r, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
        ctx.stroke(circle, with: .color(Self.track), lineWidth: lw)

        func arc(_ f: Double, _ color: Color) {
            if f <= 0 {
                // The card's dasharray "0 C" still paints the round cap: a drained ring keeps a dot at
                // twelve o'clock rather than vanishing.
                let dot = CGRect(x: c.x - lw / 2, y: c.y - r - lw / 2, width: lw, height: lw)
                ctx.fill(Path(ellipseIn: dot), with: .color(color))
                return
            }
            var p = Path()
            p.addArc(center: c, radius: r, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * f),
                     clockwise: false)
            ctx.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: lw, lineCap: .round))
        }
        arc(ring.base, Color(hex: ring.baseColor))
        if ring.over > 0, let oc = ring.overColor { arc(ring.over, Color(hex: oc)) }

        func tick(_ pos: Double, _ color: Color) {
            let a = 2 * Double.pi * pos
            let pt = { (rad: CGFloat) in CGPoint(x: (40 + rad * sin(a)) * k, y: (40 - rad * cos(a)) * k) }
            var p = Path()
            p.move(to: pt(29))
            p.addLine(to: pt(39.5))
            ctx.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: 2 * k, lineCap: .round))
        }
        tick(1 - ring.frac, inkText)
        if let sm = ring.stagedMark { tick(sm, stagedTick) }

        func text(_ s: String, size: CGFloat, color: Color, baseline: CGFloat) {
            let t = ctx.resolve(Text(s).font(.system(size: size * k, weight: .bold)).foregroundColor(color))
            let m = t.measure(in: CGSize(width: 1000, height: 1000))
            let bl = t.firstBaseline(in: m)
            ctx.draw(t, in: CGRect(x: c.x - m.width / 2, y: baseline * k - bl, width: m.width, height: m.height))
        }
        text(glyph, size: 14, color: Self.glyphInk, baseline: 37)
        text((ring.dev > 0 ? "+" : "") + String(ring.dev), size: 13, color: Color(hex: ring.devColor), baseline: 54)
    }
}

/// Today's entries from the hub's nutrition log (`cards/nutritionlog.js` loadNutDay): the day band, then
/// every entry newest first with staged ones on top. Display only.
private struct DayLog: View {
    let day: NutritionDay

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            band.padding(.bottom, 8)
            if day.entries.isEmpty {
                Text("No food logged").font(.system(size: 12)).foregroundColor(Color(hex: "#556666"))
            } else {
                ForEach(day.entries) { EntryRow(entry: $0) }
            }
        }
    }

    /// `.nutday`: the date, then each total over its goal. With nothing logged it is the date alone.
    private var band: some View {
        let tm = day.target_macros
        return Flow(spacing: 12, lineSpacing: 4) {
            Text(dateLabel(day.date))
                .font(.system(size: 12, weight: .heavy)).tracking(0.6).foregroundColor(mutedText)
            if !day.entries.isEmpty {
                seg(mn(day.total_cal), (day.target_cal ?? 0) > 0 ? day.target_cal : nil, "cal")
                seg(mn(day.total_protein), tm?.protein_g, "P")
                seg(mn(day.total_carbs), tm?.carbs_g, "C")
                seg(mn(day.total_fat), tm?.fat_g, "F")
            }
        }
        .padding(.vertical, 7).padding(.horizontal, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(hex: "#11171e")))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#222a33"), lineWidth: 1))
    }

    private func seg(_ v: Int, _ goal: Double?, _ label: String) -> Text {
        var t = Text(String(v)).font(.system(size: 12, weight: .heavy)).foregroundColor(Color(hex: "#e6eaf0"))
        if let goal {
            t = t + Text("/" + js(goal)).font(.system(size: 12, weight: .semibold)).foregroundColor(mutedText)
        }
        return t + Text(" " + label).font(.system(size: 12)).foregroundColor(mutedText)
    }

    /// "SA 9/13", the card's own weekday letters.
    private func dateLabel(_ date: String) -> String {
        let p = date.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return date }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let d = cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12))!
        let dow = ["SU", "M", "TU", "W", "TH", "F", "SA"][cal.component(.weekday, from: d) - 1]
        return dow + " " + String(p[1]) + "/" + String(p[2])
    }
}

/// `.dex`: name (and the STAGED badge), then the kcal/P/C/F chips and the time an eaten entry was
/// logged for. A staged row is tinted with a gold bar down its left edge.
private struct EntryRow: View {
    let entry: NutritionDay.Entry

    private static let gold = Color(red: 214 / 255, green: 192 / 255, blue: 66 / 255)

    var body: some View {
        let staged = entry.staged ?? false
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(entry.name ?? "—")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(staged ? Color(hex: "#cdd3db") : inkText)
                if staged { badge }
            }
            Flow(spacing: 4, lineSpacing: 4) {
                chip(String(mn(entry.calories)) + " kcal")
                chip(String(mn(entry.protein_g)) + "g P")
                chip(String(mn(entry.carbs_g)) + "g C")
                chip(String(mn(entry.fat_g)) + "g F")
                if !staged, let t = clock(entry.occurred_at) { chip(t) }
            }
        }
        .padding(.vertical, 9)
        .padding(.leading, staged ? 11 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(staged ? Self.gold.opacity(0.08) : Color.clear)
        .overlay(alignment: .leading) { if staged { Rectangle().fill(Self.gold).frame(width: 3) } }
        .overlay(alignment: .top) { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }
    }

    private var badge: some View {
        Text("STAGED")
            .font(.system(size: 9, weight: .bold)).tracking(0.72)
            .foregroundColor(Self.gold)
            .padding(.vertical, 1).padding(.horizontal, 5)
            .background(RoundedRectangle(cornerRadius: 5).fill(Self.gold.opacity(0.13)))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Self.gold.opacity(0.4), lineWidth: 1))
    }

    private func chip(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11.5))
            .foregroundColor(Color(hex: "#c7ced8"))
            .padding(.vertical, 3).padding(.horizontal, 7)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(hex: "#0e1318")))
    }

    /// "…T14:07…" → "2:07 PM", the card's fmtTime on the naive-local occurred_at.
    private func clock(_ occurred: String?) -> String? {
        guard let o = occurred, let r = o.range(of: #"T\d{2}:\d{2}"#, options: .regularExpression) else { return nil }
        let hm = o[r].dropFirst().split(separator: ":")
        guard hm.count == 2, let h = Int(hm[0]) else { return nil }
        return String(h % 12 == 0 ? 12 : h % 12) + ":" + hm[1] + (h < 12 ? " AM" : " PM")
    }
}

/// The card's `mn`: a macro number, rounded.
private func mn(_ v: Double?) -> Int { Int((v ?? 0).rounded()) }

/// A number printed the way JavaScript prints it: no ".0" on a whole one.
func js(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(v) }

/// Lays its children left to right and wraps. The hub's rows scroll sideways instead, which a watch
/// is too narrow for.
struct Flow: Layout {
    var spacing: CGFloat = 4
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? .infinity, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(bounds.width, subviews)
        for (i, p) in laid.origins.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: laid.proposals[i])
        }
    }

    /// A child wider than a whole line (a long exercise name) is offered the line's width, so its text
    /// wraps. Left at its ideal width it made the Flow wider than the screen, and a ScrollView lays its
    /// content out again at the width it reports, so the whole page overflowed both edges.
    private func arrange(_ width: CGFloat, _ subviews: Subviews)
        -> (origins: [CGPoint], proposals: [ProposedViewSize], size: CGSize) {
        var origins: [CGPoint] = [], proposals: [ProposedViewSize] = []
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            var proposal = ProposedViewSize.unspecified
            var size = s.sizeThatFits(proposal)
            if size.width > width {
                proposal = ProposedViewSize(width: width, height: nil)
                size = s.sizeThatFits(proposal)
            }
            if x > 0 && x + size.width > width { x = 0; y += line + lineSpacing; line = 0 }
            origins.append(CGPoint(x: x, y: y))
            proposals.append(proposal)
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return (origins, proposals, CGSize(width: widest, height: y + line))
    }
}
