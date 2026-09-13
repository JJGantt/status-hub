import AppIntents

/// What the Record control opens. A control that launches its app takes an `OpenIntent`, and an
/// `OpenIntent` opens a target, so this is the one there is.
enum RecordTarget: String, AppEnum {
    case prompt

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [RecordTarget: DisplayRepresentation] = [.prompt: "Record"]
}

/// Opens the watch app straight into recording: the Record control's action, and so the Action
/// button's on an Ultra once the control is assigned to it. Compiled into both the widget extension
/// and the app; the system launches the app and runs perform() there, where WATCH_APP is defined.
struct RecordIntent: OpenIntent {
    static var title: LocalizedStringResource = "Record"

    @Parameter(title: "Target") var target: RecordTarget

    init() {
        target = .prompt
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Chat.shared.requestRecording()
        #endif
        return .result()
    }
}
