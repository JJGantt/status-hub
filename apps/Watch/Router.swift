import SwiftUI

/// Where a control asked the app to land. A control runs its intent inside the app
/// (`OpenPageIntent`), which sets this; `RootView` watches it and turns the page, then clears it so
/// the same request cannot fire again on a later launch.
@MainActor
final class Router: ObservableObject {
    static let shared = Router()

    @Published var asked: WatchPage?

    private init() {}

    func open(_ page: WatchPage) { asked = page }
}
