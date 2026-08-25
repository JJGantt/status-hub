import WidgetKit
import SwiftUI
import AppIntents

// Lock Screen / Control Center control (iOS 18+): a "Record" button that opens Status Hub straight into a
// voice command. Uses the statushub://record URL scheme the app already handles (fires the voice FAB), so
// the control needs none of the app's code — it just opens the app to record.
struct RecordControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.record") {
            ControlWidgetButton(action: HubVoiceIntent()) {
                Label("Record", systemImage: "mic.fill")
            }
        }
        .displayName("Record")
    }
}

// One widgetkit-extension can host both ControlWidgets and ordinary Widgets, so every widget ships
// here rather than in a target of its own (see RingsWidget.swift for why that matters: a new target
// means a new bundle id, which needs a provisioning profile this account can't currently issue).
@main
struct StatusHubControlsBundle: WidgetBundle {
    var body: some Widget {
        RecordControl()
        RingsWidget()
        TodoWidget()
        ReposWidget()
    }
}
