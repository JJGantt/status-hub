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

    /// A plain authenticated GET. Used by the alarm sync, whose whole point is running when there is
    /// no page to ride — a background wake has no WebView and no web session.
    static func get(_ path: String, done: @escaping (Data?) -> Void) {
        guard let req = request(path, method: "GET", json: nil) else { return done(nil) }
        URLSession.shared.dataTask(with: req) { data, _, _ in done(data) }.resume()
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
        WatchLink.shared.start()   // hands the hub token to the watch app
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

    // A SILENT push. The badge-only ones have always been sent; with the `remote-notification`
    // background mode the app now actually wakes for them, so this has to be cheap and has to say no
    // when there is nothing to do — an app that reports work it did not do gets woken less often.
    //
    // `alarms` is the hub asking for a reschedule (nudgeAlarms in server.js). An AlarmKit alarm lives
    // on the device, so this is the only path by which a reminder marked alarm-grade on another
    // machine reaches the phone before it is next opened. No prompt: authorization is a foreground
    // question, and a run that finds it unanswered simply does nothing.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard userInfo["alarms"] != nil else { return completionHandler(.noData) }
        AlarmSync.sync(why: "push") { changed in completionHandler(changed ? .newData : .noData) }
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
        case "REMINDER_DONE":
            HubAPI.post("/api/todos/clear", ["id": id], done: completionHandler)
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
        // Kept, but NOT relied on. This app is a SwiftUI `WindowGroup`, which means it is scene-based,
        // and UIKit routes activation to the scene in a scene-based app rather than calling this — so
        // whether it runs at all is not ours to decide. The sync that is guaranteed to run is the one
        // driven by `scenePhase` in StatusHubApp.swift; the beacon names which trigger fired, so the
        // two cannot quietly become one.
        AlarmSync.sync(why: "didBecomeActive", mayPrompt: true)
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
