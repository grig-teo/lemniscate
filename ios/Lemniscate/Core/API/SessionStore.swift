import Foundation

/// Owns the authentication session: restores the persisted cookie at launch,
/// tracks login state, and clears everything on logout.
@MainActor
final class SessionStore: ObservableObject {
    enum State {
        case loading
        case loggedOut
        case loggedIn
    }

    static let cookieName = "lemniscate_token"
    private static let cookieLifetime: TimeInterval = 7 * 24 * 3600

    @Published private(set) var state: State = .loading
    @Published private(set) var user: User?
    @Published var loginError: String?

    /// Called once at app launch.
    func restore() async {
        guard let token = KeychainStore.readToken(), !token.isEmpty else {
            state = .loggedOut
            return
        }
        installCookie(token)
        await refreshUser()
    }

    /// Login where the token was harvested out-of-band (OAuth WebView).
    func completeLogin(token: String) async {
        installCookie(token)
        KeychainStore.saveToken(token)
        await refreshUser()
    }

    /// Login where the server already set the cookie via Set-Cookie
    /// (GitVerse PAT connect), captured by HTTPCookieStorage automatically.
    func completeCookieLogin() async {
        guard let token = storedCookieToken() else {
            loginError = "The server did not return a session cookie."
            state = .loggedOut
            return
        }
        KeychainStore.saveToken(token)
        await refreshUser()
    }

    func logout() {
        KeychainStore.deleteToken()
        removeCookie()
        user = nil
        state = .loggedOut
    }

    func clearLoginError() {
        loginError = nil
    }

    private func refreshUser() async {
        do {
            let response: MeResponse = try await APIClient.shared.request("GET", "api/auth/me")
            user = response.user
            loginError = nil
            state = .loggedIn
        } catch let error as ApiError {
            if case .unauthorized = error {
                logout()
            } else {
                loginError = error.localizedDescription
                state = .loggedOut
            }
        } catch {
            loginError = error.localizedDescription
            state = .loggedOut
        }
    }

    private func installCookie(_ token: String) {
        guard let host = Env.serverURL.host else { return }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: Self.cookieName,
            .value: token,
            .domain: host,
            .path: "/",
            .expires: Date().addingTimeInterval(Self.cookieLifetime),
        ]
        if Env.serverURL.scheme == "https" {
            properties[.secure] = "TRUE"
        }
        guard let cookie = HTTPCookie(properties: properties) else { return }
        HTTPCookieStorage.shared.setCookie(cookie)
    }

    private func storedCookieToken() -> String? {
        HTTPCookieStorage.shared.cookies?.first { $0.name == Self.cookieName }?.value
    }

    private func removeCookie() {
        HTTPCookieStorage.shared.cookies?
            .filter { $0.name == Self.cookieName }
            .forEach { HTTPCookieStorage.shared.deleteCookie($0) }
    }
}
