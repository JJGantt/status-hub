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

    init() {
        // Activate WatchConnectivity at launch so a token the phone already sent is picked up at once.
        PhoneLink.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(chat)
                .environmentObject(sessions)
                .environmentObject(nutrition)
                .environmentObject(workout)
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

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.sessionCategory])
    }

    // Shown even while the app is open, as on the phone.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let opens = response.actionIdentifier == "SESSION_OPEN"
            || response.actionIdentifier == UNNotificationDefaultActionIdentifier
        if opens, let id = response.notification.request.content.userInfo["session_id"] as? String {
            Task { @MainActor in await Sessions.shared.open(rowId: id) }
        }
        completionHandler()
    }
}

/// Four pages, left to right: the sessions, home — the conversation — the rings and today's log, and
/// the workout block. Home is where the app opens.
struct RootView: View {
    enum Page { case sessions, home, nutrition, workout }

    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var sessions: Sessions
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @Environment(\.scenePhase) private var phase
    @State private var page = Page.home

    var body: some View {
        // A session opens on top of the whole row of pages, not inside the sessions page: the row takes
        // sideways swipes, so a session pushed inside one of its pages never got the watch's own swipe
        // back — only a back button and a title bar that cost the top of the screen.
        NavigationStack(path: $sessions.path) {
            TabView(selection: $page) {
                SessionsView().tag(Page.sessions).environment(\.onScreen, page == .sessions)
                HomeView().tag(Page.home).environment(\.onScreen, page == .home)
                NutritionView().tag(Page.nutrition)
                WorkoutView().tag(Page.workout)
            }
            // No page dots: they are a strip of screen spent saying what a swipe already says.
            .tabViewStyle(.page(indexDisplayMode: .never))
            .navigationDestination(for: String.self) { key in SessionView(key: key) }
        }
        .onOpenURL { url in
            guard url.scheme == "statushub", url.host == "record" else { return }
            chat.requestRecording()
        }
        // A record request (complication or Record control) always lands on home, whichever page was
        // showing.
        .onChange(of: chat.recordRequested) { _, asked in if asked { page = .home } }
        // A session opened from its notification lands on the sessions page, even on a cold launch.
        .onChange(of: sessions.path) { _, path in if !path.isEmpty { page = .sessions } }
        .onAppear {
            if !sessions.path.isEmpty { page = .sessions }
            follow()
            #if targetEnvironment(simulator)
            // `-opensession <row id>` at launch: open a session as its notification would, so its page
            // can be watched in a simulator.
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-opensession"), i + 1 < args.count {
                Task { await sessions.open(rowId: args[i + 1]) }
            }
            #endif
        }
        .onChange(of: page) { _, _ in follow() }
        .onChange(of: phase) { _, _ in follow() }
    }

    /// A page loads and holds its stream open only while it is the one on screen.
    private func follow() {
        let live = phase == .active
        if live && page == .sessions { sessions.activate() } else { sessions.deactivate() }
        if live && page == .home { chat.activate() } else { chat.deactivate() }
        if live && page == .nutrition { nutrition.activate() } else { nutrition.deactivate() }
        if live && page == .workout { workout.activate() } else { workout.deactivate() }
    }
}
