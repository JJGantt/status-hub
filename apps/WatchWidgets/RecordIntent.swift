import AppIntents

/// What the Record control opens. A control that launches its app takes an `OpenIntent`, and an
/// `OpenIntent` opens a target, so this is the one there is.
enum RecordTarget: String, AppEnum {
    case prompt

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [RecordTarget: DisplayRepresentation] = [.prompt: "Hub"]
}

/// Opens the watch app straight into recording: the Record control's action, and so the Action
/// button's on an Ultra once the control is assigned to it. Compiled into both the widget extension
/// and the app; the system launches the app and runs perform() there, where WATCH_APP is defined.
struct RecordIntent: OpenIntent {
    static var title: LocalizedStringResource = "Hub"

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

/// What the Buffer control opens. Its own type, not shared with Rewind: the App Intents export
/// refuses two `OpenIntent`s with the same target type, and the archive fails on it.
enum BufferTarget: String, AppEnum {
    case buffer

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [BufferTarget: DisplayRepresentation] = [.buffer: "Buffer"]
}

/// What the Rewind control opens.
enum RewindTarget: String, AppEnum {
    case rewind

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [RewindTarget: DisplayRepresentation] = [.rewind: "Rewind"]
}

/// What the Rewind Ask control opens.
enum RewindAskTarget: String, AppEnum {
    case rewindAsk

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub"
    static var caseDisplayRepresentations: [RewindAskTarget: DisplayRepresentation] = [.rewindAsk: "Rewind Ask"]
}

/// Engages or drops rewind (`Watch/Rewind.swift`): the Buffer control's action. Like Listen, it has to
/// open the app, because the microphone can only start there; it then carries on with the wrist down.
struct BufferIntent: OpenIntent {
    static var title: LocalizedStringResource = "Buffer"

    @Parameter(title: "Target") var target: BufferTarget

    init() {
        target = .buffer
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Chat.shared.toggleRewind()
        #endif
        return .result()
    }
}

/// Sends what rewind holds to be transcribed and shows the words: the Rewind control's action.
struct RewindIntent: OpenIntent {
    static var title: LocalizedStringResource = "Rewind"

    @Parameter(title: "Target") var target: RewindTarget

    init() {
        target = .rewind
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Rewind.shared.grab()
        #endif
        return .result()
    }
}

/// The one-step rewind: grabs, and starts recording the user's instructions for the grab at once — the same as
/// a Rewind followed by a tap on its words.
struct RewindAskIntent: OpenIntent {
    static var title: LocalizedStringResource = "Rewind Ask"

    @Parameter(title: "Target") var target: RewindAskTarget

    init() {
        target = .rewindAsk
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if WATCH_APP
        Rewind.shared.grab(ask: true)
        #endif
        return .result()
    }
}

/// Which page of the app a control opens. `record` is the microphone's: it lands on home and starts
/// recording. The rest are places — a control per page, so Control Center (and the Action button, and
/// the Smart Stack) can put the user where the user was going rather than in the app to then swipe.
enum WatchPage: String, AppEnum {
    case sessions, nutrition, workout, day

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status Hub page"
    static var caseDisplayRepresentations: [WatchPage: DisplayRepresentation] = [
        .sessions: "Sessions", .nutrition: "Nutrition", .workout: "Workout", .day: "Day",
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
