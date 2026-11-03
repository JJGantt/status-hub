import SwiftUI
import UserNotifications
import WatchKit

@main
struct StatusHubWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var appDelegate
    @StateObject private var chat = Chat.shared
    @StateObject private var sessions = Sessions.shared
    @StateObject private var nutrition = Nutrition()
    @StateObject private var workout = Workout()
    @StateObject private var router = Router.shared

    init() {
        // Activate WatchConnectivity at launch so a token the phone already sent is picked up at once.
        PhoneLink.shared.start()
        Net.shared.start()
        LocationTrail.shared.start()  // the watch's own location history (docs/LOCATION.md)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                // The system clock sits over the top right of every watch app. This underscored
                // modifier is the only switch for it and it does work — docs/WATCH.md.
                ._statusBarHidden(true)
                .environmentObject(chat)
                .environmentObject(sessions)
                .environmentObject(nutrition)
                .environmentObject(workout)
                .environmentObject(router)
        }
    }
}

/// Notifications. The phone's pushes reach the watch too, and a session's finished reply carries the
/// SESSION_REPLY category: its Open button — the one double tap presses — opens that session here.
final class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    private static let sessionCategory = UNNotificationCategory(
        identifier: "SESSION_REPLY",
        actions: [UNNotificationAction(identifier: "SESSION_OPEN", title: "Open", options: [.foreground])],
        intentIdentifiers: [], options: [])

    /// A dated item's notification, forwarded from the phone. Registered HERE as well so its Done is
    /// answered on the wrist by the watch itself: completing the item (which scores it) rather than
    /// waking the phone to do it.
    private static let reminderCategory = UNNotificationCategory(
        identifier: "REMINDER",
        actions: [UNNotificationAction(identifier: "REMINDER_DONE", title: "Done", options: [])],
        intentIdentifiers: [], options: [])

    /// An orchestrator answer worth reading (docs/WATCH.md, "The answers inbox"). No buttons: tapping it
    /// opens home on the answer, and `customDismissAction` is what tells the app it was swiped away.
    /// Either one is reading it.
    private static let answerCategory = UNNotificationCategory(
        identifier: "VOICE_ANSWER", actions: [], intentIdentifiers: [], options: [.customDismissAction])

    /// A session blocked on a permission dialog (docs/PROMPTS.md). Registered here as on the phone, so
    /// the button is answered from the wrist without waking the phone.
    private static let promptCategory = UNNotificationCategory(
        identifier: "SESSION_PROMPT",
        actions: [UNNotificationAction(identifier: "PROMPT_ALLOW", title: "Approve", options: []),
                  UNNotificationAction(identifier: "PROMPT_DENY", title: "Deny", options: [.destructive])],
        intentIdentifiers: [], options: [])

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.sessionCategory,
                                                                       Self.reminderCategory,
                                                                       Self.answerCategory,
                                                                       Self.promptCategory])
    }

    // Shown even while the app is open, as on the phone.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // An answer landing while home is the page open is already in front of the user, or is what the next
        // raise shows: no buzz, wrist up or down (`Chat.homeOpen`). On any other page it is shown, and
        // once the watch is back on the clock the app is in the background, this is not asked, and the
        // system shows it.
        if notification.request.content.categoryIdentifier == "VOICE_ANSWER" {
            Task { @MainActor in
                let open = Chat.shared.homeOpen
                Hub.log("answer-push", ["shown": !open, "looking": Chat.shared.looking])
                completionHandler(open ? [] : [.banner, .sound, .list])
            }
            return
        }
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        // An answer's notification. Swiped away, it has been read. Tapped, home lands on the answer and
        // the read rule marks it there: marked now, an old answer would leave the thread before home
        // could land on it.
        if let id = info["voice_message_id"] as? String {
            let opened = response.actionIdentifier == UNNotificationDefaultActionIdentifier
            Task { @MainActor in
                if opened { Chat.shared.land(on: id) } else { Chat.shared.markRead(id) }
                completionHandler()
            }
            return
        }
        if let pid = info["prompt_id"] as? String,
           let decision = ["PROMPT_ALLOW": "allow", "PROMPT_DENY": "deny"][response.actionIdentifier] {
            Task { @MainActor in
                await Hub.decidePrompt(pid, decision)
                completionHandler()
            }
            return
        }
        if response.actionIdentifier == "REMINDER_DONE", let item = info["reminder_id"] as? String {
            Task { @MainActor in
                await Hub.complete(item)
                completionHandler()
            }
            return
        }
        let opens = response.actionIdentifier == "SESSION_OPEN"
            || response.actionIdentifier == UNNotificationDefaultActionIdentifier
        if opens, let id = info["session_id"] as? String {
            Task { @MainActor in await Sessions.shared.open(rowId: id) }
        }
        completionHandler()
    }
}

/// Six pages, left to right: the sessions, home — the conversation — the rings and today's log, the
/// workout block, the live mic (`LiveListenView`), and the gesture recorder (`GestureLabView`). Home is
/// where the app opens.
struct RootView: View {
    enum Page: String {
        case sessions, home, day, health, live, gesture, usage

        /// Nutrition and Workout land on the day page, which opens the list each names
        /// (`Router.dayList`): today's food log, or the exercise list. Day lands on the page itself.
        init(_ asked: WatchPage) {
            switch asked {
            case .sessions: self = .sessions
            case .nutrition, .workout, .day: self = .day
            }
        }
    }

    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var sessions: Sessions
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @EnvironmentObject private var router: Router
    @ObservedObject private var rewind = Rewind.shared
    @Environment(\.scenePhase) private var phase
    @State private var page = Page.home
    /// Black over everything from the moment the app leaves the screen until a launch has turned to its
    /// page. watchOS opens a backgrounded app by zooming in from its LAST picture of it, and a
    /// complication's URL only arrives once it is active: unveiled, a launcher shows the page the user left
    /// and then visibly moves to the one the user asked for.
    @State private var veiled = false
    /// The other pages have been loaded behind the first since the app last came to the front.
    @State private var warmed = false
    /// The on-screen page's own loads, which the others wait behind.
    @State private var loadingFirst: [Task<Void, Never>] = []

    var body: some View {
        // **A session opens INSIDE the sessions page** (its own NavigationStack, in SessionsView), so the
        // row of pages still swipes with one open, and it is still open when the user swipes back. The page
        // row takes the sideways swipe, so the system's swipe back never fires: the session's name closes
        // it, and so does a rightward drag on the session itself (`SessionView`).
        TabView(selection: $page) {
            SessionsView().tag(Page.sessions).environment(\.onScreen, page == .sessions)
            HomeView().tag(Page.home).environment(\.onScreen, page == .home)
            DayView().tag(Page.day)
            HealthView().tag(Page.health)
            LiveListenView().tag(Page.live)
            GestureLabView().tag(Page.gesture)
            UsageView().tag(Page.usage)
        }
        // No page dots: they are a strip of screen spent saying what a swipe already says.
        .tabViewStyle(.page(indexDisplayMode: .never))
        // **The command's state lives HERE, once, above everything, on every page**: the edge of the
        // glass (`CommandBorder`), which also holds the double-tap binding. Inside a page it would be
        // part of that page's content and slide with it on a swipe; over the row it stays put.
        .overlay { CommandBorder() }
        // Never takes a touch: if it ever outstays its beat, the page under it still works.
        .overlay { if veiled { Color.black.ignoresSafeArea().allowsHitTesting(false) } }
        // A rewind's words, over whatever page is showing: the grab came from a control, not a page.
        .sheet(item: $rewind.shown) { RewindSheet(shown: $0) }
        // Press and hold throws away the recording under way, on home and in a session alike. Only on
        // home does a hold with nothing recording START one (locked): in a session a follow-up is only
        // ever started by a tap, and the speaker glyph's hold is speak mode's toggle
        // (`Sessions.speakerPressed`). It sits on the whole row rather than a page so it holds still
        // across a swipe.
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.6).onEnded { _ in
            if sessions.speakerPressed { sessions.toggleSpeakMode(); return }
            guard page == .home || page == .sessions else { return }
            CommandBorder.hold(chat: chat, sessions: sessions, starts: page == .home)
        })
        .onOpenURL { url in
            guard url.scheme == "statushub" else { return }
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            switch url.host {
            case "record":
                // `?flow=silence|locked|quick`: which complication it was. None is the standard flow.
                let flow = query.first { $0.name == "flow" }?.value.flatMap(Capture.Flow.init) ?? .standard
                chat.requestRecording(flow)
            case "open":
                // `?page=day|sessions`: a complication that only travels, as a page's control does.
                if let p = query.first(where: { $0.name == "page" })?.value.flatMap({ WatchPage(rawValue: $0) }) {
                    router.open(p)
                }
            default: break
            }
        }
        // A record request (complication or Hub control) always lands on home, whichever page was
        // showing. A session left open on the sessions page stays open: the command goes to the hub
        // because home is showing (`Sessions.target`).
        .onChange(of: chat.recordRequested) { _, asked in
            if asked { jump(to: .home) }
        }
        // An answer's notification, opened: home, which lands on the answer (`Chat.landOn`).
        .onChange(of: chat.landings) { _, _ in jump(to: .home) }
        // A control that names a page (Control Center, the Action button, the Smart Stack, the Day and
        // Sessions complications) turns to it. Sessions always lands on the LIST, closing any session
        // left open there; the other pages leave it open for when the user swipes back.
        .onChange(of: router.asked, initial: true) { _, asked in
            guard let asked else { return }
            if asked == .sessions { sessions.path = [] }
            jump(to: Page(asked))
            router.asked = nil
        }
        // A session opened from its notification lands on the sessions page, even on a cold launch.
        .onChange(of: sessions.path) { _, path in if !path.isEmpty { jump(to: .sessions) } }
        .onAppear {
            if !sessions.path.isEmpty { page = .sessions }
            sessions.speakModeChanged = { follow() }
            follow()
            Task { await WatchSettings.refresh() }
            Hub.flushLog()
            #if targetEnvironment(simulator)
            // `-opensession <row id>` at launch: open a session as its notification would, so its page
            // can be watched in a simulator.
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-opensession"), i + 1 < args.count {
                Task { await sessions.open(rowId: args[i + 1]) }
            }
            // `-page <sessions|home|day|health|live|gesture>`: land on a page, so each can be screenshotted.
            if let i = args.firstIndex(of: "-page"), i + 1 < args.count, let p = Page(rawValue: args[i + 1]) {
                page = p
            }
            // `-record <seconds>`: a locked command recorded for that long, then stopped, so the stream to
            // the hub (LiveStream) can be watched end to end. 0 records until the app is killed.
            if let i = args.firstIndex(of: "-record"), i + 1 < args.count, let secs = Double(args[i + 1]) {
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    chat.startRecording(flow: .locked)
                    guard secs > 0 else { return }
                    try? await Task.sleep(for: .seconds(secs))
                    chat.stopRecording()
                }
            }
            #endif
        }
        .onChange(of: page) { _, _ in follow() }
        .onChange(of: phase) { _, now in
            Hub.log("phase", ["to": "\(now)", "veiled": veiled])
            if now == .background { veiled = true }
            if now == .active { LocationTrail.shared.fix() }  // one point per use (docs/LOCATION.md)
            // Lifted a beat after becoming active, the same beat `follow()` waits: a launcher's URL
            // turns the page in this pass, so the first thing shown is already its page. The deadline
            // behind it is because a veil that stays up is a black watch: it is the one way this
            // mechanism fails, and `veil-stuck` in the log says it happened.
            if now == .active && veiled {
                Task { await Task.yield(); veiled = false }
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    if veiled && phase == .active { Hub.log("veil-stuck"); veiled = false }
                }
            }
            if now == .active { Speaker.shared.checkOnWake(); Rewind.shared.check(); Capture.shared.resumeDraft(how: "active") }
            follow()
            // Coming to the front, not every page swipe: the watch's settings live on the hub.
            if now == .active { Task { await WatchSettings.refresh() }; Hub.flushLog() }
        }
    }

    /// A launcher, a control or a notification CUTS to its page rather than scrolling across the ones
    /// between, so it reads as opening there.
    private func jump(to p: Page) {
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { page = p }
    }

    /// **The page on screen loads first, then every other page loads behind it**, so a swipe lands on
    /// data already there. Only the page on screen holds its stream open; the others are a one-shot
    /// fetch each time the app comes to the front, and the stream's own reload catches them up when
    /// the user swipes to them.
    private func follow() {
        let live = phase == .active
        sessions.onPage = page == .sessions
        var first: [Task<Void, Never>] = []
        // Speak mode keeps the sessions stream on every page and with the wrist down (the app is held
        // running by StayAwake), since a reply it does not hear is a reply it cannot speak.
        if (live && page == .sessions) || sessions.speakMode { first.append(sessions.activate()) } else { sessions.deactivate() }
        if live && page == .home { first.append(chat.activate()) } else { chat.deactivate() }
        // The day page draws food and training live, so it follows both or neither. The health page
        // is weeks, loaded when it appears (`loadHistory`), and needs neither stream.
        if live && page == .day { first.append(nutrition.activate()); first.append(workout.activate()) }
        else { nutrition.deactivate(); workout.deactivate() }
        if live && page == .usage { first.append(ClaudeUsage.shared.activate()) } else { ClaudeUsage.shared.deactivate() }
        if !live { warmed = false; return }
        loadingFirst = first
        guard !warmed else { return }
        warmed = true
        Task {
            // A launch from a complication or a notification turns to its page in the same pass as
            // this first call, so the page to put first is read a beat later, not now.
            await Task.yield()
            let on = page
            for t in loadingFirst { await t.value }
            if on == .health { await nutrition.loadHistory() }
            Hub.log("warm", ["first": on.rawValue])
            // Everything the other pages draw at rest, side by side. Not the drill-ins (every week of
            // history, the weight page): those load when opened.
            async let s: Void = on == .sessions ? () : sessions.load()
            async let c: Void = on == .home ? () : chat.load()
            async let n: Void = on == .day ? () : nutrition.load()
            async let w: Void = on == .day ? () : workout.load()
            async let h: Void = on == .health ? () : nutrition.loadHistory()
            async let u: Void = on == .usage ? () : ClaudeUsage.shared.load()
            _ = await (s, c, n, w, h, u)
        }
    }
}
