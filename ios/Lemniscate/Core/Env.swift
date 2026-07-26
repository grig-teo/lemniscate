import Foundation

/// Runtime configuration baked into Info.plist from xcconfig build settings.
enum Env {
    // Default backend deployment. The previous path-based URL
    // (https://grig-teo.space/lemniscate) now 301-redirects to this subdomain;
    // URLSession rewrites redirected POSTs as GETs and drops the body, which
    // surfaced as "Unexpected server response" in the app.
    private static let fallbackServerURL = "https://lemniscate.grig-teo.space"

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
