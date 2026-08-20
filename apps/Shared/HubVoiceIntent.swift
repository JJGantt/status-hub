#if os(iOS)
import AppIntents

// The intent behind the Lock Screen / Control Center control (and the Siri/Spotlight shortcut): opens the
// app (openAppWhenRun) and, in the app process, fires the voice FAB via RecordLaunch. Shared by the app and
// the control extension. The RecordLaunch call is app-only (the extension can't link WebKit), so it's gated
// on HUB_APP — but with openAppWhenRun the system runs perform() in the APP, where HUB_APP is defined.
struct HubVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Status Hub Voice Command"
    static var description = IntentDescription("Open Status Hub and start a voice command.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        #if HUB_APP
        RecordLaunch.shared.request()
        #endif
        return .result()
    }
}
#endif
