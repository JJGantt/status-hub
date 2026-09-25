import SwiftUI

/// **A sideways drag the page row does not steal.** The app's pages are themselves swiped left and
/// right, and that swipe beats a horizontal ScrollView inside a page, so a map in one could not be moved.
/// This moves its content by hand under a HIGH-PRIORITY drag, which is claimed before the page swipe;
/// the drag only begins after a few points of travel, so a tap still reaches what is under the finger.
/// It rests on the newest end (the right) and every drag is clamped to the content.
struct SideScroll<Content: View>: View {
    let width: CGFloat
    @ViewBuilder let content: () -> Content
    /// How far the content is moved right from resting on its newest end, i.e. how far back it shows.
    @State private var back: CGFloat = 0
    @GestureState private var dragging: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let room = max(0, width - geo.size.width)
            let shown = min(max(back + dragging, 0), room)
            content()
                .frame(width: width, alignment: .leading)
                .offset(x: geo.size.width - width + shown)
                .frame(width: geo.size.width, alignment: .leading)
                .clipped()
                .contentShape(Rectangle())
                .highPriorityGesture(
                    DragGesture(minimumDistance: 6)
                        .updating($dragging) { v, state, _ in state = v.translation.width }
                        .onEnded { v in back = min(max(back + v.translation.width, 0), room) }
                )
        }
    }
}

/// A small back arrow for the health page's full views. A page in the row cannot be swiped back from
/// (the swipe turns the page), and a tap on the map picks a day, so the way out is its own control.
struct BackArrow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(Color(hex: "#7d8894"))
                .frame(width: 22, height: 16, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// **The whole history of one heat map, and the day picked on it.** The map is every week back to the
/// first thing logged, dragged sideways (`SideScroll`) and resting on the newest; a tap on a cell picks that day, and
/// the list under the map is that day's: every meal eaten, each opening to its ingredients, or every
/// exercise, each opening to its sets. Today is picked to begin with.
struct HistoryView: View {
    enum Kind { case food, training }
    let kind: Kind
    let back: () -> Void

    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @State private var picked: String?
    @State private var food: NutritionDay?
    @State private var lifts: [WorkoutNow.Exercise] = []
    @State private var open: String?

    /// The health page's own cell, so the map opens at the size it was tapped at.
    private static let side: CGFloat = 10

    private var weeks: [[NutHistory.Cell]] {
        guard let h = nutrition.fullHistory else { return [] }
        return kind == .food ? h.weeks : (h.sets ?? [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // One short row above the map: the way back, and which day the list below is.
            HStack(spacing: 2) {
                BackArrow(action: back)
                if let picked {
                    Text(Self.label(picked)).font(.system(size: 11)).foregroundColor(Color(hex: "#7d8894"))
                }
            }
            map
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch kind {
                    case .food:
                        if let food { DayLog(day: food, open: $open) }
                    case .training:
                        ForEach(Array(lifts.enumerated()), id: \.offset) { i, ex in
                            LiftRow(exercise: ex, open: open == ex.name, toggle: { open = open == ex.name ? nil : ex.name })
                                .padding(.top, i == 0 ? 0 : 9)
                                .overlay(alignment: .top) {
                                    if i > 0 { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }
                                }
                        }
                    }
                    Color.clear.frame(height: PageInset.bottom)
                }
            }
            .scrollIndicators(.never)
        }
        .padding(.horizontal, 8)
        .padding(.top, 18)
        .topOfTheScreen(scrollTop: 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black.ignoresSafeArea())
        .task {
            if nutrition.fullHistory == nil { await nutrition.loadFullHistory() }
            if picked == nil { picked = weeks.joined().last(where: { $0.t == 1 })?.d }
        }
        .onChange(of: picked) { _, day in
            open = nil
            guard let day else { return }
            Task {
                switch kind {
                case .food: food = await nutrition.day(day)
                case .training: lifts = await workout.day(day)
                }
            }
        }
    }

    /// The map, a column a week, dragged sideways and resting on the newest week at the right edge.
    private var map: some View {
        SideScroll(width: CGFloat(weeks.count) * Self.side) {
            HStack(spacing: 0) {
                ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                    VStack(spacing: 0) {
                        ForEach(Array(week.enumerated()), id: \.offset) { _, day in
                            cell(day)
                        }
                    }
                }
            }
        }
        .frame(height: 7 * Self.side)
    }

    private func cell(_ day: NutHistory.Cell) -> some View {
        Rectangle()
            .fill(day.c.map { Color(hex: $0) } ?? Color(hex: "#151b22"))
            .padding(0.5)
            .overlay {
                if day.d != nil && day.d == picked {
                    Rectangle().strokeBorder(Color.white, lineWidth: 1.5)
                }
            }
            .frame(width: Self.side, height: Self.side)
            .contentShape(Rectangle())
            .onTapGesture { if let d = day.d { picked = d } }
    }

    /// `Thu Sep 24` for the day picked: the list under the map has to say which day it is.
    private static func label(_ ymd: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        guard let d = f.date(from: ymd) else { return ymd }
        let out = DateFormatter()
        out.dateFormat = "EEE MMM d"
        out.timeZone = TimeZone(identifier: "UTC")
        return out.string(from: d)
    }
}

/// **The weight view**, as the phone draws it (`cards/maintviz.js`): the whole history at a fixed
/// density, dragged sideways (`SideScroll`) and resting on today at the right. Above, every weigh-in as a dot (full
/// inside the window the target is fitted over, faint outside it) and the fitted trend across that
/// window; below, each day's intake as a bar (faint outside the window), with the maintenance line
/// (amber) and the target line (green) as they stood each day. The y values sit at the right edge of the
/// screen and do not scroll.
struct WeightChart: View {
    let back: () -> Void
    @EnvironmentObject private var nutrition: Nutrition

    private static let perDay: CGFloat = 4
    private static let weightTop: CGFloat = 4, weightBottom: CGFloat = 78
    private static let intakeTop: CGFloat = 92, intakeBottom: CGFloat = 196
    private static let gutter: CGFloat = 30

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            BackArrow(action: back)
            if let v = nutrition.weight, let geo = Geometry(v) {
                ZStack(alignment: .topTrailing) {
                    SideScroll(width: geo.width) {
                        Canvas { ctx, _ in draw(ctx, v, geo) }
                            .frame(width: geo.width, height: Self.intakeBottom)
                    }
                    .padding(.trailing, Self.gutter)
                    axis(geo)
                }
                .frame(height: Self.intakeBottom)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, Landing.top - 8)
        .topOfTheScreen(scrollTop: 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black.ignoresSafeArea())
        .task { await nutrition.loadWeight() }
    }

    /// Where everything goes: the day range, and the two panels' scales.
    struct Geometry {
        let first: Date
        let days: Int
        let wMin: Double, wMax: Double
        let iMax: Double
        var width: CGFloat { CGFloat(days) * WeightChart.perDay }

        init?(_ v: WeightView) {
            let dates = (v.weighins.map(\.date) + v.intake.map(\.date)).sorted()
            guard let start = dates.first.flatMap(Self.day), let end = Self.day(v.today) else { return nil }
            first = start
            days = max(1, Int((end.timeIntervalSince(start) / 86400).rounded()) + 1)
            let wts = v.weighins.map(\.weight)
            wMin = (wts.min() ?? 0) - 0.6
            wMax = (wts.max() ?? 1) + 0.6
            let lines = v.series.flatMap { [$0.maintenance, $0.target] }.compactMap { $0 }
            iMax = max((v.intake.map(\.calories) + lines).max() ?? 1, 1) * 1.12
        }

        static func day(_ ymd: String) -> Date? {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = TimeZone(identifier: "UTC")
            return f.date(from: ymd)
        }

        func x(_ ymd: String) -> CGFloat? {
            guard let d = Self.day(ymd) else { return nil }
            return (CGFloat((d.timeIntervalSince(first) / 86400).rounded()) + 0.5) * WeightChart.perDay
        }

        func yW(_ w: Double) -> CGFloat {
            WeightChart.weightBottom - (WeightChart.weightBottom - WeightChart.weightTop) * CGFloat((w - wMin) / (wMax - wMin))
        }

        func yI(_ c: Double) -> CGFloat {
            WeightChart.intakeBottom - (WeightChart.intakeBottom - WeightChart.intakeTop) * CGFloat(c / iMax)
        }

        var weightTicks: [Double] {
            let step = (wMax - wMin) > 12 ? 5.0 : 2.0
            return stride(from: (wMin / step).rounded(.up) * step, through: wMax, by: step).map { $0 }
        }

        var intakeTicks: [Double] { stride(from: 1000.0, through: iMax, by: 1000).map { $0 } }
    }

    private static let purple = Color(hex: "#a78bfa"), blue = Color(hex: "#3b82f6")
    private static let amber = Color(hex: "#e6b93d"), green = Color(hex: "#34c759")
    private static let grid = Color(hex: "#39434f").opacity(0.5)

    private func draw(_ ctx: GraphicsContext, _ v: WeightView, _ g: Geometry) {
        // Gridlines first, so the data sits on them.
        for t in g.weightTicks { hline(ctx, g.yW(t), g.width) }
        for t in g.intakeTicks { hline(ctx, g.yI(t), g.width) }

        // The fitted trend across the window: the weight it ends on, walked back along the slope.
        if let a = v.window_start, let b = v.window_end, let slope = v.slope_lb_day, let end = v.weight_at_end,
           let xa = g.x(a), let xb = g.x(b) {
            let span = Double((xb - xa) / Self.perDay)
            var p = Path()
            p.move(to: CGPoint(x: xa, y: g.yW(end - slope * span)))
            p.addLine(to: CGPoint(x: xb, y: g.yW(end)))
            ctx.stroke(p, with: .color(Self.purple), lineWidth: 1.5)
        }
        for w in v.weighins {
            guard let x = g.x(w.date) else { continue }
            let r: CGFloat = w.inwin ? 2.2 : 1.4
            ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: g.yW(w.weight) - r, width: 2 * r, height: 2 * r)),
                     with: .color(Self.purple.opacity(w.inwin ? 0.95 : 0.35)))
        }

        // Intake bars: full inside the window, faint before it and after its last weigh-in.
        let bw = Self.perDay * 0.7
        for d in v.intake {
            guard let x = g.x(d.date) else { continue }
            let inWindow = d.kept && (v.window_end.map { d.date < $0 } ?? true)
            let top = g.yI(d.calories)
            ctx.fill(Path(CGRect(x: x - bw / 2, y: top, width: bw, height: Self.intakeBottom - top)),
                     with: .color(Self.blue.opacity(inWindow ? 0.9 : 0.4)))
        }
        // Maintenance and target, each a step that holds until the next day's value.
        step(ctx, v.series.map { ($0.date, $0.maintenance) }, g, Self.amber)
        step(ctx, v.series.map { ($0.date, $0.target) }, g, Self.green)
    }

    private func hline(_ ctx: GraphicsContext, _ y: CGFloat, _ width: CGFloat) {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: y))
        p.addLine(to: CGPoint(x: width, y: y))
        ctx.stroke(p, with: .color(Self.grid), lineWidth: 0.5)
    }

    private func step(_ ctx: GraphicsContext, _ rows: [(String, Double?)], _ g: Geometry, _ ink: Color) {
        var p = Path(), prev: CGFloat?
        for (date, value) in rows {
            guard let value, let x = g.x(date) else { prev = nil; continue }
            let y = g.yI(value)
            if let py = prev {
                p.addLine(to: CGPoint(x: x, y: py))
                p.addLine(to: CGPoint(x: x, y: y))
            } else {
                p.move(to: CGPoint(x: x, y: y))
            }
            prev = y
        }
        ctx.stroke(p, with: .color(ink), lineWidth: 1.2)
    }

    /// The y values, pinned in the right-hand gutter while the chart scrolls under nothing.
    private func axis(_ g: Geometry) -> some View {
        ZStack(alignment: .topTrailing) {
            ForEach(g.weightTicks, id: \.self) { t in label(String(Int(t)), g.yW(t)) }
            ForEach(g.intakeTicks, id: \.self) { t in label(String(Int(t / 1000)) + "k", g.yI(t)) }
        }
        .frame(width: Self.gutter - 2, height: Self.intakeBottom, alignment: .topTrailing)
    }

    private func label(_ s: String, _ y: CGFloat) -> some View {
        Text(s)
            .font(.system(size: 9).monospacedDigit())
            .foregroundColor(Color(hex: "#7d8894"))
            .offset(y: y - 6)
    }
}
