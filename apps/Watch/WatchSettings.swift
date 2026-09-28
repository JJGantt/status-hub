import SwiftUI

/// **The watch's switches and knobs that live on the hub**, so the phone's Settings page changes them
/// and no build is needed. One read of `/api/settings` when the app launches and whenever it comes to
/// the front, and every value is kept here between launches, so the app draws right from the first
/// frame and only changes if the hub says something new.
enum WatchSettings {
    @MainActor static func refresh() async {
        guard let all = try? await Hub.settings() else { return }
        if let v = all[Speaker.key], isOn(v) != SharedState.speech {
            SharedState.speech = isOn(v)
            Speaker.reload()
            Speaker.redrawControl()
        }
        if let v = all[Speaker.volumeKey].flatMap({ Double("\($0)") }) {
            Speaker.shared.apply(volume: Int(v.rounded()))
        }
        if let v = all[Speaker.routeKey] { Speaker.shared.apply(route: "\(v)") }
        BorderStyle.shared.apply(all)
    }

    private static func isOn(_ v: Any) -> Bool {
        ["1", "true", "on", "yes"].contains("\(v)".lowercased())
    }
}

/// How the edge of the glass looks (`CommandBorder`). Every field is a hub setting; unset, it takes the
/// default here. Colours are SOLID hex — a translucent line lets text show through it.
@MainActor
final class BorderStyle: ObservableObject {
    static let shared = BorderStyle()

    /// Thickness of the line, in pixels.
    @Published private(set) var px: Double = 0
    /// The opaque black band just inside the line, in pixels; 0 for none.
    @Published private(set) var bandPx: Double = 0
    @Published private(set) var recording = ""
    @Published private(set) var locked = ""
    /// The bright stretch that travels round while the hub works.
    @Published private(set) var working = ""
    /// The ring that stretch travels round.
    @Published private(set) var ring = ""
    @Published private(set) var listening = ""

    /// Every setting and its default — the one place a default is written.
    private static let fields: [(key: String, fallback: String)] = [
        ("watch_border_px", "3"), ("watch_border_band_px", "2"),
        ("watch_border_recording", "#f2a13d"), ("watch_border_locked", "#e5484d"),
        ("watch_border_working", "#ffffff"), ("watch_border_ring", "#404040"),
        ("watch_border_listening", "#295bac"),
    ]

    private init() { load() }

    /// Takes whatever the hub has for each field and keeps it; a field the hub has not set, or has set
    /// to something unusable (a colour that is not `#rrggbb`, a thickness that is not a number), takes
    /// its default rather than drawing something else.
    func apply(_ all: [String: Any]) {
        let d = UserDefaults.standard
        for (key, fallback) in Self.fields {
            let value = all[key].map { "\($0)" } ?? fallback
            let usable = fallback.hasPrefix("#") ? Self.isHex(value) : Double(value) != nil
            d.set(usable ? value : fallback, forKey: key)
        }
        load()
    }

    private func load() {
        let d = UserDefaults.standard
        func v(_ i: Int) -> String { d.string(forKey: Self.fields[i].key) ?? Self.fields[i].fallback }
        px = Double(v(0)) ?? 3
        bandPx = Double(v(1)) ?? 2
        recording = v(2); locked = v(3); working = v(4); ring = v(5); listening = v(6)
    }

    private static func isHex(_ s: String) -> Bool {
        s.count == 7 && s.hasPrefix("#") && s.dropFirst().allSatisfy(\.isHexDigit)
    }
}

/// A `#rrggbb` colour, fully opaque. With the wrist down the system dims the whole screen; the edge
/// adds no dimming of its own.
func solid(_ hex: String) -> Color {
    let v = UInt32(hex.dropFirst(), radix: 16) ?? 0xffffff
    return Color(red: Double((v >> 16) & 0xff) / 255,
                 green: Double((v >> 8) & 0xff) / 255,
                 blue: Double(v & 0xff) / 255)
}
