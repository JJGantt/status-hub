import SwiftUI

/// Where a control asked the app to land. A control runs its intent inside the app
/// (`OpenPageIntent`), which sets this; `RootView` watches it and turns the page, then clears it so
/// the same request cannot fire again on a later launch.
@MainActor
final class Router: ObservableObject {
    static let shared = Router()

    @Published var asked: WatchPage?
    /// What the day page should show when a control lands on it: Nutrition opens today's food log,
    /// Workout the exercise list, Day the page itself with nothing opened. The day page takes it and
    /// clears it.
    @Published var dayList: WatchPage?

    private init() {}

    func open(_ page: WatchPage) {
        if page != .sessions { dayList = page }
        asked = page
    }
}
