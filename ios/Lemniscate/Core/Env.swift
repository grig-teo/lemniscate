import Foundation

/// Runtime configuration baked into Info.plist from xcconfig build settings.
enum Env {
    private static let fallbackServerURL = "https://grig-teo.space/lemniscate"

    static var serverURL: URL {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "SERVER_URL") as? String,
              !raw.isEmpty,
              !raw.hasPrefix("$("),
              let url = URL(string: raw) else {
            return URL(string: fallbackServerURL)!
        }
        return url
    }
}
