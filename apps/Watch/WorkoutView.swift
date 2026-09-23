import SwiftUI

/// The page right of nutrition: the home wall's rest clocks (cards/workouts.js), then every exercise
/// logged today in the wall's `data-recent` row, the one a set just went onto first and the rest
/// scrolling below it.
struct WorkoutView: View {
    @EnvironmentObject private var workout: Workout

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                // `.resttimer:empty` — no set ever logged, no strip.
                if let n = workout.now, let last = n.last_set_at {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        RestStrip(lastAt: last, sessionStartAt: n.session_start_at, setsToday: n.sets_today ?? 0,
                                  now: ctx.date)
                    }
                }
                ForEach(Array((workout.now?.exercises ?? []).enumerated()), id: \.offset) { i, ex in
                    LiftRow(exercise: ex)
                        .padding(.top, i == 0 ? 0 : 9)
                        // Ruled apart like the hub's day list (`.dex`), since the rows no longer stand alone.
                        .overlay(alignment: .top) {
                            if i > 0 { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }
                        }
                }
            }
            .padding(.horizontal, 4)
            .padding(.bottom, CommandBar.height)
        }
        .scrollIndicators(.never)
        .background(Color.black.ignoresSafeArea())
        .overlay { CommandBar(view: "workout") }
    }
}

private let clockGreen = Color(hex: "#39d353")
private let clockAmber = Color(hex: "#d6c042")
private let clockGrey = Color(hex: "#8b96a5")

/// `#resttimer` on the home wall: "Last set" and its clock (green, amber past five minutes, grey once
/// the session is over), "Session" and its clock while a session is live, and today's tally against
/// the far edge. One line as on the wall, stepped smaller until it fits; only when one line would be
/// too small to read on a watch do the three wrap.
private struct RestStrip: View {
    let lastAt: String
    let sessionStartAt: String?
    let setsToday: Int
    let now: Date

    /// SESSION_GAP_S: more than 20 minutes between sets ends the session.
    private static let sessionGap: Double = 20 * 60

    var body: some View {
        let nowWall = wallClock(now)
        let rest = max(0, nowWall - (wallClock(lastAt) ?? nowWall))
        let active = rest <= Self.sessionGap
        let session = max(0, nowWall - (wallClock(sessionStartAt ?? lastAt) ?? nowWall))
        let parts = Parts(rest: rest, active: active, session: session, sets: setsToday)
        // One line, always: the clocks are a glance, and a wrapped three-line block is a paragraph.
        return ViewThatFits(in: .horizontal) {
            oneLine(parts, 0.85)
            oneLine(parts, 0.72)
            oneLine(parts, 0.62)
            oneLine(parts, 0.54)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct Parts { let rest: Double; let active: Bool; let session: Double; let sets: Int }

    private func oneLine(_ p: Parts, _ k: CGFloat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12 * k) {
            side("Last set", since(p.rest), p.active ? (p.rest >= 300 ? clockAmber : clockGreen) : clockGrey, k)
            if p.active { side("Session", sessionClock(p.session), clockGreen, k) }
            Spacer(minLength: 0)
            side("Sets", String(p.sets), clockGrey, k)
        }
    }

    @ViewBuilder private func sides(_ p: Parts, _ k: CGFloat) -> some View {
        side("Last set", since(p.rest), p.active ? (p.rest >= 300 ? clockAmber : clockGreen) : clockGrey, k)
        if p.active { side("Session", sessionClock(p.session), clockGreen, k) }
        side("Sets", String(p.sets), clockGrey, k)
    }

    private func side(_ label: String, _ value: String, _ color: Color, _ k: CGFloat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6 * k) {
            Text(label).font(.system(size: 14 * k, weight: .heavy)).foregroundColor(clockGrey)
            Text(value).font(.system(size: 22 * k, weight: .heavy).monospacedDigit()).foregroundColor(color)
        }
        .lineLimit(1)
        .fixedSize()
    }

    /// fmtSince: m:ss inside the hour, then "Hh Mm", then "Dd Hh".
    private func since(_ s: Double) -> String {
        let n = Int(s)
        if n < 3600 { return String(n / 60) + ":" + two(n % 60) }
        if n < 86400 { return String(n / 3600) + "h " + String((n % 3600) / 60) + "m" }
        return String(n / 86400) + "d " + String((n % 86400) / 3600) + "h"
    }

    /// fmtSession: h:mm:ss once past the hour, else m:ss.
    private func sessionClock(_ s: Double) -> String {
        let n = Int(s), h = n / 3600, m = (n % 3600) / 60, sec = n % 60
        return h > 0 ? String(h) + ":" + two(m) + ":" + two(sec) : String(m) + ":" + two(sec)
    }

    private func two(_ n: Int) -> String { n < 10 ? "0" + String(n) : String(n) }
}

/// The calendar the wall clocks are compared in. UTC is a plain calculator here, not a zone: see
/// `wallClock`.
private let digitCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}()

/// A naive "YYYY-MM-DDTHH:MM:SS" reading as seconds, digit for digit (cards/workouts.js wallClockMs).
/// occurred_at is whatever clock logged it, with no zone, so it is never converted through one.
private func wallClock(_ naive: String) -> Double? {
    let p = naive.prefix(19).split(whereSeparator: { "-T:".contains($0) }).compactMap { Int($0) }
    guard p.count == 6 else { return nil }
    return digitCalendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2],
                                                   hour: p[3], minute: p[4], second: p[5]))?.timeIntervalSince1970
}

/// This watch's own wall clock, read the same way (nowWallClockMs).
private func wallClock(_ now: Date) -> Double {
    let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: now)
    return digitCalendar.date(from: c)?.timeIntervalSince1970 ?? now.timeIntervalSince1970
}

/// One exercise: its name, and how many sets of it, on one line. **That is the whole list** — a name
/// and a count read down a column in a glance, where the wall's row (a mark, the muscles it trains,
/// every set with its weight) is a paragraph per exercise on a screen this size.
///
/// A tap opens the rest of it: the muscles it trains with their weekly sets, then the sets themselves
/// one per line in two columns. One set per line because the wall's shrink-to-fit row — six sets
/// squeezed into one line at 9pt — is unreadable on a wrist, and two columns because one is a column
/// of short strings down half a screen.
private struct LiftRow: View {
    let exercise: WorkoutNow.Exercise
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(exercise.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Color(hex: "#e6eaf0"))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(String(exercise.sets.count))
                    .font(.system(size: 15, weight: .bold).monospacedDigit())
                    .foregroundColor(Color(hex: "#8b96a5"))
            }
            if open {
                muscles
                sets
            }
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { open.toggle() }
    }

    /// Each muscle it trains with that muscle's weekly sets, in the muscle's own volume colour — the
    /// wall's chips without the boxes. Wraps, and a synergist is dimmer than a primary mover.
    private var muscles: some View {
        Flow(spacing: 9, lineSpacing: 3) {
            ForEach(Array(exercise.muscles.enumerated()), id: \.offset) { _, m in
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(m.label)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(Color(hex: m.primary ? "#c7cdd6" : "#6b7686"))
                    Text(js(m.sets))
                        .font(.system(size: 11, weight: .bold).monospacedDigit())
                        .foregroundColor(Color(hex: m.color))
                }
                .fixedSize()
            }
        }
    }

    /// The sets, one per line, filling two columns down the page: 1 and 2 on the first line, 3 and 4 on
    /// the next. A weight of 0 is bodyweight, as everywhere else.
    private var sets: some View {
        let rows = stride(from: 0, to: exercise.sets.count, by: 2).map { i in
            (i, i + 1 < exercise.sets.count ? i + 1 : nil)
        }
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, pair in
                HStack(spacing: 0) {
                    setText(pair.0).frame(maxWidth: .infinity, alignment: .leading)
                    if let second = pair.1 {
                        setText(second).frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Color.clear.frame(maxWidth: .infinity, maxHeight: 0)
                    }
                }
            }
        }
    }

    private func setText(_ i: Int) -> some View {
        let st = exercise.sets[i]
        let weight = (st.weight_lbs ?? 0) == 0 ? "BW" : js(st.weight_lbs ?? 0)
        return (Text(weight).foregroundColor(Color(hex: "#c7cdd6"))
                + Text(" × ").foregroundColor(Color(hex: "#5c6675"))
                + Text(String(st.reps ?? 0)).foregroundColor(Color(hex: "#c7cdd6")))
            .font(.system(size: 13, weight: .semibold).monospacedDigit())
            .lineLimit(1)
    }
}
