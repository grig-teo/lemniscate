import XCTest
@testable import Lemniscate

@MainActor
final class AuthViewModelTests: XCTestCase {

    override func setUp() {
        super.setUp()
        HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
    }

    func testAuthSheetIDsAreStable() {
        XCTAssertEqual(AuthViewModel.AuthSheet.oauth(provider: "github").id, "oauth-github")
        XCTAssertEqual(AuthViewModel.AuthSheet.gitverse.id, "gitverse")
    }

    func testConnectGitVersePostsTheConnectionPayload() async throws {
        let stub = StubAPIClient()
        let vm = AuthViewModel(api: stub)
        let session = SessionStore()
        try await vm.connectGitVerse(token: "pat-1", baseUrl: "https://gitverse.ru", session: session)
        XCTAssertEqual(stub.calls.map(\.method), ["POST"])
        XCTAssertEqual(stub.calls.map(\.path), ["api/connections"])
        let body = stub.lastBody as? ConnectBody
        XCTAssertEqual(body?.provider, "gitverse")
        XCTAssertEqual(body?.token, "pat-1")
        XCTAssertEqual(body?.baseUrl, "https://gitverse.ru")
        // No Set-Cookie happened in the stub, so the session reports the
        // missing-cookie error instead of flipping to logged in.
        XCTAssertEqual(session.loginError, "The server did not return a session cookie.")
    }

    func testConnectGitVersePropagatesAPIErrors() async {
        let stub = StubAPIClient(error: ApiError.server(status: 400, message: "invalid token"))
        let vm = AuthViewModel(api: stub)
        let session = SessionStore()
        do {
            try await vm.connectGitVerse(token: "bad", baseUrl: nil, session: session)
            XCTFail("expected connectGitVerse to throw")
        } catch let error as ApiError {
            guard case .server(let status, let message) = error else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(status, 400)
            XCTAssertEqual(message, "invalid token")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertNil(session.loginError)
    }
}
