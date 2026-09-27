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

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.sessionCategory,
                                                                       Self.reminderCategory])
    }

    // Shown even while the app is open, as on the phone.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
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

/// Five pages, left to right: settings, the sessions, home — the conversation — the rings and today's log, and
/// the workout block. Home is where the app opens.
struct RootView: View {
    enum Page: String {
        case settings, sessions, home, day, health

        /// Nutrition and Workout land on the day page, which opens the list each names
        /// (`Router.dayList`): today's food log, or the exercise list.
        init(_ asked: WatchPage) {
            switch asked {
            case .sessions: self = .sessions
            case .nutrition, .workout: self = .day
            }
        }
    }

    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var sessions: Sessions
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @EnvironmentObject private var router: Router
    @Environment(\.scenePhase) private var phase
    @State private var page = Page.home

    var body: some View {
        // A session opens on top of the whole row of pages, not inside the sessions page: the row takes
        // sideways swipes, so a session pushed inside one of its pages never got the watch's own swipe
        // back — only a back button and a title bar that cost the top of the screen.
        NavigationStack(path: $sessions.path) {
            TabView(selection: $page) {
                SettingsView().tag(Page.settings)
                SessionsView().tag(Page.sessions).environment(\.onScreen, page == .sessions)
                HomeView().tag(Page.home).environment(\.onScreen, page == .home)
                DayView().tag(Page.day)
                HealthView().tag(Page.health)
            }
            // No page dots: they are a strip of screen spent saying what a swipe already says.
            .tabViewStyle(.page(indexDisplayMode: .never))
            .navigationDestination(for: String.self) { key in SessionView(key: key) }
        }
        // **The command's state lives HERE, once, above everything, on every page**: the edge of the
        // glass (`CommandBorder`), which also holds the double-tap binding. Inside a page it would be
        // part of that page's content and slide with it on a swipe; over the stack it stays put.
        .overlay { CommandBorder() }
        // Press and hold anywhere throws away what is under way. It is on the whole stack rather than
        // a page for the same reason, and does nothing when there is nothing to throw away.
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.6).onEnded { _ in
            CommandBorder.cancel(chat: chat, sessions: sessions)
        })
        .onOpenURL { url in
            guard url.scheme == "statushub", url.host == "record" else { return }
            chat.requestRecording()
        }
        // A record request (complication or Hub control) always lands on home, whichever page was
        // showing — and a command, not a follow-up, so an open session closes.
        // **Every control closes an open session.** A session is pushed over the whole row of pages, so
        // turning the page underneath it changes nothing he can see: the session stays on top.
        .onChange(of: chat.recordRequested) { _, asked in
            if asked { sessions.path = []; page = .home }
        }
        // A control that names a page (Control Center, the Action button, the Smart Stack) turns to it.
        .onChange(of: router.asked, initial: true) { _, asked in
            guard let asked else { return }
            sessions.path = []
            page = Page(asked)
            router.asked = nil
        }
        // A session opened from its notification lands on the sessions page, even on a cold launch.
        .onChange(of: sessions.path) { _, path in if !path.isEmpty { page = .sessions } }
        .onAppear {
            if !sessions.path.isEmpty { page = .sessions }
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
            // `-page <settings|sessions|home|day|health>`: land on a page, so each can be screenshotted.
            if let i = args.firstIndex(of: "-page"), i + 1 < args.count, let p = Page(rawValue: args[i + 1]) {
                page = p
            }
            #endif
        }
        .onChange(of: page) { _, _ in follow() }
        .onChange(of: phase) { _, now in
            follow()
            // Coming to the front, not every page swipe: the watch's settings live on the hub.
            if now == .active { Task { await WatchSettings.refresh() }; Hub.flushLog() }
        }
    }

    /// A page loads and holds its stream open only while it is the one on screen.
    private func follow() {
        let live = phase == .active
        if live && page == .sessions { sessions.activate() } else { sessions.deactivate() }
        if live && page == .home { chat.activate() } else { chat.deactivate() }
        // The day page draws food and training live, so it follows both or neither. The health page
        // is weeks, loaded when it appears (`loadHistory`), and needs neither stream.
        if live && page == .day { nutrition.activate(); workout.activate() }
        else { nutrition.deactivate(); workout.deactivate() }
    }
}
