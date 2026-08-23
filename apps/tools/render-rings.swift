import SwiftUI
import AppKit

// Renders the widget's own views to PNGs so the layout can be inspected without a rebuild-reinstall
// -squint-at-the-phone cycle. Compiled against Controls/RingsView.swift — the SAME code the widget
// draws with — so what comes out is what ships, not an approximation.
//
//   swiftc -O tools/render-rings.swift Controls/RingsView.swift -o /tmp/render && /tmp/render <outdir>

// Real values, taken from a live /api/rings response.
let json = """
{"t":0,"frac":0.4,"macros":{
 "calories":{"consumed":480,"goal":2600,"dev_g":-563,"ring_base":0.783,"ring_over":0,"base_color":"#dfcf20","over_color":null,"dev_color":"#f87171"},
 "protein_g":{"consumed":45,"goal":177,"dev_g":-26,"ring_base":0.853,"ring_over":0,"base_color":"#acdf20","over_color":null,"dev_color":"#f87171"},
 "carbs_g":{"consumed":69,"goal":313,"dev_g":-57,"ring_base":0.818,"ring_over":0,"base_color":"#c7df20","over_color":null,"dev_color":"#f87171"},
 "fat_g":{"consumed":18,"goal":87,"dev_g":-17,"ring_base":0.803,"ring_over":0,"base_color":"#d4df20","over_color":null,"dev_color":"#f87171"}}}
"""

@main
enum Render {
    static func main() {
        let frame = try! JSONDecoder().decode(Frame.self, from: Data(json.utf8))
        let score = Score(nutrition: 31.5, training: 22.0, overall: 53.5)
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
        // Real widget point sizes on a 12 Pro Max.
        MainActor.assumeIsolated {
            shoot(frame, score, outDir, "medium",      CGSize(width: 364, height: 172), .medium)
            shoot(frame, score, outDir, "small",       CGSize(width: 170, height: 170), .small)
            shoot(frame, score, outDir, "rectangular", CGSize(width: 172, height: 76),  .rectangular)
        }
    }
}

@MainActor
func shoot(_ frame: Frame, _ score: Score, _ outDir: String, _ name: String, _ size: CGSize, _ layout: RingsLayout) {
    let view = RingsRow(frame: frame, layout: layout, score: score)
        .padding(.horizontal, 8).padding(.vertical, 6)
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

