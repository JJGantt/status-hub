#if os(iOS)
import UIKit
import WebKit
import UserNotifications
import WidgetKit

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
        // The phone's IANA zone travels with Jared, so the hub uses it as "where he is" — a reminder
        // set for 4pm should fire at 4pm wherever he actually is, not 4pm Eastern. Re-sent on every
        // launch, so crossing a timezone corrects itself the next time the app opens.
        let tz = TimeZone.current.identifier
        let js = """
        fetch('/api/register-push',{method:'POST',headers:{'Content-Type':'application/json'},\
        body:JSON.stringify({token:'\(token)',platform:'ios',environment:'\(env)',tz:'\(tz)'})}).catch(function(){});
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
    // The one button on a reminder notification: **Done**, which COMPLETES the item — it scores, and
    // the item stays on the day as something that happened. Anything else is dismissing the
    // notification, which is the system's own gesture and needs no button of ours. There is no snooze:
    // a dated item that has not happened yet is moved by asking, not by a button that silently rewrites
    // its time. A BACKGROUND action (no .foreground), so it acts without launching the app.
    private static let reminderCategory = UNNotificationCategory(
        identifier: "REMINDER",
        actions: [UNNotificationAction(identifier: "REMINDER_DONE", title: "Done", options: [])],
        intentIdentifiers: [], options: [])

    // An orchestrator answer worth reading (docs/WATCH.md, "Unread answers"). No buttons;
    // `customDismissAction` is what reports a swipe-away, so tapping it and dismissing it both reach
    // the delegate, and either one marks the answer read.
    private static let answerCategory = UNNotificationCategory(
        identifier: "VOICE_ANSWER", actions: [], intentIdentifiers: [], options: [.customDismissAction])

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.reminderCategory, Self.answerCategory])
        WatchLink.shared.start()   // hands the hub token to the watch app
        HealthSync.shared.start()  // Apple Health -> the hub, and SleepSync after it (docs/HEALTH.md, docs/SLEEP.md)
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
        // An answer's notification, tapped or swiped away: read.
        if let mid = response.notification.request.content.userInfo["voice_message_id"] as? String {
            HubAPI.post("/api/voice-messages/read", ["id": mid], done: completionHandler)
            return
        }
        // A session's finished reply: tapping the banner opens that session on the repos pane.
        if let sid = response.notification.request.content.userInfo["session_id"] as? String {
            SessionLaunch.shared.request(sid)
            return completionHandler()
        }
        // A published report: tapping the banner opens that page. Checked before the reminder guard,
        // which returns early on any notification without a reminder_id.
        if let rid = response.notification.request.content.userInfo["report_id"] as? String {
            ReportLaunch.shared.request(rid)
            return completionHandler()
        }
        guard let id = response.notification.request.content.userInfo["reminder_id"] as? String else {
            return completionHandler()
        }
        switch response.actionIdentifier {
        // COMPLETE, not clear. `clear` deletes the item: no points, and no record that it happened —
        // which is what Done did until the scoring existed, and why pressing it seemed to do nothing.
        case "REMINDER_DONE":
            HubAPI.post("/api/todos/complete", ["id": id], done: completionHandler)
        default:
            completionHandler()
        }
    }

    // Badge is authoritative from the hub, so re-read it whenever the app comes forward.
    func applicationDidBecomeActive(_ application: UIApplication) {
        HubAPI.refreshBadge()
        // A placed widget holds a CACHED timeline: reinstalling the app does not refresh it, so new
        // widget code — or a changed payload shape — keeps rendering against the old cached entries
        // until the policy date rolls round. Opening the app forces it to regenerate.
        WidgetCenter.shared.reloadAllTimelines()
    }

    // …and again on the way OUT, which is the half that was missing. Opening the app is the moment a
    // widget stops being looked at; LEAVING is the moment it starts, and it is also the moment just
    // after whatever you came in to change. Without this, logging a meal and swiping home left the
    // rings showing pre-meal numbers: the page-driven nudge (core.js nudgeWidgets) is throttled to
    // once a minute and only runs while the page is live on the stream, so a change in that last
    // minute reached the widget only when its own hourly policy came round.
    //
    // Cheap enough to do unconditionally — this is an IPC to WidgetKit, not the fetch. The extension
    // does the work later, on its own schedule.
    func applicationDidEnterBackground(_ application: UIApplication) {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
#endif
