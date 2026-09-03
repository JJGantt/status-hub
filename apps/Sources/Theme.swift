import SwiftUI

extension Color {
    static let bg = Color(red: 0.043, green: 0.051, blue: 0.063)
    static let card = Color(red: 0.082, green: 0.102, blue: 0.125)
    static let cardBorder = Color(red: 0.133, green: 0.165, blue: 0.200)
    static let tile = Color(red: 0.055, green: 0.075, blue: 0.094)
    static let muted = Color(red: 0.545, green: 0.588, blue: 0.647)
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255)
    }
}

// t=0 green -> t=1 red, through yellow at 0.5 (mirrors the web hueColor).
func hueColor(_ t: Double) -> Color {
    let tt = max(0, min(1, t))
    return Color(hue: (120 * (1 - tt)) / 360.0, saturation: 0.85, brightness: 0.6)
}
func litterColor(_ v: Double?) -> Color { v == nil ? .muted : hueColor((90 - v!) / 20) }   // 90%→green, 70%→red
func drawerColor(_ v: Double?) -> Color { v == nil ? .muted : hueColor((v! - 75) / 20) }   // 75%→green, 95%→red

// "#rrggbb" from the payload -> Color. Device state colours are computed server-side so the card,
// the walls and this app cannot drift apart.
func hexColor(_ s: String?) -> Color {
    guard let hex = s?.trimmingCharacters(in: CharacterSet(charactersIn: "#")),
          let v = UInt32(hex, radix: 16) else { return .muted }
    return Color(hex: v)
}

// Workout label → accent color (push red, pull green, legs blue, full body white, else purple).
func dayColor(_ label: String?) -> Color {
    guard let l = label?.lowercased() else { return Color(hex: 0x2a313a) }
    if l.contains("full body") { return Color(hex: 0xe8eaed) }
    if l.contains("push") { return Color(hex: 0xef4444) }
    if l.contains("pull") { return Color(hex: 0x22c55e) }
    if l.contains("legs") { return Color(hex: 0x3b82f6) }
    return Color(hex: 0xa855f7)
}

func gint(_ v: Double?) -> String { v == nil ? "0" : String(Int(v!.rounded())) }
func pctText(_ v: Double?) -> String { v == nil ? "—" : "\(Int(v!.rounded()))%" }
