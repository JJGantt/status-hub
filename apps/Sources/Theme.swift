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

let statusLabel: [String: String] = [
    "READY": "Ready", "CLEAN_CYCLE": "Cleaning", "CAT_SENSOR_INTERRUPTED": "Stuck (auto-resuming)",
    "PAUSED": "Paused", "CAT_DETECTED": "Cat detected", "CAT_SENSOR_TIMING": "Waiting (post-cat)",
    "CLEAN_CYCLE_COMPLETE": "Cycle complete", "DRAWER_FULL": "Drawer full!", "OFFLINE": "Offline", "OFF": "Off",
]
let statusColorMap: [String: UInt32] = [
    "READY": 0x3b82f6, "CLEAN_CYCLE": 0xeab308, "CAT_SENSOR_INTERRUPTED": 0xf97316,
    "PAUSED": 0xf97316, "DRAWER_FULL": 0xef4444, "OFFLINE": 0xef4444, "OFF": 0x556677,
]
func statusColor(_ s: String) -> Color { Color(hex: statusColorMap[s] ?? 0x8b96a5) }

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
