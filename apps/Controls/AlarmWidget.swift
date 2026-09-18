#if canImport(AlarmKit)
import ActivityKit
import AlarmKit
import SwiftUI
import WidgetKit

// The alarm's face. AlarmKit does not draw its own: the alert, the Lock Screen banner and the Dynamic
// Island are a LIVE ACTIVITY, so the framework requires a widget extension declaring an
// ActivityConfiguration over AlarmAttributes<Metadata>. Without this the alarm has nowhere to appear
// and scheduling is pointless — which is why it is here and not a later polish pass.
//
// Everything shown is the ITEM's own: `presentation.alert.title` is the title the app put on the
// alarm, which is the title of the thing that is due. Nothing is written here.

@available(iOS 26.0, *)
struct HubAlarmWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlarmAttributes<HubAlarmMetadata>.self) { context in
            HStack(spacing: 10) {
                Image(systemName: "alarm.fill")
                    .font(.title3)
                    .foregroundStyle(context.attributes.tintColor)
                Text(context.attributes.presentation.alert.title)
                    .font(.headline)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "alarm.fill").foregroundStyle(context.attributes.tintColor)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.presentation.alert.title)
                        .font(.headline)
                        .lineLimit(2)
                }
            } compactLeading: {
                Image(systemName: "alarm.fill").foregroundStyle(context.attributes.tintColor)
            } compactTrailing: {
                EmptyView()
            } minimal: {
                Image(systemName: "alarm.fill").foregroundStyle(context.attributes.tintColor)
            }
        }
    }
}
#endif
