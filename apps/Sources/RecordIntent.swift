#if os(iOS)
import AppIntents

// Exposes the app's voice command as a Siri / Spotlight App Shortcut. The intent itself (HubVoiceIntent)
// lives in Shared/ and is also used by the Lock Screen / Control Center control.
struct StatusHubAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: HubVoiceIntent(),
            phrases: [
                "Record with \(.applicationName)",
                "\(.applicationName) voice command",
                "New \(.applicationName) command",
            ],
            shortTitle: "Record",
            systemImageName: "mic.fill"
        )
    }
}
#endif
