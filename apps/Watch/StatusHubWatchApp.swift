import SwiftUI

@main
struct StatusHubWatchApp: App {
    @StateObject private var chat = Chat()

    init() {
        // Activate WatchConnectivity at launch so a token the phone already sent is picked up at once.
        PhoneLink.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            ChatView().environmentObject(chat)
        }
    }
}
