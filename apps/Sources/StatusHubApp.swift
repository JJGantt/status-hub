import SwiftUI
import WebKit
#if os(iOS)
import UIKit
import UserNotifications      // setBadgeCount, driven by the page via the "badge" message handler
import WidgetKit              // reloadAllTimelines — a placed widget caches its timeline
#elseif os(macOS)
import AppKit
#endif

@main
struct StatusHubApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate   // APNs registration (see Push.swift)
    #endif
    var body: some Scene {
        WindowGroup {
            HubWebView()
                .preferredColorScheme(.dark)
                // Without this, SwiftUI's default keyboard-avoidance shrinks the WHOLE WebView's frame
                // when the on-screen keyboard shows (e.g. tapping the chat input) — which shrinks
                // window.innerHeight inside the page and makes wall.js's resize-driven fit() bake in
                // that transient size. It doesn't reliably restore when the keyboard dismisses (the wall
                // reads a few points smaller after switching to chat and back). The web page's own
                // focused-input scroll-into-view already handles the keyboard; the native layer doesn't
                // need to resize around it too.
                .ignoresSafeArea(.keyboard, edges: .bottom)
            #if os(iOS)
                // Opened via statushub://record (a home-screen shortcut) → fire the same voice FAB the
                // user would tap, so it lands straight in "listening".
                .onOpenURL { url in
                    guard url.scheme == "statushub" else { return }
                    if url.host == "record" { RecordLaunch.shared.request() }
                    // statushub://item/<id> — the widget's "open this one". The id is the path.
                    if url.host == "item" {
                        let id = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
                        if !id.isEmpty { ItemLaunch.shared.request(id) }
                    }
                }
            #endif
            #if os(macOS)
                // Landscape: the Mac app renders the wall (?mode=mac) — the TV dashboard + a docked chat
                // side panel — so it wants width, unlike the phone-shaped iOS build.
                .frame(minWidth: 1040, idealWidth: 1440, minHeight: 660, idealHeight: 900)
            #endif
        }
        #if os(macOS)
        // .contentMinSize (not .contentSize): only enforce the frame's minWidth/minHeight floor. .contentSize .contentSize
        // continuously re-derives the window size from the content's reported "ideal" size on every SwiftUI
        // re-render — since HubWebView is an opaque WKWebView wrapper, that re-derivation rides on AppKit's
        // fitting-size computation for the wrapped view rather than our fixed idealWidth/idealHeight, so
        // interactions that change the web content's internal layout (e.g. collapsing the chat sidebar) could
        // nudge the actual NSWindow a few points smaller. The wall already fits itself to whatever size the
        // window is (wall.js); the window shouldn't be re-fit to the wall in turn.
        .windowResizability(.contentMinSize)
        #endif
    }
}

#if os(iOS)
// Bridges a statushub://record launch (from a home-screen shortcut) to the loaded web hub: fires the same
// voice FAB the user would tap, so the app opens straight into "listening". Polls until the page has mounted
// the recorder (window.__startVoiceCommand), so it works on a cold launch too (the URL can arrive before
// the web content finishes loading).
// Bridges an "open this item" launch (the widget's ↗ option, or statushub://item/<id>) to the loaded
// web hub: asks the to-do pane to show that item in full, body and all. Same polling shape as
// RecordLaunch — the request can arrive before the web content has mounted on a cold launch.
final class ItemLaunch {
    static let shared = ItemLaunch()
    weak var webView: WKWebView?
    private var pendingID: String?

    func request(_ id: String) { pendingID = id; fire() }
    func fireIfPending() { if pendingID != nil { fire() } }

    private func fire(retries: Int = 12) {
        guard let id = pendingID, let wv = webView else { return }
        wv.evaluateJavaScript("!!(window.__showItem)") { [weak self] ready, _ in
            guard let self, self.pendingID != nil else { return }
            if (ready as? Bool) == true {
                self.pendingID = nil
                // JSON-encoded so an id can never break out of the string literal.
                let arg = String(data: (try? JSONSerialization.data(withJSONObject: [id])) ?? Data(), encoding: .utf8) ?? "[\"\"]"
                wv.evaluateJavaScript("window.__showItem(\(arg)[0])", completionHandler: nil)
            } else if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.fire(retries: retries - 1) }
            }
        }
    }
}

final class RecordLaunch {
    static let shared = RecordLaunch()
    weak var webView: WKWebView?
    private var pending = false

    func request() { pending = true; fire() }
    func fireIfPending() { if pending { fire() } }

    private func fire(retries: Int = 12) {
        guard pending, let wv = webView else { return }
        wv.evaluateJavaScript("!!(window.__startVoiceCommand)") { [weak self] ready, _ in
            guard let self, self.pending else { return }
            if (ready as? Bool) == true {
                self.pending = false
                wv.evaluateJavaScript("window.__startVoiceCommand()", completionHandler: nil)
            } else if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.fire(retries: retries - 1) }
            }
        }
    }
}
#endif

// Thin WKWebView wrapper around the web hub (Auth.host). The app is now a shell over the web UI so
// every surface shares one codebase. Auth: pre-seed the `hub` cookie from the saved token (the same
// value the web login sets) so an already-set-up install opens straight in; with no saved password
// the web app's own /login page appears in the web view and sets the cookie itself. The mic is
// auto-granted so the in-page voice FAB works (the OS still gates it once via the system prompt).
// NOTE: the native RootView/LoginView/DashboardView (+ HubModel/Models/Views/Theme) below are now
// superseded by this and unused — left in place pending an explicit OK to remove them.
struct HubWebView {
    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)   // first-party hub → no nested prompt
        }

        // JS dialog panels. WKWebView suppresses window.alert/confirm/prompt (confirm returns false)
        // unless these WKUIDelegate methods are implemented — which silently broke every in-page button
        // gated on a confirm() (commit, delete, reset context). Present them as native dialogs instead.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            #if os(iOS)
            guard let vc = Self.topVC() else { completionHandler(); return }
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            vc.present(a, animated: true)
            #elseif os(macOS)
            let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.runModal(); completionHandler()
            #endif
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            #if os(iOS)
            guard let vc = Self.topVC() else { completionHandler(false); return }
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            vc.present(a, animated: true)
            #elseif os(macOS)
            let a = NSAlert(); a.messageText = message
            a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
            completionHandler(a.runModal() == .alertFirstButtonReturn)
            #endif
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            #if os(iOS)
            guard let vc = Self.topVC() else { completionHandler(defaultText); return }
            let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            a.addTextField { $0.text = defaultText }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
            vc.present(a, animated: true)
            #elseif os(macOS)
            let a = NSAlert(); a.messageText = prompt
            a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
            let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24)); tf.stringValue = defaultText ?? ""
            a.accessoryView = tf
            completionHandler(a.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil)
            #endif
        }

        #if os(iOS)
        // Topmost presented view controller to anchor the dialogs on.
        static func topVC() -> UIViewController? {
            let root = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first { $0.isKeyWindow }?.rootViewController
            var vc = root
            while let p = vc?.presentedViewController { vc = p }
            return vc
        }
        #endif

        #if os(iOS)
        // Once the authenticated hub has loaded, hand the web view to PushManager so it can register
        // the APNs token via a same-origin (cookie-authed) fetch.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            PushManager.shared.attach(webView)
            RecordLaunch.shared.fireIfPending()   // statushub://record cold launch → auto-start the voice FAB
            ItemLaunch.shared.fireIfPending()     // statushub://item/<id> cold launch → open that item
        }
        #endif

        // The page tells us the icon badge count directly. Clearing a reminder happens INSIDE the web
        // view, so natively we'd otherwise never know — and the server's badge-only push can't be
        // relied on to tell us either, since iOS throttles background pushes and in practice drops
        // them. This is a local call, so the badge updates the instant the row is cleared.
        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            #if os(iOS)
            switch message.name {
            case "badge":
                guard let n = message.body as? NSNumber else { return }
                DispatchQueue.main.async { UNUserNotificationCenter.current().setBadgeCount(n.intValue) }
            case "reloadWidgets":
                // The page saw the numbers move. A widget can't notice that on its own — it only
                // redraws when its timeline is rebuilt — so rebuild it now rather than leaving it
                // showing whatever it fetched last.
                DispatchQueue.main.async { WidgetCenter.shared.reloadAllTimelines() }
            default: break
            }
            #endif
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    fileprivate func build(_ coordinator: Coordinator) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(coordinator, name: "badge")          // page -> native badge updates
        cfg.userContentController.add(coordinator, name: "reloadWidgets")  // page -> refresh the widget
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()          // persistent cookies → stays signed in across launches
        #if os(iOS)
        cfg.allowsInlineMediaPlayback = true       // iOS-only knob
        #endif
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.uiDelegate = coordinator
        wv.navigationDelegate = coordinator
        #if os(iOS)
        RecordLaunch.shared.webView = wv   // so a statushub://record launch can drive this web view
        ItemLaunch.shared.webView = wv     // …and so can statushub://item/<id>
        #endif
        #if os(iOS)
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        #endif
        #if os(macOS)
        let url = URL(string: Auth.host + "/?mode=mac")!   // landscape wall + docked chat side panel
        #else
        let url = URL(string: Auth.host)!
        #endif
        let req = URLRequest(url: url)
        if let token = Auth.token(), let host = url.host,
           let cookie = HTTPCookie(properties: [
               .domain: host, .path: "/", .name: "hub", .value: token,
               .secure: "TRUE", .expires: Date(timeIntervalSinceNow: 60 * 60 * 24 * 3650),
           ]) {
            wv.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { _ = wv.load(req) }
        } else {
            _ = wv.load(req)
        }
        return wv
    }
}

#if os(iOS)
extension HubWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { build(context.coordinator) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#else
extension HubWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { build(context.coordinator) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#endif

struct RootView: View {
    @EnvironmentObject var model: HubModel
    var body: some View {
        Group {
            if model.authed {
                DashboardView()
            } else {
                LoginView()
            }
        }
        .onAppear { model.start() }
    }
}

struct LoginView: View {
    @EnvironmentObject var model: HubModel
    @State private var pw = ""
    @State private var busy = false
    @State private var err: String?
    var body: some View {
        ZStack {
            Color.bg.ignoresSafeArea()
            VStack(spacing: 16) {
                Text("Status Hub").font(.largeTitle.bold())
                secureField
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .frame(maxWidth: 280)
                if let err { Text(err).foregroundColor(.red).font(.footnote) }
                Button(busy ? "…" : "Enter") {
                    busy = true; err = nil
                    Task {
                        let ok = await model.login(pw)
                        busy = false
                        if !ok { err = "Wrong password or offline" }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(pw.isEmpty || busy)
            }
            .padding()
        }
    }
    // SecureField with iOS-only autocapitalization disabled, guarded for macOS.
    private var secureField: some View {
        let field = SecureField("Password", text: $pw)
        #if os(iOS)
        return field.textInputAutocapitalization(.never)
        #else
        return field
        #endif
    }
}

struct DashboardView: View {
    @EnvironmentObject var model: HubModel
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let s = model.status {
                    LitterCard(litter: s.litter)
                    NutritionCard(nutrition: s.nutrition)
                    MaintenanceCard(m: s.maintenance)
                    WorkoutsCard(days: s.workouts ?? [])
                } else {
                    ProgressView().tint(.muted).padding(.top, 100)
                }
                HStack(spacing: 6) {
                    Circle().fill(model.connected ? Color(hex: 0x22c55e) : .muted).frame(width: 7, height: 7)
                    Text(model.connected ? "live" : "reconnecting…").font(.caption2).foregroundColor(.muted)
                    Spacer()
                    Button("Sign out") { model.logout() }.font(.caption2).foregroundColor(.muted)
                }
                .padding(.top, 4)
            }
            .padding()
        }
        .background(Color.bg.ignoresSafeArea())
        .refreshable { await model.fetchOnce() }
    }
}
