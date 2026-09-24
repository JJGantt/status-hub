import SwiftUI

/// One of the two body-map figures — the front or the back — coloured by the week's training, the same
/// artwork and the same colours the wall draws (`cards/muscle.js`).
///
/// **The artwork is ONE 72x93 drawing with the front in x 0-36 and the back in x 36-72**, and a figure
/// is that whole drawing seen through a 36-wide window. The window is a CLIP, not just an offset: without
/// it the other half of the artwork paints beside the figure, which is the same trap the web's split
/// figures document (status-hub CLAUDE.md, "The split body figures carry the WHOLE artwork").
struct BodyFigure: View {
    let back: Bool
    /// Region id → fill, from `/api/workout-now`'s `body`. A region with no entry draws in the base fill.
    let colours: [String: String]

    /// The artwork's own units: one figure is 36 wide and 93 tall.
    static let aspect: CGFloat = 36.0 / 93.0

    var body: some View {
        Canvas { ctx, size in
            let k = size.height / 93
            ctx.clip(to: Path(CGRect(origin: .zero, size: size)))
            ctx.concatenate(CGAffineTransform(scaleX: k, y: k).translatedBy(x: back ? -36 : 0, y: 0))
            for (id, path) in Self.paths {
                ctx.fill(path, with: .color(colours[id].map { Color(hex: $0) } ?? Self.base))
                ctx.stroke(path, with: .color(Self.outline), lineWidth: 0.25)
            }
        }
        .aspectRatio(Self.aspect, contentMode: .fit)
    }

    // app.css `#body .bodysvg path`: the base fill and the hairline between regions.
    private static let base = Color(hex: "#222a33")
    private static let outline = Color(hex: "#0b0d10")

    /// Parsed once: the artwork never changes while the app runs.
    private static let paths: [(String, Path)] = bodyPaths.map { ($0.id, svgPath($0.d)) }
}

/// The subset of SVG path syntax the body-map artwork uses: M L H V C Z in both cases, implicit repeats,
/// and numbers with exponents (`4.9e-4`) and no separator before a sign (`1.5-2`).
private func svgPath(_ d: String) -> Path {
    var p = Path()
    var tokens = tokenize(d)[...]
    var cmd: Character = "M"
    var cur = CGPoint.zero, start = CGPoint.zero

    func num() -> CGFloat? {
        guard case .number(let v)? = tokens.first else { return nil }
        tokens.removeFirst()
        return CGFloat(v)
    }

    while !tokens.isEmpty {
        if case .command(let c) = tokens.first! { cmd = c; tokens.removeFirst() }
        let rel = cmd.isLowercase
        switch cmd.uppercased().first! {
        case "M":
            guard let x = num(), let y = num() else { return p }
            cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            start = cur
            p.move(to: cur)
            cmd = rel ? "l" : "L"      // further pairs after a moveto are linetos
        case "L":
            guard let x = num(), let y = num() else { return p }
            cur = rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            p.addLine(to: cur)
        case "H":
            guard let x = num() else { return p }
            cur.x = rel ? cur.x + x : x
            p.addLine(to: cur)
        case "V":
            guard let y = num() else { return p }
            cur.y = rel ? cur.y + y : y
            p.addLine(to: cur)
        case "C":
            guard let x1 = num(), let y1 = num(), let x2 = num(), let y2 = num(),
                  let x = num(), let y = num() else { return p }
            let o = rel ? cur : .zero
            let end = CGPoint(x: o.x + x, y: o.y + y)
            p.addCurve(to: end, control1: CGPoint(x: o.x + x1, y: o.y + y1),
                       control2: CGPoint(x: o.x + x2, y: o.y + y2))
            cur = end
        case "Z":
            p.closeSubpath()
            cur = start
        default:
            return p
        }
    }
    return p
}

private enum Token { case command(Character), number(Double) }

private func tokenize(_ d: String) -> [Token] {
    var out: [Token] = []
    var buf = ""
    func flush() {
        if let v = Double(buf) { out.append(.number(v)) }
        buf = ""
    }
    for ch in d {
        if ch.isLetter && ch != "e" && ch != "E" {
            flush(); out.append(.command(ch))
        } else if ch == " " || ch == "," || ch == "\n" {
            flush()
        } else if ch == "-" || ch == "+" {
            // A sign starts a new number unless it follows an exponent marker.
            if let last = buf.last, last == "e" || last == "E" { buf.append(ch) } else { flush(); buf.append(ch) }
        } else if ch == "." && buf.contains(".") && !buf.contains("e") && !buf.contains("E") {
            flush(); buf.append(ch)     // "0.5.5" is two numbers
        } else {
            buf.append(ch)
        }
    }
    flush()
    return out
}
