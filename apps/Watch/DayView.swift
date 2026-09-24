import SwiftUI
import WatchKit

/// **The day page: food on the left, training on the right, the latest answer underneath.** Built from
/// a mockup drawn at this screen's own pixels and signed off element by element, so its numbers are
/// the design rather than a starting point — `Geo` holds them, halved from the mockup's 2x pixels.
///
/// - Left: the four pace rings in a packed 2x2, then the three newest meals eaten.
/// - Right: the body figures at full height, with the rest clocks and the day's set count tucked
///   beside the feet, then the three newest exercises.
/// - Under both: the newest reply from the hub, full width, scrolling.
///
/// **The two halves are equal and a gutter runs between them.** Nothing on the right is allowed to
/// stretch into the left: the clocks are training, so they live on the training side.
///
/// Each list is a way into the whole of what it summarises — the food log with the rings kept above
/// it, or the exercise list under its clocks — and in both of those the heading is the way back.
struct DayView: View {
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @EnvironmentObject private var chat: Chat
    private enum Panel { case overview, food, exercises }
    @State private var panel: Panel = .overview
    /// One meal's ingredients open at a time in the food log.
    @State private var open: String?

    var body: some View {
        switch panel {
        case .overview: overview
        case .food: food
        case .exercises: ExerciseList(onHeader: { panel = .overview })
        }
    }

    // MARK: the overview

    private var overview: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: Geo.gutter) {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    RingGrid(rings: nutrition.rings(at: ctx.date))
                }
                .frame(width: Geo.col, height: Geo.block)
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Figures(now: workout.now, date: ctx.date)
                }
                .frame(width: Geo.col, height: Geo.block)
            }
            .padding(.bottom, Geo.headGap)
            rule
            HStack(alignment: .top, spacing: Geo.gutter) {
                summary(rows: foodRows) { panel = .food }
                summary(rows: liftRows) { panel = .exercises }
            }
            .padding(.top, Geo.listInset)
            .padding(.bottom, Geo.listInset / 2)
            rule
            reply
        }
        // The gutter is one line from the top of the rings to the foot of the lists: the halves are
        // separate all the way down, not only where their lists are.
        .overlay(alignment: .topLeading) {
            Rectangle().fill(Geo.gutterInk)
                .frame(width: 1, height: Geo.block + Geo.headGap + Geo.listInset * 1.5 + Geo.rowPitch * 3)
                .offset(x: Geo.col + Geo.gutter / 2)
        }
        .padding(.horizontal, Geo.pad)
        .padding(.top, Geo.top)
        .padding(.bottom, PageInset.bottom)
        .topOfTheScreen(scrollTop: 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black.ignoresSafeArea())
        .task { await nutrition.loadHistory() }
    }

    private var rule: some View { Rectangle().fill(Geo.ruleInk).frame(height: 1) }

    /// The three newest meals EATEN. The log puts staged ones first, but a meal planned and not yet
    /// eaten is not part of what the day has been; the full log still shows it.
    private var foodRows: [(String, String)] {
        (nutrition.day?.entries ?? []).filter { $0.staged != true }.prefix(3)
            .map { ($0.name ?? "—", String(mn($0.calories))) }
    }

    /// The three exercises a set went onto most recently, with their set counts.
    private var liftRows: [(String, String)] {
        (workout.now?.exercises ?? []).prefix(3).map { ($0.name, String($0.sets.count)) }
    }

    /// A list: the name at the left of its half, its figure against the right edge of it.
    private func summary(rows: [(String, String)], open: @escaping () -> Void) -> some View {
        Button(action: open) {
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
            }
            .frame(width: Geo.col, height: Geo.rowPitch * 3, alignment: .topLeading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The hub's newest answer, across the full width, scrolling when it runs past the room.
    private var reply: some View {
        let last = chat.recent.last { $0.role != "user" && !($0.text ?? "").isEmpty }
        return ScrollView {
            Text(inlineMarkdown(last?.text ?? ""))
                .font(.system(size: Geo.replySize))
                .foregroundColor(Geo.replyInk)
                .lineSpacing(Geo.replyLeading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Geo.listInset / 2)
                // A little short of the right edge, not the whole width: text run hard against a
                // rounded screen's side reads as clipped even where it is not.
                .padding(.trailing, 4)
                .id(last?.id)
        }
        .scrollIndicators(.never)
        .frame(maxHeight: .infinity)
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
                labelled("last", clock.restText, clock.restColour, .leading)
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
                labelled("sets", String(sets), Geo.setsInk, .trailing)
                    .offset(y: Geo.footDrop)
            }
        }
        .frame(width: Geo.col, height: Geo.block)
    }

    private func labelled(_ label: String, _ v: String, _ ink: Color, _ edge: HorizontalAlignment) -> some View {
        VStack(alignment: edge, spacing: Geo.labelGap) {
            Text(label).font(.system(size: Geo.labelSize)).foregroundColor(Geo.labelInk)
            value(v, ink)
        }
    }

    private func value(_ v: String, _ ink: Color) -> some View {
        Text(v)
            .font(.system(size: Geo.valueSize, weight: .bold, design: .rounded).monospacedDigit())
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
    static let rowPitch: CGFloat = 11.5
    static let listSize: CGFloat = 7
    static let valueSize: CGFloat = 7
    static let labelSize: CGFloat = 5.5
    static let labelGap: CGFloat = 1
    /// How far the numbers are dropped so their ink ends on the feet's last row. A text frame ends
    /// below the digits (room for descenders the digits do not have), so a number sat on the figures'
    /// bottom edge floats 1.5pt over the feet. Measured on the simulator render against the artwork;
    /// re-measure if the value font changes.
    static let footDrop: CGFloat = 1.5
    static let replySize: CGFloat = 6.5
    static let replyLeading: CGFloat = 1.5

    static let ruleInk = Color(hex: "#222a33")
    static let gutterInk = Color(hex: "#1e252e")
    static let nameInk = Color(hex: "#c7ced8")
    static let valueInk = Color(hex: "#7d8894")
    static let labelInk = Color(hex: "#646e7a")
    static let setsInk = Color(hex: "#a0aab8")
    static let replyInk = Color(hex: "#d6dce4")
}
