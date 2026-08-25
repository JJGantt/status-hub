import SwiftUI
import AppKit

// Renders the projects widget to PNGs so row density and the confirm affordance can be judged without
// a rebuild-reinstall-squint cycle. Twin of tools/render-todo.swift, compiled against the same views.
//
//   swiftc -O tools/render-repos.swift Controls/ReposView.swift Controls/RingsView.swift \
//          Shared/Auth.swift Shared/OpenTodoItem.swift -o /tmp/render-repos && /tmp/render-repos <outdir>

// Real projects, as /api/repos-widget publishes them.
let json = """
{"online":true,"repos":[
 {"path":"/Users/jaredgantt/repos/status-hub","name":"status-hub","branch":null,"dirty":true,"age":"now"},
 {"path":"/Users/jaredgantt/repos/data-layer","name":"data-layer","branch":null,"dirty":false,"age":"2h"},
 {"path":"/Users/jaredgantt/repos/voice-pipeline","name":"voice-pipeline","branch":"widget-work","dirty":true,"age":"19h"},
 {"path":"/Users/jaredgantt/repos/petlibro-mcp","name":"petlibro-mcp","branch":null,"dirty":false,"age":"19h"},
 {"path":"/Users/jaredgantt/repos/GolfTracker-SwingDetection","name":"GolfTracker-SwingDetection","branch":null,"dirty":false,"age":"2d"},
 {"path":"/Users/jaredgantt/repos/nutrition-track","name":"nutrition-track","branch":null,"dirty":false,"age":"3d"}]}
"""

@main
enum RenderRepos {
    static func main() {
        let feed = try! JSONDecoder().decode(ReposFeed.self, from: Data(json.utf8))
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
        let armed = "/Users/jaredgantt/repos/voice-pipeline"
        MainActor.assumeIsolated {
            shoot(feed, nil,   outDir, "repos-small",  CGSize(width: 170, height: 170), .small)
            shoot(feed, nil,   outDir, "repos-medium", CGSize(width: 364, height: 172), .medium)
            shoot(feed, armed, outDir, "repos-armed",  CGSize(width: 364, height: 172), .medium)
            shoot(feed, nil,   outDir, "repos-large",  CGSize(width: 364, height: 382), .large)
        }
    }
}

@MainActor
func shoot(_ feed: ReposFeed, _ armed: String?, _ outDir: String, _ name: String,
           _ size: CGSize, _ layout: ReposLayout) {
    let view = ReposListView(feed: feed, armed: armed, layout: layout)
        .padding(.horizontal, 12).padding(.vertical, 11)
        .frame(width: size.width, height: size.height)
        .background(Color(red: 0.082, green: 0.102, blue: 0.125))
    let r = ImageRenderer(content: view)
    r.scale = 3
    guard let img = r.nsImage, let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        print("failed: \(name)"); return
    }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(name).png  \(Int(size.width))x\(Int(size.height))")
}
