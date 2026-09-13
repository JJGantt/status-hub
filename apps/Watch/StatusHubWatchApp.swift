import SwiftUI

@main
struct StatusHubWatchApp: App {
    @StateObject private var chat = Chat.shared
    @StateObject private var sessions = Sessions()
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
        .onAppear { follow() }
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
