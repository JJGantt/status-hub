import AppIntents

// The widget's "open this one" option. Same shape as HubVoiceIntent, and shared for the same reason:
// `openAppWhenRun` makes the system run perform() in the APP process, where HUB_APP is defined and the
// app-only bridge exists, while the extension still gets to reference the type.
//
// A Button carrying this rather than a SwiftUI `Link`: Link renders as a missing-content placeholder
// under ImageRenderer, so the layout could not be checked with tools/render-todo.swift — and this
// codebase already proves the intent route with the Record control.
//
// Not #if os(iOS) like HubVoiceIntent: the macOS app doesn't compile this file at all (project.yml
// pulls only Shared/Auth.swift into StatusHubMac), and leaving it unguarded lets tools/render-todo
// build the row on the Mac to check the layout.
struct OpenTodoItem: AppIntent {
    static var title: LocalizedStringResource = "Open item in Status Hub"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = true

    @Parameter(title: "id") var id: String
    init() {}
    init(id: String) { self.id = id }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if HUB_APP
        ItemLaunch.shared.request(id)
        #endif
        return .result()
    }
}
