import SwiftUI
import WidgetKit

@main
struct StatusHubWatchWidgets: WidgetBundle {
    var body: some Widget {
        RecordComplication()
        RecordSilenceComplication()
        RecordLockedComplication()
        if #available(watchOS 26.0, *) {
            RecordControl()
            ListenControl()
            SessionsControl()
            NutritionControl()
            WorkoutControl()
        }
    }
}

/// The Record control (watchOS 26): Control Center, the Smart Stack, and on an Ultra the Action
/// button. It opens the app straight into recording through `RecordIntent`.
@available(watchOS 26.0, *)
struct RecordControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.record") {
            ControlWidgetButton(action: RecordIntent()) {
                Label("Hub", systemImage: "mic.fill")
            }
        }
        .displayName("Hub")
    }
}

/// Always-on listening, on and off: the job the bar's middle button did before the bar went. Spelled
/// out in full like Record — Control Center reads the kind, title and symbol before the extension runs.
@available(watchOS 26.0, *)
struct ListenControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.listen") {
            ControlWidgetButton(action: ListenIntent()) {
                Label("Listen", systemImage: "waveform")
            }
        }
        .displayName("Listen")
    }
}

/// A control per page: Control Center, the Smart Stack and an Ultra's Action button can each open the
/// app where he was going. The Record control is the odd one out — it opens home AND starts recording;
/// these only travel. One type each, because a `ControlWidget` is built by the system and so cannot
/// carry stored properties of its own.
///
/// **Everything the system reads off a control is written here as a literal** — the `kind`, the title
/// and the symbol. A control is described to Control Center before the extension runs, so a value the
/// declaration computes is a value the gallery has to render without: built by concatenation, not one
/// of these kinds appears in the extension binary at all (`strings` on it finds only the Record kind,
/// which is spelled out). Say each one in full, however much it repeats.
@available(watchOS 26.0, *)
struct SessionsControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.sessions") {
            ControlWidgetButton(action: OpenPageIntent(.sessions)) {
                Label("Sessions", systemImage: "terminal.fill")
            }
        }
        .displayName("Sessions")
    }
}

@available(watchOS 26.0, *)
struct NutritionControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.nutrition") {
            ControlWidgetButton(action: OpenPageIntent(.nutrition)) {
                Label("Nutrition", systemImage: "circle.dashed")
            }
        }
        .displayName("Nutrition")
    }
}

@available(watchOS 26.0, *)
struct WorkoutControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.workout") {
            ControlWidgetButton(action: OpenPageIntent(.workout)) {
                Label("Workout", systemImage: "figure.strengthtraining.traditional")
            }
        }
        .displayName("Workout")
    }
}

/// A watch-face button that opens the app straight into recording: `statushub://record`, which the
/// app answers by starting to record. It draws nothing: the slot is an invisible tap target that only
/// its owner knows is there, so the face shows no trace of it.
struct RecordComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordComplication", provider: Provider()) { _ in
            RecordFace()
                .widgetURL(URL(string: "statushub://record"))
                // No plate behind it either: the slot is empty on the face.
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Status Hub")
        .description("Hub")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Straight into a recording that ends at his silence, where a press SENDS rather than locking it
/// (`Capture.Flow.silence`). Invisible, like the standard one.
struct RecordSilenceComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordSilenceComplication", provider: Provider()) { _ in
            RecordFace()
                .widgetURL(URL(string: "statushub://record?flow=silence"))
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Hub Silence")
        .description("Hub Silence")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Straight into a LOCKED recording — the red edge, no silence ends it — where a press sends
/// (`Capture.Flow.locked`). Invisible, like the standard one.
struct RecordLockedComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordLockedComplication", provider: Provider()) { _ in
            RecordFace()
                .widgetURL(URL(string: "statushub://record?flow=locked"))
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Hub Locked")
        .description("Hub Locked")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Clear, but filling the slot, so the whole complication stays the tap target `widgetURL` opens.
private struct RecordFace: View {
    var body: some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: Date())], policy: .never))
    }
}

private struct Entry: TimelineEntry { let date: Date }
