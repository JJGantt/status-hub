import SwiftUI

/// **A reply's markdown, laid out as blocks**: headings at their own sizes, bulleted and numbered lists
/// (nested by indent), fenced code, quotes, rules and tables. `Text` alone renders only the INLINE part
/// of markdown and runs every block into one paragraph, so the blocks are split out here and each drawn
/// as its own view, with `inlineMarkdown` doing the inside of every one of them.
///
/// The same coverage as `md()` in the hub's shared.js, plus tables, which fit on a watch at these sizes.
struct Markdown: View {
    let text: String
    var size: CGFloat = 13
    var weight: Font.Weight = .regular
    /// Take the whole width (a reply), or only the text's own (the user's words, which hug the right edge).
    var fill = true

    var body: some View {
        let blocks = MarkdownBlock.parse(text)
        VStack(alignment: .leading, spacing: size * 0.5) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in block(b) }
        }
        .font(.system(size: size, weight: weight))
        .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
    }

    @ViewBuilder private func block(_ b: MarkdownBlock) -> some View {
        switch b {
        case .paragraph(let s):
            Text(inlineMarkdown(s))
        case .heading(let level, let s):
            Text(inlineMarkdown(s))
                .font(.system(size: size + [6, 4, 2, 1, 0, 0][min(level, 6) - 1], weight: .bold))
                .padding(.top, level <= 2 ? size * 0.3 : 0)
        case .list(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(item.marker).monospacedDigit()
                        Text(inlineMarkdown(item.text))
                    }
                    .padding(.leading, CGFloat(item.depth) * 10)
                }
            }
        case .code(let s):
            Text(s)
                .font(.system(size: size - 2, design: .monospaced))
                .opacity(0.85)
        case .quote(let s):
            HStack(alignment: .top, spacing: 6) {
                Rectangle().frame(width: 2).opacity(0.4)
                Text(inlineMarkdown(s)).opacity(0.8)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().frame(height: 1).opacity(0.3)
        case .table(let align, let header, let rows):
            // Wider than the screen scrolls sideways rather than wrapping every cell to a word a line.
            ViewThatFits(in: .horizontal) {
                grid(align, header, rows)
                ScrollView(.horizontal, showsIndicators: false) { grid(align, header, rows) }
            }
        }
    }

    private func grid(_ align: [HorizontalAlignment], _ header: [String], _ rows: [[String]]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 3) {
            GridRow { cells(header, align, bold: true) }
            Rectangle().frame(height: 1).opacity(0.3).gridCellUnsizedAxes(.horizontal)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow { cells(row, align, bold: false) }
            }
        }
        .font(.system(size: size - 2))
        .fixedSize(horizontal: true, vertical: false)
    }

    @ViewBuilder private func cells(_ row: [String], _ align: [HorizontalAlignment], bold: Bool) -> some View {
        ForEach(Array(align.indices), id: \.self) { i in
            Text(inlineMarkdown(i < row.count ? row[i] : ""))
                .fontWeight(bold ? .semibold : nil)
                .gridColumnAlignment(align[i])
        }
    }
}

enum MarkdownBlock {
    struct Item { let depth: Int; let marker: String; var text: String }

    case paragraph(String)
    case heading(Int, String)
    case list([Item])
    case code(String)
    case quote(String)
    case rule
    case table([HorizontalAlignment], [String], [[String]])

    static func parse(_ src: String) -> [MarkdownBlock] {
        let lines = src.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [MarkdownBlock] = []
        var para: [String] = [], quote: [String] = [], items: [Item] = [], indents: [Int] = []
        var code: [String]? = nil

        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
            if !quote.isEmpty { out.append(.quote(quote.joined(separator: "\n"))); quote = [] }
            if !items.isEmpty { out.append(.list(items)); items = []; indents = [] }
        }

        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let line = raw.trimmingCharacters(in: .whitespaces)
            i += 1
            if line.hasPrefix("```") {
                if let c = code { out.append(.code(c.joined(separator: "\n"))); code = nil } else { flush(); code = [] }
                continue
            }
            if code != nil { code!.append(raw); continue }
            if line.isEmpty { flush(); continue }

            if let m = line.firstMatch(of: #/^(#{1,6})\s+(.*)$/#) {
                flush(); out.append(.heading(m.1.count, String(m.2))); continue
            }
            if line.wholeMatch(of: #/(\*\s*){3,}|(-\s*){3,}|(_\s*){3,}/#) != nil {
                flush(); out.append(.rule); continue
            }
            // A table is a pipe row with a separator row under it; without the separator it is prose.
            if line.hasPrefix("|"), i < lines.count, let align = separator(lines[i]) {
                flush()
                let header = cells(line)
                var rows: [[String]] = []
                i += 1
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[i])); i += 1
                }
                let width = max(header.count, align.count)
                out.append(.table((0..<width).map { $0 < align.count ? align[$0] : .leading }, header, rows))
                continue
            }
            if let m = raw.firstMatch(of: #/^(\s*)([-*+]|\d+[.)])\s+(.*)$/#) {
                if !para.isEmpty || !quote.isEmpty { flush() }
                let indent = m.1.count
                while let last = indents.last, last > indent { indents.removeLast() }
                if indents.last != indent { indents.append(indent) }
                let marker = m.2 == "-" || m.2 == "*" || m.2 == "+" ? "•" : String(m.2)
                items.append(Item(depth: indents.count - 1, marker: marker, text: String(m.3)))
                continue
            }
            if let m = line.firstMatch(of: #/^>\s?(.*)$/#) {
                if !para.isEmpty || !items.isEmpty { flush() }
                quote.append(String(m.1)); continue
            }
            // A line under a list item that is not itself an item continues it.
            if !items.isEmpty, raw.first == " " || raw.first == "\t" {
                items[items.count - 1].text += "\n" + line; continue
            }
            if !items.isEmpty || !quote.isEmpty { flush() }
            para.append(line)
        }
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        flush()
        return out
    }

    /// The reply as words to be said: each block's text with its markup gone, one block a sentence.
    static func spoken(_ src: String) -> String {
        func plain(_ s: String) -> String { String(snippet(s).characters) }
        return parse(src).compactMap { b -> String? in
            switch b {
            case .paragraph(let s), .heading(_, let s), .quote(let s): return plain(s)
            case .code(let s): return s
            case .list(let items): return items.map { plain($0.text) }.joined(separator: ". ")
            case .table(_, let header, let rows):
                return ([header] + rows).map { $0.map(plain).joined(separator: ", ") }.joined(separator: ". ")
            case .rule: return nil
            }
        }
        .joined(separator: ". ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func cells(_ row: String) -> [String] {
        var s = row.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// The alignment row under a table's header (`|---|:--:|--:|`), or nil when the line is not one.
    private static func separator(_ row: String) -> [HorizontalAlignment]? {
        let parts = cells(row)
        guard !parts.isEmpty, parts.allSatisfy({ $0.wholeMatch(of: #/:?-+:?/#) != nil }) else { return nil }
        return parts.map { p in
            p.hasPrefix(":") && p.hasSuffix(":") ? .center : p.hasSuffix(":") ? .trailing : .leading
        }
    }
}
