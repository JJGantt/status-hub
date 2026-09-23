import SwiftUI

/// The page right of nutrition: the home wall's rest clocks (cards/workouts.js), then every exercise
/// logged today in the wall's `data-recent` row, the one a set just went onto first and the rest
/// scrolling below it.
struct WorkoutView: View {
    @EnvironmentObject private var workout: Workout
    /// One exercise open at a time, and **the newest is open by default** — the set just logged is the
    /// one being looked at, and a set landing on another exercise moves the opening to it.
    @State private var open: String?

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
                    LiftRow(exercise: ex, open: open == ex.name, toggle: { open = open == ex.name ? nil : ex.name })
                        .padding(.top, i == 0 ? 0 : 9)
                        // Ruled apart like the hub's day list (`.dex`), since the rows no longer stand alone.
                        .overlay(alignment: .top) {
                            if i > 0 { Rectangle().fill(Color(hex: "#222a33")).frame(height: 1) }
                        }
                }
            }
            // 8pt, matching every other page: a rule or a name run to the edge has its ends under
            // the display's corner arc at 4.
            .padding(.horizontal, 8)
            .padding(.bottom, CommandBar.height)
        }
        .onChange(of: workout.now?.exercises.first?.name, initial: true) { _, newest in open = newest }
        .scrollIndicators(.never)
        .topOfTheScreen()
        .background(Color.black.ignoresSafeArea())
        .overlay { CommandBar(view: "workout") }
    }
}

private let clockGreen = Color(hex: "#39d353")
private let clockAmber = Color(hex: "#d6c042")
private let clockGrey = Color(hex: "#8b96a5")

/// The wall's `#resttimer`, cut to what a wrist reads: **the time since the last set on the left, the
/// day's sets on the right**, one line, no box and no words. A clock symbol carries "since the last
/// set" where the wall spells it out, and the session clock rides beside it under a stopwatch — the
/// labels were half the line for two numbers whose meaning the symbols give away.
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
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            value(since(rest), "clock", active ? (rest >= 300 ? clockAmber : clockGreen) : clockGrey)
            if active { value(sessionClock(session), "stopwatch", clockGreen) }
            Spacer(minLength: 0)
            // The day's total, read at the RIGHT edge like every other figure on that side of this
            // page: the word first, the number against the edge, lining up with the muscle counts
            // under it. The clocks on the left are the mirror of this, value first.
            (Text("sets ").foregroundColor(clockGrey.opacity(0.6))
                + Text(String(setsToday)).foregroundColor(clockGrey))
                .font(.system(size: 15, weight: .heavy).monospacedDigit())
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The number first, its symbol after it: the value is what is read and the symbol only says which
    /// clock it is.
    private func value(_ text: String, _ symbol: String, _ colour: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(text)
                .font(.system(size: 17, weight: .heavy).monospacedDigit())
                .foregroundColor(colour)
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(clockGrey.opacity(0.7))
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
    let open: Bool
    let toggle: () -> Void

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
            if open { detail }
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { toggle() }
    }

    /// **Two columns: the sets, and what they train.** The sets run down the left one per line, and
    /// each muscle with its weekly sets runs down the right in that muscle's own volume colour — a
    /// synergist dimmer than a primary mover. Two kinds of number, each with a column of its own, so
    /// neither has to be read past the other.
    private var detail: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(exercise.sets.enumerated()), id: \.offset) { i, _ in setText(i) }
            }
            Spacer(minLength: 0)
            // **This column is read at its RIGHT edge: the value last, the muscle it names in front
            // of it.** The strip above is the other way round — the clock's value first, its mark
            // after — because that one is read at the LEFT edge. Each column puts its figures on the
            // side the eye runs down, which is the outside of the screen in both cases.
            VStack(alignment: .trailing, spacing: 2) {
                ForEach(Array(exercise.muscles.enumerated()), id: \.offset) { _, m in
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(m.label)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(Color(hex: m.primary ? "#c7cdd6" : "#6b7686"))
                        Text(js(m.sets))
                            .font(.system(size: 11, weight: .bold).monospacedDigit())
                            .foregroundColor(Color(hex: m.color))
                    }
                    .lineLimit(1)
                    .fixedSize()
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
