import SwiftUI

/// **The health page: food and training on one screen.** They were two pages and a swipe apart, which
/// put the two halves of the same day in two places. The rings run DOWN the left because four of them
/// across the top is a band of chrome above everything else; standing in a column they are a gutter,
/// and the width they free is what makes room for two heat maps stacked on the right.
///
/// Every line on it is a way into the thing it summarises, and nothing is a rotation through screens:
/// the rings are the day's numbers, so they open the numbers; the newest meal is the food log's last
/// line, so it opens the log; the newest exercise is the exercise list's last line, so it opens that.
/// From anywhere but the overview, the rings are the way back.
struct HealthView: View {
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    private enum Panel { case overview, numbers, food, exercises }
    @State private var panel: Panel = .overview
    /// One entry's ingredients at a time, so the log stays a list rather than a page of everything.
    @State private var open: String?

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            // Redrawn every second, as the card's setInterval(tickRings, 1000). Outside the scroller
            // on purpose: they are the page's heading, and scrolling what is beside them must not
            // take them with it.
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                RingsColumn(rings: nutrition.rings(at: ctx.date))
            }
            .frame(width: 40)
            .contentShape(Rectangle())
            .onTapGesture { panel = panel == .overview ? .numbers : .overview }

            // **The overview does not scroll.** It is a day of food and training sized to the screen
            // it is read on, so everything is on it or it is the wrong size — a scroller here would
            // hide the second half of the day behind a gesture. The lists it opens DO scroll, because
            // a list has no length the screen can dictate.
            switch panel {
            case .overview:
                VStack(alignment: .leading, spacing: 4) { overview }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            case .numbers, .food, .exercises:
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        switch panel {
                        case .numbers: if let d = nutrition.day { DayNumbers(day: d) }
                        case .food: if let d = nutrition.day { DayLog(day: d, open: $open) }
                        default: ExerciseList()
                        }
                    }
                    .padding(.bottom, PageInset.bottom)
                }
                .scrollIndicators(.never)
            }
        }
        // 8pt rather than 4: the corner arc eats the top ring and the ends of a full-width rule.
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .task { await nutrition.loadHistory() }
        .topOfTheScreen(scrollTop: 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.ignoresSafeArea())
    }

    /// The day at rest: the weigh-in trend, the two heat maps, and one line under each saying what the
    /// last thing was. A cell is square and 10pt, so a map is 70pt tall whatever its width, and the
    /// two of them plus the plot and the two lines come to about 218pt — which is what has to fit in
    /// the 240 this column has, with the bar gone, WITHOUT scrolling. Those sizes are the budget: grow
    /// one and something else has to give it back.
    @ViewBuilder private var overview: some View {
        if let h = nutrition.history {
            WeightPlot(plot: h.weight, side: heatSide).frame(height: 32)
            IntakeCalendar(weeks: h.weeks).frame(height: 7 * heatSide)
        }
        if let last = nutrition.day?.entries.first {
            summary(last.name ?? "—", String(mn(last.calories)) + " cal") { panel = .food }
        }
        if let sets = nutrition.history?.sets {
            IntakeCalendar(weeks: sets).frame(height: 7 * heatSide)
        }
        if let ex = workout.now?.exercises.first {
            summary(ex.name, String(ex.sets.count)) { panel = .exercises }
        }
    }

    /// One line: what it was on the left, its figure against the right edge, the whole row a way in.
    private func summary(_ name: String, _ value: String, _ open: @escaping () -> Void) -> some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(name)
                    .font(.system(size: 12))
                    .foregroundColor(Color(hex: "#c7ced8"))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(value)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundColor(Color(hex: "#7d8894"))
                    .fixedSize()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The four pace rings standing in a column down the left edge. Same cell the row used; what changes
/// is only which way they are stacked.
private struct RingsColumn: View {
    let rings: [String: RingNow]
    private let keys = [("Cal", "calories"), ("P", "protein_g"), ("C", "carbs_g"), ("F", "fat_g")]

    var body: some View {
        VStack(spacing: 4) {
            ForEach(keys, id: \.1) { glyph, key in
                if let r = rings[key] { RingCell(glyph: glyph, ring: r) }
            }
        }
    }
}



/// One ring, drawn to `cards/nutrition.js`'s SVG: an 80-unit box, a r=34 circle on a 7-unit stroke,
/// arcs from twelve o'clock clockwise with round caps, ticks from r=29 to r=39.5, the glyph on a
/// baseline at 37 and the deviation number on one at 54. Then `consumed / goal` under it (`.rtot`).
struct RingCell: View {
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
struct DayLog: View {
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
func mn(_ v: Double?) -> Int { Int((v ?? 0).rounded()) }

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
/// One heat-map cell's side on the health page. The maps are seven of these tall, and the weigh-in plot
/// places each week on a column this wide — one number, so the plot and the maps cannot disagree.
private let heatSide: CGFloat = 10

private struct WeightPlot: View {
    let plot: NutHistory.Plot
    /// The heat maps' cell side. **The plot is drawn on the maps' columns**: a map shows only the newest
    /// weeks that fit as square cells, right-aligned, so spreading the whole history across the plot's
    /// width put each week over some other week's column. Each week's point sits on its column's centre
    /// instead, over exactly the weeks the maps below show — the hub aligns its plot the same way.
    let side: CGFloat

    var body: some View {
        Canvas { ctx, size in
            // `points` is one per week column, oldest first, the same weeks as the maps.
            let weeks = plot.points.count
            let shown = min(weeks, max(1, Int(size.width / side)))
            let first = weeks - shown
            let left = size.width - CGFloat(shown) * side
            let pts = plot.points.enumerated().compactMap { i, p -> CGPoint? in
                guard i >= first, let y = p.y else { return nil }
                return CGPoint(x: left + (CGFloat(i - first) + 0.5) * side, y: y * size.height)
            }
            guard pts.count > 1 else { return }
            var line = Path()
            line.move(to: pts[0])
            for p in pts.dropFirst() { line.addLine(to: p) }
            ctx.stroke(line, with: .color(Color(hex: "#7fb0ff")), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            // **Two numbers, the high and the low of what is drawn.** Three stacked in a box this
            // short are crunched, and the middle one is the one a reader infers from the two either
            // side. Each is CLAMPED inside the box: centred on a line at the very edge, half the
            // glyph falls outside the canvas and the number reads as cut off.
            let ends = plot.axis.sorted { $0.y < $1.y }
            for a in [ends.first, ends.last].compactMap({ $0 }) {
                let t = ctx.resolve(Text(a.v).font(.system(size: 9, weight: .semibold))
                    .foregroundColor(Color(hex: "#6b7686")))
                let m = t.measure(in: CGSize(width: 100, height: 100))
                let y = min(max(a.y * size.height - m.height / 2, 0), size.height - m.height)
                ctx.draw(t, in: CGRect(x: 0, y: y, width: m.width, height: m.height))
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
            // **A cell is SQUARE**, its side taken from the seven rows, and the box then holds as many
            // weeks as that leaves room for — newest against the right edge, older ones dropping off
            // the left. Dividing the width by the number of weeks instead makes each cell as wide as
            // the data is long, which at ten weeks is a cell three times wider than it is tall.
            let side = size.height / 7
            let fits = max(1, Int(size.width / side))
            let shown = Array(weeks.suffix(fits))
            let left = size.width - CGFloat(shown.count) * side
            for (col, week) in shown.enumerated() {
                for (row, day) in week.enumerated() {
                    let box = CGRect(x: left + CGFloat(col) * side, y: CGFloat(row) * side,
                                     width: side, height: side)
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

/// **What the rings turn over to: the day's four totals against their goals, and nothing else.** No
/// box, no date and no labels beyond the unit — the page is today, and a number over its goal says
/// what it is. It sits where the plot and the calendar were, because it answers the same question at
/// a glance that they answer over weeks.
private struct DayNumbers: View {
    let day: NutritionDay

    var body: some View {
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
