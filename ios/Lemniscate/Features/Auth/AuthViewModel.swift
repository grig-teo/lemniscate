import Foundation

@MainActor
final class AuthViewModel: ObservableObject {
    enum AuthSheet: Identifiable {
        case oauth(provider: String)
        case gitverse

        var id: String {
            switch self {
            case .oauth(let provider): return "oauth-\(provider)"
            case .gitverse: return "gitverse"
            }
        }
    }

    @Published var sheet: AuthSheet?

    /// GitVerse PAT login: the response sets the session cookie via
    /// Set-Cookie, which HTTPCookieStorage captures automatically.
    func connectGitVerse(token: String, baseUrl: String?, session: SessionStore) async throws {
        let body = ConnectBody(provider: "gitverse", token: token, baseUrl: baseUrl)
        try await APIClient.shared.send("POST", "api/connections", body: body)
        await session.completeCookieLogin()
    }
}
