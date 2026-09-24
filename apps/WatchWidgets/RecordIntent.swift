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

/// What the Listen control opens: the one target there is, as with Record.
enum ListenTarget: String, AppEnum {
    case listener

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [ListenTarget: DisplayRepresentation] = [.listener: "Listen"]
}

/// Turns always-on listening on or off: the Listen control's action. The watch shows which by the
/// edge of the glass (blue while listening), since a control cannot read the app's state without an
/// App Group, which this account cannot enable. Compiled into both the extension and the app; the
/// system launches the app and runs `perform()` there, where WATCH_APP is defined.
struct ListenIntent: OpenIntent {
    static var title: LocalizedStringResource = "Listen"

    @Parameter(title: "Target") var target: ListenTarget

    init() {
        target = .listener
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Chat.shared.toggleListening()
        #endif
        return .result()
    }
}

/// What the Speak control opens.
enum SpeakTarget: String, AppEnum {
    case replies

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [SpeakTarget: DisplayRepresentation] = [.replies: "Speak"]
}

/// Turns spoken session replies on or off — the Speak control's action. The setting lives on the hub
/// (`session_speech`), so the phone's Settings shows and changes the same switch.
struct SpeakIntent: OpenIntent {
    static var title: LocalizedStringResource = "Speak"

    @Parameter(title: "Target") var target: SpeakTarget

    init() {
        target = .replies
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Speaker.toggle()
        #endif
        return .result()
    }
}

/// Which page of the app a control opens. `record` is the microphone's: it lands on home and starts
/// recording. The rest are places — a control per page, so Control Center (and the Action button, and
/// the Smart Stack) can put him where he was going rather than in the app to then swipe.
enum WatchPage: String, AppEnum {
    case sessions, nutrition, workout

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub page"
    static var caseDisplayRepresentations: [WatchPage: DisplayRepresentation] = [
        .sessions: "Sessions", .nutrition: "Nutrition", .workout: "Workout",
    ]
}

/// Opens the watch app on one page. Compiled into both the widget extension and the app; the system
/// launches the app and runs `perform()` there, where WATCH_APP is defined.
struct OpenPageIntent: OpenIntent {
    static var title: LocalizedStringResource = "Open"

    @Parameter(title: "Page") var target: WatchPage

    init() { target = .sessions }
    init(_ page: WatchPage) { target = page }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Router.shared.open(target)
        #endif
        return .result()
    }
}
