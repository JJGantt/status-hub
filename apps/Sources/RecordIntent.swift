#if os(iOS)
import AppIntents

// The app ships its OWN "Record" shortcut (App Intent) — so it appears automatically in Shortcuts,
// Spotlight, and Siri with nothing to assemble, and can be pinned to the home screen for a one-tap voice
// command. Running it opens the app and fires the same voice FAB (via RecordLaunch) → straight into
// listening, real audio through the normal pipeline.
struct StartVoiceCommandIntent: AppIntent {
    static var title: LocalizedStringResource = "Record Voice Command"
    static var description = IntentDescription("Open Status Hub and start recording a voice command.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        RecordLaunch.shared.request()
        return .result()
    }
}

struct StatusHubAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartVoiceCommandIntent(),
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
