import SwiftUI
import WidgetKit

@main
struct StatusHubWatchWidgets: WidgetBundle {
    var body: some Widget {
        RecordComplication()
    }
}

/// A watch-face button that opens the app straight into dictation: `statushub://record`, which the
/// app answers by raising the text-input sheet itself.
struct RecordComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RecordComplication", provider: Provider()) { _ in
            RecordFace()
                .widgetURL(URL(string: "statushub://record"))
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Status Hub")
        .description("Record")
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
