import SwiftUI
import WidgetKit

@main
struct StatusHubWatchWidgets: WidgetBundle {
    var body: some Widget {
        RecordComplication()
        RecordSilenceComplication()
        RecordLockedComplication()
        RecordQuickComplication()
        DayComplication()
        SessionsComplication()
        if #available(watchOS 26.0, *) {
            RecordControl()
            ListenControl()
            BufferControl()
            RewindControl()
            RewindAskControl()
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

/// Rewind on and off (`Watch/Rewind.swift`). Its own control rather than a mode of Listen, because
/// rewind uploads nothing until a grab and the listener uploads every utterance.
@available(watchOS 26.0, *)
struct BufferControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.buffer") {
            ControlWidgetButton(action: BufferIntent()) {
                Label("Buffer", systemImage: "record.circle")
            }
        }
        .displayName("Buffer")
    }
}

/// Grab what rewind holds and show the words.
@available(watchOS 26.0, *)
struct RewindControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.rewind") {
            ControlWidgetButton(action: RewindIntent()) {
                Label("Rewind", systemImage: "gobackward")
            }
        }
        .displayName("Rewind")
    }
}

/// Grab, and record instructions for it straight away.
@available(watchOS 26.0, *)
struct RewindAskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredgantt.statushub.watch.rewindask") {
            ControlWidgetButton(action: RewindAskIntent()) {
                Label("Rewind Ask", systemImage: "gobackward.minus")
            }
        }
        .displayName("Rewind Ask")
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
        StaticConfiguration(kind: "RecordComplication", provider: Provider()) { entry in
            RecordFace(entry: entry, name: "Hub")
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
        StaticConfiguration(kind: "RecordSilenceComplication", provider: Provider()) { entry in
            RecordFace(entry: entry, name: "Silence")
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
        StaticConfiguration(kind: "RecordLockedComplication", provider: Provider()) { entry in
            RecordFace(entry: entry, name: "Locked")
                .widgetURL(URL(string: "statushub://record?flow=locked"))
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Hub Locked")
        .description("Hub Locked")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// The fast path, for a one-sentence command: straight into a recording that sends at his silence or
/// at a press, AND sends itself a fixed number of seconds after the microphone opens however it is
/// going (`Capture.Flow.quick`; the seconds are `watch_quick_s` in the hub's Settings). No lock step.
struct RecordQuickComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordQuickComplication", provider: Provider()) { entry in
            RecordFace(entry: entry, name: "Quick")
                .widgetURL(URL(string: "statushub://record?flow=quick"))
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Hub Quick")
        .description("Hub Quick")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Opens the app on the day page — food and training — with nothing opened on it. Invisible, like the
/// record ones.
struct DayComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DayComplication", provider: Provider()) { entry in
            RecordFace(entry: entry, name: "Day")
                .widgetURL(URL(string: "statushub://open?page=day"))
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Hub Day")
        .description("Hub Day")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Opens the app on the sessions LIST, always: a session left open there is closed. Invisible, like
/// the record ones.
struct SessionsComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SessionsComplication", provider: Provider()) { entry in
            RecordFace(entry: entry, name: "Sessions")
                .widgetURL(URL(string: "statushub://open?page=sessions"))
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Hub Sessions")
        .description("Hub Sessions")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

/// Clear, but filling the slot, so the whole complication stays the tap target `widgetURL` opens.
/// **Except in the face editor**, which shows each complication's drawing and not its
/// `configurationDisplayName`: drawn clear there, all six are identical blank tiles. A preview
/// (`context.isPreview`, what the editor's gallery asks for) writes the name; the face never does.
private struct RecordFace: View {
    let entry: Entry
    let name: String
    var body: some View {
        ZStack {
            Color.clear
            if entry.preview {
                Text(name)
                    .font(.system(size: 11, weight: .semibold))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct Provider: TimelineProvider {
    // Blank, never the name: the face draws a placeholder REDACTED until the timeline arrives, and
    // redacted text is a grey bar on the face. The editor's gallery names come from the snapshot.
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), preview: false) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), preview: context.isPreview))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: Date(), preview: false)], policy: .never))
    }
}

private struct Entry: TimelineEntry { let date: Date; let preview: Bool }
