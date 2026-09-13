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

/// Four pages, left to right: the sessions, the prompt, the rings and today's log, and the workout
/// block. The prompt is where the app opens.
struct RootView: View {
    enum Page { case sessions, chat, nutrition, workout }

    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var sessions: Sessions
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @Environment(\.scenePhase) private var phase
    @State private var page = Page.chat

    var body: some View {
        TabView(selection: $page) {
            SessionsView().tag(Page.sessions)
            ChatView().tag(Page.chat)
            NutritionView().tag(Page.nutrition)
            WorkoutView().tag(Page.workout)
        }
        .tabViewStyle(.page)
        .onOpenURL { url in
            guard url.scheme == "statushub", url.host == "record" else { return }
            chat.requestRecording()
        }
        // A record request (complication or Record control) always lands on the prompt, whichever
        // page was showing.
        .onChange(of: chat.recordRequested) { _, asked in if asked { page = .chat } }
        // A session opened from its notification lands on the sessions page, even on a cold launch.
        .onChange(of: sessions.path) { _, path in if !path.isEmpty { page = .sessions } }
        .onAppear {
            if !sessions.path.isEmpty { page = .sessions }
            follow()
        }
        .onChange(of: page) { _, _ in follow() }
        .onChange(of: phase) { _, _ in follow() }
    }

    /// A page loads and holds its stream open only while it is the one on screen.
    private func follow() {
        let live = phase == .active
        if live && page == .sessions { sessions.activate() } else { sessions.deactivate() }
        if live && page == .chat { chat.activate() } else { chat.deactivate() }
        if live && page == .nutrition { nutrition.activate() } else { nutrition.deactivate() }
        if live && page == .workout { workout.activate() } else { workout.deactivate() }
    }
}
