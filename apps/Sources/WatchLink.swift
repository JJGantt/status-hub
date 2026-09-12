#if os(iOS)
import WatchConnectivity
import WebKit

// Hands the hub token to the watch app. The watch has its own Keychain and no web view, so it cannot
// sign in by itself; this app already holds the token as the `hub` cookie (set by the web login, or
// seeded from the Keychain password) and WatchConnectivity carries it across.
//
// It is sent as application context, which the system keeps and delivers whenever the watch app next
// runs: on activation, when the watch app is installed (sessionWatchStateDidChange — context sent
// before then is refused), and whenever the web view's cookies change, which is a sign-in or a
// sign-out. The watch can also ask with a message, which wakes this app in the background; that is
// the path for a watch that has nothing yet. An empty string means signed out.
final class WatchLink: NSObject, WCSessionDelegate, WKHTTPCookieStoreObserver {
    static let shared = WatchLink()

    private var cookies: WKHTTPCookieStore { WKWebsiteDataStore.default().httpCookieStore }

    /// Main thread — the cookie store is a main-thread API.
    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        cookies.add(self)
    }

    private func currentToken(_ done: @escaping (String) -> Void) {
        DispatchQueue.main.async {
            let host = URL(string: Auth.host)?.host ?? ""
            self.cookies.getAllCookies { all in
                let cookie = all.first { $0.name == "hub" && $0.domain.hasSuffix(host) }
                done(cookie?.value ?? Auth.token() ?? "")
            }
        }
    }

    private func push() {
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        currentToken { token in try? session.updateApplicationContext(["hubToken": token]) }
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) { push() }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        push()
    }

    func sessionWatchStateDidChange(_ session: WCSession) { push() }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        currentToken { replyHandler(["hubToken": $0]) }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    // Switching to a different watch deactivates the session; reactivating is what picks up the new one.
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
#endif
