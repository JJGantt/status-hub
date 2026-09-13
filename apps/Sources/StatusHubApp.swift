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
                    // statushub://pane/<name> — a widget tapped anywhere but a row. Each widget names
                    // the pane it depicts, so tapping it lands there instead of on whatever pane
                    // happened to be open last.
                    // statushub://repo/<path> — a repo widget row. The widget has no microphone, so
                    // it hands the choice over and the app records the opening message.
                    // statushub://report/<id> — tapping a report's notification.
                    if url.host == "report" {
                        let id = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
                        if !id.isEmpty { ReportLaunch.shared.request(id) }
                    }
                    if url.host == "repo" {
                        let path = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
                        if !path.isEmpty { RepoLaunch.shared.request(path) }
                    }
                    if url.host == "pane" {
                        let name = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
                        if !name.isEmpty { PaneLaunch.shared.request(name) }
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
// Bridges statushub://pane/<name> to the loaded web hub: scrolls the phone's swipe panes to the named
// one. Same polling shape as RecordLaunch — a cold launch can deliver the URL before the page has
// mounted the pane machinery.
// Bridges statushub://repo/<path> to the loaded web hub: lands on the repos pane and starts dictating
// the opening message for that project. Same polling shape as RecordLaunch — a cold launch can deliver
// the URL before the page has mounted.
final class RepoLaunch {
    static let shared = RepoLaunch()
    weak var webView: WKWebView?
    private var pendingPath: String?

    func request(_ path: String) { pendingPath = path; fire() }
    func fireIfPending() { if pendingPath != nil { fire() } }

    private func fire(retries: Int = 12) {
        guard let path = pendingPath, let wv = webView else { return }
        wv.evaluateJavaScript("!!(window.__startRepoSession)") { [weak self] ready, _ in
            guard let self, self.pendingPath != nil else { return }
            if (ready as? Bool) == true {
                self.pendingPath = nil
                // JSON-encoded: a filesystem path can carry quotes and must never become JS syntax.
                let arg = String(data: (try? JSONSerialization.data(withJSONObject: [path])) ?? Data(), encoding: .utf8) ?? "[\"\"]"
                wv.evaluateJavaScript("window.__startRepoSession(\(arg)[0])", completionHandler: nil)
            } else if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.fire(retries: retries - 1) }
            }
        }
    }
}

// A session's reply notification, tapped: lands on the sessions pane with that session scrolled into
// view. Same polling shape as RecordLaunch — a tap can cold-launch the app before the page has mounted.
final class SessionLaunch {
    static let shared = SessionLaunch()
    weak var webView: WKWebView?
    private var pendingId: String?

    func request(_ id: String) { pendingId = id; fire() }
    func fireIfPending() { if pendingId != nil { fire() } }

    private func fire(retries: Int = 12) {
        guard let id = pendingId, let wv = webView else { return }
        wv.evaluateJavaScript("!!(window.__showSession)") { [weak self] ready, _ in
            guard let self, self.pendingId != nil else { return }
            if (ready as? Bool) == true {
                self.pendingId = nil
                let arg = String(data: (try? JSONSerialization.data(withJSONObject: [id])) ?? Data(), encoding: .utf8) ?? "[\"\"]"
                wv.evaluateJavaScript("window.__showSession(\(arg)[0])", completionHandler: nil)
            } else if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.fire(retries: retries - 1) }
            }
        }
    }
}

// statushub://report/<id> — a write-up published by a dispatched session, opened from its push.
//
// Preferred path: hand it to the hub's Reports pane, which opens the report in a sandboxed frame. You
// then land INSIDE the app, on the pane that lists every other report, so backing out of the one you
// were sent is a button rather than a reload of the whole dashboard.
//
// Fallback: navigate the web view to /report/<id> outright. That is what happens if the page never
// mounts the bridge — an older hub, or the pane machinery absent — and it is why the web view enables
// back/forward gestures: a top-level report has to be escapable too.
final class ReportLaunch {
    static let shared = ReportLaunch()
    weak var webView: WKWebView?
    private var pendingId: String?

    func request(_ id: String) { pendingId = id; fire() }
    func fireIfPending() { if pendingId != nil { fire() } }

    private func fire(retries: Int = 12) {
        guard let id = pendingId, let wv = webView else { return }   // no web view yet → stay pending
        // `reports.id` is a text primary key, usually a uuid but not guaranteed to be one, so it is
        // ENCODED rather than filtered — stripping characters would turn a valid id into a 404.
        guard !id.isEmpty else { pendingId = nil; return }
        wv.evaluateJavaScript("!!(window.__showReport)") { [weak self] ready, _ in
            guard let self, self.pendingId != nil else { return }
            if (ready as? Bool) == true {
                self.pendingId = nil
                // JSON-encoded: an id is data and must never become JS syntax. Same shape as RepoLaunch.
                let arg = String(data: (try? JSONSerialization.data(withJSONObject: [id])) ?? Data(), encoding: .utf8) ?? "[\"\"]"
                wv.evaluateJavaScript("window.__showReport(\(arg)[0])", completionHandler: nil)
            } else if retries > 0 {
                // Cold launch: the push can arrive before the page has mounted. Same poll as RepoLaunch.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.fire(retries: retries - 1) }
            } else if let esc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                      let url = URL(string: Auth.host + "/report/" + esc) {
                self.pendingId = nil
                wv.load(URLRequest(url: url))
            } else {
                self.pendingId = nil
            }
        }
    }
}

final class PaneLaunch {
    static let shared = PaneLaunch()
    weak var webView: WKWebView?
    private var pendingName: String?

    func request(_ name: String) { pendingName = name; fire() }
    func fireIfPending() { if pendingName != nil { fire() } }

    private func fire(retries: Int = 12) {
        guard let name = pendingName, let wv = webView else { return }
        wv.evaluateJavaScript("!!(window.__showPane)") { [weak self] ready, _ in
            guard let self, self.pendingName != nil else { return }
            if (ready as? Bool) == true {
                self.pendingName = nil
                let safe = name.filter { $0.isLowercase && $0.isLetter }
                wv.evaluateJavaScript("window.__showPane('\(safe)')", completionHandler: nil)
            } else if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.fire(retries: retries - 1) }
            }
        }
    }
}

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
            PaneLaunch.shared.fireIfPending()     // statushub://pane/<name> cold launch → land there
            RepoLaunch.shared.fireIfPending()     // statushub://repo/<path> cold launch → dictate there
            ReportLaunch.shared.fireIfPending()   // statushub://report/<id> cold launch → open it
            SessionLaunch.shared.fireIfPending()  // a session-reply notification cold launch → land on it
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
        // A report is the first thing in this app you navigate AWAY from the dashboard to read,
        // so leaving it has to be possible without hunting for a control.
        wv.allowsBackForwardNavigationGestures = true
        wv.uiDelegate = coordinator
        wv.navigationDelegate = coordinator
        #if os(iOS)
        RecordLaunch.shared.webView = wv   // so a statushub://record launch can drive this web view
        ItemLaunch.shared.webView = wv     // …and so can statushub://item/<id>
        PaneLaunch.shared.webView = wv     // …and statushub://pane/<name>
        RepoLaunch.shared.webView = wv     // …and statushub://repo/<path>
        ReportLaunch.shared.webView = wv   // …and statushub://report/<id>
        SessionLaunch.shared.webView = wv  // …and a tapped session-reply notification
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
