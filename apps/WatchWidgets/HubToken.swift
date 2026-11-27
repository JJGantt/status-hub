import Foundation
import Security

/// The hub token, handed over by the iPhone app and kept in this watch's own Keychain. The watch
/// cannot sign in by itself: it has no web view, and the phone's cookies and Keychain are not shared
/// with it. See `Sources/WatchLink.swift` for the phone's half. Compiled into the app and the widget
/// extension, which share it through the keychain group both are entitled to.
///
/// **Readable while the watch is locked** (`AfterFirstUnlock`) and held in memory once read. With the
/// Keychain's default, a read with the wrist down failed and the live mic could not reconnect for over a
/// minute (`noToken`) until the wrist came up.
enum HubToken {
    nonisolated(unsafe) private static var cached: String?

    // An explicit group so the widget extension (the front-door control, `DoorAPI`) resolves the same
    // item. Deliberately equal to the app's own default group, so the token stored before this existed
    // is still found and nothing has to be handed over again.
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.jaredgantt.statushub.watch",
        kSecAttrAccount as String: "hubToken",
        kSecAttrAccessGroup as String: "XMH4AVFC78.com.jaredgantt.statushub.watch",
    ]

    static func get() -> String? {
        #if targetEnvironment(simulator)
        // A simulator has no phone to hand it a token. Passed at launch instead
        // (`SIMCTL_CHILD_HUB_TOKEN=… xcrun simctl launch`), so the real app runs against real data there.
        if let t = ProcessInfo.processInfo.environment["HUB_TOKEN"], !t.isEmpty { return t }
        #endif
        if let cached { return cached }
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        // A token stored before this was written carries the default; move it over.
        SecItemUpdate(query as CFDictionary, [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock] as CFDictionary)
        cached = s
        return s
    }

    static func set(_ token: String?) {
        SecItemDelete(query as CFDictionary)
        cached = nil
        guard let token, !token.isEmpty else { return }
        cached = token
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
