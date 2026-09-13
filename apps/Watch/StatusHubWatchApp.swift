import SwiftUI

@main
struct StatusHubWatchApp: App {
    @StateObject private var chat = Chat()
    @StateObject private var nutrition = Nutrition()
    @StateObject private var workout = Workout()

    init() {
        // Activate WatchConnectivity at launch so a token the phone already sent is picked up at once.
        PhoneLink.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(chat).environmentObject(nutrition).environmentObject(workout)
        }
    }
}

/// Three pages, left to right: the prompt, the rings and today's log, and the workout block.
struct RootView: View {
    enum Page { case chat, nutrition, workout }

    @EnvironmentObject private var chat: Chat
    @EnvironmentObject private var nutrition: Nutrition
    @EnvironmentObject private var workout: Workout
    @Environment(\.scenePhase) private var phase
    @State private var page = Page.chat

    var body: some View {
        TabView(selection: $page) {
            ChatView().tag(Page.chat)
            NutritionView().tag(Page.nutrition)
            WorkoutView().tag(Page.workout)
        }
        .tabViewStyle(.page)
        // The complication always lands on the prompt, whichever page was showing.
        .onOpenURL { url in
            guard url.scheme == "statushub", url.host == "record" else { return }
            page = .chat
            chat.requestDictation()
        }
        .onChange(of: page) { _, _ in follow() }
        .onChange(of: phase) { _, _ in follow() }
    }

    /// A page loads and holds its stream open only while it is the one on screen.
    private func follow() {
        if phase == .active && page == .nutrition { nutrition.activate() } else { nutrition.deactivate() }
        if phase == .active && page == .workout { workout.activate() } else { workout.deactivate() }
    }
}
