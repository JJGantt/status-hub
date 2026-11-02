import Foundation
import CryptoKit
import Security

// Stores the hub password in the Keychain and derives the same token the web cookie uses:
// sha256("status-hub:" + password), sent as the X-Hub-Token header.
enum Auth {
    #if targetEnvironment(simulator)
    /// `SIMCTL_CHILD_HUB_HOST=http://127.0.0.1:<port>` points a simulator at a hub on this Mac, so a test
    /// that kills the app mid-recording reports nothing to the live ops responder.
    static let host = ProcessInfo.processInfo.environment["HUB_HOST"] ?? "https://jared-status-hub.fly.dev"
    #else
    static let host = "https://jared-status-hub.fly.dev"
    #endif
    private static let service = "com.jaredgantt.statushub"
    private static let account = "hubPassword"
    // Explicit so the widget extension — a different bundle id, hence a different DEFAULT keychain
    // group — resolves the same item. Deliberately equal to the app's own default group, so the
    // password stored before this existed is still found and nothing has to be re-entered.
    private static let accessGroup = "XMH4AVFC78.com.jaredgantt.statushub"

    static func savePassword(_ pw: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(pw.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    // AfterFirstUnlock, not the default WhenUnlocked: a notification's Done runs in the background,
    // usually with the phone locked in a pocket while the watch is what got tapped. Under the default
    // the read fails there, token() is nil, and the action finishes having sent nothing at all.
    static func password() -> String? {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
        // A password saved before this carries the default; move it over on the next unlocked read.
        SecItemUpdate(base as CFDictionary, [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock] as CFDictionary)
        return s
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func token() -> String? {
        guard let pw = password() else { return nil }
        let digest = SHA256.hash(data: Data(("status-hub:" + pw).utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
