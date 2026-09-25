import SwiftUI
import WidgetKit

@main
struct StatusHubWatchWidgets: WidgetBundle {
    var body: some Widget {
        RecordComplication()
        if #available(watchOS 26.0, *) {
            RecordControl()
            ListenControl()
            SpeakControl()
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

/// Spoken session replies, as a real toggle: filled while on. What it shows is read from `SharedState`,
/// which the app keeps in step with the hub.
@available(watchOS 26.0, *)
struct SpeakControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.speak", provider: SpeechValue()) { on in
            ControlWidgetToggle(isOn: on, action: SetSpeechIntent()) {
                Label("Speak", systemImage: "speaker.wave.2.fill")
            }
        }
        .displayName("Speak")
    }
}

@available(watchOS 26.0, *)
struct SpeechValue: ControlValueProvider {
    var previewValue: Bool { false }
    func currentValue() async throws -> Bool { SharedState.speech }
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
/// app answers by starting to record.
struct RecordComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordComplication", provider: Provider()) { _ in
            RecordFace()
                .widgetURL(URL(string: "statushub://record"))
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Status Hub")
        .description("Hub")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

private struct RecordFace: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        ZStack {
            if family == .accessoryCircular { AccessoryWidgetBackground() }
            Image(systemName: "mic.fill")
                .font(.system(size: 18, weight: .semibold))
                .widgetAccentable()
        }
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
