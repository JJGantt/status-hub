import SwiftUI
import AppKit

// Renders the to-do widget's own views to PNGs, so row density and truncation can be judged without
// a rebuild-reinstall-squint-at-the-phone cycle. Compiled against Controls/TodoView.swift — the SAME
// code the widget draws with — so what comes out is what ships. Twin of tools/render-rings.swift.
//
//   swiftc -O tools/render-todo.swift Controls/TodoView.swift Controls/RingsView.swift \
//          Shared/Auth.swift Shared/OpenTodoItem.swift -o /tmp/render-todo && /tmp/render-todo <outdir>
//
// (RingsView comes along for the shared palette; Auth for the intents' network call.)

// A realistic mix: expired and upcoming, across lists, one repeating. The expired ones are the point
// — they are what the colouring and the anchor ordering exist for.
let json = """
{"items":[
 {"id":"1","title":"Order water filter","list":"Amazon","emoji":"\u{1F4E6}","expired":true,"repeating":false},
 {"id":"2","title":"Take care of the insurance and driving stuff","list":"todo","emoji":"\u{1F4CB}","expired":true,"repeating":false},
 {"id":"3","title":"Evening vitamins","list":"todo","emoji":"\u{1F4CB}","expired":true,"repeating":true},
 {"id":"4","title":"Get the ESP flashed and working again","list":"todo","emoji":"\u{1F4CB}","expired":false,"repeating":false},
 {"id":"5","title":"Milk and eggs","list":"grocery","emoji":"\u{1F6D2}","expired":false,"repeating":false},
 {"id":"6","title":"Replace Pi USB thumb drive with a USB SSD (256GB)","list":"todo","emoji":"\u{1F4CB}","expired":false,"repeating":false}]}
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
            shoot(feed, nil,   outDir, "todo-clearing",    CGSize(width: 364, height: 172), .medium, clearing: "2")
        }
    }
}

@MainActor
func shoot(_ feed: TodoFeed, _ armed: String?, _ outDir: String, _ name: String,
           _ size: CGSize, _ layout: TodoLayout, clearing: String? = nil) {
    let view = TodoListView(feed: feed, armed: armed, clearing: clearing, layout: layout)
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
