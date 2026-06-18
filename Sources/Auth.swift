import Foundation
import CryptoKit
import Security

// Stores the hub password in the Keychain and derives the same token the web cookie uses:
// sha256("status-hub:" + password), sent as the X-Hub-Token header.
enum Auth {
    static let host = "https://jared-status-hub.fly.dev"
    private static let service = "com.jaredgantt.statushub"
    private static let account = "hubPassword"

    static func savePassword(_ pw: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(pw.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    static func password() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func token() -> String? {
        guard let pw = password() else { return nil }
        let digest = SHA256.hash(data: Data(("status-hub:" + pw).utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
