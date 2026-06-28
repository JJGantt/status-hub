import SwiftUI
import WebKit
#if os(iOS)
import UIKit
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
            #if os(macOS)
                .frame(minWidth: 420, idealWidth: 460, minHeight: 640, idealHeight: 820)
            #endif
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}

// Thin WKWebView wrapper around the web hub (Auth.host). The app is now a shell over the web UI so
// every surface shares one codebase. Auth: pre-seed the `hub` cookie from the saved token (the same
// value the web login sets) so an already-set-up install opens straight in; with no saved password
// the web app's own /login page appears in the web view and sets the cookie itself. The mic is
// auto-granted so the in-page voice FAB works (the OS still gates it once via the system prompt).
// NOTE: the native RootView/LoginView/DashboardView (+ HubModel/Models/Views/Theme) below are now
// superseded by this and unused — left in place pending an explicit OK to remove them.
struct HubWebView {
    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
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
        }
        #endif
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    fileprivate func build(_ coordinator: Coordinator) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()          // persistent cookies → stays signed in across launches
        #if os(iOS)
        cfg.allowsInlineMediaPlayback = true       // iOS-only knob
        #endif
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.uiDelegate = coordinator
        wv.navigationDelegate = coordinator
        #if os(iOS)
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        #endif
        let url = URL(string: Auth.host)!
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
