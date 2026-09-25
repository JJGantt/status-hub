import SwiftUI
import WatchKit

/// **The day page: food on the left, training on the right.** Built from a mockup drawn at this screen's
/// own pixels and signed off element by element, so its numbers are the design rather than a starting
/// point — `Geo` holds them, halved from the mockup's 2x pixels.
///
/// - Left: the four pace rings in a packed 2x2, then every meal eaten today, newest first.
/// - Right: the body figures at full height, with the rest clocks and the day's set count tucked
///   beside the feet, then every exercise today, most recent first.
///
/// The lists run to the bottom of the screen and scroll. The conversation is not here: it lives on
/// home, the one page it is on.
///
/// **The two halves are equal and a gutter runs between them.** Nothing on the right is allowed to
/// stretch into the left: the clocks are training, so they live on the training side.
///
/// **The rings and the figures are switches.** A tap on the rings trades the two lists for the day's
/// totals, each macro on its own line, and a second tap brings the lists back. A tap on the figures
/// opens the week's muscles as a page of its own (`muscles`), furthest behind first.
///
/// Each list is a way into the whole of what it summarises — the food log with the rings kept above
/// it, or the exercise list under its clocks — and in both of those the heading is the way back.
struct DayView: View {
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    private enum Panel { case overview, food, exercises, muscles }
    @State private var panel: Panel = .overview
    /// The rings' tap: the day's totals in place of the lists.
    @State private var totals = false
    /// One meal's ingredients open at a time in the food log.
    @State private var open: String?

    var body: some View {
        Group {
            switch panel {
            case .overview: overview
            case .food: food
            case .exercises: ExerciseList(onHeader: { panel = .overview })
            case .muscles: muscles
            }
        }
        #if targetEnvironment(simulator)
        // `-dayview <totals|muscles>` at launch, so each can be screenshotted.
        .onAppear {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-dayview"), i + 1 < args.count else { return }
            if args[i + 1] == "totals" { totals = true } else if args[i + 1] == "muscles" { panel = .muscles }
        }
        #endif
    }

    // MARK: the overview

    private var overview: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: Geo.gutter) {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    RingGrid(rings: nutrition.rings(at: ctx.date))
                }
                .frame(width: Geo.col, height: Geo.block)
                .contentShape(Rectangle())
                .onTapGesture { totals.toggle() }
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Figures(now: workout.now, date: ctx.date)
                }
                .frame(width: Geo.col, height: Geo.block)
                .contentShape(Rectangle())
                .onTapGesture { panel = .muscles }
            }
            .padding(.bottom, Geo.headGap)
            rule
            Group {
                if totals {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Totals(rings: nutrition.rings(at: ctx.date))
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { totals = false }
                } else {
                    HStack(alignment: .top, spacing: Geo.gutter) {
                        summary(rows: foodRows) { panel = .food }
                        summary(rows: liftRows) { panel = .exercises }
                    }
                }
            }
            .padding(.top, Geo.listInset)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        // The gutter is one line from the top of the rings to the bottom of the screen: the halves are
        // separate all the way down, not only where their lists are. The totals run the full width, so
        // under them it stops at the rule.
        .overlay(alignment: .topLeading) {
            Rectangle().fill(Geo.gutterInk)
                .frame(width: 1)
                .frame(maxHeight: totals ? Geo.block + Geo.headGap : .infinity, alignment: .top)
                .offset(x: Geo.col + Geo.gutter / 2)
        }
        .padding(.horizontal, Geo.pad)
        .padding(.top, Geo.top)
        .padding(.bottom, PageInset.bottom)
        .topOfTheScreen(scrollTop: 0)
        // The lists run to the bottom of the glass: the page's own bottom margin was a band of black
        // under them.
        .ignoresSafeArea(edges: .bottom)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black.ignoresSafeArea())
        .task { await nutrition.loadHistory() }
    }

    private var rule: some View { Rectangle().fill(Geo.ruleInk).frame(height: 1) }

    /// Every meal EATEN today, newest first. The log puts staged ones first, but a meal planned and not
    /// yet eaten is not part of what the day has been; the full log still shows it.
    private var foodRows: [(String, String)] {
        (nutrition.day?.entries ?? []).filter { $0.staged != true }
            .map { ($0.name ?? "—", String(mn($0.calories))) }
    }

    /// Every exercise a set went onto today, most recent first, with its set count.
    private var liftRows: [(String, String)] {
        (workout.now?.exercises ?? []).map { ($0.name, String($0.sets.count)) }
    }

    /// A list: the name at the left of its half, its figure against the right edge of it. It fills the
    /// rest of the screen and scrolls; a tap opens the whole of what it summarises.
    private func summary(rows: [(String, String)], open: @escaping () -> Void) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(row.0).foregroundColor(Geo.nameInk).lineLimit(1)
                        Spacer(minLength: 2)
                        Text(row.1).foregroundColor(Geo.valueInk).fixedSize()
                    }
                    .font(.system(size: Geo.listSize))
                    .frame(height: Geo.rowPitch)
                }
                Color.clear.frame(height: PageInset.bottom)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
        }
        .scrollIndicators(.never)
        .frame(width: Geo.col)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: the muscles

    /// The week's muscles, furthest behind their goal first (the hub's order), each line in the colour
    /// its muscle has on the figures. No bars: the colour already says how far along it is.
    private var muscles: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Button { panel = .overview } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(Color(hex: "#7d8894"))
                        Text("Muscles")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.white)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.bottom, 6)
                ForEach(Array((workout.now?.volume ?? []).enumerated()), id: \.offset) { _, m in
                    HStack(alignment: .firstTextBaseline) {
                        Text(m.label).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(Self.sets(m.sets) + " / " + Self.sets(m.target))
                            .font(.system(size: Geo.muscleSize, weight: .semibold).monospacedDigit())
                            .fixedSize()
                    }
                    .font(.system(size: Geo.muscleSize))
                    .foregroundColor(Color(hex: m.color))
                    .frame(height: Geo.musclePitch)
                }
                Color.clear.frame(height: PageInset.bottom)
            }
            .padding(.horizontal, Geo.pad)
        }
        .scrollIndicators(.never)
        .topOfTheScreen(scrollTop: Landing.top)
        .background(Color.black.ignoresSafeArea())
    }

    /// A set count as the hub keeps it: whole, or with its half (a muscle a lift trains second counts
    /// half a set).
    private static func sets(_ n: Double) -> String {
        n == n.rounded() ? String(Int(n)) : String(format: "%.1f", n)
    }

    // MARK: the food log

    /// The whole food log, with the rings kept above it. The rings are the way back.
    private var food: some View {
        VStack(alignment: .leading, spacing: 6) {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let rings = nutrition.rings(at: ctx.date)
                HStack(spacing: Geo.ringGap) {
                    ForEach(RingGrid.keys, id: \.1) { glyph, key in
                        if let r = rings[key] { RingCell(glyph: glyph, ring: r) }
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { panel = .overview }
            ScrollView {
                if let d = nutrition.day { DayLog(day: d, open: $open) }
                Color.clear.frame(height: PageInset.bottom)
            }
            .scrollIndicators(.never)
        }
        .padding(.horizontal, Geo.pad)
        .padding(.top, Geo.top)
        .topOfTheScreen(scrollTop: 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black.ignoresSafeArea())
    }
}

/// The day's totals, one macro to a line: what has been eaten, against the goal. In place of the lists
/// while the rings are tapped.
private struct Totals: View {
    let rings: [String: RingNow]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(RingGrid.keys, id: \.1) { glyph, key in
                if let r = rings[key] {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(glyph).foregroundColor(Geo.nameInk)
                        Spacer(minLength: 4)
                        Text(String(r.consumed)).font(.system(size: Geo.totalSize, weight: .bold).monospacedDigit())
                            .foregroundColor(.white)
                        Text("/ " + String(r.goal)).foregroundColor(Geo.valueInk)
                    }
                    .font(.system(size: Geo.totalSize).monospacedDigit())
                    .frame(height: Geo.totalPitch)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The four rings packed two by two, a small gap between them and nothing else.
private struct RingGrid: View {
    let rings: [String: RingNow]
    static let keys = [("Cal", "calories"), ("P", "protein_g"), ("C", "carbs_g"), ("F", "fat_g")]

    var body: some View {
        VStack(spacing: Geo.ringGap) {
            HStack(spacing: Geo.ringGap) { cell(0); cell(1) }
            HStack(spacing: Geo.ringGap) { cell(2); cell(3) }
        }
    }

    @ViewBuilder private func cell(_ i: Int) -> some View {
        let (glyph, key) = Self.keys[i]
        Group {
            if let r = rings[key] { RingCell(glyph: glyph, ring: r) } else { Color.clear }
        }
        .frame(width: Geo.ring, height: Geo.ring)
    }
}

/// The two figures at full height, and the three training numbers sitting on the line the feet stand
/// on: `last` at the left, the session clock between the figures, `sets` at the right.
///
/// **The numbers fit beside the feet because the figures taper there**, not because the figures were
/// shrunk to make room. The worst cases were checked against the artwork before this was built —
/// `59:59` and `72h` for the rest, `1:41:12` for the session, three digits of sets — and none touches
/// it at these sizes. Widen the numbers or move the figures and that check has to be run again.
private struct Figures: View {
    let now: WorkoutNow?
    let date: Date

    var body: some View {
        let colours = now?.body ?? [:]
        let clock = now?.last_set_at.map { RestClock(lastAt: $0, sessionStartAt: now?.session_start_at, now: date) }
        HStack(spacing: Geo.figureGap) {
            BodyFigure(back: false, colours: colours)
            BodyFigure(back: true, colours: colours)
        }
        .frame(width: Geo.col, height: Geo.block)
        // Pinned to the left edge, the centre and the right edge rather than laid out in a row: in a
        // row, `last 3h` and `sets 33` differ in width and push the session clock off the centre line
        // between the figures. All three sit on the bottom edge of the figures and are then dropped by
        // `Geo.footDrop`, so the INK of every number ends on the row the feet end on.
        .overlay(alignment: .bottomLeading) {
            if let clock {
                // Green and amber say a session is on; once it has ended the rest is read in the bright
                // ink, not greyed out.
                labelled("last", value(clock.restText, clock.active ? clock.restColour : Geo.setsInk), .leading)
                    .offset(y: Geo.footDrop)
            }
        }
        .overlay(alignment: .bottom) {
            if let session = clock?.sessionText {
                value(session, clockGreen).offset(y: Geo.footDrop)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let sets = now?.sets_today {
                labelled("sets", value(String(sets), Geo.setsInk), .trailing)
                    .offset(y: Geo.footDrop)
            }
        }
        .frame(width: Geo.col, height: Geo.block)
    }

    private func labelled(_ label: String, _ v: some View, _ edge: HorizontalAlignment) -> some View {
        VStack(alignment: edge, spacing: Geo.labelGap) {
            Text(label).font(.system(size: Geo.labelSize)).foregroundColor(Geo.labelInk)
            v
        }
    }

    /// A number the size of the lists' numbers, bold. A trailing unit (`12h`) stays small: it is the
    /// digits that are read, and the letter at full size costs width beside the feet.
    private func value(_ v: String, _ ink: Color) -> some View {
        let unit = v.last.map { $0.isLetter } == true
        let digits = unit ? String(v.dropLast()) : v
        let big = Text(digits).font(.system(size: Geo.valueSize, weight: .bold).monospacedDigit())
        let small = Text(unit ? String(v.last!) : "").font(.system(size: Geo.unitSize, weight: .bold))
        return (big + small)
            .foregroundColor(ink)
            .lineLimit(1)
            .fixedSize()
    }
}

/// The page's measurements, in points — the approved mockup's pixels halved. The columns come from
/// the screen's width, so a smaller watch keeps the proportions.
private enum Geo {
    static let width = WKInterfaceDevice.current().screenBounds.width
    static let pad: CGFloat = 8
    /// Down from the top of the glass far enough that a figure's head clears the corner's curve.
    static let top: CGFloat = 17
    static let gutter: CGFloat = 7
    static let ringGap: CGFloat = 4
    static var col: CGFloat { (width - 2 * pad - gutter) / 2 }
    static var ring: CGFloat { ((col - ringGap) / 2).rounded(.down) }
    /// The ring block's side, which the figures match in height.
    static var block: CGFloat { ring * 2 + ringGap }
    static let figureGap: CGFloat = 2
    static let headGap: CGFloat = 6
    static let listInset: CGFloat = 5.5
    static let rowPitch: CGFloat = 15
    static let listSize: CGFloat = 11
    static let valueSize: CGFloat = 11
    static let totalSize: CGFloat = 16
    static let totalPitch: CGFloat = 23
    static let muscleSize: CGFloat = 14
    static let musclePitch: CGFloat = 21
    static let unitSize: CGFloat = 7
    static let labelSize: CGFloat = 5.5
    static let labelGap: CGFloat = 1
    /// How far the numbers are dropped so their ink ends on the feet's last row. A text frame ends
    /// below the digits (room for descenders the digits do not have), so a number sat on the figures'
    /// bottom edge floats 1.5pt over the feet. Measured on the simulator render against the artwork;
    /// re-measure if the value font changes.
    static let footDrop: CGFloat = 1.5

    static let ruleInk = Color(hex: "#222a33")
    static let gutterInk = Color(hex: "#1e252e")
    static let nameInk = Color(hex: "#c7ced8")
    static let valueInk = Color(hex: "#7d8894")
    static let labelInk = Color(hex: "#646e7a")
    static let setsInk = Color(hex: "#e6ebf0")
}
