import SwiftUI
import AppKit

// Renders the to-do widget's own views to PNGs, so row density and truncation can be judged without
// a rebuild-reinstall-squint-at-the-phone cycle. Compiled against Controls/TodoView.swift — the SAME
// code the widget draws with — so what comes out is what ships. Twin of tools/render-rings.swift.
//
//   swiftc -O tools/render-todo.swift Controls/TodoView.swift Controls/RingsView.swift \
//          Shared/Auth.swift -o /tmp/render-todo && /tmp/render-todo <outdir>
//
// (RingsView comes along for the shared palette; Auth for the intents' network call.)

// Real titles, as /api/list-widget derives them from the live list — including the long ones, which
// are the only ones that prove the truncation behaves.
let json = """
{"list":"todo","items":[
 {"id":"1","title":"Replace Pi USB thumb drive with a USB SSD (256GB)"},
 {"id":"2","title":"Take care of the insurance and driving stuff","overdue":true},
 {"id":"3","title":"Get the ESP flashed and working again"},
 {"id":"4","title":"Hub UI: show when a request was escalated to Opus (e.g. near the tools/commands display at the bottom)"},
 {"id":"5","title":"Hair pills"}]}
"""

@main
enum RenderTodo {
    static func main() {
        let feed = try! JSONDecoder().decode(TodoFeed.self, from: Data(json.utf8))
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
        // Real widget point sizes on a 12 Pro Max.
        MainActor.assumeIsolated {
            shoot(feed, nil,   outDir, "todo-small",       CGSize(width: 170, height: 170), .small)
            shoot(feed, nil,   outDir, "todo-medium",      CGSize(width: 364, height: 172), .medium)
            shoot(feed, "2",   outDir, "todo-medium-armed", CGSize(width: 364, height: 172), .medium)
            shoot(feed, nil,   outDir, "todo-large",       CGSize(width: 364, height: 382), .large)
        }
    }
}

@MainActor
func shoot(_ feed: TodoFeed, _ armed: String?, _ outDir: String, _ name: String,
           _ size: CGSize, _ layout: TodoLayout) {
    let view = TodoListView(feed: feed, armed: armed, layout: layout)
        .padding(.horizontal, 12).padding(.vertical, 11)
        .frame(width: size.width, height: size.height)
        .background(Color(red: 0.082, green: 0.102, blue: 0.125))   // the card's ground
    let r = ImageRenderer(content: view)
    r.scale = 3
    guard let img = r.nsImage,
          let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        print("failed: \(name)"); return
    }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(name).png  \(Int(size.width))x\(Int(size.height))")
}
