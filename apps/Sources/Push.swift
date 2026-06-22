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
        let js = """
        fetch('/api/register-push',{method:'POST',headers:{'Content-Type':'application/json'},\
        body:JSON.stringify({token:'\(token)',platform:'ios'})}).catch(function(){});
        """
        DispatchQueue.main.async { wv.evaluateJavaScript(js, completionHandler: nil) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
#endif
