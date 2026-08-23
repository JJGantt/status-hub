import SwiftUI

// The DRAWING half of the rings widget, deliberately free of any WidgetKit dependency so it can be
// compiled and rendered on its own — see tools/render-rings.swift, which writes PNGs of these exact
// views. Iterating on ring geometry by rebuilding, reinstalling and squinting at a phone is slow and
// error-prone; this way the layout can actually be looked at.

struct Macro: Decodable {
    let consumed: Double, goal: Double, dev_g: Double
    let ring_base: Double, ring_over: Double
    let base_color: String, over_color: String?, dev_color: String
}
struct Frame: Decodable {
    let t: Int                 // minutes from the fetch
    let frac: Double           // how far through the eating window — drives the marker
    let macros: [String: Macro]
}
struct RingsFeed: Decodable { let step_min: Int; let frames: [Frame] }

private extension Color {
    /// "#rrggbb" from the server's pace palette.
    init(hex: String) {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let v = UInt32(h, radix: 16) ?? 0x22c55e
        self.init(red: Double((v >> 16) & 0xff) / 255,
                  green: Double((v >> 8) & 0xff) / 255,
                  blue: Double(v & 0xff) / 255)
    }
}

/// The on-pace marker: angle 2π·frac measured COUNTER-clockwise from twelve o'clock, matching
/// cards/nutrition.js tickRings(). It is drawn ACROSS the ring band rather than at fixed fractions —
/// a stroked Circle sits on radius (size-lineWidth)/2, so the band's centre is at 1-lw/size of the
/// half-size and it is lw/size wide. Deriving it keeps the tick on the ring whatever the stroke
/// weight; hard-coded fractions left it floating inside the ring.
private struct PaceMark: Shape {
    let frac: Double
    let lwFrac: Double            // stroke width as a fraction of the view's size
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let half = min(rect.width, rect.height) / 2
        let phi = 2 * Double.pi * frac
        let mid = 1 - lwFrac                       // centre of the band
        let reach = (lwFrac / 2) * 1.25            // a touch proud of the band on both sides
        let pt = { (f: Double) in
            CGPoint(x: c.x - half * f * sin(phi), y: c.y - half * f * cos(phi))
        }
        var p = Path()
        p.move(to: pt(mid - reach))
        p.addLine(to: pt(mid + reach))
        return p
    }
}

// The card's ground is always dark, so these are explicit rather than semantic: .primary/.secondary
// resolve against the renderer's colour scheme and came out near-black on the dark card.
private let inkText  = Color(red: 0.910, green: 0.918, blue: 0.929)   // #e8eaed
private let mutedText = Color(red: 0.545, green: 0.588, blue: 0.647)  // #8b96a5

private struct RingView: View {
    let label: String
    let macro: Macro?
    let frac: Double
    var compact = false          // Lock Screen / small: drop the totals line, thinner strokes

    var body: some View {
        VStack(spacing: compact ? 0 : 5) {
            GeometryReader { geo in
                let size = min(geo.size.width, geo.size.height)
                let lwFrac = compact ? 0.10 : 0.115        // thin enough that neighbouring rings don't crowd
                let lw = size * lwFrac
                let base = min(max(macro?.ring_base ?? 0, 0), 1)
                let over = min(max(macro?.ring_over ?? 0, 0), 1)
                ZStack {
                    Circle().stroke(inkText.opacity(0.14), lineWidth: lw)
                    Circle()
                        .trim(from: 0, to: base)
                        .stroke(Color(hex: macro?.base_color ?? "#22c55e"),
                                style: StrokeStyle(lineWidth: lw, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    if let oc = macro?.over_color, over > 0 {
                        Circle()
                            .trim(from: 0, to: over)
                            .stroke(Color(hex: oc), style: StrokeStyle(lineWidth: lw, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                    PaceMark(frac: frac, lwFrac: lwFrac)
                        .stroke(Color.white, style: StrokeStyle(lineWidth: max(1.5, size * 0.05), lineCap: .round))
                    VStack(spacing: 0) {
                        Text(label)
                            .font(.system(size: size * 0.24, weight: .semibold, design: .rounded))
                            .foregroundStyle(inkText)
                        if let m = macro {
                            Text(devText(m))
                                .font(.system(size: size * 0.20, weight: .semibold, design: .rounded))
                                .foregroundStyle(Color(hex: m.dev_color))
                        }
                    }
                }
                .frame(width: size, height: size)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .aspectRatio(1, contentMode: .fit)

            if !compact {
                // String(), not interpolation: SwiftUI localises an interpolated Int and turns 2600
                // into "2,600", which doesn't match the card and costs width the row hasn't got.
                Text(macro.map { String(Int($0.consumed)) + " / " + String(Int($0.goal)) } ?? " ")
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(mutedText)
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .fixedSize(horizontal: false, vertical: true)   // never clip the descenders
            }
        }
    }

    /// Signed distance from the pace line, same as the card's centre number.
    private func devText(_ m: Macro) -> String {
        let d = Int(m.dev_g)
        return (d > 0 ? "+" : "") + String(d)
    }
}


/// Which shape to draw in. Mirrors the widget families but doesn't depend on WidgetKit, so the
/// renderer can ask for any of them.
public enum RingsLayout { case small, medium, circular, rectangular }

struct RingsRow: View {
    let frame: Frame?
    let layout: RingsLayout

    private let keys = [("Cal", "calories"), ("P", "protein_g"), ("C", "carbs_g"), ("F", "fat_g")]

    private func ring(_ i: Int, _ frac: Double) -> some View {
        RingView(label: keys[i].0, macro: frame?.macros[keys[i].1], frac: frac, compact: true)
    }

    var body: some View {
        let frac = frame?.frac ?? 0
        switch layout {
        case .circular:
            RingView(label: "Cal", macro: frame?.macros["calories"], frac: frac, compact: true)
        case .rectangular:
            HStack(spacing: 6) { ForEach(keys, id: \.0) { k in
                RingView(label: k.0, macro: frame?.macros[k.1], frac: frac, compact: true) } }
        case .small:
            // The small widget is SQUARE: a row of four leaves two thirds of it empty and shrinks
            // each ring to nothing. A 2x2 fills it and keeps the rings legible.
            VStack(spacing: 8) {
                HStack(spacing: 8) { ring(0, frac); ring(1, frac) }
                HStack(spacing: 8) { ring(2, frac); ring(3, frac) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .medium:
            // Four rings in a row are width-constrained, so the widget's height always has slack.
            // Tight spacing buys a little ring size, and centring puts the leftover evenly top and
            // bottom instead of pooling it under the row.
            HStack(spacing: 10) { ForEach(keys, id: \.0) { k in
                RingView(label: k.0, macro: frame?.macros[k.1], frac: frac) } }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}
