import SwiftUI
import WatchKit

/// **The watch's own volume, on the Digital Crown.** watchOS has no call that sets the system volume;
/// its volume control is the only way in, and while it holds focus the crown turns the device volume
/// rather than scrolling the page. `SessionView` shows it only while a reply is being spoken, so the
/// crown goes back to scrolling the moment the voice stops. The voice itself plays at full
/// (`Speaker`), so this is the one volume there is.
struct VolumeKnob: WKInterfaceObjectRepresentable {
    func makeWKInterfaceObject(context: Context) -> WKInterfaceVolumeControl {
        let control = WKInterfaceVolumeControl(origin: .local)
        control.setTintColor(UIColor(white: 0.49, alpha: 1))
        // Focus only lands once the control is in the hierarchy, which is after this returns.
        DispatchQueue.main.async { control.focus() }
        return control
    }

    func updateWKInterfaceObject(_ control: WKInterfaceVolumeControl, context: Context) {}
}
