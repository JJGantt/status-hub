import Foundation
import Security

/// **What the watch app and its Control Center extension both read.** Control Center draws a toggle
/// from the extension, which is a separate process with its own storage; a keychain item in a shared
/// access group is the one place both can see (App Groups cannot be enabled on this account, the same
/// reason the iPhone app shares its password with its widgets this way). The group is declared on both
/// targets in project.yml; the team prefix is written out because the runtime needs the full name.
enum SharedState {
    static let group = "XMH4AVFC78.com.jaredgantt.statushub.watch"
    private static let service = "com.jaredgantt.statushub.watch.shared"

    static func read(_ account: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ account: String, _ value: String?) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
        ]
        SecItemDelete(q as CFDictionary)
        guard let value else { return }
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    /// Spoken session replies, on or off: the hub's `session_speech`, mirrored here.
    static var speech: Bool {
        get { read("session_speech") == "1" }
        set { write("session_speech", newValue ? "1" : "0") }
    }

    /// The hub token, so the extension can change a hub setting itself.
    static var token: String? {
        get { read("hubToken") }
        set { write("hubToken", newValue) }
    }

    /// Writes one hub setting, from either process. Best effort: the watch re-reads every setting from
    /// the hub when it comes to the front.
    static func putSetting(_ key: String, _ value: String) async {
        guard let token, let url = URL(string: Auth.host + "/api/settings") else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 20
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["key": key, "value": value])
        _ = try? await URLSession.shared.data(for: r)
    }
}
