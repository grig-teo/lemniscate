import Foundation
import Security

/// Minimal Keychain wrapper for persisting the session token across launches.
enum KeychainStore {
    private static let service = "space.grigteo.lemniscate"
    private static let account = "lemniscate_token"

    static func saveToken(_ token: String) {
        SecItemDelete(baseQuery() as CFDictionary)
        var attributes = baseQuery()
        attributes[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func readToken() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func deleteToken() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
