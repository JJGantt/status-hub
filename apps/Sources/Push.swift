#if os(iOS)
import UIKit
import WebKit
import UserNotifications

// APNs push for the native iOS shell. The device token is registered with the hub by a same-origin
// fetch() INSIDE the authenticated WKWebView, so it rides the hub auth cookie the app already holds —
// no separate native credential needed. The AppDelegate handles permission + APNs registration; the
// web-view coordinator calls PushManager.attach(_:) once the page has loaded.
final class PushManager {
    static let shared = PushManager()
    private weak var webView: WKWebView?
    private var token: String?

    func setToken(_ t: String) { token = t; flush() }
    func attach(_ wv: WKWebView) { webView = wv; flush() }

    private func flush() {
        guard let token, let wv = webView else { return }
        // A Debug (Xcode) build gets a sandbox APNs token; a Release (TestFlight/App Store) build gets
        // a production token. Report which so the server targets the matching APNs gateway per token.
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        let js = """
        fetch('/api/register-push',{method:'POST',headers:{'Content-Type':'application/json'},\
        body:JSON.stringify({token:'\(token)',platform:'ios',environment:'\(env)'})}).catch(function(){});
        """
        DispatchQueue.main.async { wv.evaluateJavaScript(js, completionHandler: nil) }
    }
}

// Hub calls made natively rather than through the WebView. A notification action fires with the app
// in the BACKGROUND and no page loaded, so it can't ride the web session the way token registration
// does — it authenticates with the same derived token the 'hub' cookie carries (X-Hub-Token).
enum HubAPI {
    private static func request(_ path: String, method: String, json: [String: Any]?) -> URLRequest? {
        guard let url = URL(string: Auth.host + path), let token = Auth.token() else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.timeoutInterval = 20
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    // The hub returns the resulting overdue count, so acting on a reminder corrects the badge in the
    // same round trip — no second request, and no waiting on a throttled silent push. `done` always
    // runs, including on failure, so the system's action handler can finish either way.
    static func post(_ path: String, _ json: [String: Any], done: @escaping () -> Void) {
        guard let req = request(path, method: "POST", json: json) else { return done() }
        URLSession.shared.dataTask(with: req) { data, _, _ in
            applyBadge(data); DispatchQueue.main.async(execute: done)
        }.resume()
    }

    /// Re-read the true count. Called when the app foregrounds, so the badge self-corrects even if a
    /// background push was throttled away.
    static func refreshBadge() {
        guard let req = request("/api/badge", method: "GET", json: nil) else { return }
        URLSession.shared.dataTask(with: req) { data, _, _ in applyBadge(data) }.resume()
    }

    private static func applyBadge(_ data: Data?) {
        guard let data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let n = obj["badge"] as? Int else { return }
        DispatchQueue.main.async { UNUserNotificationCenter.current().setBadgeCount(n) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    // Buttons on a reminder notification. All three are BACKGROUND actions (no .foreground option),
    // so tapping one acts without launching the app or changing what's on screen. iOS shows these
    // only once the banner is expanded — pulled down, or long-pressed.
    private static let reminderCategory = UNNotificationCategory(
        identifier: "REMINDER",
        actions: [
            UNNotificationAction(identifier: "REMINDER_DONE",       title: "Done",    options: []),
            UNNotificationAction(identifier: "REMINDER_SNOOZE_1H",  title: "1 Hour",  options: []),
            UNNotificationAction(identifier: "REMINDER_SNOOZE_24H", title: "Tomorrow", options: []),
        ],
        intentIdentifiers: [], options: [])

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.reminderCategory])
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushManager.shared.setToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("APNs registration failed: \(error.localizedDescription)")
    }

    // Show the banner even when the app is foregrounded.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // Acting on a reminder from its notification. Anything that isn't one of our buttons — tapping
    // the banner, or swiping it away — deliberately does NOTHING: dismissing is not answering, so the
    // reminder stays outstanding and keeps its badge.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let id = response.notification.request.content.userInfo["reminder_id"] as? String else {
            return completionHandler()
        }
        switch response.actionIdentifier {
        case "REMINDER_DONE":
            HubAPI.post("/api/todos/complete", ["id": id], done: completionHandler)
        case "REMINDER_SNOOZE_1H":
            HubAPI.post("/api/todos/snooze", ["id": id, "hours": 1], done: completionHandler)
        case "REMINDER_SNOOZE_24H":
            HubAPI.post("/api/todos/snooze", ["id": id, "hours": 24], done: completionHandler)
        default:
            completionHandler()
        }
    }

    // Badge is authoritative from the hub, so re-read it whenever the app comes forward.
    func applicationDidBecomeActive(_ application: UIApplication) {
        HubAPI.refreshBadge()
    }
}
#endif
