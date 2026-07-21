import Foundation

/// Single source of truth for API URLs. All paths are relative to the
/// configured server base URL (see Env).
enum Endpoints {
    static func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var url = Env.serverURL
        for component in path.split(separator: "/") {
            url.append(path: String(component))
        }
        guard !query.isEmpty else { return url }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = query
        return components?.url ?? url
    }

    static func oauth(provider: String) -> URL {
        url("api/auth/\(provider)")
    }
}
