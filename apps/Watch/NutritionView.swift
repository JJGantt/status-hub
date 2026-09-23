import SwiftUI

/// The page to the right of the prompt: the hub nutrition card's four pace rings, then today's log.
struct NutritionView: View {
    @EnvironmentObject private var nutrition: Nutrition
    /// **The rings stay; what is under them is what changes.** A tap on them turns the page over: the
    /// day itself — where it stands against the goal, and the history behind it — or the list of what
    /// was eaten. Two things worth a screen, one screen, and the rings above both.
    @State private var day = false
    /// One entry's ingredients at a time: opening another closes it, so the log stays a list rather
    /// than becoming a page of everything.
    @State private var open: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Redrawn every second, as the card's setInterval(tickRings, 1000). Outside the scroll view
            // on purpose: they are the page's own heading, and scrolling the log should not take them.
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                RingsStrip(rings: nutrition.rings(at: ctx.date))
            }
            // **The outer two rings sit in the corners, and the corners are curved.** The strip is
            // outside the scroll view, so the page's top content margin never reaches it, and a round
            // thing pushed flat against a round corner loses its shoulder. Measured against the
            // device's own framebuffer mask: at this width the arc clears from 7pt down.
            .padding(.top, 8)
            .contentShape(Rectangle())
            .onTapGesture {
                day.toggle()
                if day { Task { await nutrition.loadHistory() } }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let today = nutrition.day {
                        if day {
                            DayStanding(day: today, history: nutrition.history, openList: { day = false })
                        } else {
                            DayLog(day: today, open: $open)
                        }
                    }
                }
                .padding(.bottom, CommandBar.height)
            }
            .scrollIndicators(.never)
        }
        // 8pt rather than 4: the corner arc eats the outer rings and the ends of the rules at this
        // height, and the four pixels buy back the shoulder on both.
        .padding(.horizontal, 8)
        .topOfTheScreen()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.ignoresSafeArea())
    }
}

/// What the rings turn over to: the weigh-in plot, the intake calendar under it on the same weeks, and
/// the day's standing under both. The wall draws these three together for a reason — a column is the
/// same week in each — and on a wrist they are the whole screen, which is why the log is the other
/// side of the tap rather than beneath them.
private struct DayStanding: View {
    let day: NutritionDay
    let history: NutHistory?
    let openList: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let h = history {
                WeightPlot(plot: h.weight).frame(height: 38)
                IntakeCalendar(weeks: h.weeks).frame(height: 7 * 8)
            }
            standing
            // The last thing eaten, in a line: the whole day on one screen, and a tap for the rest.
            if let last = day.entries.first {
                Button(action: openList) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(last.name ?? "—")
                            .font(.system(size: 12))
                            .foregroundColor(Color(hex: "#c7ced8"))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        (Text(String(mn(last.calories))).foregroundColor(Color(hex: "#c7ced8"))
                            + Text(" cal").foregroundColor(Color(hex: "#7d8894")))
                            .font(.system(size: 12).monospacedDigit())
                            .fixedSize()
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Each total over its goal, in one line if they fit and two if they do not. **No box and no
    /// date** — the page is today, and a number over its goal says what it is.
    private var standing: some View {
        let tm = day.target_macros
        return Flow(spacing: 10, lineSpacing: 3) {
            pair(mn(day.total_cal), (day.target_cal ?? 0) > 0 ? day.target_cal : nil, "cal")
            pair(mn(day.total_protein), tm?.protein_g, "P")
            pair(mn(day.total_carbs), tm?.carbs_g, "C")
            pair(mn(day.total_fat), tm?.fat_g, "F")
        }
    }

    private func pair(_ v: Int, _ goal: Double?, _ label: String) -> some View {
        let dim = Color(hex: "#7d8894")
        var t = Text(String(v)).foregroundColor(Color(hex: "#e6eaf0"))
        if let goal { t = t + Text("/" + js(goal)).foregroundColor(dim) }
        return (t + Text(label == "cal" ? " cal" : label).foregroundColor(dim))
            .font(.system(size: 12, weight: .semibold).monospacedDigit())
            .lineLimit(1)
            .fixedSize()
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
        Canvas { ctx, size in draw(ctx, k: size.width / 80) }
            .aspectRatio(1, contentMode: .fit)
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
        text(glyph, size: 19, color: Self.glyphInk, baseline: 38)
        text((ring.dev > 0 ? "+" : "") + String(ring.dev), size: 13, color: Color(hex: ring.devColor), baseline: 54)
    }
}

/// Today's entries from the hub's nutrition log (`cards/nutritionlog.js` loadNutDay): the day band, then
/// every entry newest first with staged ones on top. Display only.
private struct DayLog: View {
    let day: NutritionDay
    @Binding var open: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if day.entries.isEmpty {
                Text("No food logged").font(.system(size: 12)).foregroundColor(Color(hex: "#556666"))
            } else {
                ForEach(day.entries) { entry in
                    EntryRow(entry: entry, open: open == entry.id) {
                        open = open == entry.id ? nil : entry.id
                    }
                }
            }
        }
    }
}

/// One logged meal: its name on a line, its macros on the next, and a rule above it. **No boxes** —
/// a number in a box of its own costs a row's worth of height to say what a space already says — and
/// never more than one line of macros, so a day's log is read by scrolling rather than by paging.
/// A tap opens its ingredients, each one drawn the same way: what it is, then what is in it.
private struct EntryRow: View {
    let entry: NutritionDay.Entry
    let open: Bool
    let toggle: () -> Void

    private static let gold = Color(red: 214 / 255, green: 192 / 255, blue: 66 / 255)

    var body: some View {
        let staged = entry.staged ?? false
        let parts = entry.ingredients ?? []
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(entry.name ?? "—")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(staged ? Color(hex: "#cdd3db") : inkText)
                    .lineLimit(2)
                if staged { badge }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                macros(entry.calories, entry.protein_g, entry.carbs_g, entry.fat_g)
                Spacer(minLength: 4)
                if !staged, let t = clock(entry.occurred_at) { time(t) }
            }
            if open {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(part.label)
                            .font(.system(size: 11.5))
                            .foregroundColor(Color(hex: "#aeb6c0"))
                            .lineLimit(2)
                        macros(part.calories, part.protein_g, part.carbs_g, part.fat_g)
                    }
                    .padding(.top, 5)
                    .padding(.leading, 9)
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.leading, staged ? 11 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { if !parts.isEmpty { toggle() } }
        .background(staged ? Self.gold.opacity(0.08) : Color.clear)
        .overlay(alignment: .leading) { if staged { Rectangle().fill(Self.gold).frame(width: 3) } }
        .overlay(alignment: .top) { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }
    }

    /// One line: calories, then each macro with its letter. Every number is bright and every unit is
    /// dim, so the line reads as numbers with their units attached rather than as words.
    private func macros(_ cal: Double?, _ p: Double?, _ c: Double?, _ f: Double?) -> some View {
        let dim = Color(hex: "#7d8894")
        var t = Text(String(mn(cal))).foregroundColor(Color(hex: "#c7ced8"))
            + Text(" cal").foregroundColor(dim)
        for (v, label) in [(p, "P"), (c, "C"), (f, "F")] {
            t = t + Text("  " + String(mn(v))).foregroundColor(Color(hex: "#c7ced8"))
                + Text(label).foregroundColor(dim)
        }
        return t
            .font(.system(size: 11.5))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
    }

    /// When it was eaten, against the right edge: `12:30P`, the half of the day attached to the time
    /// with no space, dim like a unit — which is what it is.
    private func time(_ t: (clock: String, half: String)) -> some View {
        (Text(t.clock).foregroundColor(Color(hex: "#c7ced8"))
            + Text(t.half).foregroundColor(Color(hex: "#7d8894")))
            .font(.system(size: 11.5))
            .lineLimit(1)
            .fixedSize()
    }

    private var badge: some View {
        Text("STAGED")
            .font(.system(size: 9, weight: .bold)).tracking(0.72)
            .foregroundColor(Self.gold)
            .padding(.vertical, 1).padding(.horizontal, 5)
            .background(RoundedRectangle(cornerRadius: 5).fill(Self.gold.opacity(0.13)))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Self.gold.opacity(0.4), lineWidth: 1))
    }

    /// "…T14:07…" → ("2:07", "P") off the naive-local occurred_at.
    private func clock(_ occurred: String?) -> (clock: String, half: String)? {
        guard let o = occurred, let r = o.range(of: #"T\d{2}:\d{2}"#, options: .regularExpression) else { return nil }
        let hm = o[r].dropFirst().split(separator: ":")
        guard let h = Int(hm[0]), let m = Int(hm[1]) else { return nil }
        let hour = h % 12 == 0 ? 12 : h % 12
        return (String(hour) + ":" + (m < 10 ? "0" : "") + String(m), h < 12 ? "A" : "P")
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

/// The weigh-in plot, as the wall draws it: a line across the weeks with its three axis values written
/// over the left end rather than in a gutter — a gutter would inset the data, and being uninset is the
/// point. The first column is deliberately blank, so the line starts where the calendar's first week
/// does.
private struct WeightPlot: View {
    let plot: NutHistory.Plot

    var body: some View {
        Canvas { ctx, size in
            let pts = plot.points.compactMap { p -> CGPoint? in
                guard let x = p.x, let y = p.y else { return nil }
                return CGPoint(x: x * size.width, y: y * size.height)
            }
            guard pts.count > 1 else { return }
            var line = Path()
            line.move(to: pts[0])
            for p in pts.dropFirst() { line.addLine(to: p) }
            ctx.stroke(line, with: .color(Color(hex: "#7fb0ff")), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            for a in plot.axis {
                let t = ctx.resolve(Text(a.v).font(.system(size: 9, weight: .semibold))
                    .foregroundColor(Color(hex: "#6b7686")))
                let m = t.measure(in: CGSize(width: 100, height: 100))
                ctx.draw(t, in: CGRect(x: 0, y: a.y * size.height - m.height / 2, width: m.width, height: m.height))
            }
        }
    }
}

/// The intake calendar: a column per week, a cell per day, coloured by how the day went against its own
/// goal. **No gaps** — at this size a gap is a third of the mark, and the grid reads as black ruled by
/// colour rather than as a week of days. Today keeps a ring around it.
private struct IntakeCalendar: View {
    let weeks: [[NutHistory.Cell]]

    var body: some View {
        Canvas { ctx, size in
            guard !weeks.isEmpty else { return }
            let w = size.width / CGFloat(weeks.count), h = size.height / 7
            for (col, week) in weeks.enumerated() {
                for (row, day) in week.enumerated() {
                    let box = CGRect(x: CGFloat(col) * w, y: CGFloat(row) * h, width: w, height: h)
                    ctx.fill(Path(box.insetBy(dx: 0.25, dy: 0.25)),
                             with: .color(day.c.map { Color(hex: $0) } ?? Color(hex: "#151b22")))
                    if day.t == 1 {
                        ctx.stroke(Path(box.insetBy(dx: 0.5, dy: 0.5)), with: .color(.white), lineWidth: 1)
                    }
                }
            }
        }
    }
}
