import SwiftUI

/// The page right of nutrition: the home wall's workout block (cards/workouts.js) — the rest clocks,
/// then the exercise the last set went onto, as its `data-recent` row draws it.
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
                if let r = workout.now?.recent { RecentLift(recent: r) }
            }
            .padding(.horizontal, 4)
        }
        .scrollIndicators(.never)
        .background(Color.black.ignoresSafeArea())
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
        return ViewThatFits(in: .horizontal) {
            oneLine(parts, 1)
            oneLine(parts, 0.85)
            oneLine(parts, 0.72)
            Flow(spacing: 12 * 0.72, lineSpacing: 4) { sides(parts, 0.72) }
        }
        .padding(.vertical, 6).padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.black))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#222a33"), lineWidth: 1))
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

/// `#heatinfo[data-recent]`: the dumbbell mark and the exercise's name, each muscle it trains with that
/// muscle's weekly sets (the name grey — bright for a primary mover, dim for a synergist — and the
/// number in the muscle's volume colour), then its sets ruled apart and the tally closing the row.
private struct RecentLift: View {
    let recent: WorkoutNow.Recent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Flow(spacing: 11, lineSpacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Dumbbell().frame(width: 15, height: 15).opacity(0.6).alignmentGuide(.firstTextBaseline) { $0.height - 2 }
                    Text(recent.name).font(.system(size: 17, weight: .bold)).foregroundColor(Color(hex: "#e6eaf0"))
                }
                ForEach(Array(recent.muscles.enumerated()), id: \.offset) { _, m in
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(m.label).font(.system(size: 12, weight: .semibold))
                            .foregroundColor(Color(hex: m.primary ? "#c7cdd6" : "#6b7686"))
                        Text(js(m.sets)).font(.system(size: 15, weight: .bold).monospacedDigit())
                            .foregroundColor(Color(hex: m.color))
                    }
                    .fixedSize()
                }
            }
            SetsRow(sets: recent.sets)
        }
        .padding(.horizontal, 2)
    }
}

/// The set row. One line: it shrinks from 16 toward 9 until it fits, and only past that drops a weight
/// that repeats the set before it — as cards/workouts.js does, cheapest first. The tally keeps its size.
private struct SetsRow: View {
    let sets: [WorkoutNow.Lift]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Array(stride(from: 16, through: 9, by: -1)), id: \.self) { fs in row(CGFloat(fs), elide: false) }
            ForEach(Array(stride(from: 16, through: 9, by: -1)), id: \.self) { fs in row(CGFloat(fs), elide: true) }
        }
    }

    private func row(_ fs: CGFloat, elide: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ForEach(Array(sets.enumerated()), id: \.offset) { i, st in
                let carry = elide && i > 0 && sets[i - 1].weight_lbs == st.weight_lbs
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    if !carry {
                        Text(st.weight_lbs == 0 ? "BW" : js(st.weight_lbs ?? 0))
                            .font(.system(size: fs * 0.8125, weight: .bold).monospacedDigit())
                            .foregroundColor(Color(hex: "#c7cdd6"))
                    }
                    Text("×").font(.system(size: fs)).foregroundColor(Color(hex: "#5c6675"))
                        .padding(.horizontal, fs * 0.19)
                    Text(String(st.reps ?? 0)).font(.system(size: fs, weight: .bold).monospacedDigit())
                        .foregroundColor(Color(hex: "#c7cdd6"))
                }
                .padding(.leading, i == 0 ? 0 : fs * 0.625)
                .padding(.trailing, i == sets.count - 1 ? 0 : fs * 0.625)
                .overlay(alignment: .leading) {
                    if i > 0 { Rectangle().fill(Color.white.opacity(0.18)).frame(width: 1) }
                }
            }
            Spacer(minLength: 0)
            Text(String(sets.count)).font(.system(size: 17, weight: .bold).monospacedDigit())
                .foregroundColor(Color(hex: "#e6eaf0"))
                .padding(.leading, 13)
                .overlay(alignment: .leading) { Rectangle().fill(Color.white.opacity(0.5)).frame(width: 2) }
        }
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
    }
}

/// The wall's dumbbell: collar, plate, bar, plate, collar, from its 44×40 SVG, fitted into the box.
private struct Dumbbell: View {
    var body: some View {
        Canvas { ctx, size in
            let k = min(size.width / 44, size.height / 40)
            let dx = (size.width - 44 * k) / 2, dy = (size.height - 40 * k) / 2
            let rects: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
                (0, 12, 7, 16, 2), (8, 4, 10, 32, 2), (18, 15, 8, 10, 0), (26, 4, 10, 32, 2), (37, 12, 7, 16, 2),
            ]
            for (x, y, w, h, r) in rects {
                let rect = CGRect(x: dx + x * k, y: dy + y * k, width: w * k, height: h * k)
                ctx.fill(Path(roundedRect: rect, cornerRadius: r * k), with: .color(.white))
            }
        }
    }
}
